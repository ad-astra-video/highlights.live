"""Local VOD Pass 1 gate measurement for the decide watcher (ADAAAA-6738 G1c).

Drives the watcher over a VOD-style frame stream and measures the Part 3 /
Pass 1 gates. The bundled smoke clip (`docker/data-smoke/test_vod.mp4`) is only
8 s at 1 fps, too short to exercise a 10 s / 3 fps window over multiple ticks,
so the driver reconstructs a deterministic VOD timeline (120 s at 3 fps) with a
known event injected at t=50 s. That is exactly what the gates measure (the
mechanics: cadence, overlap, chunk bound, latency, context depth) — not media
quality. Pass a real longer clip with `--video <path>` to extract at 3 fps and
measure over real media instead.

Measurement runs the watcher in rule mode (deterministic `decide()`, no
Gemma/GPU needed) with an in-memory perceive client that returns the four
windowed-tool envelopes from the ingested frames, and records every tool call
to a trace list (the analysis_session_traces shape). Prints exact gate numbers
and writes them to an evidence JSON file.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services", "decide"))

from app.watcher import (  # noqa: E402
    Frame,
    WatcherConfig,
    WatcherSession,
)


def synthesize_stream(total_s: float, fps: float, event_ts: float) -> list[Frame]:
    """Deterministic 3 fps frame stream. A GOAL event (caption + audio burst +
    a couple of tracked players) is injected at ``event_ts``."""
    frames = []
    spacing = 1.0 / fps
    t = 0.0
    i = 0
    while t <= total_s + 1e-6:
        dt = abs(t - event_ts)
        in_event = dt <= 1.5
        obj = [{"label": "ball", "confidence": 0.9, "bbox": [0.45, 0.45, 0.5, 0.5]}] if t >= event_ts - 1.0 else []
        players = [{"trackId": "p1", "bbox": [0.3, 0.3, 0.4, 0.4], "label": "player"}] if in_event else []
        caption = "GOAL! crowd erupts" if in_event else ""
        audio_peak = 0.95 if in_event else 0.1
        frames.append(Frame(ts=round(t, 3), seq=i, players=players, objects=obj,
                            caption=caption, audio_peak=audio_peak, audio_baseline=0.05))
        i += 1
        t = round(t + spacing, 3)
    return frames


def extract_video_frames(video: str, fps: float, workdir: str) -> list[Frame]:
    """Extract frames at ``fps`` from ``video`` via ffmpeg and return Frames with
    no injected signals (real media; the rule summary will mostly read as quiet)."""
    import tempfile
    import glob

    d = tempfile.mkdtemp(dir=workdir, prefix="hl-wt-frames-")
    subprocess.run(
        ["ffmpeg", "-y", "-i", video, "-vf", f"fps={fps}", f"{d}/f%06d.jpg"],
        check=True, capture_output=True,
    )
    frames = []
    files = sorted(glob.glob(os.path.join(d, "*.jpg")))
    for i, _f in enumerate(files):
        frames.append(Frame(ts=round(i / fps, 3), seq=i))
    return frames


class InMemoryPerceive:
    """Returns the four windowed-tool envelopes from an in-memory frame list."""

    def __init__(self, frames: list[Frame]):
        self.frames = frames
        self.trace: list[dict] = []

    def call(self, tool: str, start: float, end: float, max_points: int) -> dict:
        win = [f for f in self.frames if start <= f.ts < end]
        if tool == "get_audio_levels":
            data = [{"ts": f.ts, "peakEnergy": f.audio_peak, "baselineEnergy": f.audio_baseline} for f in win]
        elif tool == "get_tracked_players":
            data = [{"ts": f.ts, "seq": f.seq, "players": f.players, "count": len(f.players)} for f in win if f.players]
        elif tool == "detect_objects":
            data = [{"ts": f.ts, "seq": f.seq, "objects": f.objects, "count": len(f.objects)} for f in win if f.objects]
        elif tool == "get_captioning":
            data = [{"ts": f.ts, "text": f.caption} for f in win if f.caption]
        else:
            data = []
        return {"tool": tool, "sessionId": "vod", "streamId": "pass1",
                "window": {"start": start, "end": end, "seconds": round(end - start, 3)},
                "count": len(data), "total": len(data), "truncated": False, "data": data}

    def record(self, rec: dict) -> None:
        self.trace.append(rec)


def measure(cfg: WatcherConfig, frames: list[Frame], event_ts: float, total_s: float) -> dict:
    perceive = InMemoryPerceive(frames)
    sess = WatcherSession(session_id="vod", stream_id="pass1", config=cfg,
                          perceive=perceive.call, trace=perceive.record)
    sess.ingest_many(frames)

    rows = []
    tick = cfg.tick_s
    while tick <= total_s + 1e-6:
        rows.append(sess.step(tick))
        tick = round(tick + cfg.tick_s, 3)

    # gate: summary cadence (max gap between rows)
    gaps = [rows[i].ts - rows[i - 1].ts for i in range(1, len(rows))]
    cadence_max = max(gaps) if gaps else 0.0

    # gate: frame chunk bound (max frames in a 10 s window, fps, width)
    chunk_max = max(r.frame_count for r in rows)
    valid_chunk = max(r.window_end - r.window_start for r in rows)

    # gate: overlap % between consecutive ticks. The very first ticks have a
    # clipped window (start clamped at t=0), so report BOTH the raw minimum and
    # the steady-state minimum over full-width (10 s) windows — the gate is about
    # the rolling 10 s chunk, which only exists once the stream is past 10 s.
    def _full_width(r):
        return (r.window_end - r.window_start) >= cfg.window_s - 1e-6
    overlaps = [r.overlap_fraction for r in rows[1:]]
    overlap_min = min(overlaps) if overlaps else 0.0
    ss = [rows[i].overlap_fraction for i in range(1, len(rows)) if _full_width(rows[i - 1]) and _full_width(rows[i])]
    overlap_min_steady = min(ss) if ss else overlap_min
    warmup_ticks = sum(1 for r in rows if not _full_width(r))

    # gate: event -> first summary naming it
    first_naming = next((r for r in rows if "GOAL" in r.event), None)
    latency = (first_naming.ts - event_ts) if first_naming else None

    # gate: summary context (last-30 s list, row count)
    ctx = sess.summaries_context()
    ctx_span = (ctx[-1].ts - ctx[0].ts) if len(ctx) >= 2 else 0.0

    # tools called per tick (uniformity) + trace volume
    tool_counts = {r.ts: len(r.tools_called) for r in rows}

    return {
        "config": {
            "tick_s": cfg.tick_s, "window_s": cfg.window_s, "fps": cfg.fps,
            "max_frame_count": cfg.max_frame_count, "min_overlap": cfg.min_overlap,
            "summary_window_s": cfg.summary_window_s, "summary_max_rows": cfg.summary_max_rows,
        },
        "stream": {"total_s": total_s, "frame_count": len(frames), "event_ts": event_ts},
        "gates": {
            "summary_rows_emitted": len(rows),
            "summary_cadence_max_gap_s": round(cadence_max, 3),
            "summary_cadence_le_3s": cadence_max <= cfg.tick_s + 1e-6,
            "frame_chunk_max_frames": chunk_max,
            "frame_chunk_window_s": round(valid_chunk, 3),
            "frame_chunk_le_30": chunk_max <= cfg.max_frame_count,
            "overlap_min_fraction": round(overlap_min, 4),
            "overlap_min_pct": round(overlap_min * 100, 1),
            "overlap_min_steady_pct": round(overlap_min_steady * 100, 1),
            "overlap_ge_50pct": overlap_min_steady >= cfg.min_overlap,
            "warmup_clipped_ticks": warmup_ticks,
            "event_latency_s": round(latency, 3) if latency is not None else None,
            "event_latency_le_5s": (latency is not None and latency <= 5.0),
            "summary_context_rows": len(ctx),
            "summary_context_span_s": round(ctx_span, 3),
            "summary_context_ge_10_rows": len(ctx) >= 10,
            "summary_context_last30s": all(r.ts >= ctx[-1].ts - cfg.summary_window_s - 1e-6 for r in ctx),
        },
        "trace_records": len(perceive.trace),
        "tools_per_tick_sample": tool_counts,
        "event_typed": first_naming.event if first_naming else None,
        "hypotheses_seeded": sess.hypotheses_seeded,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", default=None, help="optional real VOD path (extract at 3 fps)")
    ap.add_argument("--total-s", type=float, default=120.0)
    ap.add_argument("--event-ts", type=float, default=50.0)
    ap.add_argument("--out", default=None, help="evidence JSON path (default: workspace)")
    args = ap.parse_args()

    cfg = WatcherConfig(tick_s=3.0, window_s=10.0, fps=3.0, max_frame_count=30, min_overlap=0.50)
    workdir = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or os.environ.get("PAPERCLIP_SCRATCH_DIR") or "."

    if args.video:
        frames = extract_video_frames(args.video, cfg.fps, workdir)
        event_ts = args.event_ts
    else:
        frames = synthesize_stream(args.total_s, cfg.fps, args.event_ts)
        event_ts = args.event_ts

    result = measure(cfg, frames, event_ts, args.total_s)
    result["source"] = "synthetic VOD-style stream" if not args.video else f"real video {args.video}"

    out = args.out or os.path.join(workdir, "decide-watcher-pass1-evidence.json")
    with open(out, "w") as fh:
        json.dump(result, fh, indent=2)

    g = result["gates"]
    lines = [
        "Decide watcher — Pass 1 gate evidence",
        "=" * 44,
        f"source: {result['source']}",
        f"tick_s={cfg.tick_s} window_s={cfg.window_s} fps={cfg.fps} max_frames={cfg.max_frame_count}",
        f"stream: {result['stream']['total_s']:.0f}s, {result['stream']['frame_count']} frames, event@t={result['stream']['event_ts']}s",
        "",
        "GATES",
        f"  summary rows emitted        : {g['summary_rows_emitted']}",
        f"  summary cadence max gap     : {g['summary_cadence_max_gap_s']}s   (<=3s: {g['summary_cadence_le_3s']})",
        f"  frame chunk max frames      : {g['frame_chunk_max_frames']}  window {g['frame_chunk_window_s']}s  (<=30: {g['frame_chunk_le_30']})",
        f"  overlap min (steady state)  : {g['overlap_min_steady_pct']}%   (>=50%: {g['overlap_ge_50pct']})",
        f"  overlap min (incl. warmup)  : {g['overlap_min_pct']}%  ({g['warmup_clipped_ticks']} clipped <10s warmup ticks)",
        f"  event->first summary        : {g['event_latency_s']}s   (<=5s: {g['event_latency_le_5s']})",
        f"  summary context rows        : {g['summary_context_rows']}  span {g['summary_context_span_s']}s  (>=10: {g['summary_context_ge_10_rows']}; last30s: {g['summary_context_last30s']})",
        "",
        f"tool traces recorded          : {result['trace_records']} (analysis_session_traces shape)",
        f"event typed by decide         : {result['event_typed']}",
        f"hypotheses seeded (decide)    : {result['hypotheses_seeded']}",
        "",
        f"evidence written to: {out}",
    ]
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

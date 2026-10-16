"""G6 — Watcher cost-model quantification (ADAAAA-6743).

Drives the decide watcher over a deterministic VOD-style stream and measures the
cost-driver effect of each Part-4 knob so the G6 cost budget can be LOCKED with
numbers, not prose:

1. **Chunk downsample** (plan Part 4: 2 fps -> 20 frames vs 3 fps / 30 frames).
   Frame count is the KV-cost multiplier, so a cheaper chunk is the headline knob.
   Report frames-per-brain-call and the relative cost of a downsample profile.
2. **Cost-gated tool policy** (gate deep tools on a cheap CPU/audio pre-signal).
   Report tool-calls-per-tick and trace-records with the gate on vs off.
3. **Trace-write-rate knob** (downsample the analysis-session-trace write rate).
   Report trace-per-tick at rate=1.0 (every call) vs rate=0.25 (1 in 4).

The same rule-mode brain stands in for Gemma (this measures the *cost mechanics*
and the knob effect, not model quality). Prints exact per-knob numbers and writes
a cost-model evidence JSON; the gates themselves (cadence / overlap / latency /
recall / FPR) are measured by the pass-1 / pass-2 harnesses.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services", "decide"))

from app.watcher import (  # noqa: E402
    Frame,
    WatcherConfig,
    WatcherSession,
)


def synthesize_stream(total_s: float, fps: float, event_ts: float = 50.0) -> list[Frame]:
    """Deterministic frame stream: mostly quiet (low audio, no motion) with one
    notable moment around ``event_ts`` (caption + audio burst + tracked players).
    A quiet-dominant stream is what makes the cost gate's difference measurable."""
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
        audio_peak = 0.95 if in_event else 0.08
        frames.append(Frame(ts=round(t, 3), seq=i, players=players, objects=obj,
                            caption=caption, audio_peak=audio_peak, audio_baseline=0.05))
        i += 1
        t = round(t + spacing, 3)
    return frames


class InMemoryPerceive:
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
        return {"tool": tool, "sessionId": "vod", "streamId": "cost",
                "window": {"start": start, "end": end, "seconds": round(end - start, 3)},
                "count": len(data), "total": len(data), "truncated": False, "data": data}

    def record(self, rec: dict) -> None:
        self.trace.append(rec)


def run(cfg: WatcherConfig, frames: list[Frame], total_s: float) -> dict:
    perceive = InMemoryPerceive(frames)
    sess = WatcherSession(session_id="vod", stream_id="cost", config=cfg,
                          perceive=perceive.call, trace=perceive.record)
    sess.ingest_many(frames)
    tick = cfg.tick_s
    while tick <= total_s + 1e-6:
        sess.step(tick)
        tick = round(tick + cfg.tick_s, 3)
    c = sess.cost()
    c["trace_records_total"] = len(perceive.trace)
    c["hypotheses_seeded"] = sess.hypotheses_seeded
    return c


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--total-s", type=float, default=120.0)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    workdir = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or os.environ.get("PAPERCLIP_SCRATCH_DIR") or "."
    total = args.total_s

    # Profile A: G5 gate-default 3 fps / 30-frame chunk, no tool gate, trace every call.
    cfg_a = WatcherConfig(tick_s=3.0, window_s=10.0, fps=3.0, max_frame_count=30,
                          min_overlap=0.50, tool_gate=False, trace_write_rate=1.0)
    frames_a = synthesize_stream(total, cfg_a.fps)
    a = run(cfg_a, frames_a, total)

    # Profile B: G6 cost-tuned 2 fps / 20-frame chunk, same open tool policy.
    cfg_b = WatcherConfig(tick_s=3.0, window_s=10.0, fps=2.0, max_frame_count=20,
                          min_overlap=0.50, tool_gate=False, trace_write_rate=1.0)
    frames_b = synthesize_stream(total, cfg_b.fps)
    b = run(cfg_b, frames_b, total)

    # Profile C: G6 cost-tuned chunk + cost-gated tool policy (deep tools only on cheap signal).
    cfg_c = WatcherConfig(tick_s=3.0, window_s=10.0, fps=2.0, max_frame_count=20,
                          min_overlap=0.50, tool_gate=True, trace_write_rate=1.0)
    frames_c = synthesize_stream(total, cfg_c.fps)
    c_ = run(cfg_c, frames_c, total)

    # Profile D: G6 cost-tuned chunk + tool gate + trace-write downsampled to 1 in 4.
    cfg_d = WatcherConfig(tick_s=3.0, window_s=10.0, fps=2.0, max_frame_count=20,
                          min_overlap=0.50, tool_gate=True, trace_write_rate=0.25)
    frames_d = synthesize_stream(total, cfg_d.fps)
    d = run(cfg_d, frames_d, total)

    res = {
        "config": {
            "A_gate_default": {"fps": cfg_a.fps, "maxFrames": cfg_a.max_frame_count, "toolGate": cfg_a.tool_gate, "traceRate": cfg_a.trace_write_rate},
            "B_downsample": {"fps": cfg_b.fps, "maxFrames": cfg_b.max_frame_count, "toolGate": cfg_b.tool_gate, "traceRate": cfg_b.trace_write_rate},
            "C_downsample_gate": {"fps": cfg_c.fps, "maxFrames": cfg_c.max_frame_count, "toolGate": cfg_c.tool_gate, "traceRate": cfg_c.trace_write_rate},
            "D_full_cost": {"fps": cfg_d.fps, "maxFrames": cfg_d.max_frame_count, "toolGate": cfg_d.tool_gate, "traceRate": cfg_d.trace_write_rate},
        },
        "profiles": {"A": a, "B": b, "C": c_, "D": d},
        "knob_effects": {
            "downsample_brain_frames_pct": round((a["brain_frames"] - b["brain_frames"]) / a["brain_frames"] * 100, 1) if a["brain_frames"] else 0.0,
            "tool_gate_tool_calls_pct": round((b["tool_calls"] - c_["tool_calls"]) / b["tool_calls"] * 100, 1) if b["tool_calls"] else 0.0,
            "trace_rate_trace_pct": round((c_["trace_records"] - d["trace_records"]) / c_["trace_records"] * 100, 1) if c_["trace_records"] else 0.0,
            "frames_per_brain_call_A": a["frames_per_brain_call"],
            "frames_per_brain_call_B": b["frames_per_brain_call"],
            "tool_calls_per_tick_B": b["tool_calls_per_tick"],
            "tool_calls_per_tick_C": c_["tool_calls_per_tick"],
            "trace_per_tick_C": c_["trace_per_tick"],
            "trace_per_tick_D": d["trace_per_tick"],
        },
    }

    out = args.out or os.path.join(workdir, "decide-watcher-cost-model.json")
    with open(out, "w") as fh:
        json.dump(res, fh, indent=2)

    lines = [
        "Decide watcher — G6 cost-model quantification (ADAAAA-6743)",
        "=" * 56,
        f"stream: {total:.0f}s deterministic (mostly quiet, one notable moment @50s)",
        "",
        "PROFILE  | fps  maxF  toolGate  traceRate | frames/call  tools/tick  trace/tick",
        f"  A      | 3.0   30     no        1.00     | {a['frames_per_brain_call']:>10.2f}  {a['tool_calls_per_tick']:>9.2f}  {a['trace_per_tick']:>8.3f}",
        f"  B      | 2.0   20     no        1.00     | {b['frames_per_brain_call']:>10.2f}  {b['tool_calls_per_tick']:>9.2f}  {b['trace_per_tick']:>8.3f}",
        f"  C      | 2.0   20     yes       1.00     | {c_['frames_per_brain_call']:>10.2f}  {c_['tool_calls_per_tick']:>9.2f}  {c_['trace_per_tick']:>8.3f}",
        f"  D      | 2.0   20     yes       0.25     | {d['frames_per_brain_call']:>10.2f}  {d['tool_calls_per_tick']:>9.2f}  {d['trace_per_tick']:>8.3f}",
        "",
        "KNOB EFFECTS (relative to the gate-default profile A)",
        f"  chunk downsample (3fps/30 -> 2fps/20) lowers frames/brain call by {res['knob_effects']['downsample_brain_frames_pct']}%  (KV-cost multiplier)",
        f"  cost-gated tool policy lowers tool calls/tick by {res['knob_effects']['tool_gate_tool_calls_pct']}%  (perceive GPU + tool-call rate)",
        f"  trace-write-rate 0.25 lowers trace/tick by {res['knob_effects']['trace_rate_trace_pct']}%  (persistence write rate)",
        "",
        f"hypotheses seeded (A/B/C/D): {a['hypotheses_seeded']}/{b['hypotheses_seeded']}/{c_['hypotheses_seeded']}/{d['hypotheses_seeded']}",
        "note: cost mechanics measured in rule mode (same brain); quality gates measured separately.",
        f"evidence written to: {out}",
    ]
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

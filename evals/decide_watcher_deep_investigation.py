"""Local VOD Pass 2 + deep-investigation gate measurement (ADAAAA-6740 G3).

Drives the depth router (pass 2, sole trigger authority) + deep investigator
end to end over a VOD-style frame stream with known ground-truth highlight
moments and measures the Part 3 / Pass 2 + deep-investigation gates:

- **Depth router recall**: fraction of ground-truth highlight moments that got a
  flag (deep investigation) — acceptance >= 80 %.
- **Bounded false-positive rate**: flags that do not overlap a ground-truth
  moment, per minute — target <= 5 flags/min (bounds deep GPU cost).
- **Sole trigger authority**: flags originate only from decide's depth router
  over the pass-1 dialog; the perceive client here is a windowed-tool envelope
  returner and never emits a candidate/trigger.
- **Deep verdict truth**: for confirmed highlights (injected goals) the deep
  verdict confirms (scoring_play); non-highlight moments are discarded (no
  clip). Reported as deep precision/recall vs ground truth.
- **Noise-trigger reliability**: audio-noise-only flags are gated (gemma not
  fired — `deep_calls == 0`), and the audio-noise false-positive rate is
  measured via ``get_audio_levels``.

Rule mode (deterministic ``decide()``) stands in for the Gemma brain — this
measures the routing/verdict mechanics and the noise gate, not model quality.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services", "decide"))

from app.deep_investigation import DeepInvestigator, DeepInvestigationConfig  # noqa: E402
from app.depth_router import DepthRouter, DepthRouterConfig  # noqa: E402
from app.watcher import (  # noqa: E402
    Frame,
    WatcherConfig,
    WatcherSession,
)

# Ground-truth highlight moments (s) and audio-only noise blips (s) injected
# into a deterministic 3 fps VOD timeline.
GROUND_TRUTH = [15.0, 40.0, 65.0, 90.0, 110.0]
NOISE_BLIPS = [25.0, 55.0, 80.0, 100.0]  # audio spikes with no visual/event


def synthesize_stream(total_s: float, fps: float) -> list[Frame]:
    """Deterministic 3 fps frame stream. Injects ground-truth highlight moments
    (GOAL caption + audio burst + tracked player) and audio-only noise blips
    (energy spike, no caption, no visual) to probe the noise gate."""
    frames = []
    spacing = 1.0 / fps
    t = 0.0
    i = 0
    while t <= total_s + 1e-6:
        obj = []
        players = []
        caption = ""
        audio_peak = 0.1
        for gt in GROUND_TRUTH:
            if abs(t - gt) <= 1.5:
                players = [{"trackId": "p0", "bbox": [0.4, 0.4, 0.5, 0.5], "label": "player"}]
                obj = [{"label": "ball", "confidence": 0.9, "bbox": [0.45, 0.45, 0.5, 0.5]}]
                caption = "GOAL! crowd erupts"
                audio_peak = 0.95
                break
        for nb in NOISE_BLIPS:
            if abs(t - nb) <= 0.4:
                audio_peak = 0.9  # audio spike but NO caption / visual
                break
        frames.append(Frame(ts=round(t, 3), seq=i, players=players, objects=obj,
                            caption=caption, audio_peak=audio_peak, audio_baseline=0.05))
        i += 1
        t = round(t + spacing, 3)
    return frames


class InMemoryPerceive:
    """Windowed-tool envelope returner. NEVER emits a candidate/trigger — the
    only thing it answers is decide's own tool queries over a requested window."""

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
        return {"tool": tool, "sessionId": "vod", "streamId": "pass2",
                "window": {"start": start, "end": end, "seconds": round(end - start, 3)},
                "count": len(data), "total": len(data), "truncated": False, "data": data}

    def record(self, rec: dict) -> None:
        self.trace.append(rec)


def _covers(flag, moment: float, tol: float = 1.0) -> bool:
    """Whether a deep window overlaps (within tol) a ground-truth moment."""
    return flag.window_start - tol <= moment <= flag.window_end + tol


def run(frames: list[Frame], total_s: float) -> dict:
    perceive = InMemoryPerceive(frames)
    sess = WatcherSession(session_id="vod", stream_id="pass2",
                          config=WatcherConfig(), perceive=perceive.call, trace=perceive.record)
    depth = DepthRouter(session_id="vod", stream_id="pass2",
                        config=DepthRouterConfig(), perceive=perceive.call, trace=perceive.record)
    deep = DeepInvestigator(session_id="vod", stream_id="pass2",
                            config=DeepInvestigationConfig(), perceive=perceive.call, trace=perceive.record)

    sess.ingest_many(frames)
    flags = []
    verdicts = []
    tick = 3.0
    while tick <= total_s + 1e-6:
        row = sess.step(tick)
        depth.observe(row)
        flag = depth.step(tick)
        if flag is not None:
            flags.append(flag)
            v = deep.investigate(flag, lambda s, e: sess._frames_in(s, e))
            verdicts.append(v)
        tick = round(tick + 3.0, 3)

    # recall: fraction of ground-truth moments covered by >= 1 flag
    recalled = 0
    for gt in GROUND_TRUTH:
        if any(_covers(f, gt) for f in flags):
            recalled += 1
    recall = recalled / len(GROUND_TRUTH)

    # false positives: flags that do NOT overlap any ground-truth moment
    fp_flags = [f for f in flags if not any(_covers(f, gt) for gt in GROUND_TRUTH)]
    minutes = total_s / 60.0
    fp_rate = len(fp_flags) / minutes if minutes else 0.0

    # deep verdict truth: confirmed highlights = flags whose deep verdict kept a
    # highlight AND overlapped a ground-truth moment; any flagged moment whose
    # verdict is a non-highlight (discard) is a true "no clip".
    deep_confirmed = [v for v in verdicts if v.is_highlight]
    deep_tp = [v for v in deep_confirmed if any(_covers(v, gt) for gt in GROUND_TRUTH)]
    deep_precision = len(deep_tp) / len(deep_confirmed) if deep_confirmed else 0.0
    deep_recall = len([gt for gt in GROUND_TRUTH if any(
        v.is_highlight and _covers(v, gt) for v in verdicts)]) / len(GROUND_TRUTH)
    discards = [v for v in verdicts if v.discarded]
    no_clip_ok = all(v.discarded or v.is_highlight for v in verdicts)

    # noise-trigger reliability: deep-call gating and audio-noise FP rate
    gated = [v for v in verdicts if v.gated]
    audio_noise_fp = [v for v in gated if not any(_covers(v, gt) for gt in GROUND_TRUTH)]

    return {
        "config": {"tick_s": 3.0, "window_s": 10.0, "deep_back_s": DepthRouterConfig().deep_back_s,
                   "deep_forward_s": DepthRouterConfig().deep_forward_s,
                   "cooldown_s": DepthRouterConfig().cooldown_s},
        "stream": {"total_s": total_s, "frame_count": len(frames),
                   "ground_truth_moments": GROUND_TRUTH, "noise_blips": NOISE_BLIPS},
        "gates": {
            "flags_emitted": len(flags),
            "ground_truth_moments": len(GROUND_TRUTH),
            "recalled_moments": recalled,
            "depth_router_recall": round(recall, 4),
            "depth_router_recall_ge_80pct": recall >= 0.80,
            "min_flag_rate_per_min": round(len(flags) / minutes, 3),
            "fp_flags": len(fp_flags),
            "fp_rate_per_min": round(fp_rate, 3),
            "fp_rate_le_5_per_min": fp_rate <= 5.0,
            "deep_confirmed": len(deep_confirmed),
            "deep_precision": round(deep_precision, 4),
            "deep_recall": round(deep_recall, 4),
            "deep_discards": len(discards),
            "no_clip_on_discard": no_clip_ok,
            "deep_gated_discards": len(gated),
            "deep_calls": deep.deep_calls,
            "gated_discard_calls": deep.gated_discards,
            "audio_noise_fp_flags": len(audio_noise_fp),
            "audio_noise_fp_rate_per_min": round(len(audio_noise_fp) / minutes, 3),
        },
        "flags": [{"ts": f.ts, "window": [f.window_start, f.window_end], "event": f.event,
                   "score": round(f.score, 1), "audioOk": f.audio_ok} for f in flags],
        "verdicts": [{"flagTs": v.flag_ts, "event": v.event, "outcome": v.outcome,
                      "isHighlight": v.is_highlight, "discarded": v.discarded,
                      "gated": v.gated} for v in verdicts],
        "trace_records": len(perceive.trace),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--total-s", type=float, default=120.0)
    ap.add_argument("--out", default=None, help="evidence JSON path")
    args = ap.parse_args()

    frames = synthesize_stream(args.total_s, 3.0)
    result = run(frames, args.total_s)

    workdir = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or os.environ.get("PAPERCLIP_SCRATCH_DIR") or "."
    out = args.out or os.path.join(workdir, "decide-watcher-deep-investigation-evidence.json")
    with open(out, "w") as fh:
        json.dump(result, fh, indent=2)

    g = result["gates"]
    lines = [
        "Decide depth router + deep investigation — Pass 2 gate evidence",
        "=" * 52,
        f"stream: {result['stream']['total_s']:.0f}s, {result['stream']['frame_count']} frames",
        f"ground-truth highlights: {result['stream']['ground_truth_moments']}",
        f"audio noise blips       : {result['stream']['noise_blips']}",
        "",
        "PASS 2 — DEPTH ROUTER (sole trigger authority)",
        f"  flags emitted            : {g['flags_emitted']}",
        f"  depth-router recall      : {g['depth_router_recall']:.1%}   (>=80%: {g['depth_router_recall_ge_80pct']})",
        f"  flag rate                : {g['min_flag_rate_per_min']:.2f}/min",
        f"  FP flags (non-highlight) : {g['fp_flags']}   rate {g['fp_rate_per_min']:.2f}/min   (<=5/min: {g['fp_rate_le_5_per_min']})",
        "",
        "DEEP INVESTIGATION (verdict resolves through the single accept gate)",
        f"  deep confirmed           : {g['deep_confirmed']}",
        f"  deep precision           : {g['deep_precision']:.1%}",
        f"  deep recall              : {g['deep_recall']:.1%}",
        f"  deep discards (no clip)  : {g['deep_discards']}",
        f"  no clip on discard       : {g['no_clip_on_discard']}",
        "",
        "NOISE-TRIGGER RELIABILITY (gated by decide via get_audio_levels)",
        f"  deep-call gated discards : {g['gated_discard_calls']}",
        f"  audio-noise FP rate      : {g['audio_noise_fp_rate_per_min']:.2f}/min",
        "",
        f"trace records (analysis_session_traces): {result['trace_records']}",
        f"evidence written to: {out}",
    ]
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

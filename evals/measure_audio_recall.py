#!/usr/bin/env python3
"""Real-audio measurement for the Stage-A audio gate (ADAAAA-4970 / ADAAAA-7674).

Quantifies audio-gate fidelity per trigger class under continuous crowd noise on
real clips. Pure DSP — ffmpeg only to decode the audio track; no gemma, no billed
GPU path.

Two modes:

1. **Per-class mode (ADAAAA-7674 AC1/AC2)** — score every class in the label
   manifest and print the fidelity table:

       python3 evals/measure_audio_recall.py \
           --labels evals/audio-labels.json --clip-root /data

   Each class reports recall, trigger-window false-positive rate, and
   onset->fire p50/p95. A class whose manifest entry has ``clip: null`` is
   printed as ``N/A`` with its recorded gap reason — a gap is not a pass.

2. **Before/after mode (ADAAAA-4970)** — compare the legacy INC-2 operating
   point with the current defaults on one clip/goal list:

       python3 evals/measure_audio_recall.py \
           --clip /data/real_goal_3080.mp4 \
           --goals 0,2,11,... [--frame-s 0.1] [--sr 8000]

``--goals`` are the video-rail accepted GOAL timestamps (seconds) for the clip;
recall = fraction with a gate candidate within [ts-pre, ts+post].

Needs numpy + the gate module (run where perceive deps exist, e.g. the box
perceive venv/container or the box host). The energy extractor is pure stdlib.
"""
import argparse
import json
import os
import struct
import subprocess
import sys
import tempfile

import numpy as np


def extract_energies(clip: str, sr: int, frame_s: float):
    """ffmpeg -> mono s16le PCM (pure stdlib to compute per-frame RMS energy)."""
    n = int(sr * frame_s)
    with tempfile.TemporaryDirectory() as td:
        pcm = os.path.join(td, "a.pcm")
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", clip,
             "-ac", "1", "-ar", str(sr), "-c:a", "pcm_s16le", "-f", "s16le", pcm],
            check=True, capture_output=True,
        )
        data = open(pcm, "rb").read()
    out = []
    o = 0
    bytes_per = 2 * n
    while o + bytes_per <= len(data):
        s = struct.unpack("<%dh" % n, data[o:o + bytes_per])
        o += bytes_per
        ss = 0.0
        for x in s:
            ss += x * x
        out.append(min(1.0, (ss / n) ** 0.5 / 32768.0))
    return out


def load_gate():
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "..", "services", "perceive", "app", "audio_gate.py")
    spec = importlib.util.spec_from_file_location("audio_gate", os.path.normpath(path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["audio_gate"] = mod
    spec.loader.exec_module(mod)
    return mod.AudioEnergyGate, mod.GateConfig


def run_gate(gate_cls, cfg, energies, frame_s):
    g = gate_cls(cfg)
    fires = []
    lats = []
    kinds = []
    for i, e in enumerate(energies):
        sig = g.update(np.full(800, min(1.0, e)), ts=i * frame_s)
        if sig is not None:
            fires.append(sig.ts)
            lats.append(sig.onset_latency_s)
            kinds.append(sig.threshold_id or sig.kind)
    return fires, lats, kinds


def pc(lats, p):
    if not lats:
        return 0.0
    s = sorted(lats)
    return s[min(len(s) - 1, int(p * len(s)))]


def measure(gate_cls, cfg, energies, frame_s, onsets, pre, post):
    fires, lats, kinds = run_gate(gate_cls, cfg, energies, frame_s)
    onsets = sorted(set(onsets))
    rec = sum(1 for t in onsets if any(f >= t - pre and f <= t + post for f in fires))
    fp = sum(1 for f in fires if not any(t - pre <= f <= t + post for t in onsets))
    return {
        "candidates": len(fires),
        "events": len(onsets),
        "recalled": rec,
        "recall": rec / len(onsets) if onsets else 0.0,
        "fp": fp,
        "fp_rate": fp / len(fires) if fires else 0.0,
        "p50": pc(lats, 0.5),
        "p95": pc(lats, 0.95),
        "max_lat": max(lats) if lats else 0.0,
        "threshold_ids": sorted(set(kinds)),
    }


def per_class(args):
    """Score every class in the manifest; return the table rows."""
    manifest = json.load(open(args.labels))
    gate_cls, GateConfig = load_gate()
    rows = []
    for cls in manifest["classes"]:
        row = {"id": cls["id"], "clip": cls.get("clip"), "measured": bool(cls.get("measured"))}
        if not cls.get("clip"):
            row.update(measured=False, gap_reason=cls.get("gapReason", ""))
            rows.append(row)
            continue
        path = cls["clip"]
        if args.clip_root:
            path = os.path.join(args.clip_root, cls["clip"])
        if not os.path.exists(path):
            row.update(measured=False, gap_reason=f"clip not found at {path}")
            rows.append(row)
            continue
        energies = extract_energies(path, manifest.get("sr", args.sr), manifest.get("frameS", args.frame_s))
        cfg = GateConfig(frame_s=manifest.get("frameS", args.frame_s))
        m = measure(gate_cls, cfg, energies,
                    manifest.get("frameS", args.frame_s), cls["onsets"],
                    manifest.get("matchPre", args.match_pre), manifest.get("matchPost", args.match_post))
        row.update(m, measured=True)
        if args.compare_lookback is not None:
            base_cfg = GateConfig(frame_s=manifest.get("frameS", args.frame_s),
                                  lookback_s=args.compare_lookback)
            row["baseline"] = measure(gate_cls, base_cfg, energies,
                                      manifest.get("frameS", args.frame_s), cls["onsets"],
                                      manifest.get("matchPre", args.match_pre),
                                      manifest.get("matchPost", args.match_post))
        rows.append(row)
    return rows


def print_table(rows, compare):
    print("| class | clip | events | candidates | recall | FP windows | FP rate | onset->fire p50 | p95 |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        if not r.get("measured"):
            print(f"| {r['id']} | N/A | N/A | N/A | **N/A** | N/A | N/A | N/A | N/A |")
            continue
        print(f"| {r['id']} | `{r['clip']}` | {r['events']} | {r['candidates']} | "
              f"{r['recall']:.2f} ({r['recalled']}/{r['events']}) | {r['fp']} | {r['fp_rate']:.2f} | "
              f"{r['p50']:.2f} s | {r['p95']:.2f} s |")
    if compare:
        print("\n| class | lookback | recall | FP rate | candidates | p50 | p95 |")
        print("| --- | --- | --- | --- | --- | --- | --- |")
        for r in rows:
            if not r.get("measured") or "baseline" not in r:
                continue
            b, c = r["baseline"], r
            print(f"| {r['id']} | {compare:.1f} s -> current | "
                  f"{b['recall']:.2f} -> {c['recall']:.2f} | {b['fp_rate']:.2f} -> {c['fp_rate']:.2f} | "
                  f"{b['candidates']} -> {c['candidates']} | {b['p50']:.2f} -> {c['p50']:.2f} | "
                  f"{b['p95']:.2f} -> {c['p95']:.2f} |")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", help="clip path (before/after mode)")
    ap.add_argument("--goals", help="comma-separated goal timestamps (s) (before/after mode)")
    ap.add_argument("--labels", help="label manifest path (per-class mode)")
    ap.add_argument("--clip-root", help="directory the manifest clip names resolve against (e.g. /data)")
    ap.add_argument("--class", dest="classes", action="append",
                    help="only score these class ids (repeatable; default: all)")
    ap.add_argument("--frame-s", type=float, default=0.1)
    ap.add_argument("--sr", type=int, default=8000)
    ap.add_argument("--match-pre", type=float, default=3.0)
    ap.add_argument("--match-post", type=float, default=2.0)
    ap.add_argument("--compare-lookback", type=float, default=None,
                    help="also score the class at this lookback_s to show the tuning delta")
    ap.add_argument("--json", help="write the machine-readable result to this path")
    ap.add_argument("--only", choices=["old", "new"], default=None)
    a = ap.parse_args()

    if a.labels:
        rows = per_class(a)
        if a.classes:
            rows = [r for r in rows if r["id"] in a.classes]
        print_table(rows, a.compare_lookback)
        for r in rows:
            if not r.get("measured"):
                print(f"\nN/A — {r['id']}: {r.get('gap_reason', 'no footage')}")
        if a.json:
            json.dump({"classes": rows, "frameS": a.frame_s}, open(a.json, "w"), indent=2)
        return

    if not (a.clip and a.goals):
        ap.error("either --labels or both --clip and --goals are required")
    goals = [float(x) for x in a.goals.split(",") if x.strip() != ""]
    energies = extract_energies(a.clip, a.sr, a.frame_s)
    gate_cls, GateConfig = load_gate()

    old = GateConfig(frame_s=a.frame_s, burst_ratio=3.0, burst_min_frames=10,
                     swell_ratio=1.5, swell_seconds=3.0, cooldown_s=5.0)
    new = GateConfig(frame_s=a.frame_s)  # current noise-adaptive defaults

    def show(label, cfg):
        m = measure(gate_cls, cfg, energies, a.frame_s, goals, a.match_pre, a.match_post)
        print(f"{label}: candidates={m['candidates']} goals={m['events']} "
              f"recalled={m['recalled']} recall={m['recall']:.2f} "
              f"fp={m['fp']} fp_rate={m['fp_rate']:.2f} p50={m['p50']:.2f}s p95={m['p95']:.2f}s "
              f"max_lat={m['max_lat']:.2f}s threshold={m['threshold_ids']}")

    if a.only in (None, "old"):
        show("OLD (INC-2 budget)", old)
    if a.only in (None, "new"):
        show("NEW (current)", new)


if __name__ == "__main__":
    main()

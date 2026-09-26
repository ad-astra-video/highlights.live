#!/usr/bin/env python3
"""Real-audio before/after measurement for the Stage-A audio gate (ADAAAA-4970).

Quantifies audio-gate goal recall under continuous crowd noise on a real
soccer clip, comparing the ORIGINAL INC-2 operating point (burst 3x/1s/5s
cooldown) with the ADAAAA-4970 noise-adaptive operating point (burst 1.8x/0.3s
/2s cooldown, the new default). Pure DSP — ffmpeg only to decode the audio
track; no gemma, no billed GPU path.

Usage:

    python3 evals/measure_audio_recall.py \
        --clip /data/real_goal_3080.mp4 \
        --goals 0,2,11,13,15,17,19,21,23,25,28,32,34,36,39,56,58,60,62,64,66,68,70,71,74,76,77,82,83,86,89,93 \
        [--frame-s 0.1] [--sr 8000] [--match-pre 3.0] [--match-post 2.0]

``--goals`` are the video-rail accepted GOAL timestamps (seconds) for the clip
(ground truth); recall = fraction with a gate candidate within [ts-pre, ts+post].
``--old``/``--new`` select which operating points to report (default: both).

Prints per-config: candidate count, recalled/goals, recall, FP-rate (fraction
of candidates not near any goal), onset->fire latency p50/p95/max.

Needs numpy + the gate module (run where perceive deps exist, e.g. the box
perceive venv/container). The energy extractor is pure stdlib.
"""
import argparse
import json
import struct
import subprocess
import sys
import tempfile
import os

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
    for i, e in enumerate(energies):
        sig = g.update(np.full(800, min(1.0, e)), ts=i * frame_s)
        if sig is not None:
            fires.append(sig.ts)
            lats.append(sig.onset_latency_s)
    return fires, lats


def pc(lats, p):
    if not lats:
        return 0.0
    s = sorted(lats)
    return s[min(len(s) - 1, int(p * len(s)))]


def measure(gate_cls, cfg, energies, frame_s, goals, pre, post):
    fires, lats = run_gate(gate_cls, cfg, energies, frame_s)
    goals = sorted(set(goals))
    rec = sum(1 for t in goals if any(f >= t - pre and f <= t + post for f in fires))
    fp = sum(1 for f in fires if not any(f >= t - pre and f <= t + post for t in goals))
    return {
        "candidates": len(fires),
        "goals": len(goals),
        "recalled": rec,
        "recall": rec / len(goals) if goals else 0.0,
        "fp_rate": fp / len(fires) if fires else 0.0,
        "p50": pc(lats, 0.5),
        "p95": pc(lats, 0.95),
        "max_lat": max(lats) if lats else 0.0,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", required=True)
    ap.add_argument("--goals", required=True, help="comma-separated goal timestamps (s)")
    ap.add_argument("--frame-s", type=float, default=0.1)
    ap.add_argument("--sr", type=int, default=8000)
    ap.add_argument("--match-pre", type=float, default=3.0)
    ap.add_argument("--match-post", type=float, default=2.0)
    ap.add_argument("--only", choices=["old", "new"], default=None)
    a = ap.parse_args()
    goals = [float(x) for x in a.goals.split(",") if x.strip() != ""]
    energies = extract_energies(a.clip, a.sr, a.frame_s)
    gate_cls, GateConfig = load_gate()

    old = GateConfig(frame_s=a.frame_s, burst_ratio=3.0, burst_min_frames=10,
                     swell_ratio=1.5, swell_seconds=3.0, cooldown_s=5.0)
    new = GateConfig(frame_s=a.frame_s)  # ADAAAA-4970 noise-adaptive defaults

    def show(label, cfg):
        m = measure(gate_cls, cfg, energies, a.frame_s, goals, a.match_pre, a.match_post)
        print(f"{label}: candidates={m['candidates']} goals={m['goals']} "
              f"recalled={m['recalled']} recall={m['recall']:.2f} "
              f"fp_rate={m['fp_rate']:.2f} p50={m['p50']:.2f}s p95={m['p95']:.2f}s "
              f"max_lat={m['max_lat']:.2f}s")

    if a.only in (None, "old"):
        show("OLD (INC-2 budget)", old)
    if a.only in (None, "new"):
        show("NEW (ADAAAA-4970)", new)


if __name__ == "__main__":
    main()

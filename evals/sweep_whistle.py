#!/usr/bin/env python3
"""Sweep whistle operating points on the AC0 label corpus (measure-only, CPU).

Prints recall (original labelled onsets only) / in-clip FP / negative-window FP
for each candidate config so the ship gate (recall >= 0.80, FP <= 0.10) is
judged from data. Verified onsets found after labelling are in `detectedOnsets`
and count as true positives for FP accounting, never as recall.
"""
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
import measure_audio_recall as m  # noqa: E402

ROOT = "/home/brad/highlights.live/docker/data"
mod = m.load_gate()
manifest = json.load(open(os.path.join(here, "audio-labels.json")))
cls = [c for c in manifest["classes"] if c["id"] == "whistle"][0]
frame_s = manifest["frameS"]
sr = cls["sr"]
pre, post = manifest["matchPre"], manifest["matchPost"]


class Args:
    clip_root = ROOT


args = Args()

variants = []
for ratio in (3.0, 4.0, 5.0, 6.0):
    for flatness in (0.35, 0.25):
        variants.append({"whistle_ratio": ratio, "max_flatness": flatness})
for ratio in (3.0, 4.0):
    variants.append({"whistle_ratio": ratio, "max_flatness": 0.25, "sustain_frames": 2})

rows = []
for opts in variants:
    rec = fp = events = cands = 0
    lats = []
    for seg in cls["clips"]:
        path = os.path.join(ROOT, seg["clip"])
        gate = m.build_gate(mod, "whistle", frame_s, sr, **opts)
        fires, slats, kinds = m.run_gate_stream(path, sr, frame_s, gate)
        segm = m.measure_fires(fires, slats, kinds, seg["onsets"], pre, post,
                               known=seg.get("detectedOnsets", ()))
        rec += segm["recalled"]
        fp += segm["fp"]
        events += segm["events"]
        cands += len(fires)
        lats += slats
    neg = m.measure_negatives(mod, args, manifest, cls, sr, frame_s, "whistle", overrides=opts)
    rows.append({
        "opts": opts,
        "recall": round(rec / events, 3),
        "recalled": f"{rec}/{events}",
        "fp_candidates": fp,
        "candidates": cands,
        "fp_rate": round(fp / cands, 3) if cands else 0.0,
        "neg_fp_windows": neg["fp_windows"],
        "neg_fires": neg["candidates"],
        "neg_windows": neg["windows"],
        "neg_rate": round(neg["fp_window_rate"], 3),
        "p50": m.pc(lats, 0.5),
    })

rows.sort(key=lambda r: (r["fp_rate"] + r["neg_rate"], -r["recall"]))
for r in rows:
    print(json.dumps(r))

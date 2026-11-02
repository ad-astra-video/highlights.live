#!/usr/bin/env python3
"""Answer the roster-cap question from a detection slice (ADAAAA-7801 AC2).

The 3-object live cap and the 8-object VOD cap are NOT a detector property -
they are a roster capacity on the deployed tracker (`app.tracker.IoUTracker`,
capacity clamped per mode in `app.tracking_plan`). So the question "what does
each cap keep and drop on a crowded frame" is answered by stepping the frame's
real detections through the deployed tracker at each capacity and counting the
boxes the roster can carry versus the ones it has to drop.

Counting rule (same as `evals/measure_motion_recall.py`, which produced the
ADAAAA-7788 roster table): at one frame the tracker holds at most `capacity`
slots, so `kept = len(tracks)` and `dropped = max(0, len(boxes) - kept)`.

Reported per cap: clip totals, the frames that saturate the roster, and the
densest frame in the slice with its kept/dropped counts and shares. It never
invents a detection: an empty slice reports zeros, not a synthetic roster.

Run:  python3 evals/roster_cap_case.py <slice.json> --json out.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "services", "perceive"))

from app.tracker import IoUTracker  # noqa: E402


def cap_run(windows, capacity: int, lost_before_evict: int = 8) -> dict:
    """Step every window through a fresh tracker at one capacity."""
    frames = []
    detections = 0
    dropped = 0
    frames_at_cap = 0
    max_kept = 0
    for w in windows:
        tr = IoUTracker(capacity=capacity, lost_before_evict=lost_before_evict)
        for frame in w.get("frames") or []:
            objects = frame.get("objects") or []
            boxes = [tuple(o["bbox"]) for o in objects if len(o.get("bbox") or []) >= 4]
            labels = [str(o.get("label") or "") for o in objects if len(o.get("bbox") or []) >= 4]
            tracks = tr.step(boxes, ts=float(frame.get("t") or 0.0), labels=labels)
            kept = len(tracks)
            d = max(0, len(boxes) - kept)
            detections += len(boxes)
            dropped += d
            max_kept = max(max_kept, kept)
            if kept >= capacity:
                frames_at_cap += 1
            frames.append({
                "window": w.get("id"),
                "t": frame.get("t"),
                "detections": len(boxes),
                "kept": kept,
                "dropped": d,
            })
    densest = max(frames, key=lambda f: f["detections"], default=None)
    return {
        "cap": capacity,
        "frames": len(frames),
        "framesAtCap": frames_at_cap,
        "detections": detections,
        "keptTotal": detections - dropped,
        "droppedTotal": dropped,
        "droppedShare": round(dropped / detections, 4) if detections else None,
        "maxKept": max_kept,
        "densestFrame": densest,
        # The 22-player question can be answered two ways, and they are not the
        # same evidence. If a measured frame carries >= 22 detections, its
        # `densestFrame` numbers ARE the measurement. Otherwise this block is
        # roster ARITHMETIC at N=22 and is labelled as such, so no reader can
        # mistake a computed slot count for an observed crowded frame.
        "at22Objects": {
            "detections": 22,
            "kept": min(capacity, 22),
            "dropped": max(0, 22 - capacity),
            "droppedShare": round(max(0, 22 - capacity) / 22, 4),
            "basis": "roster arithmetic at N=22 (cap slots), not a measured frame",
        },
        "perFrame": frames,
    }


def build_doc(slice_doc: dict, caps: list[int], lost_before_evict: int = 8) -> dict:
    windows = slice_doc.get("windows") or []
    densest = None
    for w in windows:
        for f in w.get("frames") or []:
            n = len(f.get("objects") or [])
            if densest is None or n > densest["detections"]:
                densest = {"window": w.get("id"), "t": f.get("t"), "detections": n}
    runs = {str(c): cap_run(windows, c, lost_before_evict) for c in caps}
    return {
        "slice": {
            "profile": slice_doc.get("profile"),
            "fps": slice_doc.get("fps"),
            "frames": slice_doc.get("frames"),
            "windows": [w.get("id") for w in windows],
            "detector": slice_doc.get("detector"),
            "detectorModel": slice_doc.get("detectorModel"),
            "source": slice_doc.get("source"),
        },
        "densestFrameInSlice": densest,
        "has22ObjectFrame": bool(densest and densest["detections"] >= 22),
        "caps": runs,
        "note": (
            "kept/dropped are the deployed roster's slots at one frame "
            "(kept = len(tracks), dropped = detections - kept); the tracker is "
            "app.tracker.IoUTracker at the shipped lost_before_evict."
        ),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("slice", help="detection slice json (schema of detect_slice_from_windows)")
    ap.add_argument("--caps", default="3,8", help="roster capacities to test (live 3 / VOD 8)")
    ap.add_argument("--lost-before-evict", type=int, default=8)
    ap.add_argument("--json", default=None, help="write the full per-frame document here")
    args = ap.parse_args()

    slice_doc = json.load(open(args.slice))
    caps = [int(c) for c in args.caps.split(",") if c.strip()]
    doc = build_doc(slice_doc, caps, args.lost_before_evict)

    dense = doc["densestFrameInSlice"]
    print(f"roster cap case  profile={doc['slice']['profile']} "
          f"frames={doc['slice']['frames']} windows={doc['slice']['windows']}")
    if dense:
        print(f"  densest frame: window {dense['window']} t={dense['t']}s "
              f"detections={dense['detections']}")
        print(f"  a >=22-object frame exists in this slice: {doc['has22ObjectFrame']}")
    for cap, run in doc["caps"].items():
        d = run["densestFrame"]
        share = (d["dropped"] / d["detections"]) if d and d["detections"] else None
        print(f"  cap {cap}: framesAtCap {run['framesAtCap']}/{run['frames']}  "
              f"maxKept {run['maxKept']}  dropped {run['droppedTotal']}"
              f"/{run['detections']} ({run['droppedShare']})"
              + (f"  densest-frame kept {d['kept']} dropped {d['dropped']}"
                 f" of {d['detections']} ({share:.4f})" if d else ""))
    for cap, run in doc["caps"].items():
        r22 = run.get("at22Objects")
        if r22:
            print(f"  at 22 concurrent objects, cap {cap}: keeps {r22['kept']}, "
                  f"drops {r22['dropped']} ({r22['droppedShare']})")
    if args.json:
        os.makedirs(os.path.dirname(os.path.abspath(args.json)) or ".", exist_ok=True)
        with open(args.json, "w") as fh:
            json.dump(doc, fh, indent=1)
        print(f"wrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Objective whole-video goal-candidate detector for the kids_soccer eval.

A goal on this broadcast always moves the top-left score digits (the RMA/BAR
bar). This script walks the 3 fps job frames (``f_{t:04d}.jpg`` = job frame
``seq = 3*t``) and flags every second where the *score-digit* region of the
scoreboard changes sharply from the previous visible second. It is the cheap,
objective half of an "exhaustive goal catalogue": it produces a short list of
candidate goal instants that a human/vision pass then confirms or refutes on
the frames (ball in net / GOL graphic / celebration).

It is NOT a ground-truth labeller by itself — the score digits are read from
pixel differences, so a change can also be a broadcast cut where the overlay
is re-rendered. Treat every candidate as "inspect these frames", not "goal
confirmed".

Pure stdlib + numpy + Pillow. No network, no GPU.

Usage
-----
  python3 detect_scoreboard_changes.py --frames /tmp/hl7590_frames --out candidates.json

Exit code 0 always (this is a detector, not a gate); it prints one line per
candidate and writes the JSON list.
"""
import argparse
import json
import os

import numpy as np
from PIL import Image

# Scoreboard geometry for kids_soccer.mp4 (640x360 frames). The white clock
# box sits at top-left x~6-60, y~10-34; the red RMA/BAR bar is x~89-165,
# y~14-31; the SCORE DIGITS (what we diff) are the middle of the bar,
# x~112-154, y~14-31. The clock digits are outside x112-154, so diffing this
# box isolates the score, not the running clock.
PRESENT_BOX = (6, 10, 60, 34)
DIGIT_BOX = (112, 14, 154, 31)
PRESENT_FRAC = 0.6      # fraction of >200-luma px that counts as "overlay visible"
DIFF_THRESHOLD = 8.0    # mean abs luma diff over the digit box that counts as a change


def frame_luma(frames_dir, t):
    path = f"{frames_dir}/f_{t:04d}.jpg"
    if not os.path.exists(path):
        return None
    return np.asarray(Image.open(path).convert("L"), dtype=np.float32)


def is_present(luma):
    crop = luma[PRESENT_BOX[1]:PRESENT_BOX[3], PRESENT_BOX[0]:PRESENT_BOX[2]]
    return (crop > 200).mean() > PRESENT_FRAC


def digit_slice(luma):
    return luma[DIGIT_BOX[1]:DIGIT_BOX[3], DIGIT_BOX[0]:DIGIT_BOX[2]]


def detect(frames_dir, t0, t1, threshold=DIFF_THRESHOLD):
    prev = None
    events = []
    for t in range(t0, t1 + 1):
        luma = frame_luma(frames_dir, t)
        if luma is None or not is_present(luma):
            prev = None
            continue
        a = digit_slice(luma)
        if prev is not None:
            d = float(np.abs(a - prev).mean())
            if d > threshold:
                events.append({"t": t, "diff": round(d, 1)})
        prev = a
    # collapse adjacent event seconds into candidate instants
    groups = []
    for e in events:
        if groups and e["t"] - groups[-1][-1]["t"] <= 2:
            groups[-1].append(e)
        else:
            groups.append([e])
    return [{"t0": g[0]["t"], "t1": g[-1]["t"],
             "maxdiff": max(x["diff"] for x in g)} for g in groups]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--frames", required=True, help="dir of f_%04d.jpg 1fps frames")
    ap.add_argument("--out", default=None, help="optional JSON output path")
    ap.add_argument("--from", dest="t0", type=int, default=0)
    ap.add_argument("--to", dest="t1", type=int, default=776)
    ap.add_argument("--threshold", type=float, default=DIFF_THRESHOLD)
    args = ap.parse_args()

    cand = detect(args.frames, args.t0, args.t1, args.threshold)
    for c in cand:
        print(f"  candidate t={c['t0']}-{c['t1']} maxdiff={c['maxdiff']}")
    print(f"total {len(cand)} candidates (inspect each on the frames to confirm/refute)")
    if args.out:
        with open(args.out, "w") as f:
            json.dump(cand, f, indent=1)
        print("wrote", args.out)


if __name__ == "__main__":
    main()

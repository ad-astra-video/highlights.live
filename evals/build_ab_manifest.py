#!/usr/bin/env python3
"""build_ab_manifest.py — materialize the ADAAAA-7279 labeled A/B eval manifest
from the box's real broadcast tracking GT (soc_testset_manifest.json).

Consumes:
  --gt   path to soc_testset_manifest.json (the labeled soccer test clip set)
  --clip substring to select (default 'jersey9')
  --out  output JSONL path

Each emitted row is a DetectionTrainingSample-style labeled frame:
  {"id":..., "frame": int, "image": "", "objects":[{"label":..., "bbox":[...]}]}

The frame PIXELS stay on the box as docker/data/clips/<clip>.mp4.frames/f{frame:04d}.png
and are read by measure_molmo2_ab.py via --frames-root. This script only emits the
labels; the images are read at eval time from --frames-root.

Run on the box (or anywhere with the GT JSON):
  python3 evals/build_ab_manifest.py \
      --gt /home/brad/highlights.live/docker/data/clips/soc_testset_manifest.json \
      --clip jersey9 --out evals/ab_eval_manifest.jsonl
"""
from __future__ import annotations

import argparse
import json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gt", required=True)
    ap.add_argument("--clip", default="jersey9")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    d = json.load(open(args.gt))
    clips = [c for c in d.get("clips", []) if args.clip in c["id"]]
    if not clips:
        raise SystemExit(f"no clip matching {args.clip!r} in {args.gt}")
    c = clips[0]

    def label_of(kind):
        return "player" if kind == "player" else "soccer ball"

    rows = []
    for f in c["frames"]:
        objs = [{"label": label_of(o["kind"]),
                 "bbox": [round(float(b), 6) for b in o["bbox"]]}
                for o in f["objects"]]
        rows.append({"id": f"{args.clip}-{f['frame']}", "frame": f["frame"],
                     "image": "", "objects": objs})
    with open(args.out, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    print(f"wrote {len(rows)} labeled frames -> {args.out}  (clip {c['id']})")


if __name__ == "__main__":
    main()

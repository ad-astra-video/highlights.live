#!/usr/bin/env python3
"""Build the REAL-IMAGE held-out detection eval slice (ADAAAA-5166).

The detection eval slice is a held-out set of REAL labeled broadcast frames —
never the synthetic `evals/track_label_manifest.json` (that is the tracker's
held-out evaluation and has no image pixels). The real labeled frames are
produced by the data path (ADAAAA-5164) and exported as
`evals/train_manifest.jsonl` / `evals/val_manifest.jsonl` under the shared
`DetectionTrainingSample` contract.

This builder:
  1. Validates both manifests against the shared DetectionTrainingSample contract
     (`evals/detect_schema.py` — Python mirror of packages/events).
  2. Reports class coverage vs the plan ADAAAA-5159 §1.3 targets.
  3. Materializes the HELD-OUT EVAL SLICE as `evals/detect_eval_slice.jsonl`
     = the validated val-set frames (the held-out 15%), each verified to point
     at an existing real image (so the harness runs on real pixels), and reports
     image availability.

Run:
    python3 evals/build_detect_eval_slice.py
    python3 evals/build_detect_eval_slice.py --val val_manifest.jsonl --train train_manifest.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import detect_schema  # noqa: E402

# plan ADAAAA-5159 §1.3 target labeled-instance coverage (per class)
COVERAGE_TARGETS = {
    "player": (4000, 6000),
    "soccer ball": (1500, 2500),
    "goalkeeper": (300, 500),
    "goal": (200, 400),
    "referee": (200, 300),
}


def _coverage(objects):
    from collections import Counter
    return Counter(o["label"] for o in objects)


def resolve_image(image_ref):
    if os.path.exists(image_ref):
        return image_ref
    cand = os.path.join(HERE, "..", "data", "training", os.path.basename(image_ref))
    if os.path.exists(cand):
        return cand
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default=os.path.join(HERE, "train_manifest.jsonl"))
    ap.add_argument("--val", default=os.path.join(HERE, "val_manifest.jsonl"))
    ap.add_argument("--out", default=os.path.join(HERE, "detect_eval_slice.jsonl"))
    args = ap.parse_args()

    report: dict = {"train": None, "val": None}
    touched = False
    for key, path in (("train", args.train), ("val", args.val)):
        if not os.path.exists(path):
            print(f"[{key}] manifest not present: {path} (data path export pending — skipping)")
            continue
        valid, invalid = detect_schema.validate_manifest(path)
        print(f"[{key}] {path}")
        print(f"    schema validation: {len(valid)} valid, {len(invalid)} invalid")
        if invalid:
            for e in invalid[:10]:
                print("      INVALID", e)
        samples = [s["sample"] for s in valid]
        cov = {}
        for s in samples:
            for lbl, n in _coverage(s.get("objects", [])).items():
                cov[lbl] = cov.get(lbl, 0) + n
        report[key] = {
            "path": path, "valid": len(valid), "invalid": len(invalid),
            "frames": len(samples), "classCoverage": cov,
        }
        touched = True
        print(f"    frames: {len(samples)}")
        total = 0
        for lbl in sorted(cov):
            n = cov[lbl]
            total += n
            lo, hi = COVERAGE_TARGETS.get(lbl, (None, None))
            tag = f"[target {lo}-{hi}]" if lo is not None else ""
            print(f"      {lbl:<12} {n:>6} {tag}")
        print(f"    total labeled instances: {total}")

    # materialize the held-out eval slice from the validated val manifest
    if report.get("val"):
        val_samples = []
        valid, _ = detect_schema.validate_manifest(args.val)
        for entry in valid:
            s = entry["sample"]
            img = resolve_image(s["imageRef"])
            s = dict(s)
            s["__imageResolved"] = bool(img)
            val_samples.append(s)
        # write eval slice (held-out val set), keeping the DetectionTrainingSample
        # fields intact on each line (strip the __imageResolved marker only in-file)
        with open(args.out, "w") as fh:
            for s in val_samples:
                row = {k: v for k, v in s.items() if k != "__imageResolved"}
                fh.write(json.dumps(row) + "\n")
        n_img = sum(1 for s in val_samples if s["__imageResolved"])
        print(f"\nheld-out eval slice written: {args.out} "
              f"({len(val_samples)} frames, {n_img} with resolvable real image)")
        if n_img < len(val_samples):
            print("  WARNING: some val imageRefs not resolvable — expected until the data "
                  "path lands real labeled frames in data/training/.")
    else:
        print("\nNo val manifest: cannot materialize the held-out eval slice. "
              "Run once the data path (ADAAAA-5164) exports the real labeled manifests.")

    if not touched:
        print("No manifests available; nothing to build.")
        return 2
    out_report = os.path.join(HERE, "detect_eval_slice_report.json")
    with open(out_report, "w") as fh:
        json.dump(report, fh, indent=2)
    print(f"coverage report: {out_report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

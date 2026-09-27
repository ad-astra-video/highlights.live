#!/usr/bin/env python3
"""Pure-stdlib Python mirror of the shared `DetectionTrainingSample` contract.

The authoritative schema lives in TS/Zod at
`packages/events/src/index.ts` (`DetectionTrainingSampleSchema`, plan
ADAAAA-5159 §2.2). This module re-encodes that exact contract so the Python
eval harness (`evals/detect_precision.py`) can validate the train/val
manifests (`evals/train_manifest.jsonl`, `evals/val_manifest.jsonl`) it
consumes, without depending on Node or the TS type system at eval time.

Rules mirror `DetectionTrainingSampleSchema` 1:1:

    DetectionTrainingSample {
      id: string
      imageRef: string          // source image (URL or s3/box path)
      width: number; height: number
      objects: Array<{
        label: string
        bbox: [x1, y1, x2, y2]  // normalized 0..1
      }>
    }

`objects` defaults to [] when absent (Zod `.default([])`).
"""

from __future__ import annotations

import json
from typing import Any, Optional


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_sample(sample: Any) -> tuple[bool, list[str]]:
    """Validate one parsed JSONL line against the DetectionTrainingSample
    contract. Returns (ok, errors)."""
    errs: list[str] = []
    if not isinstance(sample, dict):
        return False, ["sample is not an object"]
    # id
    if not isinstance(sample.get("id"), str) or not sample["id"]:
        errs.append("id: expected non-empty string")
    # imageRef
    if not isinstance(sample.get("imageRef"), str) or not sample["imageRef"]:
        errs.append("imageRef: expected non-empty string")
    # width / height
    if not _is_num(sample.get("width")):
        errs.append("width: expected number")
    if not _is_num(sample.get("height")):
        errs.append("height: expected number")
    # objects (defaults to [])
    objs = sample.get("objects", [])
    if not isinstance(objs, list):
        errs.append("objects: expected array")
    else:
        for i, o in enumerate(objs):
            if not isinstance(o, dict):
                errs.append(f"objects[{i}]: expected object")
                continue
            if not isinstance(o.get("label"), str) or not o["label"]:
                errs.append(f"objects[{i}].label: expected non-empty string")
            bbox = o.get("bbox")
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                errs.append(f"objects[{i}].bbox: expected 4-element array [x1,y1,x2,y2]")
            elif not all(_is_num(x) for x in bbox):
                errs.append(f"objects[{i}].bbox: expected numeric coords")
            elif not (0.0 <= min(bbox) and max(bbox) <= 1.0 + 1e-9):
                errs.append(f"objects[{i}].bbox: coords must be normalized 0..1")
    return (len(errs) == 0, errs)


def validate_manifest(path: str) -> tuple[list[dict], list[dict]]:
    """Validate a JSONL manifest; returns (valid_samples, invalid_samples).

    Each entry of the return lists is (line_no, sample_or_error). A non-JSON
    line is recorded as invalid with the parse error string.
    """
    valid: list[dict] = []
    invalid: list[dict] = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                sample = json.loads(line)
            except json.JSONDecodeError as e:
                invalid.append({"line": lineno, "error": f"JSON decode: {e}"})
                continue
            ok, errs = validate_sample(sample)
            if ok:
                valid.append({"line": lineno, "sample": sample})
            else:
                invalid.append({"line": lineno, "errors": errs})
    return valid, invalid


def validate_track_manifest(path: str) -> tuple[Optional[dict], list[str]]:
    """Validate the tracker eval manifest (`track_label_manifest.json`) shape
    loosely: top-level object with `sport` and `clips[].frames[].objects[].{id,bbox}`.
    Returns (manifest_or_None, errors)."""
    try:
        data = json.load(open(path, "r", encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return None, [str(e)]
    errs: list[str] = []
    if not isinstance(data, dict):
        errs.append("track manifest: expected top-level object")
        return data if isinstance(data, dict) else None, errs
    if "sport" not in data:
        errs.append("track manifest: missing 'sport'")
    clips = data.get("clips")
    if not isinstance(clips, list) or not clips:
        errs.append("track manifest: missing non-empty 'clips'")
    return data, errs

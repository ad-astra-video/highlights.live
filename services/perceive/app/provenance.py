"""Provenance helpers for the perceive detector (ADAAAA-7801).

A detection slice that records only the device label (``detector: "cuda:0"``)
does not say WHICH weights produced the boxes: "cuda:0" is a device, not a
model. On a CPU host there is then no way to check that a committed slice came
from the weights the deployment serves, which is the gap Highlights.live
Reviewer flagged on ADAAAA-7797 for the american-football slice.

This module answers that in a form that needs no GPU:

  - for a LOCAL model dir (the deployed per-stream merged Florence dir) it
    records a sha256 per weight file, so a CPU copy of the dir can be compared
    byte for byte against the slice;
  - for a HUB model id it records the id plus the resolved commit hash, which
    is immutable and re-resolvable on CPU from the local HF cache;
  - either way it records the raw ``FLORENCE_MODEL`` value observed at run time
    (unset and set are different facts, and only the string is safe to record).
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Iterable

# Weight files Florence-2 / the perceive image can serve. Kept deliberately
# explicit: hashing arbitrary files in a model dir would inflate the slice and
# scan a multi-GB tree, while these are the files whose bytes ARE the model.
WEIGHT_FILE_PATTERNS = (
    "*.safetensors",
    "pytorch_model*.bin",
    "*.onnx",
    "openvino_model*.xml",
)


def sha256_file(path: str | os.PathLike, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for blk in iter(lambda: fh.read(chunk), b""):
            h.update(blk)
    return h.hexdigest()


def _weight_files(source: str) -> Iterable[Path]:
    root = Path(source)
    seen: set[Path] = set()
    for pattern in WEIGHT_FILE_PATTERNS:
        for p in root.glob(pattern):
            if p.is_file() and p not in seen:
                seen.add(p)
                yield p


def weights_digest(source: str | None, digest: bool = True) -> list[dict]:
    """Per-weight-file sha256 for a local model dir; [] for a hub id.

    `digest=False` records the file list and sizes without hashing, which is the
    cheap mode for a producer that is already inside a GPU-minute envelope.
    """
    if not source or not os.path.isdir(source):
        return []
    out = []
    for p in sorted(_weight_files(source)):
        rec = {"file": p.name, "bytes": p.stat().st_size}
        if digest:
            rec["sha256"] = sha256_file(p)
        out.append(rec)
    return out


def detector_identity(detector, digest: bool = True) -> dict:
    """Identity record for the weights a `FlorenceDetector` serves.

    Reads the detector's resolved state instead of re-deriving it, so the slice
    records what was ACTUALLY loaded rather than what the caller meant to load.
    """
    model_path = getattr(detector, "model_path", None)
    model_name = getattr(detector, "model_name", None)
    source = model_path or model_name
    return {
        "modelName": model_name,
        "modelPath": model_path,
        "source": source,
        "sourceKind": "local_dir" if model_path else "hub_id",
        "envVar": "FLORENCE_MODEL",
        # Recorded verbatim: an unset env var and an explicit id are different
        # facts, and a slice that omits this cannot be re-derived from the code.
        "envValue": os.environ.get("FLORENCE_MODEL"),
        "deviceLabel": getattr(detector, "device_label", None),
        # Set by transformers only when the model came from the hub; it pins the
        # exact revision, so a CPU host can resolve the same weights.
        "hubCommit": getattr(getattr(getattr(detector, "_model", None), "config", None), "_commit_hash", None),
        "weights": weights_digest(source, digest=digest),
    }

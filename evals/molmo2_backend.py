#!/usr/bin/env python3
"""Molmo2-4B detector backend for the detection eval harness (ADAAAA-7283).

Implements the *same* `detect(sample) -> [{label, confidence, bbox}]` contract
as the `florence` backend in `evals/detect_precision.py`, so the existing
precision/recall accounting in `eval_detection` applies unchanged. Boxes are
closed-vocab `DetectionTrainingSample`-compatible (normalized [x1,y1,x2,y2]),
and the harness's `_canonical_detections` gate maps raw labels into the closed
vocabulary (unmappable -> `<junk>` FP) exactly as it does for Florence.

Backend arm (primary): open-vocab `find all <vocab>` prompt with Molmo2 box
output. Grounding-token (`<point>`/`extract_image_points`) variants are only
the subject of a separate cheap note, not this arm.

Requires `transformers >= 4.52` (Molmo-2 architecture) and `torch`. Loaded
lazily so the harness imports cleanly on boxes / runners without the ML stack.
The pure-text box parser (`parse_molmo_boxes`) is stdlib-only and is what the
no-GPU self-test exercises (see `test_detect_precision.py::test_molmo2_*`).
"""

from __future__ import annotations

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def parse_molmo_boxes(output_text, vocab):
    """Parse Molmo2 grounding box output into `[{label, confidence, bbox}]`.

    The parser accepts the common Molmo grounding text form for an open-vocab
    box task, one object per line:

        <label>: [x1, y1, x2, y2]
        <label>: x1 y1 x2 y2

    where the four coordinates are normalized 0..1 (Molmo emits normalized
    dot-boxes). It is tolerant of surrounding tokens (brackets, trailing
    text, extra digits after the four coordinates) but requires a leading
    label token, exactly four in-range coordinates on the line, and keeps the
    box in a canonical [min, min, max, max] order.

    Labels are returned raw (lower-cased, trimmed). The harness's
    `_canonical_detections` gate is responsible for mapping them into the
    closed vocabulary and treating unmappable labels as `<junk>` FPs, so the
    vocab-matching behaviour matches the florence arm exactly.

    Returns [] on empty / unparseable output (no crash), which the accounting
    treats as a frame with zero detections (recall 0 for present GT classes).
    """
    if not output_text:
        return []
    vocab_set = {str(v).strip().lower() for v in vocab}
    found = []
    for line in output_text.splitlines():
        line = line.strip()
        if not line:
            continue
        # Split the label from the coordinate payload on the first ':' — but a
        # label may itself be multi-word ("soccer ball"), and coords may be
        # separated by ':' only once.
        if ":" in line:
            label, _, body = line.partition(":")
        else:
            # no ':' separator: assume leading word(s) then coords
            m = re.match(r"^([A-Za-z][A-Za-z0-9 _\-]{0,40}?)\s+(\[?[\d., ]+\]?)$", line)
            if not m:
                continue
            label, body = m.group(1), m.group(2)
        label = label.strip().lower()
        # collect the first 4 numeric tokens in the body
        nums = []
        for tok in re.split(r"[^0-9eE.\-]+", body):
            tok = tok.strip()
            if not tok:
                continue
            try:
                nums.append(float(tok))
            except ValueError:
                pass
            if len(nums) == 4:
                break
        if len(nums) < 4:
            continue
        x1, y1, x2, y2 = nums[0], nums[1], nums[2], nums[3]
        # clamp / reject out-of-range (Molmo may emit >= 1 slightly; treat as
        # this-frame noise -> skip so it never becomes a giant invalid box)
        if any(v < 0.0 or v > 1.0 + 1e-6 for v in (x1, y1, x2, y2)):
            continue
        box = [min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)]
        if box[2] - box[0] <= 0.0 or box[3] - box[1] <= 0.0:
            continue
        found.append({"label": label, "confidence": 1.0, "bbox": box})
    return found


def resolve_image(image_ref):
    """Resolve an imageRef (absolute path, relative path, or bare filename)."""
    if os.path.exists(image_ref):
        return image_ref
    cand = os.path.join(HERE, "..", "data", "training", os.path.basename(image_ref))
    if os.path.exists(cand):
        return cand
    return image_ref


def build_prompt(vocab):
    """Open-vocab detection prompt for the Molmo2 box arm.

    The task keeps a single prompt per frame listing the closed vocab, matching
    the intended 'find all <vocab>' shape. (Florence can't take vocab in the
    prompt so it gates post-inference; Molmo2 is instructed directly and then
    gated by the same `_canonical_detections` closed-vocab gate.)
    """
    joined = ", ".join(str(v).strip() for v in vocab)
    return f"find all {joined}."


class Molmo2Detector:
    """Molmo2-4B detector via HF transformers (measurement arm).

    Same `detect(sample) -> [{label, confidence, bbox}]` contract as the
    `florence` backend. Lazily loads `allenai/Molmo2-4B` (or `--model`) on first
    `detect`, so the harness imports cleanly on runners without the ML stack.
    """

    def __init__(self, model, vocab, device="cuda", dtype="bfloat16"):
        self.model = model
        self.device = device
        self.vocab = list(vocab)
        self.dtype = dtype
        self._model = self._proc = None
        self._peak_vram_mb = 0

    def _load(self):
        if self._model is not None:
            return
        import torch
        from transformers import (
            AutoModelForCausalLM,
            AutoProcessor,
        )  # noqa: import at runtime

        dtype = getattr(torch, self.dtype, torch.bfloat16)
        model = AutoModelForCausalLM.from_pretrained(
            self.model,
            torch_dtype=dtype,
            trust_remote_code=True,
            device_map=self.device,
        )
        model.eval()
        proc = AutoProcessor.from_pretrained(self.model, trust_remote_code=True)
        self._model, self._proc = model, proc
        if self.device.startswith("cuda"):
            self._peak_vram_mb = torch.cuda.max_memory_allocated() / (1024 * 1024)

    def peak_vram_mb(self):
        return self._peak_vram_mb

    def detect(self, sample):
        """sample: DetectionTrainingSample dict with `imageRef` (+ width/height).

        Returns [{label, confidence, bbox:[x1,y1,x2,y2]}]. Labels are raw;
        `_canonical_detections` in the harness maps them into the closed vocab.
        """
        self._load()
        import numpy as np
        from PIL import Image

        img_path = resolve_image(sample["imageRef"])
        pil = Image.open(img_path).convert("RGB")
        arr = np.asarray(pil)

        prompt = build_prompt(self.vocab)
        import torch

        # Molmo-2 takes the text+image via its processor; the grounding box task
        # is driven by the open-vocab prompt and decoded below.
        try:
            inputs = self._proc(images=pil, text=prompt, return_tensors="pt")
        except TypeError:
            # older/newer processor signature: images-first positional
            inputs = self._proc(pil, prompt, return_tensors="pt")
        inputs = {k: (v.to(self.device) if hasattr(v, "to") else v)
                  for k, v in inputs.items()}
        with torch.no_grad():
            out = self._model.generate(**inputs, max_new_tokens=256)
        text = self._proc.decode(out[0], skip_special_tokens=True)
        return parse_molmo_boxes(text, self.vocab)

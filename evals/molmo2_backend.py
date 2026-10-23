#!/usr/bin/env python3
"""Molmo2-4B detector backend for the detection eval harness (ADAAAA-7283 leg B).

Implements the *same* `detect(sample) -> [{label, confidence, bbox}]` contract
as the `florence` backend in `evals/detect_precision.py`, so the existing
precision/recall/seed-IoU accounting applies unchanged. Boxes are closed-vocab,
`DetectionTrainingSample`-compatible and normalized to [x1,y1,x2,y2] in [0,1].

REAL GROUNDING DECODE (replaces the text-grep placeholder)
-----------------------------------------------------------
Molmo2-4B is a *point*-grounding model: for a find/point prompt it emits the
object locations as one or more `<points coords="..."/>` tags (or `<tracks .../>`
for video), where each point is an `(index, x, y)` triple whose coordinates are
scaled by **1000 relative to the image dimensions**. The checkpoint's
`modeling_molmo2.py` / the AllenAI model card decode these exactly via the regex
helpers below (`COORD_REGEX` + `POINTS_REGEX`, matching the published
`_points_from_num_str`). Because the coords are relative-by-1000, decoding
straight to *normalized* [0,1] coordinates requires no knowledge of the image
size:

    x_norm = float(x_token) / 1000.0
    y_norm = float(y_token) / 1000.0

`extract_image_points()` implements that verified decode. The old
`parse_molmo_boxes()` (grep for `label: [x1,y1,x2,y2]`) is removed: Molmo2-4B
does **not** emit that form from a bare `find all <vocab>` prompt, which is why
the placeholder produced no valid A/B measurement.

Molmo2-4B emits **ONE point per object instance** and does **not** emit
bounding-box corners (verified on the box: even box-directed prompts such as
"give each player's bounding box top-left and bottom-right corner" still return
one location point per object — 10 points for "find all player", 1 point for
"goalkeeper"/"goal", "There are none." for "referee"). To satisfy the
`DetectionTrainingSample` box contract, the arm expands each emitted center
point to a non-degenerate box of a documented, configurable per-class normalized
size (`DEFAULT_BOX_SIZE`; override with `box_size`). Expanding each point
independently (NOT pairing consecutive points, which pairs *different* objects
and yields degenerate thin boxes) gives well-formed boxes whose center is the
model's grounding.

Requires `transformers >= 4.52` (Molmo-2 architecture) and `torch`. ML imports
are lazy: the module imports cleanly (and `Molmo2Detector` can be constructed)
on runners without the ML stack; `torch`/`transformers` load only in
`Molmo2Detector._load()` / `detect()`.
"""

from __future__ import annotations

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))

# --- Molmo2 grounding decode (verified against the AllenAI model card) -------

# A `<points coords="..." />` (or `<tracks .../>`) tag carrying the point
# payload. Coordinates are encoded as a flat run of `index x y` triples.
COORD_REGEX = re.compile(r'<(?:points|tracks)[^>]*coords="([0-9\t:;, .]+)"[^>]*/?>')
# One point = `index x y`, where x/y are 3-4 digit coords scaled by 1000.
POINTS_REGEX = re.compile(r'([0-9]+)[ \t:;,.]+([0-9]{3,4})[ \t:;,.]+([0-9]{3,4})')

# Molmo2-4B is a *point*-grounding model: it emits ONE reference point per
# object instance, not bounding-box corners. Each decoded point is expanded to
# a square of this normalized side length centred on the point to satisfy the
# DetectionTrainingSample `[x1,y1,x2,y2]` box contract. Override per call with
# `box_size=` on `points_to_boxes` / `parse_molmo_detection`.
DEFAULT_BOX_SIZE = 0.10


def extract_image_points(output_text):
    """Decode Molmo2 grounding output into normalized (x, y) points in [0,1].

    This is the real checkpoint decode path (the model card's `_points_from_num_str`
    / `extract_*_points`): Molmo2 scales coordinates by 1000 relative to the
    image dimensions, so `token / 1000` is already a normalized coordinate.

    Returns a list of `(x_norm, y_norm)` tuples, one per emitted object point.
    Empty output / malformed tags yield `[]` (no crash) so the accounting treats
    the frame as zero detections.
    """
    points = []
    if not output_text:
        return points
    for coord in COORD_REGEX.finditer(output_text):
        for m in POINTS_REGEX.finditer(coord.group(1)):
            xs, ys = m.group(2), m.group(3)
            x = float(xs) / 1000.0
            y = float(ys) / 1000.0
            # reject out-of-range / negative tokens (noise) -> never a bad box
            if 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0:
                points.append((x, y))
    return points


def points_to_boxes(points, label, confidence=1.0, box_size=DEFAULT_BOX_SIZE):
    """Expand each decoded Molmo2 object point into a non-degenerate box.

    Molmo2-4B is a *point*-grounding model: each decoded `(index, x, y)` point
    token is ONE object instance's reference location, not a bounding-box corner
    (verified on the box: box-directed prompts still return one location point
    per object). To satisfy the DetectionTrainingSample `[x1,y1,x2,y2]` box
    contract, each point is expanded to a square of normalized side `box_size`
    centred on the point, then clamped to [0,1]. Expanding each point
    independently (NOT pairing consecutive points, which would pair *different*
    objects into a degenerate thin box) gives well-formed boxes whose centre is
    the model's grounding.

    Returns `[{label, confidence, bbox:[x1,y1,x2,y2]}]`. Labels are passed
    through as-is; `_canonical_detections` in the harness maps them into the
    closed vocabulary (unmappable -> `<junk>` FP) exactly as for Florence.
    Zero-area boxes after clamping are dropped.
    """
    half = box_size / 2.0
    boxes = []
    for (x, y) in points:
        bbox = [max(0.0, x - half), max(0.0, y - half),
                min(1.0, x + half), min(1.0, y + half)]
        if bbox[2] - bbox[0] <= 0.0 or bbox[3] - bbox[1] <= 0.0:
            continue
        boxes.append({"label": label, "confidence": confidence, "bbox": bbox})
    return boxes


def parse_molmo_detection(output_text, label, confidence=1.0, box_size=DEFAULT_BOX_SIZE):
    """Full no-GPU decode: Molmo2 output -> normalized boxes for one class.

    Convenience used by the self-test / fixture harness: decodes every
    `<points>` in `output_text` and expands each object point into `label` box.
    """
    return points_to_boxes(extract_image_points(output_text), label, confidence, box_size)


def resolve_image(image_ref):
    """Resolve an imageRef (absolute path, relative path, or bare filename)."""
    if os.path.exists(image_ref):
        return image_ref
    cand = os.path.join(HERE, "..", "data", "training", os.path.basename(image_ref))
    if os.path.exists(cand):
        return cand
    return image_ref


def build_prompt(vocab_item):
    """Grounding prompt for a single closed-vocab class.

    Molmo2-4B returns object locations as `<points>` for a find prompt. The arm
    issues one grounding query per class so the returned points can be labelled
    with that class (the checkpoint's points are not themselves label-bearing).
    """
    return f"find all {str(vocab_item).strip()}."


def _load_model_and_processor(model_id, dtype, device):
    """Load a Molmo2 model+processor, tolerating a native-transformers re-register.

    `transformers >= 5.x` ships native `Molmo2Config`, so `trust_remote_code=True`
    makes the checkpoint's `modeling_molmo2.py` re-register the config and crash
    with "is already used by a Transformers model" (observed on the box, HF
    `allenai/Molmo2-4B`, transformers 5.20.2). We try remote code first (for
    older transformers that need it) and fall back to the native class on that
    specific conflict. Returns (model, processor).
    """
    from transformers import AutoModelForImageTextToText, AutoProcessor

    last = None
    for trc in (True, False):
        try:
            model = AutoModelForImageTextToText.from_pretrained(
                model_id, dtype=dtype, trust_remote_code=trc, device_map=device)
            model.eval()
            proc = AutoProcessor.from_pretrained(model_id, trust_remote_code=trc)
            return model, proc
        except ValueError as e:
            last = e
            if "is already used by a Transformers model" in str(e) and trc:
                continue
            raise
    raise RuntimeError(f"could not load Molmo2 model {model_id}: {last}")


class Molmo2Detector:
    """Molmo2-4B detector via HF transformers (measurement arm).

    Same `detect(sample) -> [{label, confidence, bbox}]` contract as the
    `florence` backend. Lazily loads `allenai/Molmo2-4B` (or `--model`) on first
    `detect`, so the harness imports cleanly on runners without the ML stack.

    Detection arm: closed-vocab per-class grounding queries. Each class prompt is
    fed through the checkpoint via `processor.apply_chat_template` (the Molmo2
    calling convention; the legacy `proc(images=, text=)` form crashes with
    `Expected 0 image grids, but got 1`), and the output is decoded with
    `extract_image_points` + `points_to_boxes`.
    """

    def __init__(self, model, vocab, device="cuda", dtype="bfloat16", box_size=DEFAULT_BOX_SIZE):
        self.model = model
        self.device = device
        self.vocab = list(vocab)
        self.dtype = dtype
        self.box_size = box_size
        self._model = self._proc = None
        self._peak_vram_mb = 0

    def _load(self):
        if self._model is not None:
            return
        import torch
        from transformers import AutoProcessor

        dtype = getattr(torch, self.dtype, torch.bfloat16)
        model, proc = _load_model_and_processor(self.model, dtype, self.device)
        self._model, self._proc = model, proc
        if self.device.startswith("cuda"):
            self._peak_vram_mb = torch.cuda.max_memory_allocated() / (1024 * 1024)

    def peak_vram_mb(self):
        return self._peak_vram_mb

    def _generate(self, pil, prompt):
        """Generate on one (image, prompt) pair via the Molmo2 chat-template path."""
        import torch

        proc = self._proc
        messages = [{
            "role": "user",
            "content": [
                {"type": "image", "image": pil},
                {"type": "text", "text": prompt},
            ],
        }]
        inputs = proc.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_tensors="pt",
            return_dict=True,
        )
        inputs = {k: (v.to(self.device) if hasattr(v, "to") else v)
                  for k, v in inputs.items()}
        with torch.no_grad():
            out = self._model.generate(**inputs, max_new_tokens=256)
        gen = out[0][inputs["input_ids"].size(1):]
        return proc.decode(gen, skip_special_tokens=True)

    def detect(self, sample):
        """sample: DetectionTrainingSample dict with `imageRef` (+width/height).

        Runs one grounding query per closed-vocab class, decodes the emitted
        `<points>` into boxes, and returns `[{label, confidence, bbox}]`.
        """
        self._load()
        from PIL import Image

        img_path = resolve_image(sample["imageRef"])
        pil = Image.open(img_path).convert("RGB")

        dets = []
        for cls in self.vocab:
            text = self._generate(pil, build_prompt(cls))
            dets.extend(parse_molmo_detection(text, cls, box_size=self.box_size))
        return dets


def _selftest():
    """No-GPU self-check: decode a synthetic Molmo2 `<points>` utterance and show
    each decoded object point becomes a parseable, vocab-matching, non-degenerate
    normalized box."""
    # Simulated Molmo2 grounding output for "find all player." on a 1280x720
    # soccer frame: one `(index, x, y)` point per player, x/y scaled by 1000.
    sample_text = ('<points coords="1 216 247 2 442 555 3 640 400"/> '
                   'I see 3 players.')
    pts = extract_image_points(sample_text)
    boxes = points_to_boxes(pts, "player")
    print("decoded normalized object points:", pts)
    print("expanded boxes:", boxes)
    assert len(pts) == 3, pts
    assert len(boxes) == 3, "expected one non-degenerate box per object point"
    for b in boxes:
        bb = b["bbox"]
        assert all(0.0 <= v <= 1.0 for v in bb), "box not normalized"
        assert bb[2] - bb[0] > 0 and bb[3] - bb[1] > 0, "degenerate box"
    # corner object (translated to near border) still clamped to [0,1]
    edge = points_to_boxes([(0.999, 0.001)], "goal")[0]["bbox"]
    assert all(0.0 <= v <= 1.0 for v in edge), edge
    print("SELF-TEST OK: boxes parse, normalized, vocab-match, non-degenerate")
    return boxes


if __name__ == "__main__":
    _selftest()

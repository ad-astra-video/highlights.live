# Real Florence-2 object identification for the perceive live-runner.
#
# Loaded lazily (only when PERCEIVE_MODE=florence). Device selection:
#   PERCEIVE_DEVICE=auto   -> DirectML (Intel Arc iGPU) if available, else CUDA, else CPU
#   PERCEIVE_DEVICE=cpu    -> force CPU
#   PERCEIVE_DEVICE=directml / cuda -> force a specific accelerator
#
# Runs the "<OD>" (open-domain detection) task: returns object labels + bboxes,
# which feed the same tracker/candidate pipeline as the stub blobs.
from __future__ import annotations

import os
import re
from typing import Optional

import numpy as np


class FlorenceDetector:
    """Thin wrapper over microsoft/Florence-2 (HF transformers) for <OD>."""

    def __init__(self, model_name: str | None = None, device: str | None = None):
        self.model_name = model_name or os.environ.get("FLORENCE_MODEL", "microsoft/Florence-2-base")
        self._device = device or os.environ.get("PERCEIVE_DEVICE", "auto")
        self._torch = None
        self._tdml = None
        self._processor = None
        self._model = None
        self.device_label = "not-loaded"

    # --- device resolution --------------------------------------------------
    def _pick_device(self):
        if self._device in ("cpu", "CPU"):
            return "cpu"
        # CUDA (NVIDIA)
        try:
            import torch as _t

            if self._device == "cuda" or (self._device == "auto" and _t.cuda.is_available()):
                return "cuda"
        except Exception:
            pass
        # DirectML (Intel Arc iGPU on Windows)
        try:
            import torch_directml as _d  # noqa: F401

            if self._device in ("directml", "auto"):
                return "directml"
        except Exception:
            pass
        return "cpu"

    # --- lazy load -----------------------------------------------------------
    def load(self):
        if self._model is not None:
            return
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor

        self._torch = torch
        chosen = self._pick_device()
        if chosen == "directml":
            import torch_directml

            self._tdml = torch_directml
            device = torch_directml.device()
            self.device_label = f"directml:{torch_directml.device_count()}"
        elif chosen == "cuda":
            device = torch.device("cuda")
            self.device_label = f"cuda:{torch.cuda.current_device()}"
        else:
            device = torch.device("cpu")
            self.device_label = "cpu"

        self._processor = AutoProcessor.from_pretrained(self.model_name, trust_remote_code=True)
        self._model = AutoModelForCausalLM.from_pretrained(
            self.model_name, trust_remote_code=True
        ).to(device)
        self._model.eval()
        self.dtype = next(self._model.parameters()).dtype

    # --- inference ------------------------------------------------------------
    def detect(self, image: "np.ndarray", task: str = "<OD>") -> list[dict]:
        """image: HxWx3 RGB uint8. Returns [{label, confidence, bbox:[x1,y1,x2,y2] normalized}]."""
        self.load()
        from PIL import Image

        if image.ndim == 2:
            image = np.stack([image] * 3, axis=-1)
        pil = Image.fromarray(image.astype(np.uint8)).convert("RGB")
        inputs = self._processor(images=pil, text=task, return_tensors="pt")
        target = self._tdml.device() if self._tdml is not None else next(self._model.parameters()).device
        inputs = {k: v.to(target) for k, v in inputs.items()}

        with self._torch.no_grad():
            generated = self._model.generate(
                **inputs, num_beams=3, max_new_tokens=1024, do_sample=False
            )
        text = self._processor.batch_decode(generated, skip_special_tokens=False)[0]
        return self._parse(text)

    @staticmethod
    def _parse(text: str) -> list[dict]:
        """Parse Florence-2 OD output: `label<loc_453><loc_366><loc_820><loc_753>`
        repeated per object (and optionally wrapped in <p>…</p>). loc_N is a
        0-999 coordinate; we normalize by 1000 into 0..1."""
        res: list[dict] = []
        pattern = re.compile(
            r"(?:<p>)?([^<]+?)(?:</p>)?"
            r"<loc_(\d+)><loc_(\d+)><loc_(\d+)><loc_(\d+)>"
        )
        for m in list(pattern.finditer(text))[:16]:
            label, a, b, c, d = m.groups()
            # Special tokens decode as `s>` / `<s>` / `</s>` prefixes; drop
            # everything up to the last `>` (or `<`) before the real label.
            label = re.split(r"[<>]", label)[-1].strip()
            res.append(
                {
                    "label": label or "object",
                    "confidence": 1.0,
                    "bbox": [int(a) / 1000, int(b) / 1000, int(c) / 1000, int(d) / 1000],
                }
            )
        return res


_detector: Optional[FlorenceDetector] = None


def get_detector() -> FlorenceDetector | None:
    """Return the shared Florence-2 detector when enabled, else None (stub path)."""
    global _detector
    if os.environ.get("PERCEIVE_MODE", "stub") != "florence":
        return None
    if _detector is None:
        _detector = FlorenceDetector()
    return _detector


def detector_label() -> str:
    if os.environ.get("PERCEIVE_MODE", "stub") != "florence":
        return "stub-iou"
    d = get_detector()
    d.load()
    return f"florence-2@{d.device_label}"

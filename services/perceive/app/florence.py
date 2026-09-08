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
from pathlib import Path
from typing import Optional

import numpy as np

# OpenVINO targets Intel suites (iGPU + PCIe Arc dGPU + NPU + CPU) behind one
# backend; used in-container via the GPU plugin (/dev/dri) and on Windows hosts.
# Explicit device via PERCEIVE_OV_DEVICE: GPU | CPU | NPU | AUTO


def _materialize_original_model(model_id: str, dest: Path) -> Path:
    """Copy the HF Florence-2 snapshot from the local hub cache into `dest` and
    patch the remote modeling file to strip flash-attn imports. The Intel
    OpenVINO converter otherwise re-downloads via the network and the patched
    modeling file is required (flash_attn is not installed)."""
    import shutil

    hub = Path.home() / ".cache" / "huggingface" / "hub"
    src = None
    snap = hub / ("models--" + model_id.replace("/", "--")) / "snapshots"
    if snap.is_dir():
        for d in sorted(snap.iterdir()):
            src = d
            break
    if src is None or not (src / "model.safetensors").exists():
        raise RuntimeError(f"HF model {model_id} not in local cache ({hub}); cannot convert offline")
    dest.mkdir(parents=True, exist_ok=True)
    for f in src.iterdir():
        if f.is_file():
            shutil.copy2(f, dest / f.name)
    modeling = dest / "modeling_florence2.py"
    orig_modeling = dest / "orig_modeling_florence2.py"
    if modeling.exists() and not orig_modeling.exists():
        modeling.rename(orig_modeling)
    content = orig_modeling.read_text(encoding="utf-8")
    for needle in (
        "if is_flash_attn_2_available():",
        "    from flash_attn.bert_padding import index_first_axis, pad_input, unpad_input",
        "    from flash_attn import flash_attn_func, flash_attn_varlen_func",
    ):
        content = content.replace(needle, "")
    modeling.write_text(content, encoding="utf-8")
    return dest


class FlorenceDetector:
    """Thin wrapper over microsoft/Florence-2 (HF transformers) for <OD>."""

    def __init__(self, model_name: str | None = None, device: str | None = None):
        self.model_name = model_name or os.environ.get("FLORENCE_MODEL", "microsoft/Florence-2-base")
        self._device = device or os.environ.get("PERCEIVE_DEVICE", "auto")
        self._torch = None
        self._tdml = None
        self._ov_model = None
        self._ov_device = None
        self._processor = None
        self._model = None
        self.dtype = None
        self.device_label = "not-loaded"

    # --- device resolution --------------------------------------------------
    def _pick_device(self):
        if self._device in ("cpu", "CPU"):
            return "cpu"
        # OpenVINO (Intel iGPU / PCIe Arc dGPU / NPU / CPU)
        if self._device in ("openvino", "ov"):
            return "openvino"
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
        if chosen == "openvino":
            # Intel's parts-based OpenVINO port (DaViT image encoder + BART text
            # encoder/decoder converted separately with stateful KV cache). The
            # first boot converts HF Florence-2 -> OpenVINO IR into a cache dir;
            # later boots reuse the cached IR. Vendor at services/perceive/app/
            # ov_florence2_helper.py (Intel OpenVINO notebook, Apache/BSD-2).
            from . import ov_florence2_helper as ovh

            ov_device = os.environ.get("PERCEIVE_OV_DEVICE", "GPU")
            cache = os.environ.get("PERCEIVE_OV_CACHE") or str(
                Path.home() / ".cache" / "highlights-live" / "ov" / self.model_name.replace("/", "--")
            )
            Path(cache).mkdir(parents=True, exist_ok=True)
            if not os.path.exists(os.path.join(cache, "decoder_with_past.xml")):
                orig = Path(cache) / "chkpt"
                if not orig.exists():
                    _materialize_original_model(self.model_name, orig)
                ovh.convert_florence2(self.model_name, cache, orig_model_dir=orig)
            self._ov_model = ovh.OVFlorence2Model(cache, device=ov_device)
            self._ov_device = ov_device
            self.device_label = f"openvino:{ov_device}"
            self._processor = AutoProcessor.from_pretrained(self.model_name, trust_remote_code=True)
            return
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

        if self._ov_model is not None:
            # OpenVINO runner manages its own devices; it needs the raw token ids
            # plus pixels to merge image + task-prompt embeddings internally.
            generated = self._ov_model.generate(
                input_ids=inputs["input_ids"],
                pixel_values=inputs["pixel_values"],
                num_beams=3,
                max_new_tokens=1024,
                do_sample=False,
            )
        else:
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


def _gate_frame() -> "np.ndarray":
    """A representative real frame for the fps gate. A uniform gray frame makes
    Florence-2 ramble (many output tokens), inflating measured latency, so we
    benchmark on a real object image shipped with the package instead. Falls
    back to a neutral frame if the asset is missing."""
    import os as _os
    from PIL import Image
    here = _os.path.dirname(_os.path.abspath(__file__))
    path = _os.path.join(here, "_gate_frame.jpg")
    if _os.path.exists(path):
        return np.asarray(Image.open(path).convert("RGB"))
    return np.full((384, 384, 3), 128, np.uint8)


def gate_1fps(min_fps: float = 1.0, samples: int = 3, warm: int = 1) -> tuple[bool, float, str]:
    """Load the configured Florence-2 device and verify it sustains `min_fps`
    on a representative frame. Returns (ok, measured_fps, detail). Run at
    container boot so the worker refuses to register when its device can't keep
    up (PERCEIVE_MIN_FPS). Stub mode always passes (nothing to gate)."""
    import time

    d = get_detector()
    if d is None:
        return True, float("inf"), "stub mode — no gate"
    d.load()
    frame = _gate_frame()
    for _ in range(max(1, warm)):
        d.detect(frame)
    t0 = time.time()
    count = max(1, samples)
    for _ in range(count):
        d.detect(frame)
    elapsed = time.time() - t0
    fps = count / elapsed if elapsed > 0 else float("inf")
    ok = fps >= min_fps
    return ok, fps, f"{d.device_label} ~{fps:.2f} fps (need >= {min_fps:.2f})"

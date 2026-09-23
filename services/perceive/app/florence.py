# Real Florence-2 object identification for the perceive live-runner.
#
# Loaded lazily (only when PERCEIVE_MODE=florence). Device selection:
#   PERCEIVE_DEVICE=auto   -> DirectML (Intel Arc iGPU) if available, else CUDA, else CPU
#   PERCEIVE_DEVICE=cpu    -> force CPU
#   PERCEIVE_DEVICE=directml / cuda -> force a specific accelerator
#
# Runs the "<OD>" (open-domain detection) task: returns object labels + bboxes,
# which feed the same tracker/candidate pipeline as the stub blobs. When the
# session supplies a closed vocabulary (preferLabels / gameHint, ADAAAA-3726)
# the <OD> prompt is scoped to those labels and weak/unlabeled detections are
# gated out instead of being emitted with a fake confidence 1.0.
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Optional

import numpy as np

# OpenVINO targets Intel suites (iGPU + PCIe Arc dGPU + NPU + CPU) behind one
# backend; used in-container via the GPU plugin (/dev/dri) and on Windows hosts.
# Explicit device via PERCEIVE_OV_DEVICE: GPU | CPU | NPU | AUTO

# Labels that are never useful detections (e.g. the old `label or "object"`
# fallback): a box that parses to one of these is unlabelable and must be GATED
# (dropped) rather than emitted with a fake 1.0 confidence.
_JUNK_LABELS = {
    "object",
    "unknown",
    "item",
    "thing",
}

# Closed detection vocabulary by game hint. Florence-2's open-set <OD> labels are
# unreliable on untrained game/UI content (proven live: minimap -> "mobile phone",
# timer -> "digital clock"), so when a session's gameHint is a known title we scope
# the <OD> prompt to a tight label set. `preferLabels` from the session always wins
# over this map when it is non-empty (it is the operator's explicit closed set).
_GAME_VOCABULARIES: dict[str, list[str]] = {
    "soccer": ["soccer ball", "player", "goalkeeper", "goal", "referee"],
    "football": ["soccer ball", "player", "goalkeeper", "goal", "referee"],
    "fa cup": ["soccer ball", "player", "goalkeeper", "goal", "referee"],
    "soccer ball": ["soccer ball", "player", "goalkeeper", "goal", "referee"],
    "basketball": ["basketball", "player", "hoop", "referee"],
    "tennis": ["tennis ball", "player", "racket", "net"],
    "valorant": ["player", "agent", "weapon", "head"],
}

# Game hints that are synonyms/competitions for the same sport -> canonical key
# (substring match, so "Premier League" and "FA Cup final" both hit soccer).
_GAME_HINT_ALIASES: dict[str, str] = {
    "premier league": "soccer",
    "champions league": "soccer",
    "la liga": "soccer",
    "bundesliga": "soccer",
    "world cup": "soccer",
    "fa cup": "soccer",
    "euro": "soccer",
    "nba": "basketball",
}


def resolve_vocabulary(
    game_hint: Optional[str] = None,
    prefer_labels: Optional[list[str]] = None,
) -> Optional[list[str]]:
    """Resolve the CLOSED detection vocabulary for a perceive session.

    Priority:
      1. `prefer_labels` — the operator's explicit closed label set (won).
      2. a known `game_hint` -> its canned vocabulary (e.g. soccer).
      3. None — fall back to open-domain `<OD>` (legacy best-effort labelling).

    Only returns a vocabulary when one is actually known; an empty/unknown hint
    returns None so detect() keeps the open-set prompt and never breaks callers.
    """
    if prefer_labels:
        cleaned = [str(l).strip() for l in prefer_labels if str(l).strip()]
        if cleaned:
            return cleaned
    hint = (game_hint or "").strip().lower()
    for alias, canonical in _GAME_HINT_ALIASES.items():
        if alias in hint:
            hint = canonical
            break
    if hint in _GAME_VOCABULARIES:
        return _GAME_VOCABULARIES[hint]
    return None


def build_od_prompt(task: str = "<OD>", vocabulary: Optional[list[str]] = None) -> str:
    """Build the Florence-2 <OD> prompt. A non-empty `vocabulary` scopes detection
    to those closed labels (`<OD>soccer ball, player, ...`); otherwise the prompt
    stays open-domain `<OD>`."""
    if vocabulary:
        return f"{task}{', '.join(str(v) for v in vocabulary)}"
    return task


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
        # Per-frame gating metrics (ADAAAA-3726): how many boxes Florence emitted,
        # how many were gated as weak/unlabeled, and the resulting Unknown rate.
        self.stats: Optional[dict] = None

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
    def detect(
        self,
        image: "np.ndarray",
        task: str = "<OD>",
        vocabulary: Optional[list[str]] = None,
    ) -> list[dict]:
        """image: HxWx3 RGB uint8. Returns [{label, confidence, bbox:[x1,y1,x2,y2] normalized}].

        `vocabulary` is an optional CLOSED label set (e.g. from the session's
        preferLabels / gameHint). When given, the <OD> prompt is scoped to those
        labels (`<OD>soccer ball, player, ...`) and any detection that cannot be
        labeled within the vocabulary is gated out (dropped) instead of being
        emitted with a fake confidence 1.0 — Florence-2's open-set labels are
        unreliable on untrained game/UI content. With no vocabulary the prompt
        stays open-domain `<OD>` and labelling is best-effort (legacy behaviour).
        """
        self.load()
        from PIL import Image

        if image.ndim == 2:
            image = np.stack([image] * 3, axis=-1)
        pil = Image.fromarray(image.astype(np.uint8)).convert("RGB")
        # Closed-set OD: append the vocabulary to the <OD> task token. Florence-2
        # then only emits boxes for the requested labels, which both improves
        # label usefulness and shrinks max_new_tokens to ~4*N boxes (lower latency).
        prompt = build_od_prompt(task, vocabulary)
        inputs = self._processor(images=pil, text=prompt, return_tensors="pt")

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
        objs, stats = self._parse_with_stats(text, vocabulary=vocabulary)
        self.stats = stats
        return objs

    @staticmethod
    def _parse(text: str, vocabulary: Optional[list[str]] = None) -> list[dict]:
        """See _parse_with_stats; returns just the emitted objects (back-compat)."""
        objs, _ = FlorenceDetector._parse_with_stats(text, vocabulary)
        return objs

    @staticmethod
    def _parse_with_stats(
        text: str, vocabulary: Optional[list[str]] = None
    ) -> tuple[list[dict], dict]:
        """Parse Florence-2 OD output: `label<loc_453><loc_366><loc_820><loc_753>`
        repeated per object (and optionally wrapped in <p>…</p>). loc_N is a
        0-999 coordinate; we normalize by 1000 into 0..1. Returns
        (objects, stats) where stats = {parsed, emitted, gated, unknownRate}.

        Gating: detections that cannot be usefully labeled are DROPPED rather
        than emitted with a fake confidence 1.0 (the old `label or "object"`
        fallback produced meaningless 1.0-confidence boxes). With a CLOSED
        `vocabulary`, only labels within the set are kept; everything else is
        gated out so emitted bboxes always carry a useful, in-scope label.
        """
        ok_labels = None
        if vocabulary:
            ok_labels = {str(v).strip().lower() for v in vocabulary if str(v).strip()}
        res: list[dict] = []
        parsed = 0
        gated = 0
        pattern = re.compile(
            r"(?:<p>)?([^<]+?)(?:</p>)?"
            r"<loc_(\d+)><loc_(\d+)><loc_(\d+)><loc_(\d+)>"
        )
        for m in list(pattern.finditer(text))[:16]:
            parsed += 1
            label, a, b, c, d = m.groups()
            # Special tokens decode as `s>` / `<s>` / `</s>` prefixes; drop
            # everything up to the last `>` (or `<`) before the real label.
            label = re.split(r"[<>]", label)[-1].strip()
            # Gate 1 — unlabelable/junk tokens: emit nothing (prevents the
            # old fake `"object"`/1.0 boxes the tracker would have trusted).
            norm = label.strip().lower()
            if not norm or norm in _JUNK_LABELS:
                gated += 1
                continue
            # Gate 2 — closed vocabulary: keep only labelable in-scope detections.
            if ok_labels is not None:
                if norm not in ok_labels:
                    gated += 1
                    continue
                # Return the canonical (case-preserved) vocabulary label so the
                # downstream tracker/UI sees a stable, useful label string.
                label = next(v for v in (vocabulary or []) if str(v).strip().lower() == norm)
            res.append(
                {
                    "label": label,
                    "confidence": 1.0,
                    "bbox": [int(a) / 1000, int(b) / 1000, int(c) / 1000, int(d) / 1000],
                }
            )
        stats = {
            "parsed": parsed,
            "emitted": len(res),
            "gated": gated,
            "unknownRate": round(gated / parsed, 3) if parsed else 0.0,
        }
        return res, stats


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

    global _gate_fps
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
    _gate_fps = fps
    return ok, fps, f"{d.device_label} ~{fps:.2f} fps (need >= {min_fps:.2f})"


# --- runtime-measured sampling capability --------------------------------
_measured_fps: float | None = None
_gate_fps: float | None = None


def device_is_cpu() -> bool:
    """True when the runner is CPU-bound (PERCEIVE_DEVICE=cpu/CPU). CPU cannot
    sustain live-stream rates or dense-tracking cadence, so the runner is
    VOD-only and capped at 1 fps there."""
    return os.environ.get("PERCEIVE_DEVICE", "auto") in ("cpu", "CPU")


def record_analyze(elapsed: float) -> None:
    """Feed a real per-frame wall time so the tuned sample interval tracks the
    device's steady-state capability (EMA of instantaneous fps)."""
    global _measured_fps
    if not elapsed or elapsed <= 0:
        return
    inst = 1.0 / elapsed
    _measured_fps = inst if _measured_fps is None else 0.7 * _measured_fps + 0.3 * inst


def capability() -> dict:
    """Tuned framing for the ingest side: emit one frame every
    `sample_interval_s` seconds so the card isn't over- or under-fed. Drawn from
    the measured fps (boot gate + running average); stub mode is 1 fps."""
    if os.environ.get("PERCEIVE_MODE", "stub") != "florence":
        return {"max_fps": 1.0, "sample_interval_s": 1.0, "device": "stub-iou", "live": True, "mode": "live+vod"}
    fps = _measured_fps or _gate_fps
    if fps is None:
        return {"max_fps": 1.0, "sample_interval_s": 1.0, "device": "florence-2(not yet measured)", "live": not device_is_cpu(), "mode": "vod-only" if device_is_cpu() else "live+vod"}
    # On CPU the runner only accepts VOD-style per-frame work and never exceeds
    # 1 fps — it cannot sustain live-stream or dense-tracking rates.
    live_ok = not device_is_cpu()
    if not live_ok:
        fps = min(fps, 1.0)  # hard ceiling: 1 fps on CPU
    interval = round(min(5.0, max(1.0 if not live_ok else 0.2, 1.0 / fps)), 3)
    return {
        "max_fps": round(fps, 3),
        "sample_interval_s": interval,
        "device": "florence-2",
        "live": live_ok,
        "mode": "live+vod" if live_ok else "vod-only",
    }

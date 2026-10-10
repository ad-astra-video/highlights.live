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
# the emitted detections are scoped to those labels and weak/unlabeled
# detections are gated out instead of being emitted with a fake confidence 1.0.
#
# NOTE on prompt construction: Florence-2's "<OD>" task token accepts NO input
# channel — its processor asserts the prompt text equals the bare "<OD>" token
# (verified on transformers 4.46.3 and 4.49.0), so it is impossible to embed a
# closed vocabulary inside the <OD> prompt ("<OD>ball, player" raises
# AssertionError). The sibling "<OPEN_VOCABULARY_DETECTION>" task does accept a
# vocabulary string but is unreliable on Florence-2-base (drops to zero boxes on
# real sports frames). We therefore keep the open-domain "<OD>" prompt and apply
# the closed vocabulary as a post-inference gate: open-set labels are
# canonicalized to the nearest in-vocabulary label (person->player, ball->soccer
# ball) and anything that cannot be mapped to the vocabulary is dropped. This
# yields useful, in-roster bbox labels and a bounded Unknown rate on real clips.
from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Optional

import numpy as np

log = logging.getLogger("highlights.perceive.florence")

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

# --- discovery-pass tasks (increment C — ADAAAA-6464) ------------------------
# The caption/region Florence-2 tasks the planner may run at PLAN / RE-PLAN
# cadence (never per-frame) to discover track candidates on a representative
# frame. Each maps to a plan `discovery.method`.
DISCOVERY_TASKS: tuple[str, ...] = (
    "<DETAILED_CAPTION>",
    "<MORE_DETAILED_CAPTION>",
    "<DENSE_REGION_CAPTION>",
    "<REGION_PROPOSAL>",
)
# Which discovery `method` a task implies (plan §4.1 discovery.method).
_DISCOVERY_METHOD_BY_TASK: dict[str, str] = {
    "<DETAILED_CAPTION>": "caption",
    "<MORE_DETAILED_CAPTION>": "caption",
    "<DENSE_REGION_CAPTION>": "region",
    "<REGION_PROPOSAL>": "region",
}
# Tasks that yield per-region boxes (caption text trailing the <loc_…> tokens);
# the rest are whole-frame caption tasks (no boxes).
_DISCOVERY_REGION_TASKS: tuple[str, ...] = (
    "<DENSE_REGION_CAPTION>",
    "<REGION_PROPOSAL>",
)


def discovery_task(task: str | None) -> str | None:
    """Validate/normalize a discovery task token; None if not a discovery task."""
    if not task:
        return None
    t = str(task).strip()
    return t if t in DISCOVERY_TASKS else None


def discovery_method_for_task(task: str | None) -> str | None:
    """The plan `discovery.method` implied by a discovery task (caption/region)."""
    t = discovery_task(task)
    if t is None:
        return None
    return _DISCOVERY_METHOD_BY_TASK.get(t, "mixed")


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
    "serie a": "soccer",
    "ligue 1": "soccer",
    "eredivisie": "soccer",
    "primeira liga": "soccer",
    "liga mx": "soccer",
    "major league soccer": "soccer",
    "mls": "soccer",
    "soccer match": "soccer",
    "football match": "soccer",
    "uefa": "soccer",
    "nba": "basketball",
}

# Open-set <OD> labels rarely match the closed vocabulary verbatim (Florence-2
# says "person" where we mean "player", "ball" where we mean "soccer ball").
# `canonicalize_open_label` maps a raw label to the nearest in-vocabulary label
# so a real detection survives the gate with a useful, in-roster label instead of
# being counted as Unknown. Order matters: scan the vocabulary for a matching
# canonical target first, then alias the label, then fall back to a sub-word /
# containment match. A raw label that matches none of these is out-of-scope and
# gated.
_LABEL_ALIASES: dict[str, str] = {
    "ball": "soccer ball",
    "football": "soccer ball",
    "sports ball": "soccer ball",
    "person": "player",
    "man": "player",
    "people": "player",
    "men": "player",
    "woman": "player",
    # Florence-2 fragments a player into its uniform parts on real soccer
    # frames (ADAAAA-6340 measured from live <OD> runs: 'short pants'/'sock'
    # fired on ~40% of frames and were voided by the closed-vocab gate as
    # out-of-roster). These ARE genuine player detections split by the detector,
    # so map them back to the in-roster 'player' instead of voiding them.
    "soccer player": "player",
    "footballer": "player",
    "athlete": "player",
    "short pants": "player",
    "shorts": "player",
    "sock": "player",
    "socks": "player",
    "shirt": "player",
    "jersey": "player",
    "uniform": "player",
    "kit": "player",
    "cleats": "player",
    "goalpost": "goal",
    "crossbar": "goal",
    "goal": "goal",
    "goalie": "goalkeeper",
    "net": "goal",
}

# Sub-word tokens that, when the RAW label contains one of these, resolve to the
# matching vocabulary label. e.g. "basketball hoop"/"hoop" -> "hoop" for
# basketball; "tennis player" -> "player". Keyed by a token (lowercase) present
# in the raw label -> canonical vocabulary label.
_LABEL_SUBTOKENS: dict[str, str] = {
    "racket": "racket",
    "hoop": "hoop",
    "net": "net",
    "goal": "goal",
    "referee": "referee",
}


def canonical_sport(game_hint: Optional[str] = None) -> Optional[str]:
    """Resolve a raw game hint to its canonical sport key (or None if unknown).

    e.g. "Premier League" / "FA Cup" -> "soccer". Mirrors the alias resolution
    used by `resolve_vocabulary` so sport-specific candidate classification and
    closed-vocabulary detection stay consistent.
    """
    hint = (game_hint or "").strip().lower()
    for alias, canonical in _GAME_HINT_ALIASES.items():
        if alias in hint:
            hint = canonical
            break
    if hint in _GAME_VOCABULARIES:
        return hint
    return None


# Goal-scoring sports whose fast-strike tracker candidate (a generic KILL/MOVE
# motion primitive) must be classified as a GOAL so the decide model judges and
# auto-cuts it as a highlight. The tracker is sport-agnostic (KILL = explosive
# single-step >= FAST_STEP, MOVE = large accumulated move); on a soccer paid
# path those labels conflict with the scene (the decide model hard-rejects
# "this is soccer, not a KILL event"), so the candidate is re-labelled here.
_GOAL_EVENT_SPORTS = {"soccer"}


def sport_specific_event_type(game_hint: Optional[str] = None, generic_type: str = "MOVE") -> str:
    """Map the tracker's generic candidate event type onto the active sport.

    A goal-scoring sport (soccer) classifies a fast-strike KILL/MOVE candidate
    as a GOAL; every other sport keeps the raw generic type.
    """
    if canonical_sport(game_hint) in _GOAL_EVENT_SPORTS:
        return "GOAL"
    return generic_type


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
    """Build the Florence-2 <OD> prompt.

    NOTE (ADAAAA-3726): Florence-2's <OD> task token takes NO input channel, so a
    vocabulary can never be embedded here ("<OD>ball, player" raises AssertionError
    in the processor). The closed vocabulary is applied as a post-inference gate in
    `_parse_with_stats` (canonicalization + drop). This function keeps the prompt
    to the bare task token; the `vocabulary` argument is accepted only for
    backward-compat and is intentionally ignored.
    """
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

    def __init__(
        self,
        model_name: str | None = None,
        device: str | None = None,
        model_path: str | None = None,
    ):
        self.model_name = model_name or os.environ.get("FLORENCE_MODEL", "microsoft/Florence-2-base")
        # Per-stream LoRA injection (ADAAAA-5324): when set, this detector loads
        # the given model DIRECTORY instead of the shared base model. The adapter
        # is a pre-merged drop-in Florence-2 model dir (train's `merge_and_unload`
        # output), so serving requires no PEFT/Gradient-merge at runtime — the
        # model is simply loaded from that path, one variant per stream.
        self.model_path = model_path
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
            if self.model_path:
                # Per-stream LoRA variants load via the torch/accelerator path
                # (from_pretrained on a local merged model dir). The OpenVINO
                # converter resolves a HF model id against the local hub cache,
                # not an arbitrary filesystem dir, so a LoRA variant is not
                # converted here — documented constraint (ADAAAA-5324).
                log.warning(
                    "openvino detector does not serve a per-stream LoRA dir (%s); using base converter",
                    self.model_path,
                )
                self.model_path = None
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

        # Per-stream LoRA variant (ADAAAA-5324): load this stream's pre-merged
        # Florence-2 model dir when configured; otherwise the shared base model.
        source = self.model_path or self.model_name
        self._processor = AutoProcessor.from_pretrained(source, trust_remote_code=True)
        self._model = AutoModelForCausalLM.from_pretrained(source, trust_remote_code=True).to(device)
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
        preferLabels / gameHint). When given, the emitted labels are restricted to
        that set: open-set <OD> labels are canonicalized to the nearest in-vocab
        label (person->player, ball->soccer ball) and any detection that cannot be
        labeled within the vocabulary is gated out (dropped) instead of being
        emitted with a fake confidence 1.0 — Florence-2's open-set labels are
        unreliable on untrained game/UI content. With no vocabulary the prompt
        stays open-domain `<OD>` and labelling is best-effort (legacy behaviour).

        NOTE: the <OD> task token accepts no input, so the vocabulary is applied
        as a post-inference gate, not inside the prompt (see module docstring).
        """
        self.load()
        from PIL import Image

        if image.ndim == 2:
            image = np.stack([image] * 3, axis=-1)
        pil = Image.fromarray(image.astype(np.uint8)).convert("RGB")
        # Bare <OD> prompt — the task token, nothing else (Florence-2 has no
        # <OD> input channel; appending the vocabulary here raises AssertionError).
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

    def ocr(self, image: "np.ndarray") -> list[str]:
        """Run the Florence-2 ``<OCR>`` task on a frame (scoreboard text, caption
        readings). Returns recognized text as a trimmed list of lines.

        Best-effort, bounded to candidate anchor frames by the caller
        (ADAAAA-6360, decide-leg I3): any GPU/transport failure degrades to
        ``[]`` — empty OCR is weak/absent evidence and never on its own
        confirms a goal. Never raises into the frame/candidate path.
        """
        self.load()
        from PIL import Image

        if image.ndim == 2:
            image = np.stack([image] * 3, axis=-1)
        pil = Image.fromarray(image.astype(np.uint8)).convert("RGB")
        prompt = "<OCR>"
        inputs = self._processor(images=pil, text=prompt, return_tensors="pt")

        if self._ov_model is not None:
            generated = self._ov_model.generate(
                input_ids=inputs["input_ids"],
                pixel_values=inputs["pixel_values"],
                num_beams=3,
                max_new_tokens=512,
                do_sample=False,
            )
        else:
            target = self._tdml.device() if self._tdml is not None else next(self._model.parameters()).device
            inputs = {k: v.to(target) for k, v in inputs.items()}
            with self._torch.no_grad():
                generated = self._model.generate(
                    **inputs, num_beams=3, max_new_tokens=512, do_sample=False
                )
        text = self._processor.batch_decode(generated, skip_special_tokens=True)[0]
        return [ln.strip() for ln in text.splitlines() if ln.strip()]

    def discover(self, image: "np.ndarray", task: str = "<DETAILED_CAPTION>") -> dict:
        """Run ONE Florence-2 caption/region discovery task on a frame.

        This is the PLAN-CADENCE discovery pass (increment C — ADAAAA-6464): the
        worker invokes it at plan/re-plan cadence ONLY, never from the per-frame
        hot path — caption/region tasks are slower than ``<OD>`` and would break
        the 1-5 s live budget (plan §4.2 / §7 C).

        ``task`` must be a discovery task (``DISCOVERY_TASKS``);
        ``<DETAILED_CAPTION>`` / ``<MORE_DETAILED_CAPTION>`` return a whole-frame
        description; ``<DENSE_REGION_CAPTION>`` / ``<REGION_PROPOSAL>`` return
        best-effort per-region boxes (with captions where present). Returns::

            {"task": "<...>", "method": "caption|region",
             "description": "<raw text>", "regions": [{"bbox": [..], "caption": "..."}],
             "notes": "<provenance>"}

        Best-effort: a bad/unknown task or any GPU/transport failure returns an
        empty result (description "", regions []) tagged with the failure in
        ``notes`` — never raises into the stream.
        """
        self.load()
        task_fmt = discovery_task(task)
        if task_fmt is None:
            return {
                "task": str(task or ""), "method": "mixed",
                "description": "", "regions": [], "notes": f"invalid discovery task {task!r}",
            }
        from PIL import Image

        if image.ndim == 2:
            image = np.stack([image] * 3, axis=-1)
        pil = Image.fromarray(image.astype(np.uint8)).convert("RGB")
        prompt = task_fmt
        inputs = self._processor(images=pil, text=prompt, return_tensors="pt")
        try:
            if self._ov_model is not None:
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
        except Exception as exc:  # noqa: BLE001  (discovery must never kill the stream)
            return {
                "task": task_fmt, "method": discovery_method_for_task(task_fmt),
                "description": "", "regions": [], "notes": f"discovery inference failed: {exc}",
            }
        try:
            text = self._processor.batch_decode(generated, skip_special_tokens=False)[0]
        except Exception:  # noqa: BLE001
            text = ""
        is_region = task_fmt in _DISCOVERY_REGION_TASKS
        regions = self._parse_discovery_regions(text) if is_region else []
        description = text if not is_region else ""
        return {
            "task": task_fmt,
            "method": discovery_method_for_task(task_fmt),
            "description": description.strip(),
            "regions": regions,
            "notes": f"one {task_fmt} pass at plan cadence",
        }

    @staticmethod
    def _parse_discovery_regions(text: str) -> list[dict]:
        """Best-effort parse of a region-task reply into per-region dicts.

        Florence-2 region replies emit ``<loc_…><loc_…><loc_…><loc_…>`` groups
        (0-999 coords, normalized by 1000), optionally followed by a caption
        until the next group. Returns ``[{"bbox": [x1,y1,x2,y2], "caption": str}]``;
        drops junk/empty entries. Never raises.
        """
        out: list[dict] = []
        if not text:
            return out
        # Region group: 4 <loc_N> tokens then optional text until the next group.
        group_re = re.compile(
            r"<loc_(\d+)><loc_(\d+)><loc_(\d+)><loc_(\d+)>(.*?)(?=<loc_|\Z)",
            re.S,
        )
        for m in list(group_re.finditer(text))[:16]:
            a, b, c, d = m.groups()[:4]
            caption = m.group(5).strip() if m.lastindex and m.lastindex >= 5 else ""
            caption = re.split(r"[<>]", caption)[-1].strip()
            try:
                box = [int(a) / 1000, int(b) / 1000, int(c) / 1000, int(d) / 1000]
            except ValueError:
                continue
            out.append({"bbox": box, "caption": caption})
        return out

    @staticmethod
    def _parse(text: str, vocabulary: Optional[list[str]] = None) -> list[dict]:
        """See _parse_with_stats; returns just the emitted objects (back-compat)."""
        objs, _ = FlorenceDetector._parse_with_stats(text, vocabulary)
        return objs

    @staticmethod
    def canonicalize_open_label(raw_label: str, vocabulary: list[str]) -> Optional[str]:
        """Map a raw Florence-2 <OD> label to the closest in-vocabulary label.

        Returns the canonical (case-preserved) vocabulary label, or None when the
        raw label cannot be mapped into the vocabulary. Used by _parse_with_stats
        so a real detection (person, ball) survives the closed-vocab gate with a
        useful in-roster label instead of being counted as Unknown or dropped.
        """
        if not vocabulary:
            return None
        norm = raw_label.strip().lower()
        if not norm or norm in _JUNK_LABELS:
            return None
        # Canonical spelling of each vocab label (lowercased, preserves the vocab
        # item's own casing on emit).
        canon = {str(v).strip().lower(): str(v).strip() for v in vocabulary if str(v).strip()}
        # 1) exact match
        if norm in canon:
            return canon[norm]
        # 2) explicit alias (person->player, ball->soccer ball, ...)
        alias_target = _LABEL_ALIASES.get(norm)
        if alias_target is not None and alias_target.lower() in canon:
            return canon[alias_target.lower()]
        # 3) sub-word/containment: raw label contains a vocab label or a known
        #    sub-token that resolves into the vocabulary.
        for v in vocabulary:
            vn = str(v).strip().lower()
            if vn and vn in norm:
                return canon[vn]
        for tok, target in _LABEL_SUBTOKENS.items():
            if tok in norm and target.lower() in canon:
                return canon[target.lower()]
        return None

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
        `vocabulary`, open-set labels are canonicalized to the nearest in-vocab
        label (person->player, ball->soccer ball); only mappings inside the
        vocabulary are kept — everything else is gated out so emitted bboxes
        always carry a useful, in-scope label.

        Metric definition (ADAAAA-3726): `parsed` counts only GENUINE object
        detections — raw outputs carrying a real non-empty label token that maps
        to a box. Florence-2 frequently rambles on complex frames, emitting runs
        of bare `<loc_…>` groups with no label at all (or junk tokens like
        `object`); those denote no detected object and are counted separately as
        `empty`, not as "unknown". `gated` = genuine detections dropped because
        they could not be mapped into the closed vocabulary, and `unknownRate` =
        gated / parsed. Every emitted bbox is in-roster by construction.
        """
        res: list[dict] = []
        parsed = 0
        gated = 0
        empty = 0
        pattern = re.compile(
            r"(?:<p>)?([^<]+?)(?:</p>)?"
            r"<loc_(\d+)><loc_(\d+)><loc_(\d+)><loc_(\d+)>"
        )
        for m in list(pattern.finditer(text))[:16]:
            label, a, b, c, d = m.groups()
            # Special tokens decode as `s>` / `<s>` / `</s>` prefixes; drop
            # everything up to the last `>` (or `<`) before the real label.
            label = re.split(r"[<>]", label)[-1].strip()
            norm = label.strip().lower()
            # Not a genuine object detection (empty label, or a junk/unlabelable
            # token). Counts as decoder noise (`empty`), never "unknown" — there
            # was no labelled object to fail to roster.
            if not norm or norm in _JUNK_LABELS:
                empty += 1
                continue
            parsed += 1
            # Closed vocabulary: canonicalize the open-set label to the nearest
            # in-scope label; drop what cannot be labeled in the roster.
            if vocabulary:
                mapped = FlorenceDetector.canonicalize_open_label(label, vocabulary)
                if mapped is None:
                    gated += 1
                    continue
                label = mapped
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
            "empty": empty,
            "unknownRate": round(gated / parsed, 3) if parsed else 0.0,
        }
        return res, stats


_detector: Optional[FlorenceDetector] = None
# Per-stream LoRA variants (ADAAAA-5324): one cached FlorenceDetector per
# adapter ref. Each holds its own loaded (base+LoRA-merged) model, so a
# LoRA-attached stream gets its variant while every other stream keeps the
# shared base singleton below. GPU memory grows ~one model per distinct
# adapter ref that is concurrently attached (documented cost, see plan).
_detectors: dict[str, FlorenceDetector] = {}


def reset_detectors() -> None:
    """Drop the cached detectors (base singleton + all LoRA variants). Used by
    tests to isolate selection state; called at perceive startup after the
    boot gate so a stale/partial variant never survives into serving."""
    global _detector, _detectors
    _detector = None
    _detectors = {}


def get_detector(lora_ref: str | None = None) -> FlorenceDetector | None:
    """Return the Florence-2 detector for a session, or None (stub path).

    `lora_ref` selects a PER-STREAM adapter: a LoRA-attached stream gets a
    dedicated detector that loads that stream's merged model dir; a stream
    with no adapter (None) gets the shared base singleton (unchanged legacy
    behaviour — no regression on base-stream detection).
    """
    global _detector
    if os.environ.get("PERCEIVE_MODE", "stub") != "florence":
        return None
    if not lora_ref:
        if _detector is None:
            _detector = FlorenceDetector()
        return _detector
    d = _detectors.get(lora_ref)
    if d is None:
        d = FlorenceDetector(model_path=lora_ref)
        _detectors[lora_ref] = d
    return d


def discover_candidates(
    image: "np.ndarray", task: str = "<DETAILED_CAPTION>", lora_ref: str | None = None
) -> dict:
    """Run ONE discovery pass on a representative frame (increment C).

    This is the PLAN-CADENCE discovery entry point: it selects the session's
    detector (base or per-stream LoRA via ``lora_ref``) and runs a single
    caption/region task, returning the candidate set the planner folds into the
    plan's ``discovery`` field. It is a plan/re-plan-cadence helper only — it
    is never invoked from the per-frame hot path (the ``detect`` method is the
    per-frame primitive). Best-effort: any detector/transport failure returns
    an empty result dict (``method``/``task`` set, ``regions``/``description``
    empty, ``notes`` explaining) — never raises into the stream.
    """
    base = {
        "task": str(task or ""),
        "method": discovery_method_for_task(task) or "mixed",
        "description": "",
        "regions": [],
        "notes": f"one {task} pass at plan cadence",
    }
    d = get_detector(lora_ref)
    if d is None:
        base["notes"] = f"discovery skipped: no florence detector (stub mode) for {task}"
        return base
    try:
        return d.discover(image, task=task)
    except Exception as exc:  # noqa: BLE001  (discovery never kills the stream)
        base["notes"] = f"discovery inference failed: {exc}"
        return base


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

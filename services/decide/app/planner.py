# The what-to-track planner (increment A — ADAAAA-6462, child of ADAAAA-6441).
#
# A SINGLE-SHOT decide-runner call: (intent, category, one representative
# frame, context) -> TrackingPlan. This is one more call TYPE on the decide
# runner, priced like /highlight (plan §4.4 / §14.4). It runs at stream-start
# warm-up, on re-plan triggers, and on the out-of-band re-check cadence —
# NEVER from the per-frame hot path (the 1-5 s live budget rule, plan §9).
#
# Safety contract (mirrors decide_with_gemma): on ANY transport/parse/validate
# failure the caller gets None (or the passed fallback), never an exception —
# a bad planner reply must not kill the stream, so perceive degrades to the
# canned gameHint roster (or the safe default), exactly like the rule-fallback
# for decide. The response carries a `source` field ("planner" |
# "planner-fallback") so the server can audit which path produced the plan.

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

from . import planner_prompt

# Import the contract from the perceive service. In the deployed shared-tree
# topology (GPU boxes; see plan §14.1 file map) `services/perceive` sits next
# to `services/decide`. The decide image (docker/Dockerfile.decide) is a SLIM
# image that only copies services/decide — there the contract file is absent
# and validate_plan() uses the built-in fallback gate (the same hard rules,
# mirrored: the decide runner is single-shot, so the minimal standalone check
# keeps the core invariants without the cross-service import).
#
# The contract module is loaded BY FILE PATH under a unique module name, not
# as `app.tracking_plan`: both services expose a top-level `app` package, so
# in any shared-tree process that imports decide first, `from app.tracking_plan
# import ...` would resolve to the DECIDE `app` package and silently fail. The
# perceive tracking_plan module is pure stdlib (dataclasses/typing), so a
# direct file load is safe and gives the single source of truth in shared-tree
# runs while degrading to the fallback gate in the slim image — never a crash.
import importlib.util
import sys
from pathlib import Path as _Path

_PERCEIVE_TRACKING_PLAN = (
    _Path(__file__).resolve().parents[2] / "perceive" / "app" / "tracking_plan.py"
)


def _load_perceive_contract():
    spec = importlib.util.spec_from_file_location(
        "highlights_perceive_tracking_plan", _PERCEIVE_TRACKING_PLAN
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"perceive tracking_plan contract not found: {_PERCEIVE_TRACKING_PLAN}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["highlights_perceive_tracking_plan"] = mod
    spec.loader.exec_module(mod)
    return mod


try:
    _tp_mod = _load_perceive_contract()
    clamp_max_tracks = _tp_mod.clamp_max_tracks
    _tp_normalize = _tp_mod.normalize
    _tp_validate = _tp_mod.validate
    _TRACKING_PLAN_AVAILABLE = True
except Exception:  # noqa: BLE001  (slim image — use the fallback gate, degrade, don't die)
    clamp_max_tracks = None
    _tp_normalize = None
    _tp_validate = None
    _TRACKING_PLAN_AVAILABLE = False

# Fallback gate (slim image only): the contract's hard rules mirrored locally.
# UI/HUD elements and abstract targets are never trackable (the closed-vocab
# gate), so a plan whose only targets name them is invalid — same verdict the
# perceive validator returns, so the slim and shared-tree paths agree on the
# core invariant (a drift guard test locks the agreement).
_FALLBACK_UI_HUD_BLOCKS = (
    "kill feed", "killfeed", "scoreboard", "minimap", "mini map", "radar",
    "hud", " ui", "timer", "clock", "spectator", "chat", "banner",
    "overlay", "watermark",
)
_FALLBACK_ABSTRACT_BLOCKS = (
    "atmosphere", "mood", "vibe", "crowd energy", "energy", "style",
    "aesthetic", "frame-level", "camera work", "cinematic", "background music",
    "sound", "audio", "commentary", "narrative", "story", "emotion",
    "tension", "drama",
)


def _fallback_label_trackable(label: str) -> bool:
    l = str(label).strip()
    if not l:
        return False
    low = f" {l.lower()} "
    return not any(b in low for b in _FALLBACK_UI_HUD_BLOCKS) and not any(
        b in low for b in _FALLBACK_ABSTRACT_BLOCKS
    )


def _fallback_validate(plan: dict) -> tuple[bool, list[str]]:
    if not isinstance(plan, dict):
        return False, ["plan is not a JSON object"]
    issues: list[str] = []
    targets = plan.get("targets") or []
    good = 0
    for t in targets:
        label = str(t.get("label", "")).strip() if isinstance(t, dict) else ""
        if label and _fallback_label_trackable(label):
            good += 1
    if good == 0:
        issues.append("no trackable targets (all missing, untrackable, or UI/HUD)")
    return (not issues), issues

DEFAULT_PLANNER_URL = "http://127.0.0.1:8088"

# Planner latency budget (plan §8): a single-shot multimodal call, same class
# as a /highlight call. Default 60 s is generous for vision + a ~500-token
# plan; override with PLANNER_TIMEOUT_S.
DEFAULT_PLANNER_TIMEOUT_S = 60.0

# Frame budget for the representative frame: ONE frame (plan §14.4 — the
# planner is single-shot on a representative frame; the frame-WATCHER is the
# capped-sequence consumer, increment F).
MAX_REPRESENTATIVE_FRAMES = 1

# --- fine-tune manifest (increment C — ADAAAA-6464) --------------------------
#
# When a custom Florence-2 fine-tune is attached (loraRef), it ships a
# finetune.json manifest (written by services/train/fine_tune_od.py next to
# the LoRA artifact) recording the classes it detects (detectedClasses) and
# the Florence-2 task set it serves (supportedTasks). The planner injects
# this into the seed and narrows the plan to the detected-class manifest so
# the brain only requests classes the fine-tune actually detects.

FT_MANIFEST_FILENAME = "finetune.json"


def normalize_finetune_manifest(raw: Any) -> dict | None:
    """Coerce a finetune.json payload to {detectedClasses, supportedTasks}.

    Returns None when the payload is empty/unparseable or carries neither a
    detected-class list on a supported-task list (the two fields increment C
    relies on). Never raises. detectedClasses/supportedTasks are deduped,
    trimmed, non-empty strings.
    """
    if not isinstance(raw, dict):
        return None
    # Accept both the canonical keys (detectedClasses/supportedTasks) and the
    # earlier shorthand (classes/tasks) for backward compatibility.
    classes = _clean_ft_list(raw.get("detectedClasses") or raw.get("classes"))
    tasks = _clean_ft_list(raw.get("supportedTasks") or raw.get("tasks"))
    if not classes and not tasks:
        return None
    out: dict = {}
    if classes:
        out["detectedClasses"] = classes
    if tasks:
        out["supportedTasks"] = tasks
    # Carry through any extra metadata (baseModel, trainedTasks, lora, ...).
    for key in ("baseModel", "trainedTasks", "lora", "run", "modelPath"):
        if raw.get(key) is not None:
            out[key] = raw[key]
    return out


def _clean_ft_list(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    out: list[str] = []
    for v in value:
        s = str(v).strip() if v is not None else ""
        if s and s not in out:
            out.append(s)
    return out


def load_finetune_manifest(lora_ref: str | None) -> dict | None:
    """Read the fine-tune manifest for ``lora_ref`` (a merged model dir).

    Tries, in order:
      * ``<lora_ref>/finetune.json``        — manifest written inside the
        drop-in dir that FlorenceDetector(model_path=loraRef) loads;
      * ``<lora_ref>/../finetune.json``      — manifest next to the LoRA
        artifact in the train output dir;
      * ``<lora_ref>`` itself when lora_ref names a finetune.json.
    Returns None on any failure (missing file, bad JSON, unparseable) — a
    missing/absent manifest must never break planning; the caller falls back
    to the base-model seed.
    """
    if not lora_ref:
        return None
    path = _Path(str(lora_ref))
    candidates: list[Path] = []
    if path.is_file():
        if path.name == FT_MANIFEST_FILENAME:
            candidates.append(path)
        candidates.append(path.parent / FT_MANIFEST_FILENAME)
        candidates.append(path / FT_MANIFEST_FILENAME)
    else:
        candidates.append(path / FT_MANIFEST_FILENAME)
        candidates.append(path / ".." / FT_MANIFEST_FILENAME)
        candidates.append(path.parent / FT_MANIFEST_FILENAME)
    for cand in candidates:
        try:
            if cand.is_file():
                with open(cand, "r", encoding="utf-8") as fh:
                    obj = json.load(fh)
                manifest = normalize_finetune_manifest(obj)
                if manifest is not None:
                    return manifest
        except Exception:  # noqa: BLE001  (bad manifest must never raise)
            continue
    return None


def _resolve_finetune_manifest(context: dict | None) -> dict | None:
    """Resolve the active fine-tune manifest from a planner context.

    Prefers an explicitly-passed ``fineTuneManifest``; otherwise loads from
    ``loraRef`` when present (the planner injects the manifest when a LoRA is
    attached — plan §7 C).
    """
    ctx = context or {}
    if ctx.get("fineTuneManifest"):
        return normalize_finetune_manifest(ctx["fineTuneManifest"])
    if ctx.get("loraRef"):
        return load_finetune_manifest(str(ctx["loraRef"]))
    return None


def _stringify_ft_manifest(manifest: dict) -> str:
    """Render a fine-tune manifest as a compact, seed-safe single line."""
    classes = ", ".join(manifest.get("detectedClasses", [])) or "(none declared)"
    tasks = ", ".join(manifest.get("supportedTasks", [])) or "(base set)"
    return f"detected classes: [{classes}] ; supported tasks: [{tasks}]"


def _finetune_narrow_plan(plan: dict, manifest: dict) -> dict:
    """Narrow a normalized plan to the fine-tune's detected-class manifest.

    When a fine-tune is attached the plan may ONLY request classes in its
    detected-class manifest (plan §7 C). Targets whose label is not in the
    manifest are dropped; the anchor is re-normalized so the invariant (anchor
    in targets) holds. Returns a new plan dict; the input is left untouched.
    """
    classes = {str(c).strip().lower() for c in manifest.get("detectedClasses", [])}
    if not classes:
        return dict(plan)
    targets = [
        dict(t) for t in plan.get("targets", [])
        if str(t.get("label", "")).strip().lower() in classes
    ]
    out = dict(plan)
    out["targets"] = targets
    if targets and _TRACKING_PLAN_AVAILABLE and _tp_normalize is not None:
        norm, _ = _tp_normalize(out)
        out = dict(norm)
    # Discovery provenance should note the narrowing for QA auditing.
    disc = dict(out.get("discovery") or {})
    notes = [str(disc.get("notes", "")).strip()]
    notes.append(f"narrowed to fine-tune detected-class manifest ({len(targets)} classes)")
    disc["notes"] = "; ".join(n for n in notes if n)
    out["discovery"] = disc or None
    return out


def _fold_discovery(plan: dict, discovery: Any) -> dict:
    """Fold a discovery-pass result into the plan's ``discovery`` field.

    ``discovery`` is the dict produced by perceive's discovery pass (increment
    C): {method, florenceTasks, candidates, notes} or a normalized TrackingPlan
    ``discovery`` block. The plan was generated AT PLAN CADENCE (the caller
    never invokes the discovery pass from the per-frame hot path), so folding
    the provenance here is an audit of which Florence-2 task produced the track
    set. Never raises; an unparseable discovery is dropped (plan stays as-is).
    """
    if not isinstance(discovery, dict) or not discovery:
        return dict(plan)
    out = dict(plan)
    disc = dict(discovery)
    # Keep only the canonical audit keys.
    for key in ("method", "florenceTasks", "notes", "candidates"):
        if key in disc:
            out["discovery"] = out.get("discovery") or {}
            if isinstance(out["discovery"], dict):
                out["discovery"][key] = disc[key]
    if not out.get("discovery") and "discovery" in disc:
        out["discovery"] = disc
    return out


def _strip_json_fence(text: str) -> str:
    """Remove markdown ```json ... ``` fences and surrounding prose (same
    extraction as gemma._strip_json_fence)."""

    def _first_json(s: str) -> str:
        lo = s.find("{")
        hi = s.rfind("}")
        if lo == -1 or hi == -1 or hi <= lo:
            return ""
        return s[lo : hi + 1]

    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        return _first_json(m.group(1))
    return _first_json(text)


def parse_plan(text: str) -> dict | None:
    """Turn the model's raw text into a TrackingPlan-shaped dict, or None on
    any JSON failure. Does NOT validate (validation is validate_plan's job,
    and the caller decides degrade-vs-accept); a JSON object that parses but
    fails validation still returns here and is rejected by validate_plan."""
    try:
        obj = json.loads(_strip_json_fence(text))
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def validate_plan(plan: dict | None) -> tuple[bool, list[str]]:
    """Hard-validate a raw plan dict against the TrackingPlan contract rules
    (plan §14.2 — the validator is the increment A acceptance gate). Returns
    (ok, issues). When the perceive contract is importable this delegates to
    its validator (single source of truth); otherwise it applies the built-in
    fallback gate (the contract's hard rules mirrored: no UI/HUD / abstract
    targets), so the decide runner still enforces the core rule without the
    cross-service import."""
    if not isinstance(plan, dict):
        return False, ["plan is not a JSON object"]
    if _TRACKING_PLAN_AVAILABLE and _tp_validate is not None:
        ok, issues = _tp_validate(plan)
        return bool(ok), list(issues)
    return _fallback_validate(plan)


def build_planner_prompt(
    intent: str,
    category: str,
    context: dict | None = None,
    max_tracks_proposal: int | None = None,
) -> str:
    """Compose the planner's single-shot prompt: the capability/Florence-2
    usage seed (full text) + the session context + the exact output contract.
    The seed teaches task choice = latency choice; the context carries the
    per-session facts (mode, track cap, fine-tune manifest, prior plan)."""
    ctx = context or {}
    mode = str(ctx.get("mode", "live")).strip().lower() or "live"
    lines: list[str] = []
    if max_tracks_proposal:
        lines.append(f"session mode: {mode} (track slot cap {max_tracks_proposal}; propose maxTracks within it)")
    else:
        lines.append(f"session mode: {mode}")
    intent_s = (intent or "").strip()
    default_intent = "unspecified (default to the category high-value plays)"
    lines.append(f"user intent: {intent_s or default_intent}")
    lines.append(f"video category: {category or 'general'}")
    if ctx.get("gameHint"):
        lines.append(f"game hint: {ctx['gameHint']}")
    ft = _resolve_finetune_manifest(ctx)
    if ft:
        lines.append("attached fine-tune manifest: " + _stringify_ft_manifest(ft))
        classes = ft.get("detectedClasses")
        if classes:
            lines.append(
                "FINE-TUNE CONSTRAINT: request ONLY these detected classes — "
                + ", ".join(str(c) for c in classes)
                + " (do not request any class outside this manifest)."
            )
        tasks = ft.get("supportedTasks")
        if tasks:
            lines.append(
                "fine-tune supported tasks: "
                + ", ".join(str(t) for t in tasks)
                + " — use only tasks in this set; the table below is bounded by it."
            )
    if ctx.get("previousPlan"):
        lines.append("a previous plan is active; re-plan if the representative frame contradicts it:")
        try:
            lines.append(json.dumps(ctx["previousPlan"]))
        except Exception:
            lines.append("(previous plan unserializable)")
    if ctx.get("recentDiscoveryNotes"):
        lines.append(f"prior discovery notes: {ctx['recentDiscoveryNotes']}")
    context_block = "\n".join(lines)
    return (
        planner_prompt.PLANNER_SEED
        + "\n\n# Session context\n"
        + context_block
        + "\n\n# Representative frame\n"
        + "One representative frame of this feed is attached. Inspect it: who/what "
        + "is on screen, where, and which of them carry the user's intent. Pick the "
        + "anchor and a small trackable target set accordingly."
    )


def _planner_url(url: str | None) -> str:
    return url or os.environ.get("PLANNER_URL") or os.environ.get("GEMMA_URL", DEFAULT_PLANNER_URL)


def plan_tracking(
    intent: str,
    category: str,
    frame: dict | None = None,
    context: dict | None = None,
    mode: str = "live",
    url: str | None = None,
    timeout_s: float = DEFAULT_PLANNER_TIMEOUT_S,
    max_tracks_proposal: int | None = None,
) -> dict | None:
    """The single-shot planner call: (intent, category, representative frame,
    context) -> a valid TrackingPlan dict, or None on any failure.

    `frame` is ONE representative frame {"base64": ...} (the frame-watcher's
    capped sequence is a different path — increment F; the planner never gets
    a sequence). `context` may carry mode, gameHint, fineTuneManifest,
    previousPlan, recentDiscoveryNotes. `mode` selects the maxTracks proposal
    cap (live 3 / vod 8); the plan's maxTracks is clamped server-side here
    (LLM proposes, clamp enforces) before the plan is handed to perceive.

    Returns the normalized plan with `source: "planner"` added; None (never
    an exception) when the model is unreachable, the reply is not JSON, or the
    reply fails contract validation."""
    cap = clamp_max_tracks(max_tracks_proposal, mode) if clamp_max_tracks else None
    if cap is None:
        cap = 3 if mode == "live" else 8
    prompt = build_planner_prompt(
        intent,
        category,
        context={**(context or {}), "mode": mode},
        max_tracks_proposal=cap,
    )
    import httpx

    frames = []
    if isinstance(frame, dict) and (frame.get("base64") or frame.get("image")):
        b64 = frame.get("base64") or frame.get("image")
        frames.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})

    # Single-shot, no thinking (same reasoning_effort="none" rationale as
    # gemma.ask: the QAT model otherwise burns the reply budget on reasoning
    # and returns empty content).
    content: list = frames
    content.append({"type": "text", "text": prompt})
    payload = {
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.0,
        "reasoning_effort": "none",
        "max_tokens": 1200,
        "stream": False,
    }
    model = os.environ.get("GEMMA_MODEL")
    if model:
        payload["model"] = model
    try:
        resp = httpx.post(_planner_url(url).rstrip("/") + "/v1/chat/completions", json=payload, timeout=timeout_s)
        resp.raise_for_status()
        text = resp.json()["choices"][0]["message"]["content"]
    except Exception:
        return None
    raw = parse_plan(text)
    if raw is None:
        return None
    ok, _issues = validate_plan(raw)
    if not ok:
        return None
    if _TRACKING_PLAN_AVAILABLE and _tp_normalize is not None:
        plan, _warnings = _tp_normalize(raw)
    else:
        plan = dict(raw)
    # Fine-tune narrowing (plan §7 C): when a fine-tune manifest is attached,
    # the plan may ONLY request classes the fine-tune actually detects.
    ft = _resolve_finetune_manifest(context)
    if ft:
        plan = _finetune_narrow_plan(plan, ft)
        # If narrowing emptied the roster (model proposed only out-of-manifest
        # classes), the plan is invalid — reject so the caller degrades to the
        # (narrowed) fallback rather than returning an empty plan.
        if not plan.get("targets"):
            return None
    # Fold a discovery-pass result (method/tasks/candidates) into `discovery` —
    # the caller runs the discovery pass at plan cadence, never per-frame.
    disc = (context or {}).get("discovery")
    if disc:
        plan = _fold_discovery(plan, disc)
    # Server-side hard clamp (LLM proposes, clamp enforces) — applied here so
    # the plan that reaches perceive can never exceed the mode cap.
    if clamp_max_tracks is not None:
        plan["maxTracks"] = clamp_max_tracks(plan.get("maxTracks"), mode)
    plan["source"] = "planner"
    plan["plannedAt"] = round(time.time(), 3)
    return plan


def plan_with_fallback(
    intent: str,
    category: str,
    frame: dict | None = None,
    context: dict | None = None,
    mode: str = "live",
    url: str | None = None,
    timeout_s: float = DEFAULT_PLANNER_TIMEOUT_S,
    fallback: dict | None = None,
) -> dict:
    """plan_tracking() with the caller-supplied fallback (canned gameHint
    roster / safe-default roster) on failure — the perceive-consumption
    guarantee (plan §4.5 / §10): a planner failure NEVER kills a stream.
    The result always carries `source` ("planner" | "planner-fallback") and
    `maxTracks` clamped to the mode cap."""
    plan = plan_tracking(
        intent,
        category,
        frame,
        context,
        mode=mode,
        url=url,
        timeout_s=timeout_s,
    )
    if plan is not None:
        return plan
    if isinstance(fallback, dict):
        out = dict(fallback)
        if "maxTracks" in out and clamp_max_tracks is not None:
            out["maxTracks"] = clamp_max_tracks(out.get("maxTracks"), mode)
        # Narrow the fallback to the fine-tune manifest too, so a degraded
        # plan on a fine-tuned stream also stays in-class (plan §7 C).
        ft = _resolve_finetune_manifest(context)
        if ft:
            out = _finetune_narrow_plan(out, ft)
        out["source"] = "planner-fallback"
        out["plannedAt"] = round(time.time(), 3)
        return out
    return {
        "planVersion": 1,
        "category": category or "general",
        "intent": intent or "",
        "anchor": {"label": "", "role": "entity"},
        "targets": [],
        "zones": [],
        "discovery": None,
        "maxTracks": 3 if mode == "live" else 8,
        "reason": "planner unavailable; no fallback roster supplied",
        "source": "planner-fallback",
        "plannedAt": round(time.time(), 3),
    }


def plan_with_discovery(
    intent: str,
    category: str,
    frame: dict | None = None,
    context: dict | None = None,
    mode: str = "live",
    url: str | None = None,
    timeout_s: float = DEFAULT_PLANNER_TIMEOUT_S,
    fallback: dict | None = None,
    discovery_runner=None,
    discovery_task: str = "<DETAILED_CAPTION>",
) -> dict:
    """The planner's ONE-per-plan-cadence caption/region discovery pass.

    Increment C (ADAAAA-6464): runs ``discovery_runner`` exactly once at PLAN /
    RE-PLAN cadence to get candidate track targets (perceive's
    ``run_discovery_pass`` bound to this session's Florence-2 + loraRef), then
    folds the resulting discovery block into the plan's ``discovery`` field.

    ``discovery_runner`` is a zero-arg callable returning a discovery block
    ({method, florenceTasks, candidates, notes}) as produced by
    ``services/perceive/app/discovery.run_discovery_pass``; in deployment it is
    bound to the session/representative-frame so the slow Florence-2 task runs
    once here, never per-frame. ``discovery_task`` documents/narrow the task
    but is advisory (the runner is authoritative). When ``discovery_runner`` is
    None no discovery pass runs (no candidate source) and planning proceeds
    exactly as ``plan_with_fallback``. A discovery failure NEVER breaks
    planning — it degrades to the same plan as if discovery had been skipped.
    """
    ctx = dict(context or {})
    if discovery_runner is not None:
        try:
            disc = discovery_runner()
            if isinstance(disc, dict):
                ctx["discovery"] = disc
        except Exception:  # noqa: BLE001  (discovery must never break planning)
            pass
    return plan_with_fallback(
        intent,
        category,
        frame=frame,
        context=ctx,
        mode=mode,
        url=url,
        timeout_s=timeout_s,
        fallback=fallback,
    )

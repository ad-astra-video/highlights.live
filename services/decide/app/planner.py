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
    if ctx.get("fineTuneManifest"):
        ft = ctx["fineTuneManifest"]
        if isinstance(ft, str):
            lines.append(f"attached fine-tune manifest: {ft}")
        else:
            try:
                lines.append("attached fine-tune manifest: " + json.dumps(ft))
            except Exception:
                lines.append("attached fine-tune manifest: (unserializable; ignore)")
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

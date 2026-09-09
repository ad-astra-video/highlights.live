"""Gemma 12B (llama.cpp llama-server) integration for the decide step.

Activates when DECIDE_MODE=gemma and GEMMA_URL points at a llama.cpp
`llama-server` (with mmproj for vision). Sends the ContextSnapshot + up to a
few JPEGs (full frame + track crops) as a multimodal chat request and asks for
a strict JSON HighlightDecision. Parses + validates the reply; on any failure
falls back to the deterministic rule so the pipeline never dies on a model
glitch (plan §9: health must not flap, a bad Gemma reply must not kill the job).
"""

from __future__ import annotations

import json
import os
import re
from typing import Optional

from .decider import decide

DEFAULT_GEMMA_URL = "http://127.0.0.1:8088"


def _strip_json_fence(text: str) -> str:
    """Remove markdown ```json ... ``` fences and surrounding prose."""

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


def parse_decision(text: str) -> dict | None:
    """Turn the model's raw text into a HighlightDecision-shaped dict, or None."""
    try:
        obj = json.loads(_strip_json_fence(text))
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    is_hl = obj.get("isHighlight")
    score = obj.get("score")
    if not isinstance(is_hl, bool):
        return None
    try:
        score = float(score) if score is not None else 0.0
    except (TypeError, ValueError):
        score = 0.0
    score = min(100.0, max(0.0, score))
    return {
        "isHighlight": is_hl,
        "score": score,
        "eventType": obj.get("eventType"),
        "reason": obj.get("reason"),
        "source": "gemma",
    }


def build_prompt(event_type: str, evidence: dict, game_hint: str = "") -> str:
    ev = event_type.upper()
    meta = [
        f"candidate event type: {ev}",
        f"game hint: {game_hint or 'unspecified'}",
        f"track count: {evidence.get('trackCount', 0)}",
        f"max tracked velocity: {evidence.get('maxVelocity', 0):.2f}",
        f"ocr hits: {evidence.get('ocrHits', 0)}",
    ]
    return (
        "You are a sports/esports highlight judge. You are shown the source frame "
        "(and track-crop images) from the moment of a detected candidate event.\n"
        "Decide whether this is a real highlight worth clipping.\n"
        "Context:\n- " + "\n- ".join(meta) + "\n\n"
        "Do NOT provide any reasoning or thinking. Answer immediately with ONLY one "
        "JSON object, no markdown, no preamble, exactly: "
        '{"isHighlight": true|false, "score": 0..100, "eventType": "<type>", "reason": "<short reason>"}'
    )


def ask(
    url: str,
    event_type: str,
    evidence: dict,
    game_hint: str = "",
    images: list | None = None,
    timeout_s: float = 180.0,
) -> dict | None:
    """Call llama-server multimodal completion. Returns a parsed/validated
    HighlightDecision dict, or None on any transport/parse failure."""
    import httpx

    content: list = [{"type": "text", "text": build_prompt(event_type, evidence, game_hint)}]
    for img in images or []:
        b64 = img.get("base64") or img.get("image") or ""
        if not b64:
            continue
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
            }
        )

    # Generous budget + timeout: a thinking-capable model on CPU may burn tokens
    # on a short chain of thought before the JSON, and CPU is slow. Undersizing
    # this makes the call return empty (finish_reason=length) and forces the rule
    # fallback on every evaluate — worse than a slower real decision.
    payload = {
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.0,
        "max_tokens": 1200,
        "stream": False,
    }
    # llama-server is fine without "model"; OpenAI-compatible servers (Ollama)
    # require it. Only send it when the caller declares one (GEMMA_MODEL).
    model = os.environ.get("GEMMA_MODEL")
    if model:
        payload["model"] = model
    try:
        resp = httpx.post(url.rstrip("/") + "/v1/chat/completions", json=payload, timeout=timeout_s)
        resp.raise_for_status()
        text = resp.json()["choices"][0]["message"]["content"]
    except Exception:
        return None
    return parse_decision(text)


def decide_with_gemma(
    event_type: str,
    evidence: dict,
    game_hint: str = "",
    images: list | None = None,
    url: str | None = None,
) -> dict:
    """Primary path: Gemma. On any failure, deterministic rule fallback so the
    caller always gets a valid HighlightDecision."""
    u = url or os.environ.get("GEMMA_URL", DEFAULT_GEMMA_URL)
    g = ask(u, event_type, evidence, game_hint, images)
    if g is not None:
        return g
    # fallback: deterministic rule
    d = decide(event_type, track_count=evidence.get("trackCount", 0), max_velocity=evidence.get("maxVelocity", 0), ocr_hits=evidence.get("ocrHits", 0))
    return {
        "isHighlight": d.is_highlight,
        "score": d.score,
        "eventType": event_type,
        "reason": d.reason,
        "source": "rule-fallback",
    }

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


def build_prompt(
    event_type: str,
    evidence: dict,
    game_hint: str = "",
    n_frames: int = 1,
    has_audio: bool = False,
) -> str:
    ev = event_type.upper()
    meta = [
        f"candidate event type: {ev}",
        f"game hint: {game_hint or 'unspecified'}",
        f"track count: {evidence.get('trackCount', 0)}",
        f"max tracked velocity: {evidence.get('maxVelocity', 0):.2f}",
        f"ocr hits: {evidence.get('ocrHits', 0)}",
        f"frames shown (1 FPS temporal window): {n_frames}",
        f"audio provided (commentary/crowd): {'yes' if has_audio else 'no'}",
    ]
    return (
        "You are a sports/esports highlight judge. You are shown a temporal "
        "SEQUENCE of frames (extracted at 1 FPS from the moment of a detected "
        "candidate event) plus the context images, and, when available, the "
        "accompanying audio.\n"
        "Reason across the frame sequence (motion, position, ball/foot/player "
        "location, scoreboard/OCR) AND the audio (commentary, crowd, whistle) to "
        "decide whether this is a real highlight worth clipping, and to classify "
        "the event precisely.\n"
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
    frames: list | None = None,
    audio_b64: str = "",
    audio_sample_rate: int = 16000,
    reasoning_effort: str = "none",
    timeout_s: float = 180.0,
) -> dict | None:
    """Call llama-server multimodal completion. Returns a parsed/validated
    HighlightDecision dict, or None on any transport/parse failure.

    Follows the Gemma 4 12B video+audio modality-order guidance: all image
    content (temporal frame sequence + crops) comes BEFORE the text prompt,
    and any audio comes AFTER the text. Audio is mono 16 kHz float32 (wav)."""
    import httpx

    frames = frames or []
    images = images or []

    def _img(part: dict) -> dict | None:
        b64 = part.get("base64") or part.get("image") or ""
        if not b64:
            return None
        return {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}

    # 1) frames + images (all image content) BEFORE the text prompt
    content: list = [i for i in (_img(p) for p in frames + images) if i is not None]
    # 2) the text prompt, in the middle
    content.append(
        {
            "type": "text",
            "text": build_prompt(event_type, evidence, game_hint, n_frames=len(frames), has_audio=bool(audio_b64)),
        }
    )
    # 3) audio AFTER the text (modality-order rule)
    if audio_b64:
        content.append(
            {
                "type": "audio_url",
                "audio_url": {"url": f"data:audio/wav;base64,{audio_b64}"},
            }
        )

    # reasoning_effort="none" turns OFF the gemma-4 QAT model's thinking mode
    # (verified on llama.cpp build 10920: it otherwise burns ~1.5K chars of
    # reasoning_content before the JSON — think=476 tok/5.9s vs off=53 tok/0.8s —
    # and an empty 'content' until thinking ends forced the rule fallback).
    # OpenAI's "thinking": {"enabled": false} is NOT honored by llama.cpp; the
    # OpenRouter-style reasoning_effort param is.
    payload = {
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.0,
        # Frontend-selectable; "none" (the default) turns OFF gemma-4 QAT thinking
        # so content comes back as the JSON immediately instead of empty until a
        # long chain of thought ends (see decide tests for the ordering of the
        # image/text/audio modalities).
        "reasoning_effort": reasoning_effort,
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
    frames: list | None = None,
    audio_b64: str = "",
    audio_sample_rate: int = 16000,
    reasoning_effort: str = "none",
    url: str | None = None,
) -> dict:
    """Primary path: Gemma. On any failure, deterministic rule fallback so the
    caller always gets a valid HighlightDecision."""
    u = url or os.environ.get("GEMMA_URL", DEFAULT_GEMMA_URL)
    g = ask(u, event_type, evidence, game_hint, images, frames, audio_b64, audio_sample_rate, reasoning_effort=reasoning_effort)
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

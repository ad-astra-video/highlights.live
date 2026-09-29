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
    """Turn the model's raw text into a HighlightDecision-shaped dict, or None.

    The grounding object is BEST-EFFORT: the strict JSON gate (isHighlight must
    be a bool) is unchanged, and a reply without a usable grounding object is
    still parsed (its `grounding` key is simply absent) so a noisy model reply
    never drops the whole decision. The SERVER-side grounding gate then rejects
    a claimed highlight that carries no grounding — that is the G3 rejection the
    board's feedback is written against.
    """
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
    out = {
        "isHighlight": is_hl,
        "score": score,
        "eventType": obj.get("eventType"),
        "reason": obj.get("reason"),
        "source": "gemma",
    }
    grounding = obj.get("grounding")
    if isinstance(grounding, dict):
        out["grounding"] = {
            "objects": grounding.get("objects")
            if isinstance(grounding.get("objects"), list)
            else [],
            "ocrDelta": grounding.get("ocrDelta") if isinstance(grounding.get("ocrDelta"), str) else "",
            "evidence": grounding.get("evidence") if isinstance(grounding.get("evidence"), str) else "",
            "supports": grounding.get("supports")
            if isinstance(grounding.get("supports"), bool)
            else None,
        }
    return out


def _reaction_summary(evidence: dict) -> list[str]:
    """Render the people-reaction context lines for the decide prompt (INC-4 /
    ADAAAA-4328). Contacts the INC-2 audio gate (crowd/commentary energy) and the
    INC-2b ball signal, plus a cheap visual-celebration cue. Reaction is
    corroborating evidence for the verdict, not the arbiter: Gemma still decides
    on its full read of the frames + audio + play detail. Returns [] when no
    reaction signal is present (no regression vs today's prompt)."""
    r = evidence.get("reaction") or {}
    if not isinstance(r, dict):
        r = {}
    out: list[str] = []
    try:
        ce = float(r.get("crowdEnergy", 0.0) or 0.0)
    except (TypeError, ValueError):
        ce = 0.0
    if ce > 0:
        kind = (r.get("audioKind") or "").strip() or "crowd/commentary energy"
        out.append(f"audio reaction: {kind} at crowd energy {ce:.2f}/1.0")
    try:
        him = int(r.get("humansInMotion", 0) or 0)
    except (TypeError, ValueError):
        him = 0
    if him > 0:
        out.append(f"visual reaction: {him} human(s) in high motion (celebration cue)")
    try:
        bsp = float(r.get("ballSpeedMps", 0.0) or 0.0)
    except (TypeError, ValueError):
        bsp = 0.0
    if bsp > 0:
        possessor = (r.get("ballPossessionId") or "").strip()
        out.append(
            f"ball context: {bsp:.1f} m/s"
            + (f" toward/at possession player {possessor}" if possessor else "")
        )
    return out


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
    reaction_lines = _reaction_summary(evidence)
    if reaction_lines:
        meta.append("people-reaction evidence:")
        meta.extend("  " + ln for ln in reaction_lines)
    return (
        "You are a sports/esports highlight judge. You are shown a temporal "
        "SEQUENCE of frames (extracted at 1 FPS from the moment of a detected "
        "candidate event) plus the context images, and, when available, the "
        "accompanying audio.\n"
        "Reason across the frame sequence (motion, position, ball/foot/player "
        "location, scoreboard/OCR) AND the audio (commentary, crowd, whistle) to "
        "decide whether this is a real highlight worth clipping, and to classify "
        "the event precisely.\n"
        "When people are visible, EXPLICITLY describe their reaction and weigh it "
        "as evidence: players with arms raised, a group pile/team huddle, "
        "bench/dugout leaping up to celebrate, or the crowd/commentary erupting. "
        "Reaction is corroborating evidence only - cite it, but decide on your "
        "full read of the frames, audio, and context; never let reaction alone "
        "override a clear read of the play.\n"
        "GROUNDING (REQUIRED): every decision MUST include a 'grounding' object "
        "that ties the claimed event to the actual frame content you see. It has "
        "four fields: 'objects' (the tracked object(s)/player(s)/regions you are "
        "looking at, e.g. ['ball', 'player #10 (red)']), 'ocrDelta' (any "
        "scoreboard/OCR change you observe, e.g. 'scoreboard unchanged 1-0', or "
        "'' if none), 'evidence' (one sentence on why the frame content supports "
        "or REFUTES the claimed event type, e.g. 'ball is in the net and players "
        "are celebrating'), and 'supports' (true only if the frames actually show "
        "the claimed event; false when the frames do NOT support it). Be honest: "
        "for a GOAL claim, count as supporting evidence any of: the ball in or "
        "over the goal line or clearly in the goal area, a decisive shot on goal "
        "past the keeper, several players visibly celebrating (arms raised / "
        "group pile / huddle) right after a shot on goal, or a scoreboard/OCR "
        "change. Ordinary play with none of these must set supports=false. A "
        "claimed event with no supporting visual evidence must be rejected "
        "(supports=false).\n"
        "Do NOT fabricate grounding: only cite objects/OCR/motion you can actually "
        "see in the supplied frames.\n"
        "Context:\n- " + "\n- ".join(meta) + "\n\n"
        "Do NOT provide any reasoning or thinking. Answer immediately with ONLY one "
        "JSON object, no markdown, no preamble, exactly: "
        '{"isHighlight": true|false, "score": 0..100, "eventType": "<type>", "reason": "<short reason>", '
        '"grounding": {"objects": ["..."], "ocrDelta": "...", "evidence": "...", "supports": true|false}}'
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

    # Raw audio bytes are gated OFF by default. llama-server (this llama.cpp
    # build, b10920) does NOT accept an `audio_url` content block: including one
    # makes it reject the WHOLE request with HTTP 400 "unsupported content[].type"
    # (verified live against highlights-gemma on 2026-09-29), which silently
    # dropped the entire gemma analysis to the deterministic rule fallback.
    # Audio-derived reaction evidence (crowd energy, audio kind, ball context) is
    # already folded into the prompt as TEXT via _reaction_summary, so gating the
    # raw wav bytes off loses no audio signal — frames + text still reach the
    # model. Re-enable only once llama-server accepts an audio modality/encoding,
    # and only by setting GEMMA_SEND_AUDIO=1 (any audio_url request 400s otherwise).
    send_audio = bool(audio_b64) and os.environ.get("GEMMA_SEND_AUDIO", "0") == "1"

    def _img(part: dict) -> dict | None:
        b64 = part.get("base64") or part.get("image") or ""
        if not b64:
            return None
        return {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}

    # 1) frames + images (all image content) BEFORE the text prompt
    content: list = [i for i in (_img(p) for p in frames + images) if i is not None]
    # 2) the text prompt, in the middle. has_audio reflects whether audio bytes
    # actually reach the model (send_audio), never whether the caller supplied
    # them — we must not tell the model "audio provided: yes" when it is not.
    content.append(
        {
            "type": "text",
            "text": build_prompt(event_type, evidence, game_hint, n_frames=len(frames), has_audio=send_audio),
        }
    )
    # 3) audio AFTER the text (modality-order rule) — only when the gate is on.
    if send_audio:
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


def rule_grounding(event_type: str, evidence: dict, decision) -> dict:
    """Build a grounding object from the deterministic rule's own evidence, so
    even the rule-fallback path keeps the HighlightDecision contract's grounding
    field populated (the server gate checks grounding, never trusts a bare
    claim). objects/ocrDelta come from the scalar evidence the rule actually
    scored; supports mirrors the rule verdict so a rule highlight with
    corroborating evidence passes the gate exactly as before, and a rule
    non-highlight is not surfaced (gate is a no-op for non-highlights).
    """
    track_count = int(evidence.get("trackCount", 0) or 0)
    vel = float(evidence.get("maxVelocity", 0.0) or 0.0)
    objects: list[str] = []
    if track_count >= 1:
        objects.append(f"{track_count} tracked object(s)")
    if vel >= 0.25:
        objects.append("fast-moving tracked object")
    ocr_hits = int(evidence.get("ocrHits", 0) or 0)
    parts = [f"candidate {event_type} scored from rule evidence ({decision.reason})"]
    parts.append("decision evidence present" if decision.is_highlight else "decision evidence insufficient")
    return {
        "objects": objects,
        "ocrDelta": "" if not ocr_hits else f"{ocr_hits} OCR hit(s)",
        "evidence": "; ".join(parts),
        "supports": decision.is_highlight,
    }


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
    # fallback: deterministic rule (passes the reaction block so the
    # notable-only corroboration check is consistent with the Gemma path)
    d = decide(
        event_type,
        track_count=evidence.get("trackCount", 0),
        max_velocity=evidence.get("maxVelocity", 0),
        ocr_hits=evidence.get("ocrHits", 0),
        reaction=evidence.get("reaction"),
    )
    return {
        "isHighlight": d.is_highlight,
        "score": d.score,
        "eventType": event_type,
        "reason": d.reason,
        "grounding": rule_grounding(event_type, evidence, d),
        "source": "rule-fallback",
    }

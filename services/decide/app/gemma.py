"""Gemma 12B (llama.cpp llama-server) integration for the decide step.

Activates when DECIDE_MODE=gemma and GEMMA_URL points at a llama.cpp
`llama-server` (with mmproj for vision). Sends the ContextSnapshot + up to a
few JPEGs (full frame + track crops) as a multimodal chat request and asks for
a strict JSON HighlightDecision. Parses + validates the reply; on any failure
falls back to the deterministic rule so the pipeline never dies on a model
glitch (plan §9: health must not flap, a bad Gemma reply must not kill the job).

ADAAAA-6358 (I1): the decide prompt is de-anchored. The candidate event type
is framed as a *hypothesis to test*, not a fact, and the model must (a) first
state what it independently observes, (b) check the explicit goal criteria
(ball crossed the goal line between the posts / ball in net / scoreboard
changed / crowd erupted), and (c) return isHighlight=false when a required
criterion is unverifiable or explicitly contradicted. The response carries a
structured `verdict` + `evidenceAttested` (plus the independent `reasoning`)
so a reviewer can see *why* the decision was made, grounded in the evidence.
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


_VERDICT_CRITERIA_KEYS = (
    "ballCrossedLineBetweenPosts",
    "ballInNet",
    "scoreboardChanged",
    "crowdErupted",
)


def _as_text(value) -> str:
    """Coerce an arbitrary model field to a clean str ('' for anything but a
    non-empty string). Never raises."""
    return value.strip() if isinstance(value, str) and value.strip() else ""


def _as_str_list(value) -> list[str]:
    """Coerce an arbitrary model field to a list of non-empty strings."""
    if isinstance(value, list):
        out = []
        for item in value:
            s = item.strip() if isinstance(item, str) else ""
            if s:
                out.append(s)
        return out
    s = value.strip() if isinstance(value, str) else ""
    return [s] if s else []


def _normalize_verdict(verdict) -> dict | None:
    """Normalize the model's structured ``verdict`` block to a stable shape.
    Returns None when absent/malformed. Criteria values are coerced to a
    strict tri-state: True / False / None (None == unknown/unverifiable), so a
    reviewer can see which required criterion could not be confirmed."""
    if not isinstance(verdict, dict):
        return None
    criteria_raw = verdict.get("criteria")
    criteria: dict | None = None
    if isinstance(criteria_raw, dict):
        criteria = {}
        for key in _VERDICT_CRITERIA_KEYS:
            val = criteria_raw.get(key)
            criteria[key] = val if isinstance(val, bool) else None
    observed = _as_text(verdict.get("independentlyObserved"))
    return {
        "hypothesis": _as_text(verdict.get("hypothesis")) or None,
        "independentlyObserved": observed or None,
        "criteria": criteria,
        "contradictedBy": _as_text(verdict.get("contradictedBy")) or None,
    }


def parse_decision(text: str) -> dict | None:
    """Turn the model's raw text into a HighlightDecision-shaped dict, or None.

    ADAAAA-6358 (I1): the reply may now carry a reviewer-facing rationale —
    ``reasoning`` (independent-observation-first analysis), a structured
    ``verdict`` (hypothesis / what was observed / goal criteria / what
    contradicted it) and ``evidenceAttested`` (grounded evidence items). All
    three are OPTIONAL in the model reply and defaulted here, so a
    pre-I1 / legacy-shaped reply still parses cleanly with empty rationale."""
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
    event_type = obj.get("eventType")
    if not isinstance(event_type, str):
        event_type = str(event_type) if event_type is not None else None
    reason = obj.get("reason")
    if not isinstance(reason, str):
        reason = str(reason) if reason is not None else None
    return {
        "isHighlight": is_hl,
        "score": score,
        "eventType": event_type,
        "reason": reason,
        # I1 reviewer-facing rationale (always present so the API response shape
        # is stable whether or not the model populated them).
        "reasoning": _as_text(obj.get("reasoning")),
        "verdict": _normalize_verdict(obj.get("verdict")),
        "evidenceAttested": _as_str_list(obj.get("evidenceAttested")),
        "source": "gemma",
    }


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


def apply_ball_outcome_gate(evidence: Optional[dict]) -> tuple[bool, str | None]:
    """Decide-leg I2 (ADAAAA-6359) HARD GATE over the perceived goal-line
    ground-truth signal.

    Returns (ok, reason). ok is True when no `ballOutcome` is present (no
    calibration / no signal — never gates) or when it is `goal`. When
    `ballOutcome` is present and is anything other than `goal` (off_target /
    blocked / no_shot / cross), the measured ball did not enter the goal, so
    the clip must be rejected regardless of any other verdict. This is a hard
    gate applied deterministically in the /highlight route, not just a prompt
    instruction.
    """
    outcome = (evidence or {}).get("ballOutcome")
    if not outcome:
        return True, None
    if outcome == "goal":
        return True, None
    return False, f"perceived ballOutcome={outcome} (not a goal); hard-gate rejection"


def _asr_url() -> str | None:
    """The cheap ASR endpoint for Path 2 (ADAAAA-6314). Unset => transcription is
    skipped and the decide prompt runs text-only (no regression vs today)."""
    u = os.environ.get("ASR_URL", "").strip()
    return u or None


def transcribe_audio(
    url: str,
    audio_b64: str,
    sample_rate: int = 16000,
    timeout_s: float = 20.0,
) -> tuple[str, float]:
    """Transcribe a mono WAV (base64, e.g. 16 kHz 16-bit PCM) to text via the ASR
    endpoint (Path 2). Returns (text, elapsed_seconds). Any failure returns
    ("", elapsed) so the decide path still runs text-only and never dies on an
    ASR glitch.

    Contract (newly introduced by this task): POST {url}/transcribe with JSON
    ``{"audio": "<wav base64>", "sample_rate": 16000}`` -> ``{"text": "..."}``.
    Kept tiny so any cheap ASR (faster-whisper server, hosted endpoint) can
    serve it; it never runs the gemma GPU for audio."""
    import time

    import httpx

    if not audio_b64:
        return "", 0.0
    t0 = time.monotonic()
    text = ""
    try:
        resp = httpx.post(
            url.rstrip("/") + "/transcribe",
            json={"audio": audio_b64, "sample_rate": sample_rate},
            timeout=timeout_s,
        )
        resp.raise_for_status()
        data = resp.json()
        text = (data.get("text") or data.get("transcript") or "").strip()
    except Exception:
        text = ""
    return text, round(time.monotonic() - t0, 4)


def build_prompt(
    event_type: str,
    evidence: dict,
    game_hint: str = "",
    n_frames: int = 1,
    has_audio: bool = False,
    transcript: str = "",
) -> str:
    ev = event_type.upper()
    meta = [
        f"candidate event type: {ev}",
        f"game hint: {game_hint or 'unspecified'}",
        f"track count: {evidence.get('trackCount', 0)}",
        f"max tracked velocity: {evidence.get('maxVelocity', 0):.2f}",
        f"ocr hits: {evidence.get('ocrHits', 0)}",
        f"scoreboard score change observed during window: {'yes' if evidence.get('scoreBoardChanged') else 'no'}",
        f"frames shown (1 FPS temporal window): {n_frames}",
        f"audio provided (commentary/crowd): {'yes' if has_audio else 'no'}",
    ]
    # Decide-leg I2 (ADAAAA-6359): the perceived goal-line / ball-outcome
    # ground-truth signal. When present it is decisive: a non-"goal" outcome
    # (off_target / blocked / no_shot / cross) means the ball did NOT enter the
    # goal, so the clip must be rejected. Absent == no ground-truth signal, no
    # gate (no regression).
    outcome = evidence.get("ballOutcome")
    crossed = evidence.get("goalCrossed")
    if outcome:
        meta.append(
            f"goal-line ground-truth (perceive homography): ballOutcome={outcome}"
            + (f", goalCrossed={crossed}" if crossed is not None else "")
        )
    else:
        meta.append("goal-line ground-truth (perceive homography): not available")
    reaction_lines = _reaction_summary(evidence)
    transcript = (transcript or "").strip()
    if reaction_lines or transcript:
        meta.append("people-reaction evidence:")
        meta.extend("  " + ln for ln in reaction_lines)
        # Path 2 (ADAAAA-6314): the audio window transcribed to text so Gemma can
        # read what the commentary/crowd is actually *saying* around the trigger,
        # not just how loud it is. Bounded to keep the prompt lean.
        if transcript:
            meta.append("audio commentary transcript (ASR):")
            meta.append("  " + transcript[:500])
    return (
        "You are a sports/esports highlight judge. You are shown a temporal "
        "SEQUENCE of frames (extracted at 1 FPS from the moment of a detected "
        "candidate event) plus the context images, and, when available, the "
        "accompanying audio.\n"
        "The candidate event type given in the context is a HYPOTHESIS to test, "
        "NOT a fact. It was produced by an upstream detector and is often wrong "
        "(a near-miss, an off-target shot, a warm-up or lull, or a booking gets "
        "mislabeled as a GOAL / KILL). Your job is to verify it, not to "
        "confirm it. NEVER assume the hypothesis is true.\n"
        "Reason in two passes, in this exact order:\n"
        "  PASS 1 — INDEPENDENT OBSERVATION (do this FIRST, before considering "
        "the hypothesis): describe only what you can actually SEE and HEAR in "
        "the frames + audio. State the player(s), the ball, where the ball is "
        "relative to the goal line / net / posts, the scoreboard, and the "
        "people's reaction. Do not use the candidate type to colour this pass.\n"
        "  PASS 2 — HYPOTHESIS TEST: compare your independent observation to the "
        "candidate type. Does the evidence actually support it, or is there a "
        "simpler explanation?\n"
        "When people are visible, EXPLICITLY describe their reaction and weigh it "
        "as evidence: players with arms raised, a group pile/team huddle, "
        "bench/dugout leaping up to celebrate, or the crowd/commentary erupting. "
        "Reaction is corroborating evidence only - cite it, but decide on your "
        "full read of the frames, audio, and context; never let reaction alone "
        "override a clear read of the play.\n"
        "For soccer (game hint contains 'soccer'), the candidate is a GOAL and "
        "the clip is a highlight ONLY if you can verify a goal was actually "
        "scored. Explicit goal criteria - verify each against the frames/audio, "
        "and mark a criterion false when the ball plainly did NOT enter the net "
        "or a goal was plainly NOT scored, and leave it null (unverifiable) when "
        "you cannot tell:\n"
        "- ballCrossedLineBetweenPosts: you plainly see the ball cross the goal "
        "line between the uprights;\n"
        "- ballInNet: the ball is in the net / the net ripples / the keeper is "
        "beaten and the ball ends in the goal;\n"
        "- scoreboardChanged: the scoreboard / score readout changes to reflect "
        "a goal;\n"
        "- crowdErupted: the crowd/commentary erupts consistent with a goal.\n"
        "A GOAL counts as verified (isHighlight=true) only when the required "
        "ball criteria (ballCrossedLineBetweenPosts AND ballInNet) are true, with "
        "the reaction criteria consistent. Do NOT flag a soccer clip as a "
        "highlight when it shows:\n"
        "- a yellow card, red card, booking, foul, tackle, or any disciplinary "
        "incident (referee showing a card, players confronting, a player sent "
        "off);\n"
        "- a free kick, corner, shot on target, save, miss, near-miss, off-target, "
        "blocked shot, or any chance in which the ball does NOT enter the net;\n"
        "- only open play, build-up, players running, warm-ups, or a celebration "
        "with no ball in the net.\n"
        "When a required goal criterion is UNVERIFIABLE (you cannot confirm the "
        "ball crossed the line / is in the net) or is EXPLICITLY CONTRADICTED by "
        "what you see (e.g. you see the ball hit the post, go over the bar, be "
        "saved, or the clip is warm-ups/lull with no strike), you MUST return "
        "isHighlight=false and name the contradicting evidence in `reason` and in "
        "verdict.contradictedBy. NEVER infer a goal from the candidate event "
        "type, from players celebrating, or from crowd/commentary alone.\n"
        "HARD GATE — perceived goal-line ground truth: when the context reports a "
        "`ballOutcome` (goal-line ground-truth from perceive's homography), it is "
        "a decisive measurement of whether the ball entered the goal. If "
        "`ballOutcome` is present and is anything other than `goal` (i.e. "
        "`off_target`, `blocked`, `no_shot`, or `cross`), the ball did NOT enter "
        "the net and you MUST return isHighlight=false and state that the "
        "measured ballOutcome contradicts the goal. Treat `ballOutcome=goal` as "
        "strong confirmation but still verify visually. A missing/absent "
        "`ballOutcome` is NOT a rejection signal — decide on the frames/audio as "
        "normal.\n"
        "Scoreboard evidence: when the context reports a scoreboard score change "
        "observed during the candidate window, that is independent confirmation of "
        "a goal — treat it as strong evidence for isHighlight=true (combined with "
        "the ball crossing the line). When no scoreboard change is reported, treat "
        "that as weak/absent evidence and NEVER let its absence alone force or block "
        "a goal verdict.\n"
        "Context:\n- " + "\n- ".join(meta) + "\n\n"
        "Now answer with ONLY one JSON object, no markdown, no preamble, no "
        "leading/trailing prose, exactly of this shape:\n"
        "{\"isHighlight\": true|false, \"score\": 0..100, \"eventType\": \"<type>\", "
        "\"reason\": \"<short grounded reason that names the deciding evidence>\", "
        "\"reasoning\": \"<2-4 sentences: what you independently observed FIRST, then "
        "how that tests the hypothesis>\", "
        "\"verdict\": {\"hypothesis\": \"<the candidate type you were testing>\", "
        "\"independentlyObserved\": \"<what you actually saw, stated before the "
        "hypothesis>\", \"criteria\": {\"ballCrossedLineBetweenPosts\": true|false|null, "
        "\"ballInNet\": true|false|null, \"scoreboardChanged\": true|false|null, "
        "\"crowdErupted\": true|false|null}, \"contradictedBy\": \"<the evidence that "
        "contradicts the hypothesis, or the null when it does not>\"}, "
        "\"evidenceAttested\": [\"<each concrete piece of grounded evidence you relied on>\"]}"
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
    transcript: str = "",
) -> dict | None:
    """Call llama-server multimodal completion. Returns a parsed/validated
    HighlightDecision dict, or None on any transport/parse failure.

    Follows the Gemma 4 12B video+audio modality-order guidance: all image
    content (temporal frame sequence + crops) comes BEFORE the text prompt,
    and any audio comes AFTER the text. Audio is mono 16 kHz float32 (wav)."""
    import httpx

    frames = frames or []
    images = images or []

    # Raw audio bytes are gated OFF by default. Path 1 feasibility (re-verified
    # on the box for ADAAAA-6314, 2026-10-03): llama.cpp build 10920 ACCEPTS the
    # `input_audio` content block (HTTP 200, no 400) — the earlier ADAAAA-5979
    # "content type rejected" conclusion was against the stale `audio_url` type,
    # NOT the current `input_audio` schema the Gemma 4 omni GGUF uses. But the
    # deployed `gemma-4-12b-it-qat-q4_0` is text/vision-only: given `input_audio`
    # it answers "I am a text-based AI ... cannot transcribe audio", so it does
    # NOT actually ingest the audio. So raw send stays OFF by default and audio
    # context is delivered as TEXT (Path 2 transcript). Once the omni
    # unsloth/gemma-4-12b-it-GGUF (audio-capable) is served, flip
    # GEMMA_SEND_AUDIO=1 to use the native `input_audio` path.
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
            "text": build_prompt(
                event_type,
                evidence,
                game_hint,
                n_frames=len(frames),
                has_audio=bool(send_audio or transcript),
                transcript=transcript,
            ),
        }
    )
    # 3) audio AFTER the text (modality-order rule) — only when the raw-send gate
    # is on. By default (Path 2) the audio context is delivered as TEXT
    # (transcript) instead, because the deployed QAT model is not audio-capable.
    # The content block uses the current OpenAI `input_audio` schema (not the
    # stale `audio_url`) per the Gemma 4 omni GGUF card (unsloth/gemma-4-12b-it-GGUF);
    # build 10920 accepts this block (verified HTTP 200 on the box).
    if send_audio:
        content.append(
            {
                "type": "input_audio",
                "input_audio": {"data": audio_b64, "format": "wav"},
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
    score_board_changed: bool = False,
) -> dict:
    """Primary path: Gemma. On any failure, deterministic rule fallback so the
    caller always gets a valid HighlightDecision.

    ADAAAA-6314 Path 2: when the caller supplied audio for a trigger-passing
    candidate and the raw path is off (gemma cannot ingest audio), transcribe
    the window to text and inject it into the prompt. Bounded to candidates that
    carry audio (never every frame); an ASR glitch degrades to text-only, never
    kills the verdict. The per-call audio-context cost/latency is reported on the
    decision as ``audioContext``."""
    u = url or os.environ.get("GEMMA_URL", DEFAULT_GEMMA_URL)
    # Path 2 transcription (see module docstring): only when audio is present AND
    # we are not sending raw bytes AND audio context is enabled AND an ASR
    # endpoint is configured.
    transcript = ""
    asr_latency_s = 0.0
    asr_ran = False
    if (
        audio_b64
        and not (os.environ.get("GEMMA_SEND_AUDIO", "0") == "1")
        and os.environ.get("AUDIO_CONTEXT", "1") == "1"
    ):
        asr_url = _asr_url()
        if asr_url:
            transcript, asr_latency_s = transcribe_audio(asr_url, audio_b64, audio_sample_rate)
            asr_ran = True
    g = ask(
        u,
        event_type,
        evidence,
        game_hint,
        images,
        frames,
        audio_b64,
        audio_sample_rate,
        reasoning_effort=reasoning_effort,
        transcript=transcript,
    )
    if g is not None:
        result = g
    else:
        # fallback: deterministic rule (passes the reaction block so the
        # notable-only corroboration check is consistent with the Gemma path)
        d = decide(
            event_type,
            track_count=evidence.get("trackCount", 0),
            max_velocity=evidence.get("maxVelocity", 0),
            ocr_hits=evidence.get("ocrHits", 0),
            reaction=evidence.get("reaction"),
            score_board_changed=score_board_changed,
        )
        result = {
            "isHighlight": d.is_highlight,
            "score": d.score,
            "eventType": event_type,
            "reason": d.reason,
            "source": "rule-fallback",
        }
    # Per-highlight audio-context cost/latency readout. `path` reports which
    # audio channel the model actually received: native `input_audio` when raw
    # send is on (GEMMA_SEND_AUDIO=1, ADAAAA-6350), else the ASR->text
    # transcript (Path 2), else "none" when no audio context entered the call.
    send_audio_active = bool(audio_b64) and os.environ.get("GEMMA_SEND_AUDIO", "0") == "1"
    result["audioContext"] = {
        "path": "input_audio" if send_audio_active else ("asr_text" if asr_ran else "none"),
        "transcribed": bool(transcript),
        "asrRan": asr_ran,
        "asrLatencyS": asr_latency_s,
    }
    return result

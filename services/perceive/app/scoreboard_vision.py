"""Vision-LLM scoreboard visibility + OCR (ADAAAA-7084, design follow-up to 7081).

ADAAAA-7081 scoped the scoreboard ``<OCR>`` pass to a fixed geometric ROI
(``PERCEIVE_SCOREBOARD_ROI``). QA (ADAAAA-7082) confirmed that kills the
false-positive class, but flagged that recall is calibration-dependent: a source
whose scorebug sits OUTSIDE the default ROI is cropped out, so a real score
change never fires ``scoreBoardChanged``.

This module lets the vision LLM (the same OpenAI-compatible
``/v1/chat/completions`` endpoint the decide ``planner``/``gemma`` use) do two
things that remove the per-source calibration dependency:

1. **Gate** the scoreboard OCR pass with an explicit *"is a scoreboard visible
   in this frame?"* assessment. When it answers no, the OCR pass is skipped so
   crowd / banner / ad-board text can never be read as a score.
2. **Locate + supply the OCR** for the scoreboard region. When visible it
   returns a normalized bounding box for the scoreboard graphic (the caller
   crops ``<OCR>`` to that box) and may also return the score text it read
   (used as a fallback when the cropped Florence ``<OCR>`` read comes back
   empty, e.g. a faint scorebug Florence can't parse but the LLM can).

The existing false-positive protections are preserved as the FINAL gate: the
score still only ever comes from :func:`app.scoreboard.parse_ocr_score` (the
score-line regex, colon/clock exclusion, absurd-value cap) and a delta still
only ever comes from the two-concrete-readings :class:`ScoreboardTracker`. A
hallucinated box therefore degrades to "no clean score line" -> ``None`` score
-> no false delta, exactly as a bad crop does today. Nothing here raises into
the frame / candidate path; every transport / parse failure degrades to
``None`` (the caller then runs the ADAAAA-7081 fixed-ROI path, so a vision-LLM
outage never costs the signal the ROI would have caught).

Opt-in: :func:`enabled` is driven by ``PERCEIVE_SCOREBOARD_LLM`` (default off),
mirroring the ``PERCEIVE_ROI_ENABLED`` handoff pattern, so the live per-
candidate GPU cost is unchanged until an operator flips it on per box.

Pure helpers + a best-effort network call (injectable ``post``) so the parse,
box/score normalization and degrade-on-failure contract are unit-testable with
no GPU and no network.
"""
from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Sequence, Tuple

log = logging.getLogger("highlights.perceive.scoreboard_vision")

# --- Configuration -----------------------------------------------------------
_ENABLE_ENV = "PERCEIVE_SCOREBOARD_LLM"  # "1"/"true"/"on" enables the vision gate
_URL_ENV = "PERCEIVE_SCOREBOARD_LLM_URL"  # endpoint override
_TIMEOUT_ENV = "PERCEIVE_SCOREBOARD_LLM_TIMEOUT_S"
# Endpoint default chain (same as the decide planner): an explicit override,
# then the planner/gemma URLs the box already sets, then the local vLLM port.
_DEFAULT_URL = "http://127.0.0.1:8088"
_DEFAULT_TIMEOUT_S = 5.0  # bounded so a vision-LLM stall never eats the live budget
_MAX_SCORE_LINE_CHARS = 64  # a scoreboard score read is short; cap the fallback
_SCORE_SEPARATORS = re.compile(r"[-–—:]\s*\d")  # sanity: at least one "N - M"/"N:M"


def enabled() -> bool:
    """Whether the vision-LLM scoreboard gate is on for this process.

    Default OFF (opt-in handoff), so the live per-candidate GPU cost is
    unchanged until an operator sets ``PERCEIVE_SCOREBOARD_LLM=1``.
    """
    return os.environ.get(_ENABLE_ENV, "0").strip().lower() in ("1", "true", "on", "yes")


def _url(url: Optional[str]) -> str:
    return (
        url
        or os.environ.get(_URL_ENV, "").strip()
        or os.environ.get("PLANNER_URL", "").strip()
        or os.environ.get("GEMMA_URL", "").strip()
        or _DEFAULT_URL
    )


def _timeout_s(timeout_s: Optional[float]) -> float:
    if timeout_s is not None and timeout_s > 0:
        return float(timeout_s)
    try:
        return max(1.0, float(os.environ.get(_TIMEOUT_ENV, _DEFAULT_TIMEOUT_S)))
    except (TypeError, ValueError):
        return _DEFAULT_TIMEOUT_S


@dataclass(frozen=True)
class ScoreboardVerdict:
    """The vision LLM's reading of one frame, normalized.

    ``visible`` — the LLM's "scoreboard visible?" gate. ``box`` — the normalized
    ``(x0, y0, x1, y1)`` scoreboard graphic region (``None`` when it could not
    localize; the caller then falls back to the configured ROI). ``score_text``
    — the raw score string the LLM read (``None`` when absent); the caller runs
    it through :func:`app.scoreboard.parse_ocr_score` before it may become a
    score. ``source`` / ``notes`` — provenance for the audit trail.
    """

    visible: bool
    box: Optional[Tuple[float, float, float, float]] = None
    score_text: Optional[str] = None
    source: str = "vision-llm"
    notes: str = field(default="", compare=False)


# --- Prompt ------------------------------------------------------------------
_PROMPT = (
    "You are a sports-broadcast scoreboard detector. Look carefully at the "
    "attached frame and decide whether an on-screen SCOREBOARD (a score bug, "
    "score line, or score readout showing the current score of the match) is "
    "actually visible.\n"
    "\n"
    "Respond ONLY with a single JSON object — no prose, no markdown fences:\n"
    '{\n  "scoreboardVisible": true | false,\n  "box": [x0, y0, x1, y1] | null,\n'
    '  "score": "2 - 1" | null\n}\n'
    "\n"
    "Field rules:\n"
    "- scoreboardVisible: true ONLY if a scoreboard / score bug / score readout "
    "is clearly visible. Set false for plain play with no score graphic.\n"
    "- box: when scoreboardVisible is true, the normalized bounding box "
    "[x0, y0, x1, y1] of the scoreboard graphic, each value 0.0..1.0 with "
    "x0 < x1 and y0 < y1. Use null if you cannot localize it.\n"
    "- score: when you can read the current score off the scoreboard, the score "
    "text (e.g. \"2 - 1\"). Use null when you cannot read it.\n"
    "If no scoreboard is visible, return "
    '{"scoreboardVisible": false, "box": null, "score": null}.'
)


# --- Parsing -----------------------------------------------------------------
def _strip_json_fence(text: str) -> str:
    """Strip ```json ... ``` fences and surrounding prose, keeping the first
    JSON object body."""
    if not text:
        return ""
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        return m.group(1).strip()
    return text.strip()


def _first_json(s: str) -> str:
    start = s.find("{")
    end = s.rfind("}")
    if start != -1 and end != -1 and end > start:
        return s[start : end + 1]
    return s


def _normalize_box(raw) -> Optional[Tuple[float, float, float, float]]:
    """Coerce a raw LLM box to a valid normalized ``(x0, y0, x1, y1)``, or
    ``None``. Never raises: a non-list, wrong arity, non-numeric, out-of-range
    or degenerate box all yield ``None`` so the caller falls back to the ROI."""
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    try:
        x0, y0, x1, y1 = (float(v) for v in raw)
    except (TypeError, ValueError):
        return None
    if not (0.0 <= x0 < x1 <= 1.0 and 0.0 <= y0 < y1 <= 1.0):
        return None
    return (x0, y0, x1, y1)


def _normalize_score_text(raw) -> Optional[str]:
    """Keep a plausible score string from the LLM, else ``None``.

    Only a short string that contains at least one digit-separated-by-a-score-
    separator ("N - M" / "N:M") is kept; anything else (prose, team names only,
    a bare number) is dropped so it can never be mistaken for a score. The
    :func:`app.scoreboard.parse_ocr_score` gate is the final word — this is just
    a cheap pre-filter so an obvious non-score string never even reaches it.
    """
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        raw = str(raw)
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text or len(text) > _MAX_SCORE_LINE_CHARS:
        return None
    if not _SCORE_SEPARATORS.search(text):
        return None
    return text


def parse_scoreboard_verdict(text: str) -> Optional[ScoreboardVerdict]:
    """Parse the vision LLM's reply into a :class:`ScoreboardVerdict`.

    Returns ``None`` (the degrade signal) when the reply is absent, is not JSON,
    or lacks a boolean ``scoreboardVisible``. A JSON object that parses but has
    a malformed box / score still yields a verdict — the bad fields are
    normalized to ``None`` so the caller degrades gracefully (visible-but-no-
    box -> ROI fallback; no score -> the ``<OCR>`` read must supply the score).
    Never raises.
    """
    if not text or not text.strip():
        return None
    candidate = _strip_json_fence(text)
    try:
        obj = json.loads(_first_json(candidate))
    except (json.JSONDecodeError, ValueError):
        # Try the raw (non-fenced) text once more before giving up.
        try:
            obj = json.loads(_first_json(text))
        except (json.JSONDecodeError, ValueError):
            return None
    if not isinstance(obj, dict):
        return None
    visible_raw = obj.get("scoreboardVisible")
    if isinstance(visible_raw, str):
        visible = visible_raw.strip().lower() in ("true", "yes", "1")
    elif isinstance(visible_raw, bool):
        visible = visible_raw
    else:
        return None  # no usable visibility verdict -> degrade to the ROI path
    box = _normalize_box(obj.get("box"))
    score_text = _normalize_score_text(obj.get("score"))
    return ScoreboardVerdict(visible=visible, box=box, score_text=score_text)


# --- Network call (best-effort, injectable transport) ------------------------
def build_scoreboard_prompt() -> str:
    """The single-shot scoreboard prompt (the exact output contract)."""
    return _PROMPT


def vision_scoreboard(
    image_b64: str,
    url: Optional[str] = None,
    timeout_s: Optional[float] = None,
    post: Optional[Callable[[str, dict, float], "httpx.Response"]] = None,
) -> Optional[ScoreboardVerdict]:
    """Ask the vision LLM whether a scoreboard is visible and read it.

    ``image_b64`` is the current frame as a base64 JPEG (the same frame the
    ``<OCR>`` pass reads). ``post`` is an injectable transport
    ``(url, payload, timeout_s) -> response`` so the call is unit-testable with
    no network; when omitted it uses ``httpx`` (already a perceive dependency,
    used by the trickle client).

    Returns a :class:`ScoreboardVerdict`, or ``None`` on ANY failure
    (unreachable model, timeout, non-JSON reply, missing visibility field) so
    the caller degrades to the ADAAAA-7081 fixed-ROI path. Never raises into
    the frame / candidate path — a vision-LLM outage must never drop a frame or
    a candidate, and it must never cost the signal the ROI would have caught.
    """
    if not image_b64:
        return None
    endpoint = _url(url).rstrip("/") + "/v1/chat/completions"
    timeout = _timeout_s(timeout_s)
    payload = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                    },
                    {"type": "text", "text": _PROMPT},
                ],
            }
        ],
        "temperature": 0.0,
        "reasoning_effort": "none",
        "max_tokens": 512,
        "stream": False,
    }
    model = os.environ.get("GEMMA_MODEL")
    if model:
        payload["model"] = model
    do_post = post
    if do_post is None:
        import httpx  # local import: keeps the module importable without it

        do_post = lambda u, p, t: httpx.post(u, json=p, timeout=t)
    try:
        resp = do_post(endpoint, payload, timeout)
        body = resp.read() if hasattr(resp, "read") else None
        if body is None:
            body = getattr(resp, "content", b"")
        data = json.loads(body or b"{}")
    except Exception as e:  # noqa: BLE001 - any transport/parse failure degrades
        log.info("scoreboard vision call failed url=%s: %s", endpoint, e)
        return None
    # OpenAI-compatible shape: choices[0].message.content.
    try:
        text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError, AttributeError):
        log.info("scoreboard vision reply had no choices[0].message.content")
        return None
    verdict = parse_scoreboard_verdict(text)
    if verdict is None:
        log.info("scoreboard vision reply unparsable: %r", str(text)[:120])
    return verdict

"""Gemma 12B (vLLM OpenAI-compat server) integration for the decide step.

Activates when DECIDE_MODE=gemma and GEMMA_URL points at an OpenAI-compatible
/ vLLM `chat/completions` server serving cyankiwi/gemma-4-12B-it-qat-AWQ-INT4
(ADAAAA-6695; this replaced the llama.cpp llama-server + mmproj). Sends the
ContextSnapshot + up to a few JPEGs (full frame + track crops) as a multimodal
chat request and asks for a strict JSON HighlightDecision. Parses + validates
the reply; on any failure falls back to the deterministic rule so the pipeline
never dies on a model glitch (plan §9: health must not flap, a bad Gemma reply
must not kill the job).

ADAAAA-6358 (I1): the decide prompt is de-anchored. The candidate event type
is framed as a *hypothesis to test*, not a fact, and the model must (a) first
state what it independently observes, (b) check the explicit goal criteria
(ball crossed the goal line between the posts / ball in net / scoreboard
changed / crowd erupted), and (c) return isHighlight=false when a required
criterion is unverifiable or explicitly contradicted. The response carries a
structured `verdict` + `evidenceAttested` (plus the independent `reasoning`)
so a reviewer can see *why* the decision was made, grounded in the evidence.

ADAAAA-6543 (ADAAAA-6538 pivot_vlm_judgment): the goal-line / homography
corroboration is de-emphasized from a hard accept gate to OPTIONAL
corroboration. A real goal is judged directly from the frames + the
audio-noise trigger, and an absent `ballOutcome`/line-crossing (no field
homography configured, or the instant not captured at the sampled frame) is
NOT a rejection by itself. Rejection is reserved for frames that EXPLICITLY
CONTRADICT a goal (ball did not enter the net). The deterministic
`apply_ball_outcome_gate`/`apply_gate` post-processing still only ever gates
on *present* measured evidence, never on its absence (see ADAAAA-6533 root
cause: 0 accepted highlights because every live candidate carried no
homography and the prompt conservatively rejected).
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import math
import os
import pathlib
import re
import time
from typing import Optional

from .decider import decide
from .match_context_prompt import (
    match_context_rule,
    render_match_context_block,
    sanitize_match_context,
)

log = logging.getLogger("highlights.decide.gemma")

DEFAULT_GEMMA_URL = "http://127.0.0.1:8088"

# --- ASR transcript quality guard (ADAAAA-7665) ------------------------------
# Whisper emits a canonical set of STOCK phrases when it transcribes silence or a
# ~100 ms fragment: "What?", "Go!", "Oh", "Bye.", "You", "Okay.", "And",
# "Thank you very much.", "Yes, yes, yes, yes…". Production stored exactly those
# and the decide prompt then fed the model `audio commentary transcript: What?`.
# Treat filler/punctuation as EMPTY so a silent window keeps the honest
# `audio.path = "none"` semantics (ADAAAA-7248/7277) instead of a fake one.
MIN_TRANSCRIPT_WORDS = 3
ASR_HALLUCINATION_SET = frozenset(
    {
        "", "what", "go", "oh", "bye", "you", "and", "okay", "ok", "yes", "no",
        "hmm", "mm", "ah", "uh", "thanks", "thank you", "thank you very much",
        "you know", "bye bye", "yes yes yes", "no no no", "please subscribe",
    }
)


def usable_transcript(text: str) -> str:
    """Return ``text`` when it reads like real commentary, else ``""``.

    ADAAAA-7665 quality guard: a transcript that is only punctuation, shorter
    than ``MIN_TRANSCRIPT_WORDS`` words, a single repeated token, or one of
    whisper's canonical silence hallucinations carries no information and must
    never enter the decide prompt as "audio commentary transcript".
    """
    t = (text or "").strip()
    if not t:
        return ""
    # Strip punctuation so "What?" / "Bye." / ". . . . . . ." normalize to words.
    norm = re.sub(r"[^\w\s']", " ", t.lower(), flags=re.UNICODE)
    norm = re.sub(r"\s+", " ", norm).strip()
    if not norm:
        return ""
    if norm in ASR_HALLUCINATION_SET:
        return ""
    words = norm.split(" ")
    if len(words) < MIN_TRANSCRIPT_WORDS:
        return ""
    # "Yes, yes, yes, yes" — one token repeated is filler, not commentary.
    if len(set(words)) == 1:
        return ""
    return t

# --- decide audit (ADAAAA-7027 / ADAAAA-7028) ---------------------------------
# Versioned system prompt so an audit record can re-create the EXACT request the
# model saw. Additive relative to the pre-audit user-only request: the current
# user prompt text (build_prompt / build_group_prompt) is preserved unchanged.
#
# v2 (ADAAAA-7993): the system turn now carries SYSTEM_PROMPT + STATIC_PREAMBLE +
# STATIC_CONTRACT so the static judge text is a reusable prefix; the user turn
# carries only the per-window Context block behind the frames. v1 = SYSTEM_PROMPT
# only (1.08% measured prefix-cache hit rate, ADAAAA-7979).
# v3 (ADAAAA-8103, ruling R26 of ADAAAA-8047 rev 8 §7): the window's measured
# evidence (perceive timeline, ASR, audio-noise curve, detection geometry, match
# context, prior game state) carries the judgement and the shipped frames
# CORROBORATE it. Same wire layout as v2 (only the static text moves), so a
# prefix-cache warm read cannot fake a verdict delta.
SYSTEM_PROMPT_VERSION = "3"
SYSTEM_PROMPT = (
    "You are a video highlight review agent in a sports broadcast pipeline. "
    "You will be given a candidate event and a sequence of frames (and possibly "
    "audio context). Follow the user's instructions exactly and respond ONLY with "
    "the requested strict JSON. Do not add commentary, markdown fences, or any "
    "text outside the JSON object."
)


def _audit_sha256(b64: str) -> str:
    """Content-addressed SHA-256 for a base64 media part (used as the media ref)."""
    if not b64:
        return ""
    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception:  # noqa: BLE001
        return hashlib.sha256(b64.encode("utf-8")).hexdigest()
    return hashlib.sha256(raw).hexdigest()


def _content_ref(part: dict) -> dict | None:
    """For an image-content part, return a compact ref {sha256, mime, dataUrl}
    without duplicating the base64 bytes in the record (they live in the audit
    dir / blobs, addressable by sha256)."""
    b64 = part.get("base64") or part.get("image") or ""
    if not b64:
        return None
    return {
        "sha256": _audit_sha256(b64),
        "mime": "image/jpeg",
        "dataUrl": f"data:image/jpeg;base64,{b64}",
    }


def _messages(
    mode: str,
    content: list,
    *,
    with_system: bool = True,
    system_content: str | None = None,
) -> list:
    """The ordered message array actually sent to gemma: optional system slot
    (role=system) then the single user message carrying the multimodal content.

    ``system_content`` overrides the bare SYSTEM_PROMPT — the v2 single-shot
    decide path passes SYSTEM_PROMPT + STATIC_PREAMBLE + STATIC_CONTRACT
    (ADAAAA-7993). Group mode keeps the user-only shape (``with_system=False``)."""
    msgs: list = []
    if with_system:
        msgs.append(
            {
                "role": "system",
                "content": SYSTEM_PROMPT if system_content is None else system_content,
            }
        )
    msgs.append({"role": "user", "content": content})
    return msgs


def _prompt_layout(parts: dict) -> dict:
    """ADAAAA-7993: the layout descriptor stored on a v2 audit record. It carries
    the full system content and the field order, so replaying a record
    (``rebuild_payload``) reproduces the exact ``messages`` the model saw and an
    operator can tell a v2 (hoisted) request from a v1 (flat) one."""
    return {
        "version": "v2",
        "system": {
            "fields": ["systemPrompt", "staticPreamble", "staticContract"],
            "contract": "compact" if parts.get("compact") else "full",
            "chars": len(parts["system"]),
            "content": parts["system"],
        },
        "userText": parts["context"],
        "modalityOrder": ["images", "text", "audio"],
        "staticPrefixChars": len(parts["preamble"]) + len(parts["contract"]),
    }


# --- ADAAAA-8395 (LFR-1 AC-4): the per-decide token meter -------------------
# The vLLM/llama.cpp OpenAI-compatible reply carries a `usage` block
# (`prompt_tokens` / `completion_tokens` / `total_tokens`). The decide path used
# to read ONLY `choices[0].message.content` and drop it, so the LFR-1 640:360
# cell's AC-4 (per-decide token parity) could not be graded at all — nothing was
# stored. These helpers carry the block into the audit record's `timings` JSON
# (an existing column, no migration) as ADDITIVE keys, and mark a missing block
# `usageSource: "absent"` instead of zero-filling it: a persisted 0 would grade
# as token parity and turn a missing measurement into a pass (IN-4).
_USAGE_SOURCE_PRESENT = "vllm"
_USAGE_SOURCE_ABSENT = "absent"


def _usage_int(v: object) -> int | None:
    """A non-negative int from a usage counter, else None (never a guess)."""
    try:
        n = int(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def usage_fields(reply: object) -> dict:
    """The additive `usage` / `usageSource` audit keys for one gemma reply.

    `{"usage": {prompt_tokens, completion_tokens, total_tokens}, "usageSource": "vllm"}`
    when the upstream answered with a well-formed block, else
    `{"usageSource": "absent"}`. Only a block whose `prompt_tokens` is a positive
    int is accepted — a block that is present but unreadable is treated as
    absent rather than half-recorded. Nothing else on the reply is read
    differently, so the verdict path is byte-identical.
    """
    if not isinstance(reply, dict):
        return {"usageSource": _USAGE_SOURCE_ABSENT}
    raw = reply.get("usage")
    if not isinstance(raw, dict):
        return {"usageSource": _USAGE_SOURCE_ABSENT}
    prompt_tokens = _usage_int(raw.get("prompt_tokens"))
    completion_tokens = _usage_int(raw.get("completion_tokens"))
    if prompt_tokens is None or completion_tokens is None or prompt_tokens <= 0:
        return {"usageSource": _USAGE_SOURCE_ABSENT}
    total_tokens = _usage_int(raw.get("total_tokens"))
    if total_tokens is None or total_tokens < prompt_tokens:
        total_tokens = prompt_tokens + completion_tokens
    return {
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
        },
        "usageSource": _USAGE_SOURCE_PRESENT,
    }


def _audit_record(
    *,
    audit_ctx: dict | None,
    mode: str,
    content: list,
    payload: dict,
    raw_reply: str,
    parsed: object,
    fallback: bool,
    started_at: float,
    asr_latency_s: float = 0.0,
    prompt_layout: dict | None = None,
    timings_extra: dict | None = None,
) -> dict:
    """Assemble the audit record for one gemma decide call. Content images are
    represented by content refs (sha256 + data url) so the record stays compact
    while still being able to re-attach the exact bytes. Include group identity
    (sessionId/jobId/groupKey) verbatim from audit_ctx when the caller passes it."""
    ctx = audit_ctx or {}
    # ordered multimodal refs for the user content
    refs: list = []
    for part in content:
        if part.get("type") == "image_url":
            ref = _content_ref({"base64": part["image_url"]["url"].split(",", 1)[1] if "," in part["image_url"]["url"] else ""})
            refs.append({"type": "image", **ref} if ref else {"type": "image"})
        elif part.get("type") == "input_audio":
            refs.append({"type": "audio", "format": part.get("input_audio", {}).get("format", "wav")})
        elif part.get("type") == "text":
            refs.append({"type": "text", "text": part["text"]})
    params = {k: v for k, v in payload.items() if k != "messages"}
    return {
        "version": 1,
        "systemPromptVersion": SYSTEM_PROMPT_VERSION,
        "promptLayout": prompt_layout,
        "mode": mode,
        "groupId": ctx.get("groupKey") or ctx.get("groupId") or None,
        "groupKey": ctx.get("groupKey") or None,
        "sessionId": ctx.get("sessionId") or None,
        "jobId": ctx.get("jobId") or None,
        "frameCount": ctx.get("frameCount"),
        "candidateCount": ctx.get("candidateCount"),
        "candidates": ctx.get("candidates"),
        "messages": payload.get("messages", []),
        "contentRefs": refs,
        "params": params,
        "rawReply": raw_reply,
        "parsed": parsed,
        "fallback": bool(fallback),
        "timings": {
            "elapsedMs": round((time.time() - started_at) * 1000.0, 3),
            "asrLatencyS": asr_latency_s,
            # ADAAAA-8056 (AC-E1/AC-E2): per-window coverage ledgers. They live on
            # `timings` (an existing JSON column on decide_audit) so they need no
            # schema migration and are queryable per decide row. Merged here, at
            # record-build time, so the record written to DECIDE_AUDIT_DIR carries
            # them — stamping them later onto the response descriptor only reached
            # the server's decide_audit row and left the on-disk trail bare.
            **(timings_extra or {}),
        },
        "createdAt": round(time.time(), 3),
    }


def _emit_audit(record: dict) -> None:
    """Append one audit record as a JSONL line to DECIDE_AUDIT_DIR (if set).
    Side-effect-free: never raises, never fails a decide call. When the env is
    unset this is a no-op (existing behaviour unchanged)."""
    d = os.environ.get("DECIDE_AUDIT_DIR")
    if not d:
        return
    try:
        path = pathlib.Path(d) / "decide-audit.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except Exception as e:  # noqa: BLE001
        log.warning("decide audit write failed (ignored): %s", e)


def load_audit_records(path: str | None = None) -> list:
    """Read back every audit record from DECIDE_AUDIT_DIR/decide-audit.jsonl."""
    d = path or os.environ.get("DECIDE_AUDIT_DIR")
    if not d:
        return []
    f = pathlib.Path(d) / "decide-audit.jsonl"
    if not f.exists():
        return []
    recs: list = []
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            recs.append(json.loads(line))
        except Exception:  # noqa: BLE001
            continue
    return recs


def _audit_descriptor(record: dict) -> dict | None:
    """Compact audit descriptor emitted on the decide response so the server can
    index it (ADAAAA-7028 Increment 2). Unlike the full record written to
    DECIDE_AUDIT_DIR, this strips the base64 image bytes (which stay in the
    audit dir / blobs, addressable by sha256) and keeps only what the server
    index + decision-trail needs: group identity, prompt text, media content
    hashes, model params, raw reply, parsed verdicts, timings, fallback flag.
    Returns None when the record carries no messages/params (not replayable)."""
    msgs = record.get("messages", [])
    texts: list[str] = []
    for m in msgs:
        if isinstance(m.get("content"), str):
            texts.append(m["content"])
        elif isinstance(m.get("content"), list):
            for part in m["content"]:
                if isinstance(part, dict) and part.get("type") == "text":
                    texts.append(part.get("text", ""))
    media: list[dict] = []
    for r in record.get("contentRefs", []):
        if r.get("type") == "image":
            media.append({"type": "image", "sha256": r.get("sha256"), "mime": r.get("mime", "image/jpeg")})
        elif r.get("type") == "audio":
            media.append({"type": "audio", "format": r.get("format", "wav")})
    if not msgs:
        return None
    parsed = record.get("parsed")
    verdicts = dict(parsed) if isinstance(parsed, dict) else parsed
    return {
        "version": record.get("version", 1),
        "systemPromptVersion": record.get("systemPromptVersion"),
        "mode": record.get("mode"),
        "sessionId": record.get("sessionId"),
        "jobId": record.get("jobId"),
        "groupKey": record.get("groupKey") or record.get("groupId"),
        "frameCount": record.get("frameCount"),
        "candidateCount": record.get("candidateCount"),
        "promptText": "\n".join(t for t in texts if t) or None,
        "mediaHashes": media,
        "params": record.get("params"),
        "rawReply": record.get("rawReply"),
        "verdicts": verdicts,
        "timings": record.get("timings"),
        "fallback": bool(record.get("fallback")),
        "replayable": True,
        "createdAt": record.get("createdAt"),
    }


def rebuild_payload(record: dict) -> dict:
    """Rebuild the exact chat/completions payload from an audit record (for
    replay). The record stores the verbatim messages + params, so this is a
    faithful reconstruction that byte-matches the original request (which is
    what the acceptance control assertion checks)."""
    return dict(record.get("params", {}) | {"messages": record.get("messages", [])})



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

# Outcome taxonomy (plan §4.9C / increment F, ADAAAA-6465): the analysis
# call's outcome is no longer a binary highlight/no-highlight read but a small
# closed set the model MUST pick from. A near miss is NOT a scoring play but
# can be notable — it surfaces at a lower score, labeled distinctly.
OUTCOME_TAXONOMY = (
    "scoring_play",  # frames show the ball/object crossing/converting (goal, TD, dunk, kill)
    "near_miss",  # frames show a close call (post, save at the line, denial at the net) — NOT a scoring play
    "big_play",  # non-scoring but clearly high-value (big save, big hit, clutch denial)
    "not_highlight",  # nothing notable in the window
)


def normalize_outcome(value, *, is_highlight: bool | None = None) -> str:
    """Coerce an arbitrary model ``outcome`` value to a valid taxonomy member.

    Defaults to ``not_highlight`` when absent/garbage. The ``is_highlight``
    argument is accepted for backward compatibility only; surfacing is decided
    by `outcome_is_highlight` (ADAAAA-6598: ONLY `scoring_play` is a
    board-accepted goal highlight; a near_miss/big_play read is never a score).
    """
    v = value if isinstance(value, str) else ""
    v = v.strip().lower()
    if v not in OUTCOME_TAXONOMY:
        v = "not_highlight"
    return v


def outcome_is_highlight(outcome: str) -> bool:
    """Whether an outcome taxonomy member is a board-accepted GOAL highlight.

    ONLY ``scoring_play`` (a frame-confirmed goal/score) is accepted as a
    scoring highlight on the board. ``near_miss`` and ``big_play`` are notable
    but are NOT a score — they must never surface as a scoring highlight
    (ADAAAA-6598: the spurious GOAL list was full of near_miss/big_play reads
    whose own reason said the ball did NOT enter the net). A near-miss /
    big-play may be recorded distinctly (outcome/nearMiss preserved on the
    decision) but is gated out of the accepted set by the caller.
    """
    return outcome == "scoring_play"


# ADAAAA-8325 (Inc 2): FOOTAGE PHASE — did this window show live action, or a
# replay of earlier action (broadcast replay, slow-motion repeat, a replay bug /
# logo overlay)? This is ADDITIVE metadata beside `outcome`, never a change to
# the outcome ladder: a replay is still judged on its own footage, and the
# standing rule that a replay is never a `scoring_play` stays exactly as it is.
# The server uses the signal only as CORROBORATION for attaching a replay window
# to the moment it repeats; it may never create an attach on its own.
PHASE_TAXONOMY = (
    "live",  # footage of the action as it happened
    "replay",  # footage repeating earlier action (broadcast replay / slow-mo / replay bug)
)


def normalize_phase(value) -> str | None:
    """Coerce an arbitrary model ``phase`` value to a valid taxonomy member.

    Absent, non-string or garbage becomes ``None`` — an UNKNOWN phase stays
    unknown. It must never default to ``"live"``: defaulting would let an
    unreadable reply assert live footage it never observed (AC8).
    """
    v = value.strip().lower() if isinstance(value, str) else ""
    if v in PHASE_TAXONOMY:
        return v
    return None


# ADAAAA-6855: map job-requested highlight labels (preferLabels) to the outcome
# taxonomy members they authorize for export. A requested non-goal class may be
# exported as a DISTINCT highlight (outcome/eventType preserved, never relabeled
# as a goal) even though it is not a scoring play. The map is conservative — it
# never widens goal acceptance — and it mirrors the server-side map in
# services/server/src/analyzer.ts (keep the two in sync).
NON_GOAL_LABEL_OUTCOMES: dict[str, frozenset[str]] = {
    "goals": frozenset({"scoring_play"}),
    "near-misses": frozenset({"near_miss"}),
    "saves": frozenset({"near_miss", "big_play"}),
    "red cards": frozenset({"big_play"}),
    "counter-attacks": frozenset({"big_play"}),
}


def normalize_prefer_label(label) -> str:
    return (label or "").strip().lower()


def event_type_for_outcome(outcome: str | None, fallback: str = "") -> str:
    """ADAAAA-6969: derive the TRUE public ``eventType`` label from the outcome
    taxonomy member.

    A non-scoring highlight (``near_miss`` / ``big_play``) must never be
    published as ``GOAL`` — the label reflects the outcome class (``NEAR_MISS`` /
    ``BIG_PLAY``), so a keeper save / near-miss surfaces as a distinct non-goal
    highlight. A frame-confirmed ``scoring_play`` stays ``GOAL``. Any other /
    unknown outcome defers to ``fallback`` (the candidate/model label).

    Kept in sync with the server-side ``eventTypeForOutcome`` in
    ``services/server/src/analyzer.ts`` (ADAAAA-6969) so the public label and
    the decide-note always agree.
    """
    if outcome == "scoring_play":
        return "GOAL"
    if outcome == "near_miss":
        return "NEAR_MISS"
    if outcome == "big_play":
        return "BIG_PLAY"
    return fallback


def requested_outcomes(prefer_labels) -> set[str]:
    """The outcome taxonomy members the job's preferLabels authorize for export.
    Empty set when no labels are requested, which preserves the default
    scoring-only gate (backward compatible)."""
    out: set[str] = set()
    for lab in prefer_labels or []:
        norm = normalize_prefer_label(lab)
        if norm in NON_GOAL_LABEL_OUTCOMES:
            out |= NON_GOAL_LABEL_OUTCOMES[norm]
    return out


def _rule_outcome(d) -> str:
    """Map a deterministic rule decision to the outcome taxonomy member so the
    fallback path returns the same shape as the Gemma path (increment F). The
    rule is a score/threshold classifier, so a highlight maps to scoring_play or
    big_play (we can't distinguish near_miss without the frames) and a non-
    highlight maps to not_highlight. ``d`` is the decider return (has
    ``is_highlight``)."""
    try:
        hl = bool(getattr(d, "is_highlight", False))
    except Exception:  # noqa: BLE001
        hl = bool(d) if isinstance(d, (bool, int)) else False
    return "scoring_play" if hl else "not_highlight"


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


# ---------------------------------------------------------------------------
# Running video summary (ADAAAA-7111, Increment D)
# ---------------------------------------------------------------------------
# The decide/gemma brain maintains an incrementally updated RUNNING summary of
# the video so far (story-so-far), carried across cadence observe ticks. It is
# forwarded into each request (`storySoFar`) and the model returns the updated
# one (`runningSummary`), which the server persists + surfaces in the job
# detail. The summary must GROW monotonically but stay BOUNDED, hence the
# two helpers below.
# ADAAAA-7418: raised 600 -> 2000 so long-video timelog entries stop getting
# cut off. Only the cap value changes; grow-then-compact semantics stay.
MAX_RUNNING_SUMMARY_CHARS = 2000


def _compile_summary(summary: str) -> str:
    """Bound a running summary to MAX_RUNNING_SUMMARY_CHARS, dropping the OLDEST
    lines first so the newest detail survives (grow-then-compact: monotonic up
    to the cap, then the oldest events are pruned). Never raises; an empty/None
    input yields ''. This is the single place the bounded-size acceptance
    criterion is enforced."""
    summary = (summary or "").strip()
    if not summary:
        return ""
    if len(summary) <= MAX_RUNNING_SUMMARY_CHARS:
        return summary
    lines = summary.split("\n")
    while lines and len("\n".join(lines)) > MAX_RUNNING_SUMMARY_CHARS:
        lines.pop(0)
    if not lines:
        # A single over-cap line (no newlines to prune): truncate the tail.
        return summary[:MAX_RUNNING_SUMMARY_CHARS]
    out = "\n".join(lines)
    if len(out) > MAX_RUNNING_SUMMARY_CHARS:
        out = out[:MAX_RUNNING_SUMMARY_CHARS]
    return out


def _rule_summary(story_so_far: str, outcome: str, event_type: str, reason: str | None) -> str:
    """Deterministic running summary for the rule/no-gemma path. Extends the
    prior story-so-far with a compact chronological line for this window and
    bounds the total size via {@link _compile_summary}, so the summary grows
    monotonically up to the cap then compacts. Mirrors the contiguous
    story-so-far semantics the Gemma path produces."""
    prior = (story_so_far or "").strip()
    line = f"[{outcome or 'not_highlight'}] {event_type}"
    if reason:
        line += f" — {reason[:120]}"
    return _compile_summary((prior + "\n" + line) if prior else line)



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
    # Increment F / ADAAAA-6465: outcome taxonomy. Parse + reconcile so a
    # model that says outcome=near_miss can never come back as a scored
    # scoring_play. ADAAAA-6598: ONLY a frame-confirmed scoring_play is a
    # board-accepted GOAL highlight — a near_miss / big_play / not_highlight
    # read NEVER surfaces as a scoring highlight, even when the model (or a
    # later gate) set isHighlight=true, because the taxonomy is the
    # authoritative frame read and IS the accept gate here.
    raw_outcome = obj.get("outcome")
    if raw_outcome is None:
        # Legacy/absent -> derive from the verdict, never overrule it.
        outcome = "scoring_play" if is_hl else "not_highlight"
    else:
        outcome = normalize_outcome(raw_outcome)
        # The taxonomy member is the frame read and governs acceptance: only
        # scoring_play is a board highlight; near_miss/big_play/not_highlight
        # are rejected as scoring highlights regardless of the model's
        # isHighlight field (which is where the spurious GOALs came from).
        is_hl = outcome_is_highlight(outcome)
    return {
        "isHighlight": is_hl,
        "score": score,
        "eventType": event_type,
        "reason": reason,
        # Increment F / ADAAAA-6465: outcome taxonomy member (always present;
        # defaults to not_highlight). near_miss is notable but NOT a scoring
        # play — surfaced at a lower score, labeled distinctly below.
        "outcome": outcome,
        # ADAAAA-8325 (Inc 2): the footage phase, normalized exactly like
        # `outcome` BUT with no default — an absent/malformed phase stays None
        # (unknown), never "live". Additive metadata; the outcome ladder above is
        # untouched.
        "phase": normalize_phase(obj.get("phase")),
        "nearMiss": outcome == "near_miss",
        # I1 reviewer-facing rationale (always present so the API response shape
        # is stable whether or not the model populated them).
        "reasoning": _as_text(obj.get("reasoning")),
        "verdict": _normalize_verdict(obj.get("verdict")),
        "evidenceAttested": _as_str_list(obj.get("evidenceAttested")),
        # ADAAAA-7111 (Increment D): the running video summary the model updated
        # for this window. Bound on write (see _compile_summary in the caller).
        "runningSummary": _as_text(obj.get("runningSummary")),
        # ADAAAA-8318: the clip card's copy target (a short post title). Same
        # reply as runningSummary — no second inference. Bounded at the server
        # write seam (shape + v9 grounding, deterministic fallback on refusal);
        # carried here so the audit capture shows what the model actually said.
        "postTitle": _as_text(obj.get("postTitle")),
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


# --- goal-verification attestation gate (ADAAAA-6610 / ADAAAA-6588 crit 2/3) ---
#
# The accept path trusts the model's self-reported `outcome` (scoring_play-only
# gate). The model CONFABULATES templated `scoring_play` on non-goal frames, so
# a GOAL accept whose reason is bare boilerplate AND which carries NO
# independent, *measured* goal criterion (perceive `ballOutcome=goal` /
# `goalCrossed` / a scoreboard score change) is a templated false positive and
# is REJECTED. This is deliberately narrow, preserving ADAAAA-6533 / ADAAAA-6543
# (which kept a goal accept alive on the ABSENCE of a homography so recall must
# NOT collapse): we only gate on a goal that is BOTH templated-reason AND
# unattested — never on a specific, frame-grounded reason, and never on a goal
# an independent criterion actually attested.
GOAL_CRITERION_OUTCOME = "goal"

# Independent, measured goal criteria. Only perceive's measured signals count —
# NEVER the model's self-reported verdict/criteria fields, because that is
# precisely the confabulation this gate defends against.
def attested_goal_criterion(evidence: Optional[dict]) -> bool:
    e = evidence or {}
    return (
        (e.get("ballOutcome") or "") == GOAL_CRITERION_OUTCOME
        or e.get("goalCrossed") is True
        or bool(e.get("scoreBoardChanged"))
    )


# Detected templated-reason markers (ADAAAA-6610). The model reaches for the
# same boilerplate regardless of the actual frames: a net-entry phrase AND a
# crowd/celebration phrase together. Exact-substring matching was too brittle —
# the model varies the verb ("enter / enters / entering / entered", "cross /
# crosses / crossing") and a broadcast false positive was accepted as a goal
# because "The ball is seen ENTERING the net..." escaped the "enters the net"
# literal (ADAAAA-6610 E2E, VOD t=73). Matching is verb-stem regex so the whole
# confabulated-family is caught, while the gate still only ever REJECTS when the
# reason is templated AND nothing is attested (so a specific, frame-grounded goal
# reason with an attested criterion, or a genuinely specific description, is
# never caught by this heuristic).
_TEMPLATED_NET_RE = re.compile(
    r"\b(?:enter|enters|entering|entered)\s+the\s+(?:back\s+of\s+the\s+)?net\b"
    r"|\b(?:ball\s+)?(?:cross|crosses|crossing|crossed)\s+the\s+(?:goal\s+)?line\b",
    re.IGNORECASE,
)
_TEMPLATED_REACTION_RE = re.compile(
    r"crowd/players|the crowd and players|players erupt|celebrat|reacting with|erupt",
    re.IGNORECASE,
)


def is_bare_templated_reason(reason: Optional[str]) -> bool:
    """True when the reason is the model's bare boilerplate goal template (a
    net-entry phrase combined with a crowd/celebration phrase) rather than a
    specific, frame-grounded description. Empty/None is never templated."""
    if not reason:
        return False
    r = reason
    net = bool(_TEMPLATED_NET_RE.search(r))
    reaction = bool(_TEMPLATED_REACTION_RE.search(r))
    return net and reaction


def is_goal_accept(decision: dict, event_type: Optional[str] = None) -> bool:
    """Whether the decision is an ACCEPTED goal: the model surfaced it
    (isHighlight true) for a goal event, or — when the candidate carries no
    event type at all — for a scoring_play outcome. The gate is scoped to goal
    events so a scoring_play outcome in another sport (a DUNK scoring play) is
    never caught by goal verification."""
    if not decision.get("isHighlight"):
        return False
    evt = str(event_type or "").upper().strip()
    if evt in ("GOAL", "GOL"):
        return True
    if not evt:
        return str(decision.get("outcome") or "").strip().lower() == "scoring_play"
    return False


def _confirm_pass_enabled() -> bool:
    """Whether the Stage-2 confirmation pass (ADAAAA-6797) is on for this
    deployment. Mirrors ``confirm.confirm_enabled`` without a circular import
    (confirm.py imports from gemma.py)."""
    return os.environ.get("DECIDE_CONFIRM_ENABLED", "0") == "1"


def apply_goal_attestation_gate(
    decision: dict, evidence: Optional[dict], event_type: Optional[str] = None
) -> tuple[bool, str | None]:
    """Deterministic post-gate over the *model's* accept (ADAAAA-6610).

    Returns (ok, reason). An ACCEPTED goal is allowed ONLY when an independent,
    *measured* goal criterion is present (perceive ballOutcome=goal /
    goalCrossed / scoreboard score change). The model's self-reported reason —
    whether templated OR a "specific" description — is NEVER sufficient on its
    own, because the E2E proved the model confabulates both (a specific
    "ball clearly seen inside the net, goalkeeper beaten" reason was produced on
    an open-play / keeper-has-the-ball frame with no goal). Template enumeration
    cannot be exhaustive, so the only trustworthy gate over the model's accept is
    the independent attestation.

    ADAAAA-6973 (Option 1): when the Stage-2 confirmation pass is ENABLED
    (``DECIDE_CONFIRM_ENABLED=1``), defer the attestation to the confirm
    deep-frame dive instead of hard-rejecting here. An accepted goal-type
    candidate that carries no independent attestation PASSES so the server's
    ``shouldRunConfirm`` fires and ``/confirm`` becomes the attestation
    (``goalConfirmed=confirmed_goal`` → accept; ``near_miss``/``not_goal`` →
    reject). The anti-confabulation property moves to the verifier stage rather
    than being dropped. When the confirmation pass is OFF (live / flag-off
    path), keep the strict reject so the model alone is never trusted — the
    pre-existing behavior is byte-for-byte preserved.
    """
    if not is_goal_accept(decision, event_type):
        return True, None
    if attested_goal_criterion(evidence):
        return True, None
    if _confirm_pass_enabled():
        # Defer to the Stage-2 confirm deep-frame dive (goal attestation at the
        # verifier stage); the candidate is a Stage-1 scoring_play accept.
        return True, None
    return False, (
        "no attested goal criterion (ballOutcome=goal / goalCrossed / "
        "scoreboard change); model reason alone is not sufficient to accept a goal"
    )


# --- scoring_play contract guard (ADAAAA-8120 / ADAAAA-8101 AC-E3) ----------
#
# The v3 decide-emphasis A/B (ADAAAA-8103) proved a contract hole that NEITHER
# prompt arm closes: a warm-up / commentary-lull window whose frames read
# `not_highlight` on their own, but whose commentary text is replaced by a goal
# shout, is accepted as `scoring_play` by 8 of 8 calls at both prompt versions
# and both output contracts (`contradictedBy: null` throughout). More emphasis
# text in the prompt is not the fix — a deterministic check on the ACCEPT path
# is.
#
# This guard compares the MEASURED goal attestation the model was actually given
# (perceive-timeline records, ball / goal-line geometry, scoreboard reads) with
# the claim the decision made (a goal-type `scoring_play` accept whose support is
# commentary text). It fires ONLY when the claim is text and the measurement
# that would have to support it is absent or explicitly refuting:
#
#   goal_text_without_measurement : the window's ASR transcript carries a goal
#       shout (and/or the reason cites the commentary), and NO measured channel
#       attests the goal (ballOutcome != goal, no goalCrossed, no scoreboard
#       change, no timeline goal flag, no goal-line geometry crossed).
#   perceive_timeline_not_goal : the window's own perceive timeline reads a
#       non-goal ball outcome (off_target / blocked / no_shot / cross) on every
#       decisive record, with no goal flag anywhere in the window.
#   ball_before_goal_line : measured geometry puts the ball before the goal line
#       (`goalLineDelta` < 0) with no other measured attestation.
#
# The guard is deliberately INERT in every other case, so the audited contract
# does not move:
#   - `isHighlight=false` and `null` are never touched (`null` = unverifiable,
#     and the wire verdict keeps its tri-state criteria — the guard never turns
#     an unverifiable read into a rejection);
#   - an accept that no measured channel attests AND that carries no goal-text
#     claim is left to the existing anti-fabrication gate (ADAAAA-6610), which
#     owns that class; the guard records `outcome="inert"` and does nothing;
#   - when the Stage-2 confirm pass is enabled (ADAAAA-6973) a rejection still
#     leaves the decision goal-shaped + un-attested, so the server's confirm
#     deep-frame dive runs for it (`isGateRejectedBareGoal`) and can re-attest a
#     genuine goal — the guard records `stage2ConfirmEligible` rather than
#     silently passing the accept.
#
# Everything the guard decides is recorded on the decision (`contractGuard`) and
# merged into the decide audit row's `timings.contractGuard`, so a stored job can
# be re-graded without a replay (ADAAAA-8120 AC-G5).
CONTRACT_GUARD_VERSION = "1"
CONTRACT_GUARD_SCORE_CAP = 55.0

# A goal shout in the commentary transcript. Noun/verb family only — a bare
# "shot"/"save" is a play report, not a goal claim.
_GOAL_SHOUT_RE = re.compile(
    r"\b(?:it'?s in|goal(?:!|\b)|gooo+a+l|scored?|scores|scoring|what a finish"
    r"|in the net|into the net|level(?:s|led)? it|equaliser|equalizer"
    r"|winner|back of the net)\b",
    re.IGNORECASE,
)
# A goal-SPECIFIC claim: ball-in-net / goal-line language. This is narrower than
# the shout family above, which also matches "scores"/"scored" that a non-goal
# scoring play (a DUNK) legitimately uses. Only this narrower claim puts an
# accept whose candidate label is NOT goal-type (the live AUDIO_BURST trigger)
# into the guard's scope — a warm-up window whose reason says "ball in net" is a
# goal claim whatever trigger produced the window.
_GOAL_NET_CLAIM_RE = re.compile(
    r"\b(?:in the net|into the net|back of the net|goal ?line|cross(?:ed|es)? the line"
    r"|it'?s in|is in the net)\b",
    re.IGNORECASE,
)
# A score line in the text ("2-1 to the away side"). A claim about the scoreboard
# is a claim only a measured score read can attest.
_SCORE_LINE_RE = re.compile(r"\b\d{1,2}\s*[-–:]\s*\d{1,2}\b")
# The decision citing the commentary ASR as its basis (vs a measured signal).
_COMMENTARY_CITATION_RE = re.compile(
    r"\b(?:asr|commentary|commentator|transcript|shout|audio confirms)\b",
    re.IGNORECASE,
)
_NON_GOAL_BALL_OUTCOMES = ("off_target", "blocked", "no_shot", "cross")


def _num(value) -> float | None:
    """A finite float from a wire value, or None (bools are never numbers here)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    v = float(value)
    return v if v == v and abs(v) != float("inf") else None


def measured_goal_attestation(evidence: Optional[dict], perceive_window: object = None) -> dict:
    """The MEASURED goal attestation this window carries (ADAAAA-8120).

    Computed only from evidence the model was already given — perceive-timeline
    records, ball / goal-line geometry, scoreboard reads — NEVER from the
    model's self-reported verdict/criteria (that self-report is precisely what
    the ADAAAA-8103 contradiction case confabulated). Deterministic and
    side-effect free.

    Returns ``{attested, signals, channels, missing, timeline..., audio...}``:
    `attested` is True when at least one measured channel attests a goal, and
    `missing` names every measured channel the window did NOT carry (the audit
    trail a reviewer reads when the guard fires).
    """
    e = evidence if isinstance(evidence, dict) else {}
    signals: list[str] = []
    missing: list[str] = []

    ball_outcome = str(e.get("ballOutcome") or "").strip().lower()
    if ball_outcome == GOAL_CRITERION_OUTCOME:
        signals.append("ballOutcome=goal")
    elif not ball_outcome:
        missing.append("ballOutcome")

    if e.get("goalCrossed") is True:
        signals.append("goalCrossed=true")
    elif e.get("goalCrossed") is not False:
        missing.append("goalCrossed")

    if e.get("scoreBoardChanged") is True:
        signals.append("scoreBoardChanged=true")
    else:
        missing.append("scoreBoardChanged")

    gld = _num(e.get("goalLineDelta"))
    if gld is not None and gld >= 0 and abs(gld) > 0:
        signals.append(f"goalLineDelta={gld:.2f}>=0")

    recs = [r for r in (e.get("perceiveTimeline") or []) if isinstance(r, dict)]
    goal_reads = 0
    non_goal_reads = 0
    non_goal_examples: list[str] = []
    for r in recs:
        bo = str(r.get("ballOutcome") or "").strip().lower()
        ts = _num(r.get("ts"))
        if bo == GOAL_CRITERION_OUTCOME:
            goal_reads += 1
            signals.append("timeline:ballOutcome=goal")
        elif bo in _NON_GOAL_BALL_OUTCOMES:
            non_goal_reads += 1
            if len(non_goal_examples) < 3:
                non_goal_examples.append(f"{bo}@{ts if ts is not None else '?'}s")
        if r.get("ballInNet") is True:
            signals.append("timeline:ballInNet=true")
        if r.get("goalCrossed") is True:
            signals.append("timeline:goalCrossed=true")
        if r.get("scoreBoardChanged") is True:
            signals.append("timeline:score_delta")
    if not recs:
        missing.append("perceiveTimeline")

    levels = [v for v in (e.get("audioLevels") or []) if _num(v) is not None]
    # The audio curve is a TRIGGER channel, never goal attestation (a roar also
    # accompanies a near-miss) — it is recorded for the audit trail only.
    audio_peak = round(max(float(v) for v in levels), 3) if levels else None

    return {
        "attested": bool(signals),
        "signals": list(dict.fromkeys(signals)),
        "missing": missing,
        "timelineRecords": len(recs),
        "timelineGoalReads": goal_reads,
        "timelineNonGoalReads": non_goal_reads,
        "timelineNonGoalExamples": non_goal_examples,
        "scoreReads": int(e.get("ocrHits") or 0),
        "audioSamples": len(levels),
        "audioPeak": audio_peak,
        "goalLineDelta": gld,
        # The candidate event type / warp hint the model was testing. Kept on the
        # record so a re-grade can see the hypothesis the accept was for.
        "eventType": (perceive_window or {}).get("eventType") if isinstance(perceive_window, dict) else None,
    }


def goal_text_claim(decision: dict, transcript: str = "") -> dict:
    """The commentary-text goal claim a decision made (ADAAAA-8120).

    `transcript_goal_shout` is a goal shout in the window's own ASR text;
    `reason_cites_commentary` is the decision naming the commentary/ASR as its
    basis; `score_line_claim` is a score line ("2-1") in either. A claim made
    only from vision (no text at all) leaves ``text_bits`` empty — the guard is
    inert on that class and leaves it to the anti-fabrication gate.
    """
    t = (transcript or "").strip()
    reason = " ".join(
        str(decision.get(k) or "") for k in ("reason", "reasoning")
    ).strip()
    attested = [a for a in (decision.get("evidenceAttested") or []) if isinstance(a, str)]
    attested_text = " ".join(attested)
    text_bits: list[str] = []
    if t and _GOAL_SHOUT_RE.search(t):
        text_bits.append("transcript_goal_shout")
    cites = bool(_COMMENTARY_CITATION_RE.search(reason)) or (
        bool(attested) and all(_COMMENTARY_CITATION_RE.search(a) for a in attested)
    )
    if reason and cites and _GOAL_SHOUT_RE.search(reason + " " + attested_text):
        text_bits.append("reason_cites_commentary")
    score_line = bool(_SCORE_LINE_RE.search(t)) or bool(_SCORE_LINE_RE.search(reason))
    goal_specific = bool(
        _GOAL_NET_CLAIM_RE.search(reason + " " + attested_text)
        or _GOAL_NET_CLAIM_RE.search(t)
    )
    return {
        "transcript_goal_shout": "transcript_goal_shout" in text_bits,
        "reason_cites_commentary": "reason_cites_commentary" in text_bits,
        "score_line_claim": score_line,
        "goal_specific_claim": goal_specific,
        "text_bits": text_bits,
        "transcript": t[:160] or None,
    }


def apply_contract_guard(
    decision: dict,
    evidence: Optional[dict] = None,
    event_type: Optional[str] = None,
    transcript: str = "",
    perceive_window: object = None,
) -> tuple[dict, dict]:
    """Reject a goal-type `scoring_play` accept that commentary text alone carries.

    Mutates ``decision`` (forces ``isHighlight=false``, caps the score, appends
    the contradicting evidence to ``reason``, stamps ``contradictedBy`` +
    ``contractGuard``) and returns ``(decision, guard_record)``. A no-op on
    everything outside its narrow scope, so `isHighlight=false`/`null` reads, a
    genuinely absent-but-plausible accept, and the confirm-enabled posture are
    all untouched. See the section comment above for the rules.
    """
    record: dict = {
        "version": CONTRACT_GUARD_VERSION,
        "outcome": "inert",
        "contradictedBy": None,
        "claim": None,
        "attestation": measured_goal_attestation(evidence, perceive_window),
        "refutingEvidence": [],
        "detail": None,
    }
    if decision.get("isHighlight") is not True:
        # `false` and `null` are never touched: null == unverifiable, not a
        # rejection (audited contract; ADAAAA-8120 binding constraint).
        record["outcome"] = "not_an_accept"
        return decision, record
    claim = goal_text_claim(decision, transcript)
    # Scope: a goal-type accept (decision/candidate label), OR a scoring_play
    # accept whose own reason/transcript makes a goal-SPECIFIC claim — the live
    # rail's candidate label is a trigger (AUDIO_BURST / SPORTING_EVENT / MOTION),
    # so the goal class lives on the accept's claim, not on the trigger label.
    if not is_goal_accept(decision, event_type) and not (
        str(decision.get("outcome") or "").strip().lower() == "scoring_play"
        and claim["goal_specific_claim"]
    ):
        record["outcome"] = "not_a_goal_accept"
        return decision, record

    att = record["attestation"]
    if att["attested"]:
        record["outcome"] = "attested"
        # Stamp the record on an accepted decision too, so a stored job's
        # decide_audit row shows WHICH measured channel attested it (AC-G5).
        decision["contractGuard"] = record
        return decision, record

    record["claim"] = claim
    # Recall path (ADAAAA-6973): a guard rejection leaves the decision
    # goal-shaped and un-attested (outcome scoring_play / GOAL label,
    # isHighlight=false), which is exactly the server's Stage-2 confirm
    # population (`isGateRejectedBareGoal` in analyzer.ts). The confirm deep-frame
    # dive still runs and can re-attest a genuine goal, so rejecting here does
    # NOT drop the confirm rescue — unlike a silent Stage-A pass, it records the
    # contradiction the dive has to overturn.
    if _confirm_pass_enabled():
        record["stage2ConfirmEligible"] = True

    code: str | None = None
    refuting: list[str] = []
    missing = ", ".join(att["missing"]) or "none"
    if claim["text_bits"]:
        code = "goal_text_without_measurement"
        bits = " + ".join(claim["text_bits"])
        refuting.append(
            f"the accept's support is commentary text only ({bits}) and no measured "
            f"channel attests the goal (absent: {missing})"
        )
        if claim["score_line_claim"]:
            refuting.append(
                "the text claims a score line but no scoreboard read / score_delta "
                "record carries it"
            )
    elif att["timelineRecords"] and att["timelineNonGoalReads"] and not att["timelineGoalReads"]:
        code = "perceive_timeline_not_goal"
        refuting.append(
            "the window's own perceive timeline reads a non-goal ball outcome on every "
            f"decisive record ({', '.join(att['timelineNonGoalExamples'])}) and carries "
            "no goal flag"
        )
    elif att["goalLineDelta"] is not None and att["goalLineDelta"] < 0:
        code = "ball_before_goal_line"
        refuting.append(
            f"measured goal-line geometry puts the ball before the line "
            f"(goalLineDelta={att['goalLineDelta']:.2f}) and no other measured channel attests a goal"
        )
    if code is None:
        # Evidence genuinely absent-but-plausible and no text claim: leave the
        # decision exactly as the model read it (never turn null/absent into false).
        record["outcome"] = "unverifiable_evidence"
        decision["contractGuard"] = record
        return decision, record

    detail = "; ".join(refuting)
    record.update(
        {
            "outcome": "rejected",
            "contradictedBy": code,
            "refutingEvidence": refuting,
            "detail": f"{code}: {detail}",
        }
    )
    decision["isHighlight"] = False
    try:
        score = float(decision.get("score") or 0.0)
    except (TypeError, ValueError):
        score = 0.0
    if score > CONTRACT_GUARD_SCORE_CAP:
        decision["score"] = CONTRACT_GUARD_SCORE_CAP
    decision["contradictedBy"] = record["detail"]
    decision["reason"] = (
        (decision.get("reason") or "") + "; rejected by contract guard: " + detail
    ).strip("; ")
    decision["contractGuard"] = record
    return decision, record


# --- near-miss reconciliation (ADAAAA-6481 / §8 near_miss_recall) ----------
#
# A goal-bound shot that does NOT convert is a NEAR-MISS, not a non-event:
# the deployed plan should be able to act on it. The perceived goal-line /
# ball-outcome signal is the deterministic ground truth for this: `blocked`
# (shot stopped at the line within the mouth) and `off_target` (a shot on
# goal that missed) both mean the ball was genuinely threatening the goal but
# did not score. Those must surface as `near_miss` — never as `scoring_play`
# (keeps near_miss_vs_scoring_confusion == 0) and never dismissed as
# `not_highlight` (that is the recall gap the §8 near_miss_recall metric
# measures).
NEAR_MISS_BALL_OUTCOMES: tuple[str, ...] = ("blocked", "off_target")


def is_near_miss_ball_outcome(ball_outcome: Optional[str]) -> bool:
    """True when the perceived goal-line signal records a goal-bound shot that
    did NOT convert — a genuine near-miss (blocked/saved at the line, or an
    on-goal shot that missed). Never True for `goal`, `no_shot`, `cross`, or
    when the signal is absent."""
    return (ball_outcome or "") in NEAR_MISS_BALL_OUTCOMES


def reconcile_outcome_with_ball_signal(decision: dict, ball_outcome: Optional[str]) -> dict:
    """Deterministically set the near-miss verdict from the goal-line signal
    (ADAAAA-6481). When `ball_outcome` is a near-miss class the verdict is
    `near_miss` regardless of the model's read (Gemma often dismisses a
    near-goal as `not_highlight`); it is NEVER `scoring_play` (the ball did
    not go in). ADAAAA-6598: a near-miss is recorded DISTINCTLY (outcome /
    nearMiss preserved) but is NOT a board-accepted GOAL highlight, so
    `isHighlight` is forced to False — it must never surface as a score on
    the board. Mutates and returns `decision`.

    Only acts when the signal is a near-miss class; otherwise `decision` is
    returned unchanged (no regression for goals / no-signal / non-events)."""
    if not is_near_miss_ball_outcome(ball_outcome):
        return decision
    decision["outcome"] = "near_miss"
    decision["nearMiss"] = True
    # A near-miss is notable and recorded distinctly, but is NEVER accepted as
    # a scoring/GOAL highlight on the board (ADAAAA-6598).
    decision["isHighlight"] = False
    try:
        sc = float(decision.get("score") or 0.0)
    except (TypeError, ValueError):
        sc = 0.0
    if sc >= 60.0:
        decision["score"] = 55.0
    decision["reason"] = (
        (decision.get("reason") or "")
        + "; goal-line signal: goal-bound shot did not convert (near-miss)"
    ).strip("; ")
    # ADAAAA-6969: the outcome was forced to near_miss, so the public label
    # MUST reflect that class — never leave a stale candidate/model "GOAL".
    decision["eventType"] = event_type_for_outcome("near_miss", decision.get("eventType") or "")
    return decision


# ADAAAA-7135 (criteria 6): celebration-only GOAL false-positive guard.
# When the model accepts a GOAL at a near-max confidence but reports the
# ball-in-net instant as NOT observed (ballInNet AND ballCrossedLineBetweenPosts
# both non-true) while the crowd/celebration IS observed (crowdErupted true),
# the accept is celebration-driven — the ball never demonstrably entered the
# net — so it must not surface as a scoring highlight. Narrow and deliberate: a
# real goal whose ball-in-net instant IS observed (either criterion true) is
# never caught, and a lower-confidence / non-celebration read is untouched
# (this deliberately does NOT re-enter the removed "both ball criteria must be
# true" gate — see test_gemma.py test_build_prompt_does_not_require_ball_criteria).
CELEBRATION_ONLY_SCORE_FLOOR = 90.0
CELEBRATION_ONLY_SCORE_CAP = 55.0


def apply_celebration_only_guard(decision: dict) -> dict:
    """ADAAAA-7135 criteria 6: reject a near-max-score GOAL accepted on
    crowd/celebration alone when the ball-in-net instant is not observed.

    Fires ONLY when ALL hold:
      - the decision is a board-accepted goal read (isHighlight true, and the
        event is a GOAL/GOL or the outcome is scoring_play),
      - the score is a near-max confidence (>= CELEBRATION_ONLY_SCORE_FLOOR),
      - neither explicit ball-goal criterion is observed (ballInNet is not True
        AND ballCrossedLineBetweenPosts is not True), and
      - the crowd/celebration IS observed (crowdErupted is True).

    In that case the score is capped and isHighlight forced to false so a
    celebration-only moment never surfaces as a score. Mutates and returns
    `decision` (no-op otherwise)."""
    if not decision.get("isHighlight"):
        return decision
    evt = str(decision.get("eventType") or "").upper().strip()
    is_goal_read = evt in ("GOAL", "GOL") or str(decision.get("outcome") or "").lower() == "scoring_play"
    if not is_goal_read:
        return decision
    try:
        score = float(decision.get("score") or 0.0)
    except (TypeError, ValueError):
        score = 0.0
    if score < CELEBRATION_ONLY_SCORE_FLOOR:
        return decision
    crit = (decision.get("verdict") or {}).get("criteria") or {}
    ball_in_net = crit.get("ballInNet")
    ball_crossed = crit.get("ballCrossedLineBetweenPosts")
    scoreboard_changed = crit.get("scoreboardChanged")
    crowd = crit.get("crowdErupted")
    # The goal must be observed by at least one INDEPENDENT criterion (ball in
    # net / ball crossed the line / scoreboard change) for a near-max score;
    # a scoreboard change is an independent confirmation (I3 / ADAAAA-6360) and
    # must never be caught here.
    if ball_in_net is True or ball_crossed is True or scoreboard_changed is True:
        return decision
    # Celebration observed but ball-in-net not observed -> celebration-only.
    if crowd is not True:
        return decision
    decision["isHighlight"] = False
    decision["score"] = CELEBRATION_ONLY_SCORE_CAP
    decision["reason"] = (
        (decision.get("reason") or "")
        + "; celebration-only goal read: ball-in-net instant not observed, "
        "crowd/celebration alone cannot confirm a GOAL"
    ).strip("; ")
    return decision


def finalize_goal_acceptance(decision: dict, prefer_labels: list[str] | None = None) -> dict:
    """ADAAAA-6598: the SINGLE accept gate at the top of the decide route.

    ONLY a frame-confirmed `scoring_play` is a board-accepted GOAL highlight.
    A `near_miss` / `big_play` / `not_highlight` outcome is never surfaced as a
    scoring highlight, regardless of what the model, the I2 ball-outcome gate,
    the scoreboard force, or the notable-only apply_gate set `isHighlight` to.
    This closes the loop on the two verified false positives (a near_miss at
    t=1821s and a big_play at t=1954.9s whose own reason said the ball did NOT
    enter the net) and on the high-value (GOAL) waiver that accepted a
    corroborated-but-not-a-goal candidate. ADAAAA-7135 (criteria 6): also
    rejects a near-max-score GOAL accepted on celebration alone when the
    ball-in-net instant is not observed. Mutates and returns `decision`.

    ADAAAA-6855: when the job explicitly requested a non-goal class in
    `prefer_labels` (near-misses/saves/red-cards/counter-attacks), a
    correctly-detected instance of that class is ACCEPTED and exported as a
    DISTINCT highlight (outcome / eventType preserved — never relabeled as a
    goal, so goal precision is unaffected). When no non-goal label is requested
    the default scoring-only gate is unchanged.
    """
    decision = apply_celebration_only_guard(decision)
    outcome = decision.get("outcome")
    if outcome == "scoring_play":
        return decision
    # Explicitly-requested non-goal class -> accept as a distinct highlight.
    if outcome in requested_outcomes(prefer_labels):
        decision["isHighlight"] = True
        # ADAAAA-6969: a non-scoring highlight's label reflects the outcome
        # class (NEAR_MISS / BIG_PLAY) — never the candidate/model's "GOAL".
        # outcome & nearMiss are preserved; only the label changes.
        decision["eventType"] = event_type_for_outcome(outcome, decision.get("eventType") or "")
        return decision
    decision["isHighlight"] = False
    decision.setdefault(
        "reason",
        "",
    )
    decision["reason"] = (
        (decision.get("reason") or "")
        + f"; outcome={decision.get('outcome')} is not a scoring highlight"
    ).strip("; ")
    return decision


def _detection_lines(evidence: dict) -> list[str]:
    """Render the per-detection boxes + ball/goal-line geometry (I4 / ADAAAA-6361)
    as prompt context so Gemma can cite concrete numbers instead of guessing
    position from vision alone. Returns [] when the server forwarded none (no
    regression vs today). Each detection is one line: label, normalized bbox,
    confidence, optional track id. Ball position / distance-to-goal /
    goal-line-relative are appended when present."""
    dets = evidence.get("detections") or []
    out: list[str] = []
    for d in dets[:16]:
        if not isinstance(d, dict):
            continue
        label = (d.get("label") or "").strip() or "object"
        bb = d.get("bbox") or []
        try:
            bbox = ",".join(f"{float(v):.2f}" for v in bb[:4])
        except (TypeError, ValueError):
            bbox = ""
        conf = d.get("confidence")
        conf_s = f" conf={float(conf):.2f}" if conf not in (None, "") else ""
        tid = (d.get("trackId") or "").strip()
        tid_s = f" track={tid}" if tid else ""
        out.append(f"- {label} bbox=[{bbox}]{conf_s}{tid_s}" if bbox else f"- {label}{conf_s}{tid_s}")
    bp = evidence.get("ballPosition")
    if isinstance(bp, list) and len(bp) >= 2:
        try:
            out.append(f"- ball position=[{float(bp[0]):.2f},{float(bp[1]):.2f}] (normalized)")
            dg = evidence.get("distanceToGoal")
            if isinstance(dg, (int, float)) and dg > 0:
                out.append(f"- ball distance-to-goal={float(dg):.2f}")
            gld = evidence.get("goalLineDelta")
            if isinstance(gld, (int, float)) and gld != 0:
                side = "crossed" if gld >= 0 else "before"
                out.append(f"- ball goal-line-relative={float(gld):.2f} ({side} the line)")
        except (TypeError, ValueError):
            pass
    return out


def _audio_level_line(evidence: dict) -> str:
    """Render the audio-energy level CURVE (I4 / ADAAAA-6361) — not just the
    scalar peak — so Gemma sees the shape of the crowd/commentary energy around
    the trigger. Returns \"\" when no level series was forwarded (no regression)."""
    levels = evidence.get("audioLevels") or []
    if not levels or not isinstance(levels, list):
        return ""
    try:
        nums = [float(v) for v in levels[:64] if isinstance(v, (int, float))]
    except (TypeError, ValueError):
        return ""
    if not nums:
        return ""
    # Compact: report count/peak/mean plus the raw series (rounded) so the model
    # can reason about the shape (rise at/after the trigger, etc.).
    peak = max(nums)
    mean = sum(nums) / len(nums)
    series = ",".join(f"{v:.2f}" for v in nums[:32])
    return f"audio energy level curve ({len(nums)} samples, peak={peak:.2f}, mean={mean:.2f}): [{series}]"


def _asr_url() -> str | None:
    """The cheap ASR endpoint for Path 2 (ADAAAA-6314). Unset => transcription is
    skipped and the decide prompt runs text-only (no regression vs today)."""
    u = os.environ.get("ASR_URL", "").strip()
    return u or None


# ADAAAA-7669: whisper's task knob. "transcribe" (default) keeps the source
# language — the deployed behaviour. "translate" makes whisper emit English, so
# Spanish/Catalan commentary reaches the prompt in a language gemma-4 handles
# confidently. Opting in is a per-deployment env decision (ASR_TASK=translate),
# never a code default: translation rewrites the prompt text, so enabling it
# requires re-running the goal-acceptance check on a real clip.
ASR_TASKS = ("transcribe", "translate")
ASR_DEFAULT_TASK = "transcribe"


def asr_task() -> str:
    """Effective whisper task for Path 2 ASR (``ASR_TASK``, default transcribe).

    An unrecognised value falls back to ``transcribe`` rather than erroring, so a
    typo degrades to today's source-language behaviour instead of breaking the
    decide path. The ASR endpoint echoes what actually ran as ``asrTask``.
    """
    t = (os.environ.get("ASR_TASK", "") or "").strip().lower()
    return t if t in ASR_TASKS else ASR_DEFAULT_TASK


def transcribe_audio(
    url: str,
    audio_b64: str,
    sample_rate: int = 16000,
    timeout_s: float = 20.0,
    task: str | None = None,
) -> tuple[str, float]:
    """Transcribe a mono WAV (base64, e.g. 16 kHz 16-bit PCM) to text via the ASR
    endpoint (Path 2). Returns (text, elapsed_seconds). Any failure returns
    ("", elapsed) so the decide path still runs text-only and never dies on an
    ASR glitch.

    Contract (newly introduced by this task): POST {url}/transcribe with JSON
    ``{"audio": "<wav base64>", "sample_rate": 16000, "task": "transcribe"}``
    -> ``{"text": "...", "asrTask": "transcribe"}``. The ``task`` field is
    additive (ADAAAA-7669): an ASR server that predates it ignores the extra key
    and still answers, so an old endpoint never breaks. Kept tiny so any cheap
    ASR (faster-whisper server, hosted endpoint) can serve it; it never runs the
    gemma GPU for audio."""
    import time

    import httpx

    if not audio_b64:
        return "", 0.0
    # ADAAAA-7669: explicit arg wins; otherwise the deployment's ASR_TASK.
    effective_task = (task or "").strip().lower() or asr_task()
    if effective_task not in ASR_TASKS:
        effective_task = ASR_DEFAULT_TASK
    t0 = time.monotonic()
    text = ""
    try:
        resp = httpx.post(
            url.rstrip("/") + "/transcribe",
            json={"audio": audio_b64, "sample_rate": sample_rate, "task": effective_task},
            timeout=timeout_s,
        )
        resp.raise_for_status()
        data = resp.json()
        text = (data.get("text") or data.get("transcript") or "").strip()
        # ADAAAA-7665: drop whisper's silence hallucinations ("What?", "Go!",
        # "You") and punctuation-only output so the prompt/analysis block only
        # ever carries real commentary. `audio.path` then falls back to "none"
        # for a window that carried no usable speech (ADAAAA-7248/7277).
        # ADAAAA-7669: the guard runs AFTER translation on purpose — whisper's
        # translate task answers silence with the same English filler set, so a
        # translated window must pass through this filter too.
        text = usable_transcript(text)
    except Exception:
        text = ""
    return text, round(time.monotonic() - t0, 4)


# ADAAAA-7781: COMPACT live verdict contract. The live rail's decide throughput
# is decode-bound (measured on the box: p50 9.4 s per decide for a ~1340-char
# verdict, and the box's two gemma cards together decode ~150 tok/s), so total
# decides/s = decode_tokens_per_s / tokens_per_decide. At 2 live streams the pass
# needs 0.66 decides/s but the full contract costs ~420 output tokens -> 0.36/s
# and 55+ skipped cadence windows per stream. This variant keeps every field the
# server ACTUALLY consumes (isHighlight/score/outcome/reason/eventType/verdict
# .criteria) plus the one-sentence reviewer rationale and the attestation
# discipline (independentlyObserved BEFORE the hypothesis), and drops the
# duplicated long-form prose + the evidenceAttested list. Live rail only; the
# VOD path keeps the full contract byte-for-byte.
_OUTPUT_CONTRACT_COMPACT = (
    "Now answer with ONLY one JSON object, no markdown, no preamble, no "
    "leading/trailing prose, exactly of this shape (keep every free-text field "
    "to the stated word cap — shorter is better, do NOT restate the criteria):\n"
    "{\"isHighlight\": true|false, \"score\": 0..100, \"eventType\": \"<type>\", "
    "\"outcome\": \"scoring_play|near_miss|big_play|not_highlight\", "
    "\"reason\": \"<max 20 words: the deciding evidence AND its timestamp "
    "(timeline t=…, or the ASR/window clock)>\", "
    "\"reasoning\": \"<ONE sentence, max 25 words: what you observed FIRST, then "
    "how that tests the hypothesis>\", "
    "\"verdict\": {\"hypothesis\": \"<the candidate type you were testing>\", "
    "\"independentlyObserved\": \"<max 15 words: what the dossier's evidence "
    "shows, stated before the hypothesis>\", "
    "\"criteria\": {\"ballCrossedLineBetweenPosts\": true|false|null, "
    "\"ballInNet\": true|false|null, \"scoreboardChanged\": true|false|null, "
    "\"crowdErupted\": true|false|null}, \"contradictedBy\": \"<max 12 words, or "
    "null when the hypothesis is not contradicted>\"}, "
    # ADAAAA-7935: the fast rail emits ONE play-by-play line per window with an
    # optional colour beat, not one unbounded announcer sentence. The budgets are
    # inlined so the model cannot float back to a scene-setting first clause:
    # lead <= 70, colour <= 40, whole field target <= 110 / HARD MAX 140 (down
    # from 220). The cap binds the WHOLE field, not just each appended line:
    # the stored row is the field, and AC1 (p95 <= 140, 0 over 140) plus the
    # decode-bound token budget both depend on it staying one bounded line.
    #
    # ADAAAA-7949 (ADAAAA-7933 Inc 4), contract v2. v1 folded STORY SO FAR into
    # this one line AND forbade repeats, so the model preserved a captured goal
    # by re-serving the same composite sentence: on job 7b719a9f 30 of 68
    # windows emitted one identical sentence and the beat froze from T+21 to
    # T+312 (17 of 20 sampled lines byte-identical). Root cause R1 was the
    # contract collision, not a model failure. So:
    #  - the line now describes THIS WINDOW ONLY; continuity stays in the story
    #    the job already logs (summaryLog / story-so-far), never in this field;
    #  - a nothing-new window is blunt (<= 8 words, no em-dash, no clock) rather
    #    than a shortened description (v1: 0 of 68 lines <= 8 words, min 16);
    #  - colour is its own channel (crowd / body language / momentum / bench /
    #    pitch conditions) that may not restate the lead (v1: 1 of 20 rows had
    #    one, and the em-dash clause read as apposition — R2).
    # The no-copyable-example rule from c9012ad still holds: the shape is
    # described, never exemplified with a sentence the model can paste.
    # ADAAAA-8318 (ADAAAA-8302 Option 2): the clip card's COPY TARGET. The
    # runningSummary below stays the announcer detail line; this ONE extra field
    # is the headline a user posts, generated in the SAME reply (no second call).
    #
    # ADAAAA-8356 (ADAAAA-8302 Phase B FAIL): 8318 inlined this field MID-WAY
    # through the runningSummary description, so the caption's COLOR BEAT /
    # CLOCK / no-invented-names rules dangled after the title key and the title
    # spec was a 5-clause parenthetical sitting directly under a lead rule that
    # REQUIRES actor + action + place. Measured on leg 23bb0a61: 341/898 model
    # titles carried a place chain, 39 asserted a goal on a non-scoring verdict,
    # 24 named a person/team absent from the row's copy, 24 carried a second
    # beat; the write seam refused 46/54 rows, so 20/25 served cards fell back to
    # the deterministic GOAL / m:ss title.
    #
    # Fix (v2, probe-measured): the key is declared BEFORE runningSummary, so the
    # model writes the headline from the event instead of shortening a caption it
    # has not written yet, and the caption description stays contiguous. The bars
    # ride IN the shape (the position the model attends to) with the contrast
    # named outright — the caption MUST name a place, the headline MUST NOT.
    "\"postTitle\": \"<the card HEADLINE: exactly WHO + one present-tense VERB + "
    "WHAT, three slots and no fourth — never WHERE, never a clock, second beat "
    "or score/goal word; <=60 chars, <=10 words>\", "
    "\"runningSummary\": \"<CAPTION FOR THIS WINDOW ONLY, as ONE line (never append a "
    "second line): total target max 110 chars, HARD MAX 140 (was 220). Shape "
    "'<PLAY-BY-PLAY LEAD> — <optional COLOR BEAT>'. THIS WINDOW ONLY: describe "
    "only what this window's frames and transcript show. The job's story already "
    "holds every earlier line, so STORY SO FAR is context, never material: do NOT "
    "fold it into this line, do NOT extend or compress it here, and never restate "
    "an event from an earlier window (a goal already captured stays in the story "
    "and is NEVER re-said in a later caption unless THIS window is the goal "
    "window). NEVER re-emit a line you already emitted this job: if this window "
    "looks like the last one, name a different concrete "
    "subject (another player, jersey number or role) and a different verb or zone, "
    "because a repeated sentence reads as a caption engine, not an announcer. LEAD: "
    "actor + action + place, "
    "present tense, active voice, max 70 chars — name the player/jersey when the "
    "frames read one, else the role (the winger, the keeper, the No. 9); lead with "
    "the event, not the scene, and open on an ACTION VERB (drives, carries, "
    "tackles, clears, shoots), never \"are positioned\" or \"maintain position\". "
    "QUIET WINDOW — when YOUR OWN verdict is isHighlight=false (outcome "
    "not_highlight, nothing above threshold): the whole line is ONE blunt flat "
    "statement, max 8 words counted INCLUDING articles — drop 'a', 'the', "
    "'jersey' and every adjective to fit, NO em-dash, NO colour beat, NO clock — "
    "just who has the ball and which zone it is in, and NEVER describe the play on "
    "such a window. If your draft is 9 words or longer it is WRONG: rewrite it "
    "shorter. If this window looks like the last quiet one, name a different zone "
    "(defensive third, halfway, right channel, centre circle) and never reuse the "
    "sentence. EVERY LEAD names a place this window's frames read (penalty area, "
    "box, goal area, halfway, right or left channel, centre circle). BEFORE you "
    "write, compare your line with the story already given: if it shares its first "
    "four words with an earlier line it IS a repeat — rewrite it with a different "
    "subject and zone. A window that re-shows an event you already captioned "
    "(replay, celebration, regroup) adds nothing new: give it the QUIET shape "
    "(<= 8 words, no em-dash, no colour) even when your verdict is not_highlight=false. "
    "A celebration or replay window NEVER states the goal again, whatever the "
    "scoreboard shows — the goal belongs to the window where the ball first "
    "entered the net and is not re-said afterwards. "
    "COLOR BEAT — a "
    "SEPARATE CHANNEL, NEVER the play: on a highlight window the em-dash clause "
    "may carry ONLY crowd or stand reaction, players' body language or posture, "
    "momentum or energy, the bench or dugout, or pitch/weather conditions, max 40 "
    "chars. It must not contain ANY part of the action — no shot, save, block, "
    "tackle, interception, pass, miss, post, net, goal, score or keeper save — and "
    "must not rephrase or extend the lead; when the only observation left is the "
    "play itself, write the lead alone with no em-dash. About 1 line in 4 carries "
    "a clause and NEVER more than 1 line in 3, and only when a crowd, bench or "
    "pitch observation is plainly visible in this window's frames; a not_highlight "
    "window or a repeat window never carries one, and never pad to hit a ratio. CLOCK: "
    "only on datable events ('GOAL 72s'), not every line. NEVER open with 'The "
    "video shows', 'The video begins', 'The video starts with', 'In this segment', "
    "'The scene opens on', 'The broadcast cuts to', 'The sequence', 'This window "
    "shows'. Color must be attributable to this window's frames or transcript — no "
    "invented names, scores, kit colours or flags.>\", "
    # ADAAAA-8356 (v2): the headline's operating rules, placed AFTER the shape
    # (recency, and they cannot be misread as a caption clause). The caption
    # above REQUIRES a place; the headline never names one. A violating headline
    # is discarded at the write seam and the card falls back to a plain
    # `LABEL · m:ss`, so the model is told the rule costs it the field.
    # ADAAAA-8405 (Phase C residuals, measured on 255 emitted titles): 7/255
    # headlines still carried a place phrase ("Player falls in box", "Players
    # move in center"), 5/255 asserted a goal on a not_highlight/big_play row
    # ("Ordoñez scores"), and 6/255 named a player the row's own copy never
    # read (a first name invented onto a surname). The paragraph below is the
    # v3 rewrite of 8356's v2: the place ban names the leak shapes ('in/at/on' +
    # zone) and the unit fallback, the claim ban is keyed to the OUTCOME value
    # the model just wrote rather than the word "goal", the name rule pins
    # EXACT transcription (never a first name added to a surname), and the verb
    # set is closed so a quiet window cannot reach for "scores".
    "POST TITLE RULES — postTitle is the card's HEADLINE, written FIRST from the "
    "event itself. Fill exactly three slots and nothing else: WHO (a jersey "
    "number or a role — the keeper, the defender, the striker; a name ONLY when "
    "THIS window's transcript spells it (never a name you read off a scorebug, "
    "graphic or caption in the frames), copied EXACTLY as written, never "
    "adding a first name to a surname and never correcting a spelling — never "
    "from the story or the match context, and an empty transcript and OCR mean "
    "NO NAME at all; a name lifted from STORY SO FAR or an earlier window is an "
    "invention), one present-tense VERB, and WHAT (the "
    "ball, a shot, a tackle, the keeper, the whistle). NO fourth slot: the "
    "caption MUST name a place, the headline NEVER does — no zone, area, box, "
    "third, wing, channel, circle, half, side, midfield, center, venue or "
    "stadium, and never 'in', 'at', 'on' or 'from' followed by one, no clock, no "
    "second beat, no consequence ('leads to', 'after', 'then'). If no player or "
    "role is readable, name the unit (defence, midfield, attack) — never the "
    "bare word Player or Players. The headline is NEVER more than FOUR WORDS "
    "and carries NO PREPOSITION AT ALL — never in, at, on, from, near, into, "
    "around, inside, of or to — because every one of them introduces a zone: if "
    "your draft contains one, delete it and every word after it. ONE clause, no "
    "trailing period, no em-dash, "
    "semicolon or comma clause. NO score word at all on a window whose own "
    "outcome is not_highlight or big_play — not scores, scored, scorer, goal, "
    "gol, net, equalise, level, lead or a result like 2-1 — and no goal claim "
    "unless YOUR OWN outcome here is scoring_play with a transcript or "
    "scoreboard read that says so. Use an action verb: carries, drives, clears, "
    "tackles, blocks, saves, shoots, passes, contests, loses, signals. Never "
    "reuse a subject+verb you already titled this job. Start with a capital "
    "letter. Read the headline once more and delete any word that names where "
    "the action happened."
)
_OUTPUT_CONTRACT_FULL = (
        "Now answer with ONLY one JSON object, no markdown, no preamble, no "
        "leading/trailing prose, exactly of this shape:\n"
        "{\"isHighlight\": true|false, \"score\": 0..100, \"eventType\": \"<type>\", "
        "\"reason\": \"<short grounded reason that names the deciding evidence "
        "and its timestamp (timeline t=… or the ASR/window clock)>\", "
        "\"outcome\": \"scoring_play|near_miss|big_play|not_highlight\", "
        # ADAAAA-8325 (Inc 2): the footage-phase field, added to the VOD (FULL)
        # contract only. It is additive metadata: the outcome ladder above is
        # unchanged and the standing rule that a replay is NEVER scoring_play is
        # repeated in the field's own wording. VOD only because the live rail is
        # decode-bound (output tokens are its throughput ceiling) and replay
        # attach corroboration is a VOD-only concern.
        "\"phase\": \"live|replay\", "
        "\"reasoning\": \"<2-4 sentences: what you independently observed FIRST, then "
        "how that tests the hypothesis>\", "
        "\"verdict\": {\"hypothesis\": \"<the candidate type you were testing>\", "
        "\"independentlyObserved\": \"<what the dossier's evidence shows, stated "
        "before the hypothesis>\", \"criteria\": {\"ballCrossedLineBetweenPosts\": true|false|null, "
        "\"ballInNet\": true|false|null, \"scoreboardChanged\": true|false|null, "
        "\"crowdErupted\": true|false|null}, \"contradictedBy\": \"<the evidence that "
        "contradicts the hypothesis, or the null when it does not>\"}, "
        "\"evidenceAttested\": [\"<each concrete piece of grounded evidence you relied on>\"], "
        "\"runningSummary\": \"<your updated RUNNING video story so far, ~1800 chars max. "
        "Write it like a LIVE SPORTS ANNOUNCER calling the game, as ONE continuous narrative — "
        "NOT a list of static scene descriptions. NARRATIVE CONTINUITY: each new line must build "
        "on the previous one — reference or advance the ongoing action (e.g. 'the pressure moves "
        "down the right channel', 'the keeper can't hold it and the rebound falls to the striker') "
        "instead of re-stating a fresh still. SCENE-CHANGE FRAMING: frame every change in the scene "
        "as an EVENT that happens in the story with a clear before/after (a new phase starts, the "
        "referee steps in, the attack develops, a shot is taken, a goal or near-miss happens). "
        "SPECIFICITY: name who is pressing, where the ball is, and what happens next — replace "
        "generic 'players close together' phrasing, and DROP or REWRITE dry sceneless items. "
        "FLOW: the whole thing reads as one continuous game call from the first item to the last. "
        "Chronological + forward-only: if a STORY SO FAR was given you must EXTEND it, never rewrite "
        "from scratch or delete captured events, only tighten wording; if none was given start it "
        "fresh. Cover the whole video so far, not just this window. Do NOT start a runningSummary "
        "line with a boilerplate opener such as 'The video begins', 'The video starts with', "
        "'The video shows', or 'The sequence ...' — start directly with the concrete action/observation "
        "(e.g. 'Goal: player scores at 72s')>\"}"
        # ADAAAA-8325 (Inc 2): the phase rule. Kept as a trailing sentence (not an
        # inline `<...>` inside the JSON shape) so a strict JSON emitter cannot
        # paste prose into the value. Bounded on purpose — measured delta reported
        # in the ticket; the compact contract above is untouched.
        #
        # MEASURED (deployed build, real 545be947 windows at 3 fps through
        # /app/highlight): the field is emitted on 24/24 replies but the bare rule
        # below never fired `replay` — the replay window read `live` in every
        # probe window shape. Tightened ONCE with explicit REPLAY cues (what the
        # footage looks like when it is a re-show) instead of relying on the model
        # to infer the concept; the second measurement is in the ticket comment.
        "\nPHASE (the `phase` field): `live` = the frames show the action happening; "
        "`replay` = they re-show EARLIER action. Cues for `replay`: score bug/clock "
        "missing or frozen, ball already in the net at the first frame, players "
        "celebrating instead of contesting, a cut to another camera, slow motion, a "
        "replay bumper. A replay is still judged on what it shows and is NEVER "
        "`scoring_play` for re-showing a goal. Omit `phase` when the frames cannot "
        "tell live from replay."
)

# ADAAAA-7993: the STATIC judge preamble, hoisted into the system turn so the
# vLLM prefix cache can reuse it (see the layout note above build_prompt_parts).
# Byte-identical to the head of the v1 flat prompt — the hoist reorders tokens,
# it never rewrites them.
CONTEXT_PREFIX = "Context:\n"
STATIC_PREAMBLE = (
    "You are a sports/esports highlight judge. Each window is a DOSSIER: a few frames "
    "(typically 4, sampled across the span at 1 FPS) plus the evidence the pipeline "
    "measured across the WHOLE window - the perceive timeline (one record per perceived "
    "frame), the commentary transcript (ASR), the audio-noise level curve, the detection "
    "geometry, and, when available, the match context, the prior game state and the "
    "story so far.\n"
    "THE WINDOW'S MEASURED EVIDENCE CARRIES THE READ; THE FRAMES CONFIRM IT. "
    "The perceive timeline is your PRIMARY TEMPORAL READ - it runs over the whole "
    "span, so what happened BETWEEN the stills is in the timeline records (`t=` = "
    "seconds into the window). The ASR, the audio-noise level curve and the "
    "detection geometry are PRIMARY EVIDENCE too: quote them with the timestamp "
    "you relied on. The match context and the prior game state BOUND the "
    "interpretation (teams, kit, what already happened, the current score). The "
    "frames are the CONFIRMATION CHANNEL: they resolve contradictions between "
    "channels and attest the decisive instant. Never guess from the stills alone, "
    "never treat the frames as the only evidence, and when a channel is absent "
    "say so and judge from the ones present.\n"
    "The candidate event type given in the context is a HYPOTHESIS to test, "
    "NOT a fact. It was produced by an upstream detector and is often wrong "
    "(a near-miss, an off-target shot, a warm-up or lull, or a booking gets "
    "mislabeled as a GOAL / KILL). Your job is to verify it, not to "
    "confirm it. NEVER assume the hypothesis is true.\n"
    "Reason in three passes, in this exact order:\n"
    "  PASS 1 — READ THE DOSSIER (do this FIRST, before considering the "
    "hypothesis), in this priority order: (a) the perceive timeline records in "
    "`t=` order as the temporal spine — state what the tracked objects, the ball "
    "outcome and the OCR/scoreboard readings do ACROSS the span, quoting the `t=` "
    "of the records that matter; (b) the ASR commentary, quoted; (c) the "
    "audio-noise level curve (where it rises, peaks and falls back); (d) the "
    "detection geometry near the decisive instant. Do not use the candidate type "
    "to colour this pass.\n"
    "  PASS 1b — CONFIRM WITH THE FRAMES: the frames are few, so corroborate "
    "rather than re-count. For each claim the dossier produced, check whether the "
    "frames agree. Where a frame plainly contradicts the dossier, the FRAME WINS: "
    "say so in `reason` and in verdict.contradictedBy. Where the frames are merely "
    "SILENT (the instant fell between two stills) the dossier carries the read, "
    "and frame-silence is NOT a rejection.\n"
    "  PASS 2 — HYPOTHESIS TEST: compare your confirmed read to the "
    "candidate type. Does the evidence actually support it, or is there a "
    "simpler explanation?\n"
    "When people are visible, EXPLICITLY describe their reaction and weigh it "
    "as evidence: players with arms raised, a group pile/team huddle, "
    "bench/dugout leaping up to celebrate, or the crowd/commentary erupting. "
    "Reaction is corroborating evidence only - cite it, but decide on your "
    "confirmed read of the timeline, the audio and the frames; never let reaction "
    "alone override a clear measured read of the play.\n"
    "For soccer (game hint contains 'soccer'), the candidate is a GOAL and "
    "the clip is a highlight when the confirmed read shows the team actually "
    "SCORED. Judge the goal from the timeline + audio + frame read, "
    "NOT from the geometric goal-line corroboration "
    "alone. Explicit goal signals - assess each against the timeline, the "
    "frames and the audio, mark it true when the evidence plainly shows it, false "
    "when the evidence plainly shows it did NOT happen, and null (unverifiable) "
    "when you cannot tell:\n"
    "- ballCrossedLineBetweenPosts: you plainly see the ball cross the goal "
    "line between the uprights;\n"
    "- ballInNet: the ball is in the net / the net ripples / the keeper is "
    "beaten and the ball ends in the goal;\n"
    "- scoreboardChanged: the scoreboard / score readout changes to reflect "
    "a goal;\n"
    "- crowdErupted: the crowd/commentary erupts consistent with a goal.\n"
    "A GOAL is confirmed (isHighlight=true) when the aggregate evidence "
    "supports it: the ball ends in the net / the net ripples / the keeper is "
    "beaten AND the crowd/commentary erupts consistent with a goal. The "
    "goal-line / homography corroboration (ballOutcome, "
    "ballCrossedLineBetweenPosts) is OPTIONAL corroboration, NOT a required "
    "gate: when it is absent (no field homography configured, or the "
    "line-crossing instant is not captured at the sampled frame) judge the "
    "goal DIRECTLY from the timeline + frames + audio-noise trigger, and do NOT reject "
    "just because you could not confirm the exact line crossing. Do NOT flag "
    "a soccer clip as a highlight when it shows:\n"
    "- a yellow card, red card, booking, foul, tackle, or any disciplinary "
    "incident (referee showing a card, players confronting, a player sent "
    "off);\n"
    "- a free kick, corner, shot on target, save, miss, near-miss, off-target, "
    "blocked shot, or any chance in which the ball does NOT enter the net;\n"
    "- only open play, build-up, players running, warm-ups, or a celebration "
    "with no ball in the net.\n"
    "Goal-line corroboration that is UNVERIFIABLE (you cannot confirm "
    "ball crossed the line / is in the net because the instant was not "
    "captured or no homography is configured) is NOT a rejection by itself - "
    "decide on your confirmed read of the dossier + frames. You MUST return "
    "isHighlight=false when the evidence EXPLICITLY CONTRADICTS a goal - "
    "the frames plainly show the ball did NOT enter the net (it hit the post or "
    "bar, was saved, went over or wide, or the ball stays in midfield / the clip "
    "is warm-up or lull with no strike), OR the measured channels contradict it "
    "(a ballOutcome other than goal, no goal-line / in-net / score-change record "
    "anywhere in the timeline, an OCR score that never moves, an audio level "
    "curve with no surge) - and name the contradicting evidence in `reason` and "
    "in verdict.contradictedBy. A window whose TEXT says goal (ASR commentary, a "
    "candidate label, a celebration call) but whose frames plainly contradict it "
    "MUST return isHighlight=false: text never overrides a clear frame. NEVER "
    "infer a goal from the "
    "candidate event type, or from players celebrating / crowd erupting ALONE "
    "when the frames show the ball did NOT enter the net. isHighlight=null means "
    "you genuinely cannot tell either way - it is NOT a rejection and NOT a "
    "confirmation, so use it only when the frames AND the dossier are both "
    "silent on the decisive instant.\n"
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
    "OUTCOME TAXONOMY — you must ALSO classify the outcome into EXACTLY one of "
    "the four members below and return it in the `outcome` field (increment F):\n"
    "- scoring_play: the confirmed read shows the ball/object actually crossing / "
    "converting (goal, touchdown, dunk, basket, kill, objective taken). A real "
    "score.\n"
    "- near_miss: the confirmed read shows a CLOSE CALL — a shot that hit the post/bar, a "
    "save at the line, an interception at the boundary, a denial right at the "
    "net / by the last defender — but the ball did NOT score. A near miss is "
    "NOT a scoring play, even when the crowd/commentary erupts. It IS notable "
    "and surfaces, but at a lower score.\n"
    "- big_play: non-scoring but clearly high-value — a big save, a big hit, a "
    "clutch denial, a game-changing stop.\n"
    "- not_highlight: nothing notable in the window (warm-up, lull, ordinary "
    "build-up, no close call, no score).\n"
    "THE FRAMES ARE THE FINAL ARBITER, BUT NOT THE ONLY EVIDENCE: they resolve "
    "conflicts, they do not replace the dossier. A crowd/ "
    "commentary eruption, a replay, a wrong call or an optimistic timeline flag "
    "must NEVER make you call a "
    "`scoring_play` — only evidence that the ball crossed the line / went into "
    "the net / the objective was taken can. If the frames show the ball was "
    "saved, hit the post, "
    "was caught, or did not cross before the line, the outcome is `near_miss` "
    "or `big_play` — NEVER `scoring_play` — whatever the audio or the timeline "
    "did (conflict "
    "resolves toward the frames). Conversely, do NOT downgrade a real score to "
    "`not_highlight` just because the crowd stayed quiet or the ASR said nothing "
    "(audio never flips a "
    "near_miss into a scoring play, and never cancels a real one).\n"
    "A near miss scores below a scoring play but above not_highlight: keep "
    "`score` in a lower band (e.g. <60) for near_miss, and set `nearMiss`/the "
    "flag so downstream assembly can label it distinctly.\n"
)



# ---------------------------------------------------------------------------
# ADAAAA-7938 (Spec A): the PRIOR GAME STATE block.
#
# Every decide window carries ONLY its own frames and its own window-aligned
# ASR, so a window that starts a few seconds AFTER a goal (celebration / huddle
# / replay / retrospective stat narration) is judged blind to the goal that just
# happened. VOD job fe0e3efc (ADAAAA-7931) read the 48 s celebration window as a
# fresh `scoring_play` for that reason: the goal call ("...it's 1-0 Portugal")
# sat in the 42 s window's ASR, which the 48 s window never saw.
#
# The server now forwards a compact, MEASURED prior-game-state object for every
# window after the first:
#   story        - the running story-so-far (the model's own prior summary)
#   priorAsr     - the tail of the PREVIOUS window's ASR (where a goal call lives)
#   score / lastScoreTs / needsNewScore - structured scoreboard-transition state
#
# AC-A2 (no-op guarantee): an absent / unusable block renders NOTHING, so the
# prompt stays byte-identical (proven by the golden sha256 test, not prose).
# AC-A3 (cost bound): the WHOLE block is capped at PRIOR_GAME_STATE_MAX_CHARS —
# the spec's per-field suggestions (600 story / 400 ASR) do not fit that bound
# together, so the block budget wins and the fields are sized to fit it.
# ---------------------------------------------------------------------------
PRIOR_GAME_STATE_MAX_CHARS = 600
PRIOR_STORY_MAX_CHARS = 150
PRIOR_ASR_MAX_CHARS = 90
PRIOR_SCORE_MAX_CHARS = 24
# Mirrors the deterministic ADAAAA-7865 `GOAL_DUPLICATE_REACH_S`: the block only
# claims "a new goal needs its own measured change" while the last score is
# inside that reach, so a genuinely later second goal is never talked out of a
# scoring_play by this prompt (recall guard).
PRIOR_REPEAT_REACH_S = 60


def _prior_tail(text: object, cap: int) -> str:
    """Keep the LAST `cap` chars of a single-lined string (most recent first)."""
    if not isinstance(text, str):
        return ""
    flat = " ".join(text.split())
    if not flat:
        return ""
    return flat if len(flat) <= cap else "…" + flat[-cap:]


def _prior_ts(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    return f if math.isfinite(f) else None


def _prior_block(story: str, asr: str, score: str, last_ts: float | None, needs_new: bool) -> str:
    """Render the block from already-bounded parts (deterministic)."""
    lines = ["PRIOR GAME STATE (from EARLIER windows of this clip; those frames are NOT shown here):"]
    if story:
        lines.append("- story so far: " + story)
    if asr:
        lines.append('- commentary just before this window: "' + asr + '"')
    where = f" at {last_ts:.1f}s" if last_ts is not None else ""
    if needs_new:
        scored = f"score {score}" if score else "a goal was already scored"
        lines.append(
            f"- {scored} (last score{where}); needsNewScore=true -> a NEW goal in THIS window needs its "
            'own MEASURED score change ("scoreboard score change observed during window: yes") or an '
            "in-window goal CALL. A celebration, huddle, replay or stat narration is NOT a new goal: "
            "outcome=big_play, never scoring_play."
        )
    elif score:
        lines.append(f"- score: {score}" + (f" (last score at {last_ts:.1f}s)" if last_ts is not None else ""))
    return "\n".join(lines)


def render_prior_game_state_block(prior: object) -> str:
    """The bounded PRIOR GAME STATE block, or "" when there is nothing measured
    to say (the AC-A2 no-op path). Loose on purpose: a shaped-but-wrong payload
    degrades to "no block", never to an exception or a 422."""
    if not isinstance(prior, dict):
        return ""
    story = _prior_tail(prior.get("story"), PRIOR_STORY_MAX_CHARS)
    asr = _prior_tail(prior.get("priorAsr"), PRIOR_ASR_MAX_CHARS)
    score = _prior_tail(prior.get("score"), PRIOR_SCORE_MAX_CHARS)
    last_ts = _prior_ts(prior.get("lastScoreTs"))
    needs_new = prior.get("needsNewScore") is True
    since = _prior_ts(prior.get("sinceLastScoreS"))
    # A "new score needed" claim only stands inside the deterministic reach —
    # outside it the window is a candidate for a genuinely distinct goal.
    if needs_new and since is not None and since > PRIOR_REPEAT_REACH_S:
        needs_new = False
    if not (story or asr or needs_new or score):
        return ""
    block = _prior_block(story, asr, score, last_ts, needs_new)
    if len(block) <= PRIOR_GAME_STATE_MAX_CHARS:
        return block
    # Deterministic shrink so a long story/ASR can never inflate the block past
    # the AC-A3 bound. The score-transition line is the decisive one and is kept.
    for story_cap in (120, 80, 40, 0):
        for asr_cap in (PRIOR_ASR_MAX_CHARS, 60, 30, 0):
            shrunk = _prior_block(
                _prior_tail(prior.get("story"), story_cap),
                _prior_tail(prior.get("priorAsr"), asr_cap),
                score,
                last_ts,
                needs_new,
            )
            if len(shrunk) <= PRIOR_GAME_STATE_MAX_CHARS:
                return shrunk
    return ""



# ---------------------------------------------------------------------------
# ADAAAA-8056 (lever B+e): the PER-WINDOW PERCEIVE TIMELINE block.
#
# The server folds a 27-29-seed observe window into a handful of scalars
# (trackCount max / ocrHits sum / <=16 detections / one folded goal
# attestation). *When* in the window each of those was true never reaches the
# model. Perceive already produces that density at 3 fps, so the server now
# forwards one compact record per seed (`Evidence.perceiveTimeline`) and this
# block renders it: a text record costs milliseconds of prefill where a frame
# costs 0.5-1.5 s of decide wall time.
#
# AC-E3 budget: the whole block is capped at PERCEIVE_TIMELINE_MAX_CHARS. When
# the budget binds the record is COMPACTED (object labels / OCR anchors dropped,
# keep the decisive scalars), and only then THINNED (fewest records, keeping the
# ones nearest the window center) — it is never silently dropped.
#
# ADAAAA-8064: the budget is now sized for the FULL-rate live window, not for the
# image count. The timeline is sourced from the window's whole observation set
# (~28 perceived frames over a ~10 s span at ~2.8 obs/s), so a 1000-char budget
# would bind on every window and thin the record list — which would silently
# undo the decoupling the server just built. 3400 chars holds 28-29 records at
# <= ~120 chars/record (~3.4 KB per call); prefill for ~900 extra tokens is
# milliseconds against a 0.5 s budget, and every frame saved is ~0.5-1.5 s of
# decide wall time.
PERCEIVE_TIMELINE_MAX_CHARS = 3400
PERCEIVE_TIMELINE_MAX_RECORDS = 32
PERCEIVE_TIMELINE_HEADER = (
    "perceive timeline (perceive's 3 fps view of this window, one record per "
    "frame, ordered; t = seconds from the window center):"
)


def _timeline_center(perceive_window: object) -> float | None:
    """The window center the server stated, when it said one (the `t=` column is
    relative to it). Absent/unusable == absolute timestamps, never a guess."""
    if not isinstance(perceive_window, dict):
        return None
    try:
        c = float(perceive_window.get("centerTs"))
    except (TypeError, ValueError):
        return None
    return c if c == c else None  # NaN guard


def _timeline_line(rec: dict, center_ts: float | None, *, scalars_only: bool) -> str:
    """One timeline record, rendered for the prompt. `scalars_only` drops the
    label/anchor fields and keeps the decisive scalars (the AC-E3 compaction).

    ADAAAA-8064: track ids are deliberately NOT rendered. Eight ids per record
    pushed every line past the ~120 chars/record the full-rate window budgets;
    the ids stay on the evidence record (and in `evidence.detections`), where an
    auditor can join them, while the model gets the count plus the labels.
    """
    try:
        ts = float(rec.get("ts") or 0.0)
    except (TypeError, ValueError):
        ts = 0.0
    t = f"{ts - center_ts:+.1f}s" if center_ts is not None else f"{ts:.1f}s"
    try:
        tracks = int(rec.get("tracks") or 0)
    except (TypeError, ValueError):
        tracks = 0
    parts = [f"{t} tracks={max(0, tracks)}"]
    vel = rec.get("maxVelocity")
    if isinstance(vel, (int, float)) and not isinstance(vel, bool) and float(vel) > 0:
        parts.append(f"vel={float(vel):.2f}")
    if not scalars_only:
        objs = [o for o in (rec.get("objects") or []) if isinstance(o, str) and o]
        if objs:
            parts.append("objects=" + ",".join(objs[:4]))
        ocr = [o for o in (rec.get("ocr") or []) if isinstance(o, str) and o]
        if ocr:
            parts.append('ocr="' + "|".join(ocr[:2]) + '"')
    bo = rec.get("ballOutcome")
    if isinstance(bo, str) and bo.strip():
        parts.append(f"ball={bo.strip()}")
    poss = rec.get("possession")
    if isinstance(poss, str) and poss.strip():
        parts.append(f"poss={poss.strip()}")
    flags = []
    if rec.get("goalCrossed") is True:
        flags.append("goal_line")
    if rec.get("ballInNet") is True:
        flags.append("in_net")
    if rec.get("scoreBoardChanged") is True:
        flags.append("score_delta")
    if rec.get("motionBurst") is True:
        flags.append("motion")
    if flags:
        parts.append("flag=" + "+".join(flags))
    return "  " + " ".join(parts)


def render_perceive_timeline(
    evidence: dict, perceive_window: object = None
) -> tuple[str, dict]:
    """Render the window's perceive timeline and its coverage ledger.

    Returns ``(block, ledger)``. `block` is "" when the window carries no
    timeline (VOD rail / no seeds), so the prompt stays byte-identical to the
    pre-enrichment text. `ledger` is what AC-E1/AC-C1 reads back off
    decide_audit: ``{records, chars, compacted, seeds, withFindings}`` where
    `compacted` is one of "none" | "scalars" | "thinned", plus (ADAAAA-8064) the
    server-measured density keys ``{timelineRecords, observationsInSpan,
    imageCount, imageGapMaxMs, recordsPerSecond, spanS, timelineSource}`` when the
    window stated them.

    Deterministic + side-effect free (unit-testable).
    """
    raw = evidence.get("perceiveTimeline") if isinstance(evidence, dict) else None
    recs = [r for r in (raw or []) if isinstance(r, dict)][:PERCEIVE_TIMELINE_MAX_RECORDS]
    seeds = 0
    with_findings = 0
    # ADAAAA-8064: the density/decoupling ledger the server measured for this
    # window. Passed through verbatim (typed) so `decide_audit.timings` and the
    # `analysis` block can be graded row-by-row: timelineRecords vs
    # observationsInSpan proves the timeline is not a projection of the image
    # set, recordsPerSecond/spanS grade density, imageGapMaxMs grades honesty
    # about how sparse the shipped images are.
    passthrough = {
        "timelineRecords": ("timelineRecords", int),
        "observationsInSpan": ("observationsInSpan", int),
        "imageCount": ("imageCount", int),
        # ADAAAA-8074 (AC-CAP-1): what the payload carried and which image budget
        # selected it, so a leg grades the decide_audit row instead of `printenv`.
        "imagesPerDecide": ("imagesPerDecide", int),
        # ADAAAA-8377 (LFR-1 AC-1): the payload's MEASURED image dims (from the
        # frame JPEG headers), beside the count. The ON leg of the live
        # frame-scale A/B grades 640x360 off `decide_audit` rows, so the decide
        # service must pass these through or the server's stamp never reaches
        # `timings.perceiveTimeline`.
        "imageW": ("imageW", int),
        "imageH": ("imageH", int),
        "imageBudget": ("imageBudget", int),
        "imageGapMaxMs": ("imageGapMaxMs", int),
        "recordsPerSecond": ("recordsPerSecond", float),
        "spanS": ("spanS", float),
        # ADAAAA-8065 (rev 7): the CONFIGURED live cell — the window span in
        # seconds and the decide cadence in ms, stamped by the server on every
        # payload. `spanS` above is what the frame set covered; these two are the
        # cell that was measured, so AC-SPAN-1 grades `decide_audit` instead of
        # trusting `printenv` (the ADAAAA-8074 lesson).
        "spanSec": ("spanSec", float),
        "cadenceMs": ("cadenceMs", int),
        # ADAAAA-8102: the CONFIGURED live content consume rate (frames per
        # content second). Stamped by the server on every live payload next to
        # span/cadence, so AC-8101-1 grades `contentFps == 1` off the audit row
        # rather than `printenv` — the same ADAAAA-8074 lesson applied to the rate.
        "contentFps": ("contentFps", float),
        # ADAAAA-8108 (AC-E3): the enrichment ARM this window was decided under
        # (`on` = the shipped posture, `off` = the measurement arm that omits the
        # timeline). A string passthrough, so a leg's ON/OFF split is read off
        # decide_audit instead of being inferred from `records == 0` / the prompt
        # text (both of which stay the independent cross-check).
        "enrichmentArm": ("enrichmentArm", str),
    }
    extra: dict = {}
    source = None
    if isinstance(perceive_window, dict):
        for key, dst in (("seeds", "seeds"), ("withFindings", "withFindings")):
            try:
                v = int(perceive_window.get(key) or 0)
            except (TypeError, ValueError):
                v = 0
            if dst == "seeds":
                seeds = max(0, v)
            else:
                with_findings = max(0, v)
        for key, (dst, cast) in passthrough.items():
            v = perceive_window.get(key)
            if v is None:
                continue
            try:
                extra[dst] = cast(v)
            except (TypeError, ValueError):
                continue
        src = perceive_window.get("timelineSource")
        if src in ("observations", "seeds"):
            source = src
        # ADAAAA-8074 (AC-CAP-1): a tri-state, not a string — `bool("false")` is
        # True, so it is parsed explicitly. Absent (a payload from a path that has
        # no image budget) leaves the key off the row rather than claiming true.
        applied = perceive_window.get("imageBudgetApplied")
        if applied is not None:
            if isinstance(applied, bool):
                extra["imageBudgetApplied"] = applied
            elif isinstance(applied, (int, float)):
                extra["imageBudgetApplied"] = bool(applied)
    ledger = {
        "records": 0,
        "chars": 0,
        "compacted": "none",
        "seeds": seeds,
        "withFindings": with_findings,
        **extra,
    }
    if source is not None:
        ledger["timelineSource"] = source
    if not recs:
        return "", ledger

    recs.sort(key=lambda r: float(r.get("ts") or 0.0) if isinstance(r.get("ts"), (int, float)) else 0.0)
    center = _timeline_center(perceive_window)

    def build(items: list, scalars_only: bool) -> str:
        lines = [PERCEIVE_TIMELINE_HEADER]
        lines.extend(_timeline_line(r, center, scalars_only=scalars_only) for r in items)
        return "\n".join(lines)

    block = build(recs, scalars_only=False)
    if len(block) <= PERCEIVE_TIMELINE_MAX_CHARS:
        ledger.update({"records": len(recs), "chars": len(block)})
        return block, ledger

    # Compaction 1: scalars only (drop object labels / OCR anchors / track ids).
    block = build(recs, scalars_only=True)
    mode = "scalars"
    if len(block) <= PERCEIVE_TIMELINE_MAX_CHARS:
        ledger.update({"records": len(recs), "chars": len(block), "compacted": mode})
        return block, ledger

    # Compaction 2: thin the records, keeping those nearest the window center.
    anchor = center if center is not None else 0.0
    ordered = sorted(
        recs,
        key=lambda r: abs(float(r.get("ts") or 0.0) - anchor) if isinstance(r.get("ts"), (int, float)) else 0.0,
    )
    kept: list = []
    for rec in ordered:
        trial = kept + [rec]
        trial.sort(key=lambda r: float(r.get("ts") or 0.0) if isinstance(r.get("ts"), (int, float)) else 0.0)
        if len(build(trial, scalars_only=True)) > PERCEIVE_TIMELINE_MAX_CHARS:
            continue
        kept = trial
    if not kept:  # even one record overflows: keep the single nearest one.
        kept = [ordered[0]]
    block = build(kept, scalars_only=True)
    ledger.update({"records": len(kept), "chars": len(block), "compacted": "thinned"})
    return block, ledger


def build_prompt_parts(
    event_type: str,
    evidence: dict,
    game_hint: str = "",
    n_frames: int = 1,
    has_audio: bool = False,
    transcript: str = "",
    story_so_far: str = "",
    compact: bool = False,
    match_context: object = None,
    prior_game_state: object = None,
    perceive_window: object = None,
) -> dict:
    """The three prompt pieces (ADAAAA-7993 prefix-cache layout v2):

    - ``preamble`` (:data:`STATIC_PREAMBLE`, constant) and ``contract``
      (``_OUTPUT_CONTRACT_COMPACT``/``_OUTPUT_CONTRACT_FULL``) are the STATIC
      block: identical bytes for every window of a job, so vLLM's prefix cache
      can reuse them.
    - ``context`` is the dynamic per-window ``Context:`` block (the meta lines).
    - ``system`` is exactly what the system turn carries:
      ``SYSTEM_PROMPT + preamble + contract``.
    - ``prompt`` is the v1 flat ordering (preamble + context + contract), kept
      byte-identical so the audit trail, the golden hashes and every downstream
      consumer of the prompt text do not move.

    v1 put the preamble and the contract AFTER the frames in the user turn, so
    the only cacheable prefix was SYSTEM_PROMPT (63 tokens) -> 1.08% measured
    hit rate against a 1.43% layout ceiling (ADAAAA-7979 / 7993)."""
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
    # I4 / ADAAAA-6361: per-detection geometry + audio-energy level curve, so the
    # model can cite concrete boxes/ball/levels rather than guess them from vision
    # alone. Rendered only when the server forwarded them (no regression).
    detection_lines = _detection_lines(evidence)
    if detection_lines:
        meta.append("detection geometry:")
        meta.extend("  " + ln for ln in detection_lines)
    # ADAAAA-8056 (lever B+e): the window's perceive timeline, ordered by ts.
    # Rendered only when the server forwarded records, so a non-observe / VOD
    # window keeps the byte-identical pre-enrichment prompt.
    timeline_block, _timeline_ledger = render_perceive_timeline(evidence, perceive_window)
    if timeline_block:
        meta.append(timeline_block)
    audio_level_line = _audio_level_line(evidence)
    if audio_level_line:
        meta.append(audio_level_line)
    # ADAAAA-7111 (Increment D): the running video summary (story-so-far) carried
    # from the previous cadence observe tick. Forwarded so the model can EXTEND
    # it (not rewrite from scratch) — the summary at tick N must contain/extend
    # the summary at tick N-1. Absent on the first tick (no prior summary).
    ssf = (story_so_far or "").strip()
    if ssf:
        meta.append("STORY SO FAR (your running summary of the video so far — you MUST extend/compress it, keep it chronological and forward-only, never delete events already captured, only tighten wording):")
        meta.append("  " + ssf[:MAX_RUNNING_SUMMARY_CHARS])
    # ADAAAA-7856 (Stage 6): the job's inferred teams + kit colours, resolved
    # ONCE per job from persisted evidence (no extra GPU call here) and rendered
    # as one compact block. An absent/unusable context renders "" and changes
    # nothing — the prompt stays byte-identical to the pre-feature text (AC6).
    mc_ctx = sanitize_match_context(match_context)
    mc_block = render_match_context_block(mc_ctx)
    if mc_block:
        meta.append(mc_block)
    # ADAAAA-7938 (Spec A): the prior-game-state block. Rendered ONLY when the
    # server forwarded measured state, so an absent block leaves the prompt
    # byte-identical (AC-A2). Placed after the match context and before the
    # contract so the model reads "what already happened" before the verdict
    # rules it must apply.
    pg_block = render_prior_game_state_block(prior_game_state)
    if pg_block:
        meta.append(pg_block)
    contract = _OUTPUT_CONTRACT_COMPACT if compact else _OUTPUT_CONTRACT_FULL
    if mc_block and mc_ctx is not None:
        # ADAAAA-7856 (Stage 6): the anti-fabrication rule ALSO governs the
        # runningSummary narrative — that field is where "the German defender"
        # was invented, so it carries the same rule as the verdict fields.
        contract = contract + (
            "\nMATCH CONTEXT RULE (also governs runningSummary and every free-text "
            "field): " + match_context_rule(mc_ctx.get("sport"))
        )
    context_text = CONTEXT_PREFIX + "- " + "\n- ".join(meta) + "\n\n"
    # ADAAAA-7993: v2 wire layout. The static preamble + the output contract go in
    # the SYSTEM turn (identical bytes for every window of a job), and the user
    # turn carries only the per-window Context block after the frames. The tokens
    # are reordered, never added: `prompt` below is byte-identical to the v1 flat
    # text (0-char delta, pinned by test_prompt_layout_v2.py), so verdict quality
    # cannot move because of a prompt edit here.
    return {
        "preamble": STATIC_PREAMBLE,
        "context": context_text,
        "contract": contract,
        "system": SYSTEM_PROMPT + STATIC_PREAMBLE + contract,
        "prompt": STATIC_PREAMBLE + context_text + contract,
        "compact": bool(compact),
    }


def build_prompt(
    event_type: str,
    evidence: dict,
    game_hint: str = "",
    n_frames: int = 1,
    has_audio: bool = False,
    transcript: str = "",
    story_so_far: str = "",
    compact: bool = False,
    match_context: object = None,
    prior_game_state: object = None,
    perceive_window: object = None,
) -> str:
    """The v1 flat prompt text: preamble + Context block + contract, in that
    order. Byte-identical to the pre-ADAAAA-7993 output and kept for the audit
    trail (`analysis.prompt`) and the golden-hash contract. The request that goes
    over the wire is assembled from `build_prompt_parts()` (v2 layout)."""
    return build_prompt_parts(
        event_type,
        evidence,
        game_hint,
        n_frames=n_frames,
        has_audio=has_audio,
        transcript=transcript,
        story_so_far=story_so_far,
        compact=compact,
        match_context=match_context,
        prior_game_state=prior_game_state,
        perceive_window=perceive_window,
    )["prompt"]


# --- ADAAAA-7155 Increment A: per-window LLM analysis capture ----------------
# Observability/inspectability only. These helpers build the `analysis` block
# (exact prompt + ordered dataItems + media refs + asr + full response) that is
# threaded onto the returned decision. They never change parse/accept semantics
# and never add an inference call.


def _media_refs(media: list | None) -> list:
    """Lazy media refs (seq + uri) for the frames/images fed to the model.
    `uri` is carried from the frame dict when present (the server fills the
    canonical /frames/:seq delivery); an empty uri means "bytes not resolved at
    the decide layer" — Incr B maps seq->uri on the server path."""
    out: list = []
    for i, f in enumerate(media or []):
        seq = f.get("seq", i) if isinstance(f, dict) else i
        uri = f.get("uri") if isinstance(f, dict) and f.get("uri") else ""
        try:
            seq = int(seq)
        except (TypeError, ValueError):  # noqa: BLE001
            seq = i
        out.append({"seq": seq, "uri": uri})
    return out


def _build_data_items(
    event_type: str,
    evidence: dict,
    game_hint: str = "",
    n_frames: int = 1,
    n_images: int = 0,
    has_audio: bool = False,
    transcript: str = "",
    story_so_far: str = "",
    match_context: object = None,
    prior_game_state: object = None,
    perceive_window: object = None,
) -> list:
    """Ordered, structured view of the context items fed to the model for a
    single-candidate window. Mirrors `build_prompt`'s rendered lines so the UI
    can render each item independently (type/label/value)."""
    items: list = []

    def add(typ: str, label: str, value) -> None:
        items.append({"type": typ, "label": label, "value": value})

    ev = (event_type or "").upper()
    add("candidate", "Candidate event type", ev)
    add("game", "Game hint", game_hint or "unspecified")
    add("tracking", "Track count", evidence.get("trackCount", 0))
    add("tracking", "Max tracked velocity", evidence.get("maxVelocity", 0))
    add("ocr", "OCR hits", evidence.get("ocrHits", 0))
    add("scoreboard", "Scoreboard score change", "yes" if evidence.get("scoreBoardChanged") else "no")
    add("frames", "Frames shown (1 FPS temporal window)", n_frames)
    add("images", "Context images", n_images)
    add("audio", "Audio provided (commentary/crowd)", "yes" if has_audio else "no")
    outcome = evidence.get("ballOutcome")
    crossed = evidence.get("goalCrossed")
    if outcome:
        glv = f"ballOutcome={outcome}" + (f", goalCrossed={crossed}" if crossed is not None else "")
    else:
        glv = "not available"
    add("goal_line", "Goal-line ground-truth (perceive homography)", glv)
    reaction_lines = _reaction_summary(evidence)
    for ln in reaction_lines:
        add("reaction", "People-reaction evidence", ln)
    tt = (transcript or "").strip()
    if tt:
        add("asr", "Audio commentary transcript (ASR)", tt[:500])
    det_lines = _detection_lines(evidence)
    for ln in det_lines:
        add("detections", "Detection geometry", ln)
    # ADAAAA-8056 (lever B+e): the SAME perceive timeline the prompt carries, as
    # its own inspectable item, so a decided window shows exactly what temporal
    # evidence the model was given (AC-E1's inspector).
    tl_block, tl_ledger = render_perceive_timeline(evidence, perceive_window)
    if tl_block:
        add(
            "perceive_timeline",
            "Perceive timeline (3 fps window record, ordered by ts)",
            tl_block,
        )
    al = _audio_level_line(evidence)
    if al:
        add("audio_level", "Audio-energy level curve", al)
    ssf = (story_so_far or "").strip()
    if ssf:
        add("summary", "STORY SO FAR", ssf[:MAX_RUNNING_SUMMARY_CHARS])
    # ADAAAA-7856: the same MATCH CONTEXT block the prompt carries, as its own
    # inspectable item (the window's `analysis.dataItems` in the UI). Absent
    # context adds no item, so nothing changes for resolver-less jobs.
    mc_block = render_match_context_block(match_context)
    if mc_block:
        add("match_context", "Match context (inferred teams, authoritative for naming)", mc_block)
    # ADAAAA-7938 (Spec A): the prior-game-state block as its own inspectable
    # item, so the job-detail view shows exactly what the window inherited.
    pg_block = render_prior_game_state_block(prior_game_state)
    if pg_block:
        add("prior_game_state", "Prior game state (from earlier windows)", pg_block)
    return items


def _build_group_data_items(
    candidates: list,
    game_hint: str = "",
    n_frames: int = 1,
    n_images: int = 0,
    has_audio: bool = False,
    transcript: str = "",
) -> list:
    """Ordered structured view of the context items fed for the group-mode
    window (one review over the whole frame group)."""
    items: list = []

    def add(typ: str, label: str, value) -> None:
        items.append({"type": typ, "label": label, "value": value})

    add("game", "Game hint", game_hint or "unspecified")
    add("frames", "Frames shown (1 FPS temporal window)", n_frames)
    add("images", "Context images", n_images)
    add("audio", "Audio provided (commentary/crowd)", "yes" if has_audio else "no")
    for i, c in enumerate(candidates or []):
        ev = c.get("evidence") or {}
        if not isinstance(ev, dict):
            ev = {}
        reaction = ev.get("reaction") or {}
        if not isinstance(reaction, dict):
            reaction = {}
        add("candidate", f"Candidate {i} eventType", c.get("eventType"))
        add("candidate", f"Candidate {i} timestamp", c.get("timestamp"))
        add("candidate", f"Candidate {i} trackCount", ev.get("trackCount", 0))
        add("candidate", f"Candidate {i} maxVelocity", ev.get("maxVelocity", 0))
        add("candidate", f"Candidate {i} ocrHits", ev.get("ocrHits", 0))
        add("candidate", f"Candidate {i} scoreBoardChanged", ev.get("scoreBoardChanged"))
        add("candidate", f"Candidate {i} ballOutcome", ev.get("ballOutcome"))
        add("candidate", f"Candidate {i} goalCrossed", ev.get("goalCrossed"))
        add("candidate", f"Candidate {i} audioReaction", reaction.get("crowdEnergy") or 0)
        add("candidate", f"Candidate {i} humansInMotion", reaction.get("humansInMotion") or 0)
    tt = (transcript or "").strip()
    if tt:
        add("asr", "Audio commentary transcript (ASR)", tt[:500])
    return items


def _response_block(decision: dict) -> dict:
    """The full response fields retained from a decide decision, as a FLAT copy
    (never the decision dict itself, to avoid a self-referential analysis)."""
    return {
        "isHighlight": decision.get("isHighlight"),
        "score": decision.get("score"),
        "eventType": decision.get("eventType"),
        "reason": decision.get("reason"),
        "outcome": decision.get("outcome"),
        # ADAAAA-8325: the footage phase, so a replay can compare raw vs served.
        "phase": decision.get("phase"),
        "nearMiss": decision.get("nearMiss"),
        "reasoning": decision.get("reasoning"),
        "verdict": decision.get("verdict"),
        "evidenceAttested": decision.get("evidenceAttested") or [],
        "audioContext": decision.get("audioContext"),
        "runningSummary": decision.get("runningSummary"),
        # ADAAAA-8318: the model's own post title (before the server write-seam
        # gate). Absent on the VOD/full contract, which never asks for one.
        "postTitle": decision.get("postTitle"),
        "source": decision.get("source"),
    }


def _window_analysis(
    *,
    prompt: str,
    event_type: str = "",
    evidence: dict | None = None,
    game_hint: str = "",
    data_items: list | None = None,
    n_frames: int = 1,
    n_images: int = 0,
    send_audio: bool = False,
    transcript: str = "",
    story_so_far: str = "",
    audio_sample_rate: int = 16000,
    frames: list | None = None,
    images: list | None = None,
    response: dict | None = None,
    match_context: object = None,
    prior_game_state: object = None,
    perceive_window: object = None,
) -> dict:
    """Assemble the opaque `analysis` block for a decided window."""
    evidence = evidence or {}
    if data_items is None:
        data_items = _build_data_items(
            event_type, evidence, game_hint, n_frames, n_images,
            send_audio or bool(transcript), transcript, story_so_far,
            match_context, prior_game_state, perceive_window,
        )
    return {
        "prompt": prompt,
        "dataItems": data_items,
        "frames": _media_refs(frames),
        "images": _media_refs(images),
        "audio": {
            "uri": "",
            "sampleRate": audio_sample_rate,
            "path": "input_audio" if send_audio else ("asr_text" if transcript else "none"),
        },
        "asr": {"transcript": transcript or "", "url": _asr_url()},
        # ADAAAA-8056 (AC-E1): the perceive-timeline coverage ledger for THIS
        # window (records rendered, chars, compaction mode, seeds aligned).
        "perceiveTimeline": render_perceive_timeline(evidence, perceive_window)[1],
        "response": response if response is not None else {},
    }


def _audio_coverage(
    *,
    audio_b64: str,
    asr_ran: bool,
    transcript: str,
    asr_latency_s: float,
    audio_presence: object,
    asr_source: str = "inline",
) -> tuple[dict, dict]:
    """ADAAAA-8056 (AC-E2): the per-window audio-coverage record.

    Returns ``(audio_context, flat_timings)``: the block the caller sees as
    ``audioContext`` on the decision, and the flat form stamped onto the audit
    record's ``timings``. Computed BEFORE the audit record is built so the JSONL
    written to DECIDE_AUDIT_DIR carries the same coverage as the server's
    decide_audit row; stamping it only after ``_emit_audit`` left the on-disk
    trail with zero audio fields, which reads as "no audio" to an offline grade.
    """
    # `path` reports which audio channel the model actually received: native
    # `input_audio` when raw send is on (GEMMA_SEND_AUDIO=1, ADAAAA-6350), else
    # the ASR->text transcript (Path 2), else "none" when no audio entered.
    send_audio_active = bool(audio_b64) and os.environ.get("GEMMA_SEND_AUDIO", "0") == "1"
    # `windowAudioPresent` says whether this window carried ANY audio (the server
    # reports the tap span + clip bytes), and `noAudioReason` NAMES why nothing
    # was transcribed — otherwise a no-audio window is indistinguishable from a
    # transcribed-to-empty one, which is exactly the inference AC-E2 forbids.
    presence = audio_presence if isinstance(audio_presence, dict) else {}
    try:
        presence_clip_bytes = int(presence.get("clipBytes") or 0)
    except (TypeError, ValueError):
        presence_clip_bytes = 0
    try:
        presence_tap_chunks = int(presence.get("tapChunks") or 0)
    except (TypeError, ValueError):
        presence_tap_chunks = 0
    # ADAAAA-8056: the server states whether the window clip was ALLOWED onto the
    # live payload (LIVE_DECIDE_AUDIO_CLIP, the ADAAAA-7777 trim). A gated window
    # is a named posture, not a retention gap and not a silent stream.
    clip_enabled = presence.get("clipEnabled") is not False
    window_audio_present = bool(audio_b64)
    no_audio_reason = ""
    if not window_audio_present:
        if not clip_enabled:
            no_audio_reason = "audio_clip_disabled"
        elif presence_tap_chunks > 0:
            # The tap banked chunks but this window's clip is empty: the window
            # fell outside the retained span (retention gap), not a silent stream.
            no_audio_reason = "retention_gap"
        else:
            no_audio_reason = "no_audio_clip"
    elif not asr_ran and not send_audio_active:
        no_audio_reason = "asr_unavailable" if not _asr_url() else "audio_context_off"
    audio_context = {
        "path": "input_audio" if send_audio_active else ("asr_text" if asr_ran else "none"),
        "transcribed": bool(transcript),
        "asrRan": asr_ran,
        "asrLatencyS": asr_latency_s,
        # ADAAAA-8081: WHERE the transcript came from — `prefetch` (the server's
        # fire-time side lane, i.e. transcribed outside this decide call) or
        # `inline` (this call ran ASR itself, the pre-8081 path). A leg grades the
        # migration from this key, not by inferring it from latency.
        "asrSource": asr_source,
        "windowAudioPresent": window_audio_present,
        "noAudioReason": no_audio_reason,
    }
    flat_timings = {
        "audioPath": audio_context["path"],
        "asrRan": asr_ran,
        "asrLatencyS": round(asr_latency_s, 3),
        "asrSource": asr_source,
        "windowAudioPresent": window_audio_present,
        "noAudioReason": no_audio_reason,
        "audioTapChunks": presence_tap_chunks,
        "audioClipBytes": presence_clip_bytes,
    }
    return audio_context, flat_timings


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
    audit_ctx: dict | None = None,
    story_so_far: str = "",
    compact: bool = False,
    match_context: object = None,
    prior_game_state: object = None,
    perceive_window: object = None,
    audio_timings: dict | None = None,
    request_parse_ms: float | None = None,
) -> dict | None:
    """Call the gemma multimodal completion (vLLM OpenAI-compat server). Returns
    a parsed/validated HighlightDecision dict, or None on any transport/parse
    failure.

    Follows the Gemma 4 12B video+audio modality-order guidance: all image
    content (temporal frame sequence + crops) comes BEFORE the text prompt,
    and any audio comes AFTER the text. Audio is mono 16 kHz float32 (wav).
    The `model` field is sent when GEMMA_MODEL is set (vLLM requires it to
    match the served model name).

    When ``audit_ctx`` is given (sessionId/jobId/groupKey/candidates), the
    exact request and raw reply are also captured into an audit record
    written to DECIDE_AUDIT_DIR (see _audit_record / _emit_audit) so the
    model's input+output can be re-created and replayed later."""
    import httpx

    started_at = time.time()
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

    # ADAAAA-8344: stage clocks for this decide call. `promptBuildMs` covers the
    # image/content assembly + the prompt parts + the request payload, i.e. the
    # whole pre-network cost of the call; `vllmMs` the model round trip;
    # `parseReplyMs` the reply parse + contract guard; `auditWriteMs` the audit
    # record build + JSONL append. `requestParseMs` (arrival -> parsed body) is
    # stamped by the HTTP layer and passed in.
    t_prompt = time.time()

    def _img(part: dict) -> dict | None:
        b64 = part.get("base64") or part.get("image") or ""
        if not b64:
            return None
        return {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}

    # 1) frames + images (all image content) BEFORE the text prompt
    content: list = [i for i in (_img(p) for p in frames + images) if i is not None]
    # 2) the text part, in the middle. has_audio reflects whether audio bytes
    # actually reach the model (send_audio), never whether the caller supplied
    # them — we must not tell the model "audio provided: yes" when it is not.
    # ADAAAA-7155 Incr A: the exact built prompt is captured once here and reused
    # for the request AND recorded on the returned decision as `analysis.prompt`.
    # ADAAAA-7993: the request is laid out v2 — the STATIC preamble + output
    # contract live in the system turn, and the user text part carries ONLY the
    # per-window Context block, so the static block is a reusable prefix.
    parts = build_prompt_parts(
        event_type,
        evidence,
        game_hint,
        n_frames=len(frames),
        has_audio=bool(send_audio or transcript),
        transcript=transcript,
        story_so_far=story_so_far,
        compact=compact,
        match_context=match_context,
        prior_game_state=prior_game_state,
        perceive_window=perceive_window,
    )
    prompt = parts["prompt"]
    content.append({"type": "text", "text": parts["context"]})
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
    # Under vLLM (ADAAAA-6695) Gemma 4 reasoning is disabled BY DEFAULT, and
    # the OpenAI-compat server maps `reasoning_effort: "none"` to
    # chat_template_kwargs enable_thinking=false. We ALSO set
    # chat_template_kwargs.enable_thinking=false explicitly (the documented
    # vLLM channel) so strict JSON returns immediately regardless of the vLLM
    # version's default / auto-injection behaviour; it can never ENABLE thinking.
    payload = {
        "messages": _messages("single", content, system_content=parts["system"]),
        "temperature": 0.0,
        # Frontend-selectable; "none" (the default) turns OFF gemma-4 QAT thinking
        # so content comes back as the JSON immediately instead of empty until a
        # long chain of thought ends (see decide tests for the ordering of the
        # image/text/audio modalities).
        "reasoning_effort": reasoning_effort,
        # vLLM-equivalent thinking-off knob (Gemma 4 template exposes
        # enable_thinking). Explicit so a vLLM build that keeps thinking on by
        # default still returns the JSON immediately.
        "chat_template_kwargs": {"enable_thinking": False},
        # ADAAAA-7781: the compact live contract needs far fewer output tokens;
        # capping the completion keeps a rambling reply from paying the full
        # decode cost it no longer needs (the full contract keeps its 1200).
        "max_tokens": 400 if compact else 1200,
        "stream": False,
    }
    # llama-server is fine without "model"; OpenAI-compatible servers (Ollama)
    # require it. Only send it when the caller declares one (GEMMA_MODEL).
    model = os.environ.get("GEMMA_MODEL")
    if model:
        payload["model"] = model
    log.debug(
        "gemma call event=%s frames=%d images=%d audio=%s effort=%s",
        event_type, len(frames), len(images), bool(audio_b64), reasoning_effort,
    )
    prompt_build_ms = round((time.time() - t_prompt) * 1000.0, 3)
    t_vllm = time.time()
    # ADAAAA-8395 (LFR-1 AC-4): the reply's `usage` block, captured beside the
    # content. Defaults to `{"usageSource": "absent"}` so a transport failure, a
    # reply with no block, or an unreadable block all record the ABSENCE instead
    # of a fabricated zero (IN-4).
    metered: dict = {"usageSource": _USAGE_SOURCE_ABSENT}
    try:
        resp = httpx.post(url.rstrip("/") + "/v1/chat/completions", json=payload, timeout=timeout_s)
        resp.raise_for_status()
        reply = resp.json()
        text = reply["choices"][0]["message"]["content"]
        metered = usage_fields(reply)
    except Exception as e:  # noqa: BLE001
        log.error("gemma call failed event=%s url=%s: %s", event_type, url, e)
        return None
    vllm_ms = round((time.time() - t_vllm) * 1000.0, 3)
    t_parse = time.time()
    result = parse_decision(text)
    log.debug("gemma result event=%s parsed=%s", event_type, result)
    if result is None:
        log.error("gemma reply unparseable event=%s reply=%r", event_type, text[:500])
    # ADAAAA-8120: the deterministic scoring_play contract guard runs on the
    # accept path BEFORE the audit record is built, so its outcome and the
    # evidence that refuted the claim land on the decide_audit row
    # (`timings.contractGuard`) as well as on the decision
    # (`contradictedBy` / `contractGuard`) — re-gradable without a replay.
    guard_record: dict | None = None
    if result is not None:
        result, guard_record = apply_contract_guard(
            result,
            evidence,
            event_type,
            transcript=transcript,
            perceive_window=perceive_window,
        )
    parse_reply_ms = round((time.time() - t_parse) * 1000.0, 3)
    t_audit = time.time()
    _record = _audit_record(
        audit_ctx=audit_ctx,
        mode="single",
        content=content,
        payload=payload,
        raw_reply=text,
        parsed=result,
        fallback=False,
        started_at=started_at,
        prompt_layout=_prompt_layout(parts),
        # ADAAAA-8056 (AC-E1/AC-E2): the perceive + audio coverage ledgers for
        # this window, so both the server's decide_audit row AND the on-disk
        # audit record prove the enrichment actually landed.
        timings_extra={
            **(audio_timings or {}),
            # ADAAAA-8395 (LFR-1 AC-4): the per-decide gemma token meter, beside
            # the stage clocks. `usage` is present only when the upstream reply
            # carried a well-formed block; `usageSource` is always stamped
            # ("vllm" / "absent") so a missing measurement is READABLE as missing
            # rather than graded as a zero-token pass (IN-4). Additive keys only.
            **metered,
            # ADAAAA-8344: the decide-internal stage split, alongside the existing
            # `elapsedMs`/`asrLatencyS` (both kept untouched).
            "requestParseMs": round(request_parse_ms, 3) if request_parse_ms is not None else None,
            "promptBuildMs": prompt_build_ms,
            "vllmMs": vllm_ms,
            "parseReplyMs": parse_reply_ms,
            "perceiveTimeline": render_perceive_timeline(evidence, perceive_window)[1],
            # ADAAAA-8120 (AC-G5): the guard's verdict + refuting evidence.
            **({"contractGuard": guard_record} if guard_record is not None else {}),
        },
    )
    _emit_audit(_record)
    # ADAAAA-8344: the audit write cost is only knowable AFTER the append, so it
    # is stamped onto the record before the compact descriptor is built — the
    # descriptor is what the server persists to `decide_audit.timings`, so the
    # server-visible row carries it. (The on-disk JSONL line carries every other
    # stage; its own append cost is the one value it cannot report.)
    audit_write_ms = round((time.time() - t_audit) * 1000.0, 3)
    try:
        if isinstance(_record.get("timings"), dict):
            _record["timings"]["auditWriteMs"] = audit_write_ms
    except Exception:  # noqa: BLE001
        pass
    # Emit the compact audit descriptor on the decision (ADAAAA-7028 Inc 2) so
    # the server can index it. The descriptor is attached to the returned dict;
    # it never carries the base64 media bytes (those stay in the audit dir).
    if result is not None:
        result["audit"] = _audit_descriptor(_record)
        # ADAAAA-7155 Incr A: capture the per-window analysis block — the exact
        # prompt, the ordered dataItems, the frame/image refs, the audio/asr
        # context and the full response. Observability only; never a parse gate.
        result["analysis"] = _window_analysis(
            prompt=prompt,
            event_type=event_type,
            evidence=evidence,
            game_hint=game_hint,
            n_frames=len(frames),
            n_images=len(images),
            send_audio=send_audio,
            transcript=transcript,
            story_so_far=story_so_far,
            audio_sample_rate=audio_sample_rate,
            frames=frames,
            images=images,
            response=_response_block(result),
            match_context=match_context,
            prior_game_state=prior_game_state,
            perceive_window=perceive_window,
        )
    return result


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
    audit_ctx: dict | None = None,
    story_so_far: str = "",
    compact: bool = False,
    match_context: object = None,
    prior_game_state: object = None,
    perceive_window: object = None,
    audio_presence: object = None,
    # ADAAAA-8081: the server's fire-time ASR side lane already transcribed this
    # window's clip. `asr_prefetched=True` means "do NOT run ASR here" — consume
    # the transcript instead, so the decide call is gemma only and the
    # transcription overlaps the decide that was already in flight. False (the
    # default, and the fallback whenever the prefetch failed/timed out) keeps the
    # inline ASR path byte-identical to the pre-8081 build.
    asr_prefetched: bool = False,
    asr_transcript: str = "",
    asr_latency_s: float = 0.0,
    # ADAAAA-8344: arrival -> parsed-request-body wall measured by the HTTP layer,
    # forwarded into the audit record's `timings.requestParseMs`.
    request_parse_ms: float | None = None,
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
    # ADAAAA-8081: the incoming `asr_latency_s` argument is the side lane's
    # measured ASR time; the working local is reset to 0 below for the inline
    # path, so capture the argument BEFORE that reset.
    prefetched_latency_s = float(asr_latency_s or 0.0)
    asr_latency_s = 0.0
    asr_ran = False
    # ADAAAA-8081: prefer the server's side-lane transcription. It is the SAME
    # clip (server `windowAudioSlice` -> payload `audioB64`), produced before the
    # decide call, so consuming it here takes the 0.7-5.5 s ASR off this call's
    # critical path without changing the prompt one byte: `transcript` feeds
    # exactly the same `audio commentary transcript (ASR)` line. `asr_ran` stays
    # true (the window WAS transcribed) so the AC-E2 coverage block is intact.
    asr_source = "none"
    if asr_prefetched:
        transcript = usable_transcript(asr_transcript or "")
        asr_latency_s = prefetched_latency_s
        asr_ran = True
        asr_source = "prefetch"
    elif (
        audio_b64
        and not (os.environ.get("GEMMA_SEND_AUDIO", "0") == "1")
        and os.environ.get("AUDIO_CONTEXT", "1") == "1"
    ):
        asr_url = _asr_url()
        if asr_url:
            transcript, asr_latency_s = transcribe_audio(asr_url, audio_b64, audio_sample_rate)
            asr_ran = True
            asr_source = "inline"
    # ADAAAA-8056 (AC-E2): compute the coverage block BEFORE the gemma call so
    # the audit record emitted inside `ask` carries it (the previous placement
    # stamped only the response descriptor, so the on-disk audit trail had no
    # audio fields at all). Same dict feeds `result["audioContext"]` below.
    audio_context, audio_timings = _audio_coverage(
        audio_b64=audio_b64,
        asr_ran=asr_ran,
        transcript=transcript,
        asr_latency_s=asr_latency_s,
        audio_presence=audio_presence,
        asr_source=asr_source,
    )
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
        audit_ctx=audit_ctx,
        story_so_far=story_so_far,
        compact=compact,
        match_context=match_context,
        prior_game_state=prior_game_state,
        perceive_window=perceive_window,
        audio_timings=audio_timings,
        request_parse_ms=request_parse_ms,
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
            # Increment F / ADAAAA-6465: the deterministic rule also emits the
            # outcome taxonomy so the response shape is identical on both paths.
            "outcome": _rule_outcome(d),
            # ADAAAA-8325 (Inc 2): the deterministic fallback NEVER guesses a
            # phase — a CPU-host rule path has no footage read, so the field is
            # None (unknown), exactly like an absent model reply.
            "phase": d.phase,
            "nearMiss": _rule_outcome(d) == "near_miss",
            "source": "rule-fallback",
        }
    # ADAAAA-7111 (Increment D): carry the running video summary (story-so-far).
    # Gemma's updated summary is returned bounded; on the rule-fallback path (or
    # when the model omitted it) synthesise a deterministic extension of the
    # prior summary so the summary still GROWS monotonically across ticks.
    rs = (result.get("runningSummary") or "").strip()
    if rs:
        rs = _compile_summary(rs)
    else:
        rs = _rule_summary(story_so_far, result.get("outcome") or "not_highlight", event_type, result.get("reason"))
    result["runningSummary"] = rs
    # The audio-context readout goes on the decision: `audioContext` was computed
    # ahead of the call (see _audio_coverage) so the coverage reported to the
    # caller is exactly the coverage stamped on the audit record.
    result["audioContext"] = audio_context
    # ADAAAA-7155 Incr A: finalize the per-window analysis block. On the gemma
    # path the prompt/dataItems were captured inside `ask`; here we sync the full
    # response (incl. the just-computed audioContext + runningSummary) and the
    # ASR latency. On the rule-fallback path `ask` returned None, so we build the
    # analysis from the deterministic rule inputs directly (records what the
    # fallback was fed; prompt is empty — no model call happened).
    _an = result.get("analysis")
    if isinstance(_an, dict):
        _an["response"] = _response_block(result)
        ac = result["audioContext"]
        if isinstance(_an.get("audio"), dict):
            _an["audio"]["path"] = ac.get("path", "none")
        if isinstance(_an.get("asr"), dict):
            _an["asr"]["latencyS"] = asr_latency_s
    else:
        result["analysis"] = _window_analysis(
            prompt="",
            event_type=event_type,
            evidence=evidence,
            game_hint=game_hint,
            n_frames=len(frames or []),
            n_images=len(images or []),
            send_audio=False,
            transcript=transcript,
            story_so_far=story_so_far,
            audio_sample_rate=audio_sample_rate,
            frames=frames,
            images=images,
            response=_response_block(result),
            match_context=match_context,
        )
        # rule fallback: no model call, so no audio channel reached the model
        if isinstance(result["analysis"].get("audio"), dict):
            result["analysis"]["audio"]["path"] = "none"
    log.debug(
        "gemma decide event=%s source=%s is_highlight=%s score=%s outcome=%s phase=%s audio_path=%s",
        event_type, result.get("source"), result.get("isHighlight"),
        result.get("score"), result.get("outcome"), result.get("phase"),
        result.get("audioContext", {}).get("path"),
    )
    return result


def plan_tracking_with_gemma(
    intent: str,
    category: str,
    frame: dict | None = None,
    context: dict | None = None,
    mode: str = "live",
    url: str | None = None,
    fallback: dict | None = None,
    timeout_s: float = 180.0,
    discovery_runner=None,
) -> dict:
    """What-to-track planner path (increment A — ADAAAA-6462): the decide
    brain's SINGLE-SHOT call (intent, category, one representative frame,
    context) -> a validated TrackingPlan, mirroring decide_with_gemma's
    contract — on any planner failure the caller gets a fallback plan
    (canned roster / safe default) with ``source: "planner-fallback"``, never
    None and never an exception. Increment B wires perceive to consume the
    plan; until then this is the audited call path only (no per-frame use —
    plan §9 / §14.4).

    ``discovery_runner`` (increment C — ADAAAA-6464), when provided, is a
    zero-arg callable returning a discovery block; it is invoked exactly ONCE
    at plan/re-plan cadence and its result is folded into the plan's
    ``discovery`` field (the slow caption/region pass never runs per-frame).
    """
    from .planner import plan_with_discovery  # local: keeps gemma import-light

    return plan_with_discovery(
        intent,
        category,
        frame=frame,
        context=context,
        mode=mode,
        url=url,
        timeout_s=timeout_s,
        fallback=fallback,
        discovery_runner=discovery_runner,
    )


def title_with_gemma(
    game_hint: str = "",
    event_types: list[str] | None = None,
    reasons: list[str] | None = None,
    highlight_count: int = 0,
    url: str | None = None,
    timeout_s: float = 5.0,
    match_context: object = None,
) -> str | None:
    """Generate a short, human-readable job title with a TEXT-ONLY Gemma call
    (ADAAAA-6798 Inc 1). Takes a compact summary (gameHint + the job's
    eventTypes + accepted-highlight reasons, plus the accepted count) and
    returns a short title string (e.g. \"Soccer — 3 goals, 1 near miss\"), or
    None on any transport/parse failure so the caller can apply its own
    fallback title. No images and no audio — this is the one lightweight
    text-only inference per completed job; it must never gate or fail the job.

    The FastAPI layer runs this in a worker thread (like the /highlight gemma
    branch, ADAAAA-6373) so /health stays responsive during the inference.
    """
    import httpx

    event_types = [str(x) for x in (event_types or [])]
    reasons = [str(x) for x in (reasons or [])]
    # ADAAAA-7856 (Stage 7): the title call names the REAL teams too, so a
    # chapter/title never invents a nationality. Absent context adds nothing
    # (the title prompt stays byte-identical to today).
    mc_block = render_match_context_block(match_context)
    prompt = (
        "You write a short title for a sports/gaming highlight reel. "
        "Return ONLY one short human-readable title (<= 12 words, no quotes, "
        "no leading/trailing punctuation).\n"
        f"Sport/game: {game_hint or 'unknown'}\n"
        f"Highlight event types: {', '.join(event_types) or 'none'}\n"
        f"Accepted highlight count: {highlight_count}\n"
        f"Highlight reasons: {'; '.join(r for r in reasons[:6]) or 'none'}\n"
        + (mc_block + "\n" if mc_block else "")
        + "Title:"
    )
    payload = {
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0,
        "reasoning_effort": "none",
        "chat_template_kwargs": {"enable_thinking": False},
        "max_tokens": 64,
        "stream": False,
    }
    model = os.environ.get("GEMMA_MODEL")
    if model:
        payload["model"] = model
    u = url or os.environ.get("GEMMA_URL", DEFAULT_GEMMA_URL)
    try:
        resp = httpx.post(u.rstrip("/") + "/v1/chat/completions", json=payload, timeout=timeout_s)
        resp.raise_for_status()
        text = resp.json()["choices"][0]["message"]["content"]
    except Exception as e:  # noqa: BLE001
        log.error("gemma title call failed url=%s: %s", u, e)
        return None
    title = (text or "").strip().strip('"').strip()
    if not title:
        return None
    return title[:120]


def _strip_json_fence_array(text: str) -> str:
    """Extract the first JSON array (```json ... ```-fenced or bare) from a
    group gemma reply, stripping surrounding prose. Returns '' when none."""

    def _first_array(s: str) -> str:
        lo = s.find("[")
        hi = s.rfind("]")
        if lo == -1 or hi == -1 or hi <= lo:
            return ""
        return s[lo : hi + 1]

    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        return _first_array(m.group(1))
    return _first_array(text)


def parse_verdicts(text: str) -> list | None:
    """Parse a GROUP gemma reply into a list of per-candidate verdict dicts.

    Robust to code fences and prose. Accepts either a top-level JSON array of
    verdict objects, or a JSON object carrying a ``verdicts``/``verdict`` list.
    Returns None on any parse/shape failure so the caller can fall back to one
    single-candidate decide per candidate (a genuine highlight is never silently
    dropped)."""
    raw: list | None = None
    seg = _strip_json_fence_array(text)
    if seg:
        try:
            raw = json.loads(seg)
        except Exception:
            raw = None
    if raw is None:
        # Try a JSON object (e.g. {"verdicts": [...]}).
        obj = None
        try:
            obj = json.loads(_strip_json_fence(text))
        except Exception:
            obj = None
        if isinstance(obj, dict):
            for key in ("verdicts", "verdict", "candidates", "results"):
                vs = obj.get(key)
                if isinstance(vs, list):
                    raw = vs
                    break
    if not isinstance(raw, list):
        return None
    out = []
    for v in raw:
        if not isinstance(v, dict):
            return None  # malformed element -> fall back
        out.append(v)
    return out


def build_group_prompt(
    candidates: list,
    game_hint: str = "",
    n_frames: int = 1,
    has_audio: bool = False,
    transcript: str = "",
    match_context: object = None,
) -> str:
    """The group-mode decide prompt. Lists every candidate (index, eventType,
    timestamp, evidence summary) and asks for a JSON ARRAY of verdicts, one per
    candidate, in order. Candidates are dicts shaped ``{eventType, timestamp,
    evidence}`` (the GroupCandidate model_dump)."""
    lines: list[str] = []
    for i, c in enumerate(candidates):
        ev = c.get("evidence") or {}
        if not isinstance(ev, dict):
            ev = {}
        reaction = ev.get("reaction") or {}
        if not isinstance(reaction, dict):
            reaction = {}
        lines.append(
            f"Candidate {i}: eventType={c.get('eventType')} timestamp={c.get('timestamp')} "
            f"trackCount={ev.get('trackCount', 0)} maxVelocity={ev.get('maxVelocity', 0)} "
            f"ocrHits={ev.get('ocrHits', 0)} scoreBoardChanged={ev.get('scoreBoardChanged')} "
            f"ballOutcome={ev.get('ballOutcome')} goalCrossed={ev.get('goalCrossed')} "
            f"audioReaction={reaction.get('crowdEnergy') or 0} humansInMotion={reaction.get('humansInMotion') or 0}"
        )
    candidates_block = "\n".join(lines)
    transcript = (transcript or "").strip()
    extra = ""
    if transcript:
        extra += "\naudio commentary transcript (ASR):\n  " + transcript[:500]
    # ADAAAA-7856: same MATCH CONTEXT block + rule as the single-candidate prompt
    # (absent == identical group prompt, no extra inference).
    mc_ctx = sanitize_match_context(match_context)
    mc_block = render_match_context_block(mc_ctx)
    if mc_block:
        extra += "\n" + mc_block
    return (
        "You are a sports/esports highlight judge. You are shown a temporal "
        "SEQUENCE of frames (extracted at 1 FPS) spanning a single 3-second "
        f"frame group ({n_frames} frames), plus, when available, the accompanying "
        "audio.\n"
        "This group may contain MULTIPLE candidate trigger events (Stage-A "
        "upstream detections). Each candidate is a HYPOTHESIS to test, NOT a "
        "fact. You must review the same frames + audio once for the WHOLE group "
        "and return an independent verdict PER candidate.\n"
        "Candidates (in order):\n" + candidates_block + "\n"
        "For each candidate, judge independently from the frames + audio whether "
        "it is a genuine highlight (scoring_play) or not. Use the same "
        "outcome taxonomy as a single review: scoring_play | near_miss | "
        "big_play | not_highlight. A GOAL is isHighlight=true only when the "
        "frames show the ball actually entered the net; absent/contradicting "
        "evidence means false.\n"
        "VERDICT COUNT IS CRITICAL: reply with EXACTLY one verdict object per "
        "candidate, in the same order as the candidate list above.\n" + extra +
        "\nNow answer with ONLY a JSON array, no markdown, no preamble, no "
        "trailing prose, exactly of this shape (one object per candidate, in "
        "order):\n"
        '[{"isHighlight": true|false, "score": 0..100, "eventType": "<type>", '
        '"reason": "<short grounded reason>", "outcome": "scoring_play|near_miss|big_play|not_highlight", '
        '"nearMiss": true|false}]'
    )


def ask_group(
    url: str,
    candidates: list,
    game_hint: str = "",
    images: list | None = None,
    frames: list | None = None,
    audio_b64: str = "",
    audio_sample_rate: int = 16000,
    reasoning_effort: str = "none",
    timeout_s: float = 180.0,
    transcript: str = "",
    match_context: object = None,
) -> list | None:
    """Call the gemma multimodal completion ONCE for the whole frame group and
    return the parsed per-candidate verdict list (or None on any failure). Same
    modality order as ``ask`` (all images BEFORE the text prompt, audio AFTER)."""
    import httpx

    frames = frames or []
    images = images or []
    send_audio = bool(audio_b64) and os.environ.get("GEMMA_SEND_AUDIO", "0") == "1"

    def _img(part: dict) -> dict | None:
        b64 = part.get("base64") or part.get("image") or ""
        if not b64:
            return None
        return {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}

    content: list = [i for i in (_img(p) for p in frames + images) if i is not None]
    # ADAAAA-7155 Incr A: capture the group prompt once for the request AND the
    # analysis block recorded on each returned verdict.
    group_prompt = build_group_prompt(
        candidates,
        game_hint,
        n_frames=len(frames),
        has_audio=bool(send_audio or transcript),
        transcript=transcript,
        match_context=match_context,
    )
    content.append({"type": "text", "text": group_prompt})
    if send_audio:
        content.append(
            {
                "type": "input_audio",
                "input_audio": {"data": audio_b64, "format": "wav"},
            }
        )
    payload = {
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.0,
        "reasoning_effort": reasoning_effort,
        "chat_template_kwargs": {"enable_thinking": False},
        "max_tokens": 2400,
        "stream": False,
    }
    model = os.environ.get("GEMMA_MODEL")
    if model:
        payload["model"] = model
    log.debug("gemma group call candidates=%d frames=%d audio=%s", len(candidates), len(frames), bool(audio_b64))
    try:
        resp = httpx.post(url.rstrip("/") + "/v1/chat/completions", json=payload, timeout=timeout_s)
        resp.raise_for_status()
        text = resp.json()["choices"][0]["message"]["content"]
    except Exception as e:  # noqa: BLE001
        log.error("gemma group call failed candidates=%d url=%s: %s", len(candidates), url, e)
        return None
    result = parse_verdicts(text)
    if result is None:
        log.error("gemma group reply unparseable candidates=%d reply=%r", len(candidates), text[:500])
        return result
    # ADAAAA-7155 Incr A: capture the per-window analysis on each returned
    # verdict (one shared group prompt + group dataItems; per-verdict response).
    for item in result:
        if isinstance(item, dict):
            item["analysis"] = _window_analysis(
                prompt=group_prompt,
                event_type="GROUP",
                evidence={},
                game_hint=game_hint,
                data_items=_build_group_data_items(
                    candidates, game_hint, len(frames), len(images),
                    bool(send_audio or transcript), transcript,
                ),
                n_frames=len(frames),
                n_images=len(images),
                send_audio=send_audio,
                transcript=transcript,
                audio_sample_rate=audio_sample_rate,
                frames=frames,
                images=images,
                response=_response_block(item),
            )
    return result


def decide_group_with_gemma(
    candidates: list,
    game_hint: str = "",
    images: list | None = None,
    frames: list | None = None,
    audio_b64: str = "",
    audio_sample_rate: int = 16000,
    reasoning_effort: str = "none",
    url: str | None = None,
    score_board_changed: bool = False,
    match_context: object = None,
) -> list[dict]:
    """Group mode: ONE gemma review of the whole 3 s frame group returns a
    verdict per candidate (same order as ``candidates``). Candidates are dicts
    shaped ``{eventType, timestamp, evidence}``.

    SAFETY (AC7): when the group reply cannot be parsed, or the returned array
    length does not equal the candidate count, FALL BACK to calling the existing
    single-candidate ``decide_with_gemma`` once per candidate — so a genuine
    highlight is never silently dropped. This is a rare path, documented."""

    u = url or os.environ.get("GEMMA_URL", DEFAULT_GEMMA_URL)
    n = len(candidates)
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
    g = ask_group(
        u,
        candidates,
        game_hint,
        images,
        frames,
        audio_b64,
        audio_sample_rate,
        reasoning_effort=reasoning_effort,
        transcript=transcript,
        match_context=match_context,
    )
    if g is not None and len(g) == n:
        results = g
    else:
        # Rare safety fallback (AC7): one single-candidate gemma decide per
        # candidate so a genuine highlight is never silently dropped.
        log.warning("gemma group verdict malformed (n=%d got=%s); falling back to per-candidate decide", n, None if g is None else len(g))
        results = []
        for c in candidates:
            ev = c.get("evidence") or {}
            if not isinstance(ev, dict):
                ev = {}
            v = decide_with_gemma(
                event_type=c.get("eventType", ""),
                evidence=ev,
                game_hint=game_hint,
                images=images,
                frames=frames,
                audio_b64=audio_b64,
                audio_sample_rate=audio_sample_rate,
                reasoning_effort=reasoning_effort,
                url=u,
                score_board_changed=bool(ev.get("scoreBoardChanged", False)),
                match_context=match_context,
            )
            results.append(v)
    return results

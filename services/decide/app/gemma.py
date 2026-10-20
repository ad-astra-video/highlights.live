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
import os
import pathlib
import re
import time
from typing import Optional

from .decider import decide

log = logging.getLogger("highlights.decide.gemma")

DEFAULT_GEMMA_URL = "http://127.0.0.1:8088"

# --- decide audit (ADAAAA-7027 / ADAAAA-7028) ---------------------------------
# Versioned system prompt so an audit record can re-create the EXACT request the
# model saw. Additive relative to the pre-audit user-only request: the current
# user prompt text (build_prompt / build_group_prompt) is preserved unchanged.
SYSTEM_PROMPT_VERSION = "1"
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


def _messages(mode: str, content: list, *, with_system: bool = True) -> list:
    """The ordered message array actually sent to gemma: optional system slot
    (role=system) then the single user message carrying the multimodal content."""
    msgs: list = []
    if with_system:
        msgs.append({"role": "system", "content": SYSTEM_PROMPT})
    msgs.append({"role": "user", "content": content})
    return msgs


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
        "nearMiss": outcome == "near_miss",
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
    """Perceive is a DATA source, not a decision signal (CEO directive for
    ADAAAA-7070).

    ``ballOutcome`` is a reported measurement from perceive's homography pass.
    It is handed to the vision model so it can weigh it against its own frame
    observation, but it is NOT a deterministic verdict: perceive detection
    reliability is not yet trusted, so a measured ``ballOutcome`` of anything
    other than ``goal`` must never veto a goal the model plainly saw in the
    frames. The model's frame-grounded PASS 1 read is the sole authority for
    GOAL/NEAR_MISS (see ``apply_frame_grounding_gate``). This gate therefore
    never rejects; retained for call-site compatibility.
    """
    return True, None


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
        # ADAAAA-7044 (geometry-agnostic re-scope): `ballInNet` is the additional
        # independent, measured goal criterion the fine-tuned "ball-in-net"
        # detector emits. It requires no field-line geometry / homography, so it
        # attests goals on small-sided cage/court content where no standard-pitch
        # homography is honestly derivable (no fabrication, ADAAAA-6485 §8).
        or e.get("ballInNet") is True
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
    """Legacy gate (ADAAAA-6610) now SUPERSEDED by the goal/net frame-grounding
    gate (ADAAAA-7070).

    Perceive is a DATA source, not a decision signal (CEO directive): a
    perceived ``ballOutcome``/``goalCrossed``/``ballInNet``/scoreboard change no
    longer attests a goal. A GOAL is surfaced only when the model's PASS 1 frame
    read plainly shows the goal (see ``apply_frame_grounding_gate``), which runs
    after finalize and is the sole GOAL authority. This gate therefore never
    rejects; retained for call-site compatibility."""
    return True, None


# --- goal/net frame-grounding gate (ADAAAA-7070) ----------------------------
#
# The accept-biased prompt + the perceive goal signals (ballOutcome=goal /
# ballInNet / goalCrossed / a scoreboard change) can together produce a "goal"
# the frames do not show: the perceive detector fires on a near-goal (ball
# tracked near the net / scoreboard OCR flicker) and the model, handed the
# hypothesis, narrates a goal it was handed. The ADAAAA-6610 attestation gate
# only requires *some* independent measured criterion; it does NOT require the
# model's PASS 1 frame read to corroborate. This gate closes that gap.
#
# The frame-grounding gate is the PRIMARY gate for both GOAL and NEAR_MISS: a
# verdict may only be surfaced as a goal when the model's independent PASS 1
# observation plainly states it SAW the ball enter the net / cross between the
# posts / the keeper beaten with the ball ending in the goal. Attestation alone
# is never sufficient (req 3: if the PASS 1 observation cannot plainly state a
# goal/net, do not surface GOAL). Real-goal recall (ADAAAA-6533 / ADAAAA-6543)
# is preserved because a real goal yields a genuine frame read; this gate never
# rejects a frame-grounded goal, and it never gates a non-goal outcome.

# The model's structured PASS-1 tri-state read of the frames. `True` here is the
# model plainly stating it SAW the ball in the net / between the posts. These
# (not the free-text reason) are the trust surface for frame-grounding, because
# the free text is exactly where the accept-biased model confabulates.
_GOAL_READ_CRITERIA = ("ballInNet", "ballCrossedLineBetweenPosts")

# A *specific, non-templated* goal read for the recall fallback: a real goal
# whose structured criterion came back null (the 1 FPS sample missed the exact
# net-entry instant) but whose observation still names, concretely, the ball in
# the net / the net rippling / the keeper beaten with the ball crossing the
# line. Requires the supporting read in the text, so a bare templated reason
# (see is_bare_templated_reason) never counts as frame-grounded.
_SPECIFIC_GOAL_READ_RE = re.compile(
    r"\b(?:ball|strike|shot|header|tap)\b[^.;]{0,45}"
    r"\b(?:into|inside|in|enter(?:s|ed|ing)?|ripples?|bulges?|settles?\s+in|ends?\s+up\s+in|tucked\s+away)\s+"
    r"(?:the\s+)?(?:net|goal|back\s+of\s+the\s+net)\b"
    r"|\b(?:cross|crosses|crossing|crossed)\s+the\s+(?:goal\s+)?line\b"
    r"[^.;]{0,45}\b(?:between\s+the\s+posts|into\s+the\s+net|and\s+in|inside)\b"
    r"|\b(?:keeper|goalkeeper|gk)\b[^.;]{0,45}\b(?:beaten|wrong\s+foot|dived\s+the\s+wrong)\b"
    r"[^.;]{0,40}\b(?:ball\s+)?(?:in\s+the\s+net|into\s+the\s+net|crosses?\s+the\s+(?:goal\s+)?line)\b",
    re.IGNORECASE,
)


# A read that explicitly says the model could NOT confirm / did NOT see the
# goal must NOT count as a frame-grounded goal read (anti-confabulation,
# ADAAAA-7070 req 6): "cannot confirm the ball entered the net" / "unclear
# whether..." is the model stating plainly it CANNOT see the goal, not a goal
# read. Guard before the positive regex so a negated / inconclusive read never
# surfaces a goal it did not observe.
_GOAL_READ_NEGATION_RE = re.compile(
    r"\b(?:cannot|can't|couldn't|unable|not)\s+(?:confirm|tell|verify|say|see)\b"
    r"|\b(?:unclear|uncertain|(?:not|no)\s+clear(?:\s+whether)?|can't\s+tell)\b"
    r"|\b(?:did\s+not|does\s+not|never|no)\s+(?:enter|entered|cross|crossed|score)\b"
    r"|\b(?:went\s+over|went\s+wide|kept\s+out|stayed\s+out|off\s+target)\b",
    re.IGNORECASE,
)


def _specific_goal_read_present(text: str) -> bool:
    """True when ``text`` names a concrete, frame-grounded goal read (the ball
    in the net / net rippling / keeper beaten with the ball crossing the line)
    and is NOT the bare templated boilerplate, and does NOT negate the goal.

    Anti-confabulation (ADAAAA-7070 req 6): a read that explicitly says the
    model could NOT confirm / did NOT see the goal ("cannot confirm the ball
    entered the net", "unclear whether...") is NOT a frame-grounded goal — it
    must state plainly it cannot see the goal/net, and that must not be treated
    as a positive read. Empty text is never specific, and a bare templated
    reason is never a supporting read."""
    if not text:
        return False
    if is_bare_templated_reason(text):
        return False
    if _GOAL_READ_NEGATION_RE.search(text):
        return False
    return bool(_SPECIFIC_GOAL_READ_RE.search(text))


def _model_plainly_saw_goal(decision: dict) -> bool:
    """True when the model's PASS 1 independent observation plainly states it
    SAW the ball enter the net / cross between the posts / the keeper beaten
    with the ball ending in the goal.

    Primary signal: ``verdict.criteria.ballInNet`` or
    ``verdict.criteria.ballCrossedLineBetweenPosts`` == True (the model's
    explicit binary frame read). Recall fallback: a specific, non-templated goal
    read named in ``independentlyObserved`` (and, if absent there, ``reason``).

    A bare templated reason, or a self-reported ``scoring_play`` verdict with no
    supporting frame read, is NOT frame-grounded (anti-confabulation,
    ADAAAA-7070)."""
    verdict = decision.get("verdict")
    if isinstance(verdict, dict):
        crit = verdict.get("criteria")
        if isinstance(crit, dict):
            for key in _GOAL_READ_CRITERIA:
                if crit.get(key) is True:
                    return True
        observed = _as_text(verdict.get("independentlyObserved"))
        if observed and _GOAL_READ_NEGATION_RE.search(observed):
            # The PASS 1 independent observation explicitly states the model
            # could NOT see / confirm the goal ("cannot confirm the ball entered
            # the net", "unclear whether..."). PASS 1 is the trust surface; a
            # self-reported `reason` that later narrates a goal must NOT override
            # it (anti-confabulation, ADAAAA-7070 req 6). Do not surface.
            return False
        if _specific_goal_read_present(observed):
            return True
    if _specific_goal_read_present(decision.get("reason") or ""):
        return True
    return False


# Frame-grounded near-miss read: the model SAW a goal objective (net / goal
# mouth / posts) AND a shot genuinely threatening it that did NOT convert — on
# target but saved/blocked, hitting the post/bar, or an on-goal shot dragged
# wide/over. Checked independently (order-independent) on the observation text,
# since the near-miss taxonomy is not one of the tri-state goal criteria.
_GOAL_OBJECTIVE_RE = re.compile(
    # compound goal-objective terms first (goalpost / goalmouth / goal frame /
    # goal line), then the standalone goal-objective words. The eval (ADAAAA-7072)
    # showed a genuine near-miss read "hits the goalpost and deflects away" was
    # suppressed because `\bpost(s)?\b` does not match inside the compound word
    # "goalpost"; recognize the goal compounds (and the goal line) so a
    # frame-grounded goal objective is corroborated.
    r"\bgoal[\s-]*(?:posts?|mouths?|frames?|lines?|bars?)\b"
    r"|\b(?:nets?|posts?|bars?|uprights?|cross[\s-]?bars?|goal)\b",
    re.IGNORECASE,
)
_GOAL_ATTEMPT_RE = re.compile(
    r"\b(?:shot|strike|header|effort|kick|ball|hit|hits|cross(?:es)?|"
    r"clear(?:s|ed|ing)|deflect(?:s|ed|ing)|rebound(?:s|ed|ing))\b",
    re.IGNORECASE,
)
_GOAL_THREAT_RE = re.compile(
    r"\b(?:blocked|block|save|saved|cleared\s+off\s+(?:the\s+)?(?:goal\s+)?line|"
    r"off\s+(?:the\s+)?(?:goal\s+)?line|"
    r"deflect(?:s|ed|ing)?|over|wide|off[-\\s]target|on[-\\s]target|"
    r"crosses?\s+the\s+(?:goal\s+)?line|beaten|tipped|parried|denied|post|bar|"
    r"crossbar|goes?\s+over|goes?\s+wide|drag(?:s|ged|ging)?\s+wide|"
    r"comes?\s+(?:back\s+)?off|rebound(?:s|ed|ing)?|"
    r"clipped\s+(?:the\s+)?(?:post|bar|upright)|into\s+the\s+goal\s+mouth)\b",
    re.IGNORECASE,
)


def _model_plainly_saw_goalnet_threat(decision: dict) -> bool:
    """True when the model's independent observation plainly states it SAW a
    goal objective (the goal mouth / net / posts) AND a shot genuinely
    threatening it that did not convert — the frame-grounded read that must
    corroborate a near-miss. Requires all three independent signals (a goal
    objective + a shot/attempt + a threat-that-did-not-convert). A near-miss
    must NOT be surfaced on a crowd-noise / thematic cue or the perceive signal
    alone (ADAAAA-7070 req 2)."""
    verdict = decision.get("verdict")
    text = ""
    if isinstance(verdict, dict):
        text = _as_text(verdict.get("independentlyObserved"))
    text = text or (decision.get("reason") or "")
    if not text:
        return False
    return bool(
        _GOAL_OBJECTIVE_RE.search(text)
        and _GOAL_ATTEMPT_RE.search(text)
        and _GOAL_THREAT_RE.search(text)
    )


def apply_frame_grounding_gate(
    decision: dict, event_type: Optional[str] = None, evidence: Optional[dict] = None
) -> tuple[bool, str | None]:
    """ADAAAA-7070: the goal/net frame-grounding gate over the model's accept.

    Returns (ok, reason). For a GOAL (`scoring_play` or a goal event) accept, the
    verdict is only surfaced when BOTH hold:
      1. the model's PASS 1 observation plainly states it SAW the goal in the
         frames (see ``_model_plainly_saw_goal``), AND
      2. at least one INDEPENDENT, measured data signal corroborates the goal
         (see ``attested_goal_criterion``: perceive ``ballOutcome=goal`` /
         ``goalCrossed`` / ``ballInNet``, or a scoreboard score change).

    The independent-data backstop (board decision 2026-10-20) is what closes the
    residual GOAL FPR: with perceive data-only, the gate previously trusted the
    model's self-reported `verdict.criteria.ballInNet` / `ballCrossed` — the
    very confabulation source — so a prompt alone could never keep FPR < 5%.
    Corroborating the model's read with an independent measured signal makes the
    model NO LONGER the sole evidence source. Neither signal is sufficient alone:
    attestation alone is never a goal (req 3), and a confabulated read with no
    independent corroboration is never a goal (the 66.7% FPR class). A frame read
    that is NOT corroborated is downgraded to ``not_highlight`` so no goal
    highlight is created from frames that do not show one. Real-goal recall is
    preserved because a real goal yields both a genuine frame read AND a score
    change / goal attestation (ADAAAA-6533 / 6543); only a goal with NEITHER is
    suppressed (the ADAAAA-7021 tradeoff the board accepted, to be quantified by
    QA).

    Runs AFTER the attestation gate so a goal the model did not actually SEE is
    caught even when a (misleading) perceive signal attested it. Never acts on a
    non-goal outcome (scoring_play stays the only true goal)."""
    if not is_goal_accept(decision, event_type):
        return True, None
    if _model_plainly_saw_goal(decision) and attested_goal_criterion(evidence):
        return True, None
    # Not both frame-grounded AND independently corroborated: do not surface a
    # GOAL. Include which leg failed so the published reason is diagnostic.
    read_ok = _model_plainly_saw_goal(decision)
    corrob_ok = attested_goal_criterion(evidence)
    decision["isHighlight"] = False
    decision["outcome"] = "not_highlight"
    decision.setdefault(
        "reason",
        "",
    )
    leg = (
        "no independent goal signal (perceive goalCrossed / ballOutcome=goal / "
        "ballInNet / scoreboard change)" if read_ok else
        "PASS 1 observation did not plainly show a goal/net"
    )
    decision["reason"] = (
        (decision.get("reason") or "")
        + "; frame-grounding gate failed: " + leg
    ).strip("; ")
    try:
        cur = decision.get("eventType") or event_type or ""
        decision["eventType"] = event_type_for_outcome("not_highlight", str(cur)) or cur
    except Exception:  # noqa: BLE001
        pass
    return False, (
        "no frame-grounded goal/net read corroborated by an independent goal "
        "signal; not surfaced as a goal"
    )


def apply_near_miss_frame_grounding_gate(decision: dict) -> tuple[bool, str | None]:
    """ADAAAA-7070: gate a NEAR_MISS on the model's frame ground of a goal/net.

    Returns (ok, reason). A near-miss is surfaced only when BOTH the
    deterministic goal-line signal (blocked / off_target) fired AND the model's
    independent observation corroborates a goal objective (mouth / net / posts)
    with a genuinely threatening shot (req 2). A near-miss on a crowd-noise /
    thematic cue or the perceive signal alone — with no frame-grounded goal/net
    read — is downgraded to ``not_highlight`` so no near-miss highlight is
    created from frames that do not show a goal being genuinely threatened.

    ``near_miss_vs_scoring_confusion`` stays 0 either way: this gate only ever
    downgrades a near-miss; it never promotes a near-miss to a scoring_play."""
    if (decision.get("outcome") or "") != "near_miss":
        return True, None
    if _model_plainly_saw_goalnet_threat(decision):
        return True, None
    decision["isHighlight"] = False
    decision["outcome"] = "not_highlight"
    decision["nearMiss"] = False
    decision.setdefault(
        "reason",
        "",
    )
    decision["reason"] = (
        (decision.get("reason") or "")
        + "; no frame-grounded goal/net read corroborating the near-miss (ADAAAA-7070)"
    ).strip("; ")
    try:
        cur = decision.get("eventType") or ""
        decision["eventType"] = event_type_for_outcome("not_highlight", str(cur)) or cur
    except Exception:  # noqa: BLE001
        pass
    return False, (
        "no frame-grounded goal/net read corroborating the near-miss; not surfaced"
    )


# --- near-miss reconciliation (ADAAAA-6481 / §8 near_miss_recall) ----------
#
# A goal-bound shot that does NOT convert is a NEAR-MISS, not a non-event:
# the deployed plan should be able to act on it. The perceived goal-line /
# --- near-miss classification (ADAAAA-6481 / §8 near_miss_recall) ----------
#
# Perceive is a DATA source, not a decision signal (CEO directive for
# ADAAAA-7070). A perceived ``ballOutcome`` of ``blocked`` / ``off_target`` is
# a reported measurement handed to the vision model so it can weigh it against
# its own frame observation; it is NOT a deterministic verdict, because perceive
# detection reliability is not yet trusted. The model's frame-grounded PASS 1
# read (a goal objective visibly threatened by a goal-bound shot that did not
# convert) is the sole authority for a NEAR_MISS (see
# ``apply_near_miss_frame_grounding_gate``). A near-miss is NEVER `scoring_play`
# (keeps near_miss_vs_scoring_confusion == 0) and is recorded distinctly but is
# not a board-accepted GOAL highlight (ADAAAA-6598: isHighlight forced False).
NEAR_MISS_BALL_OUTCOMES: tuple[str, ...] = ("blocked", "off_target")


def is_near_miss_ball_outcome(ball_outcome: Optional[str]) -> bool:
    """Whether the perceive data reports a goal-bound shot that did NOT convert
    (blocked/saved at the line, or an on-goal shot that missed). This is
    informational DATA about what perceive measured — it does NOT itself
    classify the clip: the model's frame-grounded read is the near-miss
    authority. Kept for reference/call-site compatibility.
    """
    return (ball_outcome or "") in NEAR_MISS_BALL_OUTCOMES


def reconcile_outcome_with_ball_signal(decision: dict, ball_outcome: Optional[str]) -> dict:
    """Perceive is DATA, not a decision signal (CEO directive for ADAAAA-7070).

    Formerly (ADAAAA-6481) this forced ``near_miss`` from a perceived
    ``ballOutcome`` of ``blocked``/``off_target``. Perceive detection
    reliability is not yet trusted, so a reported ``ballOutcome`` no longer
    overrides the model's frame-grounded read; a NEAR_MISS is only surfaced
    when the model's PASS 1 observation plainly saw a goal objective being
    threatened (``apply_near_miss_frame_grounding_gate``). ``decision`` is
    therefore returned unchanged. Mutates nothing and is retained for call-site
    compatibility."""
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
    corroborated-but-not-a-goal candidate. Mutates and returns `decision`.

    ADAAAA-6855: when the job explicitly requested a non-goal class in
    `prefer_labels` (near-misses/saves/red-cards/counter-attacks), a
    correctly-detected instance of that class is ACCEPTED and exported as a
    DISTINCT highlight (outcome / eventType preserved — never relabeled as a
    goal, so goal precision is unaffected). When no non-goal label is requested
    the default scoring-only gate is unchanged.
    """
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
    # Perceive is a DATA source, not a decision signal (CEO directive for
    # ADAAAA-7070). `ballOutcome` / `goalCrossed` are REPORTED MEASUREMENTS
    # from perceive's homography pass — detection reliability is not yet
    # trusted, so they are evidence you weigh against the frames, never ground
    # truth and never a hard gate. Absent == no report (decide from frames).
    outcome = evidence.get("ballOutcome")
    crossed = evidence.get("goalCrossed")
    if outcome:
        meta.append(
            f"perceive report (data, not ground truth): ballOutcome={outcome}"
            + (f", goalCrossed={crossed}" if crossed is not None else "")
        )
    else:
        meta.append("perceive report (data, not ground truth): not available for ballOutcome")
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
    audio_level_line = _audio_level_line(evidence)
    if audio_level_line:
        meta.append(audio_level_line)
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
        "the clip is a GOAL highlight ONLY when the frames plainly show the team "
        "actually SCORED — the ball entering the net / crossing the goal line "
        "between the posts / the keeper beaten with the ball ending in the goal. "
        "Judge the goal from the FRAMES FIRST (the temporal sequence you are "
        "shown); the geometric goal-line corroboration and the audio are "
        "secondary, never a substitute for a goal actually visible in the "
        "frames. Assess each explicit goal signal against the frames, mark it "
        "true ONLY when you plainly see it, false when the frames plainly show it "
        "did NOT happen, and null (unverifiable) when you cannot tell:\n"
        "- ballCrossedLineBetweenPosts: you plainly see the ball cross the goal "
        "line between the uprights;\n"
        "- ballInNet: the ball is in the net / the net ripples / the keeper is "
        "beaten and the ball ends in the goal;\n"
        "- scoreboardChanged: the scoreboard / score readout changes to reflect "
        "a goal;\n"
        "- crowdErupted: the crowd/commentary erupts consistent with a goal.\n"
        "A GOAL is confirmed (isHighlight=true) when you PLAINLY SEE the ball "
        "enter the net / cross between the posts / the keeper beaten with the "
        "ball ending in the goal. Judge BOTH directions accurately: confirm a "
        "goal when the frames show it — never downgrade a goal you clearly saw "
        "to a save or a block just to 'play it safe' (a ball that ends in the "
        "net or crosses between the posts IS a goal, whatever the crowd or a "
        "nearby keeper does); and confirm a NON-goal (saved / blocked / off "
        "target / wide / over / no goal) ONLY when the frames plainly show "
        "that. When you clearly saw a goal, set ballInNet / "
        "ballCrossedLineBetweenPosts to true and isHighlight=true.\n"
        "A goal is decided by the BALL's final position, not by who contested "
        "it: if the ball crosses the goal line between the posts or ends in the "
        "net, it is a GOAL even when a defender lunges / slides / tries to "
        "clear it on the line, a keeper dives or is beaten, or the play looks "
        "scrambled near the goal mouth. A 'block' or 'clear' is only a block or "
        "clear (near_miss / big_play) when the ball is kept OUT — it does NOT "
        "cross the line and does NOT end in the net. Do not call a scored goal "
        "a 'blocked by defenders' save just because defenders or a keeper were "
        "near the ball or touched it; look at where the ball ends up.\n"
        "When you cannot tell either way — the net-entry instant is not "
        "captured, the ball's relation to the line is unclear, or no frame "
        "clearly shows the ball in the net — set the goal criteria to null, "
        "state plainly in `independentlyObserved` that you could not confirm "
        "whether it was a goal, and do NOT invent a goal OR a save/block that "
        "the frames do not support. Then classify the outcome from the clearest "
        "thing you DID see (a goal-bound shot that did not convert = near_miss; "
        "a save / post / last-line denial = big_play; otherwise not_highlight).\n"
        "Absence of a clear goal read must NEVER resolve to an accept — do NOT "
        "infer a goal from the candidate event type, from the crowd/commentary "
        "reaction, from a perceived ballOutcome/ballInNet/scoreboard signal, or "
        "from players celebrating, unless the frames themselves plainly show the "
        "ball in the net. Only the frames (ball crossing the line / into the net "
        "/ objective taken) can make a scoring_play; the candidate type, audio, "
        "and perceived signals are never a substitute. And do NOT mark a real "
        "score as non-highlight just because the crowd stayed quiet or a "
        "perceived signal was absent. A clip with no goal AND no genuine "
        "goal-bound threat or notable play (open play, build-up, players "
        "running, warm-ups, a booking / card / foul, or a celebration with no "
        "ball in the net) is NOT a highlight.\n"
        "Attribute every goal/net detail you assert to a specific frame or "
        "signal you actually saw; if no frame or signal you were given supports "
        "a claim, do not assert it. State plainly whenever you cannot see the "
        "goal/net.\n"
        "PERCEIVE REPORT IS DATA, NOT A DETERMINATION: the context may include a "
        "reported `ballOutcome` from perceive's goal-line detection. That "
        "detection's reliability is NOT yet trusted and the report can be wrong, "
        "so treat it as one piece of evidence to weigh against the frames — never "
        "as ground truth and never as an instruction to accept or reject. Decide "
        "the goal from the frames you actually see: only a goal plainly visible in "
        "the frames (ball across the line between the posts / into the net) makes "
        "isHighlight=true. A perceive report of anything other than `goal`, or of "
        "`goal`, neither forces nor blocks your verdict; a missing report is "
        "simply no information and you decide from the frames as normal.\n"
        "Scoreboard evidence: a scoreboard score change observed during the "
        "window is corroborating evidence of a goal, but it is NEVER sufficient "
        "on its own — you must still plainly see the ball enter the net in the "
        "frames to confirm isHighlight=true (a fitted/flickering scoreboard read "
        "is a known false-trigger, so never confirm a goal on the scoreboard "
        "alone). When no scoreboard change is reported, treat that as weak/absent "
        "evidence and NEVER let its absence alone force or block a goal verdict.\n"
        "OUTCOME TAXONOMY — you must ALSO classify the outcome into EXACTLY one of "
        "the four members below and return it in the `outcome` field (increment F):\n"
        "- scoring_play: the frames show the ball/object actually crossing / "
        "converting (goal, touchdown, dunk, basket, kill, objective taken). A real "
        "score.\n"
        "- near_miss: the frames show a CLOSE CALL — a shot that hit the post/bar, a "
        "save at the line, an interception at the boundary, a denial right at the "
        "net / by the last defender — but the ball did NOT score. A near miss is "
        "NOT a scoring play, even when the crowd/commentary erupts. It IS notable "
        "and surfaces, but at a lower score.\n"
        "- big_play: non-scoring but clearly high-value — a big save, a big hit, a "
        "clutch denial, a game-changing stop.\n"
        "- not_highlight: nothing notable in the window (warm-up, lull, ordinary "
        "build-up, no close call, no score).\n"
        "FRAMES ARE THE PRIMARY EVIDENCE; audio is cheap and fallible. A crowd/ "
        "commentary eruption, a replay, or a wrong call must NEVER make you call a "
        "`scoring_play` — only the frames (ball crossing the line / into the net / "
        "objective taken) can. If the frames show the ball was saved, hit the post, "
        "was caught, or did not cross before the line, the outcome is `near_miss` "
        "or `big_play` — NEVER `scoring_play` — whatever the audio did (conflict "
        "resolves toward the frames). Conversely, do NOT upgrade a real score to "
        "`not_highlight` just because the crowd stayed quiet (audio never flips a "
        "near_miss into a scoring play, and never cancels a real one).\n"
        "A near miss scores below a scoring play but above not_highlight: keep "
        "`score` in a lower band (e.g. <60) for near_miss, and set `nearMiss`/the "
        "flag so downstream assembly can label it distinctly.\n"
        "Context:\n- " + "\n- ".join(meta) + "\n\n"
        "Now answer with ONLY one JSON object, no markdown, no preamble, no "
        "leading/trailing prose, exactly of this shape:\n"
        "{\"isHighlight\": true|false, \"score\": 0..100, \"eventType\": \"<type>\", "
        "\"reason\": \"<short grounded reason that names the deciding evidence>\", "
        "\"outcome\": \"scoring_play|near_miss|big_play|not_highlight\", "
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
    audit_ctx: dict | None = None,
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
    # Under vLLM (ADAAAA-6695) Gemma 4 reasoning is disabled BY DEFAULT, and
    # the OpenAI-compat server maps `reasoning_effort: "none"` to
    # chat_template_kwargs enable_thinking=false. We ALSO set
    # chat_template_kwargs.enable_thinking=false explicitly (the documented
    # vLLM channel) so strict JSON returns immediately regardless of the vLLM
    # version's default / auto-injection behaviour; it can never ENABLE thinking.
    payload = {
        "messages": _messages("single", content),
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
        "max_tokens": 1200,
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
    try:
        resp = httpx.post(url.rstrip("/") + "/v1/chat/completions", json=payload, timeout=timeout_s)
        resp.raise_for_status()
        text = resp.json()["choices"][0]["message"]["content"]
    except Exception as e:  # noqa: BLE001
        log.error("gemma call failed event=%s url=%s: %s", event_type, url, e)
        return None
    result = parse_decision(text)
    log.debug("gemma result event=%s parsed=%s", event_type, result)
    if result is None:
        log.error("gemma reply unparseable event=%s reply=%r", event_type, text[:500])
    _record = _audit_record(
        audit_ctx=audit_ctx,
        mode="single",
        content=content,
        payload=payload,
        raw_reply=text,
        parsed=result,
        fallback=False,
        started_at=started_at,
    )
    _emit_audit(_record)
    # Emit the compact audit descriptor on the decision (ADAAAA-7028 Inc 2) so
    # the server can index it. The descriptor is attached to the returned dict;
    # it never carries the base64 media bytes (those stay in the audit dir).
    if result is not None:
        result["audit"] = _audit_descriptor(_record)
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
        audit_ctx=audit_ctx,
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
            "nearMiss": _rule_outcome(d) == "near_miss",
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
    log.debug(
        "gemma decide event=%s source=%s is_highlight=%s score=%s outcome=%s audio_path=%s",
        event_type, result.get("source"), result.get("isHighlight"),
        result.get("score"), result.get("outcome"), result.get("audioContext", {}).get("path"),
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
    prompt = (
        "You write a short title for a sports/gaming highlight reel. "
        "Return ONLY one short human-readable title (<= 12 words, no quotes, "
        "no leading/trailing punctuation).\n"
        f"Sport/game: {game_hint or 'unknown'}\n"
        f"Highlight event types: {', '.join(event_types) or 'none'}\n"
        f"Accepted highlight count: {highlight_count}\n"
        f"Highlight reasons: {'; '.join(r for r in reasons[:6]) or 'none'}\n"
        "Title:"
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
    content.append(
        {
            "type": "text",
            "text": build_group_prompt(
                candidates,
                game_hint,
                n_frames=len(frames),
                has_audio=bool(send_audio or transcript),
                transcript=transcript,
            ),
        }
    )
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
            )
            results.append(v)
    return results

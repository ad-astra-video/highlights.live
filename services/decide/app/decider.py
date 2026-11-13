"""Decide step — notable-only highlight discernment.

Deterministic, evidence-driven rule that stands in for Gemma 4 12B on CPU
hosts (and is the fallback when Gemma fails on GPU hosts). Since ADAAAA-5778
it enforces a *notable-only* bar, not just a pass/fail score cutoff:

  A candidate is a highlight ONLY when it carries corroborating evidence AND
  (its event class is a high-value class OR its notability score clears the
  config knob `notability_min`). A bare trigger (audio gate / scene change)
  with no notable content — no tracks, no motion, no OCR, no reaction —
  is rejected outright. The gate is a pure post-process over signals we already
  have, so it adds NO inference to the Gemma path (same decide call budget).

The notability bar is a tunable config knob (`DECIDE_NOTABILITY_MIN`, default
landed on the §6 / real-feed eval set — see `evals/decide_discernment.py`),
not a hand-picked constant.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

HIGH_VALUE_EVENTS = {"KILL", "GOAL", "DUNK", "CLUTCH", "ACE", "PENTAKILL", "OVERTAKE", "KO"}

# Data-landed default notability bar (rule + Gemma paths). Landed in
# `evals/decide_discernment.py` from the labeled §6 eval set: every true
# highlight phase (goal / near_goal) is high-value so it clears via its event
# class, and every non-highlight phase (off_target / warm_up / lull / replay)
# scores below 60 — so 60 is inside the (max_false_score, min_true_score]
# separating band. See that file for the sweep table + evidence model.
DEFAULT_NOTABILITY_MIN = 60.0


def notability_min() -> float:
    """The config knob. Env `DECIDE_NOTABILITY_MIN` overrides the data-landed
    default; a non-numeric value falls back to the default (never crashes the
    paid decide path)."""
    raw = os.environ.get("DECIDE_NOTABILITY_MIN")
    if raw is None:
        return DEFAULT_NOTABILITY_MIN
    try:
        return float(raw)
    except (TypeError, ValueError):
        return DEFAULT_NOTABILITY_MIN


def normalize_event(event_type: str) -> str:
    return str(event_type or "").upper().strip()


def event_class(event_type: str) -> str:
    """Classify the candidate's event type (ADAAAA-5778): only high-value
    classes take the waived-notch path. Returns 'high' or 'ordinary'."""
    return "high" if normalize_event(event_type) in HIGH_VALUE_EVENTS else "ordinary"


# I3 (ADAAAA-6360): a detected scoreboard score change is a hard, independent
# confirmation of a goal. It forces isHighlight=true ONLY for a goal event; on
# every other event it is weak/absent evidence and never on its own confirms one.
GOAL_EVENTS = {"GOAL", "GOL"}


# ADAAAA-8844 (Inc 2): the ONE verdict that demotes a score change. A surface is
# `contradicted` only when the kit swatches printed on the bug sit outside the
# measured chromaticity bar AND no printed name matches this match — i.e. the
# score that moved belongs to a DIFFERENT game (the PIP score bug of the parent
# report). `absent` is deliberately NOT here: an unreadable surface keeps today's
# behaviour, because demoting what we cannot read spends recall on nothing.
CONTRADICTED_SURFACE = "contradicted"


def surface_allows_score_attestation(surface_identity: Optional[str]) -> bool:
    """Whether a score change may attest a goal on the measured score surface.

    Absent/unknown/`consistent` all return True (unchanged behaviour); only a
    measured `contradicted` surface refuses. Strings are matched loosely so a
    newer producer spelling cannot silently disable the guard — but an
    unrecognised value never demotes (fail-open on RECALL, which is the failure
    this increment must not cause).
    """
    return str(surface_identity or "").strip().lower() != CONTRADICTED_SURFACE


def scoreboard_forces_goal(
    score_board_changed: bool, event_type: str, surface_identity: Optional[str] = None
) -> bool:
    """True only when a score change was actually detected AND the event is a
    goal AND the surface it was measured on may attest (ADAAAA-8844).

    A contradicted surface can NEVER satisfy this, on either decide path, so a
    foreign score bug cannot force a goal even if its score change reaches decide.
    Absence or a non-goal event never forces a highlight either.
    """
    if not surface_allows_score_attestation(surface_identity):
        return False
    return bool(score_board_changed) and normalize_event(event_type) in GOAL_EVENTS


def has_corroboration(
    track_count: int = 0,
    max_velocity: float = 0.0,
    ocr_hits: int = 0,
    reaction: dict | None = None,
    score_board_changed: bool = False,
    surface_identity: Optional[str] = None,
) -> bool:
    """True when the candidate carries any corroborating evidence beyond the
    bare trigger itself: a tracked object, motion, OCR, a people-reaction
    signal (crowd energy / humans-in-motion / ball speed), or a detected
    scoreboard score change. A scene-change or audio-noise-change with NONE of
    these is a bare trigger with no notable content and must be rejected
    (acceptance criterion 1)."""
    # ADAAAA-8844: a change measured on a contradicted surface is evidence of a
    # DIFFERENT match's score, so it is not corroboration for this window either.
    if surface_allows_score_attestation(surface_identity) is False:
        score_board_changed = False
    if track_count >= 1 or max_velocity > 0 or ocr_hits > 0 or score_board_changed:
        return True
    r = reaction or {}
    if not isinstance(r, dict):
        r = {}
    try:
        ce = float(r.get("crowdEnergy", 0) or 0)
    except (TypeError, ValueError):
        ce = 0.0
    try:
        him = int(r.get("humansInMotion", 0) or 0)
    except (TypeError, ValueError):
        him = 0
    try:
        bsp = float(r.get("ballSpeedMps", 0) or 0)
    except (TypeError, ValueError):
        bsp = 0.0
    return ce > 0 or him > 0 or bsp > 0


def _rule_score(event_type: str, track_count: int, max_velocity: float, ocr_hits: int) -> tuple[float, list[str]]:
    """The deterministic notability scorecard + its reason parts. High-value
    event adds 50; corroborating evidence accumulates up to a cap."""
    ev = normalize_event(event_type)
    score = 0.0
    parts: list[str] = []
    if ev in HIGH_VALUE_EVENTS:
        score += 50
        parts.append(f"high-value event {ev}")
    if track_count >= 1:
        score += min(track_count * 10, 20)
        parts.append(f"{track_count} track(s)")
    # sustained / near movement is the strongest visual evidence available
    score += min(max_velocity / 0.5 * 20, 20)
    if max_velocity >= 0.25:
        parts.append(f"fast move {max_velocity:.2f}")
    if ocr_hits:
        score += min(ocr_hits * 5, 10)
        parts.append(f"ocr {ocr_hits}")
    return score, parts


@dataclass
class Decision:
    is_highlight: bool
    score: float
    reason: str
    event_class: str = "ordinary"
    corroborated: bool = False
    # ADAAAA-8325 (Inc 2): footage phase. The deterministic rule reads scalar
    # signals only — it has no footage read — so a CPU-host fallback returns None
    # (unknown) rather than guessing "live". Mirrors the decide response field.
    phase: str | None = None


def apply_gate(
    score: float,
    event_type: str,
    track_count: int = 0,
    max_velocity: float = 0.0,
    ocr_hits: int = 0,
    reaction: dict | None = None,
    min_notability: float | None = None,
    score_board_changed: bool = False,
    surface_identity: Optional[str] = None,
) -> tuple[bool, list[str]]:
    """The notable-only gate (shared by rule + Gemma paths). Returns
    (is_highlight, rejected_reason_parts). Enforces:
        corroborated AND (high-value class OR score >= notability_min)
    The gate only ever REJECTS — it can turn a 'yes' into a 'no', never the
    reverse — so applying it to the Gemma verdict adds no inference.

    I3 (ADAAAA-6360): a detected scoreboard score change for a GOAL event is a
    hard, independent confirmation and short-circuits the gate to ACCEPT (the
    scoreboard delta is itself strong corroboration, so it must not be rejected
    for 'bare trigger' or a low notability bar)."""
    if scoreboard_forces_goal(score_board_changed, event_type, surface_identity):
        return True, []
    corroborated = has_corroboration(
        track_count, max_velocity, ocr_hits, reaction, score_board_changed, surface_identity
    )
    if not corroborated:
        return False, ["no corroborating evidence (bare trigger)"]
    cls = event_class(event_type)
    bar = DEFAULT_NOTABILITY_MIN if min_notability is None else min_notability
    if cls == "high":
        return True, []
    if score >= bar:
        return True, []
    return False, [f"notability {score:.0f} < bar {bar:.0f}"]


def decide(
    event_type: str,
    track_count: int = 0,
    max_velocity: float = 0.0,
    ocr_hits: int = 0,
    reaction: dict | None = None,
    min_notability: float | None = None,
    score_board_changed: bool = False,
    surface_identity: Optional[str] = None,
) -> Decision:
    """Score a candidate and apply the notable-only bar. ``reaction`` is the
    INC-4 people-reaction block (corroborating evidence, never the arbiter).
    ``min_notability`` overrides the config knob for callers that want to
    evaluate a sweep (the eval harness).

    I3 (ADAAAA-6360): when a scoreboard score change was detected for a GOAL
    event the candidate is forced to isHighlight=true; otherwise the scoreboard
    field is weak/absent evidence and never on its own forces a goal."""
    ev = normalize_event(event_type)
    score, parts = _rule_score(event_type, track_count, max_velocity, ocr_hits)
    cls = event_class(ev)
    ok, rejects = apply_gate(
        score, event_type, track_count, max_velocity, ocr_hits, reaction, min_notability,
        score_board_changed, surface_identity,
    )
    if scoreboard_forces_goal(score_board_changed, event_type, surface_identity):
        ok = True
        rejects = []
        reason_parts = parts + ["scoreboard score change confirmed"]
    elif score_board_changed and not surface_allows_score_attestation(surface_identity):
        # ADAAAA-8844 (scope item 5): name the demotion, so a window that was not
        # accepted says WHY instead of looking like evidence-free footage.
        reason_parts = parts + rejects + [
            "score change on a contradicted score surface: ignored"
            " (the score bug printed different kit colours and none of this match's names)"
        ]
    else:
        reason_parts = parts + rejects
    reason = "; ".join(reason_parts) if reason_parts else "no strong evidence"
    return Decision(
        is_highlight=ok,
        score=round(score, 1),
        reason=reason,
        event_class=cls,
        corroborated=has_corroboration(
            track_count, max_velocity, ocr_hits, reaction, score_board_changed, surface_identity
        ),
        # ADAAAA-8325 (Inc 2): explicit — the rule never knows the footage phase.
        phase=None,
    )

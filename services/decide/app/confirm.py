"""Stage-2 goal/near-miss CONFIRMATION pass (ADAAAA-6797).

The primary decide read ([ADAAAA-6465](/ADAAAA/issues/ADAAAA-6465)) is a single
Gemma pass over a coarse ~1 FPS window. A goal-type candidate that carries NO
independent attestation (no perceive ``ballOutcome=goal`` / ``goalCrossed`` /
scoreboard score change) can still be mislabeled a GOAL when the exact
crossing/conversion instant falls between the sampled frames.

This module implements the **residual guard**: a second, higher-fidelity
confirmation read that runs ONLY for goal-type candidates with no independent
attestation. It:

- presents the Stage-1 verdict + reason back to the model;
- prompts the model to explicitly test the **contradictory hypothesis**
  ("is this actually a near miss / did the ball NOT go in?");
- gives the model richer context: a denser frame window (~10-15 fps over
  +/-3-5 s) plus precise pre-event / event-instant / post-event keyframes,
  object/ball **trajectory tracks** (Florence-2 / SAM3), **motion / optical-flow**
  magnitude, and the **audio-energy envelope + ASR transcript** (explicitly
  fallible);
- treats any independent corroboration as **input, never a gate** (preserves
  [ADAAAA-6543](/ADAAAA/issues/ADAAAA-6543));
- emits the structure ``goalConfirmed: confirmed_goal | near_miss | not_goal``
  with per-evidence fields and confidence;
- **deterministically reconciles** the verdict into the final highlight decision:
  ``confirmed_goal`` -> ``scoring_play`` goal highlight; ``near_miss`` ->
  ``near_miss`` (surfaced distinctly, never a board goal — ADAAAA-6598);
  ``not_goal`` -> not a highlight.

Config flag ``DECIDE_CONFIRM_ENABLED`` (default ``0``) gates the pass. When
disabled, or on ANY model/parse failure, the endpoint returns a **passthrough**
that leaves the Stage-1 decision unchanged (no regression, no crash) — so the
server can call it safely during VOD-first rollout before the live config flag.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger("highlights.decide")

from .gemma import (  # noqa: E402
    DEFAULT_GEMMA_URL,
    _as_text,
    _strip_json_fence,
    _asr_url,
    _media_refs,
    transcribe_audio,
)

# The closed confirmation taxonomy (mirror of the plan: confirmed_goal |
# near_miss | not_goal).
CONFIRM_VALUES: tuple[str, ...] = ("confirmed_goal", "near_miss", "not_goal")

# ---------------------------------------------------------------------------
# Goal corroboration gate (ADAAAA-7162, CEO feedback on ADAAAA-7134).
#
# The model's decide/confirm read frequently fabricates a goal ("ball clearly
# enters the net / goalkeeper beaten") even for a near-miss, a saved/blocked
# shot, or a pure dribble, with no independent corroboration. The confirm pass
# previously treated corroboration as "INPUT ONLY, never a gate", so a
# self-reported `confirmed_goal` with no corroborating signal was accepted as a
# real GOAL. Per the CEO, a GOAL is accepted on the confirm pass ONLY when the
# deep frame dive confirms the ball is actually in the net AND there is at
# least one INDEPENDENT corroboration signal:
#   - a scoreboard change to the correct value, or
#   - audio/commentary text that calls the goal ("GOOOAL", "it's in",
#     team-scored phrasing).
# A `confirmed_goal` verdict with no independent corroboration is downgraded to
# `near_miss` regardless of the model's self-reported confidence. The gate is
# deterministic and live on the confirm path (DECIDE_CONFIRM_ENABLED=1).
#
# ADAAAA-7402: during a penalty shootout the aggregate score is FIXED (it stays
# 2-2), so no converted penalty ever produces a main-score change. The gate
# therefore also credits a PENALTIS-tally increment OR a ball-in-net attestation
# as independent corroboration when the deep dive detects a shootout
# (`evidence.penaltyShootout`), while the bare-ball-in-net guard (ADAAAA-7162)
# still holds outside a shootout so saves / misses stay rejected. It also
# credits an explicit score transition the deep dive NARRATES in its reason
# (AC1, the 2-1 -> 2-2 regulation equalizer), mirroring the delayed-scoreboard
# credit.
# ---------------------------------------------------------------------------

# Goal-calling audio/commentary phrasing (lower-cased). Conservative: only
# unambiguous goal calls. "goal" alone is excluded (a replay / general
# narration can say "the goal" without a goal having just been scored).
_GOAL_CALL_PATTERNS: tuple[str, ...] = (
    "goooal", "gooal", "goall ", "it's in", "its in", "it is in",
    "its in the net", "in the net", "goal!", "goal for", "that's a goal",
    "thats a goal", "what a goal", "scores!", "scored", "find the net",
    "back of the net", "top corner", "net bulging", "a goal at",
)


def audio_calls_goal(transcript: str | None) -> bool:
    """Whether the (fallible) ASR commentary text calls a goal.

    Conservative substring/heuristic match over the lower-cased transcript.
    Used as ONE independent corroboration signal on the confirm pass. Never
    raises; empty/None input is False (no text is never corroboration)."""
    t = (transcript or "").strip().lower()
    if not t:
        return False
    return any(p in t for p in _GOAL_CALL_PATTERNS)


# ADAAAA-7402 (AC1): a regulation goal whose scoreboard change the deep-dive
# model NARRATES but did not record in the structured ``evidence.scoreboardChanged``
# field (leaving it null) still gets downgraded. Detect an explicit score
# transition in the deep-dive reason text so that a "scoreboard updates from
# 2-1 to 2-2" read is credited as a frame scoreboard change, exactly like the
# structured field (ADAAAA-7357). Conservative: only an explicit home-away score
# transition or a "scoreboard ... change/update/tick/now ... N-M" phrase fires;
# bare narration without a literal score never does.
_SCORE_DELTA_RE = re.compile(
    r"(?:"
    r"\bfrom\b[^\n]{0,12}?\b\d{1,2}\s*[-–—]\s*\d{1,2}\b[^\n]{0,24}?\bto\s+\d{1,2}\s*[-–—]\s*\d{1,2}\b"
    r"|"
    r"\b(?:scoreboard|score)\b[^\n]{0,50}?\b(?:change[ds]?|updat(?:e|ed|ing)|tick(?:s|ed|ing)?|now\b|reads?\b|moves?\b|turns?\b)\b[^\n]{0,50}?\b\d{1,2}\s*[-–—]\s*\d{1,2}\b"
    r"|"
    r"\b\d{1,2}\s*[-–—]\s*\d{1,2}\b[^\n]{0,24}?\bto\s+\d{1,2}\s*[-–—]\s*\d{1,2}\b"
    r")",
    re.IGNORECASE,
)


def reason_asserts_scoreboard_change(reason: str | None) -> bool:
    """Whether the deep-dive ``reason`` text asserts a scoreboard score change.

    ADAAAA-7402 (AC1): the model sometimes narrates the scoreboard delta (e.g.
    "scoreboard updates from 2-1 to 2-2") in its free-text reason but reports
    ``evidence.scoreboardChanged`` as null, so the structured ADAAAA-7357 credit
    misses it and the corroboration gate downgrades a real regulation goal.
    This conservative detector credits an EXPLICIT score transition or a
    scoreboard-change phrase coupled to a literal ``N-M`` score, mirroring the
    delayed-scoreboard credit. Never raises; no literal score transition ->
    False (so a bare "ball in the net" narration adds no corroboration)."""
    r = (reason or "").strip().lower()
    if not r:
        return False
    return _SCORE_DELTA_RE.search(r) is not None


# ADAAAA-7402 (penalty-recall follow-up): the deep-dive sometimes describes a
# penalty shootout in its free-text reason while leaving the structured
# ``evidence.penaltyShootout`` flag null (the PENALTIS tally line is not clearly
# legible in the narrower frame window). Since a shootout conversion is
# corroborated by the model's ``confirmed_goal`` read, and a save / miss never
# returns ``confirmed_goal``, recognizing the shootout from narration (in
# addition to the structured flag) lets an ATTESTED conversion surface without
# admitting a non-goal (AC3). Conservative: only strong shootout phrasing fires.
_SHOOTOUT_RE = re.compile(
    r"(?:penalty shootout|penalt(?:y|ies)[^\n]{0,24}?(?:tally|converted|scored)"
    r"|shootout)",
    re.IGNORECASE,
)


def reason_asserts_penalty_shootout(reason: str | None) -> bool:
    """Whether the deep-dive ``reason`` text describes a penalty shootout.

    Used to broaden shootout detection beyond the structured
    ``evidence.penaltyShootout`` flag (ADAAAA-7402 penalty-recall follow-up).
    Only strong shootout phrasing fires; never raises; no shootout phrasing ->
    False, so an ordinary goal narration adds no shootout context."""
    r = (reason or "").strip().lower()
    if not r:
        return False
    return _SHOOTOUT_RE.search(r) is not None


def confirm_requires_corroboration() -> bool:
    """Whether the confirm pass gates a confirmed_goal on an independent
    corroboration signal. Default ON (the CEO requirement); set
    ``DECIDE_CONFIRM_REQUIRE_CORROBORATION=0`` to restore the legacy
    frame-only behavior in an emergency (e.g. clips with no commentary)."""
    return os.environ.get("DECIDE_CONFIRM_REQUIRE_CORROBORATION", "1") == "1"


def goal_corroborated(*, scoreboard_changed: bool, transcript: str | None,
                      frame_scoreboard_changed: bool = False,
                      penalty_shootout: bool = False,
                      penalty_tally_changed: bool = False,
                      ball_in_net: bool = False,
                      ball_in_net_refuted: bool = False,
                      goal_confirmed: str = "") -> bool:
    """True when at least one INDEPENDENT corroboration signal is present.

    The independent anchor is a scoreboard change OR goal-calling audio text.

    ``scoreboard_changed`` is the deterministic perceive-OCR flag fed from the
    server — the ONLY scoreboard signal credited. It is a REAL measured
    pre->post numeric score delta (perceive ``score_changed`` semantics: both
    sides parsed + differ). A model-inferred scoreboard claim —
    ``frame_scoreboard_changed`` (the deep-dive's own frame read) or a free-text
    ``scoreboard change`` narration — is NOT independent corroboration
    (ADAAAA-7510): a celebration-derived scoreboard claim was exactly the
    post-bounce fabrication accepted as a scoring GOAL. A self-reported
    ball-in-net read alone is also NOT independent corroboration (ADAAAA-7162
    guard); only a measured scoreboard tick or a goal call anchors the visual
    read.

    ADAAAA-7402 (AC2): during a penalty shootout the aggregate score is fixed
    (it stays 2-2) so a converted penalty NEVER produces a main-score change —
    yet it is still a real goal. So when the deep dive detects a shootout
    (``penalty_shootout`` — the scoreboard shows a PENALTIS tally line) OR
    reports a penalty-tally increment (``penalty_tally_changed``), a
    penalty-tally increment OR the model's ball-in-net attestation
    (``ball_in_net``) is treated as SUFFICIENT independent corroboration.
    Outside a shootout the ADAAAA-7162 guard unwinds: a bare ``ball_in_net``
    read with no scoreboard / goal-call signal still is NOT independent
    corroboration, so saves / misses stay rejected.

    ADAAAA-7402 (penalty-recall follow-up, CEO "too strict"): the deep-dive
    sometimes returns ``confirmed_goal`` (its high-fidelity read that the ball
    entered the net) but leaves ``penaltyTallyChanged`` / ``ballInNet`` NULL
    (the tally / crossing is not legible in its narrower frame window), which
    previously downgraded an ATTESTED conversion to near_miss. Since a
    ``confirmed_goal`` verdict IS the model's ball-in-net attestation, in a
    detected shootout it is credited as corroboration — BUT ONLY when the deep
    dive did not EXPLICITLY refute the ball being in the net
    (``ball_in_net_refuted`` = ``evidence.ballInNet`` is ``false``). That
    refutation is the save / miss guard: a kick the deep dive judged SAVED /
    MISSED (ball NOT in the net) is still rejected even if it (incorrectly)
    carries a ``confirmed_goal`` verdict, so AC3 / ADAAAA-7162 hold. Outside a
    shootout a ``confirmed_goal`` is NOT auto-corroborated (the fabrication
    guard stays intact)."""
    if penalty_shootout or penalty_tally_changed:
        # An attested conversion: the deep dive confirmed the goal and did not
        # explicitly say the ball was NOT in the net. This is the recall gain
        # (the model's ball-in-net read survives even when the structured
        # penaltyTallyChanged / ballInNet tri-state is null).
        if goal_confirmed == "confirmed_goal" and not ball_in_net_refuted:
            return True
        return bool(penalty_tally_changed) or bool(ball_in_net)
    # ADAAAA-7510: scoreboard corroboration requires the deterministic MEASURED
    # pre->post numeric score delta (the perceive-OCR `scoreBoardChanged` flag,
    # score_changed semantics: both sides parsed + differ). A model read
    # (`frame_scoreboard_changed`) or a free-text narration of a scoreboard
    # change is NOT independent corroboration — a celebration-derived claim is
    # exactly the post-bounce fabrication that was accepted as a scoring GOAL.
    # Only a measured delta or a goal-calling audio text anchors the visual read.
    return bool(scoreboard_changed) or audio_calls_goal(transcript)


def confirm_enabled() -> bool:
    """Whether the Stage-2 confirmation pass is on for this deployment.

    Default OFF (VOD-first rollout; the server config-flags it to live once
    accuracy and live-latency cost are measured)."""
    return os.environ.get("DECIDE_CONFIRM_ENABLED", "0") == "1"


# --- request / response contracts -------------------------------------------


class ConfirmRequest(BaseModel):
    """The confirmation-pass request (goal-type, un-attested candidate).

    The server fires this ONLY for a goal-type candidate that carries no
    independent attestation (no ballOutcome=goal / goalCrossed / scoreboard
    change). ``stage1`` is the primary-pass verdict, presented back to the
    model and used to compute the Stage-1 vs Stage-2 disagreement rate.
    ``frames`` is the denser (~10-15 fps) temporal window; ``keyframes`` are the
    precise pre-event / event-instant / post-event stills. ``trajectories`` /
    ``opticalFlowMagnitude`` / ``flowMagnitudes`` / ``audioLevels`` / ``audioB64``
    are the richer tools/context. Any independent corroboration fields are
    INPUT for the model, never a gate."""

    model_config = ConfigDict(extra="ignore")

    sessionId: str = ""
    eventType: str = ""
    timestamp: float = 0.0
    gameHint: str = ""
    # Stage-1 primary-pass verdict (outcome/eventType/reason/score/isHighlight).
    stage1: dict = Field(default_factory=dict)
    # Denser temporal frame window (~10-15 fps) around the event instant.
    frames: list = Field(default_factory=list)
    # Precise pre-event / event-instant / post-event keyframes.
    keyframes: list = Field(default_factory=list)
    # object/ball trajectory tracks (Florence-2 / SAM3): {"label":..,"trackId":..,
    # "path":[[t,x,y],..]}
    trajectories: list = Field(default_factory=list)
    # motion / optical-flow magnitude at the event.
    opticalFlowMagnitude: float = Field(default=0.0, ge=0.0)
    flowMagnitudes: list = Field(default_factory=list)
    # short RMS audio-energy envelope.
    audioLevels: list = Field(default_factory=list)
    # audio context (Path 2 ASR transcript; raw bytes gated by GEMMA_SEND_AUDIO).
    audioB64: str = Field(default="")
    audioSampleRate: int = Field(default=16000, ge=8000, le=48000)
    # Optional independent corroboration — INPUT only, never a gate.
    ballOutcome: Optional[str] = None
    goalCrossed: Optional[bool] = None
    scoreBoardChanged: bool = False
    reasoningEffort: str = Field(default="none")


class ConfirmEvidence(BaseModel):
    """Per-evidence tri-state read the model was asked to report (I1-style).

    Each is true (plainly seen), false (plainly contradicted), or null
    (unverifiable) — so a reviewer can see exactly which signal the model could
    or could not confirm from the deep dive."""

    model_config = ConfigDict(extra="ignore")

    ballTrajectoryCrossedLine: Optional[bool] = None
    ballInNet: Optional[bool] = None
    sustainedScoringMotion: Optional[bool] = None
    audioErupted: Optional[bool] = None
    scoreboardChanged: Optional[bool] = None
    independentCorroboration: Optional[bool] = None
    # ADAAAA-7402: whether the scoreboard shows a PENALTIS shootout tally line
    # and whether that tally incremented across the deep-dive window. During a
    # shootout the aggregate score is fixed, so these are the load-bearing
    # corroboration signals for a converted penalty.
    penaltyShootout: Optional[bool] = None
    penaltyTallyChanged: Optional[bool] = None


class ConfirmDecision(BaseModel):
    """The confirmation-pass response.

    ``goalConfirmed`` is the structured verdict (``confirmed_goal`` | ``near_miss`` |
    ``not_goal``); ``confidence`` is the model's 0..1 self-confidence;
    ``evidence`` carries the per-evidence tri-state read; ``stage1Disagreed``
    records whether this pass corrected the primary read (the core value
    metric). ``decision`` is the deterministic reconcile - a
    ``HighlightDecision``-shaped dict the server can adopt directly. When the
    pass is disabled or unparseable, ``goalConfirmed`` is null and ``decision``
    is a passthrough of the Stage-1 verdict (no change, no crash)."""

    model_config = ConfigDict(extra="ignore")

    enabled: bool = False
    goalConfirmed: Optional[str] = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    reason: str = ""
    evidence: ConfirmEvidence = Field(default_factory=ConfirmEvidence)
    stage1Disagreed: bool = False
    # ADAAAA-7162: whether an independent corroboration signal (scoreboard change
    # OR goal-calling audio text) was present, and whether it is required. A
    # confirmed_goal on an un-corroborated candidate is downgraded to near-miss.
    corroborated: bool = False
    # ADAAAA-7185: WHICH independent corroboration signal fired ("scoreboard"
    # or "audio_text"), persisted so the evidence is queryable post hoc. null
    # when no independent corroboration signal was present.
    corroborationSource: Optional[str] = None
    corroborationRequired: bool = False
    # ADAAAA-7251 (ACC-3): the ASR transcript computed for this highlight's
    # audio context (Path 2, fallible) and fed to the confirm prompt. Returned
    # to the server top-level so it can be persisted on the highlight record
    # for human corroboration. "" when no audio context / ASR was not computed.
    transcript: str = ""
    decision: dict = Field(default_factory=dict)
    # ADAAAA-7155 Increment A: the confirm request/response analysis — the exact
    # confirm prompt, the request context summary (frames / keyframes /
    # trajectories / optical-flow / audio envelope / transcript / stage-1) and
    # the ConfirmDecision — so the server can record the confirm task verbatim.
    # Additive optional; absent on passthroughs that never built a prompt.
    analysis: Optional[dict] = Field(default=None)


# --- prompt -----------------------------------------------------------------


def _trajectory_lines(trajectories: list) -> list[str]:
    """Render the object/ball trajectory tracks as prompt context lines."""
    out: list[str] = []
    for tr in (trajectories or [])[:8]:
        if not isinstance(tr, dict):
            continue
        label = _as_text(tr.get("label")) or "object"
        tid = _as_text(tr.get("trackId"))
        path = tr.get("path") or []
        pts = []
        for p in path[:24]:
            if isinstance(p, (list, tuple)) and len(p) >= 3:
                pts.append(f"t={p[0]:.1f}s ({p[1]:.2f},{p[2]:.2f})")
        line = f"- {label}" + (f" (track {tid})" if tid else "") + " path: " + ", ".join(pts)
        out.append(line)
    return out


def _confirm_data_items(
    event_type: str,
    stage1: dict,
    n_frames: int,
    n_keyframes: int,
    trajectories: list,
    optical_flow: float,
    flow_magnitudes: list,
    audio_levels: list,
    transcript: str,
    ball_outcome: Optional[str],
    goal_crossed: Optional[bool],
    scoreboard_changed: bool,
) -> list:
    """Ordered, structured view of the confirm-pass request context (ADAAAA-7155
    Incr A): what the deep-frame-dive was fed, so it can be rendered item by
    item. Mirrors build_confirm_prompt's rendered lines."""
    items: list = []

    def add(typ: str, label: str, value) -> None:
        items.append({"type": typ, "label": label, "value": value})

    s1 = stage1 or {}
    add("candidate", "Candidate event type", (event_type or "").upper() or "GOAL")
    add("confirm", "Stage-1 verdict outcome", _as_text(s1.get("outcome")) or "unknown")
    add("confirm", "Stage-1 isHighlight", bool(s1.get("isHighlight")))
    add("confirm", "Stage-1 reason", _as_text(s1.get("reason")) or "none given")
    add("frames", "Dense frame window (~10-15 fps)", n_frames)
    add("frames", "Precise keyframes (pre / event / post)", n_keyframes)
    if ball_outcome:
        cv = f"ballOutcome={ball_outcome}"
        if goal_crossed is not None:
            cv += f", goalCrossed={goal_crossed}"
    else:
        cv = "not available"
    add("corroboration", "Independent corroboration (INPUT ONLY, never a gate)", cv)
    add("corroboration", "Scoreboard change", "observed" if scoreboard_changed else "none observed")
    if optical_flow:
        add("motion", "Motion / optical-flow magnitude", round(float(optical_flow), 2))
    if flow_magnitudes:
        add("motion", "Optical-flow magnitude curve",
            [round(float(v), 2) for v in (flow_magnitudes or [])[:32] if isinstance(v, (int, float))])
    if audio_levels:
        add("audio_level", "Audio-energy envelope",
            [round(float(v), 2) for v in (audio_levels or [])[:32] if isinstance(v, (int, float))])
    tt = (transcript or "").strip()
    if tt:
        add("asr", "Audio commentary transcript (ASR, fallible)", tt[:600])
    for ln in _trajectory_lines(trajectories):
        add("trajectory", "Object / ball trajectory track", ln)
    return items


def _confirm_analysis(
    prompt: str,
    event_type: str,
    stage1: dict,
    n_frames: int,
    n_keyframes: int,
    trajectories: list,
    optical_flow: float,
    flow_magnitudes: list,
    audio_levels: list,
    transcript: str,
    ball_outcome: Optional[str],
    goal_crossed: Optional[bool],
    scoreboard_changed: bool,
    frames: list,
    keyframes: list,
    decision: dict,
) -> dict:
    """Assemble the ConfirmRecord-shaped analysis block (request summary +
    decision) for a deep-frame-dive confirm task (ADAAAA-7155 Incr A)."""
    flow_nums = [round(float(v), 2) for v in (flow_magnitudes or [])[:32] if isinstance(v, (int, float))]
    level_nums = [round(float(v), 2) for v in (audio_levels or [])[:32] if isinstance(v, (int, float))]
    return {
        "request": {
            "prompt": prompt,
            "dataItems": _confirm_data_items(
                event_type, stage1, n_frames, n_keyframes, trajectories,
                optical_flow, flow_magnitudes, audio_levels, transcript,
                ball_outcome, goal_crossed, scoreboard_changed,
            ),
            "frames": _media_refs(frames),
            "keyframes": _media_refs(keyframes),
            "trajectories": [ln for ln in _trajectory_lines(trajectories)],
            "opticalFlowMagnitude": round(float(optical_flow), 2) if optical_flow else 0.0,
            "audioLevels": level_nums,
            "transcript": (transcript or "").strip(),
            "stage1": stage1,
        },
        "decision": {
            "enabled": bool(decision.get("enabled")),
            "goalConfirmed": decision.get("goalConfirmed"),
            "confidence": decision.get("confidence", 0.0),
            "reason": decision.get("reason", ""),
            "evidence": decision.get("evidence"),
            "stage1Disagreed": bool(decision.get("stage1Disagreed")),
            "outcome": (decision.get("decision") or {}).get("outcome"),
        },
    }


def build_confirm_prompt(
    event_type: str,
    game_hint: str,
    stage1: dict,
    n_frames: int,
    n_keyframes: int,
    trajectories: list,
    optical_flow: float,
    flow_magnitudes: list,
    audio_levels: list,
    transcript: str,
    ball_outcome: Optional[str],
    goal_crossed: Optional[bool],
    scoreboard_changed: bool,
) -> str:
    """Build the confirmation-pass prompt.

    Presents the Stage-1 verdict + reason and explicitly asks the model to test
    the CONTRADICTORY hypothesis (near miss / ball NOT in), over the denser
    frame + trajectory + optical-flow + audio context, and to emit structured
    ``goalConfirmed`` with per-evidence fields, before producing the
    ``HighlightDecision``-shaped reconcile fields."""

    ev = (event_type or "").upper() or "GOAL"
    s1 = stage1 or {}
    s1_outcome = _as_text(s1.get("outcome")) or "unknown"
    s1_reason = _as_text(s1.get("reason")) or "none given"
    s1_score = s1.get("score")
    try:
        s1_score = f"{float(s1_score):.0f}" if s1_score not in (None, "") else "n/a"
    except (TypeError, ValueError):  # noqa: BLE001
        s1_score = "n/a"

    meta = [
        f"candidate event type: {ev}",
        f"game hint: {game_hint or 'unspecified'}",
        f"stage-1 (primary pass) verdict: outcome={s1_outcome}, score={s1_score}, "
        f"isHighlight={'yes' if s1.get('isHighlight') else 'no'}",
        f"stage-1 reason: {s1_reason}",
        f"dense frame window (~10-15 fps): {n_frames} frames",
        f"precise keyframes (pre-event / event / post-event): {n_keyframes}",
    ]
    if ball_outcome:
        meta.append(
            f"independent corroboration (INPUT ONLY, never a gate): ballOutcome={ball_outcome}"
            + (f", goalCrossed={goal_crossed}" if goal_crossed is not None else "")
        )
    else:
        meta.append("independent corroboration (INPUT ONLY, never a gate): not available")
    if scoreboard_changed:
        meta.append("independent corroboration: scoreboard score change observed")
    else:
        meta.append("independent corroboration: no scoreboard score change observed")
    if optical_flow:
        meta.append(f"motion / optical-flow magnitude at the event: {optical_flow:.2f}")
    if flow_magnitudes:
        nums = [f"{v:.2f}" for v in (flow_magnitudes or [])[:32] if isinstance(v, (int, float))]
        if nums:
            meta.append("optical-flow magnitude curve: " + ", ".join(nums))
    if audio_levels:
        nums = [f"{v:.2f}" for v in (audio_levels or [])[:32] if isinstance(v, (int, float))]
        if nums:
            meta.append("audio-energy envelope: " + ", ".join(nums))
    transcript = (transcript or "").strip()
    if transcript:
        meta.append("audio commentary transcript (ASR, fallible):")
        meta.append("  " + transcript[:600])
    traj_lines = _trajectory_lines(trajectories)
    if traj_lines:
        meta.append("object / ball trajectory tracks:")
        meta.extend("  " + ln for ln in traj_lines)

    return (
        "You are a sports highlight CONFIRMATION judge performing a DEEP "
        f"frame-dive on a {ev} candidate that the primary pass labeled a "
        "'scoring / goal' play but which carries NO independent measured "
        "attestation. You are shown a DENSE temporal frame sequence (~10-15 fps "
        "around the event) plus precise pre-event / event-instant / post-event "
        "keyframes, and (when available) object/ball trajectory tracks, "
        "motion/optical-flow magnitude, and audio energy + transcript.\\n"
        "Your job is to CONFIRM or REFUTE the goal. The Stage-1 verdict above is "
        "a HYPOTHESIS to test, not a fact — the primary pass reads a coarse ~1 "
        "FPS window and can easily miss the exact crossing/conversion instant.\\n"
        "STEP 1 — READ THE CONTRADICTORY HYPOTHESIS FIRST. Before agreeing with "
        "the goal, EXPLICITLY test: is this actually a NEAR MISS, or did the "
        "ball/object NOT score? Consider, specifically, whether the action "
        "shows:\\n"
        "- a shot that hit the post/bar, was saved at the line, was cleared/blocked "
        "by the last defender, or went over/wide — a near miss, NOT a goal;\\n"
        "- a denial/interception at the net / uprights / hoop — a near miss or "
        "big play, NOT a score;\\n"
        "- only build-up, a warm-up, or a celebration with no ball in the net.\\n"
        "STEP 2 — WEIGH THE HIGHER-FIDELITY EVIDENCE. Use the trajectory tracks "
        "and optical-flow magnitude to judge whether the ball/object actually "
        "crossed the line / entered the uprights / hoop (sustained scoring "
        "motion) or was stopped/denied at the instant (a deny/stop is a near "
        "miss, never a score). The audio energy + ASR transcript are FALLIBLE — "
        "a crowd/commentary eruption, a replay, or a wrong call must NEVER make "
        "you confirm a goal on their own; the frames/trajectory are the primary "
        "visual evidence.\\n"
        "STEP 3 — RECONCILE with the frames AND an INDEPENDENT corroboration "
        "signal. A GOAL is only CONFIRMED when the frames show the ball actually "
        "entering the net AND at least one INDEPENDENT corroboration signal is "
        "present: a scoreboard score change, or audio/commentary text that CALLS "
        "the goal (e.g. 'GOOOAL', 'it's in', team-scored phrasing). A goal-calling "
        "commentary line is a valid independent corroboration alongside the "
        "frames; without ANY independent corroboration, do NOT confirm a goal — "
        "call it a near miss (close call that did not convert) or not a goal. "
        "If they show nothing scoring, call it not a goal.\\n"
        "If they show nothing scoring, call it not a goal.\\\\n"
        "===== PENALTY SHOOTOUT EXCEPTION =====\\\\n"
        "During a penalty shootout the AGGREGATE score is FIXED (it stays, e.g., 2-2) — "
        "only the PENALTIES tally (a separate PENALTIS line on the scoreboard, e.g. 4-5) "
        "increments when a kick is CONVERTED. So do NOT require a main score change there. "
        "When the scoreboard shows a penalty-shootout tally line set evidence.penaltyShootout=true; "
        "if the tally incremented across the window set evidence.penaltyTallyChanged=true. In that "
        "shootout case a converted penalty (ball clearly enters the net, evidence.ballInNet=true) "
        "IS a confirmed goal even though the main score did not change. A kick that is SAVED or "
        "MISSED (no ball in the net, no tally increment) is still near_miss / not_goal — only an "
        "attested conversion is a confirmed goal.\\\\n"
        "Context:\\n- " + "\n- ".join(meta) + "\\n\\n"
        "Now answer with ONLY one JSON object, no markdown, no preamble, exactly "
        "of this shape:\\n"
        "{\"goalConfirmed\": \"confirmed_goal|near_miss|not_goal\", "
        "\"confidence\": 0.0..1.0, \"reason\": \"<short grounded reason naming the "
        "deciding evidence and explicitly stating whether the ball/object "
        "crossed/converted or was denied>\", "
        "\"evidence\": {\"ballTrajectoryCrossedLine\": true|false|null, "
        "\"ballInNet\": true|false|null, \"sustainedScoringMotion\": true|false|null, "
        "\"audioErupted\": true|false|null, \"scoreboardChanged\": true|false|null, "
        "\"independentCorroboration\": true|false|null, "
        "\"penaltyShootout\": true|false|null, "
        "\"penaltyTallyChanged\": true|false|null}, "
        "\"outcome\": \"scoring_play|near_miss|big_play|not_highlight\", "
        "\"score\": 0..100, \"eventType\": \"<type>\"}"
    )


# --- parse ------------------------------------------------------------------


def _norm_evidence(raw) -> dict:
    """Coerce an arbitrary model ``evidence`` block to the ConfirmEvidence shape
    (strict tri-state: True / False / None)."""
    if not isinstance(raw, dict):
        return {}
    keys = (
        "ballTrajectoryCrossedLine",
        "ballInNet",
        "sustainedScoringMotion",
        "audioErupted",
        "scoreboardChanged",
        "independentCorroboration",
        "penaltyShootout",
        "penaltyTallyChanged",
    )
    out: dict = {}
    for key in keys:
        val = raw.get(key)
        out[key] = val if isinstance(val, bool) else None
    return out


def parse_confirm(text: str) -> dict | None:
    """Turn the model's raw text into a confirm-shaped dict, or None.

    Requires a valid ``goalConfirmed`` in the closed set; an absent/garbage
    verdict is a parse failure (the caller passthroughs)."""
    s = _strip_json_fence(text)
    try:
        data = json.loads(s)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict):
        return None
    goal = data.get("goalConfirmed")
    goal = goal.strip().lower() if isinstance(goal, str) else ""
    if goal not in CONFIRM_VALUES:
        return None
    data["goalConfirmed"] = goal
    try:
        conf = float(data.get("confidence") or 0.0)
    except (TypeError, ValueError):  # noqa: BLE001
        conf = 0.0
    data["confidence"] = max(0.0, min(1.0, conf))
    return data


# --- reconcile / disagreement ----------------------------------------------


def stage1_disagrees(stage1: dict, goal_confirmed: str) -> bool:
    """Whether the confirmation pass CORRECTED the Stage-1 primary read.

    The core value metric for the feature (Stage-1 vs Stage-2 disagreement
    rate). ``stage1`` is the primary-pass verdict; ``goal_confirmed`` is the
    confirmation verdict."""
    s1_outcome = _as_text((stage1 or {}).get("outcome")) or (
        "scoring_play" if (stage1 or {}).get("isHighlight") else "not_highlight"
    )
    s1_is_goal = s1_outcome == "scoring_play"
    if goal_confirmed == "confirmed_goal":
        return not s1_is_goal
    # the confirm verdict is near_miss / not_goal -> it refuted the goal
    return s1_is_goal


def reconcile_confirmed_goal(goal_confirmed: str, stage1: dict, comment: str = "",
                             *, corroborated: bool = True,
                             require_corroboration: bool = False) -> dict:
    """Deterministically map the confirmation verdict onto the final highlight
    decision (a HighlightDecision-shaped dict the server can adopt directly).

    - ``confirmed_goal`` -> ``scoring_play`` goal highlight (isHighlight=true);
    - ``near_miss``      -> ``near_miss`` (surfaced distinctly, lower score, and
      NEVER a board-accepted goal — ADAAAA-6598: isHighlight=false);
    - ``not_goal``       -> ``not_highlight`` (not a highlight).

    ADAAAA-7162 (CEO feedback on ADAAAA-7134): when corroboration is REQUIRED
    (``require_corroboration=True``, the confirm-pass default) a
    ``confirmed_goal`` with NO independent corroboration signal (no scoreboard
    change and no goal-calling audio text) is DOWNGRADED to ``near_miss``
    regardless of the model's self-reported confidence — because the model
    routinely fabricates a goal read ("ball clearly enters the net") for a
    near-miss / saved shot / dribble with no corroboration. ``corroborated`` is
    the deterministic independent-signal check from ``goal_corroborated``.

    Never raises; returns a valid decision dict."""
    decision: dict = dict(stage1 or {})
    try:
        sc = float(decision.get("score") or 0.0)
    except (TypeError, ValueError):  # noqa: BLE001
        sc = 0.0

    # ADAAAA-7162: a confirmed_goal that lacks independent corroboration is not
    # a real goal — downgrade to near_miss so it surfaces distinctly, never as a
    # board-accepted GOAL, regardless of the model's confidence.
    if goal_confirmed == "confirmed_goal" and require_corroboration and not corroborated:
        comment = (comment or "").strip()
        goal_confirmed = "near_miss"
        comment = (
            comment
            + ("; " if comment else "")
            + "goal read not corroborated (no scoreboard change / goal-calling audio); "
              "downgraded to near-miss"
        ).strip()

    comment = (comment or "").strip()
    if goal_confirmed == "confirmed_goal":
        decision["outcome"] = "scoring_play"
        decision["nearMiss"] = False
        decision["isHighlight"] = True
        # a confirmed goal is a real score; keep the score at least at the
        # scoring-play threshold even if Stage-1 scored it low.
        if sc < 60.0:
            decision["score"] = 60.0
        reason = "confirmation pass: goal confirmed (deep frame dive)"
    elif goal_confirmed == "near_miss":
        decision["outcome"] = "near_miss"
        decision["nearMiss"] = True
        decision["isHighlight"] = False
        if sc >= 60.0:
            decision["score"] = 55.0
        decision["eventType"] = decision.get("eventType") or "NEAR_MISS"
        reason = "confirmation pass: near miss — the play did not convert"
    else:  # not_goal
        decision["outcome"] = "not_highlight"
        decision["nearMiss"] = False
        decision["isHighlight"] = False
        reason = "confirmation pass: not a goal — not a highlight"

    if comment:
        reason = reason + "; " + comment
    decision["reason"] = ((decision.get("reason") or "") + "; " + reason).strip("; ")
    decision["goalConfirmed"] = goal_confirmed
    return decision


# --- assemble + model call --------------------------------------------------


def _call_gemma(url: str, prompt: str, frames: list, keyframes: list,
                reasoning_effort: str, timeout_s: float) -> str | None:
    """Call the gemma multimodal completion (vLLM OpenAI-compat server) with the
    confirmation prompt. Returns the raw text, or None on any transport error."""
    import httpx

    def _img(part: dict) -> dict | None:
        b64 = part.get("base64") or part.get("image") or ""
        if not b64:
            return None
        return {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}

    # All image content (dense frames + keyframes) BEFORE the text prompt.
    content: list = [i for i in (_img(p) for p in (list(frames or []) + list(keyframes or []))) if i is not None]
    content.append({"type": "text", "text": prompt})
    payload = {
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.0,
        "reasoning_effort": reasoning_effort,
        "chat_template_kwargs": {"enable_thinking": False},
        "max_tokens": 1200,
        "stream": False,
    }
    model = os.environ.get("GEMMA_MODEL")
    if model:
        payload["model"] = model
    try:
        resp = httpx.post(url.rstrip("/") + "/v1/chat/completions", json=payload, timeout=timeout_s)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]
    except Exception as e:  # noqa: BLE001
        log.error("confirm gemma call failed event=%s url=%s: %s", prompt[:30], url, e)
        return None


def run_confirmation_pass(req: dict, *, url: str | None = None) -> dict:
    """Full confirmation pass. Returns a ConfirmDecision-shaped dict, NEVER raises.

    When the pass is disabled, or the model/parse fails, returns a **passthrough**
    that leaves the Stage-1 verdict unchanged so the server can call this safely
    during VOD-first rollout before the live config flag. On success, reconciles
    the structured verdict into ``decision`` and records ``stage1Disagreed``."""

    req = req or {}
    stage1 = dict((req.get("stage1") or {}))
    enabled_flag = confirm_enabled()

    if not enabled_flag:
        return _passthrough(req, enabled=False, reason="confirmation pass disabled (DECIDE_CONFIRM_ENABLED=0)")

    # ASR transcript from the audio window (Path 2, fallible) — reuse the cheap
    # ASR endpoint; never die on an ASR glitch.
    transcript = ""
    if req.get("audioB64") and os.environ.get("AUDIO_CONTEXT", "1") == "1":
        asr_url = _asr_url()
        if asr_url:
            transcript, _ = transcribe_audio(
                asr_url, req.get("audioB64") or "", req.get("audioSampleRate", 16000)
            )

    frames = req.get("frames") or []
    keyframes = req.get("keyframes") or []
    prompt = build_confirm_prompt(
        event_type=req.get("eventType", ""),
        game_hint=req.get("gameHint", ""),
        stage1=stage1,
        n_frames=len(frames),
        n_keyframes=len(keyframes),
        trajectories=req.get("trajectories") or [],
        optical_flow=float(req.get("opticalFlowMagnitude") or 0.0),
        flow_magnitudes=req.get("flowMagnitudes") or [],
        audio_levels=req.get("audioLevels") or [],
        transcript=transcript,
        ball_outcome=req.get("ballOutcome"),
        goal_crossed=req.get("goalCrossed"),
        scoreboard_changed=bool(req.get("scoreBoardChanged")),
    )
    u = url or os.environ.get("GEMMA_URL", DEFAULT_GEMMA_URL)
    raw = _call_gemma(
        u,
        prompt,
        frames,
        keyframes,
        req.get("reasoningEffort", "none"),
        float(os.environ.get("DECIDE_TIMEOUT_S", "180")),
    )
    parsed = parse_confirm(raw) if raw else None
    if parsed is None:
        log.error("confirm reply unparseable event=%s reply=%r", req.get("eventType"), (raw or "")[:500])
        return _passthrough(req, enabled=True, reason="confirmation pass unparseable (kept Stage-1)", prompt=prompt)

    goal = parsed.get("goalConfirmed", "")
    comment = _as_text(parsed.get("reason"))
    # ADAAAA-7510: scoreboard corroboration requires a MEASURED pre->post numeric
    # scoreboard change OR goal-calling audio/commentary text) to accept a
    # confirmed_goal. Otherwise a fabricated visual read ("ball clearly enters
    # the net") for a near-miss / saved shot / dribble is downgraded to
    # near_miss, never a GOAL. The scoreboard signal is anchored ONLY on the
    # deterministic perceive-OCR flag (a REAL measured pre->post numeric score
    # delta) — a model-inferred scoreboard read (evidence.scoreboardChanged) or
    # a free-text narration is NOT independent corroboration, so a
    # celebration-derived "0-0 -> 1-0" claim can never fabricate a scoring GOAL
    # (ADAAAA-7510, post-bounce FP).
    ev = parsed.get("evidence") or {}
    # ADAAAA-7402 (penalty-recall follow-up): broaden shootout detection to also
    # include a narrated shootout (the structured penaltyShootout flag is often
    # null because the PENALTIS tally is not legible in the narrow window). A
    # ``confirmed_goal`` in a detected shootout is then sufficient corroboration.
    penalty_shootout = (ev.get("penaltyShootout") is True) or reason_asserts_penalty_shootout(comment)
    penalty_tally_changed = ev.get("penaltyTallyChanged") is True
    ball_in_net = ev.get("ballInNet") is True
    # ADAAAA-7402 penalty-recall follow-up: the save / miss guard. When the deep
    # dive EXPLICITLY refutes the ball being in the net (evidence.ballInNet is
    # false), a confirmed_goal verdict must NOT be credited as corroboration, so
    # a SAVED / MISSED penalty is still rejected even if it (incorrectly) carries
    # a confirmed_goal verdict (AC3 / ADAAAA-7162 preserved).
    ball_in_net_refuted = ev.get("ballInNet") is False
    confirmed = goal_corroborated(
        scoreboard_changed=bool(req.get("scoreBoardChanged")),
        transcript=transcript,
        frame_scoreboard_changed=False,
        penalty_shootout=penalty_shootout,
        penalty_tally_changed=penalty_tally_changed,
        ball_in_net=ball_in_net,
        ball_in_net_refuted=ball_in_net_refuted,
        goal_confirmed=goal,
    )
    decision = reconcile_confirmed_goal(
        goal, stage1, comment=comment,
        corroborated=confirmed,
        require_corroboration=confirm_requires_corroboration(),
    )
    # ADAAAA-7185: WHICH independent corroboration signal fired, persisted so the
    # evidence for an accepted GOAL is queryable after the fact. Scoreboard
    # change (incl. the shootout tally, which sits on the scoreboard) takes
    # precedence over goal-calling audio text; null when none. ADAAAA-7510: only
    # a MEASURED scoreboard delta is credited (a model read / narration is not).
    corroboration_source = None
    if penalty_shootout or penalty_tally_changed or bool(req.get("scoreBoardChanged")):
        corroboration_source = "scoreboard"
    elif audio_calls_goal(transcript):
        corroboration_source = "audio_text"

    resp = {
        "enabled": True,
        "goalConfirmed": goal,
        "confidence": parsed.get("confidence", 0.0),
        "reason": comment,
        "evidence": _norm_evidence(parsed.get("evidence")),
        "stage1Disagreed": stage1_disagrees(stage1, goal),
        # ADAAAA-7162: whether an independent corroboration signal was present.
        "corroborated": confirmed,
        "corroborationSource": corroboration_source,
        "corroborationRequired": confirm_requires_corroboration(),
        # ADAAAA-7251 (ACC-3): surface the ASR transcript to the server so it can
        # be persisted on the highlight record for human corroboration.
        "transcript": transcript,
        "decision": decision,
    }
    # ADAAAA-7155 Incr A: record the confirm request/response analysis (exact
    # prompt + request context summary + decision) so the server can record the
    # confirm task verbatim. Observability only.
    resp["analysis"] = _confirm_analysis(
        prompt=prompt,
        event_type=req.get("eventType", ""),
        stage1=stage1,
        n_frames=len(frames),
        n_keyframes=len(keyframes),
        trajectories=req.get("trajectories") or [],
        optical_flow=float(req.get("opticalFlowMagnitude") or 0.0),
        flow_magnitudes=req.get("flowMagnitudes") or [],
        audio_levels=req.get("audioLevels") or [],
        transcript=transcript,
        ball_outcome=req.get("ballOutcome"),
        goal_crossed=req.get("goalCrossed"),
        scoreboard_changed=bool(req.get("scoreBoardChanged")),
        frames=frames,
        keyframes=keyframes,
        decision=resp,
    )
    log.info(
        "confirm pass session=%s event=%s goal_confirmed=%s confidence=%.2f disagree=%s corroborated=%s source=%s",
        req.get("sessionId"), req.get("eventType"), goal, resp["confidence"], resp["stage1Disagreed"],
        confirmed, corroboration_source,
    )
    return resp


def _passthrough(req: dict, *, enabled: bool, reason: str, prompt: str = "") -> dict:
    """No-op result: the Stage-1 verdict passes through unchanged."""
    req = req or {}
    stage1 = dict(req.get("stage1") or {})
    resp = {
        "enabled": enabled,
        "goalConfirmed": None,
        "confidence": 0.0,
        "reason": reason,
        "evidence": {},
        "stage1Disagreed": False,
        "decision": stage1,
    }
    # ADAAAA-7155 Incr A: record what the confirm task was fed (or that it never
    # built a prompt on the disabled path) so the fallback is also inspectable.
    resp["analysis"] = _confirm_analysis(
        prompt=prompt,
        event_type=req.get("eventType", ""),
        stage1=stage1,
        n_frames=len(req.get("frames") or []),
        n_keyframes=len(req.get("keyframes") or []),
        trajectories=req.get("trajectories") or [],
        optical_flow=float(req.get("opticalFlowMagnitude") or 0.0),
        flow_magnitudes=req.get("flowMagnitudes") or [],
        audio_levels=req.get("audioLevels") or [],
        transcript="",
        ball_outcome=req.get("ballOutcome"),
        goal_crossed=req.get("goalCrossed"),
        scoreboard_changed=bool(req.get("scoreBoardChanged")),
        frames=req.get("frames") or [],
        keyframes=req.get("keyframes") or [],
        decision=resp,
    )
    return resp

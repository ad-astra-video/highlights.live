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
from typing import Optional, Tuple

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
#
# ADAAAA-7843 (this defect): the detector used to be ONE flat tuple matched as a
# bare substring, so retrospective stat commentary corroborated a goal:
#   - "Cristiano Ronaldo has scored seven penalties for Portugal, but he scored
#     only three goals in his previous 13 World Cup Finals"  -> True ("scored")
#   - "It's his 82nd goal for Portugal on his 151st appearance." -> True
#     ("goal for")
# while the REAL call, "It's 1-0 Portugal", matched nothing -> False.
# The detector is now three deterministic layers (no model/GPU cost):
#   1. STRONG calls — exclamatory, unambiguous, always a goal call;
#   2. WEAK phrased calls — genuinely ambiguous ("scored", "goal for", "in the
#      net"), credited only when the text is NOT retrospective-stat framing;
#   3. SCORE-TRANSITION calls — a literal N-M score next to a team/entity name
#      ("It's 1-0 Portugal"), which is the call the old tuple missed.
# Retrospective framing adds no corroboration on its own: it describes a
# player's record, not a live goal (requirement 1 of ADAAAA-7843).
_STRONG_GOAL_CALL_PATTERNS: tuple[str, ...] = (
    "goooal", "gooal", "what a goal", "net bulging", "scores!",
)

_WEAK_GOAL_CALL_PATTERNS: tuple[str, ...] = (
    "goall ", "it's in", "its in", "it is in", "it's in the net", "in the net",
    "goal!", "goal for", "that's a goal", "thats a goal", "scored",
    "find the net", "back of the net", "top corner", "a goal at",
)

# Kept as the union so a reader (or an older caller) still sees the complete
# phrasing set the detector recognizes. Prefer the two tiered tuples above:
# matching the union directly loses the retrospective-stat exclusion.
_GOAL_CALL_PATTERNS: tuple[str, ...] = (
    _STRONG_GOAL_CALL_PATTERNS + _WEAK_GOAL_CALL_PATTERNS
)

# ADAAAA-7843 (requirement 1): retrospective-stat framing. These phrases
# describe a player's/team's record ("has scored seven penalties for Portugal",
# "his previous 13 World Cup Finals", "82nd goal", "151st appearance") — a
# statline read-out, never a live goal call. A WEAK phrasing match inside such
# text is dropped; a STRONG call or a score transition still wins.
_RETROSPECTIVE_STAT_RES: tuple[re.Pattern, ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        # Perfect tense without an exclamation is a record, not a call. An
        # explicit "has scored!" stays a call (live commentary).
        r"\b(?:has|have|had)\s+scored\b(?!\s*!)",
        r"\bprevious\b",
        r"\brecords?\b",
        r"\bappearances?\b",
        # "his 82nd goal", "151st appearance", "3rd goal for Portugal".
        r"\b\d{1,3}(?:st|nd|rd|th)\b",
        # "scored seven penalties for Portugal" / "penalties for Portugal".
        r"\bpenalt(?:y|ies)\s+for\b",
        # Spelled-out career totals: "only three goals in his ...".
        r"\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
        r"\s+goals?\s+in\b",
    )
)

# ADAAAA-7843 (requirement 2): a score-transition call. A literal N-M score
# (N != M, so a 0-0 / 1-1 scoreboard read is not a transition) counts when it
# sits next to an entity name ("It's 1-0 Portugal", "1-0 to Portugal") or is
# anchored by an explicit transition cue ("it's 1-0", "now 2-1", "make it 2-1").
#
# Both sides are restricted to a SINGLE digit: a football/regulation scoreline
# is 0-9 per side, and this is what keeps a stat line ("13 - 2 in shot
# attempts", a 2-digit tally) from reading as a score transition. Erring
# toward a miss is correct here — a missed scoreline still has the two-signal
# frame attestation and the measured scoreboard as corroboration, while a false
# credit admits a non-goal.
_SCORE_LINE_RE = re.compile(r"\b(\d)\s*[-–—]\s*(\d)\b")
# Word-boundary cues so "the score" does not match inside "the scoreboard".
_SCORE_CUE_RE = re.compile(
    r"(?:\bit'?s\b|\bit is\b|\bthat'?s\b|\bthat is\b|\bmake[s]? it\b"
    r"|\bscore is\b|\bthe score\b|\blead[s]?\b|\bahead\b|\bnow\b"
    r"|\bwe have\b|\bthey have\b)"
)
_SCORE_STOPWORDS = frozenset({
    "for", "in", "at", "and", "on", "to", "of", "the", "a", "an", "with",
    "from", "as", "but", "so", "if", "is", "was", "are", "were", "be", "has",
    "have", "had", "it", "this", "that", "there", "then", "his", "her",
    "their", "its", "by", "up", "down", "out", "off", "over", "into", "after",
    "before", "when", "while", "no", "not", "only", "all", "nil", "goal",
    "goals", "scored", "score", "scores", "defeat", "win", "loss", "draw",
})
# A proper-noun-ish token: a real word, not a stopword or a bare number.
_TEAMISH_RE = re.compile(r"^[a-z][a-z'.\-]{2,}$")


def retrospective_stat_framing(text: str | None) -> bool:
    """Whether the commentary text is retrospective stat framing (ADAAAA-7843).

    True for a statline / record read-out ("has scored seven penalties for
    Portugal", "his previous 13 World Cup Finals", "his 82nd goal for Portugal
    on his 151st appearance") — text about a CAREER, not about a goal that has
    just been scored. Used to drop a WEAK phrasing match; never raises.
    """
    t = (text or "").strip().lower()
    if not t:
        return False
    return any(p.search(t) for p in _RETROSPECTIVE_STAT_RES)


def _teamish(word: str) -> bool:
    w = word.strip(".,;:!?()[]\"'")
    return bool(w) and _TEAMISH_RE.match(w) is not None and w not in _SCORE_STOPWORDS


def score_transition_calls_goal(text: str | None) -> bool:
    """Whether the text calls a goal by stating a literal score transition.

    ADAAAA-7843 (requirement 2): "It's 1-0 Portugal" is the canonical live goal
    call and the old substring tuple missed it entirely. A match needs a literal
    ``N-M`` with two DIFFERENT numbers (so a 0-0 / 1-1 scoreboard read is not a
    transition) plus either an entity name in the following few words or an
    explicit transition cue just before it. Conservative by construction: a bare
    number pair with neither anchor ("13 - 2" style stats, a timecode) never
    fires. Never raises.
    """
    t = (text or "").strip().lower()
    if not t:
        return False
    for m in _SCORE_LINE_RE.finditer(t):
        home, away = m.group(1), m.group(2)
        if home == away:
            continue  # a 0-0 / 2-2 readout is a score, not a transition
        before = t[max(0, m.start() - 24):m.start()]
        after_words = re.findall(r"[a-z0-9'.\-]+", t[m.end():m.end() + 40])[:3]
        if any(_teamish(w) for w in after_words):
            return True
        if _SCORE_CUE_RE.search(before):
            return True
    return False


def audio_calls_goal(transcript: str | None) -> bool:
    """Whether the (fallible) ASR commentary text calls a goal.

    Deterministic three-layer match over the lower-cased transcript
    (ADAAAA-7843): a STRONG exclamatory call, a score-transition call
    ("It's 1-0 Portugal"), or a WEAK phrased call that is NOT retrospective-stat
    framing. Used as ONE independent corroboration signal on the confirm pass.
    Never raises; empty/None input is False (no text is never corroboration)."""
    t = (transcript or "").strip().lower()
    if not t:
        return False
    if any(p in t for p in _STRONG_GOAL_CALL_PATTERNS):
        return True
    if score_transition_calls_goal(t):
        return True
    if not any(p in t for p in _WEAK_GOAL_CALL_PATTERNS):
        return False
    return not retrospective_stat_framing(t)


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


def two_signal_goal_attested(*, ball_in_net: Optional[bool],
                             ball_crossed: Optional[bool]) -> bool:
    """ADAAAA-7543 (ratified policy ADAAAA-7555 Option 1): whether a model frame
    read attests a REGULATION goal strongly enough to be credited.

    The bar is BOTH ``ballInNet`` AND "ball crossed the line between the posts"
    plainly observed, from the SAME pass. A single-signal self-read stays
    uncorroborated, so the ADAAAA-7162 fabrication guard still covers a saved
    shot / near-miss / dribble (the post-bounce celebration claim carries no
    "crossed the line between the posts" observation, so it stays rejected).
    Tri-state in: ``None`` (unverifiable) or ``False`` (refuted) never credits.
    """
    return ball_in_net is True and ball_crossed is True


def confirm_requires_corroboration() -> bool:
    """Whether the confirm pass gates a confirmed_goal on an independent
    corroboration signal. Default ON (the CEO requirement); set
    ``DECIDE_CONFIRM_REQUIRE_CORROBORATION=0`` to restore the legacy
    frame-only behavior in an emergency (e.g. clips with no commentary)."""
    return os.environ.get("DECIDE_CONFIRM_REQUIRE_CORROBORATION", "1") == "1"


# ADAAAA-7844: a measured scoreboard delta is only credited when BOTH sides are
# legible (parsed) and each side is backed by at least this many OCR samples.
SCOREBOARD_MIN_CONSISTENT_SAMPLES = 2


def _score_pair(value) -> Optional[Tuple[int, int]]:
    """Coerce a ``[home, away]`` payload to an int pair, or ``None``."""
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    out = []
    for v in value:
        if isinstance(v, bool) or not isinstance(v, int):
            return None
        if v < 0 or v > 99:
            return None
        out.append(int(v))
    return (out[0], out[1])


def scoreboard_delta_legible(delta) -> bool:
    """Whether a measured scoreboard delta is LEGIBLE and TIME-TIED.

    ADAAAA-7844: a window can only be corroborated by a scoreboard change that
    was actually measured — both sides parsed into two integers, the sides
    differ, each side is supported by at least ``SCOREBOARD_MIN_CONSISTENT_SAMPLES``
    contiguous OCR readings inside the window, and the transition instant sits
    between the two reads. A bare boolean, a single OCR sample, or an
    unparseable/absurd read is NOT a measurement and never corroborates.
    Never raises.
    """
    if not isinstance(delta, dict):
        return False
    pre = _score_pair(delta.get("pre"))
    post = _score_pair(delta.get("post"))
    if pre is None or post is None or pre == post:
        return False
    try:
        pre_samples = int(delta.get("preSamples") or 0)
        post_samples = int(delta.get("postSamples") or 0)
    except (TypeError, ValueError):
        return False
    pre_ts_raw = delta.get("preTs")
    post_ts_raw = delta.get("postTs")
    if pre_ts_raw is None or post_ts_raw is None:
        return False
    try:
        pre_ts = float(pre_ts_raw)
        post_ts = float(post_ts_raw)
        delta_ts = float(delta.get("deltaTs", post_ts_raw))
    except (TypeError, ValueError):
        return False
    if pre_samples < SCOREBOARD_MIN_CONSISTENT_SAMPLES:
        return False
    if post_samples < SCOREBOARD_MIN_CONSISTENT_SAMPLES:
        return False
    return pre_ts <= delta_ts <= post_ts


def goal_corroborated(*, scoreboard_changed: bool, transcript: str | None,
                      frame_scoreboard_changed: bool = False,
                      penalty_shootout: bool = False,
                      penalty_tally_changed: bool = False,
                      ball_in_net: bool = False,
                      ball_in_net_refuted: bool = False,
                      goal_confirmed: str = "",
                      two_signal_attested: bool = False,
                      stage1_contradicts: bool = False,
                      scoreboard_delta: dict | None = None,
                      frame_attestation_contradicts: bool = False) -> bool:
    """True when at least one INDEPENDENT corroboration signal is present.

    The independent anchors are: a MEASURED scoreboard change, goal-calling audio
    text, or (ADAAAA-7543 / ratified ADAAAA-7555 Option 1) a two-signal model
    frame attestation (both ``ballInNet`` AND ball-crossed-the-line-between-posts
    observed, neither refuted).

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
    guard stays intact).

    ADAAAA-7844: shootout crediting does NOT make the corroboration a scoreboard
    MEASUREMENT (ADAAAA-7844): a main scoreboard delta is the only thing that may be labelled
    ``scoreboard``, and every window-level delta must be legible/consistent
    (``scoreboard_delta``) and not contradicted by the window's own frame read
    (``frame_attestation_contradicts``: the deep dive's ``evidence.scoreboardChanged
    == false`` or the Stage-1 criteria's ``scoreboardChanged == false``)."""

    # ADAAAA-7543 (follow-up fix): a WINDOW-LEVEL scoreboard delta is not a
    # time-tied read of the analysed instant. kids_soccer.mp4 is a
    # frequent-goal compilation, so a genuine delta from an adjacent goal lands
    # inside nearly every 16-frame window. When the window's OWN primary read
    # says no goal occurred (``stage1_contradicts``), that window-level delta —
    # or a shootout merely NARRATED from the same window context — must not be
    # the only thing that flips the window to a GOAL. Only evidence anchored to
    # THIS window's instant may override the primary read: goal-calling audio
    # from the window's own audio track, or the two-signal frame attestation
    # from the same pass. (Observed FP: kids-soccer t=688.6, Stage-1
    # ``near_miss`` / "ball ... does not enter the net", accepted as a GOAL on a
    # measured scoreboard delta plus a narrated penalty tally.)
    frame_anchored = bool(two_signal_attested) or audio_calls_goal(transcript)
    if stage1_contradicts and not frame_anchored:
        return False
    if penalty_shootout or penalty_tally_changed:
        # An attested conversion: the deep dive confirmed the goal and did not
        # explicitly say the ball was NOT in the net. This is the recall gain
        # (the model's ball-in-net read survives even when the structured
        # penaltyTallyChanged / ballInNet tri-state is null).
        if goal_confirmed == "confirmed_goal" and not ball_in_net_refuted:
            return True
        return bool(penalty_tally_changed) or bool(ball_in_net)
    # ADAAAA-7844: the scoreboard anchor must be a LEGIBLE, time-tied MEASURED
    # delta — both sides parsed, >= 2 consistent OCR samples per side — and it
    # must not be contradicted by the window's OWN frame read (the deep dive's
    # `evidence.scoreboardChanged == false` or the Stage-1 criteria's
    # `scoreboardChanged == false`). A bare boolean, a single-frame OCR flip, or
    # a delta the window's own frames refute cannot corroborate a GOAL. This also
    # makes the "scoreboard" label evidence-backed: only this branch may carry it.
    measured_scoreboard = (
        bool(scoreboard_changed)
        and scoreboard_delta_legible(scoreboard_delta)
        and not bool(frame_attestation_contradicts)
    )
    # ADAAAA-7510: scoreboard corroboration requires the deterministic MEASURED
    # pre->post numeric score delta (the perceive-OCR `scoreBoardChanged` flag,
    # score_changed semantics: both sides parsed + differ). A model read
    # (`frame_scoreboard_changed`) or a free-text narration of a scoreboard
    # change is NOT independent corroboration — a celebration-derived claim is
    # exactly the post-bounce fabrication that was accepted as a scoring GOAL.
    # Only a measured delta, a goal call, or the two-signal frame attestation
    # anchors the visual read.
    # ADAAAA-7543 (ratified ADAAAA-7555 Option 1): a REGULATION goal read that
    # carries BOTH ball-in-net AND ball-crossed-the-line-between-posts (neither
    # refuted) is credited — a single-signal read is not, so the ADAAAA-7162
    # fabrication guard still holds for saves / near-misses / dribbles.
    return (
        measured_scoreboard
        or audio_calls_goal(transcript)
        or bool(two_signal_attested)
    )


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
    # ADAAAA-7844: the MEASURED, legible scoreboard delta behind
    # `scoreBoardChanged` ({pre, post, preTs, postTs, deltaTs, preSamples,
    # postSamples}). Absent on a bare boolean; the pass then refuses to credit a
    # scoreboard corroboration or label one "scoreboard".
    scoreBoardDelta: Optional[dict] = None
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
    # ADAAAA-7844: the MEASURED, legible scoreboard delta the corroboration was
    # credited/labelled from (parsed pre/post + sample counts + transition
    # instant). null when no legible delta was measured, so a "scoreboard"
    # corroboration is always traceable to a real reading.
    scoreboardDelta: Optional[dict] = None
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
    scoreboard_delta: Optional[dict] = None,
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
    # ADAAAA-7844: render the MEASURED delta (parsed pre -> post + read counts)
    # rather than a bare yes/no, so the model reasons over what was actually
    # read. A boolean without a legible delta is reported as NOT observed: an
    # unmeasured flip must never be presented as corroboration.
    if scoreboard_changed and scoreboard_delta_legible(scoreboard_delta):
        pre = _score_pair((scoreboard_delta or {}).get("pre"))
        post = _score_pair((scoreboard_delta or {}).get("post"))
        meta.append(
            "independent corroboration: scoreboard score change MEASURED "
            f"({pre[0]}-{pre[1]} -> {post[0]}-{post[1]}; "
            f"{int((scoreboard_delta or {}).get('postSamples') or 0)} OCR reads on the new score)"
        )
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
        "signal. A GOAL is CONFIRMED when the frames show the ball actually "
        "entering the net AND at least ONE of these INDEPENDENT corroboration "
        "signals is present (ratified policy ADAAAA-7555 Option 1):\\n"
        "  (a) a scoreboard score change;\\n"
        "  (b) audio/commentary text that CALLS the goal (e.g. 'GOOOAL', "
        "'it's in', team-scored phrasing);\\n"
        "  (c) YOUR OWN frame read plainly showing BOTH evidence.ballInNet=true "
        "AND evidence.ballTrajectoryCrossedLine=true (the ball is in the net AND "
        "you saw it cross the line between the posts), with NEITHER refuted.\\n"
        "Signal (c) is a first-class corroboration: when your frames plainly show "
        "the ball in the net AND crossing the line between the posts, set BOTH of "
        "those evidence fields true and CONFIRM the goal — do NOT refute the goal "
        "merely because there is no scoreboard change and no goal-calling audio. "
        "A SINGLE-signal frame read (ball-in-net alone, or a line crossing alone) "
        "is NOT corroboration: a saved shot, a near miss that stayed out, a "
        "post/bar rebound, or a celebration after a non-goal can show one signal "
        "without a real score, so those stay near miss / not a goal. "
        "Only when the frames plainly show the ball did NOT score (saved at the "
        "line, blocked, hit the post/bar, went over/wide, cleared, or stayed in "
        "open play) call it a near miss (close call that did not convert) or not "
        "a goal. "
        "If they show nothing scoring, call it not a goal.\\n"
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


def stage1_says_no_goal(stage1: dict) -> bool:
    """Whether the Stage-1 primary read says NO goal occurred in this window.

    ADAAAA-7543 (follow-up): this is the window's OWN independent read of the
    analysed instant — ``isHighlight`` false, or an ``outcome`` of
    ``not_highlight`` / ``near_miss``. It is the read a window-level scoreboard
    delta must not silently override: a delta inside the 16-frame window can
    belong to an adjacent goal in a compilation, so it is not evidence about
    this moment on its own.
    """
    s1 = stage1 or {}
    outcome = (_as_text(s1.get("outcome")) or "").lower()
    hi = s1.get("isHighlight")
    # An explicit isHighlight=false is the strongest signal; when the field is
    # absent (older callers) fall back to the outcome alone rather than
    # assuming "no goal" — a missing field must never suppress a real goal.
    if hi is False:
        return True
    return outcome in ("not_highlight", "near_miss")


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
        scoreboard_delta=req.get("scoreBoardDelta"),
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
    # ADAAAA-7543 (ratified ADAAAA-7555 Option 1): the REGULATION-goal two-signal
    # frame attestation. A model frame read counts only when it carries BOTH
    # ball-in-net AND ball-crossed-the-line-between-posts. The deep dive is the
    # contradictory-hypothesis pass, so when IT plainly refutes either criterion
    # (evidence ``false``) the attestation is not credited — this is the
    # "neither refuted" clause, and it keeps a saved shot / near-miss rejected
    # even if Stage-1 read it as a goal. The signals are read from the SAME pass
    # (never mixed across Stage-1 and Stage-2).
    stage1_criteria = ((stage1.get("verdict") or {}).get("criteria") or {})
    deep_dive_refuted = (
        ev.get("ballInNet") is False or ev.get("ballTrajectoryCrossedLine") is False
    )
    two_signal_attested = (not deep_dive_refuted) and (
        two_signal_goal_attested(
            ball_in_net=ev.get("ballInNet"),
            ball_crossed=ev.get("ballTrajectoryCrossedLine"),
        )
        or two_signal_goal_attested(
            ball_in_net=stage1_criteria.get("ballInNet"),
            ball_crossed=stage1_criteria.get("ballCrossedLineBetweenPosts"),
        )
    )
    # ADAAAA-7844: the window's OWN frame attestation is the independent read of
    # the analysed instant. When it EXPLICITLY says the score did not change
    # (the deep dive's evidence.scoreboardChanged == false, or the Stage-1
    # criteria's scoreboardChanged == false), a window-level OCR delta cannot be
    # the anchor and cannot be labelled "scoreboard" — this is the clause that
    # closes the job dee44c2f window-ts-117 class (a "scoreboard" corroboration
    # whose own frames, and whose Stage-1 criteria, said the score was unchanged).
    deep_dive_says_no_score_change = ev.get("scoreboardChanged") is False
    stage1_says_no_score_change = stage1_criteria.get("scoreboardChanged") is False
    frame_attestation_contradicts = (
        deep_dive_says_no_score_change or stage1_says_no_score_change
    )
    scoreboard_delta = req.get("scoreBoardDelta")
    measured_scoreboard = (
        bool(req.get("scoreBoardChanged"))
        and scoreboard_delta_legible(scoreboard_delta)
        and not frame_attestation_contradicts
    )
    confirmed = goal_corroborated(
        scoreboard_changed=bool(req.get("scoreBoardChanged")),
        transcript=transcript,
        frame_scoreboard_changed=False,
        penalty_shootout=penalty_shootout,
        penalty_tally_changed=penalty_tally_changed,
        ball_in_net=ball_in_net,
        ball_in_net_refuted=ball_in_net_refuted,
        goal_confirmed=goal,
        two_signal_attested=two_signal_attested,
        # ADAAAA-7543 (follow-up): the window's OWN primary read is the
        # independent read of the analysed instant. When it says no goal
        # occurred, a window-level scoreboard delta cannot be the only anchor
        # that accepts the window (only instant-anchored evidence can).
        stage1_contradicts=stage1_says_no_goal(stage1),
        # ADAAAA-7844: credit a scoreboard delta only when it was MEASURED
        # legibly and the window's own frames do not refute it.
        scoreboard_delta=scoreboard_delta,
        frame_attestation_contradicts=frame_attestation_contradicts,
    )
    decision = reconcile_confirmed_goal(
        goal, stage1, comment=comment,
        corroborated=confirmed,
        require_corroboration=confirm_requires_corroboration(),
    )
    # ADAAAA-7185 / ADAAAA-7844: WHICH independent corroboration signal actually
    # CREDITED the goal, persisted so the evidence for an accepted GOAL is
    # queryable after the fact. Precedence stays measured scoreboard > goal call >
    # frame attestation (ADAAAA-7543), but each label is now evidence-backed:
    #
    # - "scoreboard" ONLY when the percept-OCR delta was MEASURED legibly (both
    #   sides parsed, >= 2 consistent OCR samples per side, time-tied) and the
    #   window's own frames did not refute it. A shootout/tally read is the
    #   MODEL's frame read, not a measurement, so it can never carry this label
    #   (ADAAAA-7844: job dee44c2f window ts 117 was labelled "scoreboard" purely
    #   from the model's penalty-shootout evidence with scoreBoardChanged false).
    # - "audio_text" when goal-calling commentary text credited it.
    # - "frame_attestation" when the deep dive's OWN frame read credited it (the
    #   two-signal regulation attestation, or a shootout/ball-in-net conversion).
    # - None when corroboration did not actually fire: never label a source that
    #   was not measured and did not credit anything.
    corroboration_source = None
    if confirmed:
        if measured_scoreboard:
            corroboration_source = "scoreboard"
        elif audio_calls_goal(transcript):
            corroboration_source = "audio_text"
        elif two_signal_attested or penalty_shootout or penalty_tally_changed:
            corroboration_source = "frame_attestation"

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
        # ADAAAA-7844: the measured delta the "scoreboard" label rests on (null
        # when no legible delta was measured).
        "scoreboardDelta": scoreboard_delta if measured_scoreboard else None,
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

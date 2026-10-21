"""Tier-1 watch/notes vs Tier-2 confirm escalation gate (ADAAAA-7135).

Perceive's Stage-A triggers fire a `candidate` on essentially every soccer
frame: the tracker labels the fast-strike motion primitive as GOAL via
``sport_specific_event_type``, and the motion-burst / detection-in-zone /
audio triggers are open-set, high-recall gates. That floods both the decide
GPU spend and the durable ``job.candidates`` trail (box evidence: a job
recording 168 ``candidate`` entries, all ``eventType=GOAL``).

The two-tier design (CEO intent: watch + notes, escalate on signal, surface
only confirmed) escalates a frame to the Tier-2 confirm pass ONLY when a real
goal signal is present. Otherwise the frame stays Tier-1 (a watch / running
action note) and is never surfaced as a candidate.

Escalation signals (OR), matching the plan's signal gate:

  * ``ballInNet``          - geometry-agnostic ball-in-net attestation
                             (ADAAAA-7044). Optional; absent when unconfigured.
  * ``goalCrossed``        - goal-line plane classifier (decide-leg I2,
                             ADAAAA-6359).
  * ``ballOutcome`` goal-valued - goal-line outcome "goal"/"cross".
  * ``scoreBoardChanged``  - OCR score-delta across the candidate window
                             (decide-leg I3, ADAAAA-6360).
  * a confident motion+audio burst - BOTH a track motion burst and an audio
    noise-change gate firing in the same frame. This is the recall path for a
    real goal that carries no geometric attestation (no goal-line spec / no
    scoreboard OCR), so true-goal recall is not regressed.

RECALL SAFETY: when NO goal-signal channel produced a judgment (``goal_infra``
is false — e.g. the session has no goal-line spec, no goal attestation and no
scoreboard tracker yielding a score-delta), the gate escalates. That keeps a
genuine goal from being starved in an uncalibrated/disabled session. The gate
only SUPPRESSES when an active signal channel explicitly reports NOT a goal
(gate says "not a goal") and there is no confident motion+audio burst — which
is exactly the flood scenario on the box (goal attestation + scoreboard active,
non-goal frames report no goal signal).
"""

# ``ballOutcome`` values that mean a scoring play crossed the line. These are
# the GoalLineDetector's classification outcomes (goal_plane.py); anything
# else (off_target / blocked / no_shot / cross-without-goal / absent) is NOT a
# goal signal and must not escalate by itself.
GOAL_OUTCOMES = frozenset({"goal", "cross", "goal_crossed", "crossed"})


def escalates_to_tier2(
    *,
    ballInNet: bool | None = None,
    goalCrossed: bool | None = None,
    ballOutcome: str | None = None,
    scoreBoardChanged: bool | None = None,
    motion_burst: bool = False,
    audio_burst: bool = False,
    goal_infra: bool = False,
) -> bool:
    """Return True when this frame escalates to the Tier-2 confirm pass.

    Escalates when ANY real goal signal is present (the geometric / scoreboard
    attestations are treated as hard, independent goal confirmation, matching
    the decide service's own ball-signal gate), OR when a confident
    motion+audio burst corroborates a scoring play, OR when no goal-signal
    channel was available to judge (``goal_infra`` false) so a genuine goal is
    never starved (recall safety).

    The gate only SUPPRESSES when a goal-signal channel actively reported NOT a
    goal (all present signals non-goal, e.g. ballOutcome=off_target /
    goalCrossed=false / scoreBoardChanged=false / ballInNet=false) AND there is
    no confident motion+audio burst. That is the exact flood on the box: an
    active goal-attestation / scoreboard channel firing on every fast soccer
    frame with no goal signal.

    Note: a motion burst ALONE does not escalate — that is the flood source
    (open-set high-recall motion triggers on every fast soccer frame). It must
    be corroborated by an audio burst (a second independent channel) to be a
    "confident" escalation for the no-geometry recall path.
    """
    if ballInNet is True:
        return True
    if goalCrossed is True:
        return True
    if ballOutcome is not None and ballOutcome in GOAL_OUTCOMES:
        return True
    if scoreBoardChanged is True:
        return True
    if motion_burst and audio_burst:
        return True
    # Recall safety: no goal-signal channel could judge -> escalate (never
    # starve a goal in an uncalibrated/disabled session).
    if not goal_infra:
        return True
    return False

"""Tier-2 signal gate unit tests (ADAAAA-7135).

Verifies the escalation rule in ``app.signal_gate.escalates_to_tier2``:
a candidate escalates to the Tier-2 confirm pass when a real goal signal is
present (ballInNet / goalCrossed / goal-valued ballOutcome / scoreBoardChanged),
OR a confident motion+audio burst, OR no goal-signal channel judged the frame
(recall safety). A motion burst alone — or a frame a channel actively reported
as NOT a goal with no confident burst — must NOT escalate; that is the flood
source.
"""

import pytest

from app.signal_gate import GOAL_OUTCOMES, escalates_to_tier2


@pytest.mark.parametrize("kwargs", [
    # A single real goal signal escalates regardless of motion/audio.
    {"ballInNet": True, "goal_infra": True},
    {"goalCrossed": True, "goal_infra": True},
    {"ballOutcome": "goal", "goal_infra": True},
    {"ballOutcome": "cross", "goal_infra": True},
    {"scoreBoardChanged": True, "goal_infra": True},
    # Confident motion+audio burst escalates (no-geometry recall path).
    {"motion_burst": True, "audio_burst": True},
])
def test_escalates_on_a_real_signal(kwargs):
    assert escalates_to_tier2(**kwargs) is True


@pytest.mark.parametrize("kwargs", [
    # Ball-outcome that is NOT a goal (off_target / blocked / no_shot).
    {"goal_infra": True, "ballOutcome": "off_target"},
    {"goal_infra": True, "ballOutcome": "blocked"},
    {"goal_infra": True, "ballOutcome": "no_shot"},
    # Non-true geometric signals are not escalation.
    {"goal_infra": True, "ballInNet": False},
    {"goal_infra": True, "goalCrossed": False},
    {"goal_infra": True, "scoreBoardChanged": False},
    # Motion burst ALONE must not escalate — the flood source.
    {"goal_infra": True, "motion_burst": True},
    # Audio burst ALONE must not escalate — needs motion corroboration.
    {"goal_infra": True, "audio_burst": True},
])
def test_does_not_escalate_without_a_real_signal_when_a_channel_judged(kwargs):
    assert escalates_to_tier2(**kwargs) is False


def test_recall_safety_escalates_when_no_channel_judged():
    # With NO goal-signal channel judging (goal_infra false), a motion burst
    # must still escalate so a genuine goal is never starved in an
    # uncalibrated/disabled session. This is the recall-safety default.
    assert escalates_to_tier2(motion_burst=True, goal_infra=False) is True


def test_goal_outcomes_are_a_frozenset_of_goal_valued_outcomes():
    # The design only treats goal-valued outcomes as a goal signal; a non-goal
    # outcome must never escalate by itself (important: the decide service has a
    # separate ball-signal reconcile, but the perceive gate must not pre-escalate
    # a candidate the decide will then reject).
    assert "off_target" not in GOAL_OUTCOMES
    assert "no_shot" not in GOAL_OUTCOMES
    assert "goal" in GOAL_OUTCOMES

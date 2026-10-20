"""ADAAAA-6481 / ADAAAA-7070 — near-miss semantics unit tests.

Perceive is a DATA source, not a decision signal (CEO directive, ADAAAA-7070):
a perceived ``ballOutcome`` of ``blocked`` / ``off_target`` is a reported
measurement handed to the vision model to weigh against its own frame
observation. It does NOT itself classify the clip. A NEAR_MISS is surfaced only
when the model's frame-grounded PASS 1 read plainly saw a goal objective being
threatened (``apply_near_miss_frame_grounding_gate``). ``near_miss_vs_scoring_
confusion`` stays 0: a near-miss is never a ``scoring_play``.
"""
from app.gemma import (
    apply_ball_outcome_gate,
    event_type_for_outcome,
    is_near_miss_ball_outcome,
    reconcile_outcome_with_ball_signal,
)


def test_is_near_miss_ball_outcome_reports_data():
    # is_near_miss_ball_outcome is informational: it reports what perceive
    # measured, it does not classify the clip.
    assert is_near_miss_ball_outcome("blocked") is True
    assert is_near_miss_ball_outcome("off_target") is True
    assert is_near_miss_ball_outcome("goal") is False
    assert is_near_miss_ball_outcome("no_shot") is False
    assert is_near_miss_ball_outcome("cross") is False
    assert is_near_miss_ball_outcome(None) is False


def test_reconcile_is_data_only_never_forces_near_miss():
    # Perceive no longer forces a near-miss (ADAAAA-7070): reconcile is a no-op.
    d = {"outcome": "not_highlight", "nearMiss": False,
         "isHighlight": False, "score": 0,
         "reason": "the ball does not enter the net"}
    out = reconcile_outcome_with_ball_signal(d, "blocked")
    assert out == d


def test_reconcile_no_evidence_no_change():
    d = {"outcome": "not_highlight", "nearMiss": False, "isHighlight": False}
    out = reconcile_outcome_with_ball_signal(d, None)
    assert out == d


def test_ball_outcome_gate_never_rejects():
    # Perceive is DATA: a ballOutcome no longer hard-vetoes (unreliable
    # detection must not reject a goal the model plainly saw in the frames).
    for outcome in ("no_shot", "cross", "blocked", "off_target", "goal", None):
        ok, reason = apply_ball_outcome_gate({"ballOutcome": outcome})
        assert ok is True


def test_event_type_for_outcome_mapping():
    assert event_type_for_outcome("scoring_play") == "GOAL"
    assert event_type_for_outcome("near_miss") == "NEAR_MISS"
    assert event_type_for_outcome("big_play") == "BIG_PLAY"
    # Unknown / absent outcome defers to the candidate/model label (fallback).
    assert event_type_for_outcome(None, "GOAL") == "GOAL"
    assert event_type_for_outcome("not_highlight", "RED_CARD") == "RED_CARD"

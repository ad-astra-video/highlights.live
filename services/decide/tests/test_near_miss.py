"""ADAAAA-6481 — near-miss reconciliation unit tests.

Locks the §8 near_miss_recall / near_miss_vs_scoring_confusion acceptance: a
goal-bound shot that did NOT convert (blocked / off_target) must surface as a
near_miss (never dismissed as not_highlight) but must NEVER become a
scoring_play (confusion stays 0).
"""
from app.gemma import (
    apply_ball_outcome_gate,
    event_type_for_outcome,
    is_near_miss_ball_outcome,
    reconcile_outcome_with_ball_signal,
)


def test_is_near_miss_ball_outcome():
    assert is_near_miss_ball_outcome("blocked") is True
    assert is_near_miss_ball_outcome("off_target") is True
    assert is_near_miss_ball_outcome("goal") is False
    assert is_near_miss_ball_outcome("no_shot") is False
    assert is_near_miss_ball_outcome("cross") is False
    assert is_near_miss_ball_outcome(None) is False


def test_reconcile_upgrades_not_highlight_to_near_miss():
    d = {"outcome": "not_highlight", "nearMiss": False,
         "isHighlight": False, "score": 0,
         "reason": "the ball does not enter the net"}
    out = reconcile_outcome_with_ball_signal(d, "blocked")
    assert out["outcome"] == "near_miss"
    assert out["nearMiss"] is True
    # ADAAAA-6598: a near-miss is recorded distinctly (outcome/nearMiss) but is
    # NOT accepted as a GOAL highlight on the board (isHighlight stays false).
    assert out["isHighlight"] is False
    assert out["outcome"] != "scoring_play"


def test_reconcile_demotes_overconfident_score_and_keeps_class():
    d = {"outcome": "not_highlight", "nearMiss": False,
         "isHighlight": False, "score": 85}
    out = reconcile_outcome_with_ball_signal(d, "off_target")
    assert out["outcome"] == "near_miss"
    assert out["score"] < 60  # near-miss sits in a lower band than a goal
    assert out["nearMiss"] is True


def test_reconcile_never_turns_a_goal_into_near_miss():
    d = {"outcome": "scoring_play", "nearMiss": False,
         "isHighlight": True, "score": 80}
    out = reconcile_outcome_with_ball_signal(d, "goal")
    assert out["outcome"] == "scoring_play"
    assert out["nearMiss"] is False


def test_reconcile_no_evidence_no_change():
    d = {"outcome": "not_highlight", "nearMiss": False, "isHighlight": False}
    out = reconcile_outcome_with_ball_signal(d, None)
    assert out == d


# --- ADAAAA-6969: non-scoring highlight label must never be GOAL -------------
def test_reconcile_relabels_stale_goal_to_near_miss():
    # The verified FP: a keeper save whose model/candidate verdict carried
    # eventType=GOAL. Reconcile must relabel to NEAR_MISS, not keep "GOAL".
    d = {"outcome": "scoring_play", "eventType": "GOAL", "nearMiss": False,
         "isHighlight": True, "score": 60}
    out = reconcile_outcome_with_ball_signal(d, "blocked")
    assert out["outcome"] == "near_miss"
    assert out["nearMiss"] is True
    assert out["eventType"] == "NEAR_MISS"  # label reflects outcome class
    assert out["isHighlight"] is False


def test_event_type_for_outcome_mapping():
    assert event_type_for_outcome("scoring_play") == "GOAL"
    assert event_type_for_outcome("near_miss") == "NEAR_MISS"
    assert event_type_for_outcome("big_play") == "BIG_PLAY"
    # Unknown / absent outcome defers to the candidate/model label (fallback).
    assert event_type_for_outcome(None, "GOAL") == "GOAL"
    assert event_type_for_outcome("not_highlight", "RED_CARD") == "RED_CARD"


def test_apply_ball_outcome_gate_still_rejects_non_near_miss_non_goal():
    # no_shot / cross remain hard-rejected; near-miss classes are surfaced by
    # reconcile, NOT rejected.
    ok_no, reason_no = apply_ball_outcome_gate({"ballOutcome": "no_shot"})
    ok_cross, _ = apply_ball_outcome_gate({"ballOutcome": "cross"})
    ok_blocked, _ = apply_ball_outcome_gate({"ballOutcome": "blocked"})
    assert ok_no is False
    assert ok_cross is False
    assert ok_blocked is False  # blocked is a non-goal; reconcile surfaces the near-miss
    ok_goal, _ = apply_ball_outcome_gate({"ballOutcome": "goal"})
    assert ok_goal is True

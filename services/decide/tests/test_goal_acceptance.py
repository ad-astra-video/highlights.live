"""ADAAAA-6598 — spurious GOAL highlight acceptance unit tests.

Locks the "real goals only" acceptance bar: a near_miss / big_play /
not_highlight frame read must NEVER be accepted as a board GOAL highlight
(`isHighlight` stays false), even when the model or a later gate set
`isHighlight` true, while a frame-confirmed `scoring_play` is still accepted
(true-goal recall is not regressed).
"""
from app.gemma import (
    finalize_goal_acceptance,
    normalize_outcome,
    outcome_is_highlight,
    parse_decision,
)
from app.decider import apply_gate


# --- parse_decision: the taxonomy member IS the accept gate ----------------
def test_parse_decision_near_miss_is_not_accepted_as_scoring_highlight():
    # t=1821s verified FP: model reason says "ball does not enter the net".
    d = parse_decision(
        '{"isHighlight":true,"score":0,"eventType":"GOAL","outcome":"near_miss",'
        '"reason":"shot ... saved ... ball does not enter the net"}'
    )
    assert d is not None
    assert d["outcome"] == "near_miss"
    assert d["isHighlight"] is False


def test_parse_decision_big_play_is_not_accepted_as_scoring_highlight():
    # t=1954.9s verified FP: model reason says "ball is being saved".
    d = parse_decision(
        '{"isHighlight":true,"score":45,"eventType":"GOAL","outcome":"big_play",'
        '"reason":"ball is being saved ... does not enter the net"}'
    )
    assert d is not None
    assert d["outcome"] == "big_play"
    assert d["isHighlight"] is False


def test_parse_decision_not_highlight_is_not_accepted():
    d = parse_decision(
        '{"isHighlight":true,"score":80,"eventType":"GOAL","outcome":"not_highlight"}'
    )
    assert d is not None
    assert d["outcome"] == "not_highlight"
    assert d["isHighlight"] is False


def test_parse_decision_real_goal_still_accepted():
    # A genuine frame-confirmed goal keeps isHighlight=true (no recall regression).
    d = parse_decision(
        '{"isHighlight":true,"score":80,"eventType":"GOAL","outcome":"scoring_play",'
        '"reason":"ball crossed the line between the posts and into the net"}'
    )
    assert d is not None
    assert d["outcome"] == "scoring_play"
    assert d["isHighlight"] is True


def test_parse_decision_scoring_play_with_false_is_highlight_still_accepted():
    # Model set isHighlight=false but the frames read a real score: the taxonomy
    # (frame read) governs and the goal is accepted.
    d = parse_decision(
        '{"isHighlight":false,"score":70,"eventType":"GOAL","outcome":"scoring_play"}'
    )
    assert d is not None
    assert d["outcome"] == "scoring_play"
    assert d["isHighlight"] is True


# --- finalize_goal_acceptance: the single route-level gate ----------------
def test_finalize_rejects_near_miss_even_when_forced_true():
    d = {"isHighlight": True, "outcome": "near_miss", "score": 0, "reason": "saved"}
    out = finalize_goal_acceptance(d)
    assert out["isHighlight"] is False
    assert out["outcome"] == "near_miss"
    assert "not a scoring highlight" in out["reason"]


def test_finalize_rejects_big_play_even_after_high_value_waiver():
    # A GOAL high-value event waived through apply_gate purely on corroboration,
    # but the frame read is big_play -> must not surface as a scoring highlight.
    ok, _ = apply_gate(score=99.0, event_type="GOAL", track_count=3, max_velocity=0.9,
                       ocr_hits=2)
    assert ok is True  # high-value waiver accepted it
    d = {"isHighlight": True, "outcome": "big_play", "score": 45}
    out = finalize_goal_acceptance(d)
    assert out["isHighlight"] is False


def test_finalize_keeps_real_goal():
    d = {"isHighlight": True, "outcome": "scoring_play", "score": 80}
    out = finalize_goal_acceptance(d)
    assert out["isHighlight"] is True


# --- taxonomy helper ------------------------------------------------------
def test_outcome_is_highlight_only_scoring_play():
    assert outcome_is_highlight("scoring_play") is True
    assert outcome_is_highlight("near_miss") is False
    assert outcome_is_highlight("big_play") is False
    assert outcome_is_highlight("not_highlight") is False


def test_normalize_outcome_members_preserved():
    assert normalize_outcome("scoring_play") == "scoring_play"
    assert normalize_outcome("near_miss") == "near_miss"
    assert normalize_outcome("big_play") == "big_play"

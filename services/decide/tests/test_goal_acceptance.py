"""ADAAAA-6598 — spurious GOAL highlight acceptance unit tests.

Locks the "real goals only" acceptance bar: a near_miss / big_play /
not_highlight frame read must NEVER be accepted as a board GOAL highlight
(`isHighlight` stays false), even when the model or a later gate set
`isHighlight` true, while a frame-confirmed `scoring_play` is still accepted
(true-goal recall is not regressed).
"""
from app.gemma import (
    event_type_for_outcome,
    finalize_goal_acceptance,
    normalize_outcome,
    outcome_is_highlight,
    parse_decision,
    requested_outcomes,
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


# --- ADAAAA-6855: preferLabels-aware acceptance gate ------------------------
def test_requested_outcomes_maps_labels_to_members():
    assert requested_outcomes(None) == set()
    assert requested_outcomes(["near-misses"]) == {"near_miss"}
    assert requested_outcomes(["saves"]) == {"near_miss", "big_play"}
    assert requested_outcomes(["red cards"]) == {"big_play"}
    assert requested_outcomes(["counter-attacks"]) == {"big_play"}
    assert requested_outcomes(["goals"]) == {"scoring_play"}
    # Unknown / empty labels never widen the gate.
    assert requested_outcomes(["???"]) == set()


def test_finalize_accepts_near_miss_when_requested():
    # A correctly-detected near-miss is exported as a DISTINCT highlight when
    # the job explicitly requests near-misses (ADAAAA-6855).
    d = {"isHighlight": False, "outcome": "near_miss", "score": 55, "reason": "saved at the line", "nearMiss": True}
    out = finalize_goal_acceptance(d, prefer_labels=["near-misses"])
    assert out["isHighlight"] is True
    assert out["outcome"] == "near_miss"  # never relabeled as a goal
    assert "not a scoring highlight" not in out["reason"]


def test_finalize_accepts_big_play_when_saves_requested():
    d = {"isHighlight": False, "outcome": "big_play", "score": 45, "reason": "big save"}
    out = finalize_goal_acceptance(d, prefer_labels=["saves"])
    assert out["isHighlight"] is True
    assert out["outcome"] == "big_play"


def test_finalize_still_rejects_near_miss_when_not_requested():
    # Backward compatible: no request / different labels -> default gate.
    d = {"isHighlight": True, "outcome": "near_miss", "score": 0, "reason": "saved"}
    for labels in (None, ["goals"], ["red cards"]):
        out = finalize_goal_acceptance(dict(d), prefer_labels=labels)
        assert out["isHighlight"] is False
        assert "not a scoring highlight" in out["reason"]


def test_finalize_keeps_real_goal_even_without_labels():
    d = {"isHighlight": True, "outcome": "scoring_play", "score": 80}
    out = finalize_goal_acceptance(d, prefer_labels=None)
    assert out["isHighlight"] is True


# --- ADAAAA-6969: non-goal highlight label never defaults to GOAL -----------
def test_finalize_accepts_near_miss_with_non_goal_label():
    # A requested near-miss/save accepted as a distinct highlight must carry a
    # non-GOAL eventType (NEAR_MISS), even when the model/candidate verdict said
    # GOAL. outcome + nearMiss preserved; only the label changes.
    d = {"isHighlight": False, "outcome": "near_miss", "eventType": "GOAL",
         "score": 55, "reason": "keeper save at the line", "nearMiss": True}
    out = finalize_goal_acceptance(d, prefer_labels=["saves"])
    assert out["isHighlight"] is True
    assert out["outcome"] == "near_miss"
    assert out["nearMiss"] is True
    assert out["eventType"] == "NEAR_MISS"
    assert out["eventType"] != "GOAL"


def test_finalize_accepts_big_play_with_big_play_label():
    d = {"isHighlight": False, "outcome": "big_play", "eventType": "GOAL", "score": 45}
    out = finalize_goal_acceptance(d, prefer_labels=["saves"])
    assert out["isHighlight"] is True
    assert out["eventType"] == "BIG_PLAY"
    assert out["eventType"] != "GOAL"


def test_finalize_keeps_goal_label_for_scoring_play():
    # AC2: a true scoring_play still emits eventType "GOAL" (no regression).
    d = {"isHighlight": True, "outcome": "scoring_play", "eventType": "GOAL", "score": 80}
    out = finalize_goal_acceptance(d, prefer_labels=["goals"])
    assert out["isHighlight"] is True
    assert out["eventType"] == "GOAL"


def test_event_type_for_outcome_never_goal_for_non_scoring():
    # AC4: near_miss-vs-scoring confusion stays 0 for the label too.
    assert event_type_for_outcome("near_miss", "GOAL") == "NEAR_MISS"
    assert event_type_for_outcome("big_play", "GOAL") == "BIG_PLAY"
    assert event_type_for_outcome("scoring_play", "GOAL") == "GOAL"

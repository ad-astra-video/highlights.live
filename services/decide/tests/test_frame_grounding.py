"""ADAAAA-7070 — goal/net frame-grounding gate unit tests.

Locks the root cause of the last VOD job's bogus "ball in net" / near-miss
highlights: the accept-biased prompt plus a (misleading) perceive goal signal
(ballOutcome=goal / ballInNet / goalCrossed / scoreboard change) could accept a
"goal" the frames do not show, because the ADAAAA-6610 attestation gate only
required *some* independent measured criterion — it never required the model's
PASS 1 frame read to corroborate.

The frame-grounding gate (ADAAAA-7070) requires:
- a GOAL (`scoring_play` / goal event) accept to be grounded in the model's
  independent observation plainly stating it SAW the ball enter the net / cross
  between the posts / the keeper beaten with the ball ending in the goal, and
- a NEAR_MISS to be corroborated by a frame-grounded goal/net read (a goal
  objective with a genuinely threatening shot).

Attestation alone is never sufficient (req 3); real-goal recall is preserved
because a real goal yields a genuine frame read (ADAAAA-6533 / 6543); and
near_miss_vs_scoring_confusion stays 0 because these gates only downgrade, never
promote a near-miss to a scoring_play.
"""
from app.gemma import (
    apply_frame_grounding_gate,
    apply_near_miss_frame_grounding_gate,
    _model_plainly_saw_goal,
    _model_plainly_saw_goalnet_threat,
)


def _goal_decision(**kw) -> dict:
    d = {
        "isHighlight": True,
        "outcome": "scoring_play",
        "eventType": "GOAL",
        "reason": "The ball is seen entering the net, and the crowd erupts.",
    }
    d.update(kw)
    return d


# ---- GOAL frame-grounding ---------------------------------------------------


def test_goal_accept_requires_model_frame_read():
    # Attestation present (perceive ballInNet) but the model's PASS 1 read never
    # plainly states a goal -> must NOT surface a GOAL (the exact false-positive
    # class the last VOD job surfaced). Attestation alone is never sufficient.
    decision = _goal_decision()  # no verdict block -> no frame read
    ok, reason = apply_frame_grounding_gate(decision, "GOAL")
    assert ok is False
    assert reason is not None
    assert "frame-grounded" in reason
    assert decision["isHighlight"] is False
    assert decision["outcome"] == "not_highlight"


def test_goal_accept_with_attestation_but_no_read_is_downgraded():
    # Even with an independent attestation, a goal the model did not SEE in the
    # frames must not be surfaced. This is the core ADAAAA-7070 requirement.
    decision = _goal_decision()
    ok, _ = apply_frame_grounding_gate(decision, "GOAL")
    assert ok is False
    # The hear-of-it attestation (evidence) is NOT passed to the frame gate; the
    # model read is what decides. A perceive attestation can never substitute.
    ok2, _ = apply_frame_grounding_gate(_goal_decision(verdict={"criteria": {"ballInNet": None}}), "GOAL")
    assert ok2 is False


def test_goal_accept_with_criteria_ball_in_net_passes():
    # The model's structured PASS-1 read plainly states it saw the ball in the
    # net -> frame-grounded -> goal surfaces (recall preserved).
    decision = _goal_decision(
        verdict={"criteria": {"ballInNet": True, "ballCrossedLineBetweenPosts": None}}
    )
    ok, _ = apply_frame_grounding_gate(decision, "GOAL")
    assert ok is True
    assert decision["isHighlight"] is True
    assert decision["outcome"] == "scoring_play"


def test_goal_accept_with_crossed_between_posts_passes():
    decision = _goal_decision(
        verdict={"criteria": {"ballCrossedLineBetweenPosts": True, "ballInNet": None}}
    )
    ok, _ = apply_frame_grounding_gate(decision, "GOAL")
    assert ok is True


def test_goal_accept_with_specific_observed_read_passes():
    # Recall fallback: a real goal whose structured criterion came back null but
    # whose independent observation names concrete goal-read evidence.
    decision = _goal_decision(
        verdict={
            "independentlyObserved": "The striker's shot beats the keeper and the ball ripples the net before the crowd celebrates.",
            "criteria": {"ballInNet": None, "ballCrossedLineBetweenPosts": None},
        }
    )
    ok, _ = apply_frame_grounding_gate(decision, "GOAL")
    assert ok is True


def test_goal_templated_reason_with_no_read_is_rejected():
    # Anti-confabulation: a bare templated goal reason / self-reported scoring
    # verdict with no supporting frame read is NOT frame-grounded.
    decision = _goal_decision(
        reason="The ball enters the net, and the crowd and players celebrate wildly."
    )
    ok, _ = apply_frame_grounding_gate(decision, "GOAL")
    assert ok is False


def test_non_goal_accept_never_gated():
    # A big_play / near_miss / not_highlight outcome is untouched by the GOAL
    # frame-grounding gate.
    for decision in (
        {"isHighlight": True, "outcome": "big_play", "eventType": "BIG_SAVE"},
        {"isHighlight": False, "outcome": "not_highlight", "eventType": "GOAL"},
    ):
        ok, _ = apply_frame_grounding_gate(decision, decision["eventType"])
        assert ok is True


def test_event_type_goal_alone_triggers_frame_gate():
    # An accepted GOAL event is gated even when the model set outcome to another
    # class (mirror of the attestation gate).
    decision = {"isHighlight": True, "outcome": "big_play", "eventType": "GOAL"}
    ok, _ = apply_frame_grounding_gate(decision, "GOAL")
    assert ok is False
    assert decision["outcome"] == "not_highlight"


# ---- NEAR_MISS frame-grounding ---------------------------------------------


def _near_miss_decision(reason="The shot is blocked on the line, the keeper saves.", **kw) -> dict:
    d = {
        "isHighlight": True,
        "outcome": "near_miss",
        "nearMiss": True,
        "eventType": "NEAR_MISS",
        "reason": reason,
    }
    d.update(kw)
    return d


def test_near_miss_requires_frame_grounded_goalnet_read():
    # A near-miss flagged by the deterministic signal but with NO model read of a
    # goal objective + threat must NOT be surfaced (req 2).
    decision = _near_miss_decision(reason="A crowd swell and thematic cue.")
    ok, reason = apply_near_miss_frame_grounding_gate(decision)
    assert ok is False
    assert reason is not None
    assert decision["isHighlight"] is False
    assert decision["outcome"] == "not_highlight"
    assert decision["nearMiss"] is False


def test_near_miss_with_goalnet_threat_read_passes():
    # A goal objective (net / post) + a genuinely threatening shot that did not
    # convert is frame-grounded -> the near-miss surfaces.
    decision = _near_miss_decision(
        reason="The striker's shot toward the goal is blocked at the line by the keeper."
    )
    ok, _ = apply_near_miss_frame_grounding_gate(decision)
    assert ok is True
    assert decision["isHighlight"] is True
    assert decision["outcome"] == "near_miss"


def test_near_miss_from_perceive_signal_only_is_not_surfaced():
    # Perceive ballOutcome=blocked alone does NOT surface a near-miss when the
    # model never described seeing a goal objective + threat.
    decision = _near_miss_decision(reason="goal-line signal: goal-bound shot did not convert (near-miss)")
    ok, _ = apply_near_miss_frame_grounding_gate(decision)
    assert ok is False
    # never promoted to scoring_play (near_miss_vs_scoring_confusion stays 0)
    assert decision["outcome"] == "not_highlight"


def test_near_miss_never_promoted_to_scoring():
    # The near-miss frame gate only downgrades; it never promotes to scoring_play.
    decision = _near_miss_decision()
    apply_near_miss_frame_grounding_gate(decision)
    assert decision["outcome"] != "scoring_play"


def test_non_near_miss_untouched():
    decision = {"isHighlight": True, "outcome": "scoring_play", "eventType": "GOAL"}
    ok, _ = apply_near_miss_frame_grounding_gate(decision)
    assert ok is True


# ---- detection helpers -----------------------------------------------------


def test_model_plainly_saw_goal_helpers():
    assert _model_plainly_saw_goal({"verdict": {"criteria": {"ballInNet": True}}}) is True
    assert _model_plainly_saw_goal({"verdict": {"criteria": {"ballInNet": False}}}) is False
    assert _model_plainly_saw_goal({"verdict": {"criteria": {"ballInNet": None}}}) is False
    assert _model_plainly_saw_goal({}) is False
    # a specific non-templated observed read counts
    assert _model_plainly_saw_goal(
        {"verdict": {"independentlyObserved": "The ball ripples the net after beating the keeper."}}
    ) is True
    # a bare templated reason is never a supporting read
    assert _model_plainly_saw_goal(
        {"reason": "The ball enters the net, and the crowd and players celebrate wildly."}
    ) is False


def test_model_plainly_saw_goalnet_threat_helpers():
    assert _model_plainly_saw_goalnet_threat(
        {"reason": "The shot toward the goal is blocked by the keeper."}
    ) is True
    assert _model_plainly_saw_goalnet_threat(
        {"reason": "The ball hits the post and goes over."}
    ) is True
    assert _model_plainly_saw_goalnet_threat({"reason": "Nothing notable happens."}) is False

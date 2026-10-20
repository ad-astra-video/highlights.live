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
from app import _postprocess_gemma_verdict
from app.gemma import (
    apply_frame_grounding_gate,
    apply_near_miss_frame_grounding_gate,
    apply_goal_attestation_gate,
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


# ---- ADAAAA-7072 regression: do NOT suppress genuine near-miss reads ---------


def test_near_miss_goalpost_deflects_away_is_corroborated():
    # The empirical eval (ADAAAA-7072) surfaced that a genuine goal-bound
    # non-conversion read ("hits the goalpost and deflects away") was suppressed
    # because `\bpost(s)?\b` does not match inside the compound word "goalpost".
    # The compound-goal objective regex must corroborate a real near-miss.
    ok, _ = apply_near_miss_frame_grounding_gate(
        _near_miss_decision(
            reason="A player takes a shot that hits the goalpost and deflects away."
        )
    )
    assert ok is True
    assert _model_plainly_saw_goalnet_threat(
        {"reason": "A player takes a shot that hits the goalpost and deflects away."}
    ) is True


def test_near_miss_cleared_off_goal_line_is_corroborated():
    ok, _ = apply_near_miss_frame_grounding_gate(
        _near_miss_decision(reason="The ball is cleared off the goal line by a defender.")
    )
    assert ok is True


def test_near_miss_rebound_off_upright_is_corroborated():
    assert _model_plainly_saw_goalnet_threat(
        {"reason": "The striker's shot rebounds off the upright back into play."}
    ) is True


def test_near_miss_crowd_cue_still_rejected():
    # The widened regexes must NOT turn a crowd/thematic cue into a near-miss.
    ok, _ = apply_near_miss_frame_grounding_gate(
        _near_miss_decision(reason="A crowd swell and thematic cue, no shot on goal.")
    )
    assert ok is False


# ---- ADAAAA-7072 regression: do NOT miss a described goal (recall fallback) ---


def test_specific_goal_read_recognizes_entered_net():
    # A real goal the model described as "entering/entered the net" (criteria
    # null at the sampled rate) must count as a frame-grounded goal read, so the
    # gate does not collapse real-goal recall (ADAAAA-7072).
    for obs in (
        "The ball is seen entering the net after beating the keeper.",
        "The striker struck the ball into the net.",
        "The ball crossed the goal line between the posts.",
    ):
        assert _model_plainly_saw_goal(
            {"verdict": {"independentlyObserved": obs, "criteria": {"ballInNet": None}}}
        ) is True, obs


def test_accept_with_entered_net_read_surfaces_goal():
    decision = _goal_decision(
        verdict={
            "independentlyObserved": "The ball is seen entering the net, keeper beaten.",
            "criteria": {"ballInNet": None, "ballCrossedLineBetweenPosts": None},
        }
    )
    ok, _ = apply_frame_grounding_gate(decision, "GOAL")
    assert ok is True
    assert decision["isHighlight"] is True
    assert decision["outcome"] == "scoring_play"


# ---- ADAAAA-7073 regression: do NOT over-correct a contested real goal -------


def test_contested_goal_ending_in_net_is_not_downgraded():
    # The empirical re-eval (ADAAAA-7073) surfaced that a REAL goal on a
    # scrambled / contested free-kick (defenders and keeper near the ball) was
    # misread as "blocked by defenders ... does not enter the net" and then
    # suppressed, collapsing real-goal recall. A read that plainly states the
    # ball ENDS IN THE NET / crosses between the posts is a GOAL even when the
    # model also mentions defenders/keeper contesting the shot. The frame gate
    # must surface it (recall preserved), never downgrade it to a block.
    for obs in (
        "After a scramble in the box the ball ends in the net despite the defenders' attempts.",
        "The striker's shot is deflected by a defender but still crosses the line between the posts.",
        "The keeper dives but is beaten and the ball settles in the net after a goalmouth scramble.",
    ):
        ok, _ = apply_frame_grounding_gate(
            _goal_decision(
                verdict={
                    "independentlyObserved": obs,
                    "criteria": {"ballInNet": None, "ballCrossedLineBetweenPosts": None},
                }
            ),
            "GOAL",
        )
        assert ok is True, obs
        assert _model_plainly_saw_goal(
            {"verdict": {"independentlyObserved": obs, "criteria": {"ballInNet": None}}}
        ) is True, obs


def test_contested_goal_criteria_true_is_not_downgraded():
    # Even when the model mentions defenders, if it sets the binary criteria to
    # true the gate must accept (criteria are the primary frame signal).
    ok, _ = apply_frame_grounding_gate(
        _goal_decision(
            verdict={
                "independentlyObserved": "The ball is blocked or diverted by defenders in the box.",
                "criteria": {"ballInNet": True, "ballCrossedLineBetweenPosts": None},
            }
        ),
        "GOAL",
    )
    assert ok is True


def test_blocked_read_that_stays_out_is_still_not_a_goal():
    # Guard the FPR side: a read that plainly says the ball is KEPT OUT (does
    # NOT cross the line / enter the net) is a genuine block, NOT a goal. This
    # preserves the frame-grounding / no-hallucination requirement (req 6).
    decision = _goal_decision(
        verdict={
            "independentlyObserved": "The shot is blocked by defenders in the box and does not enter the net.",
            "criteria": {"ballInNet": False, "ballCrossedLineBetweenPosts": False},
        }
    )
    ok, _ = apply_frame_grounding_gate(decision, "GOAL")
    assert ok is False
    assert decision["isHighlight"] is False
    assert decision["outcome"] == "not_highlight"


def test_unattested_confabulated_goal_rejected_by_production_compose():
    # ADAAAA-7078 measured a residual goal FPR (12.5%, neg-03) but applied only
    # the two ADAAAA-7070 gates in isolation, BYPASSING the production
    # apply_goal_attestation_gate that runs FIRST in _postprocess_gemma_verdict /
    # the single-candidate gemma path. That isolated verdict is a harness artifact:
    # a confabulated goal read with NO independent attestation (no ballOutcome=goal
    # / goalCrossed / scoreBoardChanged / ballInNet) is only a false goal if a gate
    # trusts the model's self-reported read. In the production compose the
    # attestation gate rejects it before the frame gate ever sees it. Lock that in
    # so the artifact cannot silently recur on a future re-measure.
    decision = {
        "isHighlight": True,
        "outcome": "scoring_play",
        "eventType": "GOAL",
        "eventClass": "goal",
        "source": "gemma",
        "score": 0.9,
        "reason": "The ball clearly enters the net after a shot from a player in a white and blue kit.",
        "verdict": {
            "criteria": {"ballInNet": True, "ballCrossedLineBetweenPosts": True},
            "independentlyObserved": "A shot from a player in white and blue; the ball enters the net.",
        },
    }
    evidence = {"trackCount": 1, "maxVelocity": 0, "ocrHits": 0, "reaction": {}}
    out = dict(_postprocess_gemma_verdict(decision, evidence, "GOAL", []))
    assert out["isHighlight"] is False
    assert "no attested goal criterion" in (out.get("reason") or "")



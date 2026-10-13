"""ADAAAA-6610 — goal-verification attestation gate unit tests.

Locks the ADAAAA-6588 crit 2/3 residual: the accept path must NOT trust the
model's self-reported `outcome` (scoring_play) alone, because the model
CONFABULATES templated `scoring_play` on non-goal frames (26 accepted GOAL
highlights, all templated reason, all in a start-of-clip burst). An accepted
goal whose reason is bare templated AND which carries no attested independent
goal criterion (perceive ballOutcome=goal / goalCrossed / scoreboard score
change) must be REJECTED.

Deliberately narrow (ADAAAA-6533/6543 recall contract): an ATTESTED goal and a
specific frame-grounded reason both always pass — never collapse recall by
gating on the mere ABSENCE of a homography.
"""
from app.gemma import (
    attested_goal_criterion,
    apply_goal_attestation_gate,
    is_bare_templated_reason,
)


TEMPLATED = "The ball clearly enters the net, and the crowd/players celebrate wildly."


def test_attested_criterion_requires_measured_signal():
    # Only perceive's measured signals count as attestation.
    assert attested_goal_criterion({"ballOutcome": "goal"}) is True
    assert attested_goal_criterion({"goalCrossed": True}) is True
    assert attested_goal_criterion({"scoreBoardChanged": True}) is True
    # A near-miss / off-target ballOutcome is NOT a goal attestation.
    assert attested_goal_criterion({"ballOutcome": "off_target"}) is False
    assert attested_goal_criterion({"ballOutcome": "blocked"}) is False
    # Model self-report is never an attestation (that is the confabulation).
    assert attested_goal_criterion(
        {"verdict": {"criteria": {"ballInNet": True}}}
    ) is False
    assert attested_goal_criterion({}) is False
    assert attested_goal_criterion(None) is False


def test_is_bare_templated_reason_needs_both_markers():
    assert is_bare_templated_reason(
        "The ball clearly enters the net, and the crowd/players celebrate wildly."
    ) is True
    # A net-entry phrase without the crowd/celebration boilerplate is NOT the
    # template — it is at least partly specific.
    assert is_bare_templated_reason("The ball clearly enters the net.") is False
    # A celebration phrase without a net-entry phrase is NOT the template.
    assert is_bare_templated_reason("The crowd erupts in celebration.") is False
    assert is_bare_templated_reason(None) is False
    assert is_bare_templated_reason("") is False
    # A genuinely specific reason is never templated.
    assert is_bare_templated_reason(
        "Quick counter-attack; the striker slots it low into the far corner past the keeper."
    ) is False


def test_verb_stem_variant_is_templated_and_rejected():
    # ADAAAA-6610 E2E (VOD t=73): the SOLE accepted GOAL of the run was a
    # broadcast OPEN-PLAY false positive (Doku, ball nowhere near a net) whose
    # confabulated reason used "ENTERING the net" — the old "enters the net"
    # literal marker missed it, so the gate let it through. The verb-stem regex
    # must now catch the whole family and, with no attested criterion, reject it.
    reasons = [
        "The ball is seen entering the net, and the crowd and players are reacting with high-motion celebration.",
        "The ball enters the net, and the crowd and players celebrate.",
        "The ball clearly enters the net, and players erupt in celebration.",
        "The ball was seen to have crossed the goal line, and the crowd erupts.",
    ]
    for reason in reasons:
        assert is_bare_templated_reason(reason) is True, reason
        decision = {
            "isHighlight": True,
            "outcome": "scoring_play",
            "eventType": "GOAL",
            "reason": reason,
        }
        ok, gate_reason = apply_goal_attestation_gate(decision, {}, "GOAL")
        assert ok is False, reason
        assert gate_reason is not None
        assert "no attested goal criterion" in gate_reason
    # An attested version of the same reason is kept (true goals still captured).
    attested = {
        "isHighlight": True,
        "outcome": "scoring_play",
        "eventType": "GOAL",
        "reason": "The ball is seen entering the net, and the crowd and players are reacting with high-motion celebration.",
    }
    ok, _ = apply_goal_attestation_gate(attested, {"scoreBoardChanged": True}, "GOAL")
    assert ok is True


def test_rejects_templated_goal_with_no_attestation():
    decision = {
        "isHighlight": True,
        "outcome": "scoring_play",
        "eventType": "GOAL",
        "reason": TEMPLATED,
    }
    ok, reason = apply_goal_attestation_gate(decision, {}, "GOAL")
    assert ok is False
    assert reason is not None
    assert "no attested goal criterion" in reason


def test_attested_templated_goal_is_kept():
    # A real goal the oracle measured is kept even if the model phrased it with
    # boilerplate (accept criterion: true goals still captured).
    for evidence in (
        {"ballOutcome": "goal"},
        {"goalCrossed": True},
        {"scoreBoardChanged": True},
    ):
        decision = {"isHighlight": True, "outcome": "scoring_play", "eventType": "GOAL", "reason": TEMPLATED}
        ok, _ = apply_goal_attestation_gate(decision, evidence, "GOAL")
        assert ok is True


def test_specific_reason_without_attestation_is_kept():
    # ADAAAA-6543 recall contract: never gate on the ABSENCE of a homography.
    decision = {
        "isHighlight": True,
        "outcome": "scoring_play",
        "eventType": "GOAL",
        "reason": "Striker slots it low into the far corner past the keeper.",
    }
    ok, _ = apply_goal_attestation_gate(decision, {}, "GOAL")
    assert ok is True


def test_non_goal_accept_never_gated():
    # A non-goal / non-scoring highlight is untouched by the goal-attestation
    # gate (it is only about GOAL verification).
    for decision in (
        {"isHighlight": True, "outcome": "big_play", "eventType": "BIG_SAVE", "reason": TEMPLATED},
        {"isHighlight": False, "outcome": "not_highlight", "eventType": "GOAL", "reason": TEMPLATED},
        {"isHighlight": True, "outcome": "scoring_play", "eventType": "DUNK", "reason": TEMPLATED},
    ):
        ok, _ = apply_goal_attestation_gate(decision, {}, decision["eventType"])
        assert ok is True


def test_event_type_goal_alone_triggers_gate():
    # An accepted GOAL event with a templated, unattested reason is rejected even
    # when the model set outcome to something else.
    decision = {"isHighlight": True, "outcome": "big_play", "eventType": "GOAL", "reason": TEMPLATED}
    ok, reason = apply_goal_attestation_gate(decision, {}, "GOAL")
    assert ok is False
    assert reason is not None

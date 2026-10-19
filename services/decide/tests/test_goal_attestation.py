"""ADAAAA-6610 — goal-verification attestation gate unit tests.

Locks the ADAAAA-6588 crit 2/3 residual: the accept path must NOT trust the
model's self-reported `outcome` (scoring_play) alone, because the model
CONFABULATES templated `scoring_play` on non-goal frames (26 accepted GOAL
highlights, all templated reason, all in a start-of-clip burst). An accepted
goal whose reason is bare templated AND which carries no attested independent
goal criterion (perceive ballOutcome=goal / goalCrossed / scoreboard score
change) must be REJECTED.

Deliberately the OPPOSITE of the old recall-preserving behavior (ADAAAA-6543 no
longer holds): an accepted goal whose reason is "specific" but which carries NO
attested independent goal criterion (perceive ballOutcome=goal / goalCrossed /
scoreboard score change) is ALSO rejected, because the E2E proved the model
confabulates a specific "ball clearly seen inside the net, goalkeeper beaten"
reason on a frame with no goal. An ACCEPTED goal requires the independent
attestation — the model's reason alone, templated or specific, is never
sufficient.
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
    # ADAAAA-7044: the geometry-agnostic ball-in-net attestation also counts.
    assert attested_goal_criterion({"ballInNet": True}) is True
    # A near-miss / off-target ballOutcome is NOT a goal attestation.
    assert attested_goal_criterion({"ballOutcome": "off_target"}) is False
    assert attested_goal_criterion({"ballOutcome": "blocked"}) is False
    # A measured ballInNet=False is NEVER an attestation.
    assert attested_goal_criterion({"ballInNet": False}) is False
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
        {"ballInNet": True},  # ADAAAA-7044 geometry-agnostic attestation
    ):
        decision = {"isHighlight": True, "outcome": "scoring_play", "eventType": "GOAL", "reason": TEMPLATED}
        ok, _ = apply_goal_attestation_gate(decision, evidence, "GOAL")
        assert ok is True


def test_specific_reason_without_attestation_is_rejected():
    # ADAAAA-6610 E2E: a "specific" reason is NOT sufficient — the model
    # confabulates a specific goal-sounding reason on non-goal frames (open
    # play / keeper holding the ball) with no independent attestation, so it
    # must be rejected rather than accepted on the model's word.
    decision = {
        "isHighlight": True,
        "outcome": "scoring_play",
        "eventType": "GOAL",
        "reason": "Striker slots it low into the far corner past the keeper.",
    }
    ok, reason = apply_goal_attestation_gate(decision, {}, "GOAL")
    assert ok is False
    assert reason is not None
    assert "no attested goal criterion" in reason


def test_confabulated_specific_goal_reason_is_rejected():
    # ADAAAA-6610 fresh full-VOD E2E (job 0c4f578f): two accepted GOALs were
    # frame-confirmed FALSE POSITIVES (clip = goalkeeper holding the ball
    # outside the net; source VOD t=175 = open-play penalty-area scramble, ball
    # in the air) whose confabulated reasons used "inside the net / entering the
    # net" + "goalkeeper beaten" — no crowd/celebration marker, so the verb-stem
    # template did NOT catch them. Unattested specific reasons must be rejected.
    for reason in (
        "The ball is clearly seen inside the net, and the goalkeeper has been beaten.",
        "The ball is clearly seen entering the net, and the goalkeeper is beaten.",
        "The ball is clearly inside the net, and the goalkeeper is beaten.",
    ):
        decision = {
            "isHighlight": True,
            "outcome": "scoring_play",
            "eventType": "GOAL",
            "reason": reason,
        }
        ok, _ = apply_goal_attestation_gate(decision, {}, "GOAL")
        assert ok is False, reason
    # An attested version of the same confabulated phrasing is kept (a real goal
    # the oracle measured is still accepted).
    attested = {
        "isHighlight": True,
        "outcome": "scoring_play",
        "eventType": "GOAL",
        "reason": "The ball is clearly seen inside the net, and the goalkeeper has been beaten.",
    }
    ok, _ = apply_goal_attestation_gate(attested, {"scoreBoardChanged": True}, "GOAL")
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


def test_confirm_enabled_defers_unattested_goal_to_confirm(monkeypatch):
    # ADAAAA-6973 (Option 1): when the Stage-2 confirmation pass is ENABLED
    # (DECIDE_CONFIRM_ENABLED=1), an un-attested goal accept must NOT be
    # hard-rejected at Stage-A — it passes through so the server's
    # shouldRunConfirm fires and the /confirm deep-frame dive becomes the
    # attestation (goalConfirmed=confirmed_goal). The final highlight is gated by
    # that dive, not dropped here.
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    for reason in (
        TEMPLATED,
        "The ball clearly enters the net, and the crowd and players react.",  # templated + reaction
        "Striker slots it low into the far corner past the keeper.",  # "specific" but unattested
    ):
        decision = {
            "isHighlight": True,
            "outcome": "scoring_play",
            "eventType": "GOAL",
            "reason": reason,
        }
        ok, gate_reason = apply_goal_attestation_gate(decision, {}, "GOAL")
        assert ok is True, reason
        assert gate_reason is None, reason


def test_confirm_disabled_still_rejects_unattested_goal(monkeypatch):
    # With the confirmation pass OFF (default / live flag-off path), the strict
    # attestation gate is byte-for-byte preserved: an un-attested goal accept is
    # rejected (the model alone is never trusted).
    monkeypatch.delenv("DECIDE_CONFIRM_ENABLED", raising=False)
    for reason in (
        TEMPLATED,
        "Striker slots it low into the far corner past the keeper.",
    ):
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

"""ADAAAA-6610 / ADAAAA-7070 — goal-verification tests.

Perceive is a DATA source, not a decision signal (CEO directive ADAAAA-7070): a
perceived ``ballOutcome`` / ``goalCrossed`` / ``ballInNet`` / scoreboard change
no longer attests a goal. The legacy ``apply_goal_attestation_gate`` is
superseded and never rejects. Anti-confabulation is now enforced by the
goal/net frame-grounding gate (``apply_frame_grounding_gate``), which surfaces a
GOAL only when the model's PASS 1 frame read plainly saw the ball in the net /
across the line / the keeper beaten with the ball in the goal.
"""
from app.gemma import apply_goal_attestation_gate, apply_frame_grounding_gate, is_bare_templated_reason


TEMPLATED = "The ball clearly enters the net, and the crowd/players celebrate wildly."


def _goal_decision(reason=None, verdict=None):
    d = {"isHighlight": True, "outcome": "scoring_play", "eventType": "GOAL", "reason": reason or TEMPLATED}
    if verdict is not None:
        d["verdict"] = verdict
    return d


def test_attestation_gate_never_rejects():
    # Perceive no longer attests (data only); the gate is superseded and never
    # rejects — the frame-grounding gate is the sole GOAL authority.
    for parent in (
        {"isHighlight": True, "outcome": "scoring_play", "eventType": "GOAL", "reason": TEMPLATED},
        {"isHighlight": True, "outcome": "big_play", "eventType": "BIG_SAVE", "reason": TEMPLATED},
        {"isHighlight": False, "outcome": "not_highlight", "eventType": "GOAL", "reason": TEMPLATED},
        {"isHighlight": True, "outcome": "scoring_play", "eventType": "DUNK", "reason": TEMPLATED},
    ):
        ok, gate_reason = apply_goal_attestation_gate(parent, {}, parent.get("eventType") or "GOAL")
        assert ok is True
        assert gate_reason is None


def test_is_bare_templated_reason_needs_both_markers():
    assert is_bare_templated_reason(
        "The ball clearly enters the net, and the crowd/players celebrate wildly."
    ) is True
    assert is_bare_templated_reason("The ball clearly enters the net.") is False
    assert is_bare_templated_reason("The crowd erupts in celebration.") is False
    assert is_bare_templated_reason(None) is False
    assert is_bare_templated_reason("") is False
    assert is_bare_templated_reason(
        "Quick counter-attack; the striker slots it low into the far corner past the keeper."
    ) is False


def test_frame_grounding_rejects_templated_unseen_goal():
    # Anti-confabulation now lives in the frame-grounding gate: a bare templated
    # reason with no frame read is NOT surfaced as a goal.
    decision = _goal_decision(reason=TEMPLATED, verdict={"criteria": {"ballInNet": None, "ballCrossedLineBetweenPosts": None, "scoreboardChanged": None, "crowdErupted": None}, "independentlyObserved": "Not clear whether a goal occurred; I cannot confirm the ball crossed the line."})
    ok, reason = apply_frame_grounding_gate(decision, "GOAL")
    assert ok is False
    assert decision["isHighlight"] is False
    assert decision["outcome"] == "not_highlight"


def test_frame_grounding_accepts_frame_grounded_goal():
    # A frame-grounded PASS 1 read (model plainly saw the ball in the net)
    # corroborated by an independent data signal is accepted (ADAAAA-7070 data
    # backstop: the model read is no longer the sole authority).
    decision = _goal_decision(
        reason="Striker slots it low into the far corner past the keeper; the ball is clearly in the net.",
        verdict={"criteria": {"ballInNet": True, "ballCrossedLineBetweenPosts": True}, "independentlyObserved": "The striker shoots low; the ball crosses the line into the net."},
    )
    ok, _ = apply_frame_grounding_gate(decision, "GOAL", {"scoreBoardChanged": True})
    assert ok is True

"""Tests for the ADAAAA-7844 fixture-bank re-score (AC4).

Pinned to the committed fixture bank so the AC4 numbers are reproducible without
the box: the guarded build's accepted set must show scoreboard-labelled GOALs
whose own frames say the score did not change BEFORE the rule, and none after.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EVAL = os.path.dirname(HERE)
sys.path.insert(0, EVAL)

import rescore_scoreboard_contradiction as rs  # noqa: E402
from score_goal_precision import goal_windows  # noqa: E402


def _fixture():
    detail = rs._load(rs.DEFAULT_FIXTURE)
    notes = rs.notes_by_ts(detail)
    goals = goal_windows(rs._load(rs.DEFAULT_MANIFEST))
    return detail, notes, goals


def test_guarded_fixture_has_scoreboard_labelled_cards_its_frames_refute():
    detail, notes, goals = _fixture()
    ab = rs._load(rs.DEFAULT_GUARD_AB)
    by_t = {round(float(c["t"]), 1): c for c in ab["guarded"]["cards"]}
    cards = rs.accepted_cards(detail)
    for card in cards:
        rec = by_t.get(round(card["t"], 1))
        card["corroborationSource"] = rec.get("corroborationSource") if rec else None
        card["trigger_ts"] = rec.get("t") if rec else card["t"]
    rows = rs.rescore(cards, notes, goals)
    contradicted = [r for r in rows if r["contradicted_scoreboard"]]
    # The recorded build shipped two of these; that is the FP class AC4 closes.
    assert len(contradicted) == 2
    # Both were real goals with a two-signal frame read, so they are relabelled,
    # not dropped (no recall loss).
    assert all(r["new_source"] == "frame_attestation" for r in contradicted)
    assert not any(r["dropped"] for r in rows)


def test_no_accepted_goal_is_scoreboard_labelled_against_its_frames_after_the_fix():
    detail, notes, goals = _fixture()
    ab = rs._load(rs.DEFAULT_GUARD_AB)
    by_t = {round(float(c["t"]), 1): c for c in ab["guarded"]["cards"]}
    cards = rs.accepted_cards(detail)
    for card in cards:
        rec = by_t.get(round(card["t"], 1))
        card["corroborationSource"] = rec.get("corroborationSource") if rec else None
        card["trigger_ts"] = rec.get("t") if rec else card["t"]
    rows = rs.rescore(cards, notes, goals)
    still_contradicted = [
        r for r in rows
        if (not r["dropped"]) and r["new_source"] == "scoreboard"
        and r["frames_scoreboardChanged"] is False
    ]
    assert still_contradicted == []


def test_a_scoreboard_card_without_another_anchor_is_dropped():
    """The dee44c2f-class worst case: a scoreboard-labelled window whose frames
    say the score did not change AND which has no two-signal frame attestation
    loses its corroboration entirely (downgraded to near_miss)."""
    card = {"t": 117.0, "start": 110.0, "end": 125.0, "trigger_ts": 117.0,
            "corroborationSource": "scoreboard"}
    note = {"timestamp": 117.0, "analysis": {"response": {"verdict": {"criteria": {
        "ballInNet": True, "ballCrossedLineBetweenPosts": False,
        "scoreboardChanged": False,
    }}}}}
    rows = rs.rescore([card], {117.0: note}, [])
    row = rows[0]
    assert row["contradicted_scoreboard"] is True
    assert row["new_source"] is None
    assert row["dropped"] is True

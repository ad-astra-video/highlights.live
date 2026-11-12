"""ADAAAA-8820 (D2) — the Stage-2 dive NAMES THE CLIP MOMENT.

Locks the moment half of the approved D2 contract (spec §4/§5, AC2.1):

- the dense frame grid the dive is shown is labelled with its CONTENT-CLOCK
  instants, so the model can answer with a time instead of a feeling;
- a moment the model names is SNAPPED onto a frame that was actually sent — a
  free-hand instant is never accepted, and a pass with no grid names nothing;
- ``momentTs`` (nullable) + ``momentConfidence`` ride EVERY verdict, including
  the passthrough, so "no moment named" is distinguishable from "an old service";
- no extra model call is made for the moment (``_call_gemma`` is monkeypatched
  once per case in the run-pass tests, as the rest of this suite does).

Runs with no real gemma server, $0.
"""
import json

import pytest

from app import confirm as cf
from app.confirm import (
    build_confirm_prompt,
    frame_instants,
    parse_moment,
    run_confirmation_pass,
    snap_moment,
)

GRID = [40.0, 40.75, 41.5, 42.25]


def _frames(grid=GRID):
    return [{"role": "full", "base64": "x", "ts": t} for t in grid]


def _stage1():
    return {"outcome": "scoring_play", "isHighlight": True, "score": 72, "eventType": "GOAL", "reason": "shot"}


def _reply(**over):
    base = {
        "goalConfirmed": "confirmed_goal",
        "confidence": 0.9,
        "reason": "ball crosses the line and is in the net",
        "evidence": {"ballInNet": True, "ballTrajectoryCrossedLine": True},
        "outcome": "scoring_play",
        "score": 80,
        "eventType": "GOAL",
    }
    base.update(over)
    return json.dumps(base)


# --- the grid ---------------------------------------------------------------


def test_frame_instants_reads_the_sent_grid():
    assert frame_instants(_frames()) == GRID


def test_frame_instants_needs_every_frame_labelled():
    # A partial grid cannot be snapped against: absent evidence is never invented.
    mixed = [{"base64": "x", "ts": 40.0}, {"base64": "y"}]
    assert frame_instants(mixed) == []


def test_frame_instants_rejects_a_non_content_instant():
    assert frame_instants([{"base64": "x", "ts": -1.0}]) == []
    assert frame_instants([{"base64": "x", "ts": "not-a-time"}]) == []
    assert frame_instants([]) == []


# --- snapping ---------------------------------------------------------------


def test_snap_moment_takes_the_nearest_sent_frame():
    assert snap_moment(41.6, GRID) == 41.5
    assert snap_moment(40.1, GRID) == 40.0
    assert snap_moment("41.0", GRID) == 40.75


def test_snap_moment_accepts_a_frame_label():
    assert snap_moment("f2", GRID) == 41.5
    assert snap_moment("frame 3", GRID) == 42.25
    # out-of-range label names no sent frame
    assert snap_moment("f9", GRID) is None


def test_snap_moment_refuses_an_instant_the_dive_never_saw():
    # > MOMENT_MAX_GRID_GAP_S outside the grid = a guess about an unsent frame.
    assert snap_moment(52.0, GRID) is None
    assert snap_moment(None, GRID) is None
    assert snap_moment(True, GRID) is None


def test_snap_moment_without_a_grid_is_never_an_instant():
    assert snap_moment(41.5, []) is None


# --- (momentTs, momentConfidence) -------------------------------------------


def test_parse_moment_clamps_confidence_and_nulls_a_missing_moment():
    ts, conf = parse_moment({"momentTs": 41.6, "momentConfidence": 1.7}, GRID)
    assert ts == 41.5
    assert conf == 1.0
    # a confidence about nothing is not a number a re-cut may act on
    assert parse_moment({"momentConfidence": 0.9}, GRID) == (None, 0.0)
    assert parse_moment(None, GRID) == (None, 0.0)


# --- the prompt -------------------------------------------------------------


def test_prompt_labels_the_dense_frame_grid_and_asks_for_the_moment():
    prompt = build_confirm_prompt(
        event_type="GOAL",
        game_hint="soccer",
        stage1=_stage1(),
        n_frames=len(GRID),
        n_keyframes=0,
        trajectories=[],
        optical_flow=0.0,
        flow_magnitudes=[],
        audio_levels=[],
        transcript="",
        ball_outcome=None,
        goal_crossed=None,
        scoreboard_changed=False,
        frame_times=GRID,
    )
    assert "dense frame instants (content clock" in prompt
    assert "40.00, 40.75, 41.50, 42.25" in prompt
    assert "STEP 4 — NAME THE MOMENT" in prompt
    assert "momentTs" in prompt
    assert "momentConfidence" in prompt


def test_prompt_without_a_grid_does_not_claim_one():
    prompt = build_confirm_prompt(
        event_type="GOAL",
        game_hint="",
        stage1=_stage1(),
        n_frames=2,
        n_keyframes=0,
        trajectories=[],
        optical_flow=0.0,
        flow_magnitudes=[],
        audio_levels=[],
        transcript="",
        ball_outcome=None,
        goal_crossed=None,
        scoreboard_changed=False,
    )
    # the grid LINE is only rendered when a grid exists (the instruction text
    # always mentions it, because it tells the model how to answer).
    assert "dense frame instants (content clock" not in prompt
    # the field is still part of the shape; the model answers null for it.
    assert "momentTs" in prompt


# --- the contract on every verdict (AC2.1) ----------------------------------


def test_passthrough_carries_the_nullable_moment(monkeypatch):
    monkeypatch.delenv("DECIDE_CONFIRM_ENABLED", raising=False)
    resp = run_confirmation_pass({"stage1": _stage1(), "eventType": "GOAL", "frames": _frames()})
    assert resp["goalConfirmed"] is None
    assert resp["momentTs"] is None
    assert resp["momentConfidence"] == 0.0


def test_run_pass_returns_the_snapped_moment(monkeypatch):
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("AUDIO_CONTEXT", "0")
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: _reply(momentTs=41.6, momentConfidence=0.82))
    resp = run_confirmation_pass({"stage1": _stage1(), "eventType": "GOAL", "frames": _frames()})
    assert resp["goalConfirmed"] == "confirmed_goal"
    assert resp["momentTs"] == 41.5, "the moment must land on a frame that was actually sent"
    assert resp["momentConfidence"] == pytest.approx(0.82)


def test_run_pass_with_no_named_moment_reports_null(monkeypatch):
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("AUDIO_CONTEXT", "0")
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: _reply(momentConfidence=0.7))
    resp = run_confirmation_pass({"stage1": _stage1(), "eventType": "GOAL", "frames": _frames()})
    assert resp["goalConfirmed"] == "confirmed_goal"
    assert resp["momentTs"] is None
    assert resp["momentConfidence"] == 0.0


def test_run_pass_with_unlabelled_frames_never_invents_a_moment(monkeypatch):
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("AUDIO_CONTEXT", "0")
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: _reply(momentTs=41.6, momentConfidence=0.9))
    resp = run_confirmation_pass(
        {"stage1": _stage1(), "eventType": "GOAL", "frames": [{"role": "full", "base64": "x"}]}
    )
    assert resp["goalConfirmed"] == "confirmed_goal"
    assert resp["momentTs"] is None, "no grid was sent, so no instant may be claimed"


# --- the WIRE contract (ADAAAA-8838) ----------------------------------------
# A pass that builds the moment is not enough. The route answers with
# ``ConfirmDecision(**result)``, and that model is ``extra="ignore"`` — a field
# the pass produced but the model never DECLARED is silently dropped at the HTTP
# boundary. That is exactly how the served build read ``momentTs: null`` on every
# live confirm while the dict-level tests above passed: the moment existed inside
# the process and never reached the server.


def test_response_model_declares_the_moment():
    assert "momentTs" in cf.ConfirmDecision.model_fields
    assert "momentConfidence" in cf.ConfirmDecision.model_fields


def test_response_model_carries_a_numeric_moment_to_the_wire():
    wire = cf.ConfirmDecision(
        **{
            "enabled": True,
            "goalConfirmed": "confirmed_goal",
            "momentTs": 41.5,
            "momentConfidence": 0.82,
        }
    ).model_dump()
    assert wire["momentTs"] == 41.5
    assert wire["momentConfidence"] == pytest.approx(0.82)


def test_response_model_keeps_an_unnamed_moment_null_on_the_wire():
    wire = cf.ConfirmDecision(**{"enabled": True, "goalConfirmed": "near_miss"}).model_dump()
    assert "momentTs" in wire and wire["momentTs"] is None
    assert "momentConfidence" in wire and wire["momentConfidence"] is None


def test_route_construction_carries_the_run_pass_moment(monkeypatch):
    """The exact construction the /confirm route performs: pass dict -> model."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("AUDIO_CONTEXT", "0")
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: _reply(momentTs=41.6, momentConfidence=0.82))
    result = run_confirmation_pass({"stage1": _stage1(), "eventType": "GOAL", "frames": _frames()})
    wire = cf.ConfirmDecision(**result).model_dump()
    assert wire["goalConfirmed"] == "confirmed_goal"
    assert wire["momentTs"] == 41.5, "the snapped moment must survive the response model"
    assert wire["momentConfidence"] == pytest.approx(0.82)


def test_route_construction_keeps_the_passthrough_nullable(monkeypatch):
    monkeypatch.delenv("DECIDE_CONFIRM_ENABLED", raising=False)
    result = run_confirmation_pass({"stage1": _stage1(), "eventType": "GOAL", "frames": _frames()})
    wire = cf.ConfirmDecision(**result).model_dump()
    assert wire["goalConfirmed"] is None
    assert "momentTs" in wire and wire["momentTs"] is None

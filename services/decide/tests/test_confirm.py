"""ADAAAA-6797 — Stage-2 goal/near-miss confirmation pass unit tests.

Locks the confirmation-pass contract: (1) the pass is gated by
``DECIDE_CONFIRM_ENABLED`` (default off -> passthrough, no regression); (2) the
contradictory-hypothesis prompt and the structured ``goalConfirmed`` parse; (3)
the deterministic reconcile (confirmed_goal -> scoring_play goal highlight;
near_miss -> near_miss, never a board goal; not_goal -> not a highlight); and
(4) the Stage-1 vs Stage-2 disagreement rate flag. Runs with no real gemma
server (``_call_gemma`` is monkeypatched).
"""
import os

import pytest

from app import app
from app import confirm as cf
from app.confirm import (
    ConfirmDecision,
    parse_confirm,
    reconcile_confirmed_goal,
    run_confirmation_pass,
    stage1_disagrees,
    _norm_evidence,
)
from fastapi.testclient import TestClient

client = TestClient(app)


# --- disabled / passthrough -------------------------------------------------


def test_disabled_by_default_passthrough(monkeypatch):
    monkeypatch.delenv("DECIDE_CONFIRM_ENABLED", raising=False)
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 72, "reason": "stage1 reason", "eventType": "GOAL"}
    req = {"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}]}
    resp = run_confirmation_pass(req)
    assert resp["enabled"] is False
    assert resp["goalConfirmed"] is None
    # decision passes the Stage-1 verdict through unchanged.
    assert resp["decision"] == stage1


def test_endpoint_confirm_disabled_returns_passthrough(monkeypatch):
    monkeypatch.delenv("DECIDE_CONFIRM_ENABLED", raising=False)
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 75, "reason": "r", "eventType": "GOAL"}
    data = client.post(
        "/confirm",
        json={"eventType": "GOAL", "stage1": stage1, "frames": [{"base64": "x"}]},
    )
    assert data.status_code == 200
    body = data.json()
    assert body["enabled"] is False
    assert body["goalConfirmed"] is None
    assert body["decision"] == stage1


# --- parse ----------------------------------------------------------------


def test_parse_confirm_accepts_closed_set():
    for val in ("confirmed_goal", "near_miss", "not_goal"):
        parsed = parse_confirm(
            '{"goalConfirmed": "%s", "confidence": 0.9, "reason": "r", '
            '"evidence": {"ballInNet": true, "audioErupted": null}}' % val
        )
        assert parsed is not None
        assert parsed["goalConfirmed"] == val
        # tri-state: a bool stays, a non-bool/null becomes None.
        ev = parsed["evidence"]
        assert ev["ballInNet"] is True
        assert ev["audioErupted"] is None


def test_parse_confirm_rejects_bad_verdict():
    assert parse_confirm('{"goalConfirmed": "maybe_goal", "confidence": 0.5}') is None
    assert parse_confirm('{"confidence": 0.5}') is None
    assert parse_confirm("not json at all") is None
    # fenced JSON still parses.
    parsed = parse_confirm('```json\n{"goalConfirmed": "near_miss", "confidence": 0.7}\n```')
    assert parsed is not None
    assert parsed["goalConfirmed"] == "near_miss"


def test_norm_evidence_coerces_tristate():
    ev = _norm_evidence(
        {"ballTrajectoryCrossedLine": True, "ballInNet": False, "sustainedScoringMotion": "yes"}
    )
    assert ev["ballTrajectoryCrossedLine"] is True
    assert ev["ballInNet"] is False
    assert ev["sustainedScoringMotion"] is None


# --- disagreement ----------------------------------------------------------


def test_stage1_disagrees():
    # Stage-1 said goal, confirm refutes -> disagree.
    assert stage1_disagrees({"outcome": "scoring_play"}, "near_miss") is True
    assert stage1_disagrees({"outcome": "scoring_play"}, "not_goal") is True
    # Stage-1 said goal, confirm confirms -> agree.
    assert stage1_disagrees({"outcome": "scoring_play"}, "confirmed_goal") is False
    # Stage-1 said not-goal, confirm confirms goal -> disagree (a corrected reject).
    assert stage1_disagrees({"outcome": "not_highlight"}, "confirmed_goal") is True
    assert stage1_disagrees({"outcome": "near_miss"}, "confirmed_goal") is True
    # Stage-1 said near_miss, confirm says near_miss -> agree.
    assert stage1_disagrees({"outcome": "near_miss"}, "near_miss") is False


# --- reconcile -------------------------------------------------------------


def test_reconcile_confirmed_goal_is_scoring_play():
    d = reconcile_confirmed_goal("confirmed_goal", {"outcome": "near_miss", "score": 40, "eventType": "GOAL"}, comment="ball crossed the line")
    assert d["outcome"] == "scoring_play"
    assert d["isHighlight"] is True
    assert d["nearMiss"] is False
    assert d["score"] >= 60  # confirmed goal never sits below the scoring bar
    assert "confirmed" in d["reason"]


def test_reconcile_near_miss_is_not_board_goal():
    d = reconcile_confirmed_goal("near_miss", {"outcome": "scoring_play", "score": 80, "eventType": "GOAL"})
    assert d["outcome"] == "near_miss"
    assert d["nearMiss"] is True
    assert d["isHighlight"] is False  # ADAAAA-6598: a near miss is never a board goal
    assert d["score"] < 60


def test_reconcile_not_goal_is_not_highlight():
    d = reconcile_confirmed_goal("not_goal", {"outcome": "scoring_play", "score": 88, "eventType": "GOAL"})
    assert d["outcome"] == "not_highlight"
    assert d["isHighlight"] is False
    assert d["nearMiss"] is False


def test_reconcile_never_raises_on_bad_stage1():
    d = reconcile_confirmed_goal("near_miss", {"score": "not-a-number"})
    assert d["outcome"] == "near_miss"
    assert d["isHighlight"] is False


def test_reconcile_promotes_demoted_goal_on_stage1_scoreboard_narration():
    """ADAAAA-7408 (AC1): the deep-dive conservatively demotes a REAL regulation
    goal to near_miss when it cannot read the scoreboard in its narrower frames,
    even though the Stage-1 reason explicitly narrated the scoreboard change
    ("scoreboard updates from 2-1 to 2-2"). A corroborated goal whose score
    change the Stage-1 read asserted must not be sabotaged by that
    corroboration-availability artifact: it is kept as a scoring_play goal."""
    d = reconcile_confirmed_goal(
        "near_miss",
        {"outcome": "scoring_play", "isHighlight": True, "score": 78, "eventType": "GOAL",
         "reason": "The ball is clearly seen entering the net, and the scoreboard updates from 2-1 to 2-2."},
        comment="there is no scoreboard change to confirm a goal",
        corroborated=True, require_corroboration=True,
        stage1_narrates_scoreboard=True,
    )
    assert d["outcome"] == "scoring_play"
    assert d["isHighlight"] is True
    assert d["nearMiss"] is False


def test_reconcile_promotes_not_goal_on_stage1_scoreboard_narration():
    """ADAAAA-7408 (AC1): even when the deep-dive says not_goal (candidate 153
    for the 0-1 -> 1-1 goal), the Stage-1 scoreboard-change narration keeps the
    corroborated goal."""
    d = reconcile_confirmed_goal(
        "not_goal",
        {"outcome": "scoring_play", "isHighlight": True, "score": 72, "eventType": "GOAL",
         "reason": "The ball enters the net and the scoreboard updates from 0-1 to 1-1."},
        comment="no visible ball in the net",
        corroborated=True, require_corroboration=True,
        stage1_narrates_scoreboard=True,
    )
    assert d["outcome"] == "scoring_play"
    assert d["isHighlight"] is True


def test_reconcile_no_promotion_without_stage1_scoreboard_narration():
    """ADAAAA-7408 (AC3): a downgraded goal WITHOUT a Stage-1 scoreboard-change
    narration (a saved shot / dribble over-called by Stage-1) must NOT be
    promoted — the demotion stays (never a board goal)."""
    d = reconcile_confirmed_goal(
        "near_miss",
        {"outcome": "scoring_play", "isHighlight": True, "score": 95, "eventType": "GOAL",
         "reason": "The ball clearly enters the net and the goalkeeper is beaten."},
        comment="blocked by the goalkeeper, no scoreboard change",
        corroborated=False, require_corroboration=True,
        stage1_narrates_scoreboard=False,
    )
    assert d["outcome"] == "near_miss"
    assert d["isHighlight"] is False


def test_reconcile_static_score_read_not_credited():
    """ADAAAA-7408 (AC3): a STATIC scoreboard read ("scoreboard shows a score of
    0-1", no transition) is not a score change, so it credits no corroboration."""
    gate = cf.reason_asserts_scoreboard_change(
        "The sequence shows a goal celebration and the scoreboard shows a score of 0-1 for BAR."
    )
    assert gate is False


def test_run_pass_surfaces_regulation_goal_on_stage1_scoreboard_narration(monkeypatch):
    """ADAAAA-7408 (AC1) end-to-end: the box regression demoted the real
    regulation goals (t~153/342/402) to near_miss even though their Stage-1
    reason explicitly narrated the scoreboard change ("scoreboard updates from
    1-1 to 2-1"). Crediting that Stage-1 narration as corroboration must surface
    the goal as a board-accepted scoring_play, not a near_miss."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("DECIDE_CONFIRM_REQUIRE_CORROBORATION", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 78, "eventType": "GOAL",
              "reason": "The ball is clearly seen entering the net, and the scoreboard updates from 1-1 to 2-1."}
    # The deep-dive conservatively demotes to near_miss, blaming missing
    # corroboration (the exact box comment for these windows).
    canned = (
        '{"goalConfirmed": "near_miss", "confidence": 0.6, '
        '"reason": "The ball is seen moving towards the goal but there is no scoreboard change or '
        'independent corroboration to confirm a goal.", '
        '"evidence": {"ballInNet": null, "scoreboardChanged": null}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    resp = run_confirmation_pass({"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}]})
    # The Stage-1 scoreboard narration is credited as corroboration.
    assert resp["corroborated"] is True
    assert resp["corroborationSource"] == "scoreboard"
    # The demoted regulation goal is promoted to a board-accepted goal (AC1).
    assert resp["decision"]["outcome"] == "scoring_play"
    assert resp["decision"]["isHighlight"] is True
    assert resp["decision"]["nearMiss"] is False


def test_run_pass_keeps_fabricated_saved_shot_rejected(monkeypatch):
    """ADAAAA-7408 (AC3) end-to-end: a saved-shot window whose Stage-1 reason
    does NOT narrate a scoreboard change stays a near_miss (never a board goal),
    even though Stage-1 over-called it a goal and the deep-dive agreed it did not
    convert."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("DECIDE_CONFIRM_REQUIRE_CORROBORATION", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 95, "eventType": "GOAL",
              "reason": "The ball clearly enters the net and the goalkeeper is beaten."}
    canned = (
        '{"goalConfirmed": "near_miss", "confidence": 0.7, '
        '"reason": "The ball is blocked by the goalkeeper, there is no scoreboard change or '
        'independent corroboration to confirm a goal.", '
        '"evidence": {"ballInNet": false, "scoreboardChanged": null}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    resp = run_confirmation_pass({"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}]})
    assert resp["corroborated"] is False
    assert resp["decision"]["outcome"] == "near_miss"
    assert resp["decision"]["isHighlight"] is False


# --- end-to-end run with a mocked gemma call --------------------------------


def test_run_pass_confirms_goal_and_disagrees(monkeypatch):
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 70, "eventType": "GOAL", "reason": "stage1 templated"}
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.95, '
        '"reason": "dense frames show the ball crossing the line and in the net", '
        '"evidence": {"ballTrajectoryCrossedLine": true, "ballInNet": true, "audioErupted": true}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    # ADAAAA-7162: an independent corroboration signal (scoreboard change) is
    # required to accept a confirmed_goal. Provide it so the goal is kept.
    resp = run_confirmation_pass(
        {"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}], "scoreBoardChanged": True}
    )
    assert resp["enabled"] is True
    assert resp["goalConfirmed"] == "confirmed_goal"
    assert resp["confidence"] == 0.95
    assert resp["corroborated"] is True
    # ADAAAA-7185: the corroboration source is persisted (scoreboard change).
    assert resp["corroborationSource"] == "scoreboard"
    assert resp["decision"]["outcome"] == "scoring_play"
    assert resp["decision"]["isHighlight"] is True
    # Stage-1 already said goal, so confirm-agree means NO disagreement.
    assert resp["stage1Disagreed"] is False


def test_run_pass_downgrades_unconfirmed_goal_to_near_miss(monkeypatch):
    """ADAAAA-7162: a confirmed_goal with NO scoreboard change and NO goal-calling
    audio text is downgraded to near_miss (never a board-accepted GOAL), even when
    the model self-reports high confidence. This is the fabricated-read case."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 99, "eventType": "GOAL", "reason": "stage1 templated"}
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.99, '
        '"reason": "ball clearly enters the net / goalkeeper beaten", '
        '"evidence": {"ballInNet": true, "audioErupted": true}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    # No scoreboard change and no audio transcript -> NOT corroborated.
    resp = run_confirmation_pass({"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}]})
    assert resp["enabled"] is True
    assert resp["goalConfirmed"] == "confirmed_goal"  # raw model verdict
    assert resp["corroborated"] is False
    # ADAAAA-7185: no corroboration source persisted when none present.
    assert resp["corroborationSource"] is None
    # Deterministic reconcile downgrades to near_miss (never a GOPAL).
    assert resp["decision"]["outcome"] == "near_miss"
    assert resp["decision"]["isHighlight"] is False
    assert resp["decision"]["nearMiss"] is True


def test_run_pass_confirms_goal_on_goal_calling_audio(monkeypatch):
    """ADAAAA-7162: goal-calling audio/commentary text is a valid independent
    corroboration, so a confirmed_goal with such text is kept as a goal."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("AUDIO_CONTEXT", "1")
    monkeypatch.setattr(cf, "_asr_url", lambda: "http://asr:9999")
    monkeypatch.setattr(
        cf, "transcribe_audio", lambda *a, **k: ("GOOOAL what a strike from the right wing", None)
    )
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 88, "eventType": "GOAL", "reason": "s1"}
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.9, '
        '"reason": "frames show ball in the net", '
        '"evidence": {"ballInNet": true}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    resp = run_confirmation_pass(
        {"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}], "audioB64": "AAA"}
    )
    assert resp["corroborated"] is True
    # ADAAAA-7185: the corroboration source is persisted (goal-calling audio).
    assert resp["corroborationSource"] == "audio_text"
    # ADAAAA-7251 (ACC-3): the ASR transcript computed for the audio context is
    # surfaced on the confirm response so the server can persist it.
    assert resp["transcript"] == "GOOOAL what a strike from the right wing"
    assert resp["goalConfirmed"] == "confirmed_goal"
    assert resp["decision"]["outcome"] == "scoring_play"
    assert resp["decision"]["isHighlight"] is True


def test_endpoint_confirm_returns_asr_transcript(monkeypatch):
    """ADAAAA-7251 (ACC-3): the /confirm HTTP response carries the ASR transcript
    so the server can persist it on the highlight record."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("AUDIO_CONTEXT", "1")
    monkeypatch.setattr(cf, "_asr_url", lambda: "http://asr:9999")
    monkeypatch.setattr(cf, "transcribe_audio", lambda *a, **k: ("GOOOAL driven into the top corner", None))
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 90, "eventType": "GOAL", "reason": "s1"}
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.9, '
        '"reason": "frames show ball in the net", "evidence": {"ballInNet": true}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    data = client.post(
        "/confirm",
        json={"eventType": "GOAL", "stage1": stage1, "frames": [{"base64": "x"}], "audioB64": "AAA"},
    )
    assert data.status_code == 200
    body = data.json()
    assert body["goalConfirmed"] == "confirmed_goal"
    assert body["transcript"] == "GOOOAL driven into the top corner"
    # Absent ASR (no audio context) -> empty string, never a fabricated value.
    data2 = client.post(
        "/confirm",
        json={"eventType": "GOAL", "stage1": stage1, "frames": [{"base64": "x"}]},
    )
    assert data2.status_code == 200
    assert data2.json()["transcript"] == ""


def test_run_pass_refutes_goal_and_disagrees(monkeypatch):
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 74, "eventType": "GOAL", "reason": "templated"}
    canned = (
        '{"goalConfirmed": "near_miss", "confidence": 0.8, '
        '"reason": "trajectory shows the shot hitting the post; ball did not cross the line", '
        '"evidence": {"ballTrajectoryCrossedLine": false, "sustainedScoringMotion": false}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    resp = run_confirmation_pass({"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}]})
    assert resp["enabled"] is True
    assert resp["goalConfirmed"] == "near_miss"
    assert resp["decision"]["outcome"] == "near_miss"
    assert resp["decision"]["isHighlight"] is False  # never a board goal
    assert resp["stage1Disagreed"] is True  # confirmation CORRECTED the primary read


def test_run_pass_unparseable_passthrough(monkeypatch):
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 70, "eventType": "GOAL", "reason": "r"}
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: "not valid json")
    resp = run_confirmation_pass({"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}]})
    assert resp["enabled"] is True
    assert resp["goalConfirmed"] is None
    assert resp["decision"] == stage1  # passthrough, no crash


def test_run_pass_gemma_transport_failure_passthrough(monkeypatch):
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 70, "eventType": "GOAL", "reason": "r"}
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: None)
    resp = run_confirmation_pass({"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}]})
    assert resp["enabled"] is True
    assert resp["goalConfirmed"] is None
    assert resp["decision"] == stage1


def test_prompt_tests_contradictory_hypothesis():
    p = cf.build_confirm_prompt(
        event_type="GOAL",
        game_hint="soccer",
        stage1={"outcome": "scoring_play", "reason": "templated", "score": 80},
        n_frames=12,
        n_keyframes=3,
        trajectories=[{"label": "ball", "trackId": "t1", "path": [[0, 0.5, 0.5], [1, 0.6, 0.4]]}],
        optical_flow=1.5,
        flow_magnitudes=[0.1, 0.2, 0.3],
        audio_levels=[0.2, 0.5, 0.9],
        transcript="commentary erupts",
        ball_outcome=None,
        goal_crossed=None,
        scoreboard_changed=False,
    )
    # The contradictory hypothesis is explicit.
    assert "CONTRADICTORY HYPOTHESIS" in p
    assert "near miss" in p.lower()
    # Stage-1 verdict + reason are presented back.
    assert "stage-1 (primary pass) verdict" in p
    assert "templated" in p
    # Denser context is rendered (frames, keyframes, trajectory, optical flow).
    assert "dense frame window" in p
    assert "precise keyframes" in p
    assert "ball" in p and "path" in p
    assert "optical-flow" in p
    # Corroboration is presented as INPUT, never a gate.
    assert "INPUT ONLY, never a gate" in p
    # The structured goalConfirmed is required.
    assert "goalConfirmed" in p


# --- ADAAAA-7162 goal corroboration gate -----------------------------------


def test_audio_calls_goal_detects_goal_call():
    from app import confirm as cf
    assert cf.audio_calls_goal("GOOOAL!!! And it's in the net") is True
    assert cf.audio_calls_goal("it's in!") is True
    assert cf.audio_calls_goal("what a goal from the striker") is True
    # conservative: bare "goal" / replay narration is not a goal call.
    assert cf.audio_calls_goal("the goal is the objective of the game") is False
    assert cf.audio_calls_goal("") is False
    assert cf.audio_calls_goal(None) is False


def test_goal_corroborated_requires_independent_signal():
    from app import confirm as cf
    # scoreboard change OR goal-calling audio is sufficient.
    assert cf.goal_corroborated(scoreboard_changed=True, transcript="") is True
    assert cf.goal_corroborated(scoreboard_changed=False, transcript="GOOOAL") is True
    # neither is present -> NOT corroborated (the fabrication case).
    assert cf.goal_corroborated(scoreboard_changed=False, transcript="crowd roars") is False
    assert cf.goal_corroborated(scoreboard_changed=False, transcript="") is False


def test_goal_corroborated_credits_frame_scoreboard_change():
    """ADAAAA-7357: the confirmation pass's OWN frame read (evidence.scoreboardChanged)
    is an independent corroboration signal, credited when the deterministic perceive-OCR
    flag was delayed / did not fire. A bare ball-in-net frame read is NOT credited."""
    from app import confirm as cf
    # Frame read attests the scoreboard change -> corroborated even with OCR flag off
    # and no audio transcript.
    assert cf.goal_corroborated(scoreboard_changed=False, transcript="",
                                frame_scoreboard_changed=True) is True
    # No frame scoreboard read, no OCR, no audio -> still NOT corroborated.
    assert cf.goal_corroborated(scoreboard_changed=False, transcript="",
                                frame_scoreboard_changed=False) is False
    # Ball-in-net alone is never independent corroboration (ADAAAA-7162 guard).
    assert cf.goal_corroborated(scoreboard_changed=False, transcript="") is False


def test_run_pass_confirms_goal_on_frame_scoreboard_attestation(monkeypatch):
    """ADAAAA-7357 (AC1): a confirmed_goal whose deep-frame dive attests a scoreboard
    change (evidence.scoreboardChanged=true) is kept as a GOAL even though the
    deterministic perceive-OCR `scoreBoardChanged` flag is off and VOD has no audio
    transcript — the delayed-scoreboard case (kids_soccer.mp4 goal 114-117s,
    scoreboard 117-120s)."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("DECIDE_CONFIRM_REQUIRE_CORROBORATION", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 70, "eventType": "GOAL", "reason": "s1"}
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.9, '
        '"reason": "dense frames show the ball crossing the line and the scoreboard ticking 0-1", '
        '"evidence": {"ballInNet": true, "scoreboardChanged": true}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    # scoreBoardChanged (OCR) is FALSE on the request; the corroboration comes ONLY
    # from the confirm pass's own frame read.
    resp = run_confirmation_pass(
        {"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}], "scoreBoardChanged": False}
    )
    assert resp["goalConfirmed"] == "confirmed_goal"
    assert resp["corroborated"] is True
    assert resp["corroborationSource"] == "scoreboard"
    assert resp["decision"]["outcome"] == "scoring_play"
    assert resp["decision"]["isHighlight"] is True


def test_run_pass_still_downgrades_on_ball_in_net_alone(monkeypatch):
    """ADAAAA-7162 guard (AC3): a confirmed_goal with only a bare ballInNet frame
    attestation and NO scoreboard / audio signal is still downgraded to near_miss —
    never a board GOAL. The frame-scoreboard credit does not weaken the guard."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("DECIDE_CONFIRM_REQUIRE_CORROBORATION", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 99, "eventType": "GOAL", "reason": "s1"}
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.99, '
        '"reason": "ball clearly enters the net", '
        '"evidence": {"ballInNet": true, "scoreboardChanged": null}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    resp = run_confirmation_pass(
        {"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}], "scoreBoardChanged": False}
    )
    assert resp["goalConfirmed"] == "confirmed_goal"
    assert resp["corroborated"] is False
    assert resp["decision"]["outcome"] == "near_miss"
    assert resp["decision"]["isHighlight"] is False


def test_confirm_requires_corroboration_default_on(monkeypatch):
    from app import confirm as cf
    monkeypatch.delenv("DECIDE_CONFIRM_REQUIRE_CORROBORATION", raising=False)
    assert cf.confirm_requires_corroboration() is True
    monkeypatch.setenv("DECIDE_CONFIRM_REQUIRE_CORROBORATION", "0")
    assert cf.confirm_requires_corroboration() is False


def test_reconcile_downgrades_unconfirmed_goal_on_required_corroboration():
    """A confirmed_goal with NO independent corroboration must be downgraded to
    near_miss (never a board-accepted GOAL) regardless of model confidence."""
    from app import confirm as cf
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 99, "reason": "r", "eventType": "GOAL"}
    d = cf.reconcile_confirmed_goal(
        "confirmed_goal", stage1,
        corroborated=False, require_corroboration=True,
    )
    assert d["outcome"] == "near_miss"
    assert d["isHighlight"] is False
    assert d["nearMiss"] is True
    assert d["score"] < 60


def test_reconcile_keeps_corroborated_goal():
    from app import confirm as cf
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 99, "reason": "r", "eventType": "GOAL"}
    d = cf.reconcile_confirmed_goal(
        "confirmed_goal", stage1,
        corroborated=True, require_corroboration=True,
    )
    assert d["outcome"] == "scoring_play"
    assert d["isHighlight"] is True


def test_reconcile_legacy_no_requirement_keeps_goal():
    """With corroboration not required (legacy path), a confirmed_goal is kept."""
    from app import confirm as cf
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 99, "reason": "r", "eventType": "GOAL"}
    d = cf.reconcile_confirmed_goal(
        "confirmed_goal", stage1,
        corroborated=False, require_corroboration=False,
    )
    assert d["outcome"] == "scoring_play"
    assert d["isHighlight"] is True


# --- ADAAAA-7402 penalty-shootout + narrated-scoreboard corroboration ---------


def test_goal_corroborated_shootout_credits_ball_in_net():
    """ADAAAA-7402 (AC2): during a shootout the aggregate score is fixed, so a
    ball-in-net attestation ALONE is sufficient corroboration for a converted
    penalty even with no main-score change and no goal-calling audio."""
    from app import confirm as cf
    assert cf.goal_corroborated(
        scoreboard_changed=False, transcript="", ball_in_net=True, penalty_shootout=True
    ) is True
    # A penalty-tally increment is also sufficient on its own.
    assert cf.goal_corroborated(
        scoreboard_changed=False, transcript="", penalty_tally_changed=True, penalty_shootout=True
    ) is True


def test_goal_corroborated_shootout_saved_penalty_not_corroborated():
    """ADAAAA-7402 (AC3): a shootout kick that is SAVED / MISSED (no ball in the
    net, no tally increment) is NOT corroborated — stays rejected."""
    from app import confirm as cf
    assert cf.goal_corroborated(
        scoreboard_changed=False, transcript="", penalty_shootout=True
    ) is False
    assert cf.goal_corroborated(
        scoreboard_changed=False, transcript="", ball_in_net=False,
        penalty_tally_changed=False, penalty_shootout=True,
    ) is False


def test_goal_corroborated_non_shootout_preserves_ball_in_net_guard():
    """ADAAAA-7162 guard preserved: outside a shootout a bare ball-in-net read
    is still NOT independent corroboration."""
    from app import confirm as cf
    assert cf.goal_corroborated(scoreboard_changed=False, transcript="", ball_in_net=True) is False


def test_reason_asserts_scoreboard_change():
    """ADAAAA-7402 (AC1): an explicit score transition narrated in the deep-dive
    reason is credited; bare narration / near-miss wording is not."""
    from app import confirm as cf
    assert cf.reason_asserts_scoreboard_change("scoreboard updates from 2-1 to 2-2") is True
    assert cf.reason_asserts_scoreboard_change("the scoreboard ticks to 1-0") is True
    assert cf.reason_asserts_scoreboard_change("2-1 to 2-2") is True
    assert cf.reason_asserts_scoreboard_change("ball clearly enters the net / goalkeeper beaten") is False
    assert cf.reason_asserts_scoreboard_change("a near miss, no score") is False
    assert cf.reason_asserts_scoreboard_change("") is False
    assert cf.reason_asserts_scoreboard_change(None) is False


def test_run_pass_confirms_penalty_conversion_in_shootout(monkeypatch):
    """ADAAAA-7402 (AC2): a confirmed_goal whose deep dive detects a shootout and
    attests ball-in-net is kept as a GOAL even with no main-score change and no
    goal-calling audio transcript (the kids_soccer.mp4 converted-penalty case)."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("DECIDE_CONFIRM_REQUIRE_CORROBORATION", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 70, "eventType": "GOAL", "reason": "s1"}
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.9, '
        '"reason": "penalty converted, ball clearly enters the net during the shootout", '
        '"evidence": {"ballInNet": true, "penaltyShootout": true, "penaltyTallyChanged": true}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    resp = run_confirmation_pass(
        {"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}], "scoreBoardChanged": False}
    )
    assert resp["goalConfirmed"] == "confirmed_goal"
    assert resp["corroborated"] is True
    assert resp["corroborationSource"] == "scoreboard"
    assert resp["decision"]["outcome"] == "scoring_play"
    assert resp["decision"]["isHighlight"] is True


def test_run_pass_confirms_penalty_conversion_on_ball_in_net_only(monkeypatch):
    """ADAAAA-7402 (AC2): in a shootout the ball-in-net attestation alone (even
    without an explicit tally increment) is sufficient corroboration."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("DECIDE_CONFIRM_REQUIRE_CORROBORATION", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 70, "eventType": "GOAL", "reason": "s1"}
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.88, '
        '"reason": "shot on goal in the shootout, ball in the net", '
        '"evidence": {"ballInNet": true, "penaltyShootout": true}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    resp = run_confirmation_pass(
        {"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}], "scoreBoardChanged": False}
    )
    assert resp["corroborated"] is True
    assert resp["decision"]["outcome"] == "scoring_play"
    assert resp["decision"]["isHighlight"] is True


def test_run_pass_still_downgrades_saved_shootout_penalty(monkeypatch):
    """ADAAAA-7402 (AC3): a shootout kick the deep dive judges SAVED / MISSED
    (no ball in the net, no tally increment) is still downgraded to near_miss —
    never a board goal."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("DECIDE_CONFIRM_REQUIRE_CORROBORATION", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 70, "eventType": "GOAL", "reason": "s1"}
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.7, '
        '"reason": "keeper saves the penalty, ball never crosses the line", '
        '"evidence": {"ballInNet": false, "penaltyShootout": true}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    resp = run_confirmation_pass(
        {"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}], "scoreBoardChanged": False}
    )
    assert resp["corroborated"] is False
    assert resp["decision"]["outcome"] == "near_miss"
    assert resp["decision"]["isHighlight"] is False


def test_run_pass_confirms_regulation_goal_on_narrated_scoreboard(monkeypatch):
    """ADAAAA-7402 (AC1): the 2-2 regulation equalizer where the deep dive
    narrates the scoreboard delta (2-1 -> 2-2) but leaves the structured
    evidence.scoreboardChanged null is now accepted as a GOAL."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("DECIDE_CONFIRM_REQUIRE_CORROBORATION", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 70, "eventType": "GOAL", "reason": "s1"}
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.9, '
        '"reason": "scoreboard updates from 2-1 to 2-2 after the goal", '
        '"evidence": {"ballInNet": true, "scoreboardChanged": null}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    resp = run_confirmation_pass(
        {"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}], "scoreBoardChanged": False}
    )
    assert resp["goalConfirmed"] == "confirmed_goal"
    assert resp["corroborated"] is True
    assert resp["corroborationSource"] == "scoreboard"
    assert resp["decision"]["outcome"] == "scoring_play"
    assert resp["decision"]["isHighlight"] is True


def test_run_pass_confirms_penalty_on_tally_increment_without_shootout_flag(monkeypatch):
    """ADAAAA-7402 (AC2): a clear penalty-tally increment corroborates a converted
    penalty even when the model could not separately flag the shootout context
    (evidence.penaltyShootout is null) — the tally IS the shootout signal."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("DECIDE_CONFIRM_REQUIRE_CORROBORATION", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 70, "eventType": "GOAL", "reason": "s1"}
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.9, '
        '"reason": "penalty converted, tally ticks to 4-4", '
        '"evidence": {"ballInNet": true, "penaltyTallyChanged": true, "penaltyShootout": null}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    resp = run_confirmation_pass(
        {"stage1": stage1, "eventType": "GOAL", "frames": [{"base64": "x"}], "scoreBoardChanged": False}
    )
    assert resp["corroborated"] is True
    assert resp["decision"]["outcome"] == "scoring_play"
    assert resp["decision"]["isHighlight"] is True

"""ADAAAA-7155 Increment A — per-window LLM analysis capture.

Verifies the decide service functions return the exact prompt + an ordered
dataItems list + the full response (reasoning / verdict / evidenceAttested /
audioContext) on the returned decision, and that the confirm pass returns the
confirm prompt + request context summary. Observability only — this does not
change parse/accept semantics, so non-regression is pinned by the existing
decision tests.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import app.confirm as cf
from app.confirm import run_confirmation_pass
from app.gemma import (
    build_group_prompt,
    build_prompt,
    decide_group_with_gemma,
    decide_with_gemma,
)


class _MockLlama:
    """Minimal HTTP server faking llama.cpp /v1/chat/completions."""

    def __init__(self, reply: str):
        self.reply = reply
        self.requests: list = []
        self._srv = HTTPServer(("127.0.0.1", 0), self._handler())
        self.port = self._srv.server_address[1]
        self._t = threading.Thread(target=self._srv.serve_forever, daemon=True)
        self._t.start()

    def _handler(self):
        owner = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("content-length", 0))
                owner.requests.append(json.loads(self.rfile.read(n)))
                resp = json.dumps({"choices": [{"message": {"content": owner.reply}}]})
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(resp.encode())

            def log_message(self, *a):
                pass

        return H

    def stop(self):
        self._srv.shutdown()


_RICH_REPLY = (
    '{"isHighlight": true, "score": 92, "eventType": "GOAL", '
    '"reason": "ball crossed the line between the posts", '
    '"outcome": "scoring_play", '
    '"reasoning": "I first observed the ball enter the net, then tested the goal hypothesis", '
    '"verdict": {"hypothesis": "GOAL", "independentlyObserved": "ball in net", '
    '"criteria": {"ballCrossedLineBetweenPosts": true, "ballInNet": true, '
    '"scoreboardChanged": false, "crowdErupted": true}, "contradictedBy": null}, '
    '"evidenceAttested": ["ball in net", "net ripples", "keeper beaten"]}'
)


def _evidence():
    return {
        "trackCount": 3,
        "maxVelocity": 24.3,
        "ocrHits": 7,
        "scoreBoardChanged": True,
        "ballOutcome": "goal",
        "goalCrossed": True,
    }


# --- decide_with_gemma (single candidate) -----------------------------------


def test_decide_analysis_prompt_matches_build_prompt():
    # Fidelity: the returned prompt is byte-for-byte the string handed to the
    # model (build_prompt with the same inputs).
    mock = _MockLlama(_RICH_REPLY)
    try:
        d = decide_with_gemma(
            "GOAL", _evidence(), game_hint="soccer",
            frames=[{"seq": 10, "base64": "AAA"}, {"seq": 11, "base64": "BBB"}],
            images=[{"seq": 3, "base64": "CCC"}],
            url=f"http://127.0.0.1:{mock.port}",
            story_so_far="first half summary",
        )
    finally:
        mock.stop()
    an = d["analysis"]
    assert an["prompt"] == build_prompt(
        "GOAL", _evidence(), "soccer", n_frames=2, has_audio=False,
        transcript="", story_so_far="first half summary",
    )
    # the exact prompt was also what went over the wire
    sent = mock.requests[0]["messages"][-1]["content"]
    sent_text = next(c["text"] for c in sent if c.get("type") == "text")
    assert an["prompt"] == sent_text


def test_decide_analysis_data_items_cover_candidate_metadata():
    mock = _MockLlama(_RICH_REPLY)
    try:
        d = decide_with_gemma(
            "GOAL", _evidence(), game_hint="soccer",
            frames=[{"seq": 10, "base64": "AAA"}],
            url=f"http://127.0.0.1:{mock.port}",
        )
    finally:
        mock.stop()
    items = d["analysis"]["dataItems"]
    assert isinstance(items, list) and len(items) >= 8  # >= candidate event metadata
    types = {i.get("type") for i in items}
    assert "candidate" in types and "tracking" in types and "frames" in types
    labels = {i.get("label") for i in items}
    assert "Candidate event type" in labels
    assert "Game hint" in labels
    assert "Goal-line ground-truth (perceive homography)" in labels
    # ordered: the first item is the candidate event type
    assert items[0]["type"] == "candidate"
    # candidate event metadata with correct values
    ev_candidate = next(i for i in items if i["label"] == "Candidate event type")
    assert ev_candidate["value"] == "GOAL"
    # scoreboard + goal-line signals surfaced
    vals = {i["label"]: i["value"] for i in items}
    assert vals["Scoreboard score change"] == "yes"
    assert vals["Goal-line ground-truth (perceive homography)"] == "ballOutcome=goal, goalCrossed=True"
    # media refs present
    assert d["analysis"]["frames"] == [{"seq": 10, "uri": ""}]


def test_decide_analysis_response_completeness():
    # reasoning / verdict / evidenceAttested / audioContext retained.
    mock = _MockLlama(_RICH_REPLY)
    try:
        d = decide_with_gemma(
            "GOAL", _evidence(), game_hint="soccer",
            frames=[{"seq": 1, "base64": "AAA"}],
            url=f"http://127.0.0.1:{mock.port}",
        )
    finally:
        mock.stop()
    resp = d["analysis"]["response"]
    assert resp["reasoning"].startswith("I first observed")
    assert resp["verdict"]["criteria"]["ballInNet"] is True
    assert resp["evidenceAttested"] == ["ball in net", "net ripples", "keeper beaten"]
    assert isinstance(resp["audioContext"], dict)
    assert resp["audioContext"]["path"] == "none"
    # the decision boundary did not drop them from the decision either
    assert d["reasoning"].startswith("I first observed")


def test_decide_analysis_rule_fallback_records_what_it_did():
    # Unreachable gemma -> deterministic rule fallback; the analysis still records
    # the dataItems (prompt empty: no model call).
    d = decide_with_gemma(
        "KILL", {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0},
        url="http://127.0.0.1:1",
    )
    an = d["analysis"]
    assert an["prompt"] == ""
    assert len(an["dataItems"]) >= 6
    assert an["audio"]["path"] == "none"
    assert d["source"] == "rule-fallback"


# --- decide_group_with_gemma (group window) ----------------------------------


def test_group_decide_analysis_prompt_and_data_items():
    candidates = [
        {"eventType": "GOAL", "timestamp": 12.0, "evidence": {"trackCount": 3, "maxVelocity": 22.0, "ocrHits": 2, "scoreBoardChanged": True, "ballOutcome": "goal"}},
        {"eventType": "KILL", "timestamp": 13.5, "evidence": {"trackCount": 2}},
    ]
    reply = json.dumps([
        {"isHighlight": True, "score": 88, "eventType": "GOAL", "reason": "r1", "outcome": "scoring_play", "nearMiss": False},
        {"isHighlight": False, "score": 20, "eventType": "KILL", "reason": "r2", "outcome": "not_highlight", "nearMiss": False},
    ])
    mock = _MockLlama(reply)
    try:
        verdicts = decide_group_with_gemma(
            candidates, game_hint="soccer",
            frames=[{"seq": 5, "base64": "AAA"}, {"seq": 6, "base64": "BBB"}],
            url=f"http://127.0.0.1:{mock.port}",
        )
    finally:
        mock.stop()
    assert len(verdicts) == 2
    for v in verdicts:
        an = v["analysis"]
        assert an["prompt"] == build_group_prompt(
            candidates, "soccer", n_frames=2, has_audio=False, transcript="",
        )
        assert len(an["dataItems"]) >= 4  # includes per-candidate metadata
        assert an["frames"] == [{"seq": 5, "uri": ""}, {"seq": 6, "uri": ""}]
        assert an["response"]["outcome"] in ("scoring_play", "not_highlight")


# --- confirm pass -------------------------------------------------------------


def test_confirm_analysis_prompt_and_context(monkeypatch):
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    stage1 = {"outcome": "scoring_play", "isHighlight": True, "score": 70, "eventType": "GOAL", "reason": "stage1 templated"}
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.95, '
        '"reason": "dense frames show the ball crossing the line and in the net", '
        '"evidence": {"ballTrajectoryCrossedLine": true, "ballInNet": true, "audioErupted": true}}'
    )
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: canned)
    req = {
        "stage1": stage1,
        "eventType": "GOAL",
        "gameHint": "soccer",
        "frames": [{"base64": "x"}, {"base64": "y"}],
        "trajectories": [{"label": "ball", "trackId": "t1", "path": [[0, 0.5, 0.5]]}],
        "opticalFlowMagnitude": 1.5,
        "audioLevels": [0.2, 0.8],
    }
    resp = run_confirmation_pass(req)
    an = resp["analysis"]
    assert an["request"]["prompt"] == cf.build_confirm_prompt(
        event_type="GOAL", game_hint="soccer", stage1=stage1,
        n_frames=len(req["frames"]), n_keyframes=0, trajectories=req["trajectories"],
        optical_flow=req["opticalFlowMagnitude"], flow_magnitudes=[], audio_levels=req["audioLevels"],
        transcript="", ball_outcome=None, goal_crossed=None, scoreboard_changed=False,
    )
    assert len(an["request"]["dataItems"]) >= 5
    assert an["request"]["frames"] == [{"seq": 0, "uri": ""}, {"seq": 1, "uri": ""}]
    assert an["decision"]["goalConfirmed"] == "confirmed_goal"
    assert an["decision"]["confidence"] == 0.95
    assert an["decision"]["outcome"] == "scoring_play"
    # the ConfirmDecision itself carries the analysis alongside
    from app.confirm import ConfirmDecision
    cd = ConfirmDecision(**resp)
    assert cd.analysis["request"]["prompt"] == an["request"]["prompt"]


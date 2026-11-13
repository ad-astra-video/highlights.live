"""ADAAAA-8844 (Inc 2, AC2.3): a contradicted score surface can never force a goal.

Inc 1 pinned the score bug per job. A pin cannot cover an un-pinned job, a second
bug that appears mid-stream, or a pin placed on the wrong surface, so the surface
identity verdict (`scoreboardSurfaceIdentity`) rides the decide evidence and the
accept path must refuse a score change measured on a surface that is provably NOT
this match's (different kit plates AND no printed name of ours).

These tests prove the guard on BOTH decide paths named by AC2.3:

  * the single-candidate path — the pure `scoreboard_forces_goal`, the rule
    `decide`, and the served `/app/highlight` request;
  * the group path — `_postprocess_gemma_verdict` and the served group request.

They also pin the RECALL side (AC2.2/AC2.3): `absent` and `consistent` must keep
today's force-goal behaviour, because absence is not contradiction.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from fastapi.testclient import TestClient

from app import app as decide_app
from app import _postprocess_gemma_verdict
from app.decider import decide, has_corroboration, scoreboard_forces_goal
from app.gemma import attested_goal_criterion

client = TestClient(decide_app)


class MockLlama:
    """Minimal HTTP server faking llama.cpp /v1/chat/completions."""

    def __init__(self, reply: str):
        self.reply = reply
        self._srv = HTTPServer(("127.0.0.1", 0), self._handler())
        self.port = self._srv.server_address[1]
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()

    def _handler(self):
        owner = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("content-length", 0))
                self.rfile.read(n)
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


def _group_payload(candidates):
    return {
        "sessionId": "grp-surface",
        "eventType": candidates[0]["eventType"],
        "timestamp": 1.0,
        "candidates": candidates,
    }


# --- the single-candidate path ----------------------------------------------

def test_forces_goal_refuses_a_contradicted_surface():
    """AC2.3: the pure predicate cannot be satisfied by a contradicted surface."""
    assert scoreboard_forces_goal(True, "GOAL", "contradicted") is False
    # ... on any spelling the producer might use (never fail-open into a force).
    assert scoreboard_forces_goal(True, "GOAL", " Contradicted ") is False
    # Recall side: absent / consistent / unmeasured keep today's behaviour.
    assert scoreboard_forces_goal(True, "GOAL", "absent") is True
    assert scoreboard_forces_goal(True, "GOAL", "consistent") is True
    assert scoreboard_forces_goal(True, "GOAL", None) is True
    # The rest of the predicate is unchanged.
    assert scoreboard_forces_goal(True, "SHOT", "consistent") is False
    assert scoreboard_forces_goal(False, "GOAL", "consistent") is False


def test_contradicted_surface_is_not_corroboration_either():
    """A foreign score change is evidence about ANOTHER match — not corroboration."""
    assert has_corroboration(0, 0.0, 0, None, True, None) is True
    assert has_corroboration(0, 0.0, 0, None, True, "consistent") is True
    assert has_corroboration(0, 0.0, 0, None, True, "contradicted") is False


def test_rule_decide_names_the_demotion_and_does_not_accept():
    """AC2.3 + scope item 5: the rule path rejects and SAYS why."""
    d = decide("GOAL", track_count=0, max_velocity=0.0, score_board_changed=True,
               surface_identity="contradicted")
    assert d.is_highlight is False
    assert d.corroborated is False
    assert "contradicted score surface" in d.reason
    assert "ignored" in d.reason
    assert "scoreboard score change confirmed" not in d.reason

    # Recall side: the same window on this match's own surface still forces.
    ok = decide("GOAL", track_count=0, max_velocity=0.0, score_board_changed=True,
                surface_identity="consistent")
    assert ok.is_highlight is True
    assert "scoreboard score change confirmed" in ok.reason
    # ... and an unmeasured surface is byte-identical to today.
    legacy = decide("GOAL", track_count=0, max_velocity=0.0, score_board_changed=True)
    assert legacy.is_highlight is True
    assert "scoreboard score change confirmed" in legacy.reason


def test_single_candidate_endpoint_refuses_contradicted_and_keeps_absent(monkeypatch):
    """AC2.3 on the served single-candidate path (`POST /app/highlight`)."""
    monkeypatch.setenv("DECIDE_MODE", "rule")
    base = {
        "sessionId": "sess-surface-single",
        "eventType": "GOAL",
        "timestamp": 1.0,
        "evidence": {"trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0, "scoreBoardChanged": True},
    }
    r = client.post("/app/highlight", json={**base, "evidence": {**base["evidence"],
                             "scoreboardSurfaceIdentity": "contradicted"}})
    assert r.status_code == 200
    body = r.json()
    assert body["isHighlight"] is False
    assert "contradicted score surface" in (body.get("reason") or "")
    assert "scoreboard score change confirmed" not in (body.get("reason") or "")

    # Absent keeps today's behaviour (the un-pinned / unreadable-surface case).
    r = client.post("/app/highlight", json={**base, "evidence": {**base["evidence"],
                             "scoreboardSurfaceIdentity": "absent"}})
    assert r.status_code == 200
    assert r.json()["isHighlight"] is True


# --- the group path (_postprocess_gemma_verdict) -----------------------------

def test_group_postprocess_refuses_a_contradicted_surface():
    """AC2.3: the group review cannot resurrect a goal off a foreign score bug."""
    decision = {
        "isHighlight": False,
        "score": 40,
        "eventType": "GOAL",
        "reason": "no ball in frame",
        # a goal-adjacent read: exactly the case the force override used to rescue
        "outcome": "scoring_play",
    }
    evidence = {"trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0,
                "scoreBoardChanged": True, "scoreboardSurfaceIdentity": "contradicted"}
    out = _postprocess_gemma_verdict(dict(decision), evidence, "GOAL", [])
    assert out["isHighlight"] is False
    assert "scoreboard score change confirmed" not in (out.get("reason") or "")

    # Recall side: the same verdict on this match's own surface is still rescued.
    evidence["scoreboardSurfaceIdentity"] = "consistent"
    rescued = _postprocess_gemma_verdict(dict(decision), evidence, "GOAL", [])
    assert rescued["isHighlight"] is True
    assert "scoreboard score change confirmed" in (rescued.get("reason") or "")


def test_group_endpoint_refuses_a_contradicted_surface(monkeypatch):
    """AC2.3 on the served group path: model accepts the goal, guard still refuses."""
    reply = json.dumps([
        {"isHighlight": True, "score": 90, "eventType": "KILL", "reason": "clutch",
         "outcome": "scoring_play"},
        {"isHighlight": True, "score": 70, "eventType": "GOAL", "reason": "score moved",
         "outcome": "scoring_play"},
    ])
    mock = MockLlama(reply)
    monkeypatch.setenv("DECIDE_MODE", "gemma")
    monkeypatch.setenv("GEMMA_URL", f"http://127.0.0.1:{mock.port}")
    cands = [
        {"eventType": "KILL", "timestamp": 1.0,
         "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0}},
        {"eventType": "GOAL", "timestamp": 2.0,
         "evidence": {"trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0,
                      "scoreBoardChanged": True, "scoreboardSurfaceIdentity": "contradicted"}},
    ]
    try:
        r = client.post("/app/highlight", json=_group_payload(cands))
    finally:
        mock.stop()
    assert r.status_code == 200
    vs = r.json()["verdicts"]
    assert len(vs) == 2
    # The clean candidate is untouched (no recall loss from the new guard).
    assert vs[0]["isHighlight"] is True
    # The goal on a contradicted surface is not accepted off the score change.
    assert "scoreboard score change confirmed" not in (vs[1].get("reason") or "")


# --- the attestation criterion (gemma accept) -------------------------------

def test_attested_goal_criterion_refuses_a_contradicted_surface():
    """A foreign score change cannot certify a model accept either."""
    assert attested_goal_criterion({"scoreBoardChanged": True}) is True
    assert attested_goal_criterion({"scoreBoardChanged": True,
                                    "scoreboardSurfaceIdentity": "consistent"}) is True
    assert attested_goal_criterion({"scoreBoardChanged": True,
                                    "scoreboardSurfaceIdentity": "absent"}) is True
    assert attested_goal_criterion({"scoreBoardChanged": True,
                                    "scoreboardSurfaceIdentity": "contradicted"}) is False
    # The other attestation channels are unaffected.
    assert attested_goal_criterion({"goalCrossed": True,
                                    "scoreboardSurfaceIdentity": "contradicted"}) is True
    assert attested_goal_criterion({"ballOutcome": "goal",
                                    "scoreboardSurfaceIdentity": "contradicted"}) is True

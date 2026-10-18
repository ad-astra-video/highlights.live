"""Group mode: ONE merged /highlight review returns a verdict per candidate.

The server's live analyzer groups all Stage-A candidate triggers inside a 3 s
frame window and calls `decideGroup()` once per group, sending a `candidates`
array plus the group's `frames` and expecting back a `verdicts` array (one
verdict per candidate, in order). These tests cover:
  - rule group mode returns N verdicts in order,
  - each verdict reflects that candidate's own evidence/eventType,
  - the single-candidate path (candidates empty) is unchanged,
  - gemma group mode parses a multi-verdict response, and falls back on a bad
    response (AC7: a genuine highlight is never silently dropped).
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from fastapi.testclient import TestClient

from app import app as decide_app
from app.gemma import build_group_prompt, decide_group_with_gemma, parse_verdicts

client = TestClient(decide_app)


def _group_payload(candidates, **_extra):
    payload = {
        "sessionId": "grp-1",
        "eventType": candidates[0]["eventType"],
        "timestamp": 1.0,
        "candidates": candidates,
    }
    payload.update(_extra)
    return payload


# ---- rule group mode --------------------------------------------------------

def test_rule_group_mode_returns_n_verdicts_in_order(monkeypatch):
    monkeypatch.setenv("DECIDE_MODE", "rule")
    r = client.post(
        "/app/highlight",
        json={
            "sessionId": "grp-1",
            "eventType": "KILL",
            "timestamp": 1.0,
            "candidates": [
                # candidate 0: strong evidence -> highlighted (86)
                {"eventType": "KILL", "timestamp": 1.0,
                 "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0}},
                # candidate 1: bare trigger -> not highlighted
                {"eventType": "SHOT", "timestamp": 2.0,
                 "evidence": {"trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0}},
                # candidate 2: high-value + motion -> highlighted (~86)
                {"eventType": "GOAL", "timestamp": 3.0,
                 "evidence": {"trackCount": 3, "maxVelocity": 0.6, "ocrHits": 0,
                              "scoreBoardChanged": True}},
            ],
        },
    )
    assert r.status_code == 200
    body = r.json()
    vs = body["verdicts"]
    assert isinstance(vs, list)
    assert len(vs) == 3
    # order preserved
    assert vs[0]["eventType"] == "KILL"
    assert vs[1]["eventType"] == "SHOT"
    assert vs[2]["eventType"] == "GOAL"
    # each verdict reflects that candidate's own evidence
    assert vs[0]["isHighlight"] is True
    assert vs[0]["score"] == 86.0
    assert vs[1]["isHighlight"] is False
    assert vs[2]["isHighlight"] is True
    # top-level decision fields reflect the FIRST verdict (backward compat)
    assert body["isHighlight"] == vs[0]["isHighlight"]
    assert body["eventType"] == "KILL"
    assert body["source"] == "rule"


def test_rule_group_mode_verdict_reflects_own_evidence(monkeypatch):
    # Two KILL candidates with DIFFERENT evidence must get DIFFERENT verdicts:
    # the first has corroborating track/motion (highlighted), the second is a
    # bare trigger (rejected). This proves each verdict is driven by its own
    # candidate's evidence, not the group's first candidate.
    monkeypatch.setenv("DECIDE_MODE", "rule")
    r = client.post(
        "/app/highlight",
        json={
            "sessionId": "grp-2",
            "eventType": "KILL",
            "timestamp": 1.0,
            "candidates": [
                {"eventType": "KILL", "timestamp": 1.0,
                 "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0}},
                {"eventType": "KILL", "timestamp": 2.0,
                 "evidence": {"trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0}},
            ],
        },
    )
    assert r.status_code == 200
    vs = r.json()["verdicts"]
    assert len(vs) == 2
    assert vs[0]["isHighlight"] is True
    assert vs[1]["isHighlight"] is False


# ---- single-candidate path unchanged (backward compat) ----------------------

def test_single_candidate_path_unchanged_and_verdicts_empty(monkeypatch):
    # The existing single-candidate call (candidates omitted/empty) must behave
    # exactly as before: isHighlight/score/eventType verdict fields, and the new
    # `verdicts` field defaults to an empty list.
    monkeypatch.setenv("DECIDE_MODE", "rule")
    for candidates in (None, []):
        payload = {
            "sessionId": "sess-single",
            "eventType": "KILL",
            "timestamp": 12.0,
            "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0},
        }
        if candidates is not None:
            payload["candidates"] = candidates
        r = client.post("/app/highlight", json=payload)
        assert r.status_code == 200
        body = r.json()
        assert body["isHighlight"] is True
        assert body["score"] == 86.0
        assert body["eventType"] == "KILL"
        assert body["verdicts"] == []


# ---- gemma group mode -------------------------------------------------------

class MockLlama:
    """Minimal HTTP server faking llama.cpp /v1/chat/completions (group mode)."""

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


def _gemma_candidates():
    return [
        {"eventType": "KILL", "timestamp": 1.0,
         "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0}},
        {"eventType": "SHOT", "timestamp": 2.0,
         "evidence": {"trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0}},
    ]


def test_gemma_group_mode_parses_multi_verdict_response(monkeypatch):
    # ONE merged gemma call for the whole group must produce exactly one verdict
    # per candidate, in order. The reply is a JSON array.
    reply = json.dumps([
        {"isHighlight": True, "score": 90, "eventType": "KILL", "reason": "clutch",
         "outcome": "scoring_play"},
        {"isHighlight": False, "score": 12, "eventType": "SHOT", "reason": "quiet",
         "outcome": "not_highlight"},
    ])
    mock = MockLlama(reply)
    monkeypatch.setenv("DECIDE_MODE", "gemma")
    monkeypatch.setenv("GEMMA_URL", f"http://127.0.0.1:{mock.port}")
    try:
        r = client.post("/app/highlight", json=_group_payload(_gemma_candidates()))
    finally:
        mock.stop()
    assert r.status_code == 200
    body = r.json()
    vs = body["verdicts"]
    assert len(vs) == 2
    assert vs[0]["eventType"] == "KILL"
    assert vs[0]["isHighlight"] is True
    assert vs[1]["eventType"] == "SHOT"
    assert vs[1]["isHighlight"] is False
    # the top-level fields reflect the first verdict (backward compat)
    assert body["isHighlight"] == vs[0]["isHighlight"]
    # exactly ONE merged gemma call was made (not one per candidate)
    assert len(mock.requests) == 1
    prompt = [c["text"] for c in mock.requests[0]["messages"][0]["content"] if c.get("type") == "text"][0]
    assert "Candidate 0:" in prompt and "Candidate 1:" in prompt


def test_gemma_group_mode_falls_back_on_bad_response(monkeypatch):
    # A malformed group reply (AC7) must NOT drop candidates: it falls back to
    # one single-candidate gemma decide per candidate (which itself degrades to
    # the deterministic rule when the model reply is unparseable), so every
    # candidate still gets a verdict.
    mock = MockLlama("this is not json at all")
    monkeypatch.setenv("DECIDE_MODE", "gemma")
    monkeypatch.setenv("GEMMA_URL", f"http://127.0.0.1:{mock.port}")
    try:
        r = client.post("/app/highlight", json=_group_payload(_gemma_candidates()))
    finally:
        mock.stop()
    assert r.status_code == 200
    vs = r.json()["verdicts"]
    assert len(vs) == 2
    # per-candidate rule fallback reflects each candidate's own evidence
    assert vs[0]["eventType"] == "KILL"
    assert vs[0]["source"] == "rule-fallback"
    assert vs[1]["eventType"] == "SHOT"
    assert vs[1]["source"] == "rule-fallback"


def test_gemma_group_mode_falls_back_on_length_mismatch(monkeypatch):
    # Reply has the WRONG number of verdicts (2 candidates but 1 verdict) ->
    # length-mismatch fallback still yields a verdict per candidate.
    reply = json.dumps([{"isHighlight": True, "score": 90, "eventType": "KILL",
                         "reason": "clutch", "outcome": "scoring_play"}])
    mock = MockLlama(reply)
    monkeypatch.setenv("DECIDE_MODE", "gemma")
    monkeypatch.setenv("GEMMA_URL", f"http://127.0.0.1:{mock.port}")
    try:
        r = client.post("/app/highlight", json=_group_payload(_gemma_candidates()))
    finally:
        mock.stop()
    assert r.status_code == 200
    vs = r.json()["verdicts"]
    assert len(vs) == 2


# ---- unit: group prompt / parse ---------------------------------------------

def test_parse_verdicts_array() -> None:
    raw = '[{"isHighlight":true,"score":80},{"isHighlight":false,"score":10}]'
    vs = parse_verdicts(raw)
    assert vs is not None
    assert len(vs) == 2
    assert vs[0]["isHighlight"] is True
    assert vs[1]["isHighlight"] is False


def test_parse_verdicts_object_wrapper() -> None:
    raw = '{"verdicts":[{"isHighlight":true,"score":80},{"isHighlight":false,"score":10}]}'
    vs = parse_verdicts(raw)
    assert vs is not None
    assert len(vs) == 2


def test_parse_verdicts_fenced_array() -> None:
    raw = 'Sure! ```json\n[{"isHighlight":true,"score":80},{"isHighlight":false,"score":10}]\n```'
    vs = parse_verdicts(raw)
    assert vs is not None
    assert len(vs) == 2


def test_parse_verdicts_garbage_returns_none() -> None:
    assert parse_verdicts("not json at all") is None
    assert parse_verdicts('{"ok":true}') is None
    assert parse_verdicts('[{"isHighlight":true}, "garbage"]') is None


def test_build_group_prompt_lists_each_candidate() -> None:
    p = build_group_prompt(_gemma_candidates(), n_frames=6, has_audio=True)
    assert "Candidate 0:" in p
    assert "Candidate 1:" in p
    assert "eventType=KILL" in p or "eventType=SHOT" in p
    assert "score" in p
    assert "outcome" in p


def test_decide_group_with_gemma_default_rule_fallback() -> None:
    # No gemma reachable -> each candidate falls back to the deterministic rule,
    # so a group always returns exactly one verdict per candidate (AC7).
    d = decide_group_with_gemma(_gemma_candidates(), url="http://127.0.0.1:1")
    assert len(d) == 2
    assert d[0]["isHighlight"] is True   # KILL + track/motion -> rule 86
    assert d[1]["isHighlight"] is False  # SHOT bare -> rejected

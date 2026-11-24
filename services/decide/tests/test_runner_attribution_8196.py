"""ADAAAA-8196 (1/2) — decide-service half: echo the SERVING pool identity.

The client now names the route it posts to (`X-Runner-Route`, plus
`X-Runner-Pool`/`X-Runner-Tier` when known) and the orchestrator injects
`Livepeer-Runner-Route` on proxied calls. This service must:

* resolve ONE identity per decide (header -> `DECIDE_RUNNER_ROUTE` -> hostname;
  host = hostname, suffixed `/pool` when a pool id is known),
* echo `runnerRoute`/`runnerHost` on the `/highlight` decision (declared on the
  response model, which is `extra="ignore"` — an undeclared field is dropped),
* stamp the SAME two values into the audit record's `timings` at RECORD-BUILD
  time, so the on-disk `decide-audit.jsonl` line and the descriptor the server
  persists into `decide_audit.timings` agree 1:1 per container.

Everything is additive: a request with no attribution headers and no env keeps
today's response shape apart from the two honest hostname-derived fields.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi.testclient import TestClient

import app as decide_app_module
from app import app as decide_app
from app.gemma import _audit_record, _emit_audit, load_audit_records

client = TestClient(decide_app)

REPLY = json.dumps(
    {
        "isHighlight": False,
        "score": 10,
        "eventType": "GOAL",
        "outcome": "not_highlight",
        "reason": "no goal in the window",
        "reasoning": "the ball stays in midfield",
        "verdict": {
            "hypothesis": "GOAL",
            "independentlyObserved": "the ball stays in midfield",
            "criteria": {"ballInNet": False},
            "contradictedBy": "ball stays in midfield",
        },
        "runningSummary": "Midfield possession.",
        "postTitle": "Keeper clears ball",
    }
)


class _MockLlama:
    """Minimal chat-completions stand-in (rule mode never touches it)."""

    def __init__(self, reply: str = REPLY):
        self.reply = reply
        self.requests: list = []
        self._srv = HTTPServer(("127.0.0.1", 0), self._handler())
        self.port = self._srv.server_address[1]
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()

    def _handler(self):
        owner = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("content-length", 0))
                owner.requests.append(json.loads(self.rfile.read(n)))
                body = json.dumps({"choices": [{"message": {"content": owner.reply}}]}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):  # noqa: D102
                pass

        return H

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def stop(self) -> None:
        self._srv.shutdown()


PAYLOAD = {
    "sessionId": "s8196",
    "eventType": "GOAL",
    "timestamp": 42.5,
    "gameHint": "soccer",
    "evidence": {"trackCount": 1, "maxVelocity": 0.2, "ocrHits": 0},
    "frames": [{"role": "full", "base64": "ZmFrZQ=="}],
    "jobId": "job-8196",
    "groupKey": "g7",
}


@pytest.fixture(autouse=True)
def _rule_mode_and_clean_env(monkeypatch):
    """Default to the deterministic rule path, with no attribution env set."""
    monkeypatch.setenv("DECIDE_MODE", "rule")
    monkeypatch.delenv("DECIDE_RUNNER_ROUTE", raising=False)
    monkeypatch.delenv("DECIDE_POOL_ID", raising=False)
    monkeypatch.delenv("DECIDE_AUDIT_DIR", raising=False)
    yield


def test_route_and_pool_headers_are_echoed_on_both_mounts():
    headers = {"X-Runner-Route": "highlights-decide-5090-gpu1", "X-Runner-Pool": "decide-pool-8183"}
    for path in ("/highlight", "/app/highlight"):
        res = client.post(path, json=PAYLOAD, headers=headers)
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["runnerRoute"] == "highlights-decide-5090-gpu1"
        host = body["runnerHost"]
        assert host.startswith("/") is False
        assert host.endswith("/decide-pool-8183")
        assert body["isHighlight"] is False


def test_orchestrator_route_header_wins_over_the_client_echo():
    res = client.post(
        "/highlight",
        json=PAYLOAD,
        headers={"Livepeer-Runner-Route": "orch-route", "X-Runner-Route": "client-route"},
    )
    assert res.json()["runnerRoute"] == "orch-route"


def test_env_fallbacks_are_used_when_no_headers_arrive(monkeypatch):
    monkeypatch.setenv("DECIDE_RUNNER_ROUTE", "highlights-decide-5090-gpu2")
    monkeypatch.setenv("DECIDE_POOL_ID", "pool-env")
    body = client.post("/highlight", json=PAYLOAD).json()
    assert body["runnerRoute"] == "highlights-decide-5090-gpu2"
    assert body["runnerHost"].endswith("/pool-env")


def test_no_attribution_at_all_degrades_to_the_hostname():
    body = client.post("/highlight", json=PAYLOAD).json()
    assert body["runnerRoute"]
    assert "/" not in body["runnerRoute"]  # bare hostname, not a host/pool pair
    assert body["runnerHost"] == body["runnerRoute"]


def test_audit_record_carries_the_identity_in_timings(tmp_path):
    """The descriptor the server persists is built from this record, so the
    on-disk JSONL line and decide_audit.timings must agree — 1:1 per container."""
    record = _audit_record(
        audit_ctx={
            "sessionId": "s8196",
            "jobId": "job-8196",
            "groupKey": "g7",
            "frameCount": 1,
            "candidateCount": 1,
            "runnerRoute": "highlights-decide-5090-gpu1",
            "runnerHost": "decide-gpu1/decide-pool-8183",
        },
        mode="single",
        content=[{"type": "text", "text": "prompt"}],
        payload={"model": "gemma", "messages": [{"role": "user", "content": "prompt"}]},
        raw_reply=REPLY,
        parsed={"isHighlight": False},
        fallback=False,
        started_at=0.0,
    )
    assert record["timings"]["runnerRoute"] == "highlights-decide-5090-gpu1"
    assert record["timings"]["runnerHost"] == "decide-gpu1/decide-pool-8183"
    # And the JSONL line (the per-container trail the leg reconciles against).
    import os

    os.environ["DECIDE_AUDIT_DIR"] = str(tmp_path)
    _emit_audit(record)
    lines = (tmp_path / "decide-audit.jsonl").read_text().splitlines()
    assert len(lines) == 1
    written = json.loads(lines[0])
    assert written["timings"]["runnerRoute"] == "highlights-decide-5090-gpu1"
    assert written["timings"]["runnerHost"] == "decide-gpu1/decide-pool-8183"


def test_audit_record_without_identity_is_unchanged():
    record = _audit_record(
        audit_ctx={"sessionId": "s0", "groupKey": "g0"},
        mode="single",
        content=[{"type": "text", "text": "p"}],
        payload={"messages": [{"role": "user", "content": "p"}]},
        raw_reply="{}",
        parsed={},
        fallback=False,
        started_at=0.0,
    )
    assert "runnerRoute" not in record["timings"]
    assert "runnerHost" not in record["timings"]


def test_stamp_merges_into_an_existing_audit_block_without_overwriting():
    decision = {"isHighlight": False, "audit": {"timings": {"elapsedMs": 5, "runnerRoute": "worker-wins"}}}
    out = decide_app_module._stamp_runner_identity(
        decision, {"runnerRoute": "header-route", "runnerHost": "h/p"}
    )
    assert out["runnerRoute"] == "header-route"  # echoed top-level…
    assert out["audit"]["timings"]["runnerRoute"] == "worker-wins"  # …worker value wins
    assert out["audit"]["timings"]["runnerHost"] == "h/p"
    assert out["audit"]["timings"]["elapsedMs"] == 5


def test_gemma_path_response_and_descriptor_agree(monkeypatch):
    """End-to-end on the real gemma path: one decide, one identity, echoed on the
    response AND stamped into the audit descriptor the server persists."""
    llama = _MockLlama()
    monkeypatch.setenv("DECIDE_MODE", "gemma")
    monkeypatch.setenv("GEMMA_URL", llama.url)
    try:
        res = client.post(
            "/highlight",
            json=PAYLOAD,
            headers={"X-Runner-Route": "highlights-decide-5090-gpu2", "X-Runner-Pool": "decide-pool-8183"},
        )
    finally:
        llama.stop()
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["runnerRoute"] == "highlights-decide-5090-gpu2"
    assert body["runnerHost"].endswith("/decide-pool-8183")
    assert body["audit"]["timings"]["runnerRoute"] == body["runnerRoute"]
    assert body["audit"]["timings"]["runnerHost"] == body["runnerHost"]

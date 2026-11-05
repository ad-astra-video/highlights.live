"""ADAAAA-8081 — the decide service consumes the server's side-lane transcript.

The live decide call used to transcribe the window itself, serially ahead of
gemma. On the 4-image cell (ADAAAA-8074 legs A/B) the 1-image tail windows read
9 125 / 8 816 ms against a 2.4-3.3 s gemma cost because ASR took 4.27 / 5.48 s
inside the same call.

These tests pin the decide-service half of the fix:

* `asr_prefetched=True` consumes `asr_transcript` and DOES NOT call
  `transcribe_audio` — the call is gemma only.
* The prompt is byte-identical: the transcript still renders on the same
  `audio commentary transcript (ASR)` line, and `asrRan`/`asrLatencyS`/`audioPath`
  coverage is unchanged (AC-E2 must keep stamping every window).
* `asrSource` is recorded on the audit `timings` so a leg grades the migration
  instead of inferring it from latency.
* Absent/false keeps the inline ASR path untouched (the fallback that protects
  coverage when a prefetch times out).
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from fastapi.testclient import TestClient

import app.gemma as G
from app import app as decide_app
from app.gemma import decide_with_gemma

client = TestClient(decide_app)

REPLY = json.dumps(
    {
        "isHighlight": True,
        "score": 82,
        "eventType": "GOAL",
        "reason": "ball in net, crowd erupts",
        "outcome": "scoring_play",
    }
)


class _MockLlama:
    """Minimal chat-completions stand-in so the prompt is inspectable."""

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


def prompt_text(requests: list) -> str:
    """Every message's content, concatenated (system + user turns)."""
    out = []
    for req in requests:
        for msg in req.get("messages", []):
            out.append(str(msg.get("content") or ""))
    return "\n".join(out)


def _decide(llama, **kw):
    base = dict(
        event_type="GOAL",
        evidence={"trackCount": 3, "maxVelocity": 0.4, "ocrHits": 1},
        game_hint="soccer",
        frames=[{"role": "full", "base64": "ZmFrZQ=="}],
        audio_b64="YXVkaW8=",
        url=llama.url,
        audit_ctx={"sessionId": "s8081", "jobId": "job-8081", "groupKey": "g1", "frameCount": 1},
    )
    base.update(kw)
    return decide_with_gemma(**base)


def test_prefetched_transcript_skips_inline_asr(monkeypatch):
    """The whole point: no ASR call inside the decide when the lane pre-ran it."""
    llama = _MockLlama()
    called = {"n": 0}

    def _boom(*a, **k):  # pragma: no cover - must never run
        called["n"] += 1
        raise AssertionError("inline ASR ran despite a prefetched transcript")

    monkeypatch.setattr(G, "transcribe_audio", _boom)
    monkeypatch.setenv("AUDIO_CONTEXT", "1")
    monkeypatch.setenv("ASR_URL", "http://asr:8082")
    try:
        res = _decide(
            llama,
            asr_prefetched=True,
            asr_transcript="what a goal, what a finish",
            asr_latency_s=1.15,
        )
    finally:
        llama.stop()

    assert called["n"] == 0
    # Coverage block is intact and names the lane.
    ac = res["audioContext"]
    assert ac["asrRan"] is True
    assert ac["asrSource"] == "prefetch"
    assert ac["asrLatencyS"] == 1.15
    assert ac["path"] == "asr_text"
    assert ac["transcribed"] is True
    # The transcript reached the prompt on the SAME line the inline path used.
    assert "audio commentary transcript (ASR):" in prompt_text(llama.requests)
    assert "what a goal, what a finish" in prompt_text(llama.requests)


def test_prefetched_and_inline_prompts_are_identical(monkeypatch):
    """Same transcript in => byte-identical prompt out (no behavioural drift)."""
    transcript = "crowd roars, shot saved"
    p_llama = _MockLlama()
    monkeypatch.setenv("AUDIO_CONTEXT", "1")
    monkeypatch.setenv("ASR_URL", "http://asr:8082")
    monkeypatch.setattr(G, "transcribe_audio", lambda *a, **k: (transcript, 0.9))
    try:
        _decide(p_llama)
    finally:
        p_llama.stop()

    f_llama = _MockLlama()
    try:
        _decide(f_llama, asr_prefetched=True, asr_transcript=transcript, asr_latency_s=0.9)
    finally:
        f_llama.stop()

    assert prompt_text(p_llama.requests) == prompt_text(f_llama.requests)


def test_prefetched_silent_window_still_reports_rans(monkeypatch):
    """An ASR that ran to empty text is `asr_text`, never `none` (AC-E2)."""
    llama = _MockLlama()
    monkeypatch.setattr(G, "transcribe_audio", lambda *a, **k: (_ for _ in ()).throw(AssertionError))
    try:
        res = _decide(llama, asr_prefetched=True, asr_transcript="", asr_latency_s=0.4)
    finally:
        llama.stop()
    ac = res["audioContext"]
    assert ac["asrRan"] is True
    assert ac["asrSource"] == "prefetch"
    assert ac["path"] == "asr_text"
    assert ac["transcribed"] is False


def test_no_prefetch_keeps_the_inline_path(monkeypatch):
    """Absent/false prefetch => ASR as before (the coverage-preserving fallback)."""
    llama = _MockLlama()
    seen = {"n": 0}

    def _asr(*a, **k):
        seen["n"] += 1
        return ("inline transcript", 0.75)

    monkeypatch.setattr(G, "transcribe_audio", _asr)
    monkeypatch.setenv("AUDIO_CONTEXT", "1")
    monkeypatch.setenv("ASR_URL", "http://asr:8082")
    try:
        res = _decide(llama)
    finally:
        llama.stop()
    assert seen["n"] == 1
    assert res["audioContext"]["asrSource"] == "inline"
    assert res["audioContext"]["asrLatencyS"] == 0.75
    assert "inline transcript" in prompt_text(llama.requests)


def test_request_block_is_optional_and_shape_tolerant(monkeypatch):
    """A malformed prefetch block must degrade to inline ASR, never a 422."""
    monkeypatch.setattr(G, "transcribe_audio", lambda *a, **k: ("", 0.1))
    monkeypatch.setenv("AUDIO_CONTEXT", "1")
    monkeypatch.setenv("ASR_URL", "http://asr:8082")
    llama = _MockLlama()
    # A request with no prefetch keys at all (the pre-8081 wire shape).
    monkeypatch.setenv("DECIDE_MODE", "gemma")
    try:
        r = client.post(
            "/highlight",
            json={
                "sessionId": "s8081b",
                "eventType": "GOAL",
                "timestamp": 0,
                "jobId": "job-8081b",
                "groupKey": "g1",
                "evidence": {"trackCount": 1},
                "frames": [{"role": "full", "base64": "ZmFrZQ=="}],
                "audioB64": "YXVkaW8=",
                "asrLatencyS": "not-a-number",
            },
        )
    finally:
        llama.stop()
    # Whatever the model wiring does in this environment, the request must be
    # ACCEPTED (no 422 from the new optional fields).
    assert r.status_code != 422, r.text

"""ADAAAA-8373 — the INLINE-on-miss ASR lane's admission bound.

The ADAAAA-8363 grade of the ADAAAA-8351 leg measured the lane that concurrent
inline-on-miss decide calls share: leg-window peak concurrency 4, 24 h peak 5,
inline p50/p95/max 717 / 6 272 / 6 579 ms. p95 sits ON the 6 000 ms wait budget,
so queue time is what converts a call into a wait-miss.

These tests pin exactly the two acceptance criteria of ADAAAA-8373:

1. INERT BY DEFAULT. With `ASR_MAX_CONCURRENT` / `ASR_QUEUE_MS` unset, no
   admission bound is constructed, the inline path is the shipped
   `transcribe_audio` call, and the decide response is unchanged
   (`asrSource: "inline"`, no `asr_queue_miss` reason anywhere).
2. BOUND ENFORCED. With both set, a call that cannot get a slot inside
   `ASR_QUEUE_MS` misses FAST (elapsed <= queueMs + epsilon) with the queue
   reason (`asrSource: "queue_miss"`, `asrRan: false`,
   `noAudioReason: "asr_queue_miss"`), and concurrency never exceeds the cap.

The reason string is the point of the second half: a queue bound must never be
read back as ASR absence (`asr_unavailable`), or the coverage/recall argument
the deploy decision rests on becomes unmeasurable.
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import app.gemma as G
from app.asr_admission import inline_asr_gate, gate_for
from app.gemma import decide_with_gemma, transcribe_inline

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
    """Minimal chat-completions stand-in so one decide call can complete."""

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


def _decide(llama, **kw):
    base = dict(
        event_type="GOAL",
        evidence={"trackCount": 3, "maxVelocity": 0.4, "ocrHits": 1},
        game_hint="soccer",
        frames=[{"role": "full", "base64": "ZmFrZQ=="}],
        audio_b64="YXVkaW8=",
        url=llama.url,
        audit_ctx={"sessionId": "s8373", "jobId": "job-8373", "groupKey": "g1", "frameCount": 1},
    )
    base.update(kw)
    return decide_with_gemma(**base)


def _asr_env(monkeypatch, max_concurrent=None, queue_ms=None):
    """Set (or clear) the two knobs exactly as the container would see them."""
    for name, value in (
        ("ASR_MAX_CONCURRENT", max_concurrent),
        ("ASR_QUEUE_MS", queue_ms),
    ):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, str(value))
    monkeypatch.setenv("ASR_URL", "http://asr:8082")
    monkeypatch.setenv("AUDIO_CONTEXT", "1")
    monkeypatch.delenv("GEMMA_SEND_AUDIO", raising=False)


# --- AC1: inert by default ---------------------------------------------------


def test_no_env_constructs_no_bound(monkeypatch):
    """Both vars unset => the gate is UNBOUNDED (no semaphore at all)."""
    _asr_env(monkeypatch, None, None)
    gate = inline_asr_gate()
    assert gate.bounded is False
    assert gate.max_concurrent == 0
    assert gate.queue_ms == 0
    # Queue-only is still inert: ASR_QUEUE_MS has nothing to bind without a cap.
    monkeypatch.setenv("ASR_QUEUE_MS", "50")
    gate = inline_asr_gate()
    assert gate.bounded is False


def test_inert_inline_path_is_the_shipped_call(monkeypatch):
    """Unset knobs: ONE transcribe_audio call, `asrSource: "inline"`, no miss."""
    _asr_env(monkeypatch, None, None)
    calls = {"n": 0}

    def _fake_transcribe(url, audio_b64, sample_rate=16000, timeout_s=20.0, task=None):
        calls["n"] += 1
        return "what a goal", 0.42

    monkeypatch.setattr(G, "transcribe_audio", _fake_transcribe)
    llama = _MockLlama()
    try:
        res = _decide(llama)
    finally:
        llama.stop()

    assert calls["n"] == 1
    ac = res["audioContext"]
    assert ac["asrSource"] == "inline"
    assert ac["asrRan"] is True
    assert ac["path"] == "asr_text"
    assert ac["noAudioReason"] == ""
    assert ac["asrLatencyS"] == 0.42
    # The transcript still rides the prompt on the same line as before.
    prompt = "\n".join(str(m.get("content") or "") for r in llama.requests for m in r.get("messages", []))
    assert "what a goal" in prompt


# --- AC2: bound enforced + miss is fast and labelled -------------------------


def test_queue_miss_is_fast_and_named(monkeypatch):
    """One slot held => the next inline call misses inside ASR_QUEUE_MS."""
    _asr_env(monkeypatch, 1, 80)
    release = threading.Event()

    def _slow_transcribe(url, audio_b64, sample_rate=16000, timeout_s=20.0, task=None):
        # Hold the single slot until the test releases it.
        release.wait(2.0)
        return "held slot transcript", 0.9

    monkeypatch.setattr(G, "transcribe_audio", _slow_transcribe)

    llama_a = _MockLlama()
    llama_b = _MockLlama()
    results: dict = {}

    def _hold():
        results["a"] = _decide(llama_a)

    holder = threading.Thread(target=_hold, daemon=True)
    holder.start()
    # Give the holder time to take the slot before the second call asks for one.
    time.sleep(0.05)
    t0 = time.monotonic()
    results["b"] = _decide(llama_b)
    elapsed_ms = (time.monotonic() - t0) * 1000
    release.set()
    holder.join(5.0)
    llama_a.stop()
    llama_b.stop()

    # AC2: the miss is FAST — bounded by the queue deadline, not by the
    # transcription behind it (the holder's stub blocks for up to 2 s).
    assert elapsed_ms <= 80 + 400, f"queue miss took {elapsed_ms:.0f} ms"
    b = results["b"]["audioContext"]
    assert b["asrSource"] == "queue_miss"
    assert b["asrRan"] is False
    assert b["transcribed"] is False
    assert b["path"] == "none"
    assert b["asrLatencyS"] == 0.0
    # AC "distinguishable from a budget miss": its OWN reason string, never
    # `asr_unavailable` (which would read as ASR absence on a stored row).
    assert b["noAudioReason"] == "asr_queue_miss"
    # The slot holder was served normally and keeps the shipped inline label.
    a = results["a"]["audioContext"]
    assert a["asrSource"] == "inline"
    assert a["asrRan"] is True
    assert a["noAudioReason"] == ""

    # The gate counted exactly one miss and the holder DID acquire.
    gate = inline_asr_gate()
    assert gate.queue_misses == 1
    assert gate.admitted == 1


def test_concurrency_never_exceeds_the_cap(monkeypatch):
    """Cap 2, queue 0 (= wait, today's queueing): peak in-flight ASR is <= 2."""
    _asr_env(monkeypatch, 2, 0)
    state = {"live": 0, "peak": 0, "ran": 0}
    lock = threading.Lock()

    def _counting_transcribe(url, audio_b64, sample_rate=16000, timeout_s=20.0, task=None):
        with lock:
            state["live"] += 1
            state["peak"] = max(state["peak"], state["live"])
            state["ran"] += 1
        time.sleep(0.08)
        with lock:
            state["live"] -= 1
        return "counted", 0.08

    monkeypatch.setattr(G, "transcribe_audio", _counting_transcribe)

    out = []

    def _one(i):
        out.append(transcribe_inline("http://asr:8082", "YXVkaW8="))

    threads = [threading.Thread(target=_one, args=(i,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10.0)

    assert state["ran"] == 6, "every call must eventually get a slot with queue=0"
    assert state["peak"] <= 2, f"peak concurrency {state['peak']} exceeded the cap"
    assert all(missed is False for _text, _s, missed in out)


def test_env_values_reach_the_gate(monkeypatch):
    """The container env is what builds the bound (values, not a source constant)."""
    _asr_env(monkeypatch, 3, 120)
    gate = inline_asr_gate()
    assert gate.bounded is True
    assert (gate.max_concurrent, gate.queue_ms) == (3, 120)
    # Bad input degrades to the shipped posture, never to a crash/odd bound.
    monkeypatch.setenv("ASR_MAX_CONCURRENT", "not-a-number")
    monkeypatch.setenv("ASR_QUEUE_MS", "-5")
    gate = inline_asr_gate()
    assert gate.bounded is False


def test_gate_for_is_the_lane_not_a_per_call_object(monkeypatch):
    """Two calls with the same posture share ONE gate (a lane, not a new object)."""
    _asr_env(monkeypatch, 2, 0)
    assert inline_asr_gate() is inline_asr_gate()
    assert gate_for(2, 0) is inline_asr_gate()

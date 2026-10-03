import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from fastapi.testclient import TestClient

from app.gemma import build_prompt, decide_with_gemma, parse_decision, transcribe_audio


# --- parse/build units ------------------------------------------------------

def test_parse_decision_plain_json():
    d = parse_decision('{"isHighlight":true,"score":78,"eventType":"KILL","reason":"ace"}')
    assert d["isHighlight"] is True
    assert d["score"] == 78.0
    assert d["eventType"] == "KILL"


def test_parse_decision_markdown_fenced():
    d = parse_decision('Sure! ```json\n{"isHighlight":false,"score":12,"reason":"nothing"}\n```')
    assert d["isHighlight"] is False
    assert d["score"] == 12.0


def test_parse_decision_garbage_returns_none():
    assert parse_decision("not json at all") is None
    assert parse_decision('{"ok":true}') is None  # missing isHighlight


def test_build_prompt_contains_context():
    p = build_prompt("KILL", {"trackCount": 2, "maxVelocity": 0.4}, "valorant")
    assert "KILL" in p
    assert "valorant" in p
    assert '"isHighlight"' in p


# --- INC-4 / ADAAAA-4328: people-reaction dimension --------------------------

def test_build_prompt_includes_reaction_dimension():
    evidence = {
        "trackCount": 3,
        "maxVelocity": 0.6,
        "ocrHits": 0,
        "reaction": {
            "crowdEnergy": 0.91,
            "audioKind": "swell",
            "humansInMotion": 5,
            "ballSpeedMps": 21.4,
            "ballPossessionId": "t2",
        },
    }
    p = build_prompt("GOAL", evidence, "soccer", n_frames=6, has_audio=True)
    # the reaction evidence is cited as context for the verdict
    assert "people-reaction evidence:" in p
    assert "audio reaction: swell at crowd energy 0.91/1.0" in p
    assert "visual reaction: 5 human(s) in high motion (celebration cue)" in p
    assert "ball context: 21.4 m/s toward/at possession player t2" in p
    # explicit reaction-reasoning instructions present
    assert "EXPLICITLY describe their reaction" in p
    assert "group pile" in p
    assert "bench" in p
    # reaction is corroborating evidence, never the arbiter
    assert "corroborating evidence only" in p
    # strict-JSON contract is unchanged
    assert '"isHighlight"' in p


def test_build_prompt_no_reaction_no_regression():
    # A candidate with no reaction signal renders the base prompt without any
    # people-reaction scalar context (no "people-reaction evidence" block), so a
    # candidate with no reaction data is unchanged vs today. The reaction
    # REASONING instruction stays (it nudges the model to cite reactions when
    # people are visible, which is what the reaction-recall metric needs), but it
    # never changes the strict-JSON contract.
    p = build_prompt("KILL", {"trackCount": 2, "maxVelocity": 0.4}, "valorant")
    assert "people-reaction evidence:" not in p
    assert "audio reaction:" not in p
    assert '"isHighlight"' in p
    assert '"score": 0..100' in p
    # absent reaction field / None / garbage are all tolerated
    for bad in ({}, {"reaction": None}, {"reaction": "junk"}, {"reaction": {"crowdEnergy": "x"}}):
        q = build_prompt("KILL", bad)
        assert '"isHighlight"' in q


# --- INC-4: strict-JSON eval (no regression to parse rate vs today) ----------

# Representative corpus of Gemma 12B outputs (including the noisy forms that the
# strip/parse pipeline must keep handling). parse_decision must return a valid
# HighlightDecision-shaped dict for every one — this is the strict-JSON eval
# gate: a prompt edit must not regress the parse rate.
CORPUS = [
    '{"isHighlight":true,"score":82,"eventType":"GOAL","reason":"crowd erupts, arms raised"}',
    'Sure! ```json\n{"isHighlight":false,"score":9,"eventType":"NONE","reason":"quiet"}\n```',
    '```json\n{"isHighlight":true,"score":95,"eventType":"DUNK","reason":"pile on"}\n```',
    'Here is the decision: {"isHighlight":true,"score":74,"eventType":"CLUTCH","reason":"bench up"}',
    '{"isHighlight": true, "score": 66, "eventType": "KILL", "reason": "group celebrate"} trailing',
    '     {"isHighlight":false,"score":3.5,"reason":"nothing","eventType":"NONE"}     ',
]


def test_strict_json_eval_corpus_full_parse():
    for raw in CORPUS:
        d = parse_decision(raw)
        assert d is not None, f"parse failure -> regression for: {raw!r}"
        assert isinstance(d["isHighlight"], bool)
        assert 0.0 <= d["score"] <= 100.0
        assert "reason" in d
        assert "source" in d


def test_decide_with_gemma_forwards_reaction_context():
    # The reaction evidence folded into the prompt reaches the model request
    # (single decide() call — no additional inference).
    mock = MockLlama('{"isHighlight":true,"score":90,"eventType":"GOAL","reason":"crowd up"}')
    try:
        decide_with_gemma(
            "GOAL",
            {
                "trackCount": 3,
                "maxVelocity": 0.6,
                "ocrHits": 0,
                "reaction": {
                    "crowdEnergy": 0.9,
                    "audioKind": "burst",
                    "humansInMotion": 4,
                    "ballSpeedMps": 0.0,
                    "ballPossessionId": "",
                },
            },
            game_hint="soccer",
            url=f"http://127.0.0.1:{mock.port}",
        )
    finally:
        mock.stop()
    assert len(mock.requests) == 1  # exactly one decide() call
    text_content = [c for c in mock.requests[0]["messages"][0]["content"] if c.get("type") == "text"]
    prompt = text_content[0]["text"]
    assert "audio reaction: burst at crowd energy 0.90/1.0" in prompt
    assert "visual reaction: 4 human(s) in high motion" in prompt
    assert "people-reaction evidence:" in prompt


# --- decide_with_gemma against a mock llama-server ---------------------------

class MockLlama:
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


def test_decide_sends_thinking_off():
    # QAT thinking mode otherwise burns the budget on reasoning_content and returns
    # empty content -> rule fallback. reasoning_effort="none" disables it (llama.cpp).
    mock = MockLlama('{"isHighlight":false,"score":10,"eventType":"NONE","reason":"quiet"}')
    try:
        decide_with_gemma(
            "NONE",
            {"trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0},
            url=f"http://127.0.0.1:{mock.port}",
        )
    finally:
        mock.stop()
    assert mock.requests[0]["reasoning_effort"] == "none"
    assert mock.requests[0]["temperature"] == 0.0


def test_decide_with_gemma_uses_model():
    mock = MockLlama('{"isHighlight":true,"score":90,"eventType":"KILL","reason":"model saw it"}')
    try:
        d = decide_with_gemma(
            "KILL",
            {"trackCount": 2, "maxVelocity": 0.3, "ocrHits": 0},
            game_hint="valorant",
            images=[{"role": "full", "base64": "AAA"}],
            url=f"http://127.0.0.1:{mock.port}",
        )
    finally:
        mock.stop()
    assert d["isHighlight"] is True
    assert d["score"] == 90.0
    assert d["source"] == "gemma"
    content = mock.requests[0]["messages"][0]["content"]
    assert any(c.get("type") == "image_url" for c in content)


def test_decide_with_gemma_orders_frames_text_audio(monkeypatch):
    # Gemma 4 12B modality-order guidance applies when the raw audio path is
    # explicitly enabled (GEMMA_SEND_AUDIO=1): all images (frame sequence +
    # crops) BEFORE the text prompt, audio AFTER the text. By default the raw
    # path is off (ADAAAA-6314 Path 2 -> audio context is TEXT), so this test
    # pins the explicit raw-send ordering.
    monkeypatch.setenv("GEMMA_SEND_AUDIO", "1")
    mock = MockLlama('{"isHighlight":true,"score":88,"eventType":"GOAL","reason":"net"}')
    try:
        d = decide_with_gemma(
            "GOAL",
            {"trackCount": 2, "maxVelocity": 0.3, "ocrHits": 0},
            game_hint="fa cup",
            frames=[{"role": "frame", "base64": "FR1"}, {"role": "frame", "base64": "FR2"}],
            images=[{"role": "full", "base64": "CROP"}],
            audio_b64="WAVB64",
            url=f"http://127.0.0.1:{mock.port}",
        )
    finally:
        mock.stop()
    assert d["eventType"] == "GOAL"
    content = mock.requests[0]["messages"][0]["content"]
    types = [c.get("type") for c in content if c.get("type")]
    # 2 frames + 1 crop (all image_url) -> text. NO audio_url block even though
    # audio_b64 was supplied (llama-server 400s "unsupported content[].type" on
    # the audio_url content type — ADAAAA-5979 regression gate).
    assert types == ["image_url", "image_url", "image_url", "text"]
    # every image before the text
    first_text = types.index("text")
    assert all(t == "image_url" for t in types[:first_text])


def test_decide_request_bytes_contain_only_accepted_content_types():
    # ADAAAA-5979 regression: the serialized request must contain only content
    # types llama-server accepts (image_url, text) — never audio_url, which it
    # rejects with HTTP 400 "unsupported content[].type" and silently drops
    # gemma analysis to the rule fallback.
    mock = MockLlama('{"isHighlight":false,"score":4,"eventType":"NONE","reason":"quiet"}')
    try:
        d = decide_with_gemma(
            "GOAL",
            {"trackCount": 2, "maxVelocity": 0.3, "ocrHits": 0},
            frames=[{"role": "frame", "base64": "FR1"}],
            images=[{"role": "full", "base64": "CROP"}],
            audio_b64="WAVB64",
            url=f"http://127.0.0.1:{mock.port}",
        )
    finally:
        mock.stop()
    assert d["source"] == "gemma"
    raw = json.dumps(mock.requests[0])
    assert "audio_url" not in raw
    assert 'data:audio/wav' not in raw
    content = mock.requests[0]["messages"][0]["content"]
    for part in content:
        assert part["type"] in ("image_url", "text")
    # a decide call that supplies audio still carries the audio-derived reaction
    # evidence as TEXT in the prompt (crowd energy etc.), so no audio signal lost
    prompt = [p["text"] for p in content if p.get("type") == "text"][0]
    assert "audio" in prompt


def test_decide_with_gemma_sends_audio_only_when_gated_on(monkeypatch):
    # GEMMA_SEND_AUDIO=1 re-enables the audio_url block (for future llama-server
    # builds that accept it). Default off keeps the request frames+text.
    mock = MockLlama('{"isHighlight":true,"score":88,"eventType":"GOAL","reason":"net"}')
    try:
        d = decide_with_gemma(
            "GOAL",
            {"trackCount": 2, "maxVelocity": 0.3, "ocrHits": 0},
            frames=[{"role": "frame", "base64": "FR1"}],
            audio_b64="WAVB64",
            url=f"http://127.0.0.1:{mock.port}",
        )
    finally:
        mock.stop()
    assert d["isHighlight"] is True  # source gemma (mock 200)
    types = [c.get("type") for c in mock.requests[0]["messages"][0]["content"] if c.get("type")]
    assert "audio_url" not in types  # default gate off -> no audio block

    monkeypatch.setenv("GEMMA_SEND_AUDIO", "1")
    mock2 = MockLlama('{"isHighlight":true,"score":88,"eventType":"GOAL","reason":"net"}')
    try:
        d2 = decide_with_gemma(
            "GOAL",
            {"trackCount": 2, "maxVelocity": 0.3, "ocrHits": 0},
            frames=[{"role": "frame", "base64": "FR1"}],
            audio_b64="WAVB64",
            url=f"http://127.0.0.1:{mock2.port}",
        )
    finally:
        mock2.stop()
    types2 = [c.get("type") for c in mock2.requests[0]["messages"][0]["content"] if c.get("type")]
    assert types2[-1] == "audio_url"  # gate on -> audio block appended last
    prompt = [p["text"] for p in mock2.requests[0]["messages"][0]["content"] if p.get("type") == "text"][0]
    assert "audio provided (commentary/crowd): yes" in prompt


def test_build_prompt_reflects_frames_and_audio():
    p = build_prompt("GOAL", {"trackCount": 1, "maxVelocity": 0.2, "ocrHits": 0}, "fa cup", n_frames=6, has_audio=True)
    assert "frames shown (1 FPS temporal window): 6" in p
    assert "audio provided (commentary/crowd): yes" in p
    assert "SEQUENCE of frames" in p


def test_decide_falls_back_to_rule_on_model_failure():
    d = decide_with_gemma("KILL", {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0}, url="http://127.0.0.1:1")
    assert d["source"] == "rule-fallback"
    assert d["isHighlight"] is True  # rule: 50 + 20 + 16 = 86 >= 60


def test_highlight_gemma_mode_routes_to_model(monkeypatch):
    from app import app

    monkeypatch.setenv("DECIDE_MODE", "gemma")
    c = TestClient(app)
    r = c.post(
        "/app/highlight",
        json={
            "sessionId": "s1",
            "eventType": "KILL",
            "timestamp": 1.0,
            "gameHint": "valorant",
            "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0},
            "images": [{"role": "full", "base64": "AAA"}],
        },
    )
    assert r.status_code == 200
    body = r.json()
    # gemma URL (127.0.0.1:8088) unreachable in test -> rule fallback, still valid
    assert body["source"] in ("rule-fallback", "gemma")
    assert "isHighlight" in body


def test_highlight_gemma_returns_source_gemma_with_frames_and_audio(monkeypatch):
    # Decide-layer proof (ADAAAA-5979 acceptance #3): a /highlight call with
    # frames (+audio supplied) against a live reachable llama-server returns a
    # gemma-analyzed HighlightDecision with source="gemma" — not the rule
    # fallback — and sends only image_url/text content (no audio_url, which the
    # real llama-server 400s on).
    mock = MockLlama('{"isHighlight":true,"score":91,"eventType":"GOAL","reason":"net, crowd up"}')
    monkeypatch.setenv("DECIDE_MODE", "gemma")
    monkeypatch.setenv("GEMMA_URL", f"http://127.0.0.1:{mock.port}")
    from app import app

    c = TestClient(app)
    try:
        r = c.post(
            "/app/highlight",
            json={
                "sessionId": "s1",
                "eventType": "GOAL",
                "timestamp": 1.0,
                "gameHint": "fa cup",
                "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0},
                "frames": [{"role": "frame", "base64": "FR1"}],
                "audioB64": "WAVB64",
                "audioSampleRate": 16000,
                "reasoningEffort": "none",
            },
        )
    finally:
        mock.stop()
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "gemma"
    assert body["isHighlight"] is True
    assert body["score"] == 91.0
    assert body["eventType"] == "GOAL"
    # the request sent to llama-server contains only accepted content types
    content = mock.requests[0]["messages"][0]["content"]
    types = [c.get("type") for c in content if c.get("type")]
    assert types == ["image_url", "text"]
    assert "audio_url" not in json.dumps(mock.requests[0])


# --- ADAAAA-6314 Path 2: ASR->text audio context into the decide prompt -------
# gemma/llama-server (b10920) rejects raw audio_url (see send_audio gate), so
# audio context is transcribed to text and injected into the prompt. These tests
# mock both the ASR endpoint and the llama-server with real HTTPServer instances.


class MockAsr:
    """Minimal HTTP server faking the ASR endpoint (POST /transcribe)."""

    def __init__(self, reply: str = "and the crowd goes wild! what a strike"):
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
                resp = json.dumps({"text": owner.reply})
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(resp.encode())

            def log_message(self, *a):
                pass

        return H

    def stop(self):
        self._srv.shutdown()


def test_transcribe_audio_calls_asr_and_returns_text():
    mock = MockAsr("commentary: GOAL for the home side")
    try:
        text, latency = transcribe_audio(f"http://127.0.0.1:{mock.port}", "WAVB64", 16000)
    finally:
        mock.stop()
    assert text == "commentary: GOAL for the home side"
    assert latency >= 0.0
    # contract: POST /transcribe with {audio, sample_rate}
    assert mock.requests[0]["audio"] == "WAVB64"
    assert mock.requests[0]["sample_rate"] == 16000


def test_transcribe_audio_failure_returns_empty():
    # unparseable / unreachable ASR degrades to ("", elapsed) — never raises.
    text, latency = transcribe_audio("http://127.0.0.1:1", "WAVB64", 16000)
    assert text == ""
    assert latency >= 0.0


def test_build_prompt_renders_transcript():
    p = build_prompt(
        "GOAL",
        {"trackCount": 1, "maxVelocity": 0.2, "ocrHits": 0},
        "fa cup",
        n_frames=2,
        has_audio=True,
        transcript="commentary: they've scored!",
    )
    assert "audio commentary transcript (ASR):" in p
    assert "commentary: they've scored!" in p
    assert '"isHighlight"' in p


def test_build_prompt_no_transcript_no_regression():
    p = build_prompt("GOAL", {"trackCount": 1, "maxVelocity": 0.2, "ocrHits": 0})
    assert "audio commentary transcript" not in p
    assert "people-reaction evidence:" not in p
    assert '"isHighlight"' in p


def test_decide_with_gemma_injects_transcript_when_audio_present(monkeypatch):
    # Audio is supplied (trigger-passing candidate), raw path off, ASR configured:
    # the transcript reaches the model prompt and the ask() request stays
    # frames+text (no raw audio_url), and audioContext cost/latency is reported.
    asr = MockAsr("commentary: what a strike from the edge of the box")
    llama = MockLlama('{"isHighlight":true,"score":90,"eventType":"GOAL","reason":"goal"}')
    try:
        monkeypatch.setenv("ASR_URL", f"http://127.0.0.1:{asr.port}")
        monkeypatch.setenv("GEMMA_SEND_AUDIO", "0")
        monkeypatch.setenv("AUDIO_CONTEXT", "1")
        d = decide_with_gemma(
            "GOAL",
            {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0},
            game_hint="fa cup",
            frames=[{"role": "frame", "base64": "FR1"}],
            audio_b64="WAVB64",
            url=f"http://127.0.0.1:{llama.port}",
        )
    finally:
        asr.stop()
        llama.stop()
    # transcript injected into the prompt
    content = llama.requests[0]["messages"][0]["content"]
    prompt = [c["text"] for c in content if c.get("type") == "text"][0]
    assert "audio commentary transcript (ASR):" in prompt
    assert "what a strike from the edge of the box" in prompt
    # ask() request carries NO raw audio block (gemma can't ingest it)
    assert all(c.get("type") != "audio_url" for c in content)
    # exactly one llama decide() call and one ASR call
    assert len(llama.requests) == 1
    assert len(asr.requests) == 1
    # cost/latency readout
    assert d["audioContext"]["path"] == "asr_text"
    assert d["audioContext"]["transcribed"] is True
    assert d["audioContext"]["asrRan"] is True
    assert d["audioContext"]["asrLatencyS"] >= 0.0


def test_decide_with_gemma_no_asr_url_skips_transcript(monkeypatch):
    # No ASR endpoint configured: audio present but no transcription, prompt
    # text-only, and the audioContext readout reports transcribed=False.
    llama = MockLlama('{"isHighlight":true,"score":80,"eventType":"GOAL","reason":"goal"}')
    try:
        monkeypatch.setenv("GEMMA_SEND_AUDIO", "0")
        monkeypatch.delenv("ASR_URL", raising=False)
        d = decide_with_gemma(
            "GOAL",
            {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0},
            frames=[{"role": "frame", "base64": "FR1"}],
            audio_b64="WAVB64",
            url=f"http://127.0.0.1:{llama.port}",
        )
    finally:
        llama.stop()
    prompt = [c["text"] for c in llama.requests[0]["messages"][0]["content"] if c.get("type") == "text"][0]
    assert "audio commentary transcript" not in prompt
    assert d["audioContext"]["transcribed"] is False
    assert d["audioContext"]["asrRan"] is False

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
    # pins the explicit raw-send ordering. The raw block uses the current
    # OpenAI `input_audio` schema (verified accepted by llama.cpp build 10920);
    # the deployed QAT model is not audio-capable, so it stays gated off.
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
    # 2 frames + 1 crop (all image_url) -> text -> input_audio
    assert types == ["image_url", "image_url", "image_url", "text", "input_audio"]
    # every image before the text; audio strictly last
    first_text = types.index("text")
    assert all(t == "image_url" for t in types[:first_text])
    assert types[-1] == "input_audio"
    # audio payload is the current schema: {data, format}
    assert content[-1]["input_audio"]["data"] == "WAVB64"
    assert content[-1]["input_audio"]["format"] == "wav"


def test_build_prompt_reflects_frames_and_audio():
    p = build_prompt("GOAL", {"trackCount": 1, "maxVelocity": 0.2, "ocrHits": 0}, "fa cup", n_frames=6, has_audio=True)
    assert "frames shown (1 FPS temporal window): 6" in p
    assert "audio provided (commentary/crowd): yes" in p
    assert "SEQUENCE of frames" in p


def test_decide_with_gemma_reports_input_audio_path(monkeypatch):
    # ADAAAA-6350: when the native raw-audio path is on (GEMMA_SEND_AUDIO=1) and
    # audio is supplied for a trigger-passing candidate, the decision reports
    # audioContext.path = "input_audio" (not the Path-2 "asr_text") and no ASR
    # ran — so the caller can tell the model heard the native clip.
    monkeypatch.setenv("GEMMA_SEND_AUDIO", "1")
    monkeypatch.setenv("AUDIO_CONTEXT", "1")
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
    assert d["audioContext"]["path"] == "input_audio"
    assert d["audioContext"]["asrRan"] is False
    assert d["audioContext"]["transcribed"] is False


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


# --- ADAAAA-6314 Path 2: ASR->text audio context into the decide prompt -------
# llama.cpp build 10920 ACCEPTS an `input_audio` block, but the deployed QAT
# model is not audio-capable (answers as text-only), so audio context is
# transcribed to text and injected into the prompt by default. These tests
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
    # ask() request carries NO raw audio block (model is not audio-capable)
    assert all(c.get("type") != "input_audio" for c in content)
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


# --- ADAAAA-6358 (I1): de-anchor + verify-framing prompt ---------------------
# The candidate event type is a HYPOTHESIS to test, not a fact. The model must
# (a) independently observe first, (b) check explicit goal criteria, and (c)
# return isHighlight=false when a required criterion is unverifiable/contradicted.
# The response carries a structured `verdict` + `evidenceAttested`.


def test_build_prompt_deanchored_hypothesis_not_fact():
    p = build_prompt("GOAL", {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0}, "soccer")
    # the candidate type is framed as a hypothesis to test, never assumed true
    assert "HYPOTHESIS to test" in p
    assert "NEVER assume the hypothesis is true" in p
    # the old anchoring line ("verify it from the frames") that implied
    # confirmation-of-a-fact is gone; the candidate is now the thing to test.
    assert "CANDIDATE label, not proof" not in p


def test_build_prompt_requires_two_pass_reasoning():
    p = build_prompt("GOAL", {}, "soccer")
    # independent observation happens FIRST, before the hypothesis is considered
    assert "PASS 1" in p
    assert "PASS 2" in p
    assert "INDEPENDENT OBSERVATION" in p
    assert "HYPOTHESIS TEST" in p
    assert "FIRST, before considering the hypothesis" in p


def test_build_prompt_names_explicit_goal_criteria():
    p = build_prompt("GOAL", {}, "soccer")
    # all four explicit goal criteria are named and tri-state on the wire
    for k in (
        "ballCrossedLineBetweenPosts",
        "ballInNet",
        "scoreboardChanged",
        "crowdErupted",
    ):
        assert k in p
    # a required criterion that is unverifiable or contradicted must reject
    assert "UNVERIFIABLE" in p
    assert "EXPLICITLY CONTRADICTED" in p
    assert "isHighlight=false" in p


def test_build_prompt_response_shape_carries_rationale():
    p = build_prompt("GOAL", {}, "soccer")
    # the strict-JSON contract now carries the reviewer-facing rationale
    assert '"isHighlight"' in p
    assert '"reason"' in p
    assert '"reasoning"' in p
    assert '"verdict"' in p
    assert '"evidenceAttested"' in p


def test_parse_decision_i1_verdict_reply():
    # An off-target shot rejected with a grounded, contradicting-evidence reason
    # and a structured verdict + attested evidence must parse cleanly.
    raw = (
        '{"isHighlight":false,"score":20,"eventType":"GOAL",'
        '"reason":"ball hit the crossbar and was cleared; no ball in the net",'
        '"reasoning":"I see a shot strike the woodwork and the keeper clear it. '
        'The ball never entered the net, so this contradicts the GOAL hypothesis.",'
        '"verdict":{"hypothesis":"GOAL",'
        '"independentlyObserved":"shot strikes the crossbar; keeper clears",'
        '"criteria":{"ballCrossedLineBetweenPosts":false,"ballInNet":false,'
        '"scoreboardChanged":null,"crowdErupted":true},'
        '"contradictedBy":"ball hit the crossbar and was cleared; never entered the net"},'
        '"evidenceAttested":["ball crossed the crossbar at frame 4",'
        '"keeper cleared at frame 5","scoreboard unchanged 0-0"]}'
    )
    d = parse_decision(raw)
    assert d is not None
    assert d["isHighlight"] is False
    # independent-observation-first rationale is grounded and names the evidence
    assert d["reasoning"]
    assert "never entered the net" in d["reasoning"] or "woodwork" in d["reasoning"]
    assert d["verdict"] is not None
    assert d["verdict"]["hypothesis"] == "GOAL"
    assert "crossbar" in d["verdict"]["independentlyObserved"]
    assert d["verdict"]["criteria"]["ballCrossedLineBetweenPosts"] is False
    assert d["verdict"]["criteria"]["ballInNet"] is False
    assert d["verdict"]["criteria"]["scoreboardChanged"] is None  # null == unverifiable
    assert "crossbar" in d["verdict"]["contradictedBy"]
    assert len(d["evidenceAttested"]) == 3
    assert d["source"] == "gemma"


def test_parse_decision_warmup_rejected_with_contradicting_reason():
    # A warm-up clip (no strike) mislabeled GOAL is rejected; the reason names
    # the contradicting evidence (no shot / no ball in net).
    raw = (
        '{"isHighlight":false,"score":10,"eventType":"GOAL",'
        '"reason":"warm-up passing drill; no shot on goal and no ball in the net",'
        '"reasoning":"Players pass the ball around in the middle of the pitch. '
        'There is no strike, no shot, and the ball never approaches the goal. '
        'This contradicts the GOAL hypothesis.",'
        '"verdict":{"hypothesis":"GOAL","independentlyObserved":"players passing, no strike",'
        '"criteria":{"ballCrossedLineBetweenPosts":false,"ballInNet":false,'
        '"scoreboardChanged":false,"crowdErupted":false},'
        '"contradictedBy":"no shot was taken; ball stays in midfield"},'
        '"evidenceAttested":["players passing in midfield","no shot toward goal"]}'
    )
    d = parse_decision(raw)
    assert d is not None
    assert d["isHighlight"] is False
    assert "no shot" in d["reason"] or "no ball" in d["reason"]
    assert d["verdict"]["criteria"]["ballInNet"] is False
    assert d["verdict"]["contradictedBy"]


def test_parse_decision_legacy_reply_back_compat():
    # A pre-I1 / legacy-shaped reply (no rationale) still parses with empty
    # rationale so the response shape stays stable.
    d = parse_decision('{"isHighlight":true,"score":82,"eventType":"GOAL","reason":"crowd erupts"}')
    assert d is not None
    assert d["isHighlight"] is True
    assert d["reasoning"] == ""
    assert d["verdict"] is None
    assert d["evidenceAttested"] == []


def test_parse_decision_malformed_verdict_coerces_tristate():
    # Non-bool criteria values coerce to None (unverifiable); garbage verdict
    # block -> None. The verdict never raises and never 500s the endpoint.
    d = parse_decision(
        '{"isHighlight":true,"score":90,"verdict":{"criteria":'
        '{"ballInNet":"yes","ballCrossedLineBetweenPosts":1,"junk":"x"}}}'
    )
    assert d["verdict"] is not None
    assert d["verdict"]["criteria"]["ballInNet"] is None
    assert d["verdict"]["criteria"]["ballCrossedLineBetweenPosts"] is None
    # a malformed (non-dict) verdict degrades to None, not a crash
    assert parse_decision('{"isHighlight":true,"score":90,"verdict":"junk"}')["verdict"] is None


def test_parse_decision_evidence_attested_coerces():
    # evidenceAttested is coerced to a list of non-empty strings; garbage -> [].
    d = parse_decision(
        '{"isHighlight":false,"score":5,"evidenceAttested":["a","  ",42,null,"b"]}'
    )
    assert d["evidenceAttested"] == ["a", "b"]
    # a bare-string evidenceAttested is NOT garbage: it becomes a single-item list
    assert parse_decision('{"isHighlight":false,"score":5,"evidenceAttested":"junk"}')["evidenceAttested"] == ["junk"]
    assert parse_decision('{"isHighlight":false,"score":5,"evidenceAttested":"saw the keeper save it"}')["evidenceAttested"] == ["saw the keeper save it"]


def test_decide_with_gemma_returns_i1_rationale(monkeypatch):
    # The I1 verdict/rationale flows through decide_with_gemma() to the caller
    # (not just parse_decision), and audioContext is still reported.
    reply = (
        '{"isHighlight":false,"score":15,"eventType":"GOAL","reason":"off-target",'
        '"reasoning":"ball goes over the bar, no ball in net",'
        '"verdict":{"hypothesis":"GOAL","independentlyObserved":"ball over the bar",'
        '"criteria":{"ballCrossedLineBetweenPosts":false,"ballInNet":false,'
        '"scoreboardChanged":null,"crowdErupted":false},'
        '"contradictedBy":"ball went over the bar"},'
        '"evidenceAttested":["ball crossed above the crossbar"]}'
    )
    mock = MockLlama(reply)
    try:
        d = decide_with_gemma(
            "GOAL",
            {"trackCount": 2, "maxVelocity": 0.5, "ocrHits": 0},
            game_hint="soccer",
            url=f"http://127.0.0.1:{mock.port}",
        )
    finally:
        mock.stop()
    assert d["source"] == "gemma"
    assert d["isHighlight"] is False
    assert d["verdict"]["hypothesis"] == "GOAL"
    assert d["verdict"]["contradictedBy"] == "ball went over the bar"
    assert d["evidenceAttested"] == ["ball crossed above the crossbar"]
    # the de-anchored prompt actually reached the model request
    prompt = [c["text"] for c in mock.requests[0]["messages"][0]["content"] if c.get("type") == "text"][0]
    assert "HYPOTHESIS to test" in prompt
    assert "ballCrossedLineBetweenPosts" in prompt


# --- ADAAAA-6358 (I1): response contract ------------------------------------


def test_highlight_response_model_includes_rationale(monkeypatch):
    # The /highlight response model now carries the reviewer-facing rationale
    # (reasoning / verdict / evidenceAttested) in addition to the verdict.
    from app import app as decide_app
    from fastapi.testclient import TestClient

    monkeypatch.setenv("DECIDE_MODE", "rule")  # rule path: no model needed
    c = TestClient(decide_app)
    r = c.post(
        "/app/highlight",
        json={
            "sessionId": "s1",
            "eventType": "GOAL",
            "timestamp": 1.0,
            "gameHint": "soccer",
            "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0},
        },
    )
    assert r.status_code == 200
    body = r.json()
    # core verdict still present
    assert "isHighlight" in body
    # I1 rationale fields are on the wire (empty on the rule path)
    assert body.get("reasoning", None) is not None or "reasoning" in body
    assert "verdict" in body
    assert isinstance(body["evidenceAttested"], list)
    # score is bounded [0,100] by the model (a >100 rule score must not 500)
    assert 0.0 <= body["score"] <= 100.0


def test_highlight_rule_path_preserves_classifiers_through_response_model(monkeypatch):
    # ADAAAA-6358: /highlight now declares response_model=HighlightDecision
    # (extra=ignore). The rule path returns eventClass/corroborated which predate
    # I1; the model must carry them so the response contract stays backward
    # compatible and they are NOT silently dropped.
    from app import app as decide_app
    from fastapi.testclient import TestClient

    monkeypatch.setenv("DECIDE_MODE", "rule")  # rule path: no model needed
    c = TestClient(decide_app)
    r = c.post(
        "/app/highlight",
        json={
            "sessionId": "s2",
            "eventType": "GOAL",
            "timestamp": 2.0,
            "gameHint": "soccer",
            "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 1,
                         "reaction": {"crowdEnergy": 0.9, "humansInMotion": 2}},
        },
    )
    assert r.status_code == 200
    body = r.json()
    # pre-I1 rule-path classifiers still surface through the response model
    assert body.get("eventClass") == "high"
    assert body.get("corroborated") is True
    assert body.get("source") == "rule"


# --- Decide-leg I2 (ADAAAA-6359): goal-line / ball-outcome HARD GATE ---------


def test_apply_ball_outcome_gate_non_goal_rejects():
    from app.gemma import apply_ball_outcome_gate

    for outcome in ["off_target", "blocked", "no_shot", "cross"]:
        ok, reason = apply_ball_outcome_gate({"ballOutcome": outcome})
        assert ok is False, f"{outcome} must gate"
        assert reason is not None and outcome in reason
    ok, reason = apply_ball_outcome_gate({"ballOutcome": "goal"})
    assert ok is True and reason is None
    ok, reason = apply_ball_outcome_gate({})
    assert ok is True and reason is None
    ok, reason = apply_ball_outcome_gate(None)
    assert ok is True and reason is None


def test_build_prompt_renders_ball_outcome_gate():
    p = build_prompt("GOAL", {"ballOutcome": "off_target", "goalCrossed": True}, "soccer")
    assert "goal-line ground-truth" in p
    assert "ballOutcome=off_target" in p
    assert "HARD GATE" in p
    # Absent signal never gates / never claims a measurement.
    p2 = build_prompt("GOAL", {"trackCount": 1}, "soccer")
    assert "not available" in p2
    assert "HARD GATE" in p2  # the gate instruction is always present


def test_highlight_rule_mode_hard_gate_rejects_non_goal():
    from app import create_app as decide_create_app

    decide_app = decide_create_app()
    import os

    os.environ["DECIDE_MODE"] = "rule"
    c = TestClient(decide_app)
    r = c.post(
        "/app/highlight",
        json={
            "sessionId": "s3",
            "eventType": "GOAL",
            "timestamp": 3.0,
            "gameHint": "soccer",
            "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0,
                         "ballOutcome": "off_target", "goalCrossed": True,
                         "reaction": {"crowdEnergy": 0.9}},
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["isHighlight"] is False
    assert "off_target" in body["reason"]


def test_highlight_rule_mode_goal_passes_gate():
    from app import create_app as decide_create_app

    decide_app = decide_create_app()
    import os

    os.environ["DECIDE_MODE"] = "rule"
    c = TestClient(decide_app)
    r = c.post(
        "/app/highlight",
        json={
            "sessionId": "s4",
            "eventType": "GOAL",
            "timestamp": 4.0,
            "gameHint": "soccer",
            "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0,
                         "ballOutcome": "goal", "goalCrossed": True,
                         "reaction": {"crowdEnergy": 0.9, "humansInMotion": 2}},
        },
    )
    assert r.status_code == 200
    body = r.json()
    # ballOutcome=goal does not force reject; the rule decides on evidence.
    assert isinstance(body["isHighlight"], bool)

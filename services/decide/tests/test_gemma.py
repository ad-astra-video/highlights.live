import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from fastapi.testclient import TestClient

from app.gemma import build_prompt, decide_with_gemma, parse_decision


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


def test_decide_with_gemma_orders_frames_text_audio():
    # Gemma 4 12B modality-order guidance: all images (frame sequence + crops)
    # BEFORE the text prompt, audio AFTER the text.
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
    # 2 frames + 1 crop (all image_url) -> text -> audio_url
    assert types == ["image_url", "image_url", "image_url", "text", "audio_url"]
    # every image before the text; audio strictly last
    first_text = types.index("text")
    assert all(t == "image_url" for t in types[:first_text])
    assert types[-1] == "audio_url"
    # audio payload is a data:wav URI
    assert content[-1]["audio_url"]["url"].startswith("data:audio/wav;base64,W")


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

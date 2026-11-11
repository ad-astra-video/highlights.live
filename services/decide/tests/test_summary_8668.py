"""ADAAAA-8668 — the decide service's text-only `/summary` route.

The body-copy prompt is composed by the SERVER (a snapshot-tested contract in
`packages/events/src/highlight-summary.ts`), and the reply is gated there. This
service therefore has exactly one job on this route: run the text through the
model and hand it back. These tests pin the three things that must hold:

* gemma mode + a non-empty prompt -> the model's sentence(s), verbatim;
* rule mode / empty prompt / a failing model -> `summary: null`, i.e. the caller
  DROPS the row and the card serves on its headline. There is no deterministic
  fallback copy: any placeholder would be exactly what the spec forbids;
* the call is text-only — no frames, no audio, no decide contract.

`summary_with_gemma` is monkeypatched, so these tests spend no GPU and make no
network call.
"""
import app as app_pkg
import app.summary_copy as S


def _client():
    from fastapi.testclient import TestClient

    return TestClient(app_pkg.app)


def test_gemma_mode_returns_the_model_copy(monkeypatch):
    seen = {}

    def fake_summary(prompt, url=None, timeout_s=2.5, max_words=70):
        seen["prompt"] = prompt
        seen["max_words"] = max_words
        return "The equaliser levels it at 2-2 in the second half. A drive beats the keeper."

    monkeypatch.setenv("DECIDE_MODE", "gemma")
    monkeypatch.setattr(S, "summary_with_gemma", fake_summary)
    monkeypatch.setattr(app_pkg, "summary_with_gemma", fake_summary)

    r = _client().post("/summary", json={"prompt": "BODY COPY PROMPT", "rail": "live", "maxWords": 70})
    assert r.status_code == 200
    body = r.json()
    assert body["summary"].startswith("The equaliser levels it at 2-2")
    assert seen["prompt"] == "BODY COPY PROMPT"
    assert seen["max_words"] == 70


def test_rule_mode_returns_no_copy_so_the_caller_drops(monkeypatch):
    monkeypatch.setenv("DECIDE_MODE", "rule")
    r = _client().post("/summary", json={"prompt": "BODY COPY PROMPT", "rail": "vod", "maxWords": 120})
    assert r.status_code == 200
    # Never a placeholder: absent copy means "drop and serve the headline".
    assert r.json()["summary"] is None


def test_empty_prompt_never_calls_the_model(monkeypatch):
    called = {"n": 0}

    def fake_summary(*args, **kwargs):
        called["n"] += 1
        return "should not run"

    monkeypatch.setenv("DECIDE_MODE", "gemma")
    monkeypatch.setattr(app_pkg, "summary_with_gemma", fake_summary)
    r = _client().post("/summary", json={"prompt": "   ", "rail": "live", "maxWords": 70})
    assert r.json()["summary"] is None
    assert called["n"] == 0


def test_model_failure_returns_null(monkeypatch):
    monkeypatch.setenv("DECIDE_MODE", "gemma")
    monkeypatch.setattr(app_pkg, "summary_with_gemma", lambda *a, **k: None)
    r = _client().post("/summary", json={"prompt": "BODY COPY PROMPT", "rail": "live", "maxWords": 70})
    assert r.json()["summary"] is None


def test_summary_with_gemma_sends_one_text_only_chat_call(monkeypatch):
    """The helper posts ONE chat completion with only the prompt — no images, no
    audio, no tool block — and returns the raw sentence(s)."""
    captured = {}

    class FakeResp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": "  A sentence. Another sentence.  "}}]}

    def fake_post(url, json=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        captured["timeout"] = timeout
        return FakeResp()

    import httpx

    monkeypatch.setattr(httpx, "post", fake_post)
    out = S.summary_with_gemma(prompt="PROMPT", url="http://gemma.test", timeout_s=2.5, max_words=70)

    assert out == "A sentence. Another sentence."
    assert captured["url"] == "http://gemma.test/v1/chat/completions"
    payload = captured["json"]
    assert payload["messages"] == [{"role": "user", "content": "PROMPT"}]
    assert payload["stream"] is False
    # ~2 tokens per word plus headroom, and never a longer-than-band reply budget.
    assert payload["max_tokens"] >= 140
    assert set(payload.keys()) == {"messages", "temperature", "reasoning_effort", "chat_template_kwargs", "max_tokens", "stream"}

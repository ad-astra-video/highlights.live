"""ADAAAA-6739 G2 — decide -> media-server broker routing.

Verifies that the decide watcher's windowed-tool client and control sender are
routed through the MEDIA SERVER broker (the natural broker that provisions /
fronts the active perceive session) rather than talking to perceive directly.
The broker echoes the trace to the webapp/server, so decide only consumes the
tool result envelope / control ack.
"""
import httpx

from app import _make_control_sender, _make_perceive_client


class _FakeResp:
    def __init__(self, payload, status=200):
        self._p = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("http %s" % self.status_code, request=None, response=None)  # type: ignore

    def json(self):
        return self._p


def _patch_post(monkeypatch, responses):
    calls = []

    def _resp_for(item):
        # Accept a plain payload (wrapped here) or a pre-built _FakeResp (used
        # to model a broker error / non-200 response).
        if isinstance(item, _FakeResp):
            return item
        return _FakeResp(item)

    def fake_post(url, **kw):
        calls.append((url, kw))
        return _resp_for(responses.pop(0) if responses else {"ok": True, "result": {}})

    monkeypatch.setattr("httpx.post", fake_post)
    return calls


def test_perceive_client_routes_through_media_broker(monkeypatch):
    monkeypatch.setenv("MEDIA_BROKER_URL", "http://media:9000")
    monkeypatch.delenv("PERCEIVE_URL", raising=False)
    envelope = {"tool": "get_audio_levels", "window": {"start": 0, "end": 5}, "data": []}
    calls = _patch_post(monkeypatch, [{"ok": True, "result": envelope, "trace": {}}])

    c = _make_perceive_client("sess-X")
    res = c("get_audio_levels", 0, 5, 8)

    # Decide consumes the tool result (the wrapper unwraps the broker envelope).
    assert res["tool"] == "get_audio_levels"
    url, kw = calls[0]
    assert url == "http://media:9000/sessions/sess-X/analysis/query"
    assert kw["json"] == {"tool": "get_audio_levels", "start": 0, "end": 5, "maxPoints": 8}
    assert kw["headers"]["X-Session-Id"] == "sess-X"


def test_perceive_client_broker_error_is_visible_as_none(monkeypatch):
    monkeypatch.setenv("MEDIA_BROKER_URL", "http://media:9000")
    monkeypatch.delenv("PERCEIVE_URL", raising=False)
    # Broker surfaces a visible error for a session that no longer exists (404).
    calls = _patch_post(monkeypatch, [])

    def failing_post(url, **kw):
        return _FakeResp({"error": "no such session"}, status=404)

    monkeypatch.setattr("httpx.post", failing_post)
    c = _make_perceive_client("sess-gone")
    # Never fatal to a tick: an unavailable session degrades to None, not a raise.
    assert c("get_audio_levels", 0, 5, 8) is None


def test_perceive_client_falls_back_to_direct_perceive(monkeypatch):
    monkeypatch.delenv("MEDIA_BROKER_URL", raising=False)
    monkeypatch.setenv("PERCEIVE_URL", "http://perceive:8000")
    envelope = {"tool": "get_captioning", "window": {"start": 0, "end": 5}, "data": [{"ts": 1.0, "text": "goal"}]}
    calls = _patch_post(monkeypatch, [envelope])

    c = _make_perceive_client("sess-X")
    res = c("get_captioning", 0, 5, 8)
    assert res["tool"] == "get_captioning"
    url, kw = calls[0]
    assert url == "http://perceive:8000/analysis/get_captioning"
    assert kw["params"] == {"start": 0, "end": 5, "maxPoints": 8}


def test_control_sender_routes_through_media_broker(monkeypatch):
    monkeypatch.setenv("MEDIA_BROKER_URL", "http://media:9000")
    monkeypatch.delenv("PERCEIVE_URL", raising=False)
    ack = {"type": "ack", "ok": True, "cmd": "track"}
    calls = _patch_post(monkeypatch, [{"ok": True, "result": ack, "trace": {}}])

    send = _make_control_sender("sess-X")
    res = send({"cmd": "track", "label": "new-player"})
    assert res["cmd"] == "track"
    url, kw = calls[0]
    assert url == "http://media:9000/sessions/sess-X/analysis/control"
    assert kw["json"] == {"instruction": {"cmd": "track", "label": "new-player"}}


def test_perceive_client_falls_back_to_direct_when_broker_has_no_session(monkeypatch):
    """ADAAAA-6785: a VOD perceive session is NOT registered with the media
    broker, so the broker answers 404 \"no such session\". The client must fall
    back to a direct PERCEIVE_URL query instead of returning None (which would
    persist a request-only trace)."""
    monkeypatch.setenv("MEDIA_BROKER_URL", "http://media:9000")
    monkeypatch.setenv("PERCEIVE_URL", "http://perceive:8000")
    envelope = {"tool": "get_captioning", "window": {"start": 0, "end": 5}, "data": [{"ts": 1.0, "text": "goal"}]}
    calls = _patch_post(
        monkeypatch,
        [_FakeResp({"error": "no such session"}, status=404), envelope],
    )

    c = _make_perceive_client("sess-VOD")
    res = c("get_captioning", 0, 5, 8)

    assert res["tool"] == "get_captioning"
    assert len(calls) == 2
    assert calls[0][0] == "http://media:9000/sessions/sess-VOD/analysis/query"
    assert calls[1][0] == "http://perceive:8000/analysis/get_captioning"
    assert calls[1][1]["headers"]["X-Session-Id"] == "sess-VOD"
    assert calls[1][1]["params"] == {"start": 0, "end": 5, "maxPoints": 8}


def test_control_sender_falls_back_to_direct_when_broker_has_no_session(monkeypatch):
    """ADAAAA-6785: the control sender falls back to a direct PERCEIVE_URL
    control when the broker has no session registered (VOD path)."""
    monkeypatch.setenv("MEDIA_BROKER_URL", "http://media:9000")
    monkeypatch.setenv("PERCEIVE_URL", "http://perceive:8000")
    ack = {"type": "ack", "ok": True, "cmd": "track"}
    calls = _patch_post(
        monkeypatch,
        [_FakeResp({"error": "no such session"}, status=404), ack],
    )

    send = _make_control_sender("sess-VOD")
    res = send({"cmd": "track", "label": "new-player"})

    assert res["cmd"] == "track"
    assert len(calls) == 2
    assert calls[0][0] == "http://media:9000/sessions/sess-VOD/analysis/control"
    assert calls[1][0] == "http://perceive:8000/control"
    assert calls[1][1]["json"] == {"cmd": "track", "label": "new-player"}


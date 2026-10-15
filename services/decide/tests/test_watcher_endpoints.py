"""End-to-end watcher-mode HTTP endpoints (ADAAAA-6738 G1c)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import create_app


def _fresh():
    return TestClient(create_app())


def test_watcher_start_state_ingest_step_flow():
    c = _fresh()
    r = c.post("/watcher/start", json={"sessionId": "s1", "streamId": "st1"})
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert c.get("/watcher/state").json()["active"] is True

    # ingest a GOAL caption frame inside the first window
    for i in range(1, 31):
        c.post("/watcher/ingest", json={"ts": round(i / 3.0, 3), "seq": i, "caption": "GOAL! crowd"})
    r = c.post("/watcher/step", json={"tickTs": 10.0})
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["event"] == "GOAL"
    assert 0 < body["summary"]["frameCount"] <= 30  # <=30-frame chunk gate
    assert len(body["context"]) == 1
    # tools called all four (default decide policy)
    assert body["summary"]["toolsCalled"] == ["get_audio_levels", "get_tracked_players", "detect_objects", "get_captioning"]


def test_watcher_step_requires_session():
    c = _fresh()
    r = c.post("/watcher/step", json={"tickTs": 3.0})
    assert r.status_code == 409
    r = c.post("/watcher/ingest", json={"ts": 1.0, "seq": 1})
    assert r.status_code == 409


def test_watcher_summaries_empty_then_populated():
    c = _fresh()
    assert c.get("/watcher/summaries").json() == {"summaries": []}
    c.post("/watcher/start", json={"sessionId": "s", "streamId": "st"})
    c.post("/watcher/step", json={"tickTs": 3.0})
    assert len(c.get("/watcher/summaries").json()["summaries"]) == 1


def test_trace_sink_presents_service_token_header(monkeypatch):
    """ADAAAA-6748 G1b-2: the decide VOD watcher trace sink must present the
    TRACE_SERVICE_TOKEN the server hands it on /watcher/start, so the server's
    user-Bearer-only POST /jobs/:id/analysis/trace does not 401 and drop the
    trace. Without a token the sink stays unauthenticated (live path uses the
    media-broker -> webapp relay)."""
    import httpx
    from app import _make_trace_sink

    captured = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        class R:
            status_code = 200
        return R()

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setenv("TRACE_BASE", "http://server:3000")

    sink = _make_trace_sink("job-1", "svc-secret-123")
    assert sink is not None
    sink({"type": "watcher_tool_call", "tool": "get_captioning", "result": None, "resultOk": False})
    assert captured["url"] == "http://server:3000/jobs/job-1/analysis/trace"
    assert captured["headers"] == {"Authorization": "Bearer svc-secret-123"}
    assert captured["json"] == {"trace": {"type": "watcher_tool_call", "tool": "get_captioning", "result": None, "resultOk": False}}

    # No token => no Authorization header.
    sink0 = _make_trace_sink("job-1", "")
    sink0({"type": "watcher_tool_call", "tool": "detect_objects"})
    assert captured["headers"] in (None, {})

    # No TRACE_BASE/no job => no sink.
    monkeypatch.delenv("TRACE_BASE")
    assert _make_trace_sink("", "") is None

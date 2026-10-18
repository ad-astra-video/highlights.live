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

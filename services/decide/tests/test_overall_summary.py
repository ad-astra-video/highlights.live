"""Tests for the increment-1 /summary HTTP route (ADAAAA-7237).

The decide runner exposes the text-only end-of-video overall-summary generator
over HTTP (`POST /app/summary`). In rule/stub mode it returns a deterministic
overall summary that names every point of interest with its event type +
timestamp and walks the chronological time log, so a completed job always gets
a whole-video overview even when the model is down. The gemma path is covered
by the `summary_with_gemma` unit behaviour (test_gemma) — this file locks the
HTTP contract + fallback composition.
"""

from fastapi.testclient import TestClient

from app import create_app


def _client():
    return TestClient(create_app())


def test_summary_route_names_points_of_interest_and_log():
    c = _client()
    r = c.post(
        "/summary",
        json={
            "gameHint": "soccer",
            "pointsOfInterest": [
                {"eventType": "GOAL", "timestamp": 120, "reason": "a goal in the box"},
                {"eventType": "NEAR_MISS", "timestamp": 300, "reason": "hit the post"},
            ],
            "timeLog": [{"seq": 1, "ts": "t", "text": "early pressure"}, {"seq": 2, "ts": "t", "text": "late goal"}],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert "overallSummary" in body
    assert isinstance(body["overallSummary"], str)
    assert body["overallSummary"]
    assert "soccer" in body["overallSummary"]
    assert "GOAL at 120s" in body["overallSummary"]
    assert "NEAR_MISS at 300s" in body["overallSummary"]
    assert "early pressure" in body["overallSummary"]


def test_summary_route_empty_payload_falls_back():
    c = _client()
    r = c.post("/summary", json={})
    assert r.status_code == 200
    assert r.json()["overallSummary"] == "Video overview\nNo confirmed highlights."


def test_summary_route_ignores_unknown_fields():
    c = _client()
    r = c.post("/summary", json={"gameHint": "basketball", "bogus": 1})
    assert r.status_code == 200
    assert "basketball" in r.json()["overallSummary"]

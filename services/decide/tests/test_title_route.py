"""Tests for the increment-1 /title HTTP route (ADAAAA-6798 Inc 1).

The decide runner exposes the text-only job-title generator over HTTP
(`POST /app/title`). In rule/stub mode (DECIDE_MODE unset -> "rule") it returns
a deterministic title composed from the summary, so a completed job always gets
a sensible title even when the model is down. The gemma path is covered by the
`title_with_gemma` unit-level behaviour (test_gemma) — this file locks the HTTP
contract + fallback composition.
"""

from fastapi.testclient import TestClient

from app import create_app


def _client():
    return TestClient(create_app())


def test_title_route_returns_a_short_title_from_the_summary():
    c = _client()
    r = c.post(
        "/title",
        json={"gameHint": "soccer", "eventTypes": ["GOAL", "GOAL"], "reasons": ["a goal"], "highlightCount": 2},
    )
    assert r.status_code == 200
    body = r.json()
    assert "title" in body
    assert isinstance(body["title"], str)
    assert body["title"]  # non-empty
    assert "soccer" in body["title"]
    assert "2 highlights" in body["title"]


def test_title_route_empty_request_falls_back():
    c = _client()
    r = c.post("/title", json={})
    assert r.status_code == 200
    assert r.json()["title"] == "Highlight reel"


def test_title_route_ignores_unknown_fields():
    c = _client()
    r = c.post("/title", json={"gameHint": "basketball", "bogus": 1})
    assert r.status_code == 200
    assert r.json()["title"] == "basketball"

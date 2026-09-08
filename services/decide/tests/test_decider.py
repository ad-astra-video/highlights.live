from fastapi.testclient import TestClient

from app import app
from app.decider import decide

client = TestClient(app)


def test_high_value_event_only_scores_50_low():
    d = decide("KILL", track_count=0, max_velocity=0.0)
    assert d.score == 50.0
    assert d.is_highlight is False


def test_high_value_plus_track_and_motion_clears_threshold():
    d = decide("KILL", track_count=2, max_velocity=0.4, ocr_hits=0)
    # 50 + 20 + 16 = 86 >= 60
    assert d.is_highlight is True
    assert d.score == 86.0


def test_fast_motion_alone_not_enough():
    d = decide("MOVE", track_count=0, max_velocity=0.5)
    assert d.is_highlight is False


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_highlight_endpoint():
    r = client.post(
        "/app/highlight",
        json={
            "sessionId": "sess-1",
            "eventType": "KILL",
            "timestamp": 12.0,
            "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0},
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["isHighlight"] is True
    assert body["score"] == 86.0
    assert body["eventType"] == "KILL"

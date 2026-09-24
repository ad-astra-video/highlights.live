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


def test_highlight_endpoint_accepts_reaction_evidence():
    # INC-4 / ADAAAA-4328: the decide endpoint must accept the reaction evidence
    # block without 422 (pydantic parses it). Rule mode ignores reaction for the
    # score but must not reject the payload — the strict-JSON contract holds.
    r = client.post(
        "/app/highlight",
        json={
            "sessionId": "sess-1",
            "eventType": "GOAL",
            "timestamp": 12.0,
            "evidence": {
                "trackCount": 2,
                "maxVelocity": 0.4,
                "ocrHits": 0,
                "reaction": {
                    "crowdEnergy": 0.93,
                    "audioKind": "swell",
                    "humansInMotion": 5,
                    "ballSpeedMps": 21.4,
                    "ballPossessionId": "t2",
                },
            },
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert "isHighlight" in body
    assert "reason" in body

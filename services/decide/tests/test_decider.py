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


def test_decide_accepts_out_of_old_bounds_evidence_no_422():
    # ADAAAA-4736/5231: real media observes trackCount > 2 and crowdEnergy > 1.0.
    # The schema was relaxed so these are accepted (200), never 422-rejected.
    for track_count in (3, 5, 8):
        r = client.post(
            "/app/highlight",
            json={
                "sessionId": "sess-1",
                "eventType": "KILL",
                "timestamp": 12.0,
                "evidence": {
                    "trackCount": track_count,
                    "maxVelocity": 0.4,
                    "ocrHits": 0,
                    "reaction": {
                        "crowdEnergy": 1.5,
                        "audioKind": "swell",
                        "humansInMotion": track_count,
                        "ballSpeedMps": 18.0,
                        "ballPossessionId": "t1",
                    },
                },
            },
        )
        assert r.status_code == 200, f"track_count={track_count} -> {r.status_code} {r.text}"
        assert "isHighlight" in r.json()
    # crowdEnergy up to 2.0 accepted (old bound was 1.0).
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
                "reaction": {"crowdEnergy": 2.0, "audioKind": "burst", "humansInMotion": 2},
            },
        },
    )
    assert r.status_code == 200
    assert "isHighlight" in r.json()

# --- ADAAAA-5778 notable-only discernment -----------------------------
from app.decider import DEFAULT_NOTABILITY_MIN, decide, apply_gate, has_corroboration, event_class


def test_bare_scene_change_rejected():
    # A scene/audio change with NO notable content: no track, no motion, no OCR,
    # no reaction -> must not surface (acceptance criterion 1).
    d = decide("SCENE", track_count=0, max_velocity=0.0, ocr_hits=0)
    assert d.is_highlight is False
    assert d.corroborated is False


def test_bare_audio_gate_rejected_even_with_tracks_absent_reaction():
    d = decide("AUDIO", track_count=0, max_velocity=0.0, reaction={"crowdEnergy": 0.0, "humansInMotion": 0, "ballSpeedMps": 0.0})
    assert d.is_highlight is False


def test_high_value_with_corroboration_accepted():
    d = decide("GOAL", track_count=2, max_velocity=0.4, reaction={"crowdEnergy": 0.9, "humansInMotion": 3})
    assert d.is_highlight is True
    assert d.event_class == "high"
    assert d.corroborated is True


def test_high_value_without_corroboration_rejected():
    # KILL alone (no track/motion/ocr/reaction) is not a highlight.
    d = decide("KILL", track_count=0, max_velocity=0.0)
    assert d.is_highlight is False
    assert d.score == 50.0


def test_ordinary_with_low_notability_rejected():
    # Off-target-style ordinary shot: motion + a track, but not high-value
    # and notability (30) under the bar -> rejected.
    d = decide("SHOT", track_count=1, max_velocity=0.5)
    assert d.is_highlight is False
    assert d.score == 30.0


def test_ordinary_with_high_notability_and_corroboration_accepted():
    # Sweep override: an ordinary (non-tagged) moment with strong notability
    # + corroboration can still clear a higher bar (recall valve).
    d = decide("SHOT", track_count=2, max_velocity=0.5, ocr_hits=2, min_notability=50)
    assert d.score == 50.0  # 0 high-value + 20 tracks + 20 motion + 10 ocr
    assert d.event_class == "ordinary"
    assert d.is_highlight is True  # 50 >= sweep bar 50, corroborated


def test_default_notability_bar_is_data_landed():
    # The landed default sits above the max non-highlight phase score (~30)
    # and below strong true moments; it must be a real, data-supported value.
    assert DEFAULT_NOTABILITY_MIN == 60.0


def test_apply_gate_only_rejects_never_accepts():
    # The gate can only turn a 'yes' into a 'no' (no added inference).
    ok_nocorr, _ = apply_gate(score=95, event_type="GOAL", track_count=0, max_velocity=0.0)
    assert ok_nocorr is False
    ok_hi, _ = apply_gate(score=95, event_type="GOAL", track_count=2, max_velocity=0.4)
    assert ok_hi is True


def test_gemma_path_rejects_bare_trigger_on_yes_verdict(monkeypatch):
    # Gemma says 'yes' (score 95) but the candidate is a bare audio-gate
    # trigger with no corroboration -> the notable-only gate forces 'no'
    # without any extra inference.
    from app import gemma as gemma_mod

    monkeypatch.setenv("DECIDE_MODE", "gemma")
    monkeypatch.setattr(gemma_mod, "ask", lambda *a, **k: {"isHighlight": True, "score": 95.0, "eventType": "AUDIO", "reason": "loud", "source": "gemma"})
    r = client.post(
        "/app/highlight",
        json={
            "sessionId": "sess-bare",
            "eventType": "AUDIO",
            "timestamp": 1.0,
            "evidence": {"trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0},
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["isHighlight"] is False
    assert "notable-only bar" in body["reason"]

"""ADAAAA-6525: debug-gated per-candidate logging in decide.

A decision summary is logged at INFO for every /highlight (and /plan) call;
per-candidate detail (+ full gemma invocation/result) appears only at DEBUG.
These tests drive the rule-mode /highlight handler and assert on caplog.
"""

import logging

from fastapi.testclient import TestClient

from app import app

client = TestClient(app)


def _req(event_type="GOAL", track=1, vel=0.3):
    return {
        "sessionId": "sess-dec",
        "eventType": event_type,
        "timestamp": 1.0,
        "gameHint": "soccer",
        "evidence": {
            "trackCount": track,
            "maxVelocity": vel,
            "ocrHits": 0,
            "scoreBoardChanged": True,
        },
    }


def test_highlight_logs_decision_summary_at_info(caplog):
    """The default INFO level logs a per-request decision summary."""
    with caplog.at_level(logging.INFO, logger="highlights.decide"):
        r = client.post("/app/highlight", json=_req())
        assert r.status_code == 200
    assert any("highlight decision" in rec.getMessage() for rec in caplog.records), (
        "a decision summary should be logged at INFO"
    )


def test_highlight_identified_logged_at_info(caplog):
    """A GOAL candidate that passes clears as a highlight; 'highlight identified'
    is a salient default (INFO) event per ADAAAA-6524 board feedback.
    The candidate is attested (scoreBoardChanged) so the ADAAAA-6610 gate lets it
    through."""
    with caplog.at_level(logging.INFO, logger="highlights.decide"):
        client.post("/app/highlight", json=_req())
    assert any("highlight identified" in rec.getMessage() for rec in caplog.records), (
        "a highlight identification should be logged at INFO"
    )
    assert any("highlight decision" in rec.getMessage() for rec in caplog.records)


def test_highlight_per_candidate_detail_suppressed_at_default(caplog):
    """At default INFO, per-candidate frame/evidence detail is suppressed."""
    with caplog.at_level(logging.INFO, logger="highlights.decide"):
        client.post("/app/highlight", json=_req())
    assert not any("highlight context" in rec.getMessage() for rec in caplog.records), (
        "per-candidate detail must be suppressed at default level"
    )


def test_highlight_per_candidate_detail_emitted_at_debug(caplog):
    """At DEBUG, per-candidate detail is emitted."""
    with caplog.at_level(logging.DEBUG, logger="highlights.decide"):
        client.post("/app/highlight", json=_req())
    assert any("highlight context" in rec.getMessage() for rec in caplog.records), (
        "per-candidate detail should appear at DEBUG"
    )

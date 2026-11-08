# ADAAAA-8344 AC1 (decide-internal split): the decide service must stamp the five
# stage timings on the audit row it returns to the server, alongside the existing
# `elapsedMs` / `asrLatencyS` — and the compact descriptor must still carry no
# base64 media bytes.
#
# Why: the ticket's securing-leg attribution is joined against
# `decide_audit.timings`, so a decide-side stage that never reaches the descriptor
# is invisible in the report (the ADAAAA-8056 lesson: stamping the response
# descriptor later left the stored trail bare).
from test_gemma import MockLlama

from app.gemma import ask


def test_ask_stamps_the_decide_internal_stage_timings():
    mock = MockLlama('{"isHighlight":false,"score":5,"eventType":"NONE","reason":"quiet"}')
    try:
        out = ask(
            f"http://127.0.0.1:{mock.port}",
            "NONE",
            {"trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0},
            frames=[{"role": "full", "base64": "QUJD"}],
            audit_ctx={"sessionId": "job-t", "jobId": "job-t", "groupKey": "g1"},
            request_parse_ms=7.5,
        )
    finally:
        mock.stop()
    assert out is not None
    timings = out["audit"]["timings"]
    # The pre-existing fields stay untouched.
    assert timings["elapsedMs"] >= 0
    assert timings["asrLatencyS"] == 0
    # The five new stages ride the same object, all finite and non-negative.
    for key in ("requestParseMs", "promptBuildMs", "vllmMs", "parseReplyMs", "auditWriteMs"):
        assert key in timings, key
        assert timings[key] >= 0, key
    assert timings["requestParseMs"] == 7.5
    # The model round trip is the dominant decision-internal cost on a mock that
    # answers instantly: it must still be measured (never left at 0 by omission).
    assert timings["vllmMs"] > 0
    # Compact descriptor: no base64 media bytes anywhere on the audit block.
    blob = str(out["audit"])
    assert "QUJD" not in blob
    assert len(blob) < 200_000


def test_request_parse_ms_is_optional():
    # A direct in-process call (no HTTP layer) leaves the field None rather than
    # inventing a request-parse number.
    mock = MockLlama('{"isHighlight":false,"score":5,"eventType":"NONE","reason":"quiet"}')
    try:
        out = ask(
            f"http://127.0.0.1:{mock.port}",
            "NONE",
            {"trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0},
            audit_ctx={"sessionId": "job-t2", "jobId": "job-t2", "groupKey": "g2"},
        )
    finally:
        mock.stop()
    assert out is not None
    assert out["audit"]["timings"]["requestParseMs"] is None

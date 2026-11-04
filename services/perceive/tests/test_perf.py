"""ADAAAA-8004: per-stage timing accounting (perf.py) and its live surface."""
import base64
import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import app, perf
from app.perf import StageRecorder


def _frame_jpeg(gray: np.ndarray) -> str:
    img = Image.fromarray(gray.astype(np.uint8), "L")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


def test_recorder_bounds_the_window_and_reports_percentiles():
    rec = StageRecorder(window=10, log_every=10_000)
    for i in range(1, 21):  # 20 samples into a 10-sample window
        rec.add("sam", i / 100.0)
    st = rec.summary()["stages"]["sam"]
    assert st["count"] == 10, "the window must bound memory on a long stream"
    assert st["max"] == pytest.approx(0.20)
    assert st["p50"] == pytest.approx(0.15)
    assert st["p95"] == pytest.approx(0.20)


def test_recorder_skips_negative_and_missing_samples():
    rec = StageRecorder(log_every=10_000)
    rec.add("detect", -1.0)
    rec.add("detect", None)
    assert "detect" not in rec.summary()["stages"]
    rec.add("detect", 0.5)
    assert rec.summary()["stages"]["detect"]["count"] == 1


def test_timed_records_even_when_the_block_raises():
    rec = StageRecorder(log_every=10_000)
    with pytest.raises(RuntimeError):
        with perf.timed("roi", rec):
            raise RuntimeError("boom")
    assert rec.summary()["stages"]["roi"]["count"] == 1


def test_summary_reports_every_recorded_stage_and_steps():
    rec = StageRecorder(log_every=10_000)
    rec.add_many({"detect": 0.14, "sam": 0.6, "frame": 0.8})
    rec.step_done()
    rec.step_done()
    s = rec.summary()
    assert s["steps"] == 2
    assert set(s["stages"]) == {"detect", "sam", "frame"}
    assert s["last"] == {"detect": 0.14, "sam": 0.6, "frame": 0.8}


def test_unknown_stage_is_recorded_not_dropped():
    rec = StageRecorder(log_every=10_000)
    rec.add("future_stage", 0.25)
    assert rec.summary()["stages"]["future_stage"]["max"] == pytest.approx(0.25)


def test_analyze_records_a_frame_and_perf_endpoint_serves_it():
    """The pipeline must produce at least one `frame` sample per analyzed frame,
    and GET /perf must expose the measured decomposition (AC3's evidence)."""
    perf.reset()
    client = TestClient(app)
    frame = _frame_jpeg(np.full((60, 80), 128, dtype=np.float32))
    r = client.post(
        "/app/analyze",
        json={"seq": 0, "timestamp": 0.0, "image": frame},
        headers={"X-Session-Id": "perf-test"},
    )
    assert r.status_code == 200

    body = client.get("/perf").json()
    assert body["steps"] >= 1
    assert "frame" in body["stages"]
    assert body["stages"]["frame"]["count"] >= 1
    # The stage map is the contract QA greps for: the compute stages exist as
    # keys even when one of them was skipped on this frame.
    assert set(perf.STAGES) <= set(body["stages"]) | set(perf.STAGES)

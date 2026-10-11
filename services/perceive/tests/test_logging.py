"""ADAAAA-6525: debug-gated per-frame logging in perceive.

Per-frame detail must be OFF at the default (INFO) level and only appear at
DEBUG, so a container can be flipped to DEBUG without rebuilding. These tests
drive a frame through process_frame (via /app/analyze) and assert on the
caplog records.
"""

import base64
import io
import logging

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app import app

client = TestClient(app)


def _frame_jpeg(gray: np.ndarray) -> str:
    img = Image.fromarray(gray.astype(np.uint8), "L")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


def _black() -> np.ndarray:
    return np.zeros((60, 80), dtype=np.float32)


def _post(sid: str, seq: int):
    return client.post(
        "/app/analyze",
        json={"seq": seq, "timestamp": float(seq), "image": _frame_jpeg(_black())},
        headers={"X-Session-Id": sid},
    )


def _frame_lines(records) -> list[str]:
    return [
        r.getMessage()
        for r in records
        if "frame enter" in r.getMessage() or "frame done" in r.getMessage()
    ]


def test_per_frame_logging_suppressed_at_default(caplog):
    """At the default INFO level, no per-frame DEBUG line is emitted."""
    sid = "sess-dbg-default"
    with caplog.at_level(logging.INFO, logger="highlights.perceive"):
        r = _post(sid, 0)
        assert r.status_code == 200
    assert not _frame_lines(caplog.records), "per-frame lines must be suppressed at default level"


def test_per_frame_logging_emitted_at_debug(caplog):
    """At DEBUG, every frame produces a correlated per-frame entry."""
    sid = "sess-dbg-debug"
    with caplog.at_level(logging.DEBUG, logger="highlights.perceive"):
        r = _post(sid, 0)
        assert r.status_code == 200
    frames = _frame_lines(caplog.records)
    assert frames, "per-frame lines should appear at DEBUG"
    # The frame line ties to the session + a seq so it correlates to the rail.
    assert any(sid in f for f in frames), "per-frame line should carry the session id"

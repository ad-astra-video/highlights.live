"""ADAAAA-8004: the optional second Florence copy (OCR lane)."""
import pytest

from app import _scoreboard_ocr_fields
from app import florence


def test_dual_florence_is_off_by_default(monkeypatch):
    monkeypatch.delenv("PERCEIVE_DUAL_FLORENCE", raising=False)
    monkeypatch.setenv("PERCEIVE_MODE", "florence")
    florence.reset_detectors()
    assert florence.dual_florence_enabled() is False
    assert florence.get_ocr_detector() is None, (
        "the second copy must not load unless the operator opts in"
    )


def test_dual_florence_returns_a_second_distinct_copy(monkeypatch):
    monkeypatch.setenv("PERCEIVE_DUAL_FLORENCE", "1")
    monkeypatch.setenv("PERCEIVE_MODE", "florence")
    florence.reset_detectors()
    ocr = florence.get_ocr_detector()
    assert ocr is not None
    assert ocr is florence.get_ocr_detector(), "the copy is cached, not rebuilt per frame"
    assert ocr is not florence.get_detector(), "OCR must not share the primary model instance"


def test_dual_florence_is_none_in_stub_mode(monkeypatch):
    monkeypatch.setenv("PERCEIVE_DUAL_FLORENCE", "1")
    monkeypatch.setenv("PERCEIVE_MODE", "stub")
    florence.reset_detectors()
    assert florence.get_ocr_detector() is None


def test_ocr_lane_is_single_worker():
    from app import _ocr_lane_executor

    assert _ocr_lane_executor()._max_workers == 1


def test_ocr_fields_default_when_there_is_no_detector_or_frame():
    assert _scoreboard_ocr_fields(None, None, "", 1, 0.0, None, None) == {"ocr": []}
    assert _scoreboard_ocr_fields(object(), None, "", 1, 0.0, None, None) == {"ocr": []}


def test_dual_lane_result_lands_in_the_observation(monkeypatch):
    """With the lane on, the frame still carries the OCR the second copy read."""
    import base64
    import io

    import numpy as np
    from fastapi.testclient import TestClient
    from PIL import Image

    import app as _app
    from app import app

    class FakeOcrDet:
        def ocr(self, rgb, roi=None):
            return ["TURKIYEBASKETBOLMB13 8Samsunspor"]

    class PrimaryDet:
        def detect(self, rgb, vocabulary=None):
            return []

    monkeypatch.setenv("PERCEIVE_DUAL_FLORENCE", "1")
    monkeypatch.setattr(_app, "dual_florence_enabled", lambda: True)
    monkeypatch.setattr(_app, "get_ocr_detector", lambda: FakeOcrDet())
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: PrimaryDet())

    img = Image.fromarray(np.zeros((60, 80), dtype=np.uint8), "L")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    frame = base64.b64encode(buf.getvalue()).decode()

    client = TestClient(app)
    r = client.post(
        "/app/analyze",
        json={"seq": 0, "timestamp": 0.0, "image": frame, "gameHint": "basketball"},
        headers={"X-Session-Id": "dual-lane-test"},
    )
    assert r.status_code == 200
    assert any("TURKIYE" in line for line in r.json()["ocr"])

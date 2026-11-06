"""ADAAAA-8139: the ``POST /scoreboard`` probe route.

Pins the wire shape the server's persisted-frame re-read depends on: the route
exists on both the root and ``/app`` mounts, needs no session, returns the raw
OCR lines plus the resolved crop, and never 500s on a bad frame (a dead frame is
absent evidence, not a rail error).
"""
from __future__ import annotations

import base64
import io

from fastapi.testclient import TestClient
from PIL import Image

from app import app


client = TestClient(app)


def _jpeg_b64(width: int = 320, height: int = 180) -> str:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (18, 18, 18)).save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_scoreboard_probe_route_exists_on_both_mounts():
    body = {"image": _jpeg_b64()}
    for path in ("/scoreboard", "/app/scoreboard"):
        r = client.post(path, json=body)
        assert r.status_code == 200, path
        data = r.json()
        # Stub posture: no OCR model -> explicit absent evidence, not an error.
        assert "ocr" in data and isinstance(data["ocr"], list)
        assert "roi" in data
        assert "reason" in data


def test_scoreboard_probe_accepts_an_explicit_roi():
    r = client.post("/app/scoreboard", json={"image": _jpeg_b64(), "roi": [0.0, 0.7, 1.0, 0.95]})
    assert r.status_code == 200
    assert r.json()["roi"] == [0.0, 0.7, 1.0, 0.95]


def test_scoreboard_probe_bad_image_is_not_a_500():
    r = client.post("/app/scoreboard", json={"image": "nonsense"})
    assert r.status_code == 200
    assert r.json()["ocr"] == []
    assert r.json()["reason"] == "bad_image"


def test_scoreboard_probe_empty_body_is_not_a_500():
    r = client.post("/app/scoreboard", json={})
    assert r.status_code == 200
    assert r.json()["ocr"] == []

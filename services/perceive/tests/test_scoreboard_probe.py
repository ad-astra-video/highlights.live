"""ADAAAA-8139: the single-frame scoreboard OCR probe.

The server's bounded persisted-frame re-read calls this once per frame, so these
tests pin what that costs and what it refuses:

- exactly ONE ``detector.ocr`` call per frame (no detection, no SAM, no tracker);
- the ROI is always a score-bug crop (request box > session ROI > env ROI > the
  documented top-band prior) — never a whole-frame read that could pick up
  banner/crowd text;
- a bad image / missing detector / OCR failure degrades to ``ocr: []`` with a
  reason and never raises (absent evidence, never a fabricated read).
"""
from __future__ import annotations

import base64
import io

import pytest
from PIL import Image

from app.scoreboard import ScoreboardRoi
from app.scoreboard_probe import (
    probe_scoreboard_ocr,
    resolve_probe_roi,
)


def _jpeg_b64(width: int = 320, height: int = 180) -> str:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (18, 18, 18)).save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


class _FakeDetector:
    """Counts OCR calls and records the ROI it was handed."""

    def __init__(self, lines):
        self.lines = lines
        self.calls = 0
        self.rois = []
        self.raise_on_call = None

    def ocr(self, image, roi=None):
        self.calls += 1
        self.rois.append(roi)
        if self.raise_on_call:
            raise RuntimeError(self.raise_on_call)
        return list(self.lines)


class _FakeState:
    def __init__(self, roi=None):
        self.scoreboard_roi = roi


def test_probe_makes_exactly_one_ocr_call_on_the_crop():
    det = _FakeDetector(["20:00 RMA 2-1 BAR"])
    out = probe_scoreboard_ocr(_jpeg_b64(), detector=det)
    assert det.calls == 1
    assert out["ok"] is True
    assert out["ocr"] == ["20:00 RMA 2-1 BAR"]
    assert out["score"] == [2, 1]
    assert isinstance(det.rois[0], ScoreboardRoi)


def test_probe_returns_raw_lines_so_the_server_owns_parsing():
    # A hyphenated broadcast clock: the perceive parser reads it first-match-wins
    # as (19, 41); the SERVER's parseOcrScoreLine is the one that picks 2-1. The
    # probe must hand back the raw lines untouched so the two layers agree.
    det = _FakeDetector(["19-41 RMA-2-1 BAR"])
    out = probe_scoreboard_ocr(_jpeg_b64(), detector=det)
    assert out["ocr"] == ["19-41 RMA-2-1 BAR"]


def test_request_roi_wins_and_is_used_verbatim():
    det = _FakeDetector(["2-1"])
    out = probe_scoreboard_ocr(_jpeg_b64(), roi=[0.1, 0.1, 0.5, 0.4], detector=det)
    assert out["roi"] == pytest.approx([0.1, 0.1, 0.5, 0.4])
    assert det.rois[0].x0 == pytest.approx(0.1)


def test_session_roi_is_reused_before_the_top_band_prior():
    session = ScoreboardRoi(0.0, 0.6, 1.0, 0.9)  # a bottom-left scorebug
    roi = resolve_probe_roi(None, _FakeState(session))
    assert roi is session


def test_malformed_request_roi_is_ignored_not_widened(monkeypatch):
    # A degenerate box must not turn into a whole-frame OCR.
    monkeypatch.delenv("PERCEIVE_SCOREBOARD_ROI", raising=False)
    session = ScoreboardRoi(0.0, 0.6, 1.0, 0.9)
    roi = resolve_probe_roi([2.0, 0.0, 3.0, 1.0], _FakeState(session))
    assert roi is session


def test_env_roi_is_honoured_when_no_request_or_session(monkeypatch):
    monkeypatch.setenv("PERCEIVE_SCOREBOARD_ROI", "0.0,0.7,1.0,0.95")
    roi = resolve_probe_roi(None, None)
    assert (roi.x0, roi.y0, roi.x1, roi.y1) == pytest.approx((0.0, 0.7, 1.0, 0.95))


def test_top_band_prior_is_the_last_resort(monkeypatch):
    monkeypatch.delenv("PERCEIVE_SCOREBOARD_ROI", raising=False)
    roi = resolve_probe_roi(None, None)
    assert (roi.x0, roi.y0, roi.x1, roi.y1) == pytest.approx((0.0, 0.0, 1.0, 0.25))


def test_bad_image_is_absent_evidence_not_an_exception():
    det = _FakeDetector(["2-1"])
    out = probe_scoreboard_ocr("not-a-jpeg", detector=det)
    assert out["ocr"] == []
    assert out["ok"] is False
    assert out["reason"] == "bad_image"
    assert det.calls == 0


def test_missing_detector_is_a_no_op(monkeypatch):
    monkeypatch.setattr("app.florence.get_detector", lambda *_a, **_k: None)
    out = probe_scoreboard_ocr(_jpeg_b64())
    assert out["ocr"] == []
    assert out["ok"] is False
    assert out["reason"] == "no_detector"


def test_ocr_failure_degrades_to_absent_evidence():
    det = _FakeDetector(["2-1"])
    det.raise_on_call = "cuda oom"
    out = probe_scoreboard_ocr(_jpeg_b64(), detector=det)
    assert out["ocr"] == []
    assert out["ok"] is False
    assert out["reason"].startswith("ocr_failed")


def test_unreadable_crop_reports_unreadable_not_a_score():
    det = _FakeDetector(["", "   ", "VITALDE"])
    out = probe_scoreboard_ocr(_jpeg_b64(), detector=det)
    assert out["ocr"] == ["VITALDE"]
    assert out["score"] is None
    assert out["ok"] is True
    # Text but no score-shaped line: absent evidence, and the server parser sees
    # the same raw lines and also refuses them.
    assert out["reason"] == "no_score"


def test_empty_crop_reports_unreadable():
    det = _FakeDetector([])
    out = probe_scoreboard_ocr(_jpeg_b64(), detector=det)
    assert out["ocr"] == []
    assert out["reason"] == "unreadable"

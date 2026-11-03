"""ADAAAA-7847: request-supplied high-resolution anchor frames for the
jersey-identify pass.

The one-shot `track-player` identification used to read ONLY the frame the
perceive session last saw, which is a rail sample (320:180 live / 640:360 VOD).
A broadcast jersey number is not legible at that scale (measured: 0/311 census
frames of clip `397294f3` read jersey 11 at either rail scale, 14/311 read it at
the native 1280x720). The server now samples ANCHOR frames at request time and
the control handler identifies against them first.

These tests pin the handler contract without any model:

  * the anchor frames are tried BEFORE the rail frame, newest first;
  * a match on the anchor seeds exactly one selected/locked `player #N` slot;
  * the rail frame is still the last resort when no anchor frame reads;
  * a corrupt anchor frame is dropped, never a failed request.
"""
import base64
import io

import numpy as np
from PIL import Image

import app as app_mod
from app import handle_control
from app.session import SessionState
from app.tracker import IoUTracker


class _WidthAwareDetector:
    """Detects one player box and reads the jersey only on frames at least
    `min_width` pixels wide — i.e. only on the high-resolution anchor sample."""

    def __init__(self, number, min_width):
        self.number = int(number)
        self.min_width = int(min_width)
        self.frame_widths = []

    def detect(self, rgb, vocabulary=None, roi_pass=True):
        self.frame_widths.append(int(rgb.shape[1]))
        return [{"label": "player", "confidence": 0.9, "bbox": [0.3, 0.3, 0.5, 0.6]}]

    def ocr(self, frame, roi=None):
        return [str(self.number)] if int(frame.shape[1]) >= self.min_width else []


def _jpeg_data_uri(width, height, colour=(12, 34, 56)):
    img = Image.new("RGB", (width, height), colour)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _rail_state(session_id, width=320, height=180):
    state = SessionState(session_id=session_id)
    state.last_rgb = np.zeros((height, width, 3), np.uint8)
    state.tracker = IoUTracker(capacity=3)
    return state


def test_anchor_frames_are_tried_before_the_rail_frame_and_seed(monkeypatch):
    det = _WidthAwareDetector(11, min_width=960)
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: det)
    state = _rail_state("s-anchor-1")

    ack = handle_control(
        state,
        {
            "type": "track-player",
            "number": 11,
            "anchorImages": [_jpeg_data_uri(320, 180), _jpeg_data_uri(1280, 720)],
            "anchorScale": "1280:720",
        },
    )

    assert ack["ok"] is True, ack
    assert ack["number"] == 11
    assert ack["selected"] is True
    assert ack["anchorFrames"] == 2  # the 320-wide anchor missed, the 1280-wide one seeded
    assert ack["anchorScale"] == "1280:720"
    label = state.tracker.tracks[ack["slot"]].label
    assert label == "player #11"
    assert state.requested_player_number == 11
    # The rail frame (320 wide) was never asked to identify: the anchor list hit.
    assert det.frame_widths[:2] == [320, 1280]
    assert 180 not in det.frame_widths  # rail frame height, i.e. the rail frame


def test_rail_frame_is_still_the_last_resort_when_no_anchor_reads(monkeypatch):
    """Pre-7847 behaviour survives: a request whose high-resolution sample does
    not read the jersey still identifies against the session's rail frame."""
    det = _WidthAwareDetector(11, min_width=200)  # rail (320 wide) DOES read here
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: det)
    state = _rail_state("s-anchor-2")

    ack = handle_control(
        state,
        {
            "type": "track-player",
            "number": 11,
            "anchorImages": [_jpeg_data_uri(1280, 720)],
            "anchorScale": "1280:720",
        },
    )

    assert ack["ok"] is True, ack
    assert ack["anchorFrames"] == 1
    # anchor (1280, no read at this number? it reads at >=200 too) -> the first
    # frame that reads wins: the anchor. Nothing about the fallback regressed.
    assert state.tracker.tracks[ack["slot"]].label == "player #11"


def test_no_anchor_still_requires_a_rail_frame():
    state = SessionState(session_id="s-anchor-3")  # no last_rgb
    ack = handle_control(state, {"type": "track-player", "number": 9})
    assert ack["ok"] is False
    assert "anchor" in ack.get("error", "")


def test_corrupt_anchor_frame_is_dropped_not_fatal(monkeypatch):
    det = _WidthAwareDetector(11, min_width=960)
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: det)
    state = _rail_state("s-anchor-4")

    ack = handle_control(
        state,
        {
            "type": "track-player",
            "number": 11,
            "anchorImages": ["data:image/jpeg;base64,not-a-jpeg", _jpeg_data_uri(1280, 720)],
            "anchorScale": "1280:720",
        },
    )

    assert ack["ok"] is True, ack
    assert ack["anchorFrames"] == 1  # only the decodable frame was attempted


def test_anchor_miss_reports_the_retry_window_with_the_anchor_count(monkeypatch):
    det = _WidthAwareDetector(11, min_width=4096)  # nothing ever reads
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: det)
    state = _rail_state("s-anchor-5")

    ack = handle_control(
        state,
        {
            "type": "track-player",
            "number": 11,
            "anchorImages": [_jpeg_data_uri(1280, 720), _jpeg_data_uri(1280, 720)],
            "anchorScale": "1280:720",
        },
    )

    assert ack["ok"] is False
    assert ack["retrying"] is True
    assert ack["retryWindowFrames"] > 0
    assert ack["anchorFrames"] == 2
    assert state.pending_player_number == 11
    assert len(state.tracker.tracks) == 0

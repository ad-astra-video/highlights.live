"""ADAAAA-7218 (Increment C): player-by-number identification, tested through
the player_id module and the gated `track-player` control command.

  * identification: given a requested jersey number, the matched player bbox is
    identified from the anchor frame's player detections via a one-shot OCR.
  * gating: player-by-number inference NEVER runs in the default per-frame
    path; it runs only when the operator sends `track-player`.
  * handoff: seeding the matched player marks it selected (surfaced + accuracy).

No real model required (fake detector + OCR).
"""
import numpy as np

import app as app_mod
from app import florence
from app import handle_control
from app.player_id import (
    identify_player_by_number,
    is_player_detection,
    match_player_by_number,
    parse_jersey_numbers,
)
from app.sam_tracker import HybridTracker, SamBackend
from app.session import SessionState
from app.tracker import IoUTracker


class _TrackBall(SamBackend):
    def ready(self):
        return True

    def advance(self, prompts):
        self._cur = dict(prompts)

    def get(self, slot):
        return self._cur.get(slot)


class _FakeDetector:
    """Player detections + a scripted OCR per normalized bbox.

    `numbers` maps the normalized (x1, y1) leading corner of a detection bbox
    -> OCR lines. The fake `ocr` crops via the ROI adapter, scales its pixel
    box back, and returns the number registered for the matching detection.
    """

    def __init__(self, detections, numbers=None):
        self.detections = [dict(d) for d in detections]
        self.numbers = numbers or {}
        self.detect_calls = []
        self.ocr_calls = []

    def detect(self, rgb, vocabulary=None, roi_pass=True):
        self.detect_calls.append({"vocabulary": list(vocabulary) if vocabulary else None, "roi_pass": roi_pass})
        return [dict(d) for d in self.detections]

    def ocr(self, frame, roi=None):
        H, W = frame.shape[:2]
        px = roi.pixel_box(W, H) if roi else None
        self.ocr_calls.append(px)
        for d in self.detections:
            x1, y1, x2, y2 = d["bbox"]
            if px == (int(x1 * W), int(y1 * H), int(x2 * W), int(y2 * H)):
                return list(self.numbers.get((int(x1 * W), int(y1 * H)), []))
        return []


def _norm_key(bbox):
    return (round(float(bbox[0]), 3), round(float(bbox[1]), 3))


def _px_key(bbox, W=64, H=64):
    return (int(bbox[0] * W), int(bbox[1] * H))



# --- pure helpers -----------------------------------------------------------


def test_parse_jersey_numbers_basic():
    assert parse_jersey_numbers(["9"]) == [9]
    assert parse_jersey_numbers(["\u201c#9\u201d", "the number 9"]) == [9]
    assert parse_jersey_numbers(["23"]) == [23]
    assert parse_jersey_numbers(["09"]) == [9]
    # larger digit runs (clocks / scores / years) are ignored
    assert parse_jersey_numbers(["45:30", "1998"]) == [45, 30]
    assert parse_jersey_numbers([]) == []
    assert parse_jersey_numbers(None) == []


def test_is_player_detection():
    assert is_player_detection({"label": "player"}) is True
    assert is_player_detection({"label": "goalkeeper"}) is True
    assert is_player_detection({"label": "soccer ball"}) is False
    assert is_player_detection({"label": "goal"}) is False
    assert is_player_detection({"label": ""}) is False


def test_match_player_by_number_picks_correct_box():
    objects = [
        {"label": "player", "confidence": 0.9, "bbox": [0.1, 0.1, 0.3, 0.4]},   # #7
        {"label": "player", "confidence": 0.8, "bbox": [0.5, 0.1, 0.7, 0.4]},   # #9
        {"label": "player", "confidence": 0.7, "bbox": [0.7, 0.5, 0.9, 0.9]},   # #9 (dup)
    ]
    numbers = {
        _norm_key([0.1, 0.1, 0.3, 0.4]): ["7"],
        _norm_key([0.5, 0.1, 0.7, 0.4]): ["9"],
        _norm_key([0.7, 0.5, 0.9, 0.9]): ["9"],
    }

    def read(bbox):
        return numbers.get(_norm_key(bbox), [])

    match = match_player_by_number(objects, 9, read)
    assert match is not None
    assert match["number"] == 9
    assert list(match["bbox"]) == [0.5, 0.1, 0.7, 0.4]
    assert match["ocr"] == ["9"]


def test_match_player_by_number_no_match_returns_none():
    objects = [{"label": "player", "confidence": 0.9, "bbox": [0.1, 0.1, 0.3, 0.4]}]
    match = match_player_by_number(objects, 9, lambda bbox: ["7"])
    assert match is None


def test_identify_player_by_number_uses_player_vocab_and_roi_off():
    det = _FakeDetector(
        [{"label": "player", "confidence": 0.9, "bbox": [0.2, 0.2, 0.4, 0.5]}],
        numbers={_px_key([0.2, 0.2, 0.4, 0.5]): ["9"]},
    )
    frame = np.zeros((64, 64, 3), np.uint8)
    match = identify_player_by_number(frame, 9, det)
    assert match is not None and match["number"] == 9
    # Detect was scoped to the player roster and no ROI (ball-recovery) pass.
    assert det.detect_calls[0]["vocabulary"] == ["player", "goalkeeper"]
    assert det.detect_calls[0]["roi_pass"] is False
    # One-shot: one detection pass + one OCR read on the matched box.
    assert len(det.detect_calls) == 1
    assert len(det.ocr_calls) == 1


# --- control integration ---------------------------------------------------


def test_track_player_seeds_matched_selected_slot(monkeypatch):
    det = _FakeDetector(
        [{"label": "player", "confidence": 0.9, "bbox": [0.2, 0.2, 0.4, 0.5]}],
        numbers={_px_key([0.2, 0.2, 0.4, 0.5]): ["9"]},
    )
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: det)
    state = SessionState(session_id="s-pn")
    state.last_rgb = np.zeros((64, 64, 3), np.uint8)
    state.tracker = IoUTracker(capacity=3)

    ack = handle_control(state, {"type": "track-player", "number": 9})
    assert ack["ok"] is True and ack["cmd"] == "track-player"
    assert ack["number"] == 9
    assert ack["selected"] is True
    assert ack["slot"] == 0
    assert state.requested_player_number == 9
    # The seeded track is selected (INC-6 accuracy semantics) and carries the
    # player-by-number label so the operator sees the requested jersey number.
    tr = state.tracker.tracks[0]
    assert tr.selected is True
    assert tr.label == "player #9"


def test_track_player_missing_number_ack_false():
    state = SessionState(session_id="s-pn2")
    state.last_rgb = np.zeros((64, 64, 3), np.uint8)
    ack = handle_control(state, {"type": "track-player"})
    assert ack["ok"] is False
    assert "number" in ack.get("error", "")


def test_track_player_no_match_ack_false(monkeypatch):
    det = _FakeDetector(
        [{"label": "player", "confidence": 0.9, "bbox": [0.2, 0.2, 0.4, 0.5]}],
        numbers={_px_key([0.2, 0.2, 0.4, 0.5]): ["7"]},
    )
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: det)
    state = SessionState(session_id="s-pn3")
    state.last_rgb = np.zeros((64, 64, 3), np.uint8)
    state.tracker = IoUTracker(capacity=3)
    ack = handle_control(state, {"type": "track-player", "number": 9})
    assert ack["ok"] is False
    assert "no player with number 9" in ack.get("error", "")
    assert state.requested_player_number is None
    assert len(state.tracker.tracks) == 0


def test_track_player_requires_anchor_frame():
    state = SessionState(session_id="s-pn4")
    # no last_rgb -> no anchor frame to identify against
    ack = handle_control(state, {"type": "track-player", "number": 9})
    assert ack["ok"] is False
    assert "anchor" in ack.get("error", "")


def test_per_frame_path_never_runs_player_by_number(monkeypatch):
    """Gating (acceptance: never runs by default). The default per-frame
    process_frame path must not invoke player-by-number identification — it only
    runs when the operator sends an explicit `track-player` control. We install
    a sentinel that fails the test if it is ever called from process_frame."""
    from app import process_frame

    called = {"n": 0}

    def _boom(*a, **k):
        called["n"] += 1
        raise AssertionError("player-by-number inference ran in the default per-frame path")

    monkeypatch.setattr(app_mod, "identify_player_by_number", _boom)

    det = _CountingDetector(ball_box=(0.3, 0.3, 0.5, 0.5))
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: det)
    monkeypatch.setattr(florence, "get_detector", lambda lora_ref=None: det)

    state = SessionState(session_id="s-pn-default")
    state.game_hint = "soccer"
    state.tracker = HybridTracker(backend=_TrackBall(), ball_label="soccer ball")
    state.last_rgb = np.zeros((64, 64, 3), np.uint8)

    # No `track-player` control sent. Run several default frames through the
    # per-frame path; player-by-number must never fire.
    for i in range(5):
        process_frame(state, i, float(i), "")
    assert called["n"] == 0


class _CountingDetector:
    """Tiny detector that identifies the ball on the first frame only, so the
    default soccer per-frame path bootstraps the SAM ball slot (Inc A/B)."""

    def __init__(self, ball_box):
        self.ball_box = list(ball_box)
        self.calls = 0

    def detect(self, rgb, vocabulary=None, roi_pass=True):
        self.calls += 1
        if self.calls == 1:
            return [{"label": "soccer ball", "confidence": 0.9, "bbox": list(self.ball_box)}]
        return []


def test_track_player_handoff_sam_propagates_without_per_frame_player_detect(monkeypatch):
    """ADAAAA-7218 acceptance: once the matched player's SAM slot is seeded,
    SAM propagates the tracking and player detections are NOT re-run per frame.

    We seed a player via `track-player` on the anchor frame, then run subsequent
    frames; the counting detector must not be asked for players again (the
    per-frame vocabulary stays ball-first / ball-dropped), while the seeded
    player track survives and stays on-screen via the SAM backend."""
    from app import process_frame

    det = _CountingDetector(ball_box=(0.3, 0.3, 0.5, 0.5))
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: det)
    monkeypatch.setattr(florence, "get_detector", lambda lora_ref=None: det)

    state = SessionState(session_id="s-pn-handoff")
    state.game_hint = "soccer"
    # A SAM backend that always propagates the seeded player prompt.
    state.tracker = HybridTracker(backend=_TrackBall(), ball_label="soccer ball")
    state.last_rgb = np.full((64, 64, 3), 128, np.uint8)

    # Seed frame: identify player #9 on the anchor and seed the SAM slot.
    sid_det = _FakeDetector(
        [{"label": "player", "confidence": 0.9, "bbox": [0.2, 0.2, 0.4, 0.5]}],
        numbers={_px_key([0.2, 0.2, 0.4, 0.5]): ["9"]},
    )
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: sid_det)
    ack = handle_control(state, {"type": "track-player", "number": 9})
    assert ack["ok"] is True
    seeded_track_id = ack["trackId"]
    assert seeded_track_id in [t.track_id for t in state.tracker.tracks]

    # Now let the per-frame path run WITHOUT a player request. The seeded player
    # slot must stay alive / on-screen (SAM propagates it).
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: det)
    for i in range(1, 6):
        obs, _ = process_frame(state, i, float(i), "")
        # The seeded player track stays on screen (SAM held it forward).
        track_ids = [t["trackId"] for t in obs["tracks"]]
        assert seeded_track_id in track_ids, f"frame {i}: seeded player lost"
    # No player-by-number identification re-ran (one-shot only).
    assert state.requested_player_number == 9



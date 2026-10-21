"""Unit tests for the scoreboard OCR / score-delta logic (ADAAAA-6360, decide-leg
I3). Pure functions and the tracker — no GPU, no network.

ADAAAA-7081 also covers the scoreboard-region-of-interest scoping: only OCR
read from the scoreboard ROI may become a score; crowd / banner / jersey /
shot-clock text is cropped out and can never set ``scoreBoardChanged``.
"""
from __future__ import annotations

from app.scoreboard import ScoreboardRoi, ScoreboardTracker, parse_ocr_score, score_changed


def test_parse_ocr_score_standard_dash():
    assert parse_ocr_score(["Chelsea 2 - 1 Arsenal"]) == (2, 1)


def test_parse_ocr_score_separator_variants():
    assert parse_ocr_score(["45-42"]) == (45, 42)
    assert parse_ocr_score(["2–1"]) == (2, 1)  # en dash


def test_parse_ocr_score_rejects_time_clock():
    # Colon / clock reads are NOT scores; a false score could wrongly confirm a
    # goal (ADAAAA-6360 precision), so they must not become a delta.
    assert parse_ocr_score(["10:15"]) is None
    assert parse_ocr_score(["min 90:00"]) is None


def test_parse_ocr_score_ignores_non_score_lines():
    # No clean two-integer score line -> None (weak/absent evidence).
    assert parse_ocr_score(["second half", "corner kick", "12"]) is None
    assert parse_ocr_score(["2to1"]) is None


def test_parse_ocr_score_empty_and_unicode_dash():
    assert parse_ocr_score([]) is None
    assert parse_ocr_score([None, ""]) is None


def test_parse_ocr_score_rejects_absurd_values():
    # Jersey / clock-like numbers that are not a score should not be a delta.
    assert parse_ocr_score(["123 - 456"]) is None


def test_score_changed_requires_two_concrete():
    assert score_changed(None, (1, 0)) is False
    assert score_changed((1, 0), None) is False
    assert score_changed(None, None) is False
    assert score_changed((1, 0), (2, 0)) is True
    assert score_changed((2, 0), (2, 0)) is False


def test_tracker_delta_across_window():
    tr = ScoreboardTracker(window_seconds=60.0)
    # One reading only -> no delta yet.
    tr.record(10.0, (1, 0))
    assert tr.changed(10.0) is False
    # Same score later -> no delta.
    tr.record(30.0, (1, 0))
    assert tr.changed(40.0) is False
    # Score goes 2-0 within the window -> delta.
    tr.record(45.0, (2, 0))
    assert tr.changed(50.0) is True


def test_tracker_prunes_stale_window():
    tr = ScoreboardTracker(window_seconds=60.0)
    tr.record(1.0, (1, 0))
    tr.record(100.0, (2, 0))
    # The first reading is outside the 60 s window ending at 100 -> pruned,
    # so only "2-0" remains and there is no delta.
    assert tr.changed(100.0) is False


def test_tracker_ignores_none_readings():
    tr = ScoreboardTracker()
    tr.record(10.0, None)
    tr.record(20.0, (1, 0))
    assert tr.changed(20.0) is False


# --- ADAAAA-7081: scoreboard ROI scoping -------------------------------------
# A copy/banner "N - M" line OUTSIDE the scoreboard ROI must never become a
# score. The scoreboard ROI occupies, say, the top-left score bug region; the
# crowd/banner/jersey/clock text lives elsewhere in the frame. We pass per-line
# normalized boxes alongside the OCR text, exactly like a position-aware OCR.


def test_parse_ocr_score_ignores_crowd_line_outside_roi():
    # A banner in the crowd reads "3 - 2" but sits at the bottom-left of the
    # frame, far outside the top-left scoreboard ROI. It must not become a score.
    roi = ScoreboardRoi(0.0, 0.0, 0.4, 0.25)  # top-left scorebug region
    crowd_line = "HALF TIME 3 - 2"
    crowd_box = [0.05, 0.70, 0.55, 0.80]  # bottom-left crowd/banner band
    assert parse_ocr_score([crowd_line], roi=roi, ocr_boxes=[crowd_box]) is None


def test_parse_ocr_score_returns_only_roi_scoreboard():
    # A real scoreboard inside the ROI wins even when a crowd "N - M" line outside
    # it is also present — the scoreboard read is what we keep.
    roi = ScoreboardRoi(0.0, 0.0, 0.4, 0.25)
    crowd_line = "FANS 4 - 1"
    crowd_box = [0.5, 0.6, 0.9, 0.75]
    board_line = "MCI 2 - 1 LIV"
    board_box = [0.02, 0.03, 0.30, 0.20]
    assert parse_ocr_score(
        [crowd_line, board_line], roi=roi, ocr_boxes=[crowd_box, board_box]
    ) == (2, 1)


def test_parse_ocr_score_no_boxes_still_scoped_by_crop():
    # The production path crops the frame to the ROI BEFORE <OCR>, so every line
    # passed in is already in-region and there are no per-line boxes. A line with
    # no box and an active ROI is still eligible (cropping is the single source
    # of truth); a real scoreboard read is kept.
    roi = ScoreboardRoi(0.0, 0.0, 1.0, 0.25)
    assert parse_ocr_score(["2 - 1"], roi=roi) == (2, 1)


def test_parse_ocr_score_crowd_line_cannot_drive_tracker_delta():
    # End-to-end at the pure level: a crowd/banner "N - M" line outside the ROI
    # produces no score, so the tracker can never report a score change for it.
    roi = ScoreboardRoi(0.0, 0.0, 0.4, 0.25)
    tr = ScoreboardTracker(window_seconds=60.0)
    tr.record(10.0, parse_ocr_score(["BILLBOARD 1 - 1"], roi=roi, ocr_boxes=[[0.6, 0.7, 0.95, 0.85]]))
    tr.record(
        30.0,
        parse_ocr_score(["BILLBOARD 2 - 1"], roi=roi, ocr_boxes=[[0.6, 0.7, 0.95, 0.85]]),
    )
    # Both reads were outside the ROI -> no score ever recorded -> no delta.
    assert tr.changed(40.0) is False


def test_scoreboard_roi_pixel_box():
    roi = ScoreboardRoi(0.0, 0.0, 0.5, 0.25)
    assert roi.pixel_box(1280, 720) == (0, 0, 640, 180)
    # Degenerate / out-of-range region -> None (caller falls back, never crashes).
    assert ScoreboardRoi(0.5, 0.5, 0.5, 0.6).pixel_box(1280, 720) is None
    assert ScoreboardRoi(-0.1, 0.0, 0.5, 0.6).pixel_box(1280, 720) is None
    assert ScoreboardRoi(0.0, 0.0, 1.0, 1.0).pixel_box(0, 0) is None


def test_scoreboard_roi_contains():
    roi = ScoreboardRoi(0.0, 0.0, 0.4, 0.25)
    assert roi.contains([0.02, 0.03, 0.30, 0.20]) is True   # inside
    assert roi.contains([0.5, 0.6, 0.9, 0.75]) is False     # outside
    assert roi.contains([0.39, 0.24, 0.40, 0.25]) is True   # right on the edge
    assert roi.contains([0.0, 0.0, 1.0, 1.0]) is True       # spans, overlaps


def test_scoreboard_roi_from_env_and_fallback():
    import os
    from app import scoreboard as sb

    env_key = sb._SCOREBOARD_ROI_ENV
    previous = os.environ.get(env_key)
    try:
        os.environ[env_key] = "0.0,0.0,0.5,0.25"
        roi = ScoreboardRoi.from_env()
        assert (roi.x0, roi.y0, roi.x1, roi.y1) == (0.0, 0.0, 0.5, 0.25)
        # Malformed value falls back to the default, never raises.
        os.environ[env_key] = "not,a,box"
        roi2 = ScoreboardRoi.from_env()
        assert roi2.x1 == 1.0 and roi2.y1 == sb._DEFAULT_SCOREBOARD_ROI[3]
    finally:
        if previous is None:
            os.environ.pop(env_key, None)
        else:
            os.environ[env_key] = previous

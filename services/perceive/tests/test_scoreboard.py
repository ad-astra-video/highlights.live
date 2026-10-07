"""Unit tests for the scoreboard OCR / score-delta logic (ADAAAA-6360, decide-leg
I3). Pure functions and the tracker — no GPU, no network.
"""
from __future__ import annotations

from app.scoreboard import ScoreboardTracker, parse_ocr_score, score_changed


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

"""Unit tests for the eviction-guarded ball track (INC-2b / ADAAAA-4326).

The ball is small and fast; the failure mode the tracker exists to fix is a
Florence ``<OD>`` "sports ball" detection being missed on individual busy
frames, which would drop the ball from a naive IoU/centroid tracker. These tests
drive the box-level BallTracker with per-frame ball detections (real + dropped)
and assert (a) the eviction guard holds the box through gaps, (b) it re-acquires
instantly without slot destruction, and (c) on-screen persistence meets the
>=95% acceptance target under realistic per-frame dropout.
"""
import numpy as np
import pytest

from app.ball_track import BallTracker


def _ball_at(i: int, n: int = 600) -> tuple:
    """A small ball sweeping bottom-left -> top-right over n frames (px box)."""
    f = i / max(1, n - 1)
    w, h = 0.03, 0.03  # the ball is tiny
    x = 0.10 + 0.80 * f
    y = 0.85 - 0.70 * f
    return (x, y, x + w, y + h)


def _box(px: tuple) -> list:
    return [px]


def test_single_frame_miss_is_held_not_dropped():
    """A one-frame missed detection must bridge the gap (the core guard)."""
    tr = BallTracker(loss_hold_frames=5)
    b = _ball_at(10)
    s0 = tr.step([b], ts=1.0)
    assert s0.present and s0.real and not s0.held
    # next frame: NO ball detection (Florence missed it)
    s1 = tr.step([], ts=2.0)
    assert s1.present, "single-frame miss must NOT drop the ball"
    assert s1.held and not s1.real
    assert s1.bbox == b, "held box must equal the last known ball box"
    assert tr.ball_box == b


def test_holds_through_brief_multi_frame_occlusion():
    """A short occlusion (within loss_hold_frames) keeps the track alive."""
    tr = BallTracker(loss_hold_frames=5)
    b = _ball_at(20)
    tr.step([b], ts=1.0)
    last = tr.ball_box
    for k in range(1, 4):  # 3 missed frames, all bridged
        s = tr.step([], ts=1.0 + k)
        assert s.present and s.held
        assert s.bbox == last
    # re-acquire on the next real detection
    b2 = _ball_at(21)
    s = tr.step([b2], ts=5.0)
    assert s.real and s.present and not s.held
    assert s.bbox == b2


def test_long_gap_goes_absent_but_reacquires_without_new_slot():
    """Beyond the hold window the ball is absent, yet the slot persists and
    re-acquires instantly on the next detection (never destroyed/evicted)."""
    tr = BallTracker(loss_hold_frames=3, off_screen_after=20)
    tr.step([_ball_at(5)], ts=1.0)
    # drive far past the hold window
    s = tr.step([], ts=2.0)  # held
    for i in range(10):
        s = tr.step([], ts=3.0 + i)
    assert not s.present, "well past hold window -> absent"
    # re-acquire on the very next real detection
    b = _ball_at(50)
    s = tr.step([b], ts=30.0)
    assert s.present and s.real
    assert s.bbox == b
    assert tr.confirmed  # slot was never destroyed


@pytest.mark.parametrize("drop_rate", [0.02, 0.05, 0.10])
def test_persistence_meets_95pct_target_under_dropout(drop_rate):
    """On-screen persistence stays >=95% even when Florence misses 2-10% of
    individual frames (the target: >=95% of on-screen game time tracked)."""
    rng = np.random.default_rng(7)
    n = 600
    tr = BallTracker(loss_hold_frames=5, off_screen_after=20)
    for i in range(n):
        box = [(_ball_at(i))] if rng.random() >= drop_rate else []
        tr.step(box, ts=float(i))
    assert tr.persistence() >= 0.95


def test_persistence_survives_occlusion_bursts():
    """Multi-frame occlusion bursts must be bridged by the hold window, keeping
    on-screen persistence well above the 95% target."""
    n = 600
    tr = BallTracker(loss_hold_frames=5, off_screen_after=20)
    occlusions = [(150, 153), (300, 305), (500, 502)]  # (start, end) inclusive gaps
    for i in range(n):
        dropped = any(start <= i <= end for start, end in occlusions)
        box = [] if dropped else [_ball_at(i)]
        tr.step(box, ts=float(i))
    assert tr.persistence() >= 0.95


def test_off_screen_time_does_not_clobber_persistence():
    """Frames genuinely trailing the shot (ball off screen) are NOT counted as
    on-screen misses, so persistence measures real on-screen time only."""
    tr = BallTracker(loss_hold_frames=3, off_screen_after=20)
    n = 300
    for i in range(n):
        tr.step([_ball_at(i)], ts=float(i))  # fully tracked
    # now 100 frames with no ball (left the shot)
    for i in range(100):
        tr.step([], ts=float(n + i))
    assert tr.persistence() >= 0.95
    # and the trailing absent frames did not inflate the on-screen denominator
    assert tr._on_screen_frames <= n + 24


def test_absent_before_any_detection_is_not_a_miss():
    """Before the first real detection there is nothing to track -- no phantom
    on-screen frames, no present claim."""
    tr = BallTracker()
    for _ in range(10):
        s = tr.step([], ts=1.0)
        assert not s.present and s.bbox is None
    assert tr.persistence() == 1.0  # divides cleanly over zero on-screen frames

import numpy as np
import pytest

from app.tracker import IoUTracker, MAX_TRACKS, _iou, foreground_blobs


def test_iou():
    assert abs(_iou((0, 0, 1, 1), (0, 0, 1, 1)) - 1.0) < 1e-6
    assert abs(_iou((0, 0, 0.5, 0.5), (0.5, 0.5, 1, 1)) - 0.0) < 1e-6
    # half overlap
    assert abs(_iou((0, 0, 1, 1), (0.5, 0, 1.5, 1)) - 1 / 3) < 1e-6


def test_tracker_assigns_then_evicts_after_lost():
    tr = IoUTracker(lost_before_evict=3)
    t1 = tr.step([(0.1, 0.1, 0.3, 0.3)], ts=1.0)
    assert len(t1) == 1
    assert t1[0].slot == 0

    # same place next frame -> still matched, lost_frames 0
    t2 = tr.step([(0.1, 0.1, 0.3, 0.3)], ts=2.0)
    assert t2[0].lost_frames == 0

    # no boxes -> lost increments
    t3 = tr.step([], ts=3.0)
    assert t3[0].lost_frames == 1
    tr.step([], ts=4.0)
    tr.step([], ts=5.0)
    t6 = tr.step([], ts=6.0)  # lost=4 > 3 -> evicted
    assert len(t6) == 0


def test_tracker_caps_at_max_tracks():
    tr = IoUTracker()
    boxes = [(0.0, 0.0, 0.2, 0.2), (0.4, 0.4, 0.6, 0.6), (0.8, 0.8, 0.95, 0.95)]
    trs = tr.step(boxes, ts=1.0)
    assert len(trs) == MAX_TRACKS
    assert {t.slot for t in trs} == {0, 1}


def test_candidate_on_accumulated_movement_and_cooldown():
    tr = IoUTracker(jump_velocity=0.2, cooldown_s=3.0)
    tr.step([(0.1, 0.1, 0.2, 0.2)], ts=1.0)
    assert tr.candidate(ts=1.0) is None  # first frame, no movement
    # move 0.05/frame x5; overlaps keep the same track, movement accumulates
    for i in range(5):
        dx = 0.05 * (i + 1)
        tr.step([(0.1 + dx, 0.1 + dx, 0.2 + dx, 0.2 + dx)], ts=2.0 + i)
    c = tr.candidate(ts=7.0)
    assert c is not None and c.event_type == "MOVE"
    # cooldown throttles an immediate second candidate
    tr.step([(0.39, 0.39, 0.49, 0.49)], ts=7.1)
    assert tr.candidate(ts=7.2) is None


def test_foreground_blobs_real_frame():
    # a white moving square on black background produces a blob
    h = w = 100
    prev = np.zeros((h, w), dtype=np.float32)
    gray = np.zeros((h, w), dtype=np.float32)
    gray[20:40, 20:40] = 255.0
    blobs = foreground_blobs(gray, prev)
    assert len(blobs) == 1
    bx1, by1, bx2, by2 = blobs[0]
    # square is at x20..40, y20..40 of 100 -> normalized ~0.2..0.4
    assert abs(bx1 - 0.2) < 0.05 and abs(bx2 - 0.4) < 0.05
    assert abs(by1 - 0.2) < 0.05 and abs(by2 - 0.4) < 0.05

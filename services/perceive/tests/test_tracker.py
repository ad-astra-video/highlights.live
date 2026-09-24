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


def test_tracker_caps_at_capacity():
    tr = IoUTracker(capacity=3)
    boxes = [(0.0, 0.0, 0.2, 0.2), (0.4, 0.4, 0.6, 0.6), (0.8, 0.8, 0.95, 0.95), (0.1, 0.6, 0.3, 0.8)]
    trs = tr.step(boxes, ts=1.0)
    assert len(trs) == 3
    assert {t.slot for t in trs} == {0, 1, 2}


def test_tracker_default_capacity_is_schema_ceiling():
    tr = IoUTracker()
    assert tr.capacity == MAX_TRACKS


def test_tracker_vod_capacity_8():
    tr = IoUTracker(capacity=8)
    boxes = [(i * 0.1, i * 0.1, i * 0.1 + 0.05, i * 0.1 + 0.05) for i in range(8)]
    trs = tr.step(boxes, ts=1.0)
    assert len(trs) == 8
    assert {t.slot for t in trs} == set(range(8))


def test_tracked_object_selection_tracks_accuracy_and_ontoframes():
    """INC-6: a selected (find-and-track) object counts matched on-screen frames
    and reports a continuity accuracy = matched / (matched + lost)."""
    tr = IoUTracker(lost_before_evict=10, capacity=3)
    tr.seed((0.1, 0.1, 0.3, 0.3), slot=0, ts=0.0, selected=True)
    t = tr.tracks[0]
    assert t.selected
    assert t.accuracy is None  # not yet matched on-screen

    # two matched frames on-screen
    tr.step([(0.1, 0.1, 0.3, 0.3)], ts=1.0)
    tr.step([(0.12, 0.12, 0.32, 0.32)], ts=2.0)
    t = tr.tracks[0]
    assert t.onto_frames == 2
    assert t.accuracy is not None and abs(t.accuracy - 1.0) < 1e-6  # never lost

    # one lost frame (not on screen) -> accuracy drops
    tr.step([], ts=3.0)
    t = tr.tracks[0]
    assert t.lost_frames == 1
    assert t.accuracy is not None and abs(t.accuracy - 2.0 / 3.0) < 1e-6


def test_unselected_track_reports_no_accuracy():
    """Non-find-and-track (auto-detected) tracks do not carry accuracy/stats."""
    tr = IoUTracker()
    tr.step([(0.1, 0.1, 0.3, 0.3)], ts=1.0)
    t = tr.tracks[0]
    assert not t.selected
    assert t.accuracy is None


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


def test_candidate_anchors_to_peak_motion_strike_frame():
    """A candidate whose accumulated displacement crosses the threshold AFTER the
    explosive step must still be anchored at the peak-motion (strike) frame, so
    the decide/cut moment lands on the strike, not the post-strike follow-through."""
    tr = IoUTracker(jump_velocity=0.2, cooldown_s=0.0)
    # seed the track (no displacement recorded for the seeding frame)
    tr.step([(0.1, 0.1, 0.2, 0.2)], ts=1.0)
    assert tr.candidate(ts=1.0) is None
    # settle frame establishes prev_center with negligible motion
    tr.step([(0.11, 0.11, 0.21, 0.21)], ts=2.0)
    assert tr.candidate(ts=2.0) is None
    # strike burst: PEAK step 0.16 at ts=3.0 (still < the 0.2 jump_velocity alone)
    tr.step([(0.19, 0.19, 0.29, 0.29)], ts=3.0)
    assert tr.candidate(ts=3.0) is None  # not crossed yet (moved=0.18)
    # follow-through: small step at ts=4.0 pushes accumulated over 0.2
    tr.step([(0.21, 0.21, 0.31, 0.31)], ts=4.0)
    c = tr.candidate(ts=4.0)
    assert c is not None
    assert c.timestamp == 3.0  # anchored at the peak-motion frame, not the late crossing frame
    assert c.event_type == "KILL"  # classified from the anchored step (0.16 >= FAST_STEP)


def test_candidate_accumulated_motion_stays_move_anchored_in_burst():
    """Steady drift spikes the accumulated threshold with no single big step: the
    candidate stays a MOVE and anchors to the burst, not the evaluation frame."""
    tr = IoUTracker(jump_velocity=0.2, cooldown_s=0.0)
    tr.step([(0.1, 0.1, 0.2, 0.2)], ts=1.0)
    assert tr.candidate(ts=1.0) is None
    for i in range(5):  # 0.05/frame drift -> 0.10 displacement per step
        dx = 0.05 * (i + 1)
        tr.step([(0.1 + dx, 0.1 + dx, 0.2 + dx, 0.2 + dx)], ts=2.0 + i)
    c = tr.candidate(ts=7.0)
    assert c is not None and c.event_type == "MOVE"
    # anchored to a drift-burst step (2.0..6.0), not the later evaluation frame (7.0)
    assert 2.0 <= c.timestamp <= 6.0


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

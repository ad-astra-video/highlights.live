"""VOD ID-persistence hardening (ADAAAA-5069).

Simulates the real-video failure QA measured (ADAAAA-5062: VOD idPersist 0.655
vs the >=0.95 bar): per-frame detection dropout and player enter/exit that
evict a confirmed track for more than `lost_before_evict` frames, then the
object reappears. The hardened tracker must RESURRECT the SAME track id (no
identity split) and must not let a single spurious detection fragment a real
object's ID (confirmation).
"""
import numpy as np

from app.tracker import IoUTracker, VOD_MAX_TRACKS


def _ids(tracks):
    return sorted(t.track_id for t in tracks)


def test_dropout_gap_reappearance_keeps_identity_vod():
    """A confirmed track evicted by >lost_before_evict dropout frames reappears
    at/near its last box -> SAME track id (dropout-tolerant matching)."""
    tr = IoUTracker(capacity=2, lost_before_evict=3, resurrect_window_frames=20)
    box = (0.2, 0.2, 0.4, 0.4)
    # confirm the track (consecutive matches)
    for ts in range(1, 5):
        tr.step([box], ts=float(ts))
    first_id = _ids(tr.tracks)[0]
    assert tr.tracks[0].confirmed is True  # promoted after confirm_frames

    # detector dropout: no boxes for longer than lost_before_evict (evicts)
    for ts in range(5, 11):
        tr.step([], ts=float(ts))
    assert len(tr.tracks) == 0  # evicted

    # object reappears at the same location within the resurrection window
    tr.step([box], ts=float(11))
    assert len(tr.tracks) == 1
    assert tr.tracks[0].track_id == first_id  # ID preserved, not re-seeded


def test_enter_exit_reappearance_keeps_identity_vod():
    """Player exits screen (no detection) then re-enters at a nearby spot within
    the window -> same identity, no re-seed."""
    tr = IoUTracker(capacity=3, lost_before_evict=2, resurrect_window_frames=30)
    box = (0.5, 0.5, 0.7, 0.7)
    for ts in range(1, 4):
        tr.step([box], ts=float(ts))
    first_id = _ids(tr.tracks)[0]
    for ts in range(4, 10):  # off screen (>2 evicts)
        tr.step([], ts=float(ts))
    assert len(tr.tracks) == 0
    # re-enters near the same place
    tr.step([(0.52, 0.52, 0.72, 0.72)], ts=float(11))
    assert tr.tracks[0].track_id == first_id


def test_single_spurious_detection_does_not_fragment_identity():
    """A single short-lived detection must not grab the slot and fragment an
    established track's ID. With confirmation, a one-shot box is dropped before
    it can become a competing identity."""
    tr = IoUTracker(capacity=2, lost_before_evict=3, confirm_frames=2, resurrect_window_frames=20)
    real = (0.2, 0.2, 0.4, 0.4)
    for ts in range(1, 4):
        tr.step([real], ts=float(ts))
    real_id = _ids(tr.tracks)[0]
    # a spurious detection appears once (ghost far away), then vanishes
    tr.step([real, (0.75, 0.75, 0.9, 0.9)], ts=float(4))
    tr.step([real], ts=float(5))  # spurious gone next frame
    tr.step([real], ts=float(6))
    ids = [t.track_id for t in tr.tracks]
    assert real_id in ids
    # the real object's identity is unchanged
    assert tr.tracks[0].track_id == real_id


def test_max_concurrent_never_exceeds_cap_with_resurrection():
    """Resurrection reuses a slot already freed by eviction, so max concurrent
    tracks never exceed the VOD cap of 8."""
    tr = IoUTracker(capacity=VOD_MAX_TRACKS, lost_before_evict=3, resurrect_window_frames=25)
    # 8 objects present -> 8 tracks
    boxes = [(0.1 * i, 0.1 * i, 0.1 * i + 0.05, 0.1 * i + 0.05) for i in range(8)]
    for ts in range(1, 5):
        tr.step(boxes, ts=float(ts))
    assert len(tr.tracks) == 8
    # all drop out (evicted), all reappear over some frames -> still <= 8
    for ts in range(5, 12):
        tr.step([], ts=float(ts))
    for i, b in enumerate(boxes):
        tr.step([b], ts=float(12 + i))
        assert len(tr.tracks) <= VOD_MAX_TRACKS

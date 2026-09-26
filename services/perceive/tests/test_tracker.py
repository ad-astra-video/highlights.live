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


def test_tracker_seeds_tracks_with_in_roster_label_not_unknown():
    """ADAAAA-5056: a track created from a closed-vocab detection must carry the
    gated label (and a derived kind), never a hard-coded "unknown", so the box
    the user sees on the frame reads "player"/"soccer ball" not "unknown"."""
    tr = IoUTracker(capacity=3)
    tracks = tr.step(
        [(0.1, 0.1, 0.3, 0.3), (0.5, 0.5, 0.7, 0.7)],
        ts=1.0,
        labels=["player", "soccer ball"],
    )
    by_slot = {t.slot: t for t in tracks}
    # player track
    t0 = by_slot[0]
    assert t0.label == "player"
    assert t0.kind == "player"
    # soccer ball track
    t1 = by_slot[1]
    assert t1.label == "soccer ball"
    assert t1.kind == "ball"
    # nothing labelled "unknown"
    assert all(t.label != "unknown" for t in tracks)
    assert "unknown" not in {t.kind for t in tracks}


def test_tracker_labels_absent_keeps_legacy_default():
    """Back-compat: when no labels are provided (stub path), tracks keep the
    previous kind="unknown" default so existing behaviour is unchanged."""
    tr = IoUTracker(capacity=2)
    tracks = tr.step([(0.1, 0.1, 0.3, 0.3)], ts=1.0)
    assert tracks[0].kind == "unknown"
    assert tracks[0].label == ""


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


# --- ADAAAA-5069 VOD identity hardening -------------------------------------

def test_confirm_gate_prevents_spurious_slot_squat():
    """A single-frame spurious detection must not become a confirmed identity
    that squats a slot and drops a real object the same frame (the real-video
    VOD churn QA measured in ADAAAA-5062). The confirm gate keeps the blip
    TENTATIVE and recycles it at capacity so a real player is never dropped."""
    tr = IoUTracker(capacity=2, lost_before_evict=8, confirm_frames=2)
    # F1: real player A + one-frame spurious blip B (both new -> tentative)
    t1 = tr.step([(0.1, 0.1, 0.25, 0.3), (0.8, 0.05, 0.95, 0.15)], ts=1.0)
    assert all(not t.confirmed for t in t1)  # nothing confirmed after ONE frame
    # F2: A + a NEW real player C on the right; B's spurious box is gone.
    t2 = tr.step([(0.1, 0.1, 0.25, 0.3), (0.5, 0.5, 0.65, 0.6)], ts=2.0)
    # C gets a slot (the tentative B slot is recycled, not B squatting it):
    c = next((t for t in t2 if t.slot == 1 and t.bbox[0] > 0.4), None)
    assert c is not None, "real player C must not be dropped because a blip squatted slot 1"


def test_confirm_requires_stable_detections_before_commit():
    """A track only becomes a real identity after `confirm_frames` consecutive
    matched frames; a one-shot detection stays tentative and is evicted fast if
    it never repeats (no long-lived ghost identity)."""
    tr = IoUTracker(capacity=2, confirm_frames=3, unconfirmed_max_lost=2)
    # one detection then never again (spurious)
    tr.step([(0.1, 0.1, 0.3, 0.3)], ts=1.0)
    tr.step([], ts=2.0)   # lost 1
    tr.step([], ts=3.0)   # lost 2
    t4 = tr.step([], ts=4.0)  # lost 3 > unconfirmed_max_lost=2 -> tentative evicted
    assert len(t4) == 0, "a never-repeated detection must not linger as a ghost identity"


def test_dropout_tolerant_revival_preserves_track_id():
    """A CONFIRMED track that is briefly missed (detection dropout) is revived
    with the SAME trackId when the object reappears near its predicted position,
    instead of re-seeding a new identity (the dominant VOD failure)."""
    tr = IoUTracker(capacity=2, confirm_frames=2, unconfirmed_max_lost=2, lost_before_evict=8)
    pid = None
    # establish + confirm the player: frame 0 CREATES the track (not a match),
    # frames 1-2 give it the confirm_frames=2 consecutive matches to commit.
    for f in range(3):
        tr.step([(0.3, 0.3, 0.45, 0.5)], ts=float(f))
    confirmed = tr.tracks[0]
    assert confirmed.confirmed
    pid = confirmed.track_id
    # detection dropout: player missed for 3 frames (a spurious blip elsewhere
    # appears, but the real player's slot simply carries no box)
    tr.step([], ts=2.0)
    tr.step([(0.8, 0.1, 0.95, 0.2)], ts=3.0)
    tr.step([], ts=4.0)
    # player reappears at ~same predicted position -> SAME trackId survives
    tr.step([(0.31, 0.31, 0.46, 0.51)], ts=5.0)
    reappeared = next((t for t in tr.tracks if abs(t.bbox[0] - 0.3) < 0.2), None)
    assert reappeared is not None
    assert reappeared.track_id == pid, "identity must survive a short detection gap"

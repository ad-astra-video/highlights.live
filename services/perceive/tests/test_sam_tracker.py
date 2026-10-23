"""Handoff logic of the Florence+SAM3 HybridTracker, tested with a stub SAM
backend + a counting Florence detector (no real model required)."""
import numpy as np

from app.sam_tracker import HybridTracker, SamBackend


def _white(h=64, w=64):
    return np.full((h, w, 3), 128, np.uint8)


class StubBackend(SamBackend):
    """plan: list of {slot: box|None} rows, indexed by advance call; last repeats."""
    def __init__(self, plan):
        self.plan = plan
        self.row = 0
        self._cur = {}

    def ready(self):
        return True

    def advance(self, prompts):
        self._cur = self.plan[min(self.row, len(self.plan) - 1)]
        self.row += 1

    def get(self, slot):
        return self._cur.get(slot)


class CountingBackend(SamBackend):
    """Tracks how many SAM advances happen (gating test) and returns boxes."""

    def __init__(self, box_map=None, miss_frames=0):
        self.box_map = box_map or {}
        self.miss_frames = miss_frames
        self._miss_left = miss_frames
        self.advances = 0

    def ready(self):
        return True

    def advance(self, prompts):
        self.advances += 1
        self._cur = dict(prompts)  # simulate propagation to the same prompts

    def get(self, slot):
        return self._cur.get(slot)


class CountingDetect:
    def __init__(self, detections):
        self.detections = detections
        self.calls = 0

    def __call__(self, frame_rgb):
        self.calls += 1
        return [{"label": "person", "confidence": 1.0, "bbox": b} for b in self.detections]


def _slots(tracks):
    return sorted(t.slot for t in tracks)


def test_idle_frame_does_not_run_sam():
    # Rule: SAM must not run when nothing has been identified for tracking.
    be = CountingBackend()
    tr = HybridTracker(detect=None, backend=be)
    tracks = tr.step_frame(_white(), 0.0, florence_boxes=[])  # no identifications
    assert be.advances == 0          # SAM never called
    assert tr._prompts == {}         # nothing seeded
    assert tracks == []              # no tracks started


def test_idle_frames_only_never_engage_sam():
    be = CountingBackend()
    tr = HybridTracker(detect=None, backend=be)
    for ts in range(5):
        tr.step_frame(_white(), float(ts), florence_boxes=[])
    assert be.advances == 0          # an empty stream never pays SAM compute
    assert tr._prompts == {}


def test_florence_identification_bootstraps_sam():
    # Rule: Florence identifies -> seeds SAM, which then tracks (advance runs).
    be = CountingBackend()
    tr = HybridTracker(detect=None, backend=be)
    tr.step_frame(_white(), 0.0, florence_boxes=[(0.2, 0.2, 0.4, 0.4)])
    assert be.advances == 1          # SAM advanced exactly once for the seed frame
    assert len(tr._prompts) == 1     # the identification became a tracked prompt
    assert len(tr.tracks) == 1
    # subsequent frames with the prompt carried forward keep advancing SAM
    tr.step_frame(_white(), 1.0, florence_boxes=[(0.2, 0.2, 0.4, 0.4)])
    assert be.advances == 2


def test_no_backend_falls_back_to_florence_boxes():
    tr = HybridTracker(detect=None, backend=None)
    boxes = [(0.2, 0.2, 0.4, 0.4), (0.6, 0.6, 0.8, 0.8)]
    tracks = tr.step_frame(_white(), 0.0, boxes)
    assert _slots(tracks) == [0, 1]
    assert len(tracks) == 2


def test_sam_propagate_updates_prompt_and_feeds_iou():
    plan = [{0: (0.20, 0.20, 0.40, 0.40)},
            {0: (0.24, 0.22, 0.44, 0.42)},
            {0: (0.28, 0.24, 0.48, 0.44)}]
    tr = HybridTracker(detect=None, backend=StubBackend(plan))
    tr.seed((0.2, 0.2, 0.4, 0.4), slot=0, ts=0.0)
    for i, ts in enumerate([1.0, 2.0, 3.0]):
        tracks = tr.step_frame(_white(), ts)
        assert len(tracks) == 1
        assert round(tracks[0].bbox[0], 2) == plan[i][0][0]
    # prompt carried forward to the last propagated box
    assert round(tr._prompts[0][0], 2) == 0.28


def test_sam_loss_triggers_florence_redetect():
    # backend returns a box once, then None (target lost)
    plan = [{0: (0.2, 0.2, 0.4, 0.4)},
            {0: None}, {0: None}]
    det = CountingDetect([(0.10, 0.10, 0.30, 0.30)])
    tr = HybridTracker(detect=det, backend=StubBackend(plan), lost_before_redetect=1, redetect_every=999)
    tr.seed((0.2, 0.2, 0.4, 0.4), slot=0, ts=0.0)
    tr.step_frame(_white(), 1.0)   # SAM box -> no redetect
    tr.step_frame(_white(), 2.0)   # SAM None -> miss=1
    tr.step_frame(_white(), 3.0)   # miss>=1 -> Florence re-detect; reseed repopulated prompts
    assert det.calls >= 1
    assert len(tr._prompts) >= 1


def test_redetect_cadence_forces_florence():
    plan = [{0: (0.2, 0.2, 0.4, 0.4)}] * 100  # SAM never loses it
    det = CountingDetect([(0.1, 0.1, 0.3, 0.3)])
    tr = HybridTracker(detect=det, backend=StubBackend(plan), redetect_every=3, lost_before_redetect=99)
    tr.seed((0.2, 0.2, 0.4, 0.4), slot=0, ts=0.0)
    tr.step_frame(_white(), 1.0); assert det.calls == 0
    tr.step_frame(_white(), 2.0); assert det.calls == 0
    tr.step_frame(_white(), 3.0); assert det.calls >= 1  # since_detect(3) >= redetect_every(3)
    tr.step_frame(_white(), 4.0); assert det.calls == 1   # cadence reset after re-detect


def test_user_seed_reprompts_sam():
    plan = [{0: None}]
    det = CountingDetect([(0.5, 0.5, 0.7, 0.7)])
    tr = HybridTracker(detect=det, backend=StubBackend(plan), lost_before_redetect=99)
    tr.seed((0.2, 0.2, 0.4, 0.4), slot=0, ts=0.0)
    assert tr._prompts[0] == (0.2, 0.2, 0.4, 0.4)
    tr.seed((0.5, 0.5, 0.7, 0.7), slot=0, ts=1.0)  # user changed target -> re-prompted
    assert tr._prompts[0] == (0.5, 0.5, 0.7, 0.7)


# --- ADAAAA-7217 (Increment A): dedicated locked ball SAM slot ----------------
def _ball_prop_plan(ball_slot):
    """SAM plan: the ball slot propagates forward 3 frames; a player slot holds."""
    return [
        {ball_slot: (0.20, 0.20, 0.40, 0.40)},
        {ball_slot: (0.24, 0.22, 0.44, 0.42)},
        {ball_slot: (0.28, 0.24, 0.48, 0.44)},
    ]


def test_ball_slot_seeded_and_tracked_by_sam():
    # Florence identifies the ball -> a dedicated locked SAM slot tracks it.
    tr = HybridTracker(detect=None, backend=CountingBackend(), ball_label="soccer ball")
    assert tr.ball_live is False
    tr.seed_ball((0.2, 0.2, 0.4, 0.4), ts=0.0)
    assert tr.ball_live is True
    assert tr.ball_box() == (0.2, 0.2, 0.4, 0.4)
    # advances SAM -> the ball is held + feeds a ball track
    tr.step_frame(_white(), 1.0)
    assert tr.ball_live is True
    assert tr.ball_box() == (0.2, 0.2, 0.4, 0.4)
    assert any(t.kind == "ball" for t in tr.tracks)
    # the ball slot is locked so it is never auto-evicted
    assert tr._ball_slot in tr._iou.locked


def test_ball_slot_propagates_forward():
    tr = HybridTracker(detect=None, backend=StubBackend(_ball_prop_plan(0)), ball_label="soccer ball")
    tr.seed_ball((0.2, 0.2, 0.4, 0.4), ts=0.0)
    for i, ts in enumerate([1.0, 2.0, 3.0]):
        tr.step_frame(_white(), ts)
        assert round(tr.ball_box()[0], 2) == _ball_prop_plan(0)[i][0][0]


def test_ball_slot_holds_last_box_on_miss():
    # Eviction guard: a short SAM miss holds the last known box (not lost).
    tr = HybridTracker(detect=None, backend=StubBackend([{0: (0.2, 0.2, 0.4, 0.4)}, {0: None}]), ball_label="soccer ball", ball_hold_frames=5)
    tr.seed_ball((0.2, 0.2, 0.4, 0.4), ts=0.0)
    tr.step_frame(_white(), 1.0)   # SAM present
    tr.step_frame(_white(), 2.0)   # SAM miss -> held
    assert tr.ball_live is True
    assert tr.ball_miss_frames == 1
    assert tr.ball_box() == (0.2, 0.2, 0.4, 0.4)   # held box still emitted
    assert not tr.ball_needs_redetect()


def test_ball_slot_reports_redetect_after_sustained_loss():
    # Beyond the hold window the ball is absent and needs Florence re-identify.
    tr = HybridTracker(detect=None, backend=StubBackend([{0: (0.2, 0.2, 0.4, 0.4)}] + [{0: None}] * 6), ball_label="soccer ball", ball_hold_frames=2)
    tr.seed_ball((0.2, 0.2, 0.4, 0.4), ts=0.0)
    for ts in range(1, 7):
        tr.step_frame(_white(), float(ts))
    assert tr.ball_miss_frames >= 2
    assert tr.ball_needs_redetect() is True
    assert tr.ball_box() is None


def test_ball_not_evicted_after_long_loss():
    # The dedicated slot is locked: even after many lost frames it survives.
    tr = HybridTracker(detect=None, backend=StubBackend([{0: (0.2, 0.2, 0.4, 0.4)}] + [{0: None}] * 20), ball_label="soccer ball", lost_before_evict=4, ball_hold_frames=2)
    tr.seed_ball((0.2, 0.2, 0.4, 0.4), ts=0.0)
    for ts in range(1, 20):
        tr.step_frame(_white(), float(ts))
    assert tr.ball_live is True
    assert any(t.kind == "ball" for t in tr.tracks)


# --- ADAAAA-7243: player-by-number track keeps its label/accuracy on redetect --
def test_player_number_track_keeps_label_across_redetect():
    # A seeded player-by-number slot (selected, label "player #9") must survive
    # the redetect cadence. The per-frame soccer roster only reports ball/goal
    # (players are detected on demand); _reseed_from's nearest-box refresh used
    # to ADOPT the nearest detection REGARDLESS of class, so a "goal" box near
    # the player clobbered the "player #9" label -> the track stopped surfacing
    # as a selected "player #" track and the measure harness read accuracy=None.
    plan = [{1: (0.40, 0.40, 0.55, 0.70)}] * 8   # player SAM slot 1 persists
    tr = HybridTracker(detect=None, backend=StubBackend(plan), ball_label="soccer ball",
                       redetect_every=3, lost_before_redetect=99, capacity=8)
    tr.seed((0.40, 0.40, 0.55, 0.70), slot=1, ts=0.0, kind="player",
            label="player #9", selected=True)
    tr.seed_ball((0.40, 0.40, 0.50, 0.50), ts=0.0)   # ball slot 0 (ball-first)
    goal = (0.38, 0.42, 0.52, 0.66)                  # different-class box near player
    # Drive past the redetect cadence; per-frame roster only ever yields ball/goal,
    # and the goal is the nearest detection to the player slot.
    for ts in range(1, 7):
        tr.step_frame(_white(), float(ts), florence_boxes=[goal], labels=["goal"])
    player_track = next(t for t in tr.tracks if t.kind == "player")
    assert player_track.selected is True
    assert player_track.label == "player #9"     # identity preserved, not clobbered to "goal"
    assert player_track.accuracy is not None      # continuity accuracy still computable


# --- ADAAAA-7305: selected player stays ON-SCREEN across the redetect cadence --
def test_selected_player_track_stays_on_screen_across_redetect():
    # A selected `player #N` track (SAM-propagated, label "player #1") must NOT
    # register as "lost" on the Florence redetect frames. `_sam_step` used to
    # return the raw Florence detections on a redetect frame, which DROPPED the
    # SAM-propagated player box -> the selected track's onto_frames stayed 0 and
    # accuracy None / onScreen False on the measure harness. The redetect frame
    # must feed the IoU layer the SAM-propagated tracked boxes, keeping the
    # selected track matched (lost_frames == 0) and its accuracy computable.
    plan = [{0: (0.20, 0.20, 0.40, 0.40), 2: (0.45, 0.30, 0.55, 0.45)}] * 12
    tr = HybridTracker(detect=None, backend=StubBackend(plan), ball_label="soccer ball",
                       redetect_every=3, lost_before_evict=8, lost_before_redetect=99,
                       capacity=8)
    tr.seed((0.45, 0.30, 0.55, 0.45), slot=2, ts=0.0, kind="player",
            label="player #1", selected=True)
    tr.seed_ball((0.20, 0.20, 0.40, 0.40), ts=0.0)          # ball slot 0
    goal = (0.60, 0.60, 0.80, 0.80)                          # default-roster structure box
    # Drive past several redetect cadences; per-frame roster only ever yields goal.
    for ts in range(1, 13):
        tr.step_frame(_white(), float(ts), florence_boxes=[goal], labels=["goal"])
    pl = next(t for t in tr.tracks if t.kind == "player")
    assert pl.selected is True
    assert pl.label == "player #1"
    assert pl.lost_frames == 0                 # never spuriously lost on redetect
    assert pl.accuracy is not None
    assert pl.accuracy >= 0.90                 # >=90% continuity target


def test_operator_selected_player_slot_is_not_auto_evicted():
    # An operator-selected `player #N` slot is pinned (like the ball slot) so a
    # SAM-propagation gap cannot auto-evict the chosen track and drop the metric
    # to None (the track must stay surfaceable to report accuracy).
    # Plan: the player slot's SAM box is ABSENT from frame 2 onward (a long gap).
    plan = [{2: (0.45, 0.30, 0.55, 0.45)}, {2: None}] + [{2: None}] * 20
    tr = HybridTracker(detect=None, backend=StubBackend(plan), ball_label="soccer ball",
                       lost_before_evict=4, lost_before_redetect=99, capacity=8)
    tr.seed((0.45, 0.30, 0.55, 0.45), slot=2, ts=0.0, kind="player",
            label="player #1", selected=True)
    tr.lock(2)                                 # track-player pins the selected slot
    for ts in range(1, 22):
        tr.step_frame(_white(), float(ts), florence_boxes=[])
    assert any(t.slot == 2 and t.kind == "player" for t in tr.tracks)  # not evicted

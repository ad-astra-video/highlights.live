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

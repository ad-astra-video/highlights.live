"""Per-frame Sam3Backend logic against a fake predictor that mimics the SAM 3
repo's client surface (handle_request / handle_stream_request / obj_id_to_mask),
so the state machine + geometry are testable without triton/weights/GPU."""
import numpy as np
import pytest

from app.sam3_backend import Sam3Backend, box_to_point, box_to_points, mask_to_bbox
from app.sam_tracker import HybridTracker


def _mask(active, h=16, w=16):
    """Return a (h,w) bool mask (or None for 'absent') for a normalized bbox."""
    if active is None:
        return None
    x1, y1, x2, y2 = active
    m = np.zeros((h, w), bool)
    m[int(y1 * h) : max(int(y2 * h), int(y1 * h) + 1),
      int(x1 * w) : max(int(x2 * w), int(x1 * w) + 1)] = True
    return m


class FakePredictor:
    """Repo-shaped predictor.

    frames: list of {obj_id: normalized bbox|None}; index advances per
    propagate request (last row repeats). Tracks prompts added per obj_id and
    counts resets, so tests can assert target-change behaviour.
    """
    def __init__(self, frames):
        self.frames = frames
        self.row = 0
        self.prompts = {}
        self.boxes = {}
        self.resets = 0
        self.session = None
        self.starts = []

    def handle_request(self, req):
        t = req["type"]
        if t == "start_session":
            self.session = req["resource_path"]
            return {"session_id": "s1"}
        if t == "reset_session":
            self.resets += 1
            return {}
        if t == "add_prompt":
            # ADAAAA-7305: mirror the real SAM3 client's add_prompt contract —
            # the model asserts points XOR boxes (sending both raises), and the
            # obj_id TRACKER path requires `points`. Record what was sent so
            # tests can assert the tracker prompt form.
            pts = req.get("points")
            boxes = req.get("bounding_boxes")
            if pts is not None and boxes is not None:
                raise AssertionError(
                    "points and bounding_boxes are mutually exclusive in add_prompt"
                )
            self.prompts[int(req["obj_id"])] = (
                req["frame_index"],
                tuple(np.asarray(req["points"])[0].tolist()) if pts is not None else None,
            )
            self.boxes[int(req["obj_id"])] = (
                tuple(np.asarray(boxes).reshape(-1).tolist()) if boxes is not None else None,
            )
            return {}
        return {}

    def handle_stream_request(self, req):
        # ADAAAA-7305: the real SAM3 client reads `start_frame_index` (with
        # "index"); mirror that key so a wrong key in Sam3Backend fails here
        # instead of silently re-tracking from frame 0 on the GPU box.
        if "start_frame_index" not in req:
            raise KeyError(
                "propagate request must use `start_frame_index` (SAM3 reads this key; "
                "`start_frame_idx` is silently dropped -> never advances)"
            )
        start = req["start_frame_index"]
        self.starts.append(start)
        row = self.frames[min(start, len(self.frames) - 1)]
        masks = {oid: _mask(b) for oid, b in row.items() if b is not None}
        yield {
            "frame_index": start,
            "outputs": {"obj_id_to_mask": masks},
        }


def _make(
    frames,
    clip="x.mp4",
    blue=((0.2, 0.2, 0.4, 0.4), (0.6, 0.6, 0.8, 0.8)),
    red=((0.5, 0.5, 0.7, 0.7),),
):
    fake = FakePredictor(frames)
    backend = Sam3Backend(predictor_factory=lambda: fake, clip_path=clip)
    return fake, backend


def _white(h=64, w=64):
    return np.full((h, w, 3), 128, np.uint8)


# --- backend unit tests -----------------------------------------------------
def test_ready_requires_start_session():
    fake, backend = _make([{0: (0.2, 0.2, 0.4, 0.4)}])
    assert backend.ready()
    assert fake.session == "x.mp4"


def test_ready_false_without_clip():
    fake = FakePredictor([{0: (0.2, 0.2, 0.4, 0.4)}])
    b = Sam3Backend(predictor_factory=lambda: fake, clip_path=None)
    assert not b.ready()  # no clip -> no session -> fallthrough to Florence


def test_mask_to_bbox_unit():
    m = np.zeros((10, 20), bool)
    m[2:6, 4:12] = True
    b = mask_to_bbox(m, 10, 20)
    assert b == (4 / 20, 2 / 10, 12 / 20, 6 / 10)


def test_mask_to_bbox_empty_is_none():
    assert mask_to_bbox(np.zeros((10, 10), bool), 10, 10) is None


def test_box_to_point_normalized_center():
    p = box_to_point((0.2, 0.2, 0.4, 0.4))
    assert p[0][0] == pytest.approx(0.3) and p[0][1] == pytest.approx(0.3)


def test_advance_steps_one_frame_and_serves_multi_slots():
    fake, backend = _make([
        {0: (0.2, 0.2, 0.4, 0.4), 1: (0.6, 0.6, 0.8, 0.8)},
        {0: (0.3, 0.2, 0.5, 0.4), 1: (0.6, 0.6, 0.8, 0.8)},
    ])
    assert backend.ready()

    backend.advance({0: (0.2, 0.2, 0.4, 0.4), 1: (0.6, 0.6, 0.8, 0.8)})
    assert backend.get(0) is not None and backend.get(1) is not None
    assert backend.get(0)[0] == pytest.approx(0.2, abs=0.06)
    assert backend.get(1)[0] == pytest.approx(0.6, abs=0.06)

    backend.advance({0: (0.2, 0.2, 0.4, 0.4), 1: (0.6, 0.6, 0.8, 0.8)})
    assert backend.get(0)[0] == pytest.approx(0.3, abs=0.06)   # single frame stepped
    assert backend.get(1)[0] == pytest.approx(0.6, abs=0.06)


def test_slot_absent_returns_none():
    fake, backend = _make([{0: (0.2, 0.2, 0.4, 0.4)}, {0: None}, {0: None}])
    backend.advance({0: (0.2, 0.2, 0.4, 0.4), 1: (0.6, 0.6, 0.8, 0.8)})
    assert backend.get(0) is not None and backend.get(1) is None
    backend.advance({0: (0.2, 0.2, 0.4, 0.4), 1: (0.6, 0.6, 0.8, 0.8)})
    assert backend.get(0) is None  # absent this frame


def test_target_change_resets_and_readds():
    fake, backend = _make([{0: (0.2, 0.2, 0.4, 0.4)}] * 10)
    backend.advance({0: (0.2, 0.2, 0.4, 0.4)})
    assert fake.resets == 0
    assert fake.prompts[0][1][0] == pytest.approx(0.3)
    # user changes the target -> new prompt -> reset + re-add, frame advances on
    backend.advance({0: (0.7, 0.7, 0.9, 0.9)})
    assert fake.resets == 1
    assert fake.prompts[0][1][0] == pytest.approx(0.8)
    assert backend.get(0) is not None  # next frame still returns its mask


def test_propagate_advances_via_start_frame_index():
    # ADAAAA-7305: the SAM3 client reads `start_frame_index` (not
    # `start_frame_idx`). A wrong key silently drops the start to None and SAM3
    # re-tracks from the earliest annotation frame on EVERY call, so the player
    # slot never advances and reports no per-frame mask (accuracy ~0.2). Assert
    # the backend sends the correct key and steps one frame forward per advance.
    fake, backend = _make([
        {0: (0.2, 0.2, 0.4, 0.4)},
        {0: (0.3, 0.2, 0.5, 0.4)},
        {0: (0.4, 0.2, 0.6, 0.4)},
        {0: (0.5, 0.2, 0.7, 0.4)},
    ])
    assert backend.ready()
    box = (0.2, 0.2, 0.4, 0.4)
    for _ in range(3):
        backend.advance({0: box})
    # the fake would have raised KeyError if the key were `start_frame_idx`
    assert fake.starts == [0, 1, 2]           # advances frame-by-frame
    # and the returned box tracks the object as it drifts right
    b0 = backend.get(0)
    assert b0 is not None and b0[0] > 0.2


def test_add_prompt_uses_points_tracker_path_not_boxes():
    # ADAAAA-7305: obj_id-based video tracking uses SAM3's TRACKER prompt path,
    # which requires `points`+`obj_id` and FORBIDS `bounding_boxes` at the same
    # time (the model asserts points XOR boxes). A prior fix tried to also send
    # `bounding_boxes` for the large `player #N`, which crashes the real client.
    # Assert the backend sends ONLY the center-point tracker prompt for the
    # operator-selected player, so a future change cannot re-introduce the crash.
    fake, backend = _make([{0: (0.455, 0.264, 0.551, 0.437)}] * 3)
    assert backend.ready()
    box = (0.455, 0.264, 0.551, 0.437)  # the real tight #1 player box
    backend.advance({0: box})
    # center point sent (tracker path)
    fi, ppt = fake.prompts[0]
    assert fi == 0
    assert ppt is not None and ppt[0] == pytest.approx((0.455 + 0.551) / 2, abs=1e-6)
    assert ppt[1] == pytest.approx((0.264 + 0.437) / 2, abs=1e-6)
    # no box sent (the fake raises if both points+boxes are present)
    assert fake.boxes[0] == (None,)
    assert backend.get(0) is not None


# --- HybridTracker integration ----------------------------------------------
class CountingDetect:
    def __init__(self, detections):
        self.detections = detections
        self.calls = 0

    def __call__(self, frame_rgb):
        self.calls += 1
        return [{"label": "person", "confidence": 1.0, "bbox": b} for b in self.detections]


def test_hybrid_sam_multi_slot_across_frames():
    # two targets that drift right over three frames, all tracked by SAM
    frames = [
        {0: (0.20, 0.20, 0.40, 0.40), 1: (0.60, 0.60, 0.80, 0.80)},
        {0: (0.25, 0.20, 0.45, 0.40), 1: (0.65, 0.60, 0.85, 0.80)},
        {0: (0.30, 0.20, 0.50, 0.40), 1: (0.70, 0.60, 0.90, 0.80)},
    ]
    fake, backend = _make(frames)
    tr = HybridTracker(detect=None, backend=backend, redetect_every=999, lost_before_redetect=99)
    tr.seed((0.2, 0.2, 0.4, 0.4), slot=0, ts=0.0)
    tr.seed((0.6, 0.6, 0.8, 0.8), slot=1, ts=0.0)
    for i, ts in enumerate([1.0, 2.0, 3.0]):
        tracks = tr.step_frame(_white(), ts)
        assert len(tracks) == 2
    assert fake.session == "x.mp4"
    # SAM carried both targets forward as they drifted right => prompts moved
    # RIGHT of their seeds and no spurious reset happened (drift != target change)
    assert fake.resets == 0
    assert tr._prompts[0][0] > 0.2
    assert tr._prompts[1][0] > 0.6


def test_hybrid_sam_loss_triggers_florence_redetect():
    frames = [{0: (0.2, 0.2, 0.4, 0.4)}, {0: None}, {0: None}]
    fake, backend = _make(frames)
    det = CountingDetect([(0.1, 0.1, 0.3, 0.3)])
    tr = HybridTracker(detect=det, backend=backend, lost_before_redetect=1, redetect_every=999)
    tr.seed((0.2, 0.2, 0.4, 0.4), slot=0, ts=0.0)
    tr.step_frame(_white(), 1.0)  # SAM box
    tr.step_frame(_white(), 2.0)  # SAM None -> miss=1
    tr.step_frame(_white(), 3.0)  # miss>=1 -> Florence re-detect + reseed
    assert det.calls >= 1
    assert len(tr._prompts) >= 1  # reseed repopulated prompts


# --- ADAAAA-7345: mid-stream masklet recovery + player point calibration -----
class StrictSinglePointPredictor(FakePredictor):
    """Rejects multi-point prompts the way an older client build would."""

    def handle_request(self, req):
        if req.get("type") == "add_prompt" and len(np.asarray(req["points"])) > 1:
            raise RuntimeError("multi-point prompts unsupported")
        return super().handle_request(req)


def test_box_to_points_ball_single_player_cluster():
    # small (ball-sized) box keeps the verified single center point
    ball = box_to_points((0.500, 0.500, 0.510, 0.510))
    assert ball.shape == (1, 2)
    assert ball[0][0] == pytest.approx(0.505)
    # player-sized box gets a center-first positive cluster inside the box
    player = box_to_points((0.455, 0.264, 0.551, 0.437))
    assert player.shape == (5, 2)
    assert player[0][0] == pytest.approx((0.455 + 0.551) / 2)
    assert player[0][1] == pytest.approx((0.264 + 0.437) / 2)
    assert bool(((player[:, 0] >= 0.455) & (player[:, 0] <= 0.551)).all())
    assert bool(((player[:, 1] >= 0.264) & (player[:, 1] <= 0.437)).all())


def test_recover_readds_prompt_after_masklet_loss():
    # SAM loses the mid-stream object on frames 1-2 and never re-registers it by
    # itself (real SAM3 behaviour: dropped masklets stay dropped). The backend
    # must re-anchor the slot's prompt at the CURRENT frame so tracking resumes.
    frames = [
        {0: (0.2, 0.2, 0.4, 0.4)},
        {0: None},
        {0: None},
        {0: (0.2, 0.2, 0.4, 0.4)},
    ]
    fake, backend = _make(frames)
    box = (0.2, 0.2, 0.4, 0.4)
    backend.advance({0: box})
    assert backend.get(0) is not None
    assert fake.prompts[0][0] == 0
    backend.advance({0: box})
    assert backend.get(0) is None          # lost this frame
    backend.advance({0: box})              # -> recovery re-adds at frame 2
    assert fake.prompts[0][0] == 2
    backend.advance({0: box})
    assert backend.get(0) is not None      # tracking resumed


def test_recover_stops_after_max_misses():
    fake, backend = _make([{0: (0.2, 0.2, 0.4, 0.4)}] + [{0: None}] * 60)
    backend.recover_max_misses = 5
    adds = {"n": 0}
    orig = fake.handle_request

    def counting(req):
        if req.get("type") == "add_prompt":
            adds["n"] += 1
        return orig(req)

    fake.handle_request = counting
    box = (0.2, 0.2, 0.4, 0.4)
    for _ in range(20):
        backend.advance({0: box})
    assert adds["n"] == 1 + 5     # initial seed + capped recoveries, then stop


def test_recover_does_not_readd_while_tracking():
    frames = [{0: (0.2, 0.2, 0.4, 0.4)}] * 10
    fake, backend = _make(frames)
    adds = {"n": 0}
    orig = fake.handle_request

    def counting(req):
        if req.get("type") == "add_prompt":
            adds["n"] += 1
        return orig(req)

    fake.handle_request = counting
    box = (0.2, 0.2, 0.4, 0.4)
    for _ in range(5):
        backend.advance({0: box})
    assert adds["n"] == 1         # healthy track is never re-prompted


def test_add_prompt_falls_back_to_single_point_when_cluster_rejected():
    fake = StrictSinglePointPredictor([{0: (0.455, 0.264, 0.551, 0.437)}] * 3)
    backend = Sam3Backend(predictor_factory=lambda: fake, clip_path="x.mp4")
    box = (0.455, 0.264, 0.551, 0.437)
    backend.advance({0: box})
    fi, pt = fake.prompts[0]
    assert fi == 0
    assert pt is not None
    assert pt[0] == pytest.approx((0.455 + 0.551) / 2)
    assert backend.get(0) is not None


# --- ADAAAA-7820: clip frame index, mask-derived re-anchor, fresh obj_id -----
def test_advance_uses_clip_frame_index_for_midstream_prompt():
    # A mid-stream seed must annotate the CLIP frame it was seeded on, not the
    # backend's own advance counter (which is 0 when SAM was idle before the
    # seed -> SAM re-tracks from frame 0 and drops the masklet in ~12 frames).
    fake, backend = _make([{0: (0.2, 0.2, 0.4, 0.4)}] * 60)
    assert backend.ready()
    backend.advance({0: (0.2, 0.2, 0.4, 0.4)}, frame_index=52)
    assert fake.prompts[0][0] == 52
    assert fake.starts == [52]


def test_hybrid_tracker_passes_clip_frame_index_even_when_sam_idle():
    class FrameIndexBackend:
        supports_frame_index = True
        def __init__(self):
            self.seen = []
            self._cur = {}
        def ready(self):
            return True
        def advance(self, prompts, frame_index=None):
            self.seen.append(frame_index)
            self._cur = dict(prompts)
        def get(self, slot):
            return self._cur.get(slot)

    b = FrameIndexBackend()
    tr = HybridTracker(backend=b, redetect_every=999, lost_before_redetect=99)
    tr.seed((0.2, 0.2, 0.4, 0.4), slot=0, ts=0.0)
    for ts in (1.0, 2.0, 3.0):
        tr.step_frame(_white(), ts)
    assert b.seen == [0, 1, 2]


def test_reanchor_prompt_comes_from_last_accepted_mask():
    # SAM drifts the box right, then loses it: the re-anchor prompt must be the
    # last ACCEPTED MASK bbox (mask-derived), not the stale seed/OD box.
    frames = [
        {0: (0.20, 0.20, 0.40, 0.40)},
        {0: (0.30, 0.20, 0.50, 0.40)},
        {0: None},
        {0: (0.30, 0.20, 0.50, 0.40)},
    ]
    fake, backend = _make(frames)
    backend.advance({0: (0.2, 0.2, 0.4, 0.4)}, frame_index=0)
    backend.advance({0: (0.3, 0.2, 0.5, 0.4)}, frame_index=1)
    last_mask = backend.get(0)
    assert last_mask is not None and last_mask[0] > 0.2   # mask-derived, drifted right
    backend.advance({0: (0.3, 0.2, 0.5, 0.4)}, frame_index=2)   # lost this frame
    assert backend.get(0) is None
    backend.advance({0: (0.9, 0.9, 0.95, 0.95)}, frame_index=3)  # re-anchor
    fi, pt = fake.prompts[0]
    assert fi == 3
    # the re-anchor prompt is the LAST MASK's center, not the (wildly different)
    # caller-supplied box center
    assert pt[0] == pytest.approx((last_mask[0] + last_mask[2]) / 2, abs=1e-6)


class RemovalPredictor(FakePredictor):
    """Reports the tracked obj_id as removed, then only answers the FRESH id."""

    def __init__(self, frames):
        super().__init__(frames)
        self.alias = {}
        self.removed_at = set()

    def handle_request(self, req):
        if req.get("type") == "add_prompt":
            oid = int(req["obj_id"])
            self.alias.setdefault(oid, 0)   # every id tracks target 0
        return super().handle_request(req)

    def handle_stream_request(self, req):
        start = req["start_frame_index"]
        row = self.frames[min(start, len(self.frames) - 1)]
        masks = {}
        for oid in self.alias:
            b = row.get(self.alias[oid])
            if b is not None:
                masks[oid] = _mask(b)
        out = {"obj_id_to_mask": masks}
        if start in self.removed_at:
            out["removed_obj_ids"] = [0]
            out["obj_id_to_mask"] = {k: v for k, v in masks.items() if k != 0}
        yield {"frame_index": start, "outputs": out}


def test_reanchor_after_removal_registers_a_fresh_obj_id():
    # SAM3 pops a removed masklet from its metadata and keeps it in the action
    # history; re-adding the SAME id is the historically failing path. The
    # backend must re-register the slot under a fresh obj_id and still map the
    # returned mask back to the slot.
    fake = RemovalPredictor([{0: (0.2, 0.2, 0.4, 0.4)}] * 6)
    fake.removed_at = {1}
    backend = Sam3Backend(predictor_factory=lambda: fake, clip_path="x.mp4")
    box = (0.2, 0.2, 0.4, 0.4)
    backend.advance({0: box}, frame_index=0)
    assert backend.get(0) is not None
    backend.advance({0: box}, frame_index=1)          # SAM removes the masklet
    assert backend.get(0) is None
    backend.advance({0: box}, frame_index=2)          # re-anchor -> fresh obj id
    assert backend._obj_id(0) >= 100
    assert backend.get(0) is not None                 # mask mapped back to slot 0


def test_timeline_records_loss_and_reanchor_events():
    frames = [{0: (0.2, 0.2, 0.4, 0.4)}, {0: None}, {0: (0.2, 0.2, 0.4, 0.4)}]
    fake, backend = _make(frames)
    backend.debug = True
    backend.advance({0: (0.2, 0.2, 0.4, 0.4)}, frame_index=0)
    backend.advance({0: (0.2, 0.2, 0.4, 0.4)}, frame_index=1)
    backend.advance({0: (0.2, 0.2, 0.4, 0.4)}, frame_index=2)
    assert [r["frame"] for r in backend.timeline] == [0, 1, 2]
    assert backend.timeline[0]["slots"]["0"]["state"] == "matched"
    assert backend.timeline[1]["slots"]["0"]["state"] == "lost"
    assert backend.timeline[2]["slots"]["0"]["reanchor"] is True
    assert backend.timeline[2]["slots"]["0"]["state"] == "matched"
    from app.sam3_backend import timeline_summary
    s = timeline_summary(backend.timeline, 0)
    assert s["matched_frames"] == 2 and s["lost_frames"] == 1
    assert s["first_lost_frame"] == 1 and s["reanchor_prompts"] == 1


class BackwardPredictor(FakePredictor):
    def __init__(self, frames):
        super().__init__(frames)
        self.session_starts = []
        self.directions = []
        self.closed = []

    def handle_request(self, req):
        if req.get("type") == "start_session":
            self.session_starts.append(req["resource_path"])
            return {"session_id": f"s{len(self.session_starts)}"}
        if req.get("type") == "close_session":
            self.closed.append(req["session_id"])
            return {}
        return super().handle_request(req)

    def handle_stream_request(self, req):
        self.directions.append((req["session_id"], req["propagation_direction"],
                                req["start_frame_index"], req["max_frame_num_to_track"]))
        start = req["start_frame_index"]
        for k in range(req["max_frame_num_to_track"]):
            fi = start - k
            yield {"frame_index": fi,
                   "outputs": {"obj_id_to_mask": {0: _mask((0.2, 0.2, 0.3, 0.4))}}}


def test_backfill_backward_runs_a_second_session_in_reverse():
    fake = BackwardPredictor([{0: (0.2, 0.2, 0.4, 0.4)}] * 60)
    backend = Sam3Backend(predictor_factory=lambda: fake, clip_path="x.mp4")
    assert backend.ready()
    backend.advance({0: (0.2, 0.2, 0.4, 0.4)}, frame_index=0)
    frames = backend.backfill_backward(4, {0: (0.2, 0.2, 0.4, 0.4)})
    # second session on the same clip, backward from the seed, covering 0..4
    assert fake.session_starts == ["x.mp4", "x.mp4"]
    sid, direction, start, span = fake.directions[-1]
    assert direction == "backward" and start == 4 and span == 5
    assert [f["frame"] for f in frames] == [4, 3, 2, 1, 0]
    assert backend.backfill_calls == 1
    assert fake.closed  # the throwaway session is closed


def test_session_resource_uses_frame_list_when_given():
    # ADAAAA-7820: the perceive image has no cv2/torchcodec, so a .mp4 session
    # could not start (silently). SAM3 also accepts a list of PIL images.
    class Recording(FakePredictor):
        def __init__(self):
            super().__init__([{0: (0.2, 0.2, 0.4, 0.4)}])
            self.resource = None

        def handle_request(self, req):
            if req.get("type") == "start_session":
                self.resource = req["resource_path"]
            return super().handle_request(req)

    fake = Recording()
    frames = [object(), object()]
    backend = Sam3Backend(predictor_factory=lambda: fake, clip_path="x.mp4", frames=frames)
    assert backend.ready()
    assert fake.resource is frames


def test_start_failure_is_recorded_not_swallowed():
    class Boom(FakePredictor):
        def handle_request(self, req):
            if req.get("type") == "start_session":
                raise ImportError("No module named 'cv2'")
            return super().handle_request(req)

    backend = Sam3Backend(predictor_factory=lambda: Boom([{0: (0.2, 0.2, 0.4, 0.4)}]),
                          clip_path="x.mp4")
    assert backend.ready() is False
    assert backend.start_error and "cv2" in backend.start_error


class LostPlayerBackend:
    supports_frame_index = True

    def __init__(self):
        self._cur = {}

    def ready(self):
        return True

    def advance(self, prompts, frame_index=None):
        self._cur = {}          # everything lost every frame

    def get(self, slot):
        return self._cur.get(slot)


def test_bounded_reseed_recovers_lost_selected_player():
    b = LostPlayerBackend()
    tr = HybridTracker(backend=b, redetect_every=999, lost_before_redetect=99)
    tr.reseed_after = 1
    tr.reseed_max = 1
    tr._player_detect = lambda rgb: [
        {"label": "player", "bbox": (0.50, 0.30, 0.56, 0.45)},
    ]
    tr.seed((0.45, 0.25, 0.55, 0.44), kind="player", label="player #1", selected=True)
    for ts in (1.0, 2.0, 3.0, 4.0, 5.0):
        tr.step_frame(_white(), ts)
    assert tr.reseed_calls == 1                       # capped by reseed_max
    assert tr._prompts[0] == (0.50, 0.30, 0.56, 0.45)


def test_bounded_reseed_is_off_by_default():
    b = LostPlayerBackend()
    tr = HybridTracker(backend=b, redetect_every=999, lost_before_redetect=99)
    calls = {"n": 0}
    tr._player_detect = lambda rgb: calls.__setitem__("n", calls["n"] + 1) or []
    tr.seed((0.45, 0.25, 0.55, 0.44), kind="player", label="player #1", selected=True)
    for ts in (1.0, 2.0, 3.0):
        tr.step_frame(_white(), ts)
    assert calls["n"] == 0 and tr.reseed_calls == 0


# --- ADAAAA-7345: windowed propagation -------------------------------------
class WindowPredictor(FakePredictor):
    """Predictor that behaves like the real client: ONE propagate call yields a
    whole WINDOW of frames (hotstart_delay=15 means a 1-frame call yields no
    masklet at all: measured zero masks on all 487 frames, ADAAAA-7820)."""

    def __init__(self, frames):
        super().__init__(frames)
        self.windows = []          # (start, max_frame_num_to_track)
        self.yields = 0

    def handle_stream_request(self, req):
        if "start_frame_index" not in req:
            raise KeyError("propagate request must use `start_frame_index`")
        start = req["start_frame_index"]
        maxn = req.get("max_frame_num_to_track") or 1
        self.windows.append((start, maxn))
        for k in range(maxn):
            fi = min(start + k, len(self.frames) - 1)
            row = self.frames[fi]
            masks = {oid: _mask(b) for oid, b in row.items() if b is not None}
            self.yields += 1
            yield {"frame_index": fi, "outputs": {"obj_id_to_mask": masks}}


def test_window_propagate_serves_every_frame_from_one_call():
    frames = [{0: (0.10 + 0.02 * i, 0.2, 0.30 + 0.02 * i, 0.4)} for i in range(20)]
    fake = WindowPredictor(frames)
    backend = Sam3Backend(predictor_factory=lambda: fake, clip_path="x.mp4")
    backend.propagate_window = 16
    prompt = (0.10, 0.2, 0.30, 0.4)
    backend.advance({0: prompt}, frame_index=0)
    assert backend.get(0)[0] == pytest.approx(0.10, abs=0.06)
    # the next 15 frames come out of the cache: no second propagate call
    for f in range(1, 16):
        backend.advance({0: prompt}, frame_index=f)
        assert backend.get(0)[0] == pytest.approx(0.10 + 0.02 * f, abs=0.06)
    assert len(fake.windows) == 1, "cached window frames must not re-propagate"
    assert fake.windows[0] == (0, 16)


def test_window_propagate_reissues_after_cache_exhausted():
    frames = [{0: (0.10, 0.2, 0.30, 0.4)} for _ in range(40)]
    fake = WindowPredictor(frames)
    backend = Sam3Backend(predictor_factory=lambda: fake, clip_path="x.mp4")
    backend.propagate_window = 8
    prompt = (0.10, 0.2, 0.30, 0.4)
    for f in range(9):
        backend.advance({0: prompt}, frame_index=f)
    assert [w[0] for w in fake.windows] == [0, 8]


def test_reseed_clears_window_cache():
    frames = [{0: (0.10, 0.2, 0.30, 0.4)} for _ in range(20)]
    fake = WindowPredictor(frames)
    backend = Sam3Backend(predictor_factory=lambda: fake, clip_path="x.mp4")
    backend.propagate_window = 16
    backend.advance({0: (0.10, 0.2, 0.30, 0.4)}, frame_index=0)
    assert fake.windows == [(0, 16)]
    # an EXTERNAL target change resets the session: stale window frames must go
    backend.advance({0: (0.60, 0.5, 0.80, 0.7)}, frame_index=1)
    assert fake.resets == 1
    assert fake.windows[-1] == (1, 16)


def test_window_cache_dropped_when_reanchor_fires():
    # SAM loses the slot -> the re-anchor prompt at the current frame makes the
    # cached later frames stale, so the window must be re-propagated from here.
    class Losing(WindowPredictor):
        def handle_stream_request(self, req):
            for item in super().handle_stream_request(req):
                if item["frame_index"] >= 3:
                    yield {"frame_index": item["frame_index"], "outputs": {"obj_id_to_mask": {}}}
                else:
                    yield item

    frames = [{0: (0.10, 0.2, 0.30, 0.4)} for _ in range(30)]
    fake = Losing(frames)
    backend = Sam3Backend(predictor_factory=lambda: fake, clip_path="x.mp4")
    backend.propagate_window = 8
    prompt = (0.10, 0.2, 0.30, 0.4)
    for f in range(5):
        backend.advance({0: prompt}, frame_index=f)
    assert fake.windows[-1] == (4, 8), "re-anchor must invalidate the cached window"


def test_parses_client_postprocessed_arrays_not_obj_id_to_mask():
    # ADAAAA-7345 ROOT CAUSE: Sam3VideoInference._postprocess_output returns
    # `out_obj_ids` / `out_binary_masks` (parallel arrays) and never
    # `obj_id_to_mask`. Reading the dict made every frame parse as "no
    # objects", which is why the whole chain measured zero masks.
    class ClientShapePredictor(FakePredictor):
        def handle_stream_request(self, req):
            if "start_frame_index" not in req:
                raise KeyError("propagate request must use `start_frame_index`")
            start = req["start_frame_index"]
            row = self.frames[min(start, len(self.frames) - 1)]
            ids, masks = [], []
            for oid, b in row.items():
                m = _mask(b)
                if m is None:
                    continue
                ids.append(oid)
                masks.append(m)
            yield {
                "frame_index": start,
                "outputs": {
                    "out_obj_ids": np.array(ids, dtype=np.int64),
                    "out_probs": np.ones(len(ids), dtype=np.float32),
                    "out_boxes_xywh": np.zeros((len(ids), 4), dtype=np.float32),
                    "out_binary_masks": (
                        np.stack(masks) if masks else np.zeros((0, 16, 16), bool)
                    ),
                },
            }

    fake = ClientShapePredictor([{0: (0.2, 0.2, 0.4, 0.4), 1: (0.6, 0.6, 0.8, 0.8)}])
    backend = Sam3Backend(predictor_factory=lambda: fake, clip_path="x.mp4")
    backend.advance({0: (0.2, 0.2, 0.4, 0.4), 1: (0.6, 0.6, 0.8, 0.8)})
    assert backend.get(0) is not None and backend.get(1) is not None
    assert backend.get(0)[0] == pytest.approx(0.2, abs=0.06)
    assert backend.get(1)[0] == pytest.approx(0.6, abs=0.06)
    assert backend._last_mask_ids == [0, 1]


def test_client_shape_empty_frame_is_none():
    class Empty(WindowPredictor):
        def handle_stream_request(self, req):
            yield {
                "frame_index": req["start_frame_index"],
                "outputs": {
                    "out_obj_ids": np.zeros(0, dtype=np.int64),
                    "out_probs": np.zeros(0, dtype=np.float32),
                    "out_boxes_xywh": np.zeros((0, 4), dtype=np.float32),
                    "out_binary_masks": np.zeros((0, 16, 16), bool),
                },
            }

    fake = Empty([{0: (0.2, 0.2, 0.4, 0.4)}])
    backend = Sam3Backend(predictor_factory=lambda: fake, clip_path="x.mp4")
    backend.advance({0: (0.2, 0.2, 0.4, 0.4)})
    assert backend.get(0) is None

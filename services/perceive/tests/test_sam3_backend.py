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

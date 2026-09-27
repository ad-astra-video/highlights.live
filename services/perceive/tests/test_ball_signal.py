"""Unit + integration tests for the ball-signal orchestration (INC-2b slice 5).

Slice 5 wires BallTracker -> BallVelocityEstimator -> PossessionAssigner into a
single per-session ``BallSignalPipeline`` and attaches the result to the
emitted CandidateEvent as ``ballVelocity`` / ``ballPossession`` (both OPTIONAL,
backward compatible -- see packages/events).

These tests lock the ORCHESTRATION (the per-component acceptance metrics are
locked by each component's own tests in slices 2-4):

  * ball detections are extracted from Florence ``objects`` by label;
  * a calibrated pipeline emits a homography-corrected BallVelocity whose
    ground-plane speed is within the <=15% budget, plus a BallPossession with
    the nearest player, in the exact contract dict shape;
  * an UNcalibrated pipeline degrades gracefully (homography: false, no crash);
  * a loose ball (player beyond the threshold) -> possessingPlayerId "none";
  * no ball -> no velocity / no possession, never a crash;
  * process_frame wiring actually attaches both fields to the candidate.
"""
import numpy as np

import app as app_mod
from app import process_frame
from app.ball_signal import BallSignalPipeline, is_ball_label
from app.pitch_homography import homography_from_pitch_rect, project_points

# --- synthetic broadcast camera on NORMALIZED image coords (0..1) -----------
NORM_IMAGE_CORNERS = [
    (0.06, 0.94),
    (0.94, 0.94),  # wide, near bottom of frame
    (0.30, 0.10),
    (0.70, 0.10),  # narrow, far top of frame
]
FIELD_CORNERS = [(0.0, 0.0), (68.0, 0.0), (0.0, 105.0), (68.0, 105.0)]
H = homography_from_pitch_rect(NORM_IMAGE_CORNERS, FIELD_CORNERS)
H_FI = np.linalg.inv(H)  # field -> image (normalized)

DT = 1.0 / 60


def _ball_objects_norm(center, half=0.006):
    """Florence-style objects for a ball whose NORMALIZED image center = center."""
    cx, cy = center
    return [{"label": "soccer ball", "confidence": 0.9,
             "bbox": [cx - half, cy - half, cx + half, cy + half]}]


def _ball_objects_field(field_pos):
    """Florence-style objects for a ball at ``field_pos`` meters (image projected)."""
    img = project_points(H_FI, [field_pos])[0]
    return _ball_objects_norm((img[0], img[1]))


def _player_boxes(field_positions, tag="p"):
    """Player track dict {id: bbox} from a list of field positions."""
    out = {}
    for i, f in enumerate(field_positions):
        img = project_points(H_FI, [f])[0]
        cx, cy = float(img[0]), float(img[1])
        out[f"{tag}{i}"] = (cx - 0.05, cy - 0.05, cx + 0.05, cy + 0.05)
    return out


# ---------------------------------------------------------------- is_ball_label
def test_is_ball_label_matches_ball_labels():
    for lab in ("soccer ball", "sports ball", "ball", "basketball", "tennis ball", "BALL"):
        assert is_ball_label(lab), lab


def test_is_ball_label_rejects_non_ball():
    for lab in ("player", "goalkeeper", "", None):
        assert not is_ball_label(lab), lab


# ------------------------------------------------------------ ball extraction
def test_extract_ball_boxes_filters_by_label():
    pipe = BallSignalPipeline(H=H)
    objects = [
        {"label": "player", "bbox": [0.1, 0.2, 0.5, 0.6]},
        {"label": "soccer ball", "bbox": [0.4, 0.3, 0.42, 0.32]},
        {"label": "referee", "bbox": [0.7, 0.7, 0.9, 0.9]},
    ]
    assert pipe.extract_ball_boxes(objects) == [(0.4, 0.3, 0.42, 0.32)]


def test_extract_ball_boxes_handles_empty():
    pipe = BallSignalPipeline(H=H)
    assert pipe.extract_ball_boxes([]) == []
    assert pipe.extract_ball_boxes([{"label": "player", "bbox": [0, 0, 1, 1]}]) == []


# ----------------------------------------------------- calibrated pipeline
def test_calibrated_pipeline_velocity_within_15pct_and_possession():
    """Ball moving at a KNOWN on-pitch speed -> homography-corrected m/s within
    15% budget; nearest player assigned -> possession in contract shape."""
    pipe = BallSignalPipeline(H=H, velocity_window=6)
    v = np.array([12.0, 5.0])
    speed_true = float(np.linalg.norm(v))
    start = np.array([10.0, 20.0])
    n = 40
    rng = np.random.default_rng(7)

    # A player standing where the ball ends its run (within the 5 m loose
    # threshold of the final position) so the last frame is "possessed".
    players = _player_boxes([(16.0, 23.0)])

    last_frame = None
    for k in range(n):
        field = start + v * (k * DT)
        img = project_points(H_FI, [field])[0] + rng.normal(0, 0.0005, 2)
        last_frame = pipe.step(_ball_objects_norm((img[0], img[1])), players, ts=k * DT)

    assert last_frame is not None
    vel = last_frame.velocity
    assert vel is not None
    assert vel["homography"] is True
    err = abs(vel["speedMps"] - speed_true) / speed_true
    assert err <= 0.15, f"speed error {err:.3f} exceeds 15% budget"
    assert set(("vxMps", "vyMps", "speedMps", "homography", "posXm", "posYm")).issubset(vel)

    poss = last_frame.possession
    assert poss is not None
    assert poss["possessingPlayerId"] == "p0"
    assert "distanceM" in poss and poss["distanceM"] >= 0


def test_loose_ball_reports_none():
    """A ball far from every player (beyond the loose threshold) -> 'none'."""
    pipe = BallSignalPipeline(H=H, loose_threshold=5.0)
    players = _player_boxes([(3.0, 8.0)])  # near one pitch corner
    last = None
    ball_field = np.array([58.0, 95.0])  # far from that player
    for k in range(20):
        last = pipe.step(_ball_objects_field(ball_field), players, ts=k * DT)
    assert last is not None
    assert last.possession is not None
    assert last.possession["possessingPlayerId"] == "none"


def test_no_ball_yields_no_velocity_no_possession():
    pipe = BallSignalPipeline(H=H)
    frame = pipe.step([], _player_boxes([(20.0, 20.0)]), ts=1.0)
    assert frame.velocity is None
    assert frame.possession is None
    assert frame.persistence >= 0.0


def test_persists_through_missed_detections():
    """Two consecutive missed ball detections are bridged (held box), so
    velocity/possession keep reporting and on-screen persistence stays high."""
    pipe = BallSignalPipeline(H=H, velocity_window=4)
    v = np.array([8.0, 3.0])
    start = np.array([15.0, 30.0])
    players = _player_boxes([(30.0, 35.0)])
    final = None
    for frame_i in range(30):
        if frame_i in (5, 6):
            objs = []  # no ball detection this frame
        else:
            objs = _ball_objects_field(start + v * (frame_i * DT))
        final = pipe.step(objs, players, ts=frame_i * DT)
    assert final is not None
    assert final.velocity is not None
    assert final.possession is not None
    assert final.persistence >= 0.9, f"persistence {final.persistence:.3f} < 0.90"


def test_uncalibrated_pipeline_falls_back_to_image_space():
    pipe = BallSignalPipeline(H=None, loose_threshold=5.0)
    players = {"p": (0.3, 0.3, 0.6, 0.6)}
    last = None
    for k in range(20):
        obj = [{"label": "soccer ball", "bbox": [0.40 + 0.01 * k, 0.40, 0.42 + 0.01 * k, 0.42]}]
        last = pipe.step(obj, players, ts=k * DT)
    assert last is not None
    assert last.velocity is not None
    assert last.velocity["homography"] is False  # graceful image-space fallback
    assert last.possession is not None
    assert "distanceM" not in last.possession  # omitted when no H (not meters)


def test_reset_clears_velocity_ring():
    pipe = BallSignalPipeline(H=H, velocity_window=3)
    for k in range(6):
        pipe.step(_ball_objects_field(np.array([10.0, 20.0])), {}, ts=k * DT)
    pipe.reset()
    assert pipe.velocity.estimate() is None  # ring cleared, no samples


# ---------------------------------------------------------- process_frame wiring
class _FakeDetector:
    """Minimal stand-in for the Florence detector: yields one frame's objects
    per detect() call. process_frame calls detector.detect() exactly once per
    frame, so a single shared detector advances through the canned frames."""

    def __init__(self, objects_per_frame):
        self._frames = list(objects_per_frame)
        self._i = 0

    def detect(self, rgb, vocabulary=None):
        if self._i < len(self._frames):
            out = self._frames[self._i]
            self._i += 1
            return out
        return []


def test_process_frame_attaches_ball_signal_to_candidate(monkeypatch):
    """End-to-end wiring: with a ball + moving player + calibration, a fired
    CandidateEvent carries ballVelocity + ballPossession (decide() context)."""
    from app.session import SessionState
    from app.tracker import IoUTracker

    state = SessionState(session_id="s-slice5")
    state.tracker = IoUTracker()
    state.homography = H

    # Per-frame Florence objects: a fast-moving PLAYER (silhouette) triggers the
    # tracker candidate; the ball moves on the pitch throughout.
    objects_per_frame = []
    player_center = 0.15
    ball_field = np.array([10.0, 20.0])
    n = 12
    for k in range(n):
        player_box = [player_center * 1000 - 60, 350, player_center * 1000 + 60, 600]
        img = project_points(H_FI, [ball_field])[0]
        ball_box = [img[0] * 1000 - 5, img[1] * 1000 - 5, img[0] * 1000 + 5, img[1] * 1000 + 5]
        objects_per_frame.append([
            {"label": "player", "confidence": 0.9, "bbox": player_box},
            {"label": "soccer ball", "confidence": 0.9, "bbox": ball_box},
        ])
        player_center += 0.18
        ball_field = ball_field + np.array([12.0, 5.0]) * DT

    fake = _FakeDetector(objects_per_frame)
    monkeypatch.setattr(app_mod, "get_detector", lambda: fake)

    saw_candidate = False
    for k in range(n):
        _obs, cand = process_frame(state, seq=k, timestamp=k * DT, image_b64="")
        if cand is not None:
            saw_candidate = True
            assert "ballVelocity" in cand, "candidate must carry ballVelocity"
            assert cand["ballVelocity"]["homography"] is True
            assert cand["ballVelocity"]["speedMps"] >= 0
            assert "ballPossession" in cand, "candidate must carry ballPossession"
            # Contract field present with a valid assignment ("<track-id>" or
            # "none" for a loose ball -- possession correctness is unit-tested
            # in the pipeline tests; here we verify it flows onto the event).
            assert isinstance(cand["ballPossession"]["possessingPlayerId"], str)
            break
    assert saw_candidate, "expected at least one candidate from the fast-moving player"

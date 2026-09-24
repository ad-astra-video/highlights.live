"""Unit tests for nearest-neighbor ball possession (INC-2b / ADAAAA-4326).

The acceptance target for this slice: possession-assignment accuracy >= 90% on
labeled frames. We build synthetic broadcast-camera scenes -- real field
positions for players + the ball, a known homography image<->field, image jitter
-- where the TRUE possessor is the closest on-pitch player to the ball, then
check the assigner recovers that label. Also verifies the loose-ball ("none")
decision, ground-plane distanceM, and the image-space fallback.
"""
import numpy as np
import pytest

from app.possession import PossessionAssigner
from app.pitch_homography import estimate_homography, project_points

# Same synthetic broadcast camera as test_pitch_homography.py.
FIELD_CORNERS = [
    (0.0, 0.0),
    (68.0, 0.0),
    (0.0, 105.0),
    (68.0, 105.0),
]
IMAGE_CORNERS = [
    (120.0, 680.0),
    (1160.0, 680.0),
    (430.0, 90.0),
    (850.0, 90.0),
]

# image -> field homography for the synthetic camera.
H_IF = estimate_homography(IMAGE_CORNERS, FIELD_CORNERS)
H_FI = np.linalg.inv(H_IF)


def _bbox_around_image_center(center, half=6.0):
    cx, cy = center
    return (cx - half, cy - half, cx + half, cy + half)


def _field_to_image(field_pts):
    """Project field (N,2) points -> image pixels via the synthetic camera."""
    out = project_points(H_FI, field_pts)
    return np.asarray(out, dtype=float)


def _ball_bbox_at(field_pos, rng):
    img = _field_to_image(np.asarray([field_pos], dtype=float))[0]
    img = img + rng.normal(0, 0.5, 2)  # ball box centroid jitter
    return _bbox_around_image_center(tuple(img), half=4.0)


def _player_tracks_at(field_positions, rng):
    tracks = {}
    for i, fp in enumerate(field_positions):
        img = _field_to_image(np.asarray([fp], dtype=float))[0]
        img = img + rng.normal(0, 0.8, 2)  # player box centroid jitter
        tracks[f"p{i}"] = _bbox_around_image_center(tuple(img), half=10.0)
    return tracks


def _scatter_players(rng, n, min_spacing, pitch_w=68.0, pitch_h=105.0):
    """Place n players on the pitch with pairwise field distance >= min_spacing."""
    pts = []
    attempts = 0
    while len(pts) < n and attempts < 5000:
        attempts += 1
        cand = np.array([rng.uniform(3, pitch_w - 3), rng.uniform(3, pitch_h - 3)])
        if all(np.linalg.norm(cand - q) >= min_spacing for q in pts):
            pts.append(cand)
    return np.array(pts)


def test_nearest_player_assigned_when_clear():
    """With well-separated players and the ball near one, that one is assigned."""
    rng = np.random.default_rng(1)
    players = _scatter_players(rng, 8, min_spacing=10.0)
    possessor_idx = 4
    ball_field = players[possessor_idx] + np.array([0.6, -0.4])
    assigner = PossessionAssigner(H=H_IF, loose_threshold=5.0)

    tracks = _player_tracks_at(players, rng)
    ball = _ball_bbox_at(ball_field, rng)
    st = assigner.assign(tracks, ball)

    assert st.possessingPlayerId == f"p{possessor_idx}"
    assert st.loose is False
    # distanceM is roughly the true on-pitch distance to the possessor.
    assert st.distanceM is not None
    true_off = np.linalg.norm(ball_field - players[possessor_idx])
    assert abs(st.distanceM - true_off) < 1.5


def test_accuracy_above_90pct_on_labeled_frames():
    """REQUIRED: possession-assignment accuracy >= 90% across labeled frames.

    Many independently-drawn scenes (random player layouts near a fixed spacing,
    box/centroid jitter), where the ground-truth possessor is the closest
    on-pitch player. The assigner must recover that label on >= 90% of frames.
    """
    rng = np.random.default_rng(42)
    assigner = PossessionAssigner(H=H_IF, loose_threshold=5.0)

    n_frames = 200
    correct = 0
    for _ in range(n_frames):
        n_players = int(rng.integers(4, 10))
        players = _scatter_players(rng, n_players, min_spacing=5.0)
        possessor_idx = int(rng.integers(0, len(players)))
        # Ball within ~1.2m of the possessor - owner is clearly nearest.
        offset = rng.normal(0, 0.5, 2)
        offset = np.clip(offset, -1.2, 1.2)
        ball_field = players[possessor_idx] + offset

        tracks = _player_tracks_at(players, rng)
        ball = _ball_bbox_at(ball_field, rng)
        st = assigner.assign(tracks, ball)

        if st.possessingPlayerId == f"p{possessor_idx}":
            correct += 1

    acc = correct / n_frames
    assert acc >= 0.90, f"possession accuracy {acc:.3f} < 90% ({correct}/{n_frames})"


def test_even_closer_packing_still_above_90pct():
    """Tighter player spacing (3.5m) still stays >= 90% accurate."""
    rng = np.random.default_rng(7)
    assigner = PossessionAssigner(H=H_IF, loose_threshold=5.0)

    n_frames = 200
    correct = 0
    for _ in range(n_frames):
        n_players = int(rng.integers(5, 11))
        players = _scatter_players(rng, n_players, min_spacing=3.5)
        possessor_idx = int(rng.integers(0, len(players)))
        offset = np.clip(rng.normal(0, 0.35, 2), -0.9, 0.9)
        ball_field = players[possessor_idx] + offset

        tracks = _player_tracks_at(players, rng)
        ball = _ball_bbox_at(ball_field, rng)
        st = assigner.assign(tracks, ball)
        if st.possessingPlayerId == f"p{possessor_idx}":
            correct += 1

    acc = correct / n_frames
    assert acc >= 0.90, f"possession accuracy {acc:.3f} < 90% ({correct}/{n_frames})"


def test_loose_ball_when_player_beyond_threshold():
    """Ball far from every player -> possessingPlayerId \"none\", loose=True."""
    rng = np.random.default_rng(11)
    players = _scatter_players(rng, 4, min_spacing=15.0)
    # Place the ball far from all players (> loose_threshold of 5m).
    ball_field = np.array([66.0, 3.0])
    assert all(np.linalg.norm(ball_field - p) > 5.0 for p in players)

    assigner = PossessionAssigner(H=H_IF, loose_threshold=5.0)
    st = assigner.assign(_player_tracks_at(players, rng), _ball_bbox_at(ball_field, rng))
    assert st.possessingPlayerId == "none"
    assert st.loose is True
    assert st.distanceM is not None  # still reports the nearest distance


def test_distance_threshold_edge():
    """Below threshold -> owned; above -> none. Threshold is inclusive-ish."""
    rng = np.random.default_rng(13)
    # One player at origin-ish; ball just inside and just outside the threshold.
    assigner = PossessionAssigner(H=H_IF, loose_threshold=5.0)

    player = np.array([30.0, 50.0])
    tracks = _player_tracks_at([player], rng)

    inside = player + np.array([2.0, 0.0])  # 2m from player
    st_in = assigner.assign(tracks, _ball_bbox_at(inside, rng))
    assert st_in.possessingPlayerId.startswith("p") and st_in.loose is False
    assert st_in.distanceM is not None and st_in.distanceM < 5.0

    outside = player + np.array([12.0, 0.0])  # 12m from player
    st_out = assigner.assign(tracks, _ball_bbox_at(outside, rng))
    assert st_out.possessingPlayerId == "none" and st_out.loose is True


def test_no_ball_returns_none():
    rng = np.random.default_rng(17)
    players = _scatter_players(rng, 5, min_spacing=6.0)
    assigner = PossessionAssigner(H=H_IF, loose_threshold=5.0)
    st = assigner.assign(_player_tracks_at(players, rng), None)
    assert st.possessingPlayerId == "none" and st.loose is True


def test_empty_player_tracks_returns_none():
    assigner = PossessionAssigner(H=H_IF, loose_threshold=5.0)
    st = assigner.assign({}, (100, 100, 110, 110))
    assert st.possessingPlayerId == "none" and st.loose is True


def test_image_space_fallback_no_homography():
    """Without H, nearest-neighbor runs in image units with its own threshold."""
    assigner = PossessionAssigner(H=None, loose_threshold=5.0, image_space_threshold=0.08)
    ball = (0.4, 0.4, 0.42, 0.42)  # normalized-ish image coords
    tracks = {
        "a": (0.35, 0.35, 0.45, 0.45),  # close to ball center (0.41,0.41)
        "b": (0.7, 0.7, 0.85, 0.85),    # far
    }
    st = assigner.assign(tracks, ball)
    assert st.possessingPlayerId == "a"
    assert st.loose is False
    # No homography -> distanceM omitted (cannot report meters).
    assert st.distanceM is None

    # A ball far from every player (loose in image units).
    st2 = assigner.assign(tracks, (0.05, 0.05, 0.06, 0.06))
    assert st2.possessingPlayerId == "none" and st2.loose is True


def test_rejects_non_3x3_homography():
    with pytest.raises(ValueError):
        PossessionAssigner(H=np.eye(2))

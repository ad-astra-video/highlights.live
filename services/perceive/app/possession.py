"""Nearest-neighbor ball possession assignment (INC-2b / ADAAAA-4326).

Slice 4 of the ball-centric candidate signal. The ball track (``ball_track.py``)
gives a per-frame ball box and the pitch homography (``pitch_homography.py``)
gives image -> field meters; this module answers *who has the ball*.

Per the research scope: associate the CENTROID of the nearest player bbox to the
CENTROID of the ball bbox each frame -> possessingPlayerId, or ``"none"`` when
the nearest player is beyond the loose-ball distance threshold. Nearest
neighbor only -- no new detection model. The assignment feeds
``BallPossession.possessingPlayerId`` / ``distanceM`` on CandidateEvent.

Design notes:

  - Distances are measured on the GROUND PLANE in meters when a homography H is
    available (project the ball center and each player centroid through H).
    This is the same field coordinate frame as ``BallVelocity`` from slice 3,
    so ``distanceM`` is comparable and physically meaningful.
  - Without H, falls back to image-space distance (the boxes' native units) and
    a separate image-space loose-ball threshold; ``distanceM`` is then omitted
    because it is not in meters. The assignment logic is otherwise identical.
  - Pure per-frame greedy nearest neighbor, exactly as the scope specifies. It
    keeps no cross-frame state, so the same inputs always produce the same
    output (no flicker-hiding hidden state to reason about).

Acceptance: possession-assignment accuracy >= 90% on labeled frames, verified
in ``tests/test_possession.py`` against synthetic broadcast-camera scenes
where the true possessor is the closest on-pitch player.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional, Sequence, Tuple

import numpy as np

from .pitch_homography import project_points

BBox = Tuple[float, float, float, float]  # x1, y1, x2, y2 (normalized or px)
PlayerTracks = Dict[str, BBox]  # player track id -> bbox


@dataclass
class PossessionState:
    """Result of one frame's possession assignment.

    Mirrors ``packages/events`` BallPossession: ``possessingPlayerId`` is the
    nearest player track id, or ``"none"`` when the ball is loose (nearest
    player beyond the loose threshold). ``distanceM`` is the ground-plane
    distance in meters when a homography was available (``None`` otherwise).
    ``loose`` True means the ball is considered loose this frame.
    """

    possessingPlayerId: str
    distanceM: Optional[float] = None
    loose: bool = True


def _center(b: Sequence[float]) -> Tuple[float, float]:
    """BBox (x1,y1,x2,y2) -> centroid, tolerating degenerate boxes."""
    x1, y1, x2, y2 = (float(v) for v in b)
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def _valid_box(b: Sequence[float]) -> bool:
    if len(b) != 4:
        return False
    x1, y1, x2, y2 = (float(v) for v in b)
    return x2 - x1 > 0 and y2 - y1 > 0


class PossessionAssigner:
    """Assign the nearest player to the ball each frame (or ``"none"``).

    ``H`` is the image -> field homography (see ``pitch_homography``). When it
    is provided, distances are ground-plane meters and ``loose_threshold`` is in
    meters. When ``H`` is None, distances are in image units (pixels or
    normalized, matching the boxes) and ``image_space_threshold`` is used as
    the loose-ball cutoff; ``distanceM`` is omitted from the result.
    """

    def __init__(
        self,
        H: Optional[np.ndarray] = None,
        loose_threshold: float = 5.0,
        image_space_threshold: Optional[float] = None,
    ):
        if H is not None:
            Hmat = np.asarray(H, dtype=float)
            if Hmat.shape != (3, 3):
                raise ValueError("H must be a 3x3 matrix")
            H = Hmat
        self.H = H
        self.loose_threshold = float(loose_threshold)
        # Default image-space threshold: ~12% of frame for normalized boxes
        # (adapted to whatever image units are passed in).
        self.image_space_threshold = (
            float(image_space_threshold)
            if image_space_threshold is not None
            else 0.12
        )

    def _project_to_field(self, pts: Sequence[Tuple[float, float]]) -> np.ndarray:
        """Map image points to field meters via H (H must be set)."""
        return np.asarray(project_points(self.H, pts), dtype=float)

    # ------------------------------------------------------------------ step
    def assign(
        self,
        player_tracks: PlayerTracks,
        ball_bbox: Optional[Sequence[float]],
    ) -> PossessionState:
        """Assign possession for one frame.

        ``player_tracks`` maps player track id -> bbox for every on-screen
        player this frame. ``ball_bbox`` is the ball box (image space matching
        ``H`` / the player boxes); ``None`` means no ball this frame.

        Returns the nearest player's track id as ``possessingPlayerId``, or
        ``"none"`` when the nearest player is beyond the loose threshold (a
        loose ball) or when there is no usable ball this frame.
        """
        if not player_tracks or ball_bbox is None or not _valid_box(ball_bbox):
            return PossessionState(
                possessingPlayerId="none", distanceM=None, loose=True
            )

        ball_center = _center(ball_bbox)

        best_id: Optional[str] = None
        best_dist = float("inf")

        if self.H is not None:
            # Project the ball center + every player centroid to field meters,
            # then nearest-neighbor on the ground plane.
            centers = [_center(b) for b in player_tracks.values()]
            mapped = self._project_to_field([ball_center, *centers])
            ball_m = mapped[0]
            for (tid, _b), pc_m in zip(player_tracks.items(), mapped[1:]):
                d = float(np.hypot(ball_m[0] - pc_m[0], ball_m[1] - pc_m[1]))
                if d < best_dist:
                    best_dist = d
                    best_id = tid
        else:
            # No homography: nearest-neighbor in image units.
            for tid, b in player_tracks.items():
                pc = _center(b)
                d = float(np.hypot(ball_center[0] - pc[0], ball_center[1] - pc[1]))
                if d < best_dist:
                    best_dist = d
                    best_id = tid

        if best_id is None:
            return PossessionState(
                possessingPlayerId="none", distanceM=None, loose=True
            )

        # Loose-ball decision. The threshold unit depends on whether H is set.
        if self.H is not None:
            loose = best_dist > self.loose_threshold
            dist_m = best_dist
        else:
            loose = best_dist > self.image_space_threshold
            dist_m = None

        if loose:
            return PossessionState(
                possessingPlayerId="none", distanceM=dist_m, loose=True
            )

        return PossessionState(
            possessingPlayerId=best_id, distanceM=dist_m, loose=False
        )

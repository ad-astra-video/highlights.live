"""Ball-centric candidate signal orchestration (INC-2b / ADAAAA-4326).

Slice 5 wires the three ball-signal components from slices 2-4 into ONE
per-session pipeline that feeds the emitted CandidateEvent:

  ball detections (Florence <OD>) -> BallTracker (eviction-guarded, slice 2)
                                   -> BallVelocityEstimator (homography m/s, slice 3)
                                   -> PossessionAssigner (nearest player, slice 4)

Each frame, ``BallSignalPipeline.step()`` consumes the raw Florence ``objects``
(pass through so the caller does not have to duplicate the ball-label filter)
plus the on-screen player track boxes, and returns a ``BallSignalFrame`` whose
``velocity`` / ``possession`` dicts match the ``packages/events``
``BallVelocity`` / ``BallPossession`` contract fields exactly -- so the caller
can drop them straight onto a CandidateEvent:

  - velocity:  {vxMps, vyMps, speedMps, posXm, posYm, homography}
  - possession:{possessingPlayerId, distanceM?}

Everything is OPTIONAL on CandidateEvent (backward compatible). When there is
no homography H the velocity estimator falls back to image space
(``homography: false``) and possession falls back to an image-space loose-ball
threshold (``distanceM`` omitted) -- exactly the graceful degradation the
contract test covers, and the right behaviour for an uncalibrated session.

Coordinate convention: the pipeline operates on NORMALIZED bboxes (0..1),
because perceive's ``_norm_bbox`` normalizes all Florence boxes before the
tracker. The homography passed in MUST therefore be fit on normalized image
points (see ``pitch_homography``) so image and field spaces line up.

The acceptance targets for the individual components (ball-track persistence
>=95%, ground-plane speed error <=15%, possession accuracy >=90%) are each
locked by their own module tests (slices 2-4). This module's tests lock the
ORCHESTRATION: the right signal lands on the candidate, in the right contract
shape, and never crashes / never emits a malformed field when the ball is
absent, uncalibrated, or a detection is missed between frames.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from .ball_track import BallState, BallTracker, BBox
from .pitch_homography import BallVelocity, BallVelocityEstimator
from .possession import PossessionAssigner, PossessionState

PlayerTracks = Dict[str, BBox]  # player track id -> bbox


def is_ball_label(label: Optional[str]) -> bool:
    """True when a detection label refers to a ball.

    Matches the ball labels the closed vocabulary + canonicalizer actually emit
    ("soccer ball", "basketball", "tennis ball", "volleyball", ...) and Florence's
    raw open-set "sports ball" / "ball". Any label containing the token "ball"
    (lowercased) is treated as a ball; likewise the explicit "sports ball".
    """
    if not label:
        return False
    lab = str(label).strip().lower()
    return "ball" in lab


@dataclass
class BallSignalFrame:
    """One frame's ball signal, ready to attach to a CandidateEvent."""

    velocity: Optional[dict]  # BallVelocity contract fields (None until enough samples)
    possession: Optional[dict]  # BallPossession contract fields (None when no ball)
    ball_state: BallState  # the underlying eviction-guarded track state
    persistence: float  # current on-screen persistence (fraction 0..1)


def _round(v: float, nd: int = 3) -> float:
    return round(float(v), nd)


class BallSignalPipeline:
    """Per-session orchestrator: BallTracker -> velocity -> possession.

    Owns the three components so they share one homography and one coordinate
    convention, and so a session simply resets the whole signal (its velocity
    sample ring too) when its calibration or identity changes.
    """

    def __init__(
        self,
        H: Optional[np.ndarray] = None,
        loose_threshold: float = 5.0,
        loss_hold_frames: int = 5,
        off_screen_after: int = 20,
        velocity_window: int = 4,
    ):
        self.H = H
        self.ball_tracker = BallTracker(
            loss_hold_frames=loss_hold_frames, off_screen_after=off_screen_after
        )
        self.velocity = BallVelocityEstimator(H=H, window=velocity_window)
        self.possession = PossessionAssigner(H=H, loose_threshold=loose_threshold)

    # ------------------------------------------------------------------ utils
    def extract_ball_boxes(self, objects: Sequence[dict]) -> List[BBox]:
        """Pull the ball-boxes out of this frame's Florence ``objects``.

        ``objects`` entries carry ``label`` + ``bbox`` (normalized, already run
        through the closed-vocabulary canonicalizer by ``florence``). Ball
        boxes are the ones whose label is a ball label; ``BallTracker`` picks
        the largest-area one (usually there is exactly one).
        """
        out: List[BBox] = []
        for o in objects or []:
            if not isinstance(o, dict):
                continue
            if is_ball_label(o.get("label")):
                b = o.get("bbox")
                if b and len(b) == 4:
                    out.append(
                        (float(b[0]), float(b[1]), float(b[2]), float(b[3]))
                    )
        return out

    def reset(self) -> None:
        """Clear ball track + velocity sample ring (e.g. calibration change)."""
        # Rebuild a clean tracker + estimator, keep the homography/possession.
        self.ball_tracker = BallTracker(
            loss_hold_frames=self.ball_tracker.loss_hold_frames,
            off_screen_after=self.ball_tracker.off_screen_after,
        )
        self.velocity.reset()

    # ------------------------------------------------------------------ step
    def step(
        self,
        objects: Sequence[dict],
        player_tracks: Optional[PlayerTracks],
        ts: float,
    ) -> BallSignalFrame:
        """Advance one frame and return the ball signal.

        ``objects`` are this frame's Florence detections (ball boxes are
        extracted internally). ``player_tracks`` maps player track id -> bbox
        (the caller decides the on-screen player set; see the wiring in
        ``app/__init__._player_tracks``). ``velocity`` is None until the
        estimator has at least 2 on-pitch samples; ``possession`` is None when
        there is no ball this frame. Never raises on absent/empty input.
        """
        ball_boxes = self.extract_ball_boxes(objects)
        bs = self.ball_tracker.step(ball_boxes, ts)

        velocity: Optional[dict] = None
        possession: Optional[dict] = None

        if bs.present and bs.bbox is not None:
            bbox = bs.bbox
            vel: Optional[BallVelocity] = self.velocity.update(bbox, ts)
            if vel is not None:
                velocity = {
                    "vxMps": _round(vel.vxMps),
                    "vyMps": _round(vel.vyMps),
                    "speedMps": _round(vel.speedMps),
                    "homography": bool(vel.homography),
                }
                if vel.posXm is not None:
                    velocity["posXm"] = _round(vel.posXm)
                if vel.posYm is not None:
                    velocity["posYm"] = _round(vel.posYm)

            pos: PossessionState = self.possession.assign(player_tracks or {}, bbox)
            possession = {"possessingPlayerId": pos.possessingPlayerId}
            if pos.distanceM is not None:
                possession["distanceM"] = _round(pos.distanceM)

        return BallSignalFrame(
            velocity=velocity,
            possession=possession,
            ball_state=bs,
            persistence=self.ball_tracker.persistence(),
        )

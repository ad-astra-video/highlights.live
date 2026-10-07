"""Goal-line / ball-outcome ground-truth signal (decide-leg I2 / ADAAAA-6359).

Extends the INC-2b homography work. The homography already gives the ball's
ground-plane position (``posXm``/``posYm``, field meters) each frame; this
module answers the question the decide leg needs most: *did the ball actually
cross the goal-line plane inside the goal mouth, and what was the outcome?*

It is a pure, deterministic geometry classifier over a short window of on-pitch
ball positions. No GPU, no IO. It never raises and never emits a field when no
goal-line calibration is configured (graceful degradation, same pattern as the
INC-2b homography being optional).

Coordinate convention (must match ``pitch_homography``): field points are (X, Y)
meters in the calibration's axes. The goal line is a line parallel to one field
axis at a constant coordinate on the *perpendicular* axis. A ``GoalLineSpec``
names that perpendicular axis, the goal-line coordinate, and the goal-mouth
span (on the parallel axis). E.g. a goal at the near end-line of the synthetic
65x105 pitch (X width, Y length) is ``axis="y", position=0.0`` with the mouth
spanning X in ``[mouth_min, mouth_max]``.

Outcome vocabulary (matches the I2 plan): ``goal`` | ``off_target`` | ``blocked``
| ``no_shot`` | ``cross``.

  - ``goal``       ball crossed the goal-line plane inside the mouth.
  - ``off_target`` ball crossed the goal-line plane OUTSIDE the mouth at shot
                   speed (a shot that went wide / over the bar).
  - ``cross``      ball crossed the goal-line plane outside the mouth at lower
                   speed (a wide delivery / cut-back across the face).
  - ``blocked``    a fast shot approached the goal-line region but was stopped
                   (speed collapse) before it crossed the plane.
  - ``no_shot``    no goal-bound strike (slow/ambient play, warm-up, lull).

The critical separation for the I2 accept criterion is ``goal`` vs not-goal.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Deque, Optional, Sequence, Tuple

# Minimum on-pitch speed (m/s) to treat a ball as having been "shot" toward
# goal (a genuinely struck ball), vs ambient dribble / bounce.
STRIKE_SPEED_MPS = 8.0
# A ball within this many meters (normal-axis distance) of the goal-line plane
# counts as having reached the goal-line region (the shot wasn't hopeless).
NEAR_LINE_M = 3.0
# Peak speed must fall below this fraction of the window's peak to count as a
# collapse (blocked / saved) rather than a ball that simply missed the frame.
BLOCKED_SPEED_FRACTION = 0.4


@dataclass
class GoalLineSpec:
    """Where the goal line sits in the calibration's field coordinates.

    ``axis`` is the field axis perpendicular to the goal line ("x" or "y").
    The goal line is the plane ``coordinate[axis] == position``. The goal mouth
    spans ``[mouth_min, mouth_max]`` on the *other* axis (the cross axis).
    """

    axis: str = "y"          # "x" | "y"
    position: float = 0.0    # goal-line coordinate on `axis` (field meters)
    mouth_min: float = 20.0  # mouth lower bound on the cross axis (field meters)
    mouth_max: float = 48.0  # mouth upper bound on the cross axis (field meters)

    def __post_init__(self) -> None:
        self.axis = (self.axis or "y").lower()
        if self.axis not in ("x", "y"):
            raise ValueError("GoalLineSpec.axis must be 'x' or 'y'")
        if self.mouth_max < self.mouth_min:
            self.mouth_min, self.mouth_max = self.mouth_max, self.mouth_min

    def normal(self, pos: Tuple[float, float]) -> float:
        """The coordinate on the perpendicular (crossing-detect) axis."""
        return pos[0] if self.axis == "x" else pos[1]

    def cross(self, pos: Tuple[float, float]) -> float:
        """The coordinate on the parallel (goal-mouth) axis."""
        return pos[1] if self.axis == "x" else pos[0]

    @classmethod
    def from_dict(cls, d: Optional[dict]) -> Optional["GoalLineSpec"]:
        """Build from a JSON-ish dict (control `configure` / env), or None when
        absent/unparseable. Invalid values degrade to None, never raise."""
        if not isinstance(d, dict):
            return None
        try:
            axis = str(d.get("axis", "y")).lower()
            position = float(d.get("position", 0.0))
            mouth_min = float(d.get("mouthMin", d.get("mouth_min", 20.0)))
            mouth_max = float(d.get("mouthMax", d.get("mouth_max", 48.0)))
            return cls(axis=axis, position=position,
                       mouth_min=mouth_min, mouth_max=mouth_max)
        except (TypeError, ValueError):
            return None


@dataclass
class GoalLineSignal:
    """One detection's goal-line / ball-outcome result, ready to attach to a
    CandidateEvent as ``goalCrossed`` / ``ballOutcome``."""

    goalCrossed: bool
    ballOutcome: str  # goal | off_target | blocked | no_shot | cross
    normal: Optional[float] = None    # ball normal-axis coord at detection
    cross: Optional[float] = None     # ball cross-axis coord at detection


def _interp_cross(n_before: float, n_after: float, c_before: float,
                  c_after: float, goal_position: float) -> Optional[float]:
    """The cross-axis coordinate at the moment the normal-axis coordinate
    crosses ``goal_position`` as the ball moves linearly between two samples.
    None when the two samples do not actually straddle the plane."""
    if abs(n_after - n_before) < 1e-9:
        return None
    t = (goal_position - n_before) / (n_after - n_before)
    if not (0.0 <= t <= 1.0):
        return None
    return c_before + t * (c_after - c_before)


class GoalLineDetector:
    """Per-session goal-line crossing + ball-outcome classifier.

    Feed it each frame's on-pitch ball position (from the INC-2b homography
    velocity) and speed. It keeps a short ring of recent on-pitch samples and
    classifies the ball's outcome over that window. ``update`` returns the
    current ``GoalLineSignal`` (or ``None`` until enough samples / no spec).
    """

    def __init__(self, spec: Optional[GoalLineSpec] = None, window: int = 6):
        self.spec = spec
        self.window = max(2, int(window))
        # ( (posX, posY), speed, ts )
        self._samples: Deque[Tuple[Tuple[float, float], float, float]] = deque(
            maxlen=self.window
        )

    def reset(self) -> None:
        self._samples.clear()

    def update(
        self,
        pos: Optional[Tuple[float, float]],
        speed: Optional[float],
        ts: float,
    ) -> Optional[GoalLineSignal]:
        """Push one on-pitch sample and return the goal-line signal.

        ``pos`` (posXm, posYm) in field meters, ``speed`` in m/s (may be None
        or 0 when the ball is absent / no homography). Returns None when no
        goal-line spec is configured or there is not yet enough data.
        """
        if self.spec is None:
            return None
        if pos is None:
            # Ball not on screen / no homography: treat as a gap, not a signal.
            self._samples.clear()
            return None
        speed = float(speed or 0.0)
        self._samples.append(((float(pos[0]), float(pos[1])), speed, float(ts)))
        if len(self._samples) < 2:
            return None
        return self._classify(self.spec, list(self._samples))

    def _classify(
        self, spec: GoalLineSpec, samples: Sequence[Tuple[Tuple[float, float], float, float]]
    ) -> GoalLineSignal:
        normals = [spec.normal(p) for p, _s, _t in samples]
        crosses = [spec.cross(p) for p, _s, _t in samples]
        speeds = [s for _p, s, _t in samples]
        peak_speed = float(max(speeds)) if speeds else 0.0

        # ---- detect a goal-line-plane crossing (sign change of normal axis) ----
        crossing_cross: Optional[float] = None
        crossing_speed: Optional[float] = None
        for i in range(1, len(samples)):
            n_before, n_after = normals[i - 1], normals[i]
            if (n_before - spec.position) * (n_after - spec.position) < 0:
                cc = _interp_cross(n_before, n_after, crosses[i - 1],
                                   crosses[i], spec.position)
                if cc is not None:
                    crossing_cross = cc
                    crossing_speed = speeds[i]
                    break

        last = samples[-1][0]

        if crossing_cross is not None:
            inside = spec.mouth_min <= crossing_cross <= spec.mouth_max
            cross_of_cross = crossing_cross
            if inside:
                return GoalLineSignal(True, "goal",
                                      normal=spec.normal(last), cross=cross_of_cross)
            # Crossed the plane outside the mouth -> off_target if it was shot
            # at pace, else a slow wide delivery (cross).
            if (crossing_speed is not None and crossing_speed >= STRIKE_SPEED_MPS) \
                    or peak_speed >= STRIKE_SPEED_MPS:
                return GoalLineSignal(True, "off_target",
                                      normal=spec.normal(last), cross=cross_of_cross)
            return GoalLineSignal(True, "cross",
                                  normal=spec.normal(last), cross=cross_of_cross)

        # ---- no crossing this window ----
        # A fast shot that comes near the line but is stopped before crossing
        # (speed collapse) is a blocked/saved effort.
        min_dist = min(abs(n - spec.position) for n in normals)
        if peak_speed >= STRIKE_SPEED_MPS and min_dist <= NEAR_LINE_M:
            # Confirm the speed actually collapses relative to the peak (so a
            # ball that simply leaves frame / keeps rolling isn't "blocked").
            last_speed = float(speeds[-1])
            if last_speed < BLOCKED_SPEED_FRACTION * peak_speed:
                return GoalLineSignal(False, "blocked",
                                      normal=spec.normal(last), cross=spec.cross(last))
        return GoalLineSignal(False, "no_shot",
                              normal=spec.normal(last), cross=spec.cross(last))

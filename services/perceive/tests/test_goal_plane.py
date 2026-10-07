"""Unit tests for the goal-line / ball-outcome classifier (decide-leg I2 /
ADAAAA-6359).

Field convention mirrors ``test_pitch_homography``: X width (0..68), Y length
(0..105). We put a goal at the near end-line Y=0 with the mouth spanning X in
[20, 48] (a 7.32m real goal centred on a 68m pitch would be ~[30.3, 37.7]; we
use a wider synthetic mouth so the off-mouth cases are unambiguous).

The I2 accept criterion is >=90% agreement vs the label manifest for the
``goal`` / ``off_target`` / ``no_shot`` classes; these tests lock the discrete
geometry the classifier must separate (the VOD/live evals measure the real
agreement on the labeled set).
"""
import numpy as np
import pytest

from app.goal_plane import GoalLineDetector, GoalLineSpec, STRIKE_SPEED_MPS

# Near end-line goal at Y=0, mouth spans X in [20, 48].
SPEC = GoalLineSpec(axis="y", position=0.0, mouth_min=20.0, mouth_max=48.0)

DT = 1.0 / 60.0


def _feed(det, positions, speeds, start_ts=0.0):
    """Feed one sample per (pos, speed) pair and return the last signal."""
    out = None
    for k, (pos, speed) in enumerate(zip(positions, speeds)):
        out = det.update(pos, speed, ts=start_ts + k * DT)
    return out


def test_goal_when_crosses_inside_mouth():
    det = GoalLineDetector(SPEC, window=6)
    # Ball travels toward Y=0 and crosses inside the mouth (X stays ~34).
    positions = [(34.0, 8.0), (34.0, 5.0), (34.0, 2.0), (34.0, -1.0)]
    speeds = [12.0, 13.0, 13.0, 12.0]
    sig = _feed(det, positions, speeds)
    assert sig is not None
    assert sig.goalCrossed is True
    assert sig.ballOutcome == "goal"


def test_off_target_when_crosses_wide_at_speed():
    det = GoalLineDetector(SPEC, window=6)
    # Crosses Y=0 well outside the mouth (X ~5) at shot pace -> off target.
    positions = [(5.0, 8.0), (5.0, 4.0), (5.0, 1.0), (5.0, -1.0)]
    speeds = [12.0, 11.0, 12.0, 11.0]
    sig = _feed(det, positions, speeds)
    assert sig is not None
    assert sig.goalCrossed is True
    assert sig.ballOutcome == "off_target"


def test_cross_when_wide_delivery_slow():
    det = GoalLineDetector(SPEC, window=6)
    # Crosses outside the mouth but at sub-shot pace -> a cross, not a shot.
    positions = [(60.0, 8.0), (60.0, 4.0), (60.0, 1.0), (60.0, -1.0)]
    speeds = [3.0, 3.5, 3.0, 3.2]
    sig = _feed(det, positions, speeds)
    assert sig is not None
    assert sig.goalCrossed is True
    assert sig.ballOutcome == "cross"


def test_blocked_when_speed_collapses_before_line():
    det = GoalLineDetector(SPEC, window=6)
    # Fast shot approaches to Y~1.2 (within 3m of the line) then is stopped:
    # speed collapses and the ball never crosses (no sign change).
    positions = [(34.0, 20.0), (34.0, 8.0), (34.0, 3.0), (34.0, 1.2),
                 (34.0, 0.5), (34.0, 0.4)]
    speeds = [14.0, 13.0, 12.0, 5.0, 2.0, 1.5]
    sig = _feed(det, positions, speeds)
    assert sig is not None
    assert sig.goalCrossed is False
    assert sig.ballOutcome == "blocked"


def test_no_shot_for_ambient_play():
    det = GoalLineDetector(SPEC, window=6)
    # Ball stays central, far from the line, at walk pace -> no shot.
    positions = [(34.0, 60.0), (34.0, 55.0), (35.0, 50.0), (36.0, 45.0)]
    speeds = [2.0, 2.5, 2.0, 3.0]
    sig = _feed(det, positions, speeds)
    assert sig is not None
    assert sig.goalCrossed is False
    assert sig.ballOutcome == "no_shot"


def test_no_signal_without_spec():
    det = GoalLineDetector(None, window=6)
    sig = _feed(det, [(34.0, 5.0), (34.0, -1.0)], [12.0, 12.0])
    assert sig is None


def test_insufficient_samples_returns_none():
    det = GoalLineDetector(SPEC, window=6)
    assert det.update((34.0, 5.0), 12.0, 0.0) is None


def test_reset_clears():
    det = GoalLineDetector(SPEC, window=6)
    _feed(det, [(34.0, 5.0), (34.0, 2.0), (34.0, -1.0)], [12.0, 13.0, 12.0])
    det.reset()
    assert det.update((34.0, 5.0), 12.0, 0.0) is None


def test_spec_from_dict_invalid_returns_none():
    assert GoalLineSpec.from_dict(None) is None
    assert GoalLineSpec.from_dict({}) is not None  # defaults apply
    assert GoalLineSpec.from_dict({"position": "not-a-number"}) is None
    spec = GoalLineSpec.from_dict(
        {"axis": "x", "position": 68.0, "mouthMin": 30.0, "mouthMax": 38.0}
    )
    assert spec is not None and spec.axis == "x" and spec.position == 68.0
    assert spec.mouth_min == 30.0 and spec.mouth_max == 38.0


def test_x_axis_goal():
    # A goal on the right end-line: plane at X=68, mouth spans Y in [40, 65].
    spec = GoalLineSpec(axis="x", position=68.0, mouth_min=40.0, mouth_max=65.0)
    det = GoalLineDetector(spec, window=6)
    # Ball crosses X=68 inside the mouth (Y stays ~52).
    positions = [(60.0, 52.0), (64.0, 52.0), (67.0, 52.0), (69.0, 52.0)]
    speeds = [12.0, 13.0, 12.0, 12.0]
    sig = _feed(det, positions, speeds)
    assert sig is not None
    assert sig.goalCrossed is True
    assert sig.ballOutcome == "goal"

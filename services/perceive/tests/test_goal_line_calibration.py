"""Unit tests for the per-session goal-line calibration wiring (ADAAAA-6489 /
ADAAAA-7159 Gap 2).

The server path delivers a per-camera/per-clip calibration (homography +
goalLine) on every /analyze. ``_apply_calibration`` folds it into the session so
the goal-line detector / ball-signal pipeline produce a REAL measured
goalCrossed/ballOutcome (never a fabricated uncalibrated flip). A bad value is
ignored (KEEP the prior calibration, never fatal); absent leaves the session's
calibration untouched (image-space / no-goal-line-signal fallback -> reported
not_captured, never invented).
"""
import numpy as np

from app import _apply_calibration
from app.session import SessionState

GOAL = {"axis": "y", "position": 0.0, "mouthMin": 20.0, "mouthMax": 48.0}
HOMOG = np.eye(3).tolist()


def _state() -> SessionState:
    return SessionState(session_id="s-cal")


def test_apply_calibration_sets_homography_and_goal_line():
    st = _state()
    _apply_calibration(st, HOMOG, GOAL)
    assert st.homography is not None
    assert st.ball_signal is not None
    assert st.goal_line_spec is not None
    assert st.goal_line_detector is not None
    assert st.goal_line_detector.spec is st.goal_line_spec


def test_apply_calibration_bad_values_keep_prior():
    st = _state()
    _apply_calibration(st, HOMOG, GOAL)
    prev_H = st.homography
    prev_spec = st.goal_line_spec
    # Bad homography (not 9 values) + bad goalLine (axis out of {x,y}) -> the
    # prior calibration is KEPT (never fatal, never a bogus signal).
    _apply_calibration(st, [1, 2, 3], {"axis": "z"})
    assert st.homography is prev_H
    assert st.goal_line_spec is prev_spec
    assert st.goal_line_detector.spec is prev_spec


def test_apply_calibration_absent_is_noop():
    st = _state()
    _apply_calibration(st, None, None)
    assert st.homography is None
    assert st.ball_signal is None
    assert st.goal_line_spec is None
    assert st.goal_line_detector is None


def test_detector_emits_real_measured_outcome():
    # A genuine goal-line crossing inside the mouth -> REAL goal attestation
    # (goalCrossed=true, ballOutcome=goal) from the supplied spec.
    st = _state()
    _apply_calibration(st, None, GOAL)
    det = st.goal_line_detector
    sig = None
    for pos, spd, ts in [
        ((30.0, 2.0), 12.0, 0.0),
        ((30.0, 1.0), 12.0, 0.02),
        ((30.0, -1.0), 12.0, 0.04),  # crosses Y=0 inside the mouth
    ]:
        sig = det.update(pos, spd, ts)
    assert sig is not None
    assert sig.goalCrossed is True
    assert sig.ballOutcome == "goal"


def test_no_calibration_emits_no_outcome():
    # No spec supplied -> detector is None, so no goalCrossed/ballOutcome is
    # ever fabricated (the candidate stays unattested -> decide reports
    # not_captured, never a flipped signal).
    st = _state()
    _apply_calibration(st, None, None)
    assert st.goal_line_detector is None
    assert st.goal_line_spec is None

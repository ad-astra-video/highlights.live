"""ADAAAA-6489 — server-path per-session goal-line calibration delivery.

Locks the new wiring: the detail-first/VOD server path now supplies a
per-camera/per-clip goal-line calibration (image->field homography + goal-line
plane spec) to the perceive session, so the goal-line crossing signal
(ballOutcome / goalCrossed) is REAL — and a clip that has no calibration is
reported not_captured rather than fabricated.

Acceptance #1 mechanism: a near-goal trajectory configured through the same
calibration-apply path the /analyze handler uses must emit a non-goal
ballOutcome (off_target), which decide's reconcile turns into outcome=near_miss
(the decide side is locked separately in services/decide/tests/test_near_miss.py).
"""
from app import _apply_calibration, _ensure_goal_line_detector
from app.goal_plane import GoalLineDetector, GoalLineSpec
from app.session import SessionState

# Near end-line goal at Y=0, mouth spans X in [20, 48] (mirror test_goal_plane).
GOAL_LINE = {"axis": "y", "position": 0.0, "mouthMin": 20.0, "mouthMax": 48.0}
# Identity 3x3 (row-major 9 numbers): image (normalized) == field for this test.
H = [1, 0, 0, 0, 1, 0, 0, 0, 1]

DT = 1.0 / 60.0


def _near_goal_trajectory(det):
    """A shot that crosses the goal-line plane WIDE of the mouth at shot pace
    -> off_target (a goal-bound shot that did not convert => the near-miss class
    decide reconciles to near_miss)."""
    positions = [(5.0, 8.0), (5.0, 4.0), (5.0, 1.0), (5.0, -1.0)]
    speeds = [12.0, 11.0, 12.0, 11.0]
    sig = None
    for k, (pos, speed) in enumerate(zip(positions, speeds)):
        sig = det.update(pos, speed, ts=k * DT)
    return sig


def test_apply_calibration_configures_goal_line_signal():
    st = SessionState(session_id="s-6489-1")
    assert st.goal_line_spec is None
    assert st.homography is None
    # The server path delivers homography + goalLine on /analyze -> applied.
    _apply_calibration(st, H, GOAL_LINE)
    assert st.homography is not None
    assert st.goal_line_spec is not None
    det = _ensure_goal_line_detector(st)
    assert det is not None
    sig = _near_goal_trajectory(det)
    assert sig is not None
    assert sig.goalCrossed is True
    # A goal-bound shot that missed (wide at pace) is the near-miss class.
    assert sig.ballOutcome == "off_target"


def test_bad_homography_keeps_prior_never_fatal():
    st = SessionState(session_id="s-6489-2")
    _apply_calibration(st, H, GOAL_LINE)  # valid first
    # Bad homography (not 9 numbers) + bad goalLine are ignored, prior kept.
    _apply_calibration(st, [1, 0], "not-a-dict")
    assert st.homography is not None and st.homography.shape == (3, 3)
    assert st.goal_line_spec is not None
    assert _ensure_goal_line_detector(st) is not None


def test_no_calibration_reports_not_captured():
    st = SessionState(session_id="s-6489-3")
    # No goal-line spec configured -> no detector -> no ballOutcome (not_captured).
    assert _ensure_goal_line_detector(st) is None
    assert st.goal_line_spec is None


def test_goal_ball_outcome_when_calibrated():
    """Sanity: a genuine goal (crosses inside the mouth) is still `goal`, so the
    calibration path never mislabels a real goal as a near-miss."""
    det = GoalLineDetector(GoalLineSpec.from_dict(GOAL_LINE), window=6)
    positions = [(34.0, 8.0), (34.0, 5.0), (34.0, 2.0), (34.0, -1.0)]
    speeds = [12.0, 13.0, 13.0, 12.0]
    sig = None
    for k, (pos, speed) in enumerate(zip(positions, speeds)):
        sig = det.update(pos, speed, ts=k * DT)
    assert sig is not None
    assert sig.ballOutcome == "goal"

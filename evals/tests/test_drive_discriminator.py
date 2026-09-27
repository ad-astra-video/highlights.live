"""Tests for the celebration-discriminator honest spatial signals in
evals/drive_inc8.py (INC-9 precision / ADAAAA-4496).

ball_in_goal_mouth() and celebration_cluster() are computed from perceive's OWN
detections (track/object bboxes) - never ground-truth labels. A real goal puts
the ball in/near the goal mouth and crowds a celebration pile of players there;
off-target / warm-up keep the ball in midfield/centre-circle with players spread
(or huddled mid-pitch). These tests assert the signals separate the two.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from drive_inc8 import ball_in_goal_mouth, celebration_cluster  # noqa: E402


def _track(bbox, kind="player"):
    return {"kind": kind, "bbox": list(bbox), "trackId": "t"}


def test_ball_in_goal_mouth_right_corner():
    # ball detection near the right goal mouth -> True (honest detection)
    obs = {"objects": [{"label": "soccer ball", "bbox": [0.85, 0.45, 0.90, 0.50]}]}
    assert ball_in_goal_mouth(obs) is True


def test_ball_in_goal_mouth_centre_is_false():
    # warm-up/off-target: ball at centre-circle -> not a goal-mouth placement
    obs = {"objects": [{"label": "soccer ball", "bbox": [0.48, 0.50, 0.53, 0.55]}]}
    assert ball_in_goal_mouth(obs) is False


def test_no_ball_detected_is_false():
    assert ball_in_goal_mouth({"objects": [], "tracks": []}) is False


def test_ball_via_track_fallback():
    obs = {"objects": [], "tracks": [_track([0.05, 0.40, 0.10, 0.46], kind="ball")]}
    assert ball_in_goal_mouth(obs) is True


def test_celebration_cluster_pile_at_goal():
    # 3 players tucked together in the left goal mouth = celebration pile
    obs = {"tracks": [
        _track([0.05, 0.40, 0.12, 0.52]),
        _track([0.10, 0.42, 0.17, 0.54]),
        _track([0.07, 0.45, 0.14, 0.57]),
        _track([0.50, 0.50, 0.60, 0.65]),  # far centre-circle player, not in pile
    ]}
    assert celebration_cluster(obs) >= 3


def test_celebration_cluster_spread_or_centre_is_low():
    # warm-up: players spread / huddled at centre-circle, none in the goal mouth
    obs = {"tracks": [
        _track([0.45, 0.50, 0.55, 0.65]),
        _track([0.50, 0.45, 0.60, 0.60]),
        _track([0.55, 0.48, 0.65, 0.63]),
    ]}
    assert celebration_cluster(obs) == 0


def test_celebration_cluster_ignores_ball_and_tiny_boxes():
    # ball-kind + ball-sized boxes must not inflate the player cluster
    obs = {"tracks": [
        _track([0.05, 0.40, 0.12, 0.52]),
        _track([0.07, 0.42, 0.10, 0.45], kind="ball"),
        _track([0.04, 0.44, 0.046, 0.047]),  # ball-sized
    ]}
    assert celebration_cluster(obs) == 1

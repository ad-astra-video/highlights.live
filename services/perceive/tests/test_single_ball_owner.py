"""ADAAAA-7536: single-ball invariant for ball-first rosters.

The board reported "soccer ball detection boxes and labels on frames that don't
make any sense" — live reproduction (job 7fbcdb02, seq 334) showed three
*collateral* "soccer ball" boxes pointing at an advertising board, a player's
leg, and a foreground person's back (94% of the job's frames carried >=1 ball
box, 68% carried >=2 simultaneous). These are Florence-2 open-<OD> false
positives surfaced by the default ball-first soccer roster (["soccer ball",
"goal"]): every hallucinated "soccer ball" detection is seeded and rendered as
its own box. A soccer frame has exactly ONE ball, so `_single_ball_owner`
collapses multiple ball detections to a single box before seeding.

No real model required — the helper is a pure function.
"""
from app import _single_ball_owner


def test_single_ball_is_unchanged():
    boxes = [[0.1, 0.2, 0.2, 0.3]]
    labels = ["soccer ball"]
    assert _single_ball_owner(boxes, labels) == (boxes, labels)


def test_no_ball_is_unchanged():
    boxes = [[0.1, 0.2, 0.2, 0.3]]
    labels = ["goal"]
    assert _single_ball_owner(boxes, labels) == (boxes, labels)


def test_collapses_to_smallest_on_cold_start():
    # Cold (no prior ball): keep the SMALLEST box — a real soccer ball is small;
    # the huge over-frame boxes are the egregious false positives.
    boxes = [
        [0.02, 0.04, 0.90, 0.95],  # huge (ad-board/body false positive)
        [0.40, 0.45, 0.44, 0.49],  # plausibly small (the ball)
        [0.60, 0.20, 0.61, 0.22],  # tiny sliver
    ]
    labels = ["soccer ball", "soccer ball", "soccer ball"]
    out_boxes, out_labels = _single_ball_owner(boxes, labels)
    assert len(out_boxes) == 1
    assert len(out_labels) == 1
    # smallest area = the 0.04x0.04 box
    assert out_boxes[0] == [0.40, 0.45, 0.44, 0.49]
    assert out_labels[0] == "soccer ball"


def test_collapse_prefers_tracked_ball_for_continuity():
    # With a previous ball center, keep the detection nearest it (timeline
    # continuity) even if it is not the smallest.
    boxes = [
        [0.10, 0.10, 0.12, 0.12],  # far from prior ball
        [0.50, 0.50, 0.54, 0.54],  # near prior ball
    ]
    labels = ["soccer ball", "soccer ball"]
    # prior ball center ~ (0.52, 0.52)
    out_boxes, _ = _single_ball_owner(boxes, labels, last_ball_center=(0.52, 0.52))
    assert out_boxes == [[0.50, 0.50, 0.54, 0.54]]


def test_non_ball_detections_survive_collapse():
    # Collapsing ball detections must NOT drop genuine non-ball detections
    # (goal / player boxes) alongside.
    boxes = [
        [0.5, 0.5, 0.54, 0.54],  # ball small
        [0.05, 0.7, 0.45, 0.95],  # goal
        [0.8, 0.8, 0.9, 0.9],  # ball huge (false positive)
    ]
    labels = ["soccer ball", "goal", "soccer ball"]
    out_boxes, out_labels = _single_ball_owner(boxes, labels)
    assert "goal" in out_labels
    assert out_labels.count("soccer ball") == 1


def test_empty_input_unchanged():
    assert _single_ball_owner([], []) == ([], [])

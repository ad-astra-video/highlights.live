"""Regression tests for the shot-window FP class (ADAAAA-7687).

The four residual shot-vs-goal false positives on build `da2d21a`
(`178.1, 203.2, 358.8, 401.7`, all labelled shot-class windows in
`label-manifest.json`) plus the `evidence:none` FP at `252.6` are pinned here
against a slimmed, faithful slice of the real job detail
(`tests/fixtures/job_detail_ac6bf37f_slim.json`, derived from
`GET /jobs/ac6bf37f-.../detail`). The slice keeps every accepted highlight, every
decide note's confirm annotation + Stage-1 criteria, and the cached ball tracks
around the accepted instants; reason text is truncated to its first clause with
the confirm annotation preserved verbatim, because the harness only pattern
matches that annotation.

These tests fail loudly if a confirm-stage change moves the accepted set, so a
future guard that rejects a shot-window FP shows up as an intentional update to
the recorded table rather than a silent change.
"""
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
EVAL_DIR = os.path.dirname(HERE)
sys.path.insert(0, EVAL_DIR)

import shot_vs_goal_discrimination as svg  # noqa: E402

MANIFEST = os.path.join(EVAL_DIR, "label-manifest.json")
FIXTURE = os.path.join(HERE, "fixtures", "job_detail_ac6bf37f_slim.json")

# Recorded on build da2d21a (ADAAAA-7687 measurement).
RECORDED_RULES = {
    "none": (23, 0.7826, 1.0),
    "reject_frame_attestation": (11, 0.9091, 0.5333),
    "reject_scoreboard_trigger_no_confirm": (19, 0.7895, 0.8667),
    "reject_cluster_non_goal_majority": (2, 1.0, 0.1333),
    "reject_no_prior_goal_read": (18, 0.7778, 0.8),
    "reject_ball_stays_in_play": (8, 1.0, 0.4667),
    "reject_no_crowd_criteria": (22, 0.8182, 1.0),
    "oracle_reject_known_fps": (18, 1.0, 1.0),
}

# The shot-window FP class this issue is about.
SHOT_WINDOW_FPS = (178.1, 203.2, 358.8, 401.7)


@pytest.fixture(scope="module")
def analysis():
    manifest = json.load(open(MANIFEST))
    detail = json.load(open(FIXTURE))
    return svg.analyse(manifest, detail, commit="da2d21a")


def test_fixture_reproduces_the_builds_accepted_set(analysis):
    assert analysis["accepted_cards"] == 23
    assert analysis["goal_cards"] == 18
    assert analysis["false_positive_cards"] == 5
    assert analysis["baseline"]["precision"] == 0.7826
    assert analysis["baseline"]["recall_vs_accepted_goals"] == 1.0


def test_shot_window_fps_are_pinned(analysis):
    """The four shot-class FPs are accepted cards anchored on the model's own
    frame attestation — the anchor a confirm-stage guard has to dislodge."""
    by_t = {round(f["t"], 1): f for f in analysis["cards"]}
    for t in SHOT_WINDOW_FPS:
        card = by_t[t]
        assert card["goal_label"] is None, f"t={t} must not match a labelled goal"
        assert card["corroborationSource"] == "frame_attestation"
        assert card["goalConfirmed"] == "confirmed_goal"
    # the fifth FP (evidence:none window) was accepted without a confirm dive
    none_fp = by_t[252.6]
    assert none_fp["goal_label"] is None
    assert none_fp["corroborationSource"] is None
    assert none_fp["triggerKind"] == "score_change"


def test_no_deterministic_confirm_stage_rule_meets_ac1(analysis):
    """Precision >= 0.94 at recall 1.0 is not reachable from the confirm-stage
    signals the pipeline already produces (ADAAAA-7687 measurement). If a new
    rule lands, it must replace this assertion deliberately."""
    assert analysis["usable_rules"] == []
    best = max((r for r in analysis["rules"]
                if r["rule"] != "oracle_reject_known_fps"
                and r["precision"] is not None
                and r["recall_vs_accepted_goals"] == 1.0),
               key=lambda r: r["precision"])
    # precision-at-full-recall ceiling: killing 203.2 only, +3.5 points, n=1
    assert best["rule"] == "reject_no_crowd_criteria"
    assert best["precision"] == 0.8182
    assert best["recall_vs_accepted_goals"] == 1.0


def test_recorded_rule_table(analysis):
    for rule in analysis["rules"]:
        accepted, precision, recall = RECORDED_RULES[rule["rule"]]
        assert rule["accepted"] == accepted, rule["rule"]
        assert rule["precision"] == precision, rule["rule"]
        assert rule["recall_vs_accepted_goals"] == recall, rule["rule"]


def test_oracle_row_is_the_only_ceiling(analysis):
    oracle = next(r for r in analysis["rules"] if r["rule"] == "oracle_reject_known_fps")
    assert oracle["precision"] == 1.0
    assert oracle["recall_vs_accepted_goals"] == 1.0
    assert oracle["rejected"] == list(svg.KNOWN_FPS)


def test_analysis_is_deterministic():
    manifest = json.load(open(MANIFEST))
    detail = json.load(open(FIXTURE))
    a = json.dumps(svg.analyse(manifest, detail, commit="da2d21a"), sort_keys=True)
    b = json.dumps(svg.analyse(manifest, detail, commit="da2d21a"), sort_keys=True)
    assert a == b


def test_confirm_verdict_annotation_parsing():
    assert svg._confirm_verdict({"reason": "x; confirmation pass: goal confirmed (deep frame dive)"}) == "goal"
    assert svg._confirm_verdict({"reason": "confirmation pass: near miss — the play did not convert"}) == "near_miss"
    assert svg._confirm_verdict({"reason": "confirmation pass: not a goal — not a highlight"}) == "not_goal"
    assert svg._confirm_verdict({"reason": "no confirm ran here"}) == "-"


def test_ball_path_ignores_offscreen_and_non_ball_tracks():
    frames = [
        {"timestamp": 0.0, "tracks": [{"kind": "player", "bbox": [0.1, 0.1, 0.2, 0.2]}]},
        {"timestamp": 1.0, "tracks": [{"kind": "ball", "bbox": [0.10, 0.10, 0.12, 0.12]}]},
        {"timestamp": 2.0, "tracks": [{"kind": "ball", "bbox": [0.30, 0.10, 0.32, 0.12]}]},
        {"timestamp": 3.0, "tracks": [{"kind": "ball", "bbox": [0.90, 0.90, 0.92, 0.92], "onScreen": False}]},
    ]
    pts = svg._ball_path(frames, 0.0, 10.0)
    assert [p[0] for p in pts] == [1.0, 2.0]
    assert svg._path_length(pts) == pytest.approx(0.2)

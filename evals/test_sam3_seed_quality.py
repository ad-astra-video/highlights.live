#!/usr/bin/env python3
"""Tests for `evals/sam3_seed_quality.py` (ADAAAA-7287).

Covers the SAM3 seed-quality + track-persistence metric accounting, especially
the over-large-seed failure mode (ADAAAA-7262):
  - a plausible tight seed is adopted and persists (high seed IoU + persistence),
  - an over-large seed is rejected by the guard -> `sam_player_box` null / 0,
  - seeding an over-large box into a SAM backend that cannot propagate it
    collapses persistence (the reason the guard exists).
"""

from __future__ import annotations

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import sam3_seed_quality as sq  # noqa: E402

GT = (0.27, 0.31, 0.35, 0.69)  # tight GT player box (normalized)
N = 12


def _gt_window(n=N):
    return [GT for _ in range(n)]


def test_is_plausible_player_seed_box_guard():
    assert sq.is_plausible_player_seed_box(GT) is True
    # near-full-frame box (ADAAAA-7262 scorebug OCR match): area/side way over cap
    assert sq.is_plausible_player_seed_box((0.02, 0.02, 0.98, 0.85)) is False
    assert sq.is_plausible_player_seed_box((0.9, 0.9, 0.99, 0.99)) is True   # tiny box
    assert sq.is_plausible_player_seed_box(None) is False
    assert sq.is_plausible_player_seed_box([0.1, 0.1, 0.2]) is False


def test_perfect_seed_is_kept_and_persists():
    r = sq.measure_seed_quality(GT, _gt_window(), mode="stub")
    assert r["plausible_seed"] is True
    assert r["reason"] == "seeded"
    assert r["track_persistence"] >= sq.ACCEPT_PERSIST
    assert r["sam_player_box_null_frames"] == 0
    assert r["slot_kept_frames"] == N
    assert r["seed_iou_mean"] is not None and r["seed_iou_mean"] >= 0.90
    assert all(p["seeded"] and p["sam_player_box"] is not None for p in r["per_frame"])


def test_overlarge_seed_rejected_by_guard():
    r = sq.measure_seed_quality((0.02, 0.02, 0.98, 0.85), _gt_window(), mode="stub")
    assert r["plausible_seed"] is False
    assert r["reason"] == "overlarge_seed_rejected"
    assert r["sam_player_box_null_frames"] == N
    assert r["slot_kept_frames"] == 0
    assert r["track_persistence"] == 0.0
    assert all(p["sam_player_box"] is None and not p["seeded"]
               for p in r["per_frame"])


def test_seeded_overlarge_box_collapses_persistence():
    # Bypass the guard and feed the over-large box to a SAM backend that loses it
    # after a couple frames -> persistence collapses below the 0.90 accept bar.
    r = sq.measure_seed_quality(
        (0.02, 0.02, 0.98, 0.85), _gt_window(), mode="stub",
        apply_guard=False, backend=sq.StubSamBackend(collapse_after=2),
    )
    assert r["reason"] == "seeded"
    assert r["track_persistence"] < sq.ACCEPT_PERSIST
    assert r["sam_player_box_null_frames"] > 0
    assert r["slot_kept_frames"] < N


def test_no_seed_returns_null_without_crashing():
    r = sq.measure_seed_quality(None, _gt_window(), mode="stub")
    assert r["reason"] == "no_seed"
    assert r["track_persistence"] == 0.0
    assert all(p["sam_player_box"] is None for p in r["per_frame"])


def test_on_off_gt_player_gives_none_seed_iou_only_on_absent_frames():
    # A frame with no GT player box yields seed_iou None but the slot still kept.
    gt = [GT, None, GT, GT]
    r = sq.measure_seed_quality(GT, gt, mode="stub")
    assert r["seed_iou_sampled_frames"] == 3  # 3 of 4 frames have a GT player
    assert r["track_persistence"] >= sq.ACCEPT_PERSIST
    assert r["per_frame"][1]["seed_iou"] is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

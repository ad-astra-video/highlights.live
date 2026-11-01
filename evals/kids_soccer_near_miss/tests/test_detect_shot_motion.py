"""Self-check for the second read layer (detect_shot_motion.py, ADAAAA-7643).

Runner test only: no frames dir, no network. It proves the *accounting* of the
layer, not its accuracy on real footage — accuracy is the calibration's job
(`results/shot_motion_summary.json`). What this pins down:

  * a cut second can never be called a shot (a broadcast cut is not a shot);
  * the block score ignores the scoreboard strip and reports the hottest block
    inside the pitch band;
  * the global shift really recovers a known translation;
  * the AUC helper reports 1.0 / 0.5 at the two ends of separation, so a
    "score carries no signal" verdict cannot be produced by an arithmetic bug.
"""
import importlib
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
dsm = importlib.import_module("detect_shot_motion")


def test_cut_second_is_never_a_shot():
    hot = {"t": 10, "score": 500.0, "cut": False}
    cut = {"t": 11, "score": 500.0, "cut": True}
    assert dsm.shot_at(hot, 55) is True
    assert dsm.shot_at(cut, 55) is False
    assert dsm.shot_at({"t": 12, "score": 54.9, "cut": False}, 55) is False


def test_block_score_ignores_scoreboard_and_finds_hot_block():
    frame = np.zeros((360, 640), dtype=np.float32)
    # scoreboard strip: a huge change that must be masked out
    frame[0:40, 0:170] = 255.0
    # one hot 8x8 block inside the pitch band
    frame[200:208, 400:408] = 90.0
    score = dsm.block_score(frame)
    assert score == 90.0


def test_block_score_is_zero_on_a_flat_residual():
    assert dsm.block_score(np.zeros((360, 640), dtype=np.float32)) == 0.0


def test_global_shift_recovers_a_known_translation():
    rng = np.random.default_rng(7)
    base = rng.integers(0, 255, size=(360, 640)).astype(np.float32)
    cur = np.roll(base, (12, -16), axis=(0, 1))  # content moved down 12, left 16
    dy, dx = dsm.global_shift(base, cur, down=4)
    aligned = dsm.shift_image(base, dy, dx)
    ok = ~np.isnan(aligned)
    # the returned offset is the shift_image sampling offset that aligns the pair
    assert abs(float(np.abs(cur - aligned)[ok].mean())) < 0.5


def test_auc_reports_both_ends_of_separation():
    assert dsm.auc([9, 8, 7], [1, 2, 3]) == 1.0
    assert dsm.auc([1, 2, 3], [1, 2, 3]) == 0.5
    assert dsm.auc([], [1]) is None

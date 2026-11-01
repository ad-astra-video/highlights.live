"""Pin the region-first motion result (ADAAAA-7611 AC-1, 2026-11-01).

`localised_shot_motion.py` was the third deterministic attempt at a shot
labeller: same statistic as the two earlier layers but restricted to a
goal-mouth region derived from the labelled goal windows (the "localise first"
insight the vision read produced). It scored AUC 0.442 — chance — so the
negative result is recorded, not just described.
"""
import importlib
import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

lsm = importlib.import_module("localised_shot_motion")

SUMMARY = HERE / "results" / "localised_shot_motion_summary.json"


def test_cell_map_masks_the_scoreboard_strip():
    resid = np.zeros((70, 120), dtype=np.float32)
    resid[0:10, 0:10] = 200.0        # overlay digits, not pitch motion
    cells = lsm.cell_map(resid, (12, 7))
    assert np.isnan(cells[0, 0])
    assert np.nanmax(cells) == 0.0


def test_cell_map_finds_the_hot_cell():
    resid = np.zeros((70, 120), dtype=np.float32)
    resid[60:70, 60:70] = 80.0       # one moving object, bottom-centre cell
    cells = lsm.cell_map(resid, (12, 7))
    r, c = np.unravel_index(np.nanargmax(cells), cells.shape)
    assert (r, c) == (6, 6)
    assert cells[r, c] == 80.0


def test_region_needs_a_goal_to_quiet_contrast():
    g = np.full((7, 12), 10.0)
    q = np.full((7, 12), 10.0)
    g[5, 0] = 100.0
    q[5, 0] = 10.0
    region = lsm.pick_region([g], [q], pct=90)
    assert region == [(5, 0)]
    # a cell that is equally hot on quiet seconds is not goal-mouth specific
    q[5, 0] = 90.0
    assert lsm.pick_region([g], [q], pct=90) == []


def test_region_max_ignores_nan_cells_and_empty_region():
    cells = np.full((7, 12), np.nan)
    cells[5, 0] = 42.0
    assert lsm.region_max(cells, [(5, 0), (0, 0)]) == 42.0
    assert lsm.region_max(cells, [(0, 0)]) == 0.0


def test_windows_from_manifest_splits_the_three_classes():
    m = {"windows": [
        {"id": "g", "t_start": 1, "t_end": 2, "ground_truth": "goal",
         "evidence": "ball_in_net"},
        {"id": "s", "t_start": 3, "t_end": 4, "ground_truth": "no_goal",
         "evidence": "saved"},
        {"id": "c", "t_start": 5, "t_end": 6, "ground_truth": "no_goal",
         "evidence": "none"},
    ]}
    assert [w[0] for w in lsm.windows_from_manifest(m, {"goal"})] == ["g"]
    assert [w[0] for w in lsm.windows_from_manifest(m, {"shot"})] == ["s"]
    assert [w[0] for w in lsm.windows_from_manifest(m, {"control"})] == ["c"]


def test_recorded_verdict_is_the_negative_result():
    """The committed measurement must stay the one RESULTS.md quotes."""
    assert SUMMARY.exists(), "run localised_shot_motion.py on the box first"
    with open(SUMMARY) as fh:
        d = json.load(fh)
    assert d["grid"] == "12x7"
    assert d["region"]["n_cells"] == 3
    assert d["region"]["cells"] == [[5, 0], [5, 3], [6, 0]]
    assert d["auc_shot_vs_control_in_region"] == 0.442
    assert d["medians"]["shot"] == 74.64 and d["medians"]["control"] == 76.66
    assert "does NOT meet" in d["verdict"]
    assert len(d["shots"]) == 10 and len(d["controls"]) == 12


GEMMA_CAL = HERE / "results" / "gemma_labeller_cal.json"


def test_recorded_gemma_labeller_calibration_is_the_negative_result():
    """The local gemma layer is fast but not a labeller; pin the numbers."""
    assert GEMMA_CAL.exists(), "run gemma_labeller_cal.py inside the compose network"
    with open(GEMMA_CAL) as fh:
        d = json.load(fh)
    assert d["reads"] == 245
    assert d["shot_windows_reproduced"] == 10 and d["shot_windows"] == 10
    # ... and the loose rule also flags every control window: no discrimination
    assert d["control_windows_false_shot"] == 12 and d["control_windows"] == 12
    assert d["strict_bar"]["shots_reproduced"] == 6
    assert d["strict_bar"]["control_windows_false"] == 4
    assert "not a labeller" in d["verdict"]
    assert len(d["per_window"]) == 22

"""ADAAAA-8744 WP3 — the operating-point harness's own guards.

The grid run itself is the end-to-end self-test (real frames, real reader, real
oracle). These tests pin the four properties a reviewer cannot re-derive from the
printed table:

1. A6: a manifest or clip that is not the pinned artifact **voids** the run — no
   number is produced (the harness raises ``Voided``, it does not warn and go on).
2. The park/continue decision: only a cell that clears *all* of A1-A4 can be
   chosen, and a grid where nothing clears chooses nothing (plan §7.4 park).
3. The printed table exposes every cell's own A1-A4 verdict — no aggregated number
   that lets a failing cell hide inside a passing one.
4. A cell's candidate export is a valid `evals/hud_oracle.py` export (so QA can
   re-score any cell on its own box), and it cannot carry label fields.
"""
import importlib.util
import os
import sys
import tempfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


harness = _load("measure_hud_recall", "measure_hud_recall.py")
oracle = _load("hud_oracle_under_test", "hud_oracle.py")


MANIFEST = os.path.join(HERE, "supertuxkart_val", "label-manifest.json")


def _copy_with(mutate):
    with open(MANIFEST, "rb") as fh:
        raw = bytearray(fh.read())
    mutate(raw)
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "wb") as fh:
        fh.write(bytes(raw))
    return path


def test_pinned_manifest_passes():
    assert harness.check_manifest(MANIFEST, oracle) == oracle.MANIFEST_SHA256


def test_tampered_manifest_voids_the_run():
    path = _copy_with(lambda raw: raw.extend(b"\n"))
    try:
        with pytest.raises(harness.Voided):
            harness.check_manifest(path, oracle)
    finally:
        os.unlink(path)


def test_wrong_clip_voids_the_run():
    manifest = oracle.load_manifest(MANIFEST)
    fd, path = tempfile.mkstemp(suffix=".mp4")
    os.write(fd, b"not the labelled clip")
    os.close(fd)
    try:
        with pytest.raises(harness.Voided):
            harness.check_clip(path, manifest)
    finally:
        os.unlink(path)


def _row(**kw):
    base = {"cell": "s0.08_d3", "changeSensitivity": 0.08, "minDwellFrames": 3,
            "candidatesInWindow": 7, "recall": 0.0, "recalled": 0, "events": 15,
            "fpRate": 1.0, "silentWindows": 12, "nonEventWindows": 13,
            "candidatesPerMinute": 0.33,
            "a1": False, "a2": False, "a3": True, "a4": True, "clears": False}
    base.update(kw)
    if "clears" not in kw:
        base["clears"] = base["a1"] and base["a2"] and base["a3"] and base["a4"]
    return base


def test_nothing_clears_means_park():
    rows = [_row(), _row(cell="s0.25_d4", a1=False, a2=False, a3=False, a4=True)]
    assert harness.pick_best(rows) is None


def test_a_cell_that_clears_all_four_is_chosen():
    passing = _row(cell="s0.10_d3", changeSensitivity=0.10, recall=0.87, recalled=13,
                   fpRate=0.06, silentWindows=13, candidatesPerMinute=1.10,
                   a1=True, a2=True, a3=True, a4=True)
    assert harness.pick_best([_row(), passing]) is passing


def test_a_cell_that_clears_a1_a2_a4_but_not_a3_is_not_chosen():
    near = _row(cell="s0.10_d4", recall=0.87, recalled=13, fpRate=0.06,
                silentWindows=10, a1=True, a2=True, a3=False, a4=True)
    assert harness.pick_best([near]) is None


def test_best_cell_prefers_recall_then_lowest_volume():
    hi_recall = _row(cell="s0.06_d2", changeSensitivity=0.06, recall=0.87, recalled=13,
                     fpRate=0.08, candidatesPerMinute=1.4,
                     a1=True, a2=True, a3=True, a4=True)
    tighter = _row(cell="s0.14_d3", changeSensitivity=0.14, recall=0.87, recalled=13,
                   fpRate=0.05, candidatesPerMinute=1.0,
                   a1=True, a2=True, a3=True, a4=True)
    lower_recall = _row(cell="s0.20_d2", changeSensitivity=0.20, recall=0.80, recalled=12,
                        fpRate=0.02, candidatesPerMinute=0.9,
                        a1=True, a2=True, a3=True, a4=True)
    assert harness.pick_best([lower_recall, hi_recall, tighter]) is tighter


def test_grid_table_prints_each_cells_own_verdict():
    text = harness.render_grid([_row(), _row(cell="s0.09_d2", a1=True, a2=False)])
    assert text.startswith(harness.GRID_HEADER)
    # one row per cell, and every failing clause is visible as FAIL
    assert text.count("\n| `s") == 2
    assert "FAIL" in text
    assert "0.00 (0/15)" in text


def test_cell_export_is_oracle_loadable_and_label_free():
    export = {
        "video": {"id": "onfoss-2023-09-23-stk-tournament", "path": "clip.mp4"},
        "producer": "hud-event/hud_reader (measure_hud_recall grid cell)",
        "fps": 1,
        "candidates": [{"t": 4432.0, "band": "race-clock", "kind": "clock", "score": 0.18}],
    }
    fd, path = tempfile.mkstemp(suffix=".json")
    import json
    with os.fdopen(fd, "w") as fh:
        json.dump(export, fh)
    try:
        loaded = oracle.load_export(path)
        assert loaded["candidates"][0]["t"] == 4432.0
    finally:
        os.unlink(path)


def test_cell_export_carrying_labels_is_refused():
    export = {"candidates": [{"t": 4432.0, "band": "race-clock",
                              "ground_truth": "objective_event"}]}
    fd, path = tempfile.mkstemp(suffix=".json")
    import json
    with os.fdopen(fd, "w") as fh:
        json.dump(export, fh)
    try:
        with pytest.raises(oracle.CandidateSchemaError):
            oracle.load_export(path)
    finally:
        os.unlink(path)


def test_bars_match_plan_section_5():
    assert harness.BAR_RECALL == 0.80
    assert harness.BAR_FP_RATE == 0.10
    assert harness.BAR_SILENT_WINDOWS == 11
    assert harness.BAR_CANDIDATES_PER_MIN == 1.5


def test_bands_are_native_pixels_from_the_manifest():
    """The measurement geometry must be the labels' own bands, not a normalized box."""
    manifest = oracle.load_manifest(MANIFEST)
    video = manifest["video"]
    assert (video["width"], video["height"]) == (426, 240)
    for name, rect, _kind in harness.STK_BANDS:
        x0, y0, x1, y1 = rect
        assert 0 <= x0 < x1 <= video["width"], name
        assert 0 <= y0 < y1 <= video["height"], name
    # the numbers the manifest states for the three bands it was read from
    assert ("race-clock", (364, 30, 426, 56), "clock") in harness.STK_BANDS
    assert ("centre-banner", (120, 60, 320, 110), "banner") in harness.STK_BANDS
    assert ("grand-prix-panel", (60, 50, 170, 180), "counter") in harness.STK_BANDS


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

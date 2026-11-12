#!/usr/bin/env python3
"""Tests for the WP4 additions to `evals/measure_hud_recall.py` (ADAAAA-8745).

Runs with plain stdlib (`python3 evals/test_hud_harness_latency.py`) and is also
pytest-discoverable. No clip, no ffmpeg, no GPU: the synthetic frames here are
**test fixtures**, never measurements — which is exactly what `--backend fixture`
refuses in the CLI, and why that refusal is executed below instead of described.

Pinned properties, each tied to an acceptance criterion:

- the fidelity table IS the audio harness' table (imported `print_table`), so the
  HUD and audio cells cannot drift apart — AC "columns/classes are identical";
- the fidelity window is the audio harness' `-3/+2 s` — AC "same matching windows";
- one candidate per transition, and the event->candidate CPU is the sum of the
  frames in the confirmed dwell run — AC A5's definition;
- the latency export is written in the shape `evals/metrics_runner.py
  --hud-latency` grades — AC "latency export present and readable";
- `--backend fixture` exits 4 and writes `numbers: null` — AC "no fixture number
  is admissible anywhere as a measurement";
- the harness arms its own profile copy; the shipped profile stays unarmed.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from contextlib import redirect_stdout

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import measure_hud_recall as m  # noqa: E402
import metrics_runner  # noqa: E402

AUDIO_LABELS = os.path.join(HERE, "supertuxkart_val", "audio-labels.json")
WINDOWS_LABELS = os.path.join(HERE, "supertuxkart_val", "label-manifest.json")


# ------------------------------------------------------------------ fixtures ---

def _band_frames(band, changed=(20, 40), baseline=20, step=235, n=60):
    """(n, h, w) uint8 stack where `band`'s rect steps in `changed`."""
    x0, y0, x1, y1 = band.rect
    stack = np.full((n, 240, 426), baseline, dtype=np.uint8)
    for i in range(*changed):
        stack[i, y0:y1, x0:x1] = step
    return stack


def _run(tmp_path, stage_a=True, sensitivity=0.10, dwell=3):
    reader_mod = m.load_reader_module()
    oracle = m.load_oracle_module()
    stage_a_mod = m.load_stage_a_module() if stage_a else None
    game_profile = sys.modules[f"{m.READER_PKG}.game_profile"]
    model = game_profile.HudModel(
        bands=tuple(game_profile.HudBand(name=n, rect=r, kind=k) for n, r, k in m.STK_BANDS),
        change_sensitivity=sensitivity, min_dwell_frames=dwell, quiet_frames=2, cell=8)
    frames = _band_frames(model.bands[1])
    manifest = oracle.load_manifest(WINDOWS_LABELS)
    row = m.run_cell(reader_mod, oracle, frames, 0, sensitivity, dwell, str(tmp_path),
                     manifest, WINDOWS_LABELS, float(frames.shape[0]),
                     stage_a=stage_a_mod)
    return row, model, manifest


# -------------------------------------------------------------------- parity ---

def test_fidelity_table_is_the_audio_harness_table():
    audio = m.load_audio_harness()
    onsets = [22.0]
    audio_row = {"id": "objective_event", "clip": "clip.mp4", "measured": True,
                 **audio.measure_fires([23.0], [1.0], ["stageA"], onsets, 3.0, 2.0)}
    buf = io.StringIO()
    with redirect_stdout(buf):
        audio.print_table([audio_row], None)
    audio_header = buf.getvalue().splitlines()[0]

    manifest = json.load(open(AUDIO_LABELS))
    rows = m.fidelity_rows(audio, [23.0], manifest, 3.0, 2.0, fps=1)
    fidelity = m.render_fidelity(audio, rows)
    assert fidelity.splitlines()[0] == audio_header, "HUD fidelity header drifted"
    assert len(fidelity.splitlines()[2].split("|")) == \
        len(buf.getvalue().splitlines()[2].split("|")), "column count drifted"
    assert rows[0]["id"] == "objective_event"


def test_fidelity_window_is_the_audio_default():
    audio = m.load_audio_harness()
    assert audio.resolve_match_windows(None, None, {}) == (3.0, 2.0)
    manifest = json.load(open(AUDIO_LABELS))
    inside = m.fidelity_rows(audio, [101.0], {"classes": [
        {"id": "objective_event", "clip": "clip.mp4", "onsets": [100.0]}]}, 3.0, 2.0, 1)
    outside = m.fidelity_rows(audio, [102.5], {"classes": [
        {"id": "objective_event", "clip": "clip.mp4", "onsets": [100.0]}]}, 3.0, 2.0, 1)
    assert inside[0]["recalled"] == 1
    assert outside[0]["recalled"] == 0
    assert inside[0]["p95"] == 1.0


def test_manifest_classes_supports_both_shapes():
    verbatim = m.manifest_classes(json.load(open(AUDIO_LABELS)))
    assert [c["id"] for c in verbatim] == ["objective_event"]
    derived = m.manifest_classes(json.load(open(WINDOWS_LABELS)))
    assert [c["id"] for c in derived] == ["race_start", "final_lap", "race_finish"]
    assert sum(len(c["onsets"]) for c in derived) == 15
    assert all(c["negatives"] for c in derived)


# ----------------------------------------------------------------- live path ---

def test_live_path_emits_one_candidate_and_times_the_dwell_run(tmp_path):
    row, model, _ = _run(tmp_path, stage_a=True)
    assert row["livePath"] is True
    assert row["frames"] == 60
    assert row["candidatesInWindow"] + row["outsideWindow"] == 1, \
        "the latch must emit exactly one candidate per transition"
    lat = row["latency"]
    assert lat["eventToCandidateCpuS"]["n"] == 1
    assert lat["eventToCandidateCpuS"]["p95"] > 0.0
    assert lat["eventToCandidateWallS"]["p95"] >= (model.min_dwell_frames - 1) / 1.0
    assert lat["cpuFrameS"]["n"] == 60
    assert row["eventToCandidateCpuP95S"] <= m.LATENCY_CPU_P95_BAR_S


def test_the_shipped_profile_is_not_armed():
    game_profile = sys.modules.get(f"{m.READER_PKG}.game_profile") or \
        m.load_reader_module() and sys.modules[f"{m.READER_PKG}.game_profile"]
    shipped = game_profile.load_game_profile("supertuxkart")
    model = game_profile.HudModel(
        bands=tuple(game_profile.HudBand(name=n, rect=r, kind=k) for n, r, k in m.STK_BANDS))
    armed = m.armed_profile(game_profile, model)
    assert shipped.allows(m.TRIGGER_HUD_EVENT) is False, \
        "arming hud-event on the shipped profile is a served default change, out of scope"
    assert armed.allows(m.TRIGGER_HUD_EVENT) is True
    assert armed.hud_model is model


# ------------------------------------------------------------ export / refuse ---

def test_latency_export_is_graded_by_metrics_runner(tmp_path):
    row, _, manifest = _run(tmp_path)
    doc = m.latency_export(row, manifest, "clip.mp4", "sha", (4380, 5731))
    assert doc["admissible"] is True and doc["backend"] == "live"
    assert doc["bars"]["stageAEventToCandidateCpuP95S"]["pass"] is True
    path = tmp_path / "hud_latency.json"
    path.write_text(json.dumps(doc))
    out = io.StringIO()
    with redirect_stdout(out):
        rc = metrics_runner._print_hud_latency(str(path))
    assert rc == 0
    assert "event->candidate CPU p95" in out.getvalue()


def test_metrics_runner_refuses_a_fixture_export(tmp_path):
    path = tmp_path / "fixture.json"
    path.write_text(json.dumps({"harness": "measure_hud_recall", "schemaVersion": 1,
                                "backend": "fixture", "admissible": False, "numbers": None}))
    out = io.StringIO()
    with redirect_stdout(out):
        rc = metrics_runner._print_hud_latency(str(path))
    assert rc == 1
    assert "INADMISSIBLE" in out.getvalue()


def test_fixture_backend_is_refused_before_any_decode(tmp_path):
    out_path = tmp_path / "out.json"
    err = io.StringIO()
    from contextlib import redirect_stderr
    with redirect_stderr(err):
        rc = m.main(["--clip", str(tmp_path / "missing.mp4"), "--backend", "fixture",
                     "--latency-export", str(out_path)])
    assert rc == m.INADMISSIBLE_EXIT
    assert "INADMISSIBLE" in err.getvalue()
    doc = json.loads(out_path.read_text())
    assert doc["admissible"] is False and doc["numbers"] is None


def test_metrics_runner_cli_grades_an_export_with_no_manifest(tmp_path):
    """The export must be readable on its own: a reviewer has the JSON, not the clip."""
    row, _, manifest = _run(tmp_path)
    doc = m.latency_export(row, manifest, "clip.mp4", "sha", (4380, 5731))
    path = tmp_path / "hud_latency.json"
    path.write_text(json.dumps(doc))
    proc = subprocess.run(
        [sys.executable, os.path.join(HERE, "metrics_runner.py"), "--hud-latency", str(path)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert "PASS" in proc.stdout and "event->candidate CPU p95" in proc.stdout
    # ... and the manifest-required branch still errors when a trace run is asked for.
    trace = tmp_path / "trace.json"
    trace.write_text(json.dumps({"events": []}))
    proc2 = subprocess.run(
        [sys.executable, os.path.join(HERE, "metrics_runner.py"), "--hud-latency", str(path),
         "--vod", str(trace), "--live", str(trace)],
        capture_output=True, text=True,
    )
    assert proc2.returncode != 0 and "manifest is required" in proc2.stderr


def test_a5_bar_and_trigger_id_are_pinned():
    assert m.LATENCY_CPU_P95_BAR_S == 0.5
    assert m.INADMISSIBLE_EXIT == 4
    assert m.TRIGGER_HUD_EVENT == "hud-event"


# ------------------------------------------- record integrity (reviewer caveats) ---

def test_the_cell_export_records_the_model_it_ran(tmp_path):
    """The artifact echoes the constructed `HudModel`, not this module's constants.

    `HudModel.max_latch_frames` has its own default (60) while the measured
    cells run 30, so a reader of the export cannot tell "the bound the cell
    ran" from "the model's default" unless the record comes from the model the
    reader was built with. A constant drifting away from the model must show up
    in the artifact instead of being echoed back.
    """
    m.load_reader_module()
    game_profile = sys.modules[f"{m.READER_PKG}.game_profile"]
    default_bound = game_profile.HudModel(
        bands=tuple(game_profile.HudBand(name=n, rect=r, kind=k) for n, r, k in m.STK_BANDS)
    ).max_latch_frames
    assert default_bound != 7, "the pin needs a bound that differs from the dataclass default"

    saved = (m.MAX_LATCH_FRAMES, m.REFERENCE_FRAMES)
    m.MAX_LATCH_FRAMES, m.REFERENCE_FRAMES = 7, 2
    try:
        row, model, _ = _run(tmp_path)
    finally:
        m.MAX_LATCH_FRAMES, m.REFERENCE_FRAMES = saved

    export = json.loads((tmp_path / f"cell_{row['cell']}.json").read_text())
    # The record follows the constructed model (the patched constants) and the
    # dataclass default is visibly not what ran — drift is detectable.
    assert export["cell"]["maxLatchFrames"] == 7 != default_bound
    assert export["cell"]["referenceFrames"] == 2
    assert export["cell"]["quietFrames"] == 2
    assert export["cell"]["bands"] == [
        {"name": n, "rect": list(r), "kind": k} for n, r, k in m.STK_BANDS]


def test_label_coverage_rate_divides_by_label_coverage_not_the_frame_window(tmp_path):
    """`candidatesPerMinuteLabelCoverage` is per label-coverage minute.

    The oracle is scored with the plan's frame window (60 s here), which is the
    A4 denominator; the label-coverage rate answers the other question and must
    not silently reuse the frame window (the reviewer's 4.26 vs 4.54 mix-up).
    """
    oracle = m.load_oracle_module()
    real_loader = m.load_oracle_module

    def _narrow_loader():
        mod = real_loader()
        setattr(mod, "labelled_window", lambda manifest: (10.0, 50.0))
        return mod

    assert oracle is not None
    m.load_oracle_module = _narrow_loader
    try:
        row, _, _ = _run(tmp_path)
    finally:
        m.load_oracle_module = real_loader

    assert row["candidatesInWindow"] == 1
    assert row["candidatesPerMinute"] == round(1 / (60.0 / 60.0), 3)
    assert row["candidatesPerMinuteLabelCoverage"] == round(1 / (40.0 / 60.0), 3)

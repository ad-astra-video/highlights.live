#!/usr/bin/env python3
"""Tests for the esports HUD corroboration oracle (evals/hud_oracle.py, ADAAAA-8743 / WP2).

Stdlib + pytest-or-plain-python. No clip, no ffmpeg, no numpy, no reader: every case is a
synthetic candidate export built *from the frozen manifest* with hits, misses and false
positives that are counted by hand below, so the oracle's printed numbers are asserted
exactly (counts by identity, rates by their formatted cell) rather than within a tolerance.

Run either way:

    python3 evals/test_hud_oracle.py        # prints a per-test PASS line, exit 0/1
    python3 -m pytest evals/test_hud_oracle.py -q

What is pinned here:

- AC1  exact recall / in-window FP / non-event-window numbers on a synthetic export;
- AC2  parity of the matching window, the table columns and the window precedence with
       `evals/measure_audio_recall.py`, so HUD and audio cells cannot drift apart;
- AC3  the oracle's import graph cannot reach `services/perceive/app/hud_reader.py` (or the
       label builder) — asserted statically on the import statements *and* at runtime on
       `sys.modules`, plus a reader-side guard that activates once WP1's file exists;
- AC4  per-rule precision lift is reported on its own row, with two rules showing two
       different numbers;
- AC5  a candidate export carrying label fields is refused;
- AC6  the manifest sha256 is re-checked before AND after scoring and a changed manifest
       voids the run (no numbers at all).
"""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import hud_oracle as oracle  # noqa: E402

MANIFEST = os.path.join(HERE, "supertuxkart_val", "label-manifest.json")
ORACLE_PATH = os.path.join(HERE, "hud_oracle.py")
AUDIO_HARNESS = os.path.join(HERE, "measure_audio_recall.py")
HUD_READER = os.path.join(ROOT, "services", "perceive", "app", "hud_reader.py")
LABEL_BUILDER = os.path.join(HERE, "supertuxkart_val", "build_stk_labels.py")

# Events this export deliberately misses: one per class, so every class row is 4/5 = 0.80.
MISSES = {"A-start", "C-final-lap", "E-finish"}

# The independent channels attached to the candidates below. Counted in the docstring of
# `build_synthetic_export`; the per-rule assertions read these numbers back out of the table.
MOTION_HITS = ("A-final-lap", "A-finish", "B-start", "B-final-lap", "B-finish", "C-start",
               "C-finish", "D-start")
AUDIO_HITS = ("A-final-lap", "A-finish", "B-start", "D-final-lap", "D-finish")
BAND_HITS = ("B-final-lap", "E-start", "E-final-lap")


def build_synthetic_export(manifest: dict) -> dict:
    """A candidate export with hand-counted hits, misses and false positives.

    12 of the 15 objective events get one candidate at `instant + 0.4 s` (inside the -3/+2 s
    window, so recall is 4/5 in each of the three classes = 0.80). Four false positives:

    - t=4700  motion 0.70 only           -> agreed by `motion`
    - t=5000  no corroboration           -> agreed by no rule
    - t=4465  second band `laps`         -> inside non-event window N01
    - t=5145  audio 0.66 + band `laps`   -> inside non-event window N07

    So: candidates 16, recall 12/15 = 0.80, in-window FP 4, FP rate 4/16 = 0.25, 2 of 13
    non-event windows fire. Per corroboration rule: motion keeps 9 (8 TP), audio keeps 6
    (5 TP), second-band keeps 5 (3 TP), any-of-rules keeps 15 (12 TP).
    """
    events = oracle.labelled_events(manifest)
    candidates = []
    for event in events:
        if event["id"] in MISSES:
            continue
        cand = {"t": round(event["instant"] + 0.4, 3), "band": "centre-banner",
                "score": 0.81}
        corr = {}
        if event["id"] in MOTION_HITS:
            corr["motion"] = 0.62
        if event["id"] in AUDIO_HITS:
            corr["audio"] = 0.71
        if event["id"] in BAND_HITS:
            corr["bands"] = [{"band": "laps", "t": round(event["instant"] + 0.5, 3)}]
        if corr:
            cand["corroboration"] = corr
        candidates.append(cand)

    candidates.append({"t": 4700.0, "band": "race-clock",
                       "corroboration": {"motion": 0.70}})
    candidates.append({"t": 5000.0, "band": "race-clock"})
    candidates.append({"t": 4465.0, "band": "centre-banner",
                       "corroboration": {"bands": [{"band": "laps", "t": 4465.0}]}})
    candidates.append({"t": 5145.0, "band": "centre-banner",
                       "corroboration": {"audio": 0.66, "bands": [{"band": "laps",
                                                                   "t": 5145.2}]}})
    return {"video": {"id": manifest["video"]["id"], "path": manifest["video"]["path"]},
            "producer": "hud-event/hud_reader (synthetic fixture)",
            "fps": 1,
            "candidates": candidates}


def _write(tmpdir: str, name: str, payload) -> str:
    path = os.path.join(tmpdir, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    return path


def _run_synthetic(tmpdir: str):
    manifest = json.load(open(MANIFEST, encoding="utf-8"))
    export_path = _write(tmpdir, "candidates.json", build_synthetic_export(manifest))
    return oracle.run(MANIFEST, export_path)


# --- AC1: exact numbers on the synthetic export --------------------------------------------

def test_ac1_class_rows_are_exact(tmpdir=None):
    with tempfile.TemporaryDirectory() as tmp:
        result = _run_synthetic(tmp)
    rows = {r["id"]: r for r in result["classes"]}
    assert list(rows) == list(oracle.EVENT_CLASSES)
    for cls, row in rows.items():
        assert row["events"] == 5, cls
        assert row["candidates"] == 16, cls
        assert row["recalled"] == 4, cls
        assert row["recall"] == 4 / 5, cls
        assert row["fp"] == 4, cls
        assert row["fp_rate"] == 4 / 16, cls
        assert row["lags"] == [0.4, 0.4, 0.4, 0.4], cls
        assert row["p50"] == 0.4 and row["p95"] == 0.4, cls
        assert row["sr"] == 1, cls
        assert row["clip"] == "sh_onfoss_20230923_tournament.mp4", cls


def test_ac1_overall_numbers_are_exact():
    with tempfile.TemporaryDirectory() as tmp:
        result = _run_synthetic(tmp)
    o = result["overall"]
    assert o["candidates"] == 16 and o["candidates_in_window"] == 16
    assert o["outside_labelled_window"] == 0
    assert o["events"] == 15
    assert o["recalled"] == 12
    assert o["recall"] == 12 / 15
    assert o["fp"] == 4
    assert o["fp_rate"] == 4 / 16


def test_ac1_non_event_windows_are_exact():
    with tempfile.TemporaryDirectory() as tmp:
        result = _run_synthetic(tmp)
    neg = result["negatives"]
    assert neg["windows"] == 13
    assert neg["fp_windows"] == 2
    assert neg["fp_window_rate"] == 2 / 13
    assert neg["candidates"] == 2
    assert neg["silent_windows"] == 11
    firing = {w["id"]: w["fires"] for w in neg["per_window"] if w["fires"]}
    assert firing == {"N01": [4465.0], "N07": [5145.0]}


def test_ac1_printed_table_carries_those_exact_numbers():
    """The *printed* cells, not just the dict: a formatting change cannot hide a number."""
    with tempfile.TemporaryDirectory() as tmp:
        result = _run_synthetic(tmp)
    text = oracle.render(result)
    for cls in oracle.EVENT_CLASSES:
        assert (f"| {cls} | `sh_onfoss_20230923_tournament.mp4` | 1 | 5 | 16 | "
                f"0.80 (4/5) | 4 | 0.25 | 0.40 s | 0.40 s |") in text, cls
    assert "| _non_event windows_ | 13 windows | 1 | — | 2 fires | — | 2 | 0.15 | — | — |" \
        in text
    assert ("overall: candidates=16 in-window=16 outside=0 events=15 recalled=12 "
            "recall=0.80 fp=4 fp_rate=0.25 candidates/min=0.76 silent_windows=11/13") in text
    assert "| N01 | 4460 | 4484 | 1 | 24 |" in text
    assert "| N07 | 5140 | 5164 | 1 | 24 |" in text
    assert "| N02 | 4500 | 4524 | 0 | 24 |" in text


# --- AC2: parity with the audio harness ----------------------------------------------------

def _audio_source_header_and_windows():
    tree = ast.parse(open(AUDIO_HARNESS, encoding="utf-8").read())
    constants = {}
    header = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name) and isinstance(node.value, ast.Constant):
                constants[target.id] = node.value.value
        if isinstance(node, ast.FunctionDef) and node.name == "print_table":
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name) \
                        and sub.func.id == "print" and sub.args:
                    arg = sub.args[0]
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str) \
                            and arg.value.startswith("| class |"):
                        header = arg.value
    return header, constants


def test_ac2_table_columns_are_byte_identical_to_the_audio_harness():
    header, _ = _audio_source_header_and_windows()
    assert header == oracle.TABLE_HEADER
    assert oracle.TABLE_SEP.count("---") == header.count(" |")
    assert oracle.TABLE_SEP == "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"


def test_ac2_matching_window_matches_the_audio_harness():
    _, constants = _audio_source_header_and_windows()
    assert constants["DEFAULT_MATCH_PRE_S"] == oracle.DEFAULT_MATCH_PRE_S == 3.0
    assert constants["DEFAULT_MATCH_POST_S"] == oracle.DEFAULT_MATCH_POST_S == 2.0


def test_ac2_window_precedence_flag_then_manifest_then_default():
    # Same precedence as measure_audio_recall.resolve_match_windows (ADAAAA-7772).
    assert oracle.resolve_match_windows(None, None, {}) == (3.0, 2.0)
    assert oracle.resolve_match_windows(None, None, {"matchPre": 5.0, "matchPost": 4.0}) \
        == (5.0, 4.0)
    assert oracle.resolve_match_windows(10.0, 6.0, {"matchPre": 5.0, "matchPost": 4.0}) \
        == (10.0, 6.0)
    assert oracle.resolve_match_windows(10.0, None, {"matchPre": 5.0, "matchPost": 4.0}) \
        == (10.0, 4.0)


# --- AC3: independence guard --------------------------------------------------------------

STDLIB_ONLY = {"__future__", "argparse", "hashlib", "json", "os", "sys"}


def _imported_modules(path: str) -> set:
    tree = ast.parse(open(path, encoding="utf-8").read())
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                names.add(f"<relative:{node.module}>")
            else:
                names.add((node.module or "").split(".")[0])
    return names


def test_ac3_oracle_imports_only_stdlib_so_the_graph_cannot_reach_the_reader():
    """If every import of hud_oracle.py is stdlib, no repo module is reachable at all."""
    names = _imported_modules(ORACLE_PATH)
    assert names <= STDLIB_ONLY, f"non-stdlib import(s): {sorted(names - STDLIB_ONLY)}"
    assert names <= set(sys.stdlib_module_names)
    assert not any("<relative" in n for n in names)


def test_ac3_runtime_module_graph_holds_no_reader_or_label_builder():
    assert "hud_reader" not in sys.modules
    assert "build_stk_labels" not in sys.modules
    forbidden = {os.path.abspath(HUD_READER), os.path.abspath(LABEL_BUILDER)}
    leaked = []
    for name, mod in list(sys.modules.items()):
        path = getattr(mod, "__file__", None)
        if isinstance(path, str) and os.path.abspath(path) in forbidden:
            leaked.append(name)
    assert leaked == []


def test_ac3_oracle_takes_only_a_manifest_path_and_a_candidate_path():
    """The signature is the audit: no reader handle, no reader module, no callable injection."""
    import inspect
    params = list(inspect.signature(oracle.run).parameters)
    assert params == ["manifest_path", "candidates_path", "match_pre", "match_post", "cfg",
                      "labelled_window_s", "rule"]
    # Nothing importable is named after the reader or the label builder.
    assert not [n for n in dir(oracle) if "reader" in n.lower() or "label_builder" in n.lower()]
    # The only paths `run` opens are the manifest and the candidate export.
    body = inspect.getsource(oracle.run)
    assert "open(" not in body


def _local_import_closure(entry: str, depth: int = 0, seen=None) -> set:
    seen = seen if seen is not None else set()
    if entry in seen or depth > 8 or not os.path.exists(entry):
        return seen
    seen.add(os.path.abspath(entry))
    app_dir = os.path.dirname(os.path.abspath(entry))
    for name in _imported_modules(entry):
        for candidate in (os.path.join(app_dir, f"{name}.py"),
                          os.path.join(HERE, f"{name}.py"),
                          os.path.join(app_dir, "..", "..", "..", f"{name}.py")):
            candidate = os.path.normpath(candidate)
            if os.path.exists(candidate):
                _local_import_closure(candidate, depth + 1, seen)
    return seen


def test_ac3_reader_side_guard_when_wp1_reader_exists():
    """Skips until WP1 lands mixed services/perceive/app/hud_reader.py (its own guard covers it)."""
    if not os.path.exists(HUD_READER):
        print("  (skipped: services/perceive/app/hud_reader.py not present yet)")
        return
    closure = _local_import_closure(HUD_READER)
    assert os.path.abspath(LABEL_BUILDER) not in closure, \
        f"the reader's import graph reaches the label builder: {sorted(closure)}"
    assert os.path.abspath(ORACLE_PATH) not in closure


# --- AC4: per-rule precision lift, reported separately ------------------------------------

def test_ac4_each_rule_reports_its_own_number():
    with tempfile.TemporaryDirectory() as tmp:
        result = _run_synthetic(tmp)
    rows = {r["rule"]: r for r in result["corroboration"]}
    assert list(rows) == ["motion", "audio", "second-band", "any-of-rules"]
    motion, audio, band, union = (rows["motion"], rows["audio"], rows["second-band"],
                                  rows["any-of-rules"])
    assert (motion["candidates_kept"], motion["kept_tp"]) == (9, 8)
    assert (audio["candidates_kept"], audio["kept_tp"]) == (6, 5)
    assert (band["candidates_kept"], band["kept_tp"]) == (5, 3)
    assert (union["candidates_kept"], union["kept_tp"]) == (15, 12)
    # Base precision over every candidate in the export.
    assert motion["base_precision"] == audio["base_precision"] == 12 / 16
    # Two rules, two different lifts — an aggregate single number is exactly what this forbids.
    assert motion["precision_lift"] > 0 and band["precision_lift"] < 0
    assert round(motion["precision_lift"], 4) != round(audio["precision_lift"], 4)
    assert [r["events_kept"] for r in (motion, audio, band, union)] == [8, 5, 3, 12]


def test_ac4_printed_rule_rows_are_exact():
    with tempfile.TemporaryDirectory() as tmp:
        result = _run_synthetic(tmp)
    text = oracle.render(result)
    assert "| motion | 9 | 8 | 0.89 | 0.75 | +0.14 | 0.53 (8/15) | -0.27 |" in text
    assert "| audio | 6 | 5 | 0.83 | 0.75 | +0.08 | 0.33 (5/15) | -0.47 |" in text
    assert "| second-band | 5 | 3 | 0.60 | 0.75 | -0.15 | 0.20 (3/15) | -0.60 |" in text
    assert "| any-of-rules | 15 | 12 | 0.80 | 0.75 | +0.05 | 0.80 (12/15) | +0.00 |" in text
    assert oracle.CORROBORATION_HEADER in text


def test_ac4_rule_filter_changes_the_scored_set():
    with tempfile.TemporaryDirectory() as tmp:
        manifest = json.load(open(MANIFEST, encoding="utf-8"))
        export_path = _write(tmp, "candidates.json", build_synthetic_export(manifest))
        filtered = oracle.run(MANIFEST, export_path, rule="motion")
    assert filtered["rule_applied"] == "motion"
    assert filtered["overall"]["candidates"] == 9
    assert filtered["overall"]["recalled"] == 8
    assert filtered["overall"]["fp"] == 1
    assert "corroboration rule applied before scoring: `motion`" in oracle.render(filtered)


def test_ac4_second_band_requires_a_band_other_than_the_candidates_own():
    cand = {"t": 100.0, "band": "centre-banner",
            "corroboration": {"bands": [{"band": "centre-banner", "t": 100.1}]}}
    assert oracle.rule_agrees("second-band", cand) is False
    cand["corroboration"]["bands"].append({"band": "laps", "t": 100.2})
    assert oracle.rule_agrees("second-band", cand) is True
    # A second band too far away in time is not agreement.
    far = {"t": 100.0, "band": "centre-banner",
           "corroboration": {"bands": [{"band": "laps", "t": 130.0}]}}
    assert oracle.rule_agrees("second-band", far) is False


# --- AC5: no label fields in a candidate export -------------------------------------------

def test_ac5_candidate_carrying_a_label_field_is_refused():
    with tempfile.TemporaryDirectory() as tmp:
        for field in ("ground_truth", "event_type", "instant", "bracket"):
            path = _write(tmp, f"bad-{field}.json",
                          {"candidates": [{"t": 4429.9, field: "objective_event"}]})
            try:
                oracle.load_export(path)
            except oracle.CandidateSchemaError as exc:
                assert field in str(exc)
            else:
                raise AssertionError(f"candidate with `{field}` was accepted")


def test_ac5_export_carrying_labels_at_top_level_is_refused():
    with tempfile.TemporaryDirectory() as tmp:
        path = _write(tmp, "bad-top.json",
                      {"candidates": [{"t": 4429.9}], "windows": [{"ground_truth": "x"}],
                       "labels": ["A-start"]})
        try:
            oracle.load_export(path)
        except oracle.CandidateSchemaError as exc:
            assert "labels" in str(exc)
        else:
            raise AssertionError("top-level label field was accepted")


def test_ac5_synthetic_export_keys_carry_no_label_fields():
    manifest = json.load(open(MANIFEST, encoding="utf-8"))
    export = build_synthetic_export(manifest)
    assert not (set(oracle.LABEL_FIELDS) & set(export))
    for cand in export["candidates"]:
        assert not (set(oracle.LABEL_FIELDS) & set(cand))
    # And the schema the oracle reads is exactly `t` + reader-side evidence fields.
    for cand in export["candidates"]:
        assert "t" in cand
        assert set(cand) <= {"t", "band", "channel", "score", "corroboration", "motion",
                             "audio", "bands"}


# --- AC6: the manifest pin, before and after ----------------------------------------------

def test_ac6_changed_manifest_hash_voids_the_run():
    with tempfile.TemporaryDirectory() as tmp:
        tampered = json.load(open(MANIFEST, encoding="utf-8"))
        # The smallest possible edit: one label instant moves a tenth of a second.
        tampered["windows"][0]["instant"] = float(tampered["windows"][0]["instant"]) + 0.1
        bad_manifest = _write(tmp, "tampered-manifest.json", tampered)
        manifest = json.load(open(MANIFEST, encoding="utf-8"))
        good_export = _write(tmp, "candidates.json", build_synthetic_export(manifest))
        try:
            oracle.run(bad_manifest, good_export)
        except oracle.ManifestVoided as exc:
            assert "VOIDED" in str(exc)
        else:
            raise AssertionError("a tampered manifest produced numbers instead of voiding")


def test_ac6_cli_prints_voided_and_no_table():
    with tempfile.TemporaryDirectory() as tmp:
        tampered = json.load(open(MANIFEST, encoding="utf-8"))
        tampered["known_gaps"] = tampered["known_gaps"][:-1]   # any byte change voids it
        bad_manifest = _write(tmp, "tampered-manifest.json", tampered)
        manifest = json.load(open(MANIFEST, encoding="utf-8"))
        good_export = _write(tmp, "candidates.json", build_synthetic_export(manifest))
        proc = subprocess.run(
            [sys.executable, ORACLE_PATH, "--candidates", good_export,
             "--manifest", bad_manifest],
            capture_output=True, text=True)
    assert proc.returncode == 3, proc.stdout + proc.stderr
    assert "VOIDED" in proc.stderr
    assert oracle.TABLE_HEADER not in proc.stdout
    assert "recall=" not in proc.stdout


def test_ac6_valid_run_reports_the_same_pin_before_and_after():
    with tempfile.TemporaryDirectory() as tmp:
        result = _run_synthetic(tmp)
    assert result["sha_before"] == result["sha_after"] == oracle.MANIFEST_SHA256
    text = oracle.render(result)
    assert f"manifest sha256 (pinned `{oracle.MANIFEST_SHA256}`): before " \
           f"`{oracle.MANIFEST_SHA256}`" in text
    assert f"manifest sha256 after scoring: `{oracle.MANIFEST_SHA256}` — unchanged" in text


def test_ac6_committed_manifest_is_the_pinned_artifact():
    assert oracle.sha256_file(MANIFEST) == oracle.MANIFEST_SHA256
    assert oracle.default_manifest_path() == MANIFEST


# --- CLI end to end -------------------------------------------------------------------------

def test_cli_scores_the_synthetic_export_and_writes_json():
    with tempfile.TemporaryDirectory() as tmp:
        manifest = json.load(open(MANIFEST, encoding="utf-8"))
        export_path = _write(tmp, "candidates.json", build_synthetic_export(manifest))
        out_json = os.path.join(tmp, "result.json")
        proc = subprocess.run(
            [sys.executable, ORACLE_PATH, "--candidates", export_path, "--json", out_json],
            capture_output=True, text=True)
        assert proc.returncode == 0, proc.stderr
        assert oracle.TABLE_HEADER in proc.stdout
        assert "0.80 (4/5)" in proc.stdout
        payload = json.load(open(out_json, encoding="utf-8"))
    assert payload["overall"]["recall"] == 12 / 15
    assert payload["negatives"]["fp_windows"] == 2
    assert [r["rule"] for r in payload["corroboration"]][0] == "motion"


def test_cli_refuses_a_bad_candidate_export():
    with tempfile.TemporaryDirectory() as tmp:
        path = _write(tmp, "bad.json", {"candidates": [{"band": "x"}]})
        proc = subprocess.run([sys.executable, ORACLE_PATH, "--candidates", path],
                              capture_output=True, text=True)
    assert proc.returncode == 2
    assert "REFUSED" in proc.stderr


def test_labelled_window_override_changes_only_the_volume_denominator():
    with tempfile.TemporaryDirectory() as tmp:
        manifest = json.load(open(MANIFEST, encoding="utf-8"))
        export_path = _write(tmp, "candidates.json", build_synthetic_export(manifest))
        default = oracle.run(MANIFEST, export_path)
        comparable = oracle.run(MANIFEST, export_path, labelled_window_s=1351.0)
    assert default["overall"]["candidates_per_minute"] == 16 / ((5699 - 4429.67) / 60.0)
    assert comparable["overall"]["candidates_per_minute"] == 16 / (1351.0 / 60.0)
    assert default["labelled_window_s"] == 1269.33
    assert comparable["labelled_window_s"] == 1351.0
    assert default["overall"]["recall"] == comparable["overall"]["recall"]


if __name__ == "__main__":
    failures = 0
    tests = [(name, fn) for name, fn in sorted(globals().items())
             if name.startswith("test_") and callable(fn)]
    for name, fn in tests:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - a runner, not a test framework
            failures += 1
            print(f"FAIL {name}: {type(exc).__name__}: {exc}")
        else:
            print(f"PASS {name}")
    print(f"\n{len(tests) - failures}/{len(tests)} tests passed")
    sys.exit(1 if failures else 0)

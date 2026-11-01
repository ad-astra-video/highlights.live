"""Self-check for the native-resolution readers (ADAAAA-7611).

Runner-level tests only: no ffmpeg, no video, no network. They pin the parts of
`native_shot_motion.py` / `native_scoreboard_timeline.py` that a future edit
could silently break — the block statistic, the cut rule, the per-second sweep
accounting and the recorded verdicts — so the negative results in `RESULTS.md`
stay reproducible from the committed numbers rather than from prose.

Why guard negatives at all: both modules exist to answer "does this layer carry
signal". If an edit flips `shot_at`'s cut rule or the sweep's window counting,
the next run would report a different AUC for the same evidence and the recorded
finding would stop meaning anything.
"""
import importlib
import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

nsm = importlib.import_module("native_shot_motion")
nst = importlib.import_module("native_scoreboard_timeline")


def test_block_score_finds_the_hot_block():
    resid = np.zeros((90, 160), dtype=np.float32)
    resid[24:32, 40:48] = 40.0          # one moving object in one 8x8 block
    score, hot, very = nsm.block_score(resid)
    assert 39.0 <= score <= 41.0
    assert hot >= 1 and very >= 1


def test_block_score_masks_the_scoreboard_strip():
    # a change confined to the top-left overlay strip is not pitch motion
    resid = np.zeros((90, 160), dtype=np.float32)
    resid[0:8, 0:8] = 255.0
    score, hot, _ = nsm.block_score(resid)
    assert score == 0.0 and hot == 0


def test_shot_at_requires_score_and_no_cut():
    assert nsm.shot_at({"score": 90.0, "cut": False}, 55.0) is True
    assert nsm.shot_at({"score": 90.0, "cut": True}, 55.0) is False
    assert nsm.shot_at({"score": 10.0, "cut": False}, 55.0) is False
    assert nsm.shot_at({}, 55.0) is False


def test_sweep_counts_windows_and_control_seconds():
    reads = [
        {"t": 10, "score": 99.0, "cut": False},
        {"t": 11, "score": 10.0, "cut": False},
        {"t": 20, "score": 99.0, "cut": False},
        {"t": 21, "score": 99.0, "cut": True},
    ]
    shot = [{"id": "s1", "t_start": 10, "t_end": 11}]
    control = [{"id": "c1", "t_start": 20, "t_end": 21}]
    rows = nsm.sweep(reads, shot, control)
    row = [r for r in rows if r["threshold"] == 55.0][0]
    assert row["shot_windows_reproduced"] == 1
    assert row["reproduced_ids"] == ["s1"]
    # t=21 is a cut, so only t=20 counts as a false shot second
    assert row["control_seconds_false"] == 1
    assert row["false_ids"] == [{"id": "c1", "t": 20}]


def test_scoreboard_counters_match_the_committed_run():
    """The recorded native-resolution run must keep its shape."""
    path = HERE / "results" / "native_scoreboard_timeline.json"
    d = json.loads(path.read_text())
    c = d["counts"]
    assert d["layer"]["source"].startswith("1280x720")
    assert c["seconds"] >= 777
    assert c["present_seconds"] > 400
    # the finding: "no-cut mask change" fires ~17x per real goal, so the layer
    # cannot be used as a goal labeller at source resolution either
    goals = sum(1 for w in json.loads((HERE / "label-manifest.json").read_text())["windows"]
                if w["ground_truth"] == "goal")
    assert c["score_changes"] > 10 * goals
    assert len(d["score_changes"]) == c["score_changes"]


def test_native_motion_summary_records_no_signal():
    path = HERE / "results" / "native_shot_motion_summary.json"
    d = json.loads(path.read_text())
    assert d["layer"]["source"] == "1280x720 60/1 fps, sampled at 12 fps, scale=native"
    assert d["windows"]["shot"] == 10 and d["windows"]["control"] == 12
    assert d["discrimination"]["score_auc"] < 0.5     # worse than chance
    assert d["gate"]["met"] is False
    assert d["gate"]["thresholds_meeting_it"] == []

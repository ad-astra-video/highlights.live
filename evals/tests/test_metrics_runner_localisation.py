"""Tests for the ADAAAA-8122 additions to `evals/metrics_runner.py`:
scoring a windows-shaped frame-verified manifest, and the goal FP +
localisation rows the decide-model comparison is graded on.

Pure stdlib — no ffmpeg, no GPU, no network.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import metrics_runner  # noqa: E402

WINDOWS = {
    "video": {"id": "kids-soccer", "path": "/data/clips/kids-soccer.mp4"},
    "windows": [
        {"id": "ks-g-0100", "t_start": 95, "t_end": 105, "instant": 100,
         "ground_truth": "goal", "evidence": "ball_in_net"},
        {"id": "ks-g-0200", "t_start": 196, "t_end": 206, "instant": 200,
         "ground_truth": "goal", "evidence": "ball_in_net"},
        {"id": "ks-n-0150", "t_start": 147, "t_end": 157, "ground_truth": "none"},
        {"id": "ks-n-0250", "t_start": 247, "t_end": 257, "ground_truth": "none"},
    ],
}


def _manifest(tmp_path):
    p = tmp_path / "label-manifest.json"
    p.write_text(json.dumps(WINDOWS))
    return str(p)


def _trace(accepted):
    """accepted: {clipId: [(t, verdict)]} -> trace events."""
    events = []
    for cid, rows in accepted.items():
        cand = min(t for t, _ in rows)
        events.append({"type": "candidate", "clipId": cid,
                       "eventType": "SPORTING_EVENT", "timestamp": cand,
                       "source": "observe-cadence"})
        for t, ok in rows:
            events.append({"type": "decision", "clipId": cid, "timestamp": t,
                           "eventTime": t,
                           "decision": {"isHighlight": ok, "score": 80.0,
                                        "reason": "crowd erupts"}})
    n = sum(len(v) for v in accepted.values())
    rejected = sum(1 for v in accepted.values() for _, ok in v if not ok)
    return {"events": events,
            "stageA": {"totalCandidates": n, "rejected": rejected,
                       "mode": "observe-cadence"},
            "tracking": {}}


def test_windows_manifest_expands_to_units(tmp_path):
    clips, accept, sport = metrics_runner.load_manifest(_manifest(tmp_path))
    assert len(clips) == 4
    assert sum(1 for c in clips if c["groundTruth"]["isHighlight"]) == 2
    assert clips[0]["groundTruth"]["instant"] == 100.0
    assert clips[0]["groundTruth"]["eventWindow"] == [95.0, 105.0]
    assert accept["precisionPct"] == 70 and accept["localisationToleranceS"] == 5.0
    assert sport == "soccer"


def test_localisation_and_goal_fp_are_measured(tmp_path):
    clips, accept, _ = metrics_runner.load_manifest(_manifest(tmp_path))
    # goal 1 accepted at its instant, goal 2 accepted 4 s late, one negative
    # window wrongly accepted -> 1 goal FP, localisation |dt| median 2.0
    trace = _trace({
        "ks-g-0100": [(100.0, True)],
        "ks-g-0200": [(204.0, True)],
        "ks-n-0150": [(150.0, False)],
        "ks-n-0250": [(250.0, True)],   # false positive
    })
    m, _ = metrics_runner.compute(clips, trace["events"], trace["stageA"], {},
                                  accept)
    assert m["positivesN"] == 2 and m["negativesN"] == 2
    assert m["recallHits"] == 2
    assert m["goalFpUnits"] == 1 and m["goalFpRate"] == 0.5
    loc = m["localisation"]
    assert loc["n"] == 2
    assert loc["medianAbsS"] == 2.0 and loc["medianS"] == 2.0
    assert loc["withinTolerance"] == 1.0        # both inside the 5 s tolerance
    assert loc["missed"] == 0
    assert m["precision"] == pytest.approx(2 / 3)


def test_localisation_counts_a_missed_goal_and_flags_wild_offsets(tmp_path):
    clips, accept, _ = metrics_runner.load_manifest(_manifest(tmp_path))
    trace = _trace({"ks-g-0100": [(108.0, True)]})   # 8 s late, goal 2 missed
    m, _ = metrics_runner.compute(clips, trace["events"], trace["stageA"], {},
                                  accept, localisation_tolerance_s=5.0)
    assert m["recallHits"] == 1
    loc = m["localisation"]
    assert loc["n"] == 1 and loc["medianAbsS"] == 8.0
    assert loc["withinTolerance"] == 0.0
    assert loc["missed"] == 1
    assert m["goalFpUnits"] == 0


def test_clip_manifest_has_no_localisation_ground_truth(tmp_path):
    m = {"sport": "soccer", "acceptance": {"recallVodPct": 90}, "clips": [
        {"id": "soc-goal-01", "mode": "vod",
         "groundTruth": {"isHighlight": True, "eventType": "GOAL"}}]}
    p = tmp_path / "clips.json"
    p.write_text(json.dumps(m))
    clips, accept, _ = metrics_runner.load_manifest(str(p))
    trace = _trace({"soc-goal-01": [(1.0, True)]})
    got, _ = metrics_runner.compute(clips, trace["events"], trace["stageA"], {}, accept)
    assert got["recallHits"] == 1
    assert got["localisation"]["n"] == 0          # nothing labelled to compare to
    assert got["localisation"]["medianAbsS"] is None


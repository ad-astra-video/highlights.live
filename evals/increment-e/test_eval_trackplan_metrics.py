"""Increment E (ADAAAA-6468) — accounting self-test for the §8 metrics scorer.

Validates eval_trackplan_metrics.score_trace on the synthetic trace (no GPU)
so the accounting is proven correct before it is trusted on a real pipeline
trace. This is a RUNNER test, not pipeline evidence (mirrors the existing
evals/metrics_runner synthetic-pass pattern).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from eval_trackplan_metrics import score_trace, _hold  # noqa: E402


def _load():
    with open(os.path.join(HERE, "fixtures", "synthetic-trace.json")) as f:
        return json.load(f)


def test_synthetic_scoring():
    trace = _load()
    m = score_trace(trace, "live")

    # p95 latency: sorted [1.9, 2.4, 3.1] -> idx 2 -> 3.1
    assert abs(m["latency_live_p95"] - 3.1) < 1e-9
    # re-plan p95 among plan latencies -> 0.61
    assert abs(m["replan_discovery_p95"] - 0.61) < 1e-9
    # target precision 19/20 = 0.95
    assert abs(m["target_precision"] - 0.95) < 1e-9
    # detection alignment: no off-plan tracked
    assert m["detection_alignment"] == 0
    # discovery usefulness 5/14
    assert abs(m["discovery_usefulness"] - (5 / 14)) < 1e-9
    # category coverage: all 8 categories present with >0 targets
    assert m["category_coverage"] == 8
    # frame caps live/vod: 0 violations
    assert m["frame_cap_live"] == 0
    assert m["frame_cap_vod"] == 0
    # near-miss recall 2/3 = 0.667 -> FAIL; precision 2/2 = 1.0 -> PASS
    assert abs(m["near_miss_recall"] - (2 / 3)) < 1e-9
    assert _hold("near_miss_recall", m["near_miss_recall"]) is False
    assert abs(m["near_miss_precision"] - 1.0) < 1e-9
    # near-miss/scoring confusion = 1 -> FAIL
    assert m["near_miss_vs_scoring_confusion"] == 1
    assert _hold("near_miss_vs_scoring_confusion", 1) is False
    # audio-misled/crowd-alone = 0
    assert m["audio_misled"] == 0
    assert m["audio_evidence_use"] == 0
    # tracking accuracy 9/10
    assert abs(m["tracking_accuracy"] - 0.90) < 1e-9
    # vod depth 52/40 = 1.3
    assert abs(m["vod_depth"] - 1.30) < 1e-9
    # warm-up max 2.1 (<=3 PASS), re-check max 7.0 (<=10 PASS)
    assert abs(m["warmup_time"] - 2.1) < 1e-9
    assert _hold("warmup_time", 2.1) is True
    assert abs(m["recheck_interval"] - 7.0) < 1e-9
    assert _hold("recheck_interval", 7.0) is True
    # per-frame planner calls = 0
    assert m["per_frame_planner_calls"] == 0
    # cost bound: plan events not per-frame = 8
    assert m["cost_bound"] == 8


def test_missing_counters_report_not_captured():
    # Empty trace -> every metric not_captured (None), no crash.
    m = score_trace({"events": []}, "live")
    assert m["latency_live_p95"] is None
    assert m["target_precision"] is None
    for meta_val in m.values():
        pass  # just ensure no exception


def test_unknown_metric_hold_is_none():
    assert _hold("does_not_exist", 1.0) is None

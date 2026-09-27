"""Tests for the ADAAAA-4959 paired VOD-vs-live depth scoring in
evals/metrics_runner.py (A4 out-depth, spec ADAAAA-4940 §3).

Validates: (a) D_detail is driven by the honest detail signals a finding
carries (frames judged, evidence cited, reason length, event-window IoU) and
(b) the paired out-depth gate (mean D_vod > D_live by >=10% relative) separates
a deeper VOD pass from a shallow live pass. Pure stdlib — no ffmpeg/GPU needed.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import metrics_runner  # noqa: E402

_FIX = os.path.join(os.path.dirname(__file__), "..", "fixtures",
                    "vod-live-paired-pass.json")

# A tiny manifest: one true-positive goal clip + one negative clip, with a
# detail checklist + ground-truth event window so D_detail is fully computed.
CLIPS = [
    {
        "id": "soc-goal-01", "phase": "goal", "mode": "vod",
        "groundTruth": {"isHighlight": True, "eventType": "GOAL",
                        "eventWindow": [10.0, 14.0]},
        "detail": {"evidence": ["players", "ball", "possession", "score",
                                "reaction"]},
    },
    {
        "id": "soc-off-01", "phase": "off_target", "mode": "vod",
        "groundTruth": {"isHighlight": False, "eventType": None},
    },
]
ACCEPT = {
    "recallLivePct": 85, "recallVodPct": 90, "precisionPct": 70,
    "e2eLatencyMaxS": 5, "goalLatencyMedianMaxS": 3,
    "noiseTriggerFpRateMaxPct": 60, "reactionCitedMinPct": 80,
    "ballTrackPersistenceMinPct": 95, "groundPlaneSpeedErrorMaxPct": 15,
    "possessionAccuracyMinPct": 90,
}


def _deep_decision():
    return [{"type": "candidate", "clipId": "soc-goal-01", "eventType": "GOAL",
             "timestamp": 12.0},
            {"type": "decision", "clipId": "soc-goal-01", "timestamp": 12.5,
             "framesJudged": 24,
             "decision": {"isHighlight": True, "eventType": "GOAL",
                          "reason": "goal: striker on the ball, shot into the "
                                    "goal, crowd erupts, players pile, bench "
                                    "dugout reaction, score 1-0"}}]


def _shallow_decision():
    return [{"type": "candidate", "clipId": "soc-goal-01", "eventType": "GOAL",
             "timestamp": 12.0},
            {"type": "decision", "clipId": "soc-goal-01", "timestamp": 12.5,
             "framesJudged": 3,
             "decision": {"isHighlight": True, "eventType": "GOAL",
                          "reason": "goal"}}]


def test_deep_outdepths_shallow():
    deep = {"events": _deep_decision(), "stageA": {"totalCandidates": 1, "rejected": 0},
            "tracking": {}}
    shallow = {"events": _shallow_decision(), "stageA": {"totalCandidates": 1, "rejected": 0},
               "tracking": {}}
    dm, _ = metrics_runner.compute(CLIPS, deep["events"], deep["stageA"], {},
                                   ACCEPT)
    lm, _ = metrics_runner.compute(CLIPS, shallow["events"], shallow["stageA"],
                                   {}, ACCEPT)
    assert dm["depthN"] == 1 and lm["depthN"] == 1
    assert dm["depthMean"] > lm["depthMean"]
    rel = (dm["depthMean"] - lm["depthMean"]) / lm["depthMean"]
    assert rel >= 0.10, f"expected >=10% relative out-depth, got {rel*100:.1f}%"
    # deeper finding should itself be a healthy (>0) measured depth
    assert dm["depthMean"] >= 40.0


def test_detail_score_weights_evidence_and_reason():
    # Long detailed reason citing many checklist fields + many frames ranks far
    # above a terse "goal" with few frames and no checklist citations.
    clip = CLIPS[0]
    deep_dec = _deep_decision()[1]["decision"]
    shallow_dec = _shallow_decision()[1]["decision"]
    sd = metrics_runner._detail_score(shallow_dec, clip)
    dd = metrics_runner._detail_score(deep_dec, clip)
    assert dd is not None and sd is not None
    assert dd > sd


def test_paired_fixture_parses():
    d = json.load(open(_FIX))
    assert "vod" in d and "live" in d
    clips_l, clips_v = CLIPS, CLIPS
    vm, _ = metrics_runner.compute(clips_v, d["vod"]["events"], d["vod"]["stageA"],
                                   {}, ACCEPT)
    lm, _ = metrics_runner.compute(clips_l, d["live"]["events"], d["live"]["stageA"],
                                   {}, ACCEPT)
    assert vm["depthN"] >= 1 and lm["depthN"] >= 1
    assert vm["depthN"] == lm["depthN"]
    assert vm["depthMean"] > lm["depthMean"]

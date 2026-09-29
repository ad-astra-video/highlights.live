"""ADAAAA-6028 — grounding eval runner self-check (plan G1/G2/G3 accounting).

These are runner tests (no video / GPU): they prove the precision/recall and
gate-reject accounting is correct against driven fixtures. Real pipeline
numbers are produced by driving the deployed decide runner over the labeled
clips and scoring the trace (see grounding_eval.py header).
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from grounding_eval import gate_decision, score  # noqa: E402

EVALS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = json.load(open(os.path.join(EVALS, "grounding-label-manifest.json"), encoding="utf-8"))


def load(name: str):
    return json.load(open(os.path.join(EVALS, "fixtures", name), encoding="utf-8"))


# --- gate unit semantics (mirror of server applyGroundingGate) --------------

def test_gate_accepts_grounded_highlight():
    ok, reason = gate_decision({
        "isHighlight": True, "eventType": "GOAL",
        "grounding": {"objects": ["ball"], "evidence": "ball in net", "supports": True},
    })
    assert ok and reason == ""


def test_gate_rejects_missing_grounding():
    ok, reason = gate_decision({"isHighlight": True, "eventType": "GOAL"})
    assert not ok
    assert "no grounding" in reason


def test_gate_rejects_refuted_grounding():
    ok, reason = gate_decision({
        "isHighlight": True, "eventType": "GOAL",
        "grounding": {"objects": ["ball"], "evidence": "off target", "supports": False},
    })
    assert not ok
    assert "refutes" in reason


def test_gate_rejects_claim_with_no_cited_evidence():
    ok, reason = gate_decision({
        "isHighlight": True, "eventType": "GOAL",
        "grounding": {"objects": [], "evidence": "", "ocrDelta": "", "supports": True},
    })
    assert not ok
    assert "no cited evidence" in reason


def test_gate_noop_for_non_highlight():
    ok, reason = gate_decision({"isHighlight": False, "score": 20, "eventType": "GOAL"})
    assert not ok and reason == ""


# --- G1 / G2 / G3 accounting ------------------------------------------------

def test_pass_fixture_full_precision_and_recall():
    # A grounded decide set: all 6 real goals surfaced with supporting evidence,
    # all 6 non-goal claims refuted by the gate (supports=false -> rejected).
    report = score(MANIFEST, load("grounding-synthetic-pass.json"), apply_gate=True)
    assert report["tp"] == 6 and report["fp"] == 0 and report["fn"] == 0
    assert report["precision"] == 1.0   # G1: no claimed goal that isn't one
    assert report["recall"] == 1.0      # G2: every real goal surfaced
    assert report["g3Rejections"] == 6  # G3: the 6 un-grounded GOAL claims rejected


def test_fail_fixture_counts_false_positives():
    # A decide set where the gate did NOT catch some non-goal claims surfaced as
    # GOAL: precision must drop, rejections = 0 (all accepted).
    report = score(MANIFEST, load("grounding-synthetic-fail.json"), apply_gate=True)
    assert report["tp"] == 6 and report["fp"] == 3 and report["fn"] == 0
    assert report["precision"] == pytest.approx(6 / 9)  # 0.667 < 0.70 target -> FAIL
    assert report["recall"] == 1.0
    assert report["g3Rejections"] == 0


def test_no_gate_reproduces_pre_change_baseline():
    # Without the gate, the raw decide claimed GOAL for every clip including the
    # 6 non-goals: precision 6/12 = 50%, recall 100% — the exact deployed
    # pre-change numbers recorded in evals/VOD-EVAL-PASS1.md. This pins the
    # runner to the real baseline it must beat.
    report = score(MANIFEST, load("grounding-synthetic-pass.json"), apply_gate=False)
    assert report["precision"] == pytest.approx(0.5)
    assert report["recall"] == 1.0
    assert report["fp"] == 6


# --- E2 — motion-aware confirmation: burst-vs-coarse meet-or-beat (ADAAAA-6030)

# A tiny labeled set with ground-truth event times so localization is expressible.
LOC_MANIFEST = {
    "samples": [
        {"id": "a", "isGoal": True, "timeSeconds": 10.0},
        {"id": "b", "isGoal": True, "timeSeconds": 20.0},
        {"id": "c", "isGoal": False},
    ]
}


def _loc_trace(tier, decision_time, extra=None):
    entry = {
        "sampleId": tier,  # placeholder replaced below per-sample
        "tier": tier,
        "decisionTime": decision_time,
        "decision": {
            "isHighlight": True,
            "eventType": "GOAL",
            "grounding": {"objects": ["ball"], "evidence": "in net", "supports": True},
        },
    }
    if extra:
        entry.update(extra)
    return entry


def test_e2_localization_error_computed_per_sampled_goal():
    from grounding_eval import localization_meets_or_beats

    trace = []
    for sid, t in [("a", 11.0), ("b", 20.5)]:
        e = _loc_trace("burst", t)
        e["sampleId"] = sid
        trace.append(e)
    report = score(LOC_MANIFEST, trace, apply_gate=True)
    # errors: |11-10|=1.0, |20.5-20|=0.5 -> mean 0.75, max 1.0
    assert report["meanLocalizationErrorS"] == pytest.approx(0.75)
    assert report["maxLocalizationErrorS"] == pytest.approx(1.0)
    assert report["localizationSamples"] == 2
    assert report["tier"] == "burst"

    # E2 guard: burst with tighter localization + equal precision meets-or-beats
    # coarse (coarser localization, same precision).
    coarse_trace = []
    for sid, t in [("a", 9.0), ("b", 22.0)]:
        e = _loc_trace("coarse", t)
        e["sampleId"] = sid
        coarse_trace.append(e)
    coarse = score(LOC_MANIFEST, coarse_trace, apply_gate=True)
    ok, reason = localization_meets_or_beats(coarse, report)
    assert ok, reason
    assert "burst mean|err| 0.75s vs coarse" in reason

    # A burst that is WORSE on localization must FAIL the guard.
    bad_trace = []
    for sid, t in [("a", 14.0), ("b", 26.0)]:
        e = _loc_trace("burst", t)
        e["sampleId"] = sid
        bad_trace.append(e)
    bad = score(LOC_MANIFEST, bad_trace, apply_gate=True)
    ok2, _ = localization_meets_or_beats(coarse, bad)
    assert not ok2

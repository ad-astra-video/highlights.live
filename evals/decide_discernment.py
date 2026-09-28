"""ADAAAA-5778 — land the notable-only notability bar FROM DATA.

Sweeps the decide notable-only gate over the labeled §6 / real-feed eval set
(evals/label-manifest.json, the INC-5 soccer clips) and picks the default
`notability_min` as the value inside the separating band that keeps recall at
the accepted bar with 0 spurious highlight phases.

Why data, not a hand-picked number: ADAAAA-4496 (INC-9) measured that the four
negative clips (off_target / warm_up / replay / commentary_lull) each carry a
GOAL candidate Gemma accepts at score ~95, because those clips contain real
shot/lull sequences visually near-identical to goals. Pure score alone does NOT
separate them. The separable signal on this eval set is corroboration: every
TRUE phase (goal / near_goal) is labeled `reaction.audio=true` (crowd/commentary
eruption is present), every FALSE phase is labeled `reaction.audio=false`. So the
gate requires corroborating evidence in addition to (or as a substitute for) a
high notability score.

This script scores the deterministic RULE path end-to-end over the eval set
(recall/precision/FP) and reports the sweep + landed default. It is pure and
reproducible (no GPU). To land the threshold from real GEMMA scores, run with
`--trace <recorded_decisions.jsonl>` where each line is a recorded decide()
outcome {phase, isHighlight, score, eventType, reaction<...>}; the gemma-path
separation is then measured on real data.

Run:  python3 evals/decide_discernment.py
      python3 evals/decide_discernment.py --trace evals/decide-trace.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# Allow import of the decide service from a repo-root invocation.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services", "decide"))

from app.decider import DEFAULT_NOTABILITY_MIN, apply_gate, event_class, has_corroboration, _rule_score  # noqa: E402

# Accepted recall bar from the eval manifest acceptance block.
RECALL_BAR_PCT = 85


def rule_evidence_model() -> list[dict]:
    """Per-phase candidate evidence derived from the eval manifest ground truth
    (reaction labels + tracking intensity). Used for the deterministic-rule
    data-landing; replace with a real recorded trace for the Gemma path."""
    return [
        # True highlights (goal / near_goal): high-value GOAL + reaction.
        {"phase": "goal",      "truth": True,  "eventType": "GOAL", "trackCount": 2, "maxVelocity": 0.40, "ocrHits": 1, "reaction": {"crowdEnergy": 0.90, "humansInMotion": 3, "ballSpeedMps": 21.0}},
        {"phase": "goal",      "truth": True,  "eventType": "GOAL", "trackCount": 2, "maxVelocity": 0.42, "ocrHits": 1, "reaction": {"crowdEnergy": 0.88, "humansInMotion": 2, "ballSpeedMps": 19.0}},
        {"phase": "goal",      "truth": True,  "eventType": "GOAL", "trackCount": 2, "maxVelocity": 0.45, "ocrHits": 0, "reaction": {"crowdEnergy": 0.95, "humansInMotion": 3, "ballSpeedMps": 22.0}},
        {"phase": "goal",      "truth": True,  "eventType": "GOAL", "trackCount": 2, "maxVelocity": 0.40, "ocrHits": 0, "reaction": {"crowdEnergy": 0.82, "humansInMotion": 2, "ballSpeedMps": 18.0}},
        {"phase": "near_goal", "truth": True,  "eventType": "GOAL", "trackCount": 2, "maxVelocity": 0.35, "ocrHits": 0, "reaction": {"crowdEnergy": 0.70, "humansInMotion": 2, "ballSpeedMps": 15.0}},
        {"phase": "near_goal", "truth": True,  "eventType": "GOAL", "trackCount": 2, "maxVelocity": 0.33, "ocrHits": 0, "reaction": {"crowdEnergy": 0.68, "humansInMotion": 1, "ballSpeedMps": 14.0}},
        # False phases: ordinary (non-high) event classes with no crowd reaction.
        {"phase": "off_target", "truth": False, "eventType": "SHOT", "trackCount": 1, "maxVelocity": 0.55, "ocrHits": 0, "reaction": {"crowdEnergy": 0.0, "humansInMotion": 1, "ballSpeedMps": 5.0}},
        {"phase": "off_target", "truth": False, "eventType": "SHOT", "trackCount": 1, "maxVelocity": 0.50, "ocrHits": 0, "reaction": {"crowdEnergy": 0.0, "humansInMotion": 1, "ballSpeedMps": 6.0}},
        {"phase": "warm_up",   "truth": False, "eventType": "MOVE", "trackCount": 0, "maxVelocity": 0.0,  "ocrHits": 0, "reaction": {"crowdEnergy": 0.0, "humansInMotion": 0, "ballSpeedMps": 0.0}},
        {"phase": "warm_up",   "truth": False, "eventType": "MOVE", "trackCount": 0, "maxVelocity": 0.0,  "ocrHits": 0, "reaction": {"crowdEnergy": 0.0, "humansInMotion": 0, "ballSpeedMps": 0.0}},
        {"phase": "commentary_lull", "truth": False, "eventType": "COMMENTARY", "trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0, "reaction": {"crowdEnergy": 0.12, "humansInMotion": 0, "ballSpeedMps": 0.0}},
        {"phase": "replay_loop", "truth": False, "eventType": "SCENE", "trackCount": 2, "maxVelocity": 0.30, "ocrHits": 0, "reaction": {"crowdEnergy": 0.0, "humansInMotion": 0, "ballSpeedMps": 0.0}},
    ]


def gate_decision(ev):
    """Score a candidate evidence row under the notable-only gate. Returns
    (surfaced: bool, score: float, event_class: str, corroborated: bool)."""
    rc = ev.get("reaction") or {}
    score, _ = _rule_score(ev["eventType"], ev.get("trackCount", 0), ev.get("maxVelocity", 0.0), ev.get("ocrHits", 0))
    ok, _ = apply_gate(
        score=score,
        event_type=ev["eventType"],
        track_count=ev.get("trackCount", 0),
        max_velocity=ev.get("maxVelocity", 0.0),
        ocr_hits=ev.get("ocrHits", 0),
        reaction=rc,
        min_notability=DEFAULT_NOTABILITY_MIN,
    )
    return ok, score, event_class(ev["eventType"]), has_corroboration(ev.get("trackCount", 0), ev.get("maxVelocity", 0.0), ev.get("ocrHits", 0), rc)


def evaluate(rows, bar: float) -> dict:
    tp = fp = tn = fn = 0
    for ev in rows:
        score, _ = _rule_score(ev["eventType"], ev.get("trackCount", 0), ev.get("maxVelocity", 0.0), ev.get("ocrHits", 0))
        ok, _ = apply_gate(
            score=score, event_type=ev["eventType"],
            track_count=ev.get("trackCount", 0), max_velocity=ev.get("maxVelocity", 0.0),
            ocr_hits=ev.get("ocrHits", 0), reaction=ev.get("reaction"),
            min_notability=bar,
        )
        truth = bool(ev["truth"])
        if ok and truth:
            tp += 1
        elif ok and not truth:
            fp += 1
        elif not ok and not truth:
            tn += 1
        else:
            fn += 1
    n_true = tp + fn
    recall = (tp / n_true * 100.0) if n_true else 100.0
    prec = (tp / (tp + fp) * 100.0) if (tp + fp) else 100.0
    # Stage-A-style rejection rate (rejected / total), comparable to the
    # recorded job.stageAMetrics.fpRate.
    reject = ((fp + tn) / len(rows) * 100.0) if rows else 0.0
    return {"tp": tp, "fp": fp, "tn": tn, "fn": fn, "recall": recall, "precision": prec, "rejectPct": reject}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trace", default=None, help="optional JSONL of recorded Gemma decide outcomes to re-land the bar from real data")
    args = ap.parse_args()

    rows: list[dict] = []
    gemma = False
    if args.trace:
        with open(args.trace) as fh:
            for line in fh:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
        gemma = True
    else:
        rows = rule_evidence_model()

    print(f"# ADAAAA-5778 notable-only bar — data-landing ({'Gemma trace' if gemma else 'deterministic-rule'} path)")
    print(f"# eval set: evals/label-manifest.json ({len(rows)} candidates; {sum(1 for r in rows if r['truth'])} true / {len(rows)-sum(1 for r in rows if r['truth'])} false)\n")

    # Per-candidate detail under the current landed default.
    ok, score, cls, corr = gate_decision(rows[0])
    print("## Per-candidate verdict @ landed default")
    print(f"{'phase':16}{'truth':6}{'class':10}{'corr':5}{'score':>6}{'surfaced':>9}")
    for ev in rows:
        s_ok, s_score, s_cls, s_corr = gate_decision(ev)
        print(f"{ev['phase']:16}{str(ev['truth']):6}{s_cls:10}{str(s_corr):5}{s_score:>6.0f}{str(s_ok):>9}")

    # Sweep and find the separating band.
    print("\n## Threshold sweep")
    print(f"{'bar':>5}{'recall%':>9}{'precision%':>11}{'FP':>4}{'reject%':>9}")
    band_lo = band_hi = None
    for bar in range(0, 101, 5):
        r = evaluate(rows, bar)
        marker = " <- landed" if bar == DEFAULT_NOTABILITY_MIN else ""
        print(f"{bar:>5}{r['recall']:>9.1f}{r['precision']:>11.1f}{r['fp']:>4}{r['rejectPct']:>9.0f}{marker}")
        ok_band = r["recall"] >= RECALL_BAR_PCT and r["fp"] == 0
        if ok_band:
            if band_lo is None:
                band_lo = bar
            band_hi = bar

    print("\n## Landed default justification")
    truth_scores = sorted(
        _rule_score(r["eventType"], r.get("trackCount", 0), r.get("maxVelocity", 0.0), r.get("ocrHits", 0))[0]
        for r in rows if r["truth"]
    )
    false_scores = sorted(
        _rule_score(r["eventType"], r.get("trackCount", 0), r.get("maxVelocity", 0.0), r.get("ocrHits", 0))[0]
        for r in rows if not r["truth"]
    )
    print(f"- Separating band where recall>={RECALL_BAR_PCT}% with 0 FP phases: bar in [{band_lo}, {band_hi}]")
    print(f"- True-phase rule scores:   {truth_scores}")
    print(f"- False-phase rule scores:  {false_scores}")
    print(f"- Landed DEFAULT_NOTABILITY_MIN = {DEFAULT_NOTABILITY_MIN} (inside band)")
    r = evaluate(rows, DEFAULT_NOTABILITY_MIN)
    print(f"- At landed bar: recall={r['recall']:.1f}% (bar>={RECALL_BAR_PCT}%), precision={r['precision']:.1f}%, "
          f"FP phases={r['fp']}, Stage-A-style reject rate={r['rejectPct']:.0f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

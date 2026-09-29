#!/usr/bin/env python3
"""ADAAAA-6028 — grounded-event classification eval runner (plan G).

Scores the grounding gate's acceptance criteria against a labeled grounding
eval set (goals vs non-events):

  G1 (precision): every claimed GOAL highlight corresponds to an actual goal.
  G2 (recall):    every actual goal is surfaced as a GOAL highlight.
  G3 (gate):      a candidate whose claimed event type has no supporting vision
                  evidence is rejected (not surfaced); rejections are counted.

`gate_decision` mirrors the server's `applyGroundingGate` (services/server/src/
analyzer.ts) so this runner can score a real deployed-pipeline trace offline:
the grounding rules live in one place (the server) and are re-checked here.

Usage (trace mode — the recommended path, no GPU needed):

    python3 evals/grounding_eval.py \
        --manifest evals/grounding-label-manifest.json \
        --trace evals/grounding-trace.json \
        [--no-gate]         # score raw decide isHighlight (pre-gate baseline)

`--trace` is a JSON array or JSONL of per-sample decisions. Each entry:
  { "sampleId": "<id from manifest>",
    "decision": { "isHighlight": bool, "eventType": "GOAL", "score": n,
                  "grounding": { "objects": [], "ocrDelta": "", "evidence": "",
                                 "supports": true } } }
A bare entry (no nested "decision") is treated as the decision itself.

Self-check (no video / GPU):

    python3 evals/grounding_eval.py --manifest evals/grounding-label-manifest.json \
        --trace evals/fixtures/grounding-synthetic-pass.json
    pytest evals/tests/test_grounding_eval.py
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def gate_decision(decision: dict) -> tuple[bool, str]:
    """Mirror of server applyGroundingGate. (accepted, reason); reason "" when
    accepted or when the decision is a non-highlight (no-op)."""
    if not decision.get("isHighlight"):
        return False, ""
    ev = str(decision.get("eventType") or "event")
    g = decision.get("grounding")
    if not isinstance(g, dict):
        return False, f"no grounding evidence for claimed event type {ev}"
    if g.get("supports") is False:
        return False, f"grounding refutes claimed event type {ev}"
    objects = g.get("objects")
    has_evidence = bool(str(g.get("evidence") or "").strip()) or (
        isinstance(objects, list) and len(objects) > 0
    ) or bool(str(g.get("ocrDelta") or "").strip())
    if not has_evidence:
        return False, f"grounding claims {ev} with no cited evidence"
    return True, ""


def load_trace(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        text = f.read().strip()
    if text.startswith("["):
        return json.loads(text)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def score(manifest: dict, trace: list[dict], apply_gate: bool = True) -> dict:
    samples = {s["id"]: s for s in manifest["samples"]}
    by_id: dict[str, dict] = {}
    for entry in trace:
        sid = entry.get("sampleId") or entry.get("id")
        if sid is not None:
            by_id[sid] = entry

    rows = []
    tp = fp = fn = 0
    rejections = 0
    # E2 (ADAAAA-6030): event-time localization scatter over surfaced true
    # positives. When a labeled sample carries `timeSeconds` (ground-truth event
    # time) and the trace entry carries `decisionTime` (the decide call's
    # reported moment), a surfaced GOAL records |decisionTime - timeSeconds|.
    # Measured per-tier so the coarse-only vs burst comparison is expressible.
    loc_errors: list[float] = []
    tier = ""
    for sid, sample in samples.items():
        gt_goal = bool(sample["isGoal"])
        entry = by_id.get(sid)
        if entry is None:
            rows.append({"id": sid, "gt": gt_goal, "surfaced": False, "absent": True})
            if gt_goal:
                fn += 1
            continue
        assert isinstance(entry, dict)  # narrow Optional for the reader/type-checker
        if entry.get("tier"):
            tier = str(entry.get("tier"))
        decision = entry.get("decision") if isinstance(entry.get("decision"), dict) else entry
        if apply_gate:
            accepted, reason = gate_decision(decision)
        else:
            accepted = bool(decision.get("isHighlight"))
            reason = ""
        # G3: a claimed highlight (isHighlight) rejected by the gate is counted.
        if decision.get("isHighlight") and not accepted:
            rejections += 1
        event_type = str(decision.get("eventType") or "").upper()
        surfaced = accepted and event_type == "GOAL"
        if gt_goal and surfaced:
            tp += 1
            gt_time = sample.get("timeSeconds")
            dec_time = entry.get("decisionTime") or decision.get("decisionTime")
            if isinstance(gt_time, (int, float)) and isinstance(dec_time, (int, float)):
                loc_errors.append(abs(float(dec_time) - float(gt_time)))
        elif not gt_goal and surfaced:
            fp += 1
        elif gt_goal and not surfaced:
            fn += 1
        rows.append(
            {
                "id": sid,
                "gt": gt_goal,
                "isHighlight": bool(decision.get("isHighlight")),
                "eventType": decision.get("eventType"),
                "gateAccepted": accepted,
                "gateReason": reason,
                "surfacedGoal": surfaced,
                "decisionTime": decision.get("decisionTime")
                or entry.get("decisionTime"),
            }
        )

    precision = tp / (tp + fp) if (tp + fp) else None
    recall = tp / (tp + fn) if (tp + fn) else None
    return {
        "gateApplied": apply_gate,
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        # G3: claimed-but-rejected (no supporting vision evidence), measurable.
        "g3Rejections": rejections,
        "g3RejectionsMeasurable": True,
        # E2 (ADAAAA-6030): event-time localization (mean/max ±s) + the tier the
        # trace was captured under, so burst-vs-coarse meet-or-beat is testable.
        "tier": tier,
        "meanLocalizationErrorS": (sum(loc_errors) / len(loc_errors)) if loc_errors else None,
        "maxLocalizationErrorS": max(loc_errors) if loc_errors else None,
        "localizationSamples": len(loc_errors),
        "rows": rows,
    }


def localization_meets_or_beats(coarse: dict, burst: dict, max_error_s: float = 2.0) -> tuple[bool, str]:
    """E2 regression guard: the burst tier must MEET-OR-BEAT coarse-only on both
    event-type precision and event-time localization (±s). Returns (ok, reason).

    ``coarse``/``burst`` are the dicts from score(); measures come from their
    respective tiers. A tier without measurements is treated as not-worse than
    the other as long as it has equal-or-better precision.
    """
    checks: list[str] = []
    ok = True
    cp, bp = coarse.get("precision"), burst.get("precision")
    if cp is not None and bp is not None:
        ok &= bp >= cp - 1e-9
        checks.append(f"burst precision {bp:.1%} vs coarse {cp:.1%} ({'PASS' if bp >= cp - 1e-9 else 'FAIL'})")
    else:
        checks.append("precision not both measured")
    cm, bm = coarse.get("meanLocalizationErrorS"), burst.get("meanLocalizationErrorS")
    if cm is not None and bm is not None:
        ok &= bm <= cm + 1e-9
        checks.append(f"burst mean|err| {bm:.2f}s vs coarse {cm:.2f}s ({'PASS' if bm <= cm + 1e-9 else 'FAIL'})")
    elif cm is None:
        checks.append("coarse localization not measured (add decisionTime + sample timeSeconds)")
        ok &= bm is None or bm <= max_error_s
    return bool(ok), "; ".join(checks)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Grounding eval runner (plan G).")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--trace", required=True)
    ap.add_argument("--no-gate", action="store_true",
                    help="score raw decide isHighlight (pre-gate baseline)")
    ap.add_argument("--json", action="store_true", help="emit machine JSON")
    a = ap.parse_args(argv)

    manifest = json.load(open(a.manifest, encoding="utf-8"))
    trace = load_trace(a.trace)
    report = score(manifest, trace, apply_gate=not a.no_gate)

    if a.json:
        print(json.dumps(report, indent=2))
        return 0

    acc = manifest.get("acceptance", {})
    p_min = acc.get("g1PrecisionMinPct", 70) / 100.0
    r_min = acc.get("g2RecallMinPct", 90) / 100.0
    p = report["precision"]
    r = report["recall"]
    mode = "with grounding gate" if report["gateApplied"] else "RAW decide (no gate)"
    print(f"mode: {mode}")
    print(f"G1 precision: {p:.1%}  (target >= {p_min:.0%})  -> {'PASS' if (p is not None and p >= p_min) else 'FAIL'}")
    print(f"G2 recall:    {r:.1%}  (target >= {r_min:.0%})  -> {'PASS' if (r is not None and r >= r_min) else 'FAIL'}")
    print(f"G3 gate rejections (claimed-but-no-evidence): {report['g3Rejections']}")
    print(f"TP={report['tp']} FP={report['fp']} FN={report['fn']}")
    for row in report["rows"]:
        print(
            f"  {row['id']:<12} gt_goal={int(row['gt'])} isHighlight={int(row['isHighlight'])} "
            f"event={str(row.get('eventType')):<6} gate_ok={int(row['gateAccepted'])} "
            f"surfaced_goal={int(row['surfacedGoal'])} {row.get('gateReason') or ''}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())

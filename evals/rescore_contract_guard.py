#!/usr/bin/env python3
"""Offline re-score of a stored decide eval (ADAAAA-8370 / ADAAAA-8343).

Pure offline replay of STORED rows: no decide call, no GPU, no server, no config
change. Each row's raw model reply is re-parsed and re-guarded with the decide
module named by --module-dir, so the v1 (deployed) and v2 (ADAAAA-8370) contract
guards are scored on byte-identical inputs.

Usage:
  python3 evals/rescore_contract_guard.py --module-dir <dir containing app/> --version v1|v2 \
      --rows rows.jsonl --manifest label-manifest.json \
      --evidence-dir <cache>/evidence --out score_<version>.json \
      --perwin perwin_<version>.jsonl
"""
import argparse
import json
import os
import sys
from collections import Counter


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--module-dir", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--rows", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--evidence-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--perwin", required=True)
    ap.add_argument("--event-type", default="SPORTING_EVENT")
    args = ap.parse_args()

    sys.path.insert(0, args.module_dir)
    from app.gemma import apply_contract_guard, parse_decision  # noqa: E402

    manifest = json.load(open(args.manifest))
    SHOT = {"saved", "post", "blocked", "wide"}
    truth = {}
    for w in manifest["windows"]:
        g = str(w.get("ground_truth", "")).lower() == "goal"
        ev = str(w.get("evidence", ""))
        truth[w["id"]] = {"cls": "goal" if g else ("shot" if ev in SHOT else "no_shot"),
                          "evidence": ev}

    rows = [json.loads(l) for l in open(args.rows) if l.strip()]
    perwin = []
    for r in rows:
        evp = os.path.join(args.evidence_dir, r["rail"], r["window"] + ".json")
        ev = None
        try:
            ev = json.load(open(evp))["evidence"]
        except Exception:  # noqa: BLE001
            ev = None
        p = parse_decision(r.get("raw") or "")
        if p is None:
            perwin.append({"cell": r["cell"], "rail": r["rail"], "window": r["window"],
                           "truth": truth[r["window"]]["cls"], "pre": "unparsed",
                           "post": "unparsed", "guard": None})
            continue
        pre = p.get("outcome")
        p2, guard = apply_contract_guard(p, ev, args.event_type, transcript="",
                                         perceive_window=None)
        crit = ((p.get("verdict") or {}).get("criteria") or {})
        att = (guard or {}).get("attestation") or {}
        perwin.append({
            "cell": r["cell"], "rail": r["rail"], "window": r["window"],
            "truth": truth[r["window"]]["cls"],
            "perceive_evidence": truth[r["window"]]["evidence"],
            "pre": pre,
            "post": p2.get("outcome"),
            "guard": (guard or {}).get("outcome"),
            "guard_code": (guard or {}).get("contradictedBy"),
            "attested": att.get("attested"),
            "signals": att.get("signals"),
            "criteria": {"ballCrossedLineBetweenPosts": crit.get("ballCrossedLineBetweenPosts"),
                         "ballInNet": crit.get("ballInNet")},
            "reason": (p2.get("reason") or "")[:200],
            "ttft_s": r.get("ttft_s"), "wall_s": r.get("wall_s"),
            "usage": r.get("usage"),
        })

    GOAL = "scoring_play"
    cells = []
    for cell in dict.fromkeys(r["cell"] for r in perwin):
        crows = [r for r in perwin if r["cell"] == cell]
        rec = {}
        for view in ("pre", "post"):
            conf, fp_d, fn_d = Counter(), [], []
            tp = fp = 0
            for r in crows:
                t = r["truth"]
                pred = r.get(view) or "not_highlight"
                conf[(t, pred)] += 1
                if pred == GOAL:
                    if t == "goal":
                        tp += 1
                    else:
                        fp += 1
                        fp_d.append({"window": r["window"], "truth": t,
                                     "evidence": r["perceive_evidence"],
                                     "guard": r["guard"], "guard_code": r["guard_code"],
                                     "attested": r["attested"],
                                     "criteria": r["criteria"],
                                     "reason": r["reason"]})
                elif t == "goal":
                    fn_d.append({"window": r["window"], "pred": pred,
                                 "guard": r["guard"], "guard_code": r["guard_code"],
                                 "attested": r["attested"]})
            n_goal = sum(1 for r in crows if r["truth"] == "goal")
            rec[view] = {"tp": tp, "fp": fp, "fn": len(fn_d),
                         "precision": round(tp / (tp + fp), 4) if tp + fp else None,
                         "recall": round(tp / n_goal, 4) if n_goal else None,
                         "confusion": {f"{a}|{b}": n for (a, b), n in sorted(conf.items())},
                         "fp_detail": fp_d, "fn_detail": fn_d}
        rec.update({"cell": cell, "rail": crows[0]["rail"], "windows": len(crows),
                    "budget": None, "scale": None})
        cells.append(rec)

    lost, tp_sets = {}, {}
    for rail in dict.fromkeys(c["rail"] for c in cells):
        cs = [c for c in cells if c["rail"] == rail]
        ctrl = next(c for c in cs if "ctrl" in c["cell"])
        ctrl_goals = sorted(r["window"] for r in perwin
                            if r["cell"] == ctrl["cell"] and r["truth"] == "goal"
                            and r["post"] == GOAL)
        tp_sets[ctrl["cell"]] = ctrl_goals
        for c in cs:
            got = sorted(r["window"] for r in perwin
                         if r["cell"] == c["cell"] and r["post"] == GOAL)
            tp_sets[c["cell"]] = got
            lost[c["cell"]] = sorted(set(ctrl_goals) - set(got))

    out = {"version": args.version, "rows": len(rows), "manifest_windows": len(manifest["windows"]),
           "cells": cells, "lost_vs_control": lost, "post_tp_sets": tp_sets,
           "guard_outcomes": Counter(r["guard"] for r in perwin),
           "guard_codes": Counter(r["guard_code"] for r in perwin)}
    out["guard_outcomes"] = dict(out["guard_outcomes"])
    out["guard_codes"] = dict(out["guard_codes"])
    json.dump(out, open(args.out, "w"), indent=1)
    with open(args.perwin, "w") as fh:
        for r in perwin:
            fh.write(json.dumps(r) + "\n")

    print(f"== {args.version}: {len(rows)} rows")
    for c in cells:
        p, q = c["post"], c["pre"]
        print(f"  {c['cell']:22s} post P={p['precision']} R={p['recall']} TP={p['tp']} "
              f"FP={p['fp']} FN={p['fn']} | pre P={q['precision']} R={q['recall']}")
    print("  guard outcomes:", out["guard_outcomes"])
    print("  guard codes:", out["guard_codes"])
    for k, v in lost.items():
        print(f"  lost({k}) = {v}")


if __name__ == "__main__":
    main()

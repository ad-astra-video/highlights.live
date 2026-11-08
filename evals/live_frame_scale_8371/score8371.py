#!/usr/bin/env python3
"""Score the ADAAAA-8371 two-cell live eval against the FRAME-VERIFIED manifest.

Cells (rail `live`, budget 280):
  live_ctrl_280_320x180   control: the deployed live scale
  live_280_768x432        match:   768x432

Prediction = the DEPLOYED parser's outcome (`parse_decision`) from the raw reply,
and `goal predicted` == outcome `scoring_play` (the taxonomy's frame-confirmed
scoring play). Both guard builds are applied with the same call the live rail
makes (`eventType='SPORTING_EVENT'`), so the report can state precision raw AND
after the deterministic guards:

  * apply_goal_attestation_gate  (ADAAAA-6610 / ADAAAA-8370 family)
  * apply_contract_guard         (ADAAAA-8120 scoring_play contract guard)

Statistics: Wilson 95% intervals per cell (precision and recall), Newcombe
hybrid score interval on each cell-to-cell delta, exact McNemar p over the
discordant goal windows, and the exact McNemar power at the observed
discordance so a single-window flip reads as noise.

Usage (box):
  python3 score8371.py --rows rows.jsonl \
      --manifest label-manifest-8371-verified.json \
      --evidence-cache cache/evidence/live \
      --frames-cache cache/frames --json score.json
"""
import argparse
import glob
import json
import math
import os
import subprocess
import sys
from collections import Counter

GOAL = "scoring_play"
SHOT = {"saved", "post", "blocked", "wide"}
EVENT_TYPE = "SPORTING_EVENT"  # what the live rail sends (the candidate label)


# ------------------------------------------------------------------ container IO
def container_score(items):
    """Parse + guard each row inside highlights-decide (exact deployed semantics).

    items: [{"raw", "evidence", "eventType"}] -> per row dict with the parsed
    decision, the attestation-gate verdict and the contract-guard record.
    """
    code = (
        "import json,sys\n"
        "sys.path.insert(0,'/srv/decide')\n"
        "from app.gemma import parse_decision, apply_goal_attestation_gate, apply_contract_guard\n"
        "items=json.load(sys.stdin)\n"
        "out=[]\n"
        "for it in items:\n"
        "    d=parse_decision(it['raw'] or '')\n"
        "    if d is None:\n"
        "        out.append({'_unparsed':True,'raw':(it['raw'] or '')[:200]}); continue\n"
        "    ok,reason=apply_goal_attestation_gate(d, it['evidence'], it['eventType'])\n"
        "    pre_isHL=d.get('isHighlight'); pre_out=d.get('outcome')\n"
        "    d2,guard=apply_contract_guard(dict(d), it['evidence'], it['eventType'], '', None)\n"
        "    out.append({'outcome':pre_out,'isHighlight':pre_isHL,\n"
        "                'reason':(d.get('reason') or '')[:300],\n"
        "                'criteria':(d.get('verdict') or {}).get('criteria'),\n"
        "                'attest_ok':ok,'attest_reason':reason,\n"
        "                'guard_outcome':guard.get('outcome'),\n"
        "                'guard_contradictedBy':guard.get('contradictedBy'),\n"
        "                'post_isHighlight':d2.get('isHighlight'),\n"
        "                'post_outcome':d2.get('outcome')})\n"
        "json.dump(out,sys.stdout)\n"
    )
    p = subprocess.run(["docker", "exec", "-i", "highlights-decide", "python3", "-c", code],
                       input=json.dumps(items).encode(), capture_output=True)
    if p.returncode != 0:
        print("container scorer failed:", p.stderr.decode()[:600], file=sys.stderr)
        sys.exit(1)
    return json.loads(p.stdout.decode())


def guard_identity():
    md5 = subprocess.run(["docker", "exec", "highlights-decide", "md5sum",
                          "/srv/decide/app/gemma.py"], capture_output=True, text=True)
    image = subprocess.run(["docker", "inspect", "highlights-decide", "-f", "{{.Image}}"],
                           capture_output=True, text=True)
    env = subprocess.run(["docker", "exec", "highlights-decide", "printenv"],
                         capture_output=True, text=True)
    confirm = [l for l in env.stdout.splitlines() if l.startswith("DECIDE_CONFIRM_ENABLED")]
    return {"gemma_py_md5": md5.stdout.split()[0] if md5.stdout else None,
            "decide_image": image.stdout.strip() or None,
            "confirm_env": confirm[0] if confirm else None}


# ----------------------------------------------------------------------- stats
def wilson(k, n, z=1.959963985):
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [round((c - half) / d, 4), round((c + half) / d, 4)]


def newcombe(k1, n1, k2, n2, z=1.959963985):
    """Newcombe (method 10) hybrid score interval for p1 - p2 (independent)."""
    if not n1 or not n2:
        return None
    p1, p2 = k1 / n1, k2 / n2
    l1, u1 = wilson(k1, n1, z)
    l2, u2 = wilson(k2, n2, z)
    d = p1 - p2
    lo = d - math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2)
    hi = d + math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)
    return [round(lo, 4), round(hi, 4)]


def mcnemar_exact(b, c):
    """Two-sided exact McNemar over discordant counts b, c."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(0, k + 1)) / (2 ** n)
    return round(min(1.0, 2 * tail), 6)


def mcnemar_power(n_windows, discordance, gain_ratio=0.75, alpha=0.05):
    """Exact power: total discordant K ~ Binom(N, discordance); within K the
    gain-direction share is `gain_ratio` (3:1 => match wins 3 of 4 discordant
    pairs). Reject when the exact two-sided McNemar p <= alpha."""
    def reject(b, k):
        return mcnemar_exact(b, k - b) <= alpha
    power = 0.0
    for k in range(0, n_windows + 1):
        pk = math.comb(n_windows, k) * discordance ** k * (1 - discordance) ** (n_windows - k)
        if pk == 0:
            continue
        inner = sum(math.comb(k, b) * gain_ratio ** b * (1 - gain_ratio) ** (k - b)
                    for b in range(0, k + 1) if reject(b, k))
        power += pk * inner
    return round(power, 4)


def median(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    return round(xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2, 3)


def payload_mb(frames_cache, scale, wid, n_img):
    d = os.path.join(frames_cache, f"30_{scale}", wid)
    files = sorted(glob.glob(os.path.join(d, "f_*.jpg")))
    if not files:
        return None
    total = sum(os.path.getsize(f) for f in files)
    total += os.path.getsize(files[-1])  # deployed wire duplicates the last frame
    return round(total / 1e6, 3)


# ------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--evidence-cache", default=None)
    ap.add_argument("--frames-cache", default=None)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    manifest = json.load(open(args.manifest))
    truth = {}
    for w in manifest["windows"]:
        g = str(w.get("ground_truth", "")).lower() == "goal"
        ev = str(w.get("evidence", ""))
        truth[w["id"]] = {"cls": "goal" if g else ("shot" if ev in SHOT else "no_shot"),
                          "evidence": ev, "instant": w.get("instant"),
                          "t_start": w.get("t_start"), "t_end": w.get("t_end")}
    rows = [json.loads(l) for l in open(args.rows) if l.strip()]
    rows = [r for r in rows if r["window"] in truth]        # dropped anchors excluded
    by_cell = {}
    for r in rows:
        by_cell.setdefault(r["cell"], []).append(r)

    items = []
    for r in rows:
        ev = None
        if args.evidence_cache:
            p = os.path.join(args.evidence_cache, r["window"] + ".json")
            if os.path.exists(p):
                ev = json.load(open(p)).get("evidence")
        items.append({"raw": r.get("raw") or "", "evidence": ev,
                      "eventType": EVENT_TYPE})
    scored = container_score(items)
    for r, s in zip(rows, scored):
        r["s"] = s

    def pred(r, guarded):
        s = r["s"]
        if s.get("_unparsed"):
            return "unparsed"
        if not guarded:
            return s.get("outcome") or "not_highlight"   # identical to the 8343 scorer
        out = s.get("post_outcome") or "not_highlight"
        if out == GOAL and s.get("post_isHighlight") is not True:
            return "scoring_play_rejected"               # guard killed the accept
        return out

    cells = []
    for cell, crows in by_cell.items():
        entry = {"cell": cell, "rail": crows[0]["rail"], "budget": crows[0]["budget"],
                 "scale": crows[0]["scale"], "windows": len(crows),
                 "n_img": crows[0].get("n_img")}
        for mode, guarded in (("raw", False), ("guard", True)):
            conf = Counter()
            tp = fp = fn = tn = 0
            fp_ids, fn_ids = [], []
            for r in crows:
                t = truth[r["window"]]["cls"]
                p = pred(r, guarded)
                conf[(t, p)] += 1
                if p == GOAL:
                    if t == "goal":
                        tp += 1
                    elif t in ("shot", "no_shot"):
                        fp += 1
                        fp_ids.append({"window": r["window"], "truth": t,
                                       "evidence": truth[r["window"]]["evidence"],
                                       "reason": (r["s"].get("reason") or "")[:160],
                                       "guard_outcome": r["s"].get("guard_outcome")})
                    else:
                        fp += 1
                        fp_ids.append({"window": r["window"], "truth": t})
                else:
                    if t == "goal":
                        fn += 1
                        fn_ids.append({"window": r["window"], "pred": p,
                                       "outcome": r["s"].get("outcome"),
                                       "reason": (r["s"].get("reason") or "")[:160]})
                    else:
                        tn += 1
            n_goal = sum(1 for r in crows if truth[r["window"]]["cls"] == "goal")
            entry[mode] = {
                "tp": tp, "fp": fp, "fn": fn, "tn": tn, "goals": n_goal,
                "precision": round(tp / (tp + fp), 4) if tp + fp else None,
                "recall": round(tp / n_goal, 4) if n_goal else None,
                "precision_ci95": wilson(tp, tp + fp),
                "recall_ci95": wilson(tp, n_goal),
                "confusion": {f"{a}|{b}": n for (a, b), n in sorted(conf.items())},
                "fp_ids": sorted(fp_ids, key=lambda x: x["window"]),
                "fn_ids": sorted(fn_ids, key=lambda x: x["window"]),
            }
        entry["latency"] = {
            "prompt_tokens_median": median([(r.get("usage") or {}).get("prompt_tokens")
                                            for r in crows if r.get("usage")]),
            "prompt_tokens_min": min([(r.get("usage") or {}).get("prompt_tokens", 10 ** 9)
                                      for r in crows if r.get("usage")], default=None),
            "prompt_tokens_max": max([(r.get("usage") or {}).get("prompt_tokens", 0)
                                      for r in crows if r.get("usage")], default=None),
            "ttft_s_median": median([r.get("ttft_s") for r in crows]),
            "wall_s_median": median([r.get("wall_s") for r in crows]),
            "payload_mb_median": median([payload_mb(args.frames_cache, r["scale"],
                                                    r["window"], r.get("n_img") or 31)
                                         for r in crows]) if args.frames_cache else None,
            "errors": sum(1 for r in crows if r.get("error")),
        }
        cells.append(entry)

    # --- delta + McNemar between the two cells (goal windows only) ----------
    comparison = {}
    verdict = {}
    if len(cells) == 2:
        ctrl = next(c for c in cells if "ctrl" in c["cell"])
        match = next(c for c in cells if "ctrl" not in c["cell"])
        comp = {}
        for mode in ("raw", "guard"):
            kc, nc = ctrl[mode]["tp"], ctrl[mode]["tp"] + ctrl[mode]["fp"]
            km, nm = match[mode]["tp"], match[mode]["tp"] + match[mode]["fp"]
            gc, gm = ctrl[mode]["tp"], match[mode]["tp"]
            ngoals = ctrl[mode]["goals"]
            comp[mode] = {
                "precision_ctrl": round(kc / nc, 4) if nc else None,
                "precision_match": round(km / nm, 4) if nm else None,
                "precision_delta": round((km / nm if nm else 0) - (kc / nc if nc else 0), 4),
                "precision_delta_ci95": newcombe(km, nm, kc, nc),
                "recall_ctrl": round(gc / ngoals, 4) if ngoals else None,
                "recall_match": round(gm / ngoals, 4) if ngoals else None,
                "recall_delta": round((gm - gc) / ngoals, 4) if ngoals else None,
                "recall_delta_ci95": newcombe(gm, ngoals, gc, ngoals),
            }
        # exact McNemar over discordant GOAL windows (control vs match), per mode
        per_mode = {}
        for mode, guarded in (("raw", False), ("guard", True)):
            got_c = {r["window"] for r in by_cell[ctrl["cell"]]
                     if truth[r["window"]]["cls"] == "goal" and pred(r, guarded) == GOAL}
            got_m = {r["window"] for r in by_cell[match["cell"]]
                     if truth[r["window"]]["cls"] == "goal" and pred(r, guarded) == GOAL}
            lost, gained = got_c - got_m, got_m - got_c
            per_mode[mode] = {
                "lost_by_match": sorted(lost), "gained_by_match": sorted(gained),
                "discordant": {"lost": len(lost), "gained": len(gained)},
                "mcnemar_exact_p": mcnemar_exact(len(lost), len(gained)),
            }
        comparison = {
            "control_cell": ctrl["cell"], "match_cell": match["cell"],
            "lost_by_match": per_mode["guard"]["lost_by_match"],
            "gained_by_match": per_mode["guard"]["gained_by_match"],
            "discordant": per_mode["guard"]["discordant"],
            "mcnemar_exact_p": per_mode["guard"]["mcnemar_exact_p"],
            "per_mode": per_mode,
            "delta": comp,
            "power": {
                "n_goal_windows": ctrl["raw"]["goals"],
                "discordance_8343": 0.2667,
                "power_at_observed_n": mcnemar_power(ctrl["raw"]["goals"], 0.2667),
                "power_at_60": mcnemar_power(60, 0.2667),
                "n_needed_for_80pct": next((n for n in range(20, 400)
                                            if mcnemar_power(n, 0.2667) >= 0.8), None),
            },
        }
        # AC6: PASS only if no control TP is lost AND precision >= control AND
        # recall >= control, evaluated per mode.
        for mode in ("raw", "guard"):
            d = comp[mode]
            lost = per_mode[mode]["lost_by_match"]
            verdict[mode] = {
                "control_tp_lost": lost,
                "no_control_tp_lost": not lost,
                "precision_ge_control": (d["precision_match"] is not None
                                         and d["precision_ctrl"] is not None
                                         and d["precision_match"] >= d["precision_ctrl"]),
                "recall_ge_control": (d["recall_match"] is not None
                                      and d["recall_ctrl"] is not None
                                      and d["recall_match"] >= d["recall_ctrl"]),
                "mcnemar_exact_p": per_mode[mode]["mcnemar_exact_p"],
            }
            verdict[mode]["pass_ac6"] = bool(
                verdict[mode]["precision_ge_control"] and verdict[mode]["recall_ge_control"]
                and verdict[mode]["no_control_tp_lost"])
        verdict["goal_window_count_ge_40"] = ctrl["raw"]["goals"] >= 40
        verdict["adopted_lever"] = "PASS only per AC6; anything else FAIL and the lever is closed"

    guard = guard_identity()
    out = {"cells": cells, "comparison": comparison, "verdict": verdict, "guard": guard,
           "event_type_used": EVENT_TYPE,
           "manifest": {"path": os.path.basename(args.manifest),
                        "sha256": __import__("hashlib").sha256(
                            open(args.manifest, "rb").read()).hexdigest(),
                        "windows": len(manifest["windows"])},
           "rows": {"file": os.path.basename(args.rows), "used": len(rows),
                    "total": sum(1 for _ in open(args.rows))},
           "register": {}
           }

    # --- register discipline: HUD-free summary of the guard's own tally -----
    tally = Counter()
    for r in rows:
        s = r["s"]
        if s.get("_unparsed"):
            tally["unparsed"] += 1
            continue
        tally[f"guard:{s.get('guard_outcome')}"] += 1
        tally[f"attest_ok:{s.get('attest_ok')}"] += 1
    out["register"] = dict(tally)

    for c in cells:
        print(f"\n== {c['cell']}  ({c['rail']} {c['budget']} tok/img @ {c['scale']}, "
              f"{c['windows']} windows, {c['n_img']} images)")
        for mode in ("raw", "guard"):
            m = c[mode]
            print(f"   [{mode}] precision {m['precision']} {m['precision_ci95']}  "
                  f"recall {m['recall']} {m['recall_ci95']}  "
                  f"TP {m['tp']} FP {m['fp']} FN {m['fn']} TN {m['tn']}")
            print(f"          confusion {m['confusion']}")
            if m["fp_ids"]:
                print("          FP " + ", ".join(f"{x['window']}({x['truth']})"
                                                  for x in m["fp_ids"]))
            if m["fn_ids"]:
                print("          FN " + ", ".join(x["window"] for x in m["fn_ids"]))
        lat = c["latency"]
        print(f"   latency pt={lat['prompt_tokens_median']} "
              f"({lat['prompt_tokens_min']}-{lat['prompt_tokens_max']}) "
              f"ttft={lat['ttft_s_median']}s wall={lat['wall_s_median']}s "
              f"payload={lat['payload_mb_median']}MB errors={lat['errors']}")
    if comparison:
        print(f"\n== comparison: {comparison['match_cell']} vs {comparison['control_cell']}")
        print(f"   lost_by_match {comparison['lost_by_match']}")
        print(f"   gained_by_match {comparison['gained_by_match']}")
        print(f"   McNemar exact p {comparison['mcnemar_exact_p']} "
              f"(discordant {comparison['discordant']})")
        for mode, d in comparison["delta"].items():
            print(f"   [{mode}] precision {d['precision_ctrl']} -> {d['precision_match']} "
                  f"(delta {d['precision_delta']} {d['precision_delta_ci95']})  "
                  f"recall {d['recall_ctrl']} -> {d['recall_match']} "
                  f"(delta {d['recall_delta']} {d['recall_delta_ci95']})")
        pw = comparison["power"]
        print(f"   power at N={pw['n_goal_windows']} (discordance "
              f"{pw['discordance_8343']}) = {pw['power_at_observed_n']}; "
              f"80% needs N={pw['n_needed_for_80pct']}")
        print(f"   verdict {json.dumps(verdict)}")
    print("\n== guard build")
    print(f"   {json.dumps(guard)}")
    print(f"   register {json.dumps(out['register'])}")
    if args.json:
        json.dump(out, open(args.json, "w"), indent=1)
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()

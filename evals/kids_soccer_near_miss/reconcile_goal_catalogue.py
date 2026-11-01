#!/usr/bin/env python3
"""Reconcile the objective goal-candidate layers against the labelled manifest.

The eval's recall is only pipeline recall if the ground-truth goal catalogue is
exhaustive. Three layers can produce or corroborate a goal instant, and this
script lines them up so a reviewer can see which seconds are covered:

  * ``--scoreboard`` — ``detect_scoreboard_changes.py`` output (score-digit box
    diff). A candidate here is *not* a goal: a broadcast cut re-renders the
    overlay and moves the digits too.
  * ``--scan`` — the 1 s goalmouth read layer
    (``results/goalmouth_scan_1s.jsonl``). ``ball_in_net``/``celebration``
    seconds are hint evidence for a goal; the layer is audited separately by
    ``audit_frame_reads.py`` and is not ground truth on its own.
  * ``--manifest`` — the frame-labelled ground truth that is actually scored.

Output: for every scoreboard candidate, the scan class around it and the nearest
labelled goal; for every scan ``ball_in_net`` second, the labelled goal that
covers it or a flag that the video shows a goal the manifest does not label.
Pure stdlib.

Usage
-----
  python3 reconcile_goal_catalogue.py \
      --manifest label-manifest.json \
      --scoreboard results/scoreboard_candidates_whole_video.json \
      --scan results/goalmouth_scan_1s.jsonl \
      --json results/goal_catalogue_reconciliation.json
"""
import argparse
import json
import re

ACTION_RE = re.compile(r"ACTION\s*=\s*([a-z_]+)", re.IGNORECASE)
GOAL_SCAN_CLASSES = {"ball_in_net", "celebration"}


def load_json(path):
    with open(path) as fh:
        return json.load(fh)


def load_scan(path):
    out = {}
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        m = ACTION_RE.search(rec.get("read") or "")
        out[int(rec["t"])] = m.group(1).lower() if m else "unknown"
    return out


def nearest(goals, t):
    if not goals:
        return None
    best = min(goals, key=lambda g: abs(g["instant"] - t))
    return {"id": best["id"], "instant": best["instant"], "delta_s": best["instant"] - t}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--scoreboard", required=True)
    ap.add_argument("--scan", required=True)
    ap.add_argument("--goal-tolerance", type=float, default=10.0,
                    help="seconds within which a card/goal instant is the same goal")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    manifest = load_json(args.manifest)
    goals = [w for w in manifest.get("windows", []) if w.get("ground_truth") == "goal"]
    scan = load_scan(args.scan)
    cands = load_json(args.scoreboard)
    if isinstance(cands, dict):
        cands = cands.get("candidates", [])

    rows = []
    for c in cands:
        t0 = int(c.get("t0", c.get("t", 0)))
        t1 = int(c.get("t1", t0))
        near = nearest(goals, t0)
        window = [scan.get(t) for t in range(t0 - 2, t1 + 3) if scan.get(t)]
        covered = near is not None and abs(near["instant"] - t0) <= args.goal_tolerance
        rows.append({
            "t0": t0,
            "t1": t1,
            "score_maxdiff": c.get("maxdiff"),
            "scan_around": window,
            "scan_has_goal_class": any(a in GOAL_SCAN_CLASSES for a in window),
            "nearest_goal": near,
            "verdict": "goal_already_labelled" if covered else "candidate_needs_frame_confirm",
        })

    scanned = set(scan)
    max_t = max(scanned) if scanned else 0
    gaps = []
    start = None
    for t in range(0, 777):
        if t not in scanned:
            if start is None:
                start = t
        elif start is not None:
            gaps.append({"from": start, "to": t - 1})
            start = None
    if start is not None:
        gaps.append({"from": start, "to": 776})
    uncovered = []
    for t, a in sorted(scan.items()):
        if a not in GOAL_SCAN_CLASSES:
            continue
        near = nearest(goals, t)
        if near is None or abs(near["instant"] - t) > args.goal_tolerance:
            # celebations/ball-in-net that no labelled goal covers
            uncovered.append({"t": t, "scan_class": a, "nearest_goal": near})

    result = {
        "goals_labelled": len(goals),
        "goal_instants": sorted(g["instant"] for g in goals),
        "scan_seconds_covered": len(scanned),
        "scan_max_second": max_t,
        "scan_gap": gaps,
        "scoreboard_candidates": rows,
        "scan_goal_class_not_labelled": uncovered,
        "counts": {
            "scoreboard_candidates": len(rows),
            "scoreboard_candidates_on_labelled_goal": sum(
                1 for r in rows if r["verdict"] == "goal_already_labelled"),
            "scoreboard_candidates_unconfirmed": sum(
                1 for r in rows if r["verdict"] != "goal_already_labelled"),
            "scan_goal_class_seconds": sum(1 for a in scan.values() if a in GOAL_SCAN_CLASSES),
            "scan_goal_class_not_labelled": len(uncovered),
        },
    }

    print("labelled goals            : %d" % result["goals_labelled"])
    print("scan coverage             : %d s (max t=%d)" % (len(scanned), max_t))
    print("scoreboard candidates     : %d (%d sit on a labelled goal, %d need a frame pass)"
          % (result["counts"]["scoreboard_candidates"],
             result["counts"]["scoreboard_candidates_on_labelled_goal"],
             result["counts"]["scoreboard_candidates_unconfirmed"]))
    print("scan goal-class seconds   : %d, %d NOT covered by a labelled goal"
          % (result["counts"]["scan_goal_class_seconds"],
             result["counts"]["scan_goal_class_not_labelled"]))
    for u in uncovered:
        print("  uncovered scan goal class: t=%d %s nearest=%s"
              % (u["t"], u["scan_class"], u["nearest_goal"]))
    for r in rows:
        if r["verdict"] != "goal_already_labelled":
            print("  candidate t=%d-%d diff=%s scan=%s nearest=%s"
                  % (r["t0"], r["t1"], r["score_maxdiff"], r["scan_around"],
                     (r["nearest_goal"] or {}).get("instant")))
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(result, fh, indent=1)
        print("wrote %s" % args.json)


if __name__ == "__main__":
    main()

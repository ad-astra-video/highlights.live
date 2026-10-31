#!/usr/bin/env python3
"""Score the accepted-GOAL path against the kids_soccer near-miss eval set.

Reads a labelled manifest (frame-derived ground truth) plus a highlights.live
job-detail JSON (``GET /jobs/{id}/detail``) and reports, for the accepted-GOAL
path of one build:

  accepted   - accepted GOAL windows the pipeline surfaced (cards)
  goals      - ground-truth goal windows in the manifest's covered scope
  precision  - accepted windows that match a ground-truth goal / accepted windows
  recall     - ground-truth goals matched by an accepted window / ground-truth goals
  FPs        - accepted windows that match no ground-truth goal, with t + reason
  FNs        - ground-truth goals no accepted window covers
  duplicates - extra accepted windows covering an already-credited goal
  self_refuting - accepted windows whose own reason text claims the shot did NOT
                  enter the net (the old ADAAAA-7477 self-consistency metric)

Pure stdlib. Matching rule: an accepted card credits a goal window when the two
intervals overlap by at least ``--min-overlap`` seconds (default 1.0) OR the
card's ``localizedTs`` sits within ``--instant-tolerance`` seconds (default 10,
about the clip's before+after) of the window's ``instant``. The second arm keeps
a card that surfaces a goal's celebration/replay from being scored as a false
positive. A goal is credited at most once for recall; every extra accepted card
on it is reported as a duplicate (still a true positive for precision, since the
card does show a goal).

Examples
--------
  # numbers for the deployed fix (AC-2)
  python3 evals/kids_soccer_near_miss/score_goal_precision.py \
      --manifest evals/kids_soccer_near_miss/label-manifest.json \
      --job-detail /tmp/job_da2d21a.json --commit da2d21a --json out.json

  # regression gate: fail when precision drops below a recorded baseline
  python3 evals/kids_soccer_near_miss/score_goal_precision.py ... \
      --fail-under-precision 0.90
"""
import argparse
import json
import re
import sys

SELF_REFUTE = re.compile(
    r"(does not enter the net|not in the net|no net bulge|near[_ ]miss|"
    r"off[ -]target|does not cross the goal line|saved by the goalkeeper)",
    re.IGNORECASE,
)


def goal_windows(manifest):
    """Ground-truth goal windows from the manifest."""
    return [w for w in manifest.get("windows", []) if w.get("ground_truth") == "goal"]


def accepted_windows(detail):
    """Accepted GOAL cards from a job detail payload, normalised."""
    out = []
    for h in detail.get("highlights", []):
        if h.get("status") != "accepted":
            continue
        if (h.get("eventType") or "").upper() != "GOAL":
            continue
        out.append({
            "t": float(h.get("localizedTs", (h["start"] + h["end"]) / 2)),
            "start": float(h["start"]),
            "end": float(h["end"]),
            "reason": (h.get("reason") or "").strip(),
            "id": h.get("id"),
        })
    out.sort(key=lambda w: w["t"])
    return out


def overlap(a_start, a_end, b_start, b_end):
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def score(manifest, detail, min_overlap=1.0, instant_tolerance=10.0):
    goals = goal_windows(manifest)
    accepted = accepted_windows(detail)

    credited = {}       # goal window id -> list of accepted card t
    true_positives = []
    false_positives = []
    for card in accepted:
        match = None
        for gw in goals:
            ov = overlap(card["start"], card["end"],
                         float(gw["t_start"]), float(gw["t_end"]))
            near = (gw.get("instant") is not None
                    and abs(card["t"] - float(gw["instant"])) <= instant_tolerance)
            if ov >= min_overlap or near:
                match = gw
                break
        if match is None:
            false_positives.append(card)
        else:
            true_positives.append(card)
            credited.setdefault(match["id"], []).append(card["t"])

    missed = [gw for gw in goals if gw["id"] not in credited]
    duplicates = [
        {"goal": gw["id"], "cards": ts[1:]}
        for gw, ts in ((gw, credited.get(gw["id"], [])) for gw in goals)
        if len(ts) > 1
    ]
    self_refuting = [c for c in accepted if SELF_REFUTE.search(c["reason"])]

    n_acc = len(accepted)
    n_goals = len(goals)
    return {
        "accepted": n_acc,
        "ground_truth_goals": n_goals,
        "true_positive_cards": len(true_positives),
        "precision": round(len(true_positives) / n_acc, 4) if n_acc else None,
        "recall": round(len(credited) / n_goals, 4) if n_goals else None,
        "false_positives": [
            {"t": round(c["t"], 1), "window": [round(c["start"], 1), round(c["end"], 1)],
             "reason": c["reason"]}
            for c in false_positives
        ],
        "false_negatives": [
            {"id": gw["id"], "window": [gw["t_start"], gw["t_end"]],
             "evidence": gw.get("evidence"), "frames": gw.get("frames")}
            for gw in missed
        ],
        "duplicate_cards": duplicates,
        "self_refuting": [
            {"t": round(c["t"], 1), "reason": c["reason"]} for c in self_refuting
        ],
    }


def render(result, commit, job_id, manifest_path):
    p = result["precision"]
    r = result["recall"]
    lines = [
        f"# goal-acceptance precision — {commit or 'unlabelled build'}",
        f"job: {job_id}",
        f"manifest: {manifest_path}",
        "",
        f"accepted GOAL windows : {result['accepted']}",
        f"ground-truth goals    : {result['ground_truth_goals']}",
        f"true-positive cards   : {result['true_positive_cards']}",
        f"precision             : {p:.2%}" if p is not None else "precision             : n/a",
        f"recall                : {r:.2%}" if r is not None else "recall                : n/a",
        f"self-refuting accepted: {len(result['self_refuting'])} (old ADAAAA-7477 metric)",
        f"duplicate cards       : {sum(len(d['cards']) for d in result['duplicate_cards'])}",
        "",
        "## false positives",
    ]
    if result["false_positives"]:
        for fp in result["false_positives"]:
            lines.append(f"- t={fp['t']}s window={fp['window']} — {fp['reason']}")
    else:
        lines.append("- none")
    lines += ["", "## missed goals (false negatives)"]
    if result["false_negatives"]:
        for fn in result["false_negatives"]:
            lines.append(f"- {fn['id']} t={fn['window']} evidence={fn['evidence']} "
                         f"({fn['frames']})")
    else:
        lines.append("- none")
    lines += ["", "## self-refuting accepted cards"]
    if result["self_refuting"]:
        for s in result["self_refuting"]:
            lines.append(f"- t={s['t']}s — {s['reason'][:180]}")
    else:
        lines.append("- none")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Score the accepted-GOAL path against a labelled eval set.")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--job-detail", required=True,
                    help="job detail JSON from GET /jobs/{id}/detail")
    ap.add_argument("--commit", default=None, help="build label, e.g. da2d21a")
    ap.add_argument("--min-overlap", type=float, default=1.0)
    ap.add_argument("--instant-tolerance", type=float, default=10.0,
                    help="seconds a card's localizedTs may sit from a goal "
                         "instant and still credit that goal (default 10, "
                         "roughly the clip window before+after)")
    ap.add_argument("--json", default=None, help="also write the result JSON here")
    ap.add_argument("--fail-under-precision", type=float, default=None,
                    help="exit 1 when measured precision is below this value")
    args = ap.parse_args(argv)

    manifest = json.load(open(args.manifest))
    detail = json.load(open(args.job_detail))
    job_id = (detail.get("job") or {}).get("id", "unknown")

    result = score(manifest, detail, args.min_overlap, args.instant_tolerance)
    result.update({"commit": args.commit, "job_id": job_id,
                   "manifest": args.manifest})
    print(render(result, args.commit, job_id, args.manifest))
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(result, fh, indent=2)
            fh.write("\n")
    if args.fail_under_precision is not None:
        if result["precision"] is None or result["precision"] < args.fail_under_precision:
            print(f"\nFAIL: precision {result['precision']} < "
                  f"{args.fail_under_precision}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

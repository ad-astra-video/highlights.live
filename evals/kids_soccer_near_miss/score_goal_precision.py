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

  # corpus mode: score N clips in one invocation and pool them (ADAAAA-7692)
  python3 evals/kids_soccer_near_miss/score_goal_precision.py \
      --pair evals/kids_soccer_near_miss/label-manifest.json:/tmp/detail_a.json:da2d21a \
      --pair evals/kids_soccer_near_miss/clip_b/manifest.json:/tmp/detail_b.json:clip-b \
      --fail-under-precision 0.78 --json evals/kids_soccer_near_miss/results/score_corpus.json

Corpus pooling rule (NOT the mean of per-clip ratios)
-----------------------------------------------------
  pooled precision = sum(TP cards) / (sum(TP cards) + sum(FP cards))
  pooled recall    = sum(credited goals) / sum(labelled goals)

Averaging two percentages over-weights a clip with a small accept set and hides
corpus variance: 2/2 on one clip and 4/8 on another is 60 % corpus precision,
not 75 %. ``--fail-under-precision`` gates the pooled figure; add
``--fail-under-clip-precision`` to also floor every clip individually.

Hard-negative metric: a *verified shot-class non-goal window* is a labelled
no-goal window whose frames show a shot at goal (evidence ``saved``, ``post``,
``blocked`` or ``wide``). Windows labelled ``evidence: none`` rule out a goal but
do not assert a shot, so they are not counted. The corpus row reports the sum
across clips (ADAAAA-7690's headline metric).
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

# Evidence values that assert a shot at goal (see the module docstring).
SHOT_CLASS_EVIDENCE = ("saved", "post", "blocked", "wide")

POOLING_RULE = (
    "precision = sum(TP cards) / (sum(TP cards) + sum(FP cards)); "
    "recall = sum(credited goals) / sum(labelled goals)"
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


def hard_negatives(manifest):
    """Verified shot-class non-goal windows in one manifest.

    A hard negative is a labelled no-goal window whose frames show a shot at
    goal (``SHOT_CLASS_EVIDENCE``), i.e. exactly the class the accept path has
    to reject. ``evidence: none`` windows are not counted: they rule out a goal
    but do not assert a shot.
    """
    windows = manifest.get("windows", [])
    hits = [
        w for w in windows
        if w.get("ground_truth") != "goal"
        and (w.get("evidence") or "").strip().lower() in SHOT_CLASS_EVIDENCE
    ]
    declared = (manifest.get("coverage") or {}).get("non_goal_shot_class")
    return {
        "count": len(hits),
        "window_ids": [w.get("id") for w in hits],
        # the manifest's own coverage figure, when it declares one
        "declared": declared,
        "declared_matches": None if declared is None else declared == len(hits),
    }


def clip_row(manifest, detail, label=None, commit=None, manifest_path=None,
             min_overlap=1.0, instant_tolerance=10.0):
    """Per-clip row for corpus mode: the single-clip score plus hard negatives."""
    r = score(manifest, detail, min_overlap, instant_tolerance)
    hn = hard_negatives(manifest)
    credited = r["ground_truth_goals"] - len(r["false_negatives"])
    return {
        "label": label or (manifest.get("video") or {}).get("id") or manifest_path,
        "commit": commit,
        "job_id": (detail.get("job") or {}).get("id", "unknown"),
        "manifest": manifest_path,
        "accepted": r["accepted"],
        "true_positive_cards": r["true_positive_cards"],
        "false_positive_cards": len(r["false_positives"]),
        "ground_truth_goals": r["ground_truth_goals"],
        "credited_goals": credited,
        "precision": r["precision"],
        "recall": r["recall"],
        "hard_negatives": hn["count"],
        "hard_negative_window_ids": hn["window_ids"],
        "hard_negatives_declared": hn["declared"],
        "hard_negatives_declared_matches": hn["declared_matches"],
        "duplicate_cards": r["duplicate_cards"],
        "self_refuting_count": len(r["self_refuting"]),
        "false_positives": r["false_positives"],
        "false_negatives": r["false_negatives"],
    }


def pool(rows):
    """Pool per-clip rows into one corpus row.

    Weighted ratios, never the mean of the per-clip ratios: each card and each
    labelled goal counts once in the corpus, so a clip with 2 cards cannot
    out-vote a clip with 8. ``mean_clip_precision_rejected`` carries the naive
    average purely so a reader can see how far it is from the pooled figure; it
    is never a gate input.
    """
    tp = sum(r["true_positive_cards"] for r in rows)
    fp = sum(r["false_positive_cards"] for r in rows)
    accepted = tp + fp
    credited = sum(r["credited_goals"] for r in rows)
    goals = sum(r["ground_truth_goals"] for r in rows)
    precisions = [r["precision"] for r in rows if r["precision"] is not None]
    return {
        "clips": len(rows),
        "accepted": accepted,
        "true_positive_cards": tp,
        "false_positive_cards": fp,
        "ground_truth_goals": goals,
        "credited_goals": credited,
        "precision": round(tp / accepted, 4) if accepted else None,
        "recall": round(credited / goals, 4) if goals else None,
        "hard_negatives": sum(r["hard_negatives"] for r in rows),
        "pooling_rule": POOLING_RULE,
        "mean_clip_precision_rejected": (
            round(sum(precisions) / len(precisions), 4) if precisions else None
        ),
        "min_clip_precision": min(precisions) if precisions else None,
    }


def score_corpus(clip_specs, min_overlap=1.0, instant_tolerance=10.0):
    """Score N ``(manifest, job detail)`` pairs and pool them.

    ``clip_specs`` items are ``{"manifest": path, "job_detail": path,
    "commit": str|None, "label": str|None}``. Returns
    ``{"mode": "corpus", "pooling_rule", "clips": [...rows], "corpus": {...}}``.
    """
    rows = []
    for spec in clip_specs:
        manifest = json.load(open(spec["manifest"]))
        detail = json.load(open(spec["job_detail"]))
        rows.append(clip_row(
            manifest, detail,
            label=spec.get("label"), commit=spec.get("commit"),
            manifest_path=spec["manifest"],
            min_overlap=min_overlap, instant_tolerance=instant_tolerance,
        ))
    return {
        "mode": "corpus",
        "pooling_rule": POOLING_RULE,
        "clips": rows,
        "corpus": pool(rows),
    }


def render_corpus(corpus, commit=None):
    p = corpus["corpus"]["precision"]
    r = corpus["corpus"]["recall"]
    lines = [
        f"# goal-acceptance precision — corpus ({corpus['corpus']['clips']} clip(s))"
        + (f" — {commit}" if commit else ""),
        f"pooling rule: {corpus['pooling_rule']}",
        "",
        f"{'clip':<24} {'job':<12} {'cards':>5} {'TP':>3} {'FP':>3} "
        f"{'precision':>9} {'recall':>7} {'hardneg':>7}",
    ]
    for row in corpus["clips"]:
        prec = f"{row['precision']:.2%}" if row["precision"] is not None else "n/a"
        rec = f"{row['recall']:.2%}" if row["recall"] is not None else "n/a"
        lines.append(
            f"{str(row['label'])[:24]:<24} {str(row['job_id'])[:12]:<12} "
            f"{row['accepted']:>5} {row['true_positive_cards']:>3} "
            f"{row['false_positive_cards']:>3} {prec:>9} {rec:>7} "
            f"{row['hard_negatives']:>7}"
        )
    lines += [
        "",
        f"POOLED precision      : {p:.2%}" if p is not None else "POOLED precision      : n/a",
        f"POOLED recall         : {r:.2%}" if r is not None else "POOLED recall         : n/a",
        f"pooled cards          : {corpus['corpus']['true_positive_cards']} TP / "
        f"{corpus['corpus']['false_positive_cards']} FP "
        f"({corpus['corpus']['accepted']} accepted)",
        f"labelled goals        : {corpus['corpus']['ground_truth_goals']} "
        f"({corpus['corpus']['credited_goals']} credited)",
        f"corpus hard negatives : {corpus['corpus']['hard_negatives']} "
        "verified shot-class non-goal windows",
    ]
    mean = corpus["corpus"]["mean_clip_precision_rejected"]
    if mean is not None and corpus["corpus"]["clips"] > 1:
        lines.append(
            f"naive clip-average    : {mean:.2%} (reported for contrast only — "
            "the gate uses the pooled figure)"
        )
    lines += ["", "## per-clip detail"]
    for row in corpus["clips"]:
        lines += ["", f"### {row['label']} ({row['commit'] or 'unlabelled build'})"]
        lines.append(f"- accepted {row['accepted']}, TP {row['true_positive_cards']}, "
                     f"FP {row['false_positive_cards']}, goals "
                     f"{row['ground_truth_goals']}, hard negatives {row['hard_negatives']}")
        for fp in row["false_positives"]:
            lines.append(f"- FP t={fp['t']}s window={fp['window']} — {fp['reason'][:180]}")
        for fn in row["false_negatives"]:
            lines.append(f"- missed {fn['id']} t={fn['window']} evidence={fn['evidence']}")
        mismatch = [row["hard_negatives_declared"], row["hard_negatives_declared_matches"]]
        if mismatch[0] is not None and mismatch[1] is False:
            lines.append(f"- WARNING: manifest coverage declares non_goal_shot_class="
                         f"{mismatch[0]} but {row['hard_negatives']} windows are shot-class")
    return "\n".join(lines)


def parse_pair_spec(spec):
    """``MANIFEST:JOB_DETAIL[:COMMIT]`` -> clip spec dict."""
    parts = spec.split(":")
    if len(parts) not in (2, 3):
        raise ValueError(
            f"--pair expects MANIFEST:JOB_DETAIL[:COMMIT], got {spec!r}")
    return {
        "manifest": parts[0],
        "job_detail": parts[1],
        "commit": parts[2] if len(parts) == 3 else None,
        "label": None,
    }


def load_corpus_specs(path):
    """Read a corpus file: a list of clips, or ``{"clips": [...]}``."""
    data = json.load(open(path))
    clips = data.get("clips") if isinstance(data, dict) else data
    if not isinstance(clips, list) or not clips:
        raise ValueError(f"{path}: expected a non-empty clip list")
    out = []
    for clip in clips:
        if "manifest" not in clip or "job_detail" not in clip:
            raise ValueError(
                f"{path}: every clip needs 'manifest' and 'job_detail', got {clip!r}")
        out.append({
            "manifest": clip["manifest"],
            "job_detail": clip["job_detail"],
            "commit": clip.get("commit"),
            "label": clip.get("label"),
        })
    return out


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
        description="Score the accepted-GOAL path against a labelled eval set "
                    "(single clip, or --corpus/--pair for a pooled corpus figure).")
    ap.add_argument("--manifest", default=None,
                    help="single-clip mode: labelled manifest JSON")
    ap.add_argument("--job-detail", default=None,
                    help="single-clip mode: job detail JSON from GET /jobs/{id}/detail")
    ap.add_argument("--pair", action="append", default=[], metavar="MANIFEST:DETAIL[:COMMIT]",
                    help="corpus mode: one (manifest, job detail) pair; repeat per clip")
    ap.add_argument("--corpus", default=None,
                    help="corpus mode: JSON file holding a list of "
                         "{manifest, job_detail, commit, label} clips")
    ap.add_argument("--commit", default=None, help="build label, e.g. da2d21a")
    ap.add_argument("--min-overlap", type=float, default=1.0)
    ap.add_argument("--instant-tolerance", type=float, default=10.0,
                    help="seconds a card's localizedTs may sit from a goal "
                         "instant and still credit that goal (default 10, "
                         "roughly the clip window before+after)")
    ap.add_argument("--json", default=None, help="also write the result JSON here")
    ap.add_argument("--fail-under-precision", type=float, default=None,
                    help="exit 1 when measured precision is below this value "
                         "(the pooled figure in corpus mode)")
    ap.add_argument("--fail-under-clip-precision", type=float, default=None,
                    help="corpus mode only: exit 1 when ANY single clip's "
                         "precision is below this floor")
    args = ap.parse_args(argv)

    specs = []
    if args.corpus:
        specs.extend(load_corpus_specs(args.corpus))
    specs.extend(parse_pair_spec(p) for p in args.pair)

    if specs:
        if args.manifest or args.job_detail:
            ap.error("use --manifest/--job-detail (single clip) OR "
                     "--corpus/--pair (corpus mode), not both")
        return run_corpus(args, specs)

    if not args.manifest or not args.job_detail:
        ap.error("--manifest and --job-detail are required for single-clip scoring")

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


def run_corpus(args, specs):
    corpus = score_corpus(specs, args.min_overlap, args.instant_tolerance)
    print(render_corpus(corpus, args.commit))
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(corpus, fh, indent=2)
            fh.write("\n")
    failed = False
    pooled = corpus["corpus"]["precision"]
    if args.fail_under_precision is not None:
        if pooled is None or pooled < args.fail_under_precision:
            print(f"\nFAIL: pooled precision {pooled} < "
                  f"{args.fail_under_precision}", file=sys.stderr)
            failed = True
    if args.fail_under_clip_precision is not None:
        for row in corpus["clips"]:
            if row["precision"] is None or row["precision"] < args.fail_under_clip_precision:
                print(f"\nFAIL: clip {row['label']} precision {row['precision']} < "
                      f"{args.fail_under_clip_precision}", file=sys.stderr)
                failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

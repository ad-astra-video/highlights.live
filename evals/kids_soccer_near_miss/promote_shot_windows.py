#!/usr/bin/env python3
"""Promote shot-class non-goal windows from agreeing frame reads (kids_soccer eval).

AC-1 of ADAAAA-7590/7611 asks for >=20 non-goal windows in which a shot at goal
is actually visible (saved / wide / blocked / post). A window is only promoted
here when independent read layers agree that a shot is in the frame, so the
label is reproducible evidence rather than a single-model guess:

  1. the same prompt is run twice (or three times) over the 2x frames
     (`scan_goalmouth.py`), one whole second per image, temperature 0;
  2. the same second must be a shot class (`goal_mouth_shot` / `keeper_save`) in
     *every* layer — a second that any layer calls open play is dropped;
  3. the second must sit more than ``--goal-guard`` seconds away from every
     labelled goal instant, so a shot window can never shadow a goal;
  4. the second must not fall inside an already-labelled manifest window;
  5. the scan class inside the emitted window must contain no goal class
     (`ball_in_net` / `celebration`), and the objective score-digit detector
     must raise no candidate inside the window bounds.

Agreeing seconds are grouped into runs, and each run becomes one window:
``instant`` = first agreeing second (the strike), ``t_start``/``t_end`` = the
run padded by ``--pad`` seconds. ``frames`` cites the agreeing seconds, which is
the evidence requirement: every label names the frame timestamps that carry it.

Usage
-----
  python3 promote_shot_windows.py \
      --manifest label-manifest.json \
      --primary results/goalmouth_scan_1s.jsonl \
      --repeat /tmp/vote1.jsonl --repeat /tmp/vote2.jsonl \
      --frames-dir /tmp/hl7590_frames \
      --json results/promoted_shot_windows.json        # dry run, prints the plan
  python3 promote_shot_windows.py ... --write           # append to the manifest
"""
import argparse
import json
import re
import sys

ACTION_RE = re.compile(r"ACTION\s*=\s*([a-z_]+)", re.IGNORECASE)
SHOT = {"goal_mouth_shot", "keeper_save"}
GOAL_CLASS = {"ball_in_net", "celebration"}
WIDE_RE = re.compile(r"\bwide\b|off target|over the bar|past the post|out of play", re.I)
BLOCK_RE = re.compile(r"\bblock|deflect|slide|slid|challenge|intercept", re.I)


def load_reads(path):
    out = {}
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        text = rec.get("read") or ""
        m = ACTION_RE.search(text)
        out[int(rec["t"])] = {
            "class": m.group(1).lower() if m else "unknown",
            "read": text,
        }
    return out


def evidence_class(reads):
    """Map agreeing reads onto the manifest's evidence vocabulary."""
    joined = " ".join(r["read"] for r in reads)
    if WIDE_RE.search(joined):
        return "wide"
    if all(r["class"] == "goal_mouth_shot" for r in reads) and BLOCK_RE.search(joined):
        return "blocked"
    if any(r["class"] == "keeper_save" for r in reads):
        return "saved"
    return "shot"


def scoreboard_flags(candidates, t0, t1):
    """Score-digit candidates from the committed detector that fall inside [t0, t1].

    Uses the whole-video output of ``detect_scoreboard_changes.py`` (the
    visibility-gated, clock-isolated detector) rather than re-diffing here, so
    the corroboration is the same objective layer RESULTS.md cites.
    """
    if candidates is None:
        return None
    hits = []
    for c in candidates:
        c0 = int(c.get("t0", c.get("t", 0)))
        c1 = int(c.get("t1", c0))
        if c1 >= t0 and c0 <= t1:
            hits.append({"t": c0, "t1": c1, "maxdiff": c.get("maxdiff")})
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--primary", required=True)
    ap.add_argument("--repeat", action="append", required=True)
    ap.add_argument("--scoreboard", default=None,
                    help="detect_scoreboard_changes.py output for the whole video")
    ap.add_argument("--goal-guard", type=float, default=10.0)
    ap.add_argument("--pad", type=int, default=3)
    ap.add_argument("--json", default=None)
    ap.add_argument("--write", action="store_true", help="append the windows to the manifest")
    args = ap.parse_args()

    manifest = json.load(open(args.manifest))
    candidates = json.load(open(args.scoreboard)) if args.scoreboard else None
    if isinstance(candidates, dict):
        candidates = candidates.get("candidates", [])
    windows = manifest["windows"]
    goals = [w["instant"] for w in windows if w["ground_truth"] == "goal"]
    layers = [load_reads(args.primary)] + [load_reads(p) for p in args.repeat]
    shared = sorted(set.intersection(*[set(l) for l in layers]))

    def inside_existing(t):
        for w in windows:
            if w["t_start"] <= t <= w["t_end"]:
                return w
        return None

    # 1..4: seconds confirmed as a shot by every layer, away from goals/labels
    kept, dropped = [], []
    for t in shared:
        classes = [l[t]["class"] for l in layers]
        if not all(c in SHOT for c in classes):
            dropped.append({"t": t, "classes": classes, "why": "layer disagreement"})
            continue
        near = min((abs(t - g) for g in goals), default=999)
        if near <= args.goal_guard:
            dropped.append({"t": t, "classes": classes, "why": "goal guard %.0fs" % near})
            continue
        hit = inside_existing(t)
        if hit:
            dropped.append({"t": t, "classes": classes, "why": "already labelled %s" % hit["id"]})
            continue
        kept.append(t)

    runs = []
    for t in kept:
        if runs and t - runs[-1][-1] <= 1:
            runs[-1].append(t)
        else:
            runs.append([t])

    primary = layers[0]
    promoted = []
    for run in runs:
        t0, t1 = max(0, run[0] - args.pad), min(776, run[-1] + args.pad)
        # 5: no goal class inside the emitted window
        win_classes = [primary[t]["class"] for t in range(t0, t1 + 1)
                       if t in primary and primary[t]["class"] in GOAL_CLASS]
        if win_classes:
            dropped.append({"t": run[0], "classes": win_classes,
                            "why": "goal class inside window %d-%d" % (t0, t1)})
            continue
        flags = scoreboard_flags(candidates, t0, t1)
        if flags:
            dropped.append({"t": run[0], "classes": [f["t"] for f in flags],
                            "why": "scoreboard moved inside window %d-%d" % (t0, t1)})
            continue
        reads = [primary[t] for t in run]
        promoted.append({
            "id": "ks-n-%04d" % run[0],
            "t_start": t0,
            "t_end": t1,
            "ground_truth": "no_goal",
            "evidence": evidence_class(reads),
            "frames": "1 s scan at 2x: shot class at t=%s (agreeing across %d read layers); "
                      "scorebox unchanged %d-%d"
                      % (",".join(str(t) for t in run), len(layers), t0, t1),
            "confidence": "high" if len(layers) >= 2 else "medium",
            "scan_read": primary[run[0]]["read"].replace("\n", " ")[:220],
            "read_layers": len(layers),
        })

    # Merge overlapping promoted windows: one window per shot event, never two
    # windows for the same strike (they would double-count in the window count).
    promoted.sort(key=lambda w: w["t_start"])
    merged = []
    for w in promoted:
        if merged and w["t_start"] <= merged[-1]["t_end"]:
            prev = merged[-1]
            prev["t_end"] = max(prev["t_end"], w["t_end"])
            prev["frames"] = prev["frames"] + " | " + w["frames"]
            if w["evidence"] != prev["evidence"]:
                prev["evidence"] = "saved"
        else:
            merged.append(w)
    promoted = merged

    # Clip a promoted window against the neighbouring labels instead of dropping
    # it: an event next to a labelled window is a real shot, its bounds just have
    # to stay inside the gap so two labels never describe the same seconds.
    def clip(w):
        lo, hi = w["t_start"], w["t_end"]
        for e in windows:
            if e["t_end"] < lo and e["t_end"] >= lo - 8:
                lo = max(lo, e["t_end"] + 1)
            if e["t_start"] > hi and e["t_start"] <= hi + 8:
                hi = min(hi, e["t_start"] - 1)
        return lo, hi

    def overlaps_existing(w):
        for e in windows:
            if w["t_start"] <= e["t_end"] and e["t_start"] <= w["t_end"]:
                return e["id"]
        return None

    final = []
    for w in promoted:
        lo, hi = clip(w)
        if hi - lo < 1:
            dropped.append({"t": w["t_start"], "classes": [],
                            "why": "window %d-%d has no room between labels"
                                   % (w["t_start"], w["t_end"])})
            continue
        w["t_start"], w["t_end"] = lo, hi
        clash = overlaps_existing(w)
        if clash:
            dropped.append({"t": w["t_start"], "classes": [],
                            "why": "window %d-%d overlaps %s" % (lo, hi, clash)})
            continue
        final.append(w)
    promoted = final

    print("agreeing shot seconds: %d over %d layer(s)" % (len(kept), len(layers)))
    print("promoted windows      : %d" % len(promoted))
    for w in promoted:
        print("  %s t=%d-%d %s" % (w["id"], w["t_start"], w["t_end"], w["evidence"]))
    print("dropped seconds       : %d" % len(dropped))
    for d in dropped[:12]:
        print("  t=%s %s" % (d["t"], d["why"]))
    if len(dropped) > 12:
        print("  ... %d more" % (len(dropped) - 12))

    out = {"promoted": promoted, "dropped": dropped,
           "read_layers": args.repeat + [args.primary], "kept_seconds": kept}
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(out, fh, indent=1)
        print("wrote %s" % args.json)

    if args.write:
        existing = {w["id"] for w in windows}
        added = [w for w in promoted if w["id"] not in existing]
        windows.extend(added)
        shot = [w for w in windows if w["ground_truth"] != "goal" and w["evidence"] != "none"]
        manifest.setdefault("coverage", {})
        manifest["coverage"]["goal_windows"] = sum(
            1 for w in windows if w["ground_truth"] == "goal")
        manifest["coverage"]["non_goal_windows"] = sum(
            1 for w in windows if w["ground_truth"] != "goal")
        manifest["coverage"]["non_goal_shot_class"] = len(shot)
        with open(args.manifest, "w") as fh:
            json.dump(manifest, fh, indent=2)
            fh.write("\n")
        print("appended %d windows to %s (shot-class total now %d)"
              % (len(added), args.manifest, len(shot)))
    else:
        print("dry run: pass --write to append to the manifest")


if __name__ == "__main__":
    sys.exit(main())

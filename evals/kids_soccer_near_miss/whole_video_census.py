#!/usr/bin/env python3
"""Whole-video 1 s census of shot-like seconds (ADAAAA-7611 AC-1).

The per-window prompt family could not separate shot windows from controls
(see `labeller_variants.py`), so this script takes the same two best readers and
runs them over **every** second of the clip instead of a 22-window sample, then:

- reports, for each labelled window, which seconds each reader fires on;
- clusters contiguous seconds where both readers fire into candidate moments;
- cross-checks the clusters against the 15-goal catalogue, so a hit *outside* a
  goal window can be treated as a non-goal shot candidate rather than noise, and
  a hit *inside* one confirms the census is sensitive to goalmouth action at all.

Inputs are the raw per-frame reads (`whole_reads.jsonl`, one row per
frame/variant) plus the label manifest. Output is condensed so it can be pulled
off the box in one call.

    python3 whole_video_census.py whole_reads.jsonl label-manifest.json out.json
"""
import collections
import json
import sys

V1_FIRE = {"shot_at_goal", "save"}


def fires(row):
    p = row.get("parsed") or {}
    if row["variant"] == "v1_scene":
        return p.get("SCENE") in V1_FIRE
    if row["variant"] == "v3_defined":
        return p.get("SHOT") == "yes"
    return False


def main():
    reads_path, manifest_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    rows = [json.loads(l) for l in open(reads_path)]
    manifest = json.load(open(manifest_path))
    windows = manifest["windows"]

    # per-second vote: which readers fired
    votes = collections.defaultdict(set)
    errs = collections.Counter()
    for r in rows:
        if r.get("err"):
            errs[r["variant"]] += 1
            continue
        if fires(r):
            votes[r["t"]].add(r["variant"])
    both = sorted(t for t, v in votes.items() if len(v) == 2)
    any1 = sorted(votes)

    # contiguous runs of "both readers fire"
    runs = []
    for t in both:
        if runs and t == runs[-1][1] + 1:
            runs[-1][1] = t
        else:
            runs.append([t, t])

    def window_at(t):
        for w in windows:
            if w.get("t_start") is not None and w["t_start"] <= t <= w["t_end"]:
                return w["id"]
        return None

    goals = [w for w in windows if w["ground_truth"] == "goal"]
    nongoals = [w for w in windows if w["ground_truth"] != "goal"]

    def win_hits(w):
        secs = [t for t in range(w["t_start"], w["t_end"] + 1) if t in votes]
        both_secs = [t for t in secs if len(votes[t]) == 2]
        return {"id": w["id"], "evidence": w["evidence"],
                "any_reader": secs, "both_readers": both_secs,
                "max_run_both": _maxrun(both_secs)}

    def _maxrun(secs):
        best = run = 0
        prev = None
        for t in secs:
            run = run + 1 if prev is not None and t == prev + 1 else 1
            best = max(best, run)
            prev = t
        return best

    goal_hits = [win_hits(w) for w in goals]
    nongoal_hits = [win_hits(w) for w in nongoals]

    clusters = []
    for a, b in runs:
        inside = sorted({w for w in (window_at(t) for t in range(a, b + 1)) if w})
        clusters.append({"t_start": a, "t_end": b, "len": b - a + 1,
                         "windows": inside,
                         "in_labelled_goal": any(window_at(t) in {g["id"] for g in goals}
                                                 for t in range(a, b + 1))})

    summary = {
        "readers": sorted({r["variant"] for r in rows}),
        "frames_read": len({(r["variant"], r["t"]) for r in rows}),
        "read_errors": dict(errs),
        "both_reader_seconds": len(both),
        "any_reader_seconds": len(any1),
        "clusters_both_ge2s": [c for c in clusters if c["len"] >= 2],
        "clusters_both_ge3s": [c for c in clusters if c["len"] >= 3],
        "clusters_both_all": len(clusters),
        "goal_windows": goal_hits,
        "nongoal_windows": nongoal_hits,
        "goal_windows_with_both_reader_hit": sum(1 for g in goal_hits if g["both_readers"]),
        "nongoal_windows_with_both_reader_hit": sum(1 for n in nongoal_hits if n["both_readers"]),
        "nongoal_windows_with_run_ge2": sum(1 for n in nongoal_hits if n["max_run_both"] >= 2),
    }
    json.dump(summary, open(out_path, "w"), indent=1)
    print(json.dumps({k: v for k, v in summary.items()
                      if k not in ("goal_windows", "nongoal_windows",
                                   "clusters_both_ge2s", "clusters_both_ge3s")}, indent=1))
    print("--- goal windows")
    for g in goal_hits:
        print(f"  {g['id']:12s} both={g['both_readers']} run={g['max_run_both']}")
    print("--- non-goal windows")
    for n in nongoal_hits:
        print(f"  {n['id']:12s} ev={n['evidence']:7s} both={n['both_readers']} run={n['max_run_both']}")
    print("--- both-reader clusters >=3 s")
    for c in summary["clusters_both_ge3s"]:
        print(f"  {c['t_start']}-{c['t_end']} ({c['len']}s) in_goal={c['in_labelled_goal']} windows={c['windows']}")


if __name__ == "__main__":
    main()

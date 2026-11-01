#!/usr/bin/env python3
"""Reproducibility audit for a frame-read layer (kids_soccer eval).

The eval's shot-class labels are only quotable if the reader that produced them
gives the same answer twice. This script measures that, purely from recorded
reads — no network, no GPU, no model call:

  * **cross-read agreement** — for every second that two read files both cover,
    do the two reads agree on the coarse class (goal / shot / celebration /
    open play / elsewhere)?
  * **shot-class instability** — the number AC-1 cares about: seconds a primary
    read calls a shot (`goal_mouth_shot`, `keeper_save`) but a repeat read calls
    something else. A promoted shot window whose evidence does not survive a
    second read is label noise, not a label.
  * **template collapse** — how many reads are verbatim repeats of another
    read's first sentence. A reader that emits the same sentence for unrelated
    seconds is pattern-completing the prompt, so its class labels cannot be
    trusted even when two passes happen to agree.

Read files are JSONL, one `{"t": <second>, "read": "<model output>"}` per line.
The class is taken from an `ACTION=<class>` or `V=<class>` token, which is what
the recorded prompts (`scan_goalmouth.py`, the strip prompt) ask for.

Usage
-----
  python3 audit_frame_reads.py \
      --primary results/goalmouth_scan_1s.jsonl \
      --repeat results/goalmouth_scan_cross_prompt.jsonl \
      --json results/frame_read_audit.json

Exit code 0 always: this is a measurement, not a gate.
"""
import argparse
import collections
import json
import re

ACTION_RE = re.compile(r"(?:ACTION|V)\s*=\s*([a-z_]+)", re.IGNORECASE)

SHOT_CLASSES = {"goal_mouth_shot", "keeper_save"}

# Coarse buckets so two prompts that word the same event differently still match.
BUCKETS = {
    "goal_mouth_shot": "shot",
    "keeper_save": "shot",
    "ball_in_net": "goal",
    "goal": "goal",
    "celebration": "celebration",
    "open_play": "open_play",
    "closeup_elsewhere": "elsewhere",
    "close_up": "elsewhere",
    "closeup": "elsewhere",
    "penalty_setup": "shot",
}


def load(path):
    rows = {}
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = rec.get("t")
        if t is None:
            continue
        rows[int(t)] = rec.get("read") or ""
    return rows


def action(read):
    m = ACTION_RE.search(read or "")
    return m.group(1).lower() if m else "unknown"


def bucket(cls):
    return BUCKETS.get(cls, "other")


def first_sentence(read):
    head = (read or "").strip().split("\n")[0].strip()
    return head.rstrip(".").strip()


def audit(primary, repeats):
    out: dict = {"primary_seconds": len(primary), "repeat_layers": len(repeats)}
    pairs = []
    for name, rep in repeats:
        shared = sorted(set(primary) & set(rep))
        agree = disagree = 0
        disagreements = []
        shot_total = shot_stable = 0
        for t in shared:
            a, b = action(primary[t]), action(rep[t])
            if bucket(a) == bucket(b):
                agree += 1
            else:
                disagree += 1
                disagreements.append({"t": t, "primary": a, "repeat": b})
            if a in SHOT_CLASSES:
                shot_total += 1
                if b in SHOT_CLASSES:
                    shot_stable += 1
        pairs.append({
            "repeat": name,
            "shared_seconds": len(shared),
            "agree": agree,
            "disagree": disagree,
            "agreement_pct": round(100.0 * agree / len(shared), 1) if shared else None,
            "primary_shot_seconds": shot_total,
            "shot_confirmed_by_repeat": shot_stable,
            "shot_instability_pct": round(100.0 * (shot_total - shot_stable) / shot_total, 1)
            if shot_total else None,
            "disagreements": disagreements,
        })
    out["pairs"] = pairs

    sentences = collections.Counter(first_sentence(r) for r in primary.values())
    top = sentences.most_common(5)
    out["template_collapse"] = {
        "reads": len(primary),
        "distinct_first_sentences": len(sentences),
        "distinct_pct": round(100.0 * len(sentences) / len(primary), 1) if primary else None,
        "most_repeated": [{"sentence": s, "count": c} for s, c in top if c > 1][:5],
    }
    counts = collections.Counter(bucket(action(r)) for r in primary.values())
    out["primary_class_counts"] = dict(sorted(counts.items()))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--primary", required=True, help="JSONL of {t, read} to audit")
    ap.add_argument("--repeat", action="append", default=[],
                    help="JSONL of {t, read} read independently of --primary (repeatable)")
    ap.add_argument("--json", default=None, help="write the full audit JSON here")
    args = ap.parse_args()

    primary = load(args.primary)
    repeats = [(p, load(p)) for p in args.repeat]
    if not repeats:
        raise SystemExit("at least one --repeat layer is required")
    result = audit(primary, repeats)
    result["primary_file"] = args.primary
    result["repeat_files"] = args.repeat

    print("primary: %d seconds (%s)" % (result["primary_seconds"], args.primary))
    print("classes: %s" % result["primary_class_counts"])
    tc = result["template_collapse"]
    print("template collapse: %d/%d distinct first sentences (%.1f%%)"
          % (tc["distinct_first_sentences"], tc["reads"], tc["distinct_pct"]))
    for p in result["pairs"]:
        print("\nrepeat layer %s" % p["repeat"])
        print("  shared seconds          : %d" % p["shared_seconds"])
        print("  agreement               : %d/%d = %.1f%%"
              % (p["agree"], p["shared_seconds"], p["agreement_pct"]))
        if p["primary_shot_seconds"]:
            print("  shot class (primary)    : %d seconds, %d confirmed by this layer -> %.1f%% unstable"
                  % (p["primary_shot_seconds"], p["shot_confirmed_by_repeat"],
                     p["shot_instability_pct"]))
        for d in p["disagreements"][:10]:
            print("    t=%d primary=%s repeat=%s" % (d["t"], d["primary"], d["repeat"]))
        if len(p["disagreements"]) > 10:
            print("    ... %d more" % (len(p["disagreements"]) - 10))

    if args.json:
        with open(args.json, "w") as fh:
            json.dump(result, fh, indent=1)
        print("\nwrote %s" % args.json)


if __name__ == "__main__":
    main()

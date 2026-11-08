#!/usr/bin/env python3
"""ADAAAA-8392: freeze the reader-verification record (no verified manifest).

The read is unfit (see /home/brad/hl8371/verify8392.log), so this file is the
honest record of WHAT the independent reader said and why it cannot arbitrate the
34 compilation anchors: both protocols, every tally, the per-window verdicts.
"""
import json
import os
from collections import Counter

RULES = {
    "any_cue": lambda c: c["net"] or c["celebration"] or c["graphic"] or c["verdict_goal"],
    "net_or_celebration": lambda c: c["net"] or c["celebration"],
    "verdict_only": lambda c: c["verdict_goal"],
    "celebration_only": lambda c: c["celebration"],
}
P1 = ("You are looking at ONE still frame from a soccer match video. Answer with four short lines, "
      "each starting with the label:\nNET: YES if the ball is inside the goal net, else NO\n"
      "CELEBRATION: YES if players are celebrating a goal (arms raised, huddle, running together, "
      "scorer pointing), else NO\nGRAPHIC: YES if a goal graphic, replay banner, scorer caption or a "
      "changed scoreboard is shown, else NO\nVERDICT: GOAL if any of the three above is YES, otherwise "
      "NO_GOAL\nAnswer only from what is clearly visible in this frame.")
P2 = ("You are reviewing ONE still frame from a soccer match video. Answer with four short lines:\n"
      "NET: YES only if the ball itself is visibly inside the goal net, else NO\n"
      "CELEBRATION: YES only if players are clearly celebrating a goal that has just been scored "
      "(arms raised, running to a corner, group pile-on), else NO\nGRAPHIC: YES only if a goal-specific "
      "graphic is on screen (a GOAL caption, a scorer card naming the scorer, or a full-screen replay "
      "wipe labelled as the goal), else NO — a normal persistent scoreboard alone is NOT a goal graphic\n"
      "VERDICT: GOAL if any of the three above is YES, else NO_GOAL\nAnswer only from what this single "
      "frame clearly shows; do not guess.")


def load(path):
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path):
        try:
            r = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        out.setdefault(r["window"], []).append(r)
    return out


def protocol(name, prompt, reads, man):
    pos = [w["id"] for w in man["windows"] if w["id"].startswith("ks-g")]
    neg = [w["id"] for w in man["windows"] if str(w.get("ground_truth")) != "goal"]
    anchors = [w["id"] for w in man["windows"] if w["id"].startswith("cg-g")]
    tallies = {}
    for rule, fn in RULES.items():
        ph = [w for w in pos if any(fn(r) for r in reads.get(w, []))]
        fh = [w for w in neg if any(fn(r) for r in reads.get(w, []))]
        fh10 = [w for w in neg[:10] if w in fh]
        tallies[rule] = {
            "pos_called_goal": f"{len(ph)}/{len(pos)}",
            "pos_pass_12_of_15": len(ph) >= 12,
            "neg_called_goal_false": f"{len(fh)}/{len(neg)}",
            "neg_first10_called_goal": f"{len(fh10)}/10",
            "neg_pass_8_of_10": len(fh10) <= 2,
            "both_pass": len(ph) >= 12 and len(fh10) <= 2,
            "pos_missed": [w for w in pos if w not in ph],
            "neg_false_goal": fh,
        }
    anchor_read = {}
    for w in anchors:
        recs = reads.get(w, [])
        fired = {k: [r["offset"] for r in recs if r.get(k)]
                 for k in ("net", "celebration", "graphic", "verdict_goal")}
        anchor_read[w] = {"frames_read": len(recs),
                          "any_cue_goal": any(RULES["any_cue"](r) for r in recs),
                          "cues_fired_at_offsets": {k: v for k, v in fired.items() if v}}
    return {"prompt": prompt, "frames_read": sum(len(v) for v in reads.values()),
            "windows_read": len(reads), "tallies": tallies,
            "fitness": {"any_rule_passes_both_gates": any(t["both_pass"]
                                                          for t in tallies.values()),
                        "best_pos": max((t["pos_called_goal"] for t in tallies.values()),
                                        key=lambda s: int(s.split("/")[0])),
                        "verdict": "UNFIT"},
            "anchors_34": anchor_read}


man = json.load(open("/home/brad/hl8371/label-manifest-8371.json"))
v1 = load("/home/brad/hl8371/frames8392/reads.jsonl")
v2 = load("/home/brad/hl8371/frames8392/reads_v2.jsonl")
out = {
    "issue": "ADAAAA-8392 (stage B for ADAAAA-8371)",
    "purpose": ("frame-verify the 34 cg-g-* compilation goal anchors with a reader "
                "independent of the model under test"),
    "reader": {"model": "allenai/Molmo2-4B", "quantisation": "bnb-4bit-nf4",
               "compute_dtype": "bfloat16", "double_quant": True, "device": "cuda:1",
               "decoding": "greedy", "max_new_tokens": 96,
               "vram_alloc_GiB": 4.87, "model_load_s": 5.2,
               "independent_of": "deployed gemma/decide replica (never called)",
               "clip_sha256": {c["id"]: c.get("sha256") for c in man["clips"]},
               "frame_offsets_s": [-2, 0, 2, 4],
               "frame_seek": "ffmpeg input-side -ss (keyframe-accurate, ~0.2 s)"},
    "protocols": {"v1_permissive": protocol("v1", P1, v1, man),
                  "v2_strict": protocol("v2", P2, v2, man)},
    "conclusion": {
        "verified_manifest_written": False,
        "reason": ("no protocol meets both control gates: v1 over-calls "
                   "(19/41 no_goal windows read goal; permissive cue text lets a "
                   "persistent scoreboard/replay banner satisfy GRAPHIC) and its "
                   "best positive tally is 11/15 (bar 12/15); v2 under-calls "
                   "(2-3/15 positives). net_or_celebration under v1 does pass the "
                   "negative gate (10/10 first-10) but only reaches 10/15 positives. "
                   "A reader that cannot clear both sides cannot arbitrate the "
                   "anchors, and the ticket forbids padding the set with unverified "
                   "windows."),
        "consequence": ("the 34 cg-g-* anchors stay UNVERIFIED; the AC1 bar of >=40 "
                        "verified goal windows is NOT demonstrated. The eval is "
                        "reported on the 49 labelled windows (34 unverified) and on "
                        "the 15 frame-verified carried windows."),
        "next_reader_candidates": [
            "scoreboard-change OCR within each compilation segment (the manifest "
            "records that tesseract on this compilation returns digit noise)",
            "a dedicated ball-in-net detector (perceive florence/SAM3 is NOT usable: "
            "it generates the evidence the eval scores)",
            "contact-sheet review by a human/board pass"],
    },
}
json.dump(out, open("/home/brad/hl8371/reader-verification-8371.json", "w"), indent=1)
print(json.dumps({p: {k: v["tallies"][k]["both_pass"] for k in v["tallies"]}
                  for p, v in out["protocols"].items()}, indent=1))
print("wrote reader-verification-8371.json")

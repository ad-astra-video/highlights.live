#!/usr/bin/env python3
"""ADAAAA-8392 task 1: frame-verify the 34 compilation goal anchors.

Reader: Molmo2-4B (allenai/Molmo2-4B), 4-bit NF4 (bitsandbytes) on GPU1, greedy
decoding. It is INDEPENDENT of the model under test (the deployed gemma/decide
replica is never called) and independent of the audio anchor: the cg-g-* instants
were placed on an interior crowd-roar peak of a scene-cut segment, so the only
evidence that a goal is on screen is pixels.

The reader answers a DECOMPOSED cue question per frame (NET / CELEBRATION /
GRAPHIC / VERDICT) so every verdict is auditable: the manifest records which cue
fired, not just a yes/no.

Fitness gates, run and tallied BEFORE any anchor verdict counts:
  positive control: the 15 carried kids-soccer goal windows (ks-g-*) at their
                    ground-truth `instant` must read goal on >= 12/15;
  negative control: the no_goal windows must read not-a-goal on >= 8 of the
                    first 10 (all 41 are read, so the full tally is reported).

If either gate fails the script writes `reader_fit=false` and exits 3; it NEVER
writes a verified-looking manifest for an unfit reader.

Per window the frames at instant-2, instant, instant+2, instant+4 are read
(windows carried from ADAAAA-8343 without an `instant`, i.e. the 22 ks-n-*, use
four frames spread inside [t_start, t_end]). A cg-g-* window survives only when
at least one read frame reads goal inside the window; `instant` is then moved to
the earliest such frame and the window shifted with it (t_start = instant-3,
t_end = instant+9). No frame inside the window showing a goal => the window is
dropped and reported by id.

Usage (box):
  /data/molmo-venv/bin/python verify_anchors_8371.py \
      --manifest label-manifest-8371.json \
      --out label-manifest-8371-verified.json \
      --frames /home/brad/hl8371/frames8392 \
      --reads /home/brad/hl8371/frames8392/reads.jsonl \
      --device cuda:1
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import time

import torch
from PIL import Image
from transformers import AutoProcessor, AutoModelForImageTextToText, BitsAndBytesConfig

MODEL_ID = "allenai/Molmo2-4B"
PROMPT = (
    "You are looking at ONE still frame from a soccer match video. Answer with "
    "four short lines, each starting with the label:\n"
    "NET: YES if the ball is inside the goal net, else NO\n"
    "CELEBRATION: YES if players are celebrating a goal (arms raised, huddle, "
    "running together, scorer pointing), else NO\n"
    "GRAPHIC: YES if a goal graphic, replay banner, scorer caption or a changed "
    "scoreboard is shown, else NO\n"
    "VERDICT: GOAL if any of the three above is YES, otherwise NO_GOAL\n"
    "Answer only from what is clearly visible in this frame."
)
OFFSETS = (-2, 0, 2, 4)
# Aggregation rules, all computed from the SAME cached reads. The rule used for
# the anchors is frozen on the control tallies only (never on anchor outcomes).
RULES = {
    "any_cue": lambda c: c["net"] or c["celebration"] or c["graphic"] or c["verdict_goal"],
    "net_or_celebration": lambda c: c["net"] or c["celebration"],
    "verdict_only": lambda c: c["verdict_goal"],
    "celebration_only": lambda c: c["celebration"],
}


# --------------------------------------------------------------------------- io
def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def frame(clip, t, out):
    if os.path.exists(out) and os.path.getsize(out) > 0:
        return out
    os.makedirs(os.path.dirname(out), exist_ok=True)
    # input-side -ss = fast keyframe seek (~0.15-0.3 s); output-side seek decodes
    # from file start and cost ~11 s/frame on the 3,330 s compilation.
    subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{max(0.0, t):.3f}", "-i", clip,
                    "-frames:v", "1", "-update", "1", "-q:v", "2", "-y", out],
                   check=True, capture_output=True)
    return out


# ------------------------------------------------------------------------ model
def load(device):
    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                            bnb_4bit_compute_dtype=torch.bfloat16,
                            bnb_4bit_use_double_quant=True)
    last = None
    for trc in (True, False):
        try:
            m = AutoModelForImageTextToText.from_pretrained(
                MODEL_ID, quantization_config=bnb, trust_remote_code=trc,
                device_map=device)
            m.eval()
            p = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=trc)
            return m, p
        except ValueError as e:  # transformers>=5 re-register conflict
            last = e
            if "is already used by a Transformers model" in str(e) and trc:
                continue
            raise
    raise RuntimeError(last)


def ask(model, proc, pil, device, max_new_tokens=96):
    msgs = [{"role": "user", "content": [{"type": "image", "image": pil},
                                        {"type": "text", "text": PROMPT}]}]
    inp = proc.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True,
                                   return_tensors="pt", return_dict=True)
    inp = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in inp.items()}
    t0 = time.time()
    with torch.no_grad():
        out = model.generate(**inp, max_new_tokens=max_new_tokens, do_sample=False)
    gen = out[0][inp["input_ids"].size(1):]
    return proc.decode(gen, skip_special_tokens=True).strip(), round(time.time() - t0, 2)


def parse_cues(reply):
    """Decomposed cue read; tolerant of prose fallbacks."""
    r = reply or ""
    up = r.upper()

    def cue(name):
        m = re.search(name + r"\s*:\s*(YES|NO|Y|N)\b", up)
        if m:
            return m.group(1) in ("YES", "Y")
        return None

    v = re.search(r"VERDICT\s*:\s*(\**)\s*(NO[_ ]?GOAL|GOAL)\b", up)
    verdict = None
    if v:
        verdict = not v.group(2).startswith("NO")
    cues = {"net": cue("NET"), "celebration": cue("CELEBRATION"),
            "graphic": cue("GRAPHIC"), "verdict": verdict}
    if all(x is None for x in cues.values()):
        # prose fallback: explicit GOAL / NO_GOAL, else keyword read
        if re.search(r"\bNO[_ ]GOAL\b", up):
            verdict = False
        elif re.search(r"\bGOAL\b", up) and not re.search(r"\bno goal\b", up.lower()):
            verdict = True
    out = {k: bool(v) for k, v in cues.items() if k != "verdict" and v is not None}
    for k in ("net", "celebration", "graphic"):
        out.setdefault(k, False)
    if verdict is None:
        # the model skipped the verdict line: fall back to its own cue reads
        verdict = out["net"] or out["celebration"] or out["graphic"]
    out["verdict_goal"] = bool(verdict)
    out["raw"] = r[:400]
    return out


# ------------------------------------------------------------------- reading loop
def read_window(w, clip, model, proc, device, frames_dir, reads_path, cache,
                manifest_clips):
    wid = w["id"]
    if "instant" in w:
        times = [(off, float(w["instant"]) + off) for off in OFFSETS]
        grid = "instant_offsets"
    else:  # carried 8343 no_goal windows carry no instant: 4 frames inside the window
        s, e = float(w["t_start"]), float(w["t_end"])
        times = [(0, s + 0.5), (1, s + (e - s) / 3), (2, s + 2 * (e - s) / 3), (3, e - 0.5)]
        grid = "even_in_window"
    recs = []
    for off, t in times:
        key = f"{wid}@{off:+d}"
        if key in cache:
            recs.append(cache[key])
            continue
        path = frame(clip, t, os.path.join(frames_dir, wid, f"{off:+d}.jpg"))
        pil = Image.open(path).convert("RGB")
        reply, lat = ask(model, proc, pil, device)
        rec = {"window": wid, "offset": off, "t": round(t, 2), "frame": path,
               "reply": reply, "lat_s": lat}
        rec.update(parse_cues(reply))
        recs.append(rec)
        cache[key] = rec
        with open(reads_path, "a") as fh:
            fh.write(json.dumps(rec) + "\n")
    return {"id": wid, "grid": grid,
            "frames": [{"t": r["t"], "net": r.get("net"), "celebration": r.get("celebration"),
                        "graphic": r.get("graphic"), "verdict_goal": r.get("verdict_goal"),
                        "reply": r.get("raw") or r.get("reply")} for r in recs]}


def aggregate(win_read, rule):
    fn = RULES[rule]
    fired = [f for f in win_read["frames"] if fn(f)]
    return ("goal" if fired else "not_goal"), fired


def score_rule(win_reads, pos_ids, neg_ids, rule):
    pos_hit = [wr["id"] for wr in win_reads if wr["id"] in pos_ids
               and aggregate(wr, rule)[0] == "goal"]
    neg_hit = [wr["id"] for wr in win_reads if wr["id"] in neg_ids
               and aggregate(wr, rule)[0] == "not_goal"]
    return pos_hit, neg_hit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--frames", required=True)
    ap.add_argument("--reads", required=True)
    ap.add_argument("--device", default="cuda:1")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    manifest = json.load(open(args.manifest))
    clips = {c["id"]: c for c in manifest["clips"]}
    wins = manifest["windows"][: args.limit or None]
    pos = [w for w in wins if w["id"].startswith("ks-g")]
    neg = [w for w in wins if str(w.get("ground_truth")) != "goal"]
    anchors = [w for w in wins if w["id"].startswith("cg-g")]
    print(f"windows={len(wins)} pos_ctrl={len(pos)} neg_ctrl={len(neg)} anchors={len(anchors)}",
          flush=True)

    def clip_path(w):
        return w.get("clip") or clips["kids-soccer"]["path"]

    cache = {}
    if os.path.exists(args.reads):
        for line in open(args.reads):
            try:
                r = json.loads(line)
                cache[f"{r['window']}@{r['offset']:+d}"] = r
            except Exception:  # noqa: BLE001
                pass
    print(f"cached frame reads={len(cache)}", flush=True)
    os.makedirs(os.path.dirname(args.reads) or ".", exist_ok=True)

    print("gpu1 free/total GiB:",
          [round(x / 1024**3, 2) for x in torch.cuda.mem_get_info(1)], flush=True)
    t0 = time.time()
    model, proc = load(args.device)
    print("model_load_s", round(time.time() - t0, 1),
          "alloc_GiB", round(torch.cuda.memory_allocated(1) / 1024**3, 2), flush=True)

    t0 = time.time()
    order = pos + neg + anchors
    win_reads = []
    for i, w in enumerate(order, 1):
        wr = read_window(w, clip_path(w), model, proc, args.device, args.frames,
                         args.reads, cache, clips)
        win_reads.append(wr)
        if i % 10 == 0:
            print(f"  read {i}/{len(order)} elapsed={round(time.time() - t0, 1)}s",
                  flush=True)
    print(f"frames read for {len(win_reads)} windows in {round(time.time() - t0, 1)}s",
          flush=True)

    pos_ids = {w["id"] for w in pos}
    neg_ids = {w["id"] for w in neg}
    rules = {}
    for rule in RULES:
        ph, nh = score_rule(win_reads, pos_ids, neg_ids, rule)
        rules[rule] = {"pos_hit": len(ph), "pos_n": len(pos), "neg_hit": len(nh),
                       "neg_n": len(neg), "pos_ids": ph, "neg_ids": nh}
        print(f"  rule {rule}: pos {len(ph)}/{len(pos)}  neg {len(nh)}/{len(neg)}",
              flush=True)

    # freeze the rule on the CONTROL tallies only (declared order of preference)
    chosen = None
    for rule in ("net_or_celebration", "any_cue", "verdict_only", "celebration_only"):
        r = rules[rule]
        if r["pos_hit"] >= 12 and r["neg_hit"] >= int(0.8 * r["neg_n"]):
            chosen = rule
            break
    neg_first10 = [wr for wr in win_reads if wr["id"] in neg_ids][:10]
    neg10_hit = sum(1 for wr in neg_first10 if aggregate(wr, chosen or "any_cue")[0] == "not_goal")

    result = {
        "reader": {"model": MODEL_ID, "quantisation": "bnb-4bit-nf4",
                   "compute_dtype": "bfloat16", "double_quant": True,
                   "device": args.device, "decoding": "greedy",
                   "max_new_tokens": 96, "prompt": PROMPT,
                   "offsets_s": list(OFFSETS), "torch": torch.__version__,
                   "transformers": __import__("transformers").__version__,
                   "independent_of": "deployed gemma/decide replica (not called)",
                   "clip_sha256": {c["id"]: c.get("sha256") for c in manifest["clips"]}},
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cues_per_window": {wr["id"]: wr["frames"] for wr in win_reads},
        "rules": rules,
        "rule_chosen": chosen,
        "controls": {
            "positive": {"n": len(pos), "called_goal": rules[chosen]["pos_hit"] if chosen else None,
                         "required": ">=12/15", "pass": bool(chosen),
                         "goal_ids": rules[chosen]["pos_ids"] if chosen else [],
                         "missed": [w["id"] for w in pos
                                    if chosen and w["id"] not in rules[chosen]["pos_ids"]]},
            "negative": {"n": len(neg),
                         "called_not_goal": rules[chosen]["neg_hit"] if chosen else None,
                         "required_first10": ">=8/10",
                         "first10_called_not_goal": neg10_hit,
                         "pass": neg10_hit >= 8 if chosen else False,
                         "false_goal_ids": [w["id"] for w in neg
                                            if chosen and w["id"] not in rules[chosen]["neg_ids"]]},
        },
        "note": "rule frozen on the control tallies before any anchor verdict was scored",
    }
    result["reader_fit"] = bool(chosen and result["controls"]["negative"]["pass"])
    print(json.dumps({"chosen": chosen, "fit": result["reader_fit"],
                      "pos": f"{rules[chosen]['pos_hit']}/{len(pos)}" if chosen else None,
                      "neg_all": f"{rules[chosen]['neg_hit']}/{len(neg)}" if chosen else None,
                      "neg_first10": f"{neg10_hit}/10"}), flush=True)

    if not result["reader_fit"]:
        json.dump(result, open(args.out, "w"), indent=1)
        print("READER_UNFIT — no verified manifest written", flush=True)
        return 3

    # --- the 34 compilation anchors ----------------------------------------
    by_id = {wr["id"]: wr for wr in win_reads}
    kept, dropped = [], []
    for w in anchors:
        wr = by_id[w["id"]]
        verdict, fired = aggregate(wr, chosen)
        if verdict != "goal":
            dropped.append({"id": w["id"], "verdict": verdict,
                            "audio_anchor": w.get("instant"),
                            "frames": wr["frames"]})
            continue
        inst = fired[0]["t"]
        nw = dict(w)
        nw["instant"] = inst
        nw["t_start"] = round(inst - 3, 2)
        nw["t_end"] = round(inst + 9, 2)
        nw["confidence"] = "frame-verified"
        nw["frames"] = (f"Molmo2-4B 4-bit read goal at t={inst}s "
                        f"(audio anchor was {w.get('instant')}s); window shifted to "
                        f"{nw['t_start']}-{nw['t_end']}s")
        nw["verified"] = {"verdict": verdict, "rule": chosen, "first_goal_t": inst,
                          "audio_anchor": w.get("instant"),
                          "cue_fired": {"net": fired[0]["net"],
                                        "celebration": fired[0]["celebration"],
                                        "graphic": fired[0]["graphic"]},
                          "frames": wr["frames"]}
        kept.append(nw)

    out = dict(manifest)
    carried = [w for w in wins if not w["id"].startswith("cg-g")]
    out["version"] = "8371-verified"
    out["windows"] = carried + kept
    out["coverage"] = {
        "total_windows": len(out["windows"]),
        "goal_windows": sum(1 for w in out["windows"] if w.get("ground_truth") == "goal"),
        "non_goal_windows": sum(1 for w in out["windows"] if w.get("ground_truth") != "goal"),
        "carried_from_8343": sum(1 for w in wins if "increment" not in w),
        "verified_new_goal": len(kept),
        "dropped_new_goal": len(dropped),
        "anchors_read": len(anchors),
    }
    out["verification"] = result
    out["verification"]["anchors"] = {"n": len(anchors),
                                      "kept": [w["id"] for w in kept],
                                      "dropped": dropped,
                                      "per_window": {w["id"]: by_id[w["id"]]["frames"]
                                                     for w in anchors}}
    out["$comment"] = (manifest.get("$comment", "") +
                       " cg-g-* instants frame-verified with an independent reader "
                       "(Molmo2-4B 4-bit, decomposed cue question); verified windows "
                       "re-anchored on the first frame that shows the goal.")
    json.dump(out, open(args.out, "w"), indent=1)
    print(json.dumps({"kept": len(kept), "dropped": len(dropped),
                      "goal_total": out["coverage"]["goal_windows"],
                      "sha256": sha256(args.out)}, indent=1), flush=True)
    print("AC_BAR", "PASS" if out["coverage"]["goal_windows"] >= 40 else "FAIL",
          f"goal_windows={out['coverage']['goal_windows']}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

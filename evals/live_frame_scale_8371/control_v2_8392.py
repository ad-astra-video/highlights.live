#!/usr/bin/env python3
"""ADAAAA-8392: reader protocol v2 (strict cue definitions) on the CONTROL set only.

Same Molmo2-4B 4-bit reader and the SAME cached frames as the first pass; only the
prompt's cue definitions change (a persistent scoreboard and a routine huddle are
explicitly NOT a goal graphic / goal celebration). Tallies all four aggregation
rules against the positive (15 ks-g) and negative (41 no_goal) controls.
"""
import argparse
import glob
import json
import os
import re
import sys

import torch
from PIL import Image
from transformers import AutoProcessor, AutoModelForImageTextToText, BitsAndBytesConfig

MODEL_ID = "allenai/Molmo2-4B"
PROMPT = (
    "You are reviewing ONE still frame from a soccer match video. Answer with "
    "four short lines:\n"
    "NET: YES only if the ball itself is visibly inside the goal net, else NO\n"
    "CELEBRATION: YES only if players are clearly celebrating a goal that has "
    "just been scored (arms raised, running to a corner, group pile-on), else NO\n"
    "GRAPHIC: YES only if a goal-specific graphic is on screen (a GOAL caption, a "
    "scorer card naming the scorer, or a full-screen replay wipe labelled as the "
    "goal), else NO — a normal persistent scoreboard alone is NOT a goal graphic\n"
    "VERDICT: GOAL if any of the three above is YES, else NO_GOAL\n"
    "Answer only from what this single frame clearly shows; do not guess."
)
OFFSETS = (-2, 0, 2, 4)
RULES = {
    "any_cue": lambda c: c["net"] or c["celebration"] or c["graphic"] or c["verdict_goal"],
    "net_or_celebration": lambda c: c["net"] or c["celebration"],
    "verdict_only": lambda c: c["verdict_goal"],
    "celebration_only": lambda c: c["celebration"],
}


def parse_cues(reply):
    up = (reply or "").upper()

    def cue(name):
        m = re.search(name + r"\s*:\s*(YES|NO|Y|N)\b", up)
        return m.group(1) in ("YES", "Y") if m else None

    v = re.search(r"VERDICT\s*:\s*(\**)\s*(NO[_ ]?GOAL|GOAL)\b", up)
    verdict = (not v.group(2).startswith("NO")) if v else None
    out = {"net": cue("NET"), "celebration": cue("CELEBRATION"), "graphic": cue("GRAPHIC")}
    if all(x is None for x in out.values()) and verdict is None:
        verdict = False if re.search(r"\bNO[_ ]GOAL\b", up) else (
            True if re.search(r"\bGOAL\b", up) else False)
    for k in out:
        out[k] = bool(out[k])
    out["verdict_goal"] = bool(verdict) if verdict is not None else (
        out["net"] or out["celebration"] or out["graphic"])
    out["raw"] = (reply or "")[:400]
    return out


def load(device):
    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                            bnb_4bit_compute_dtype=torch.bfloat16,
                            bnb_4bit_use_double_quant=True)
    for trc in (True, False):
        try:
            m = AutoModelForImageTextToText.from_pretrained(
                MODEL_ID, quantization_config=bnb, trust_remote_code=trc,
                device_map=device)
            m.eval()
            p = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=trc)
            return m, p
        except ValueError as e:
            if "is already used by a Transformers model" in str(e) and trc:
                continue
            raise


def ask(model, proc, pil, device="cuda:1", max_new_tokens=96):
    msgs = [{"role": "user", "content": [{"type": "image", "image": pil},
                                         {"type": "text", "text": PROMPT}]}]
    inp = proc.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True,
                                   return_tensors="pt", return_dict=True)
    inp = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in inp.items()}
    with torch.no_grad():
        out = model.generate(**inp, max_new_tokens=max_new_tokens, do_sample=False)
    return proc.decode(out[0][inp["input_ids"].size(1):], skip_special_tokens=True).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--frames", required=True)
    ap.add_argument("--reads", required=True)
    ap.add_argument("--device", default="cuda:1")
    a = ap.parse_args()

    man = json.load(open(a.manifest))
    pos = [w for w in man["windows"] if w["id"].startswith("ks-g")]
    neg = [w for w in man["windows"] if str(w.get("ground_truth")) != "goal"]
    order = pos + neg

    cache = {}
    if os.path.exists(a.reads):
        for line in open(a.reads):
            try:
                r = json.loads(line)
                cache[f"{r['window']}@{r['offset']:+d}"] = r
            except Exception:  # noqa: BLE001
                pass
    print(f"cached v2 reads={len(cache)} pos={len(pos)} neg={len(neg)}", flush=True)

    model, proc = load(a.device)
    for i, w in enumerate(order, 1):
        wid = w["id"]
        if "instant" in w:
            times = [(o, float(w["instant"]) + o) for o in OFFSETS]
        else:
            s, e = float(w["t_start"]), float(w["t_end"])
            times = [(0, s + 0.5), (1, s + (e - s) / 3), (2, s + 2 * (e - s) / 3),
                     (3, e - 0.5)]
        for off, t in times:
            key = f"{wid}@{off:+d}"
            if key in cache:
                continue
            files = glob.glob(os.path.join(a.frames, wid, f"{off:+d}.jpg"))
            if not files:
                print(f"  MISSING frame {key}", flush=True)
                continue
            reply = ask(model, proc, Image.open(files[0]).convert("RGB"), a.device)
            rec = {"window": wid, "offset": off, "t": round(t, 2)}
            rec.update(parse_cues(reply))
            cache[key] = rec
            with open(a.reads, "a") as fh:
                fh.write(json.dumps(rec) + "\n")
        if i % 10 == 0:
            print(f"  window {i}/{len(order)}", flush=True)

    def win_verdict(wid, rule):
        recs = [v for v in cache.values() if v["window"] == wid]
        return "goal" if any(RULES[rule](r) for r in recs) else "not_goal"

    print(json.dumps({"protocol": "v2", "prompt": PROMPT[:120]}, indent=0))
    for rule in RULES:
        ph = [w["id"] for w in pos if win_verdict(w["id"], rule) == "goal"]
        nh = [w["id"] for w in neg if win_verdict(w["id"], rule) == "not_goal"]
        nh10 = [w["id"] for w in neg[:10] if win_verdict(w["id"], rule) == "not_goal"]
        print(json.dumps({"rule": rule, "pos": f"{len(ph)}/{len(pos)}",
                          "neg": f"{len(nh)}/{len(neg)}",
                          "neg_first10": f"{len(nh10)}/10",
                          "pos_missed": [w["id"] for w in pos if w["id"] not in ph],
                          "neg_false": [w["id"] for w in neg if w["id"] not in nh]}),
              flush=True)


if __name__ == "__main__":
    main()

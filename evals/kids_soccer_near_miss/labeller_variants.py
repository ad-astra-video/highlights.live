#!/usr/bin/env python3
"""Prompt-family calibration for the local gemma frame labeller (ADAAAA-7611 AC-1).

Follow-up to `gemma_labeller_cal.py`: the baseline prompt asks for
`BALL/SHOT/KIND/GOAL` in one line and the model collapses to `SHOT=yes
KIND=none` on both sides (36 shot frames vs 68 control frames), so the strict
rule reaches 6/10 shot windows against 4/12 false control windows.

This harness keeps the frame reads but replaces the single yes/no question with
several rubric variants that ask for the *perceptual facts* a shot frame carries
(goal net visible, ball near the net / in flight, keeper reacting) and let the
decision be derived from those facts. Raw per-frame output is written out so a
different aggregation rule can be re-scored offline without re-running the model.

Run INSIDE the compose network (gemma:8088 is not reachable from the host):

    docker exec highlights-perceive python3 -u /tmp/ac1f/labeller_variants.py \
        /tmp/ac1f/fr /tmp/ac1f/cal_plan.json /tmp/ac1f/variants.jsonl

`cal_plan.json` is `[{"id","kind","t0","t1"}]`; frames are `<id>_<n>.jpg` at
1 s steps starting at `t0`.
"""
import base64
import glob
import json
import os
import re
import sys
import urllib.request

URL = os.environ.get("GEMMA_URL", "http://gemma:8088/v1/chat/completions")
MODEL = "cyankiwi/gemma-4-12B-it-qat-AWQ-INT4"

VARIANTS = {
    # baseline, kept for the side-by-side record
    "v0_baseline": ("Answer only, one line, no explanation: "
                    "BALL=yes/no; SHOT=yes/no; KIND=saved/post/wide/blocked/none; GOAL=yes/no"),
    # rich scene classification instead of a yes/no shot question
    "v1_scene": ("Classify this soccer frame. Answer only, one line, no explanation: "
                 "SCENE=shot_at_goal/save/celebration/goalmouth/near_goal_play/"
                 "open_play/closeup/replay/graphic; BALL=inflight/at_feet/in_net/not_visible"),
    # facts-first: localise the net, then the ball relative to it, then the keeper
    "v2_facts": ("Answer only, one line, no explanation: "
                 "NET=yes/no; BALL=near_net/far/not_visible; KEEPER=diving/collecting/standing/absent"),
    # explicit definition of the class boundary
    "v3_defined": ("A shot frame shows a ball struck toward the goal or a goalkeeper making or "
                   "attempting a save: the ball is in flight close to the goal mouth, in the net, "
                   "or the keeper is diving. Midfield open play, close-ups of players, "
                   "celebrations, replays and graphics are NOT shots. "
                   "Answer only, one line: SHOT=yes/no"),
    # motion phrasing: the moment, not the scene
    "v4_moment": ("Is this the moment of a shot on goal? Answer only, one line, no explanation: "
                  "ON_TARGET=yes/no; BALL_VISIBLE=yes/no; WHERE=goalmouth/midfield/other"),
}

# derived decision per variant: the rule that turns one frame's answer into
# "shot-class frame" (True), "not a shot" (False) or unmeasured (None)
SCENE_SHOT = {"shot_at_goal", "save"}
KEEPER_SHOT = {"diving", "collecting"}


def read(path, prompt):
    b64 = base64.b64encode(open(path, "rb").read()).decode()
    body = {"model": MODEL, "temperature": 0, "max_tokens": 40,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}}]}]}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.load(r)
    return (d["choices"][0]["message"].get("content") or "").strip()


def parse(txt):
    out = {}
    for k in ("BALL", "SHOT", "KIND", "GOAL", "SCENE", "NET", "KEEPER", "ON_TARGET",
              "BALL_VISIBLE", "WHERE"):
        m = re.search(rf"{k}\s*=\s*([A-Za-z_]+)", txt or "")
        out[k] = (m.group(1).lower() if m else None)
    return out


def decide(variant, p):
    if variant == "v0_baseline":
        if p.get("SHOT") != "yes":
            return False
        return p.get("KIND") in {"saved", "post", "wide", "blocked"}
    if variant == "v1_scene":
        s = p.get("SCENE")
        return None if s is None else s in SCENE_SHOT
    if variant == "v2_facts":
        if p.get("BALL") is None:
            return None
        if p.get("BALL") == "near_net":
            return True
        return p.get("KEEPER") in KEEPER_SHOT
    if variant == "v3_defined":
        s = p.get("SHOT")
        return None if s is None else s == "yes"
    if variant == "v4_moment":
        if p.get("ON_TARGET") == "yes":
            return True
        return p.get("WHERE") == "goalmouth" and p.get("BALL_VISIBLE") == "yes"
    raise KeyError(variant)


def main():
    fdir, plan_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    plan = json.load(open(plan_path))
    wanted = [v.strip() for v in os.environ.get("GEMMA_VARIANTS", "").split(",") if v.strip()]
    todo = {v: p for v, p in VARIANTS.items() if not wanted or v in wanted}
    for v in wanted:
        if v not in VARIANTS:
            raise SystemExit(f"unknown variant {v}; known: {list(VARIANTS)}")
    rows = []
    for variant, prompt in todo.items():
        for p in plan:
            files = sorted(glob.glob(os.path.join(fdir, p["id"] + "_*.jpg")))
            for f in files:
                t = p["t0"] + int(re.search(r"_(\d+)\.jpg$", f).group(1)) - 1
                try:
                    txt = read(f, prompt)
                except Exception as e:      # failed read = unmeasured, never a disagreement
                    txt, err = "", str(e)[:100]
                else:
                    err = None
                parsed = parse(txt)
                rows.append({"variant": variant, "id": p["id"], "kind": p["kind"], "t": t,
                             "out": txt, "parsed": parsed,
                             "decision": None if err else decide(variant, parsed), "err": err})
        print(f"{variant}: {len(rows)} rows so far", flush=True)
    with open(out_path, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    print(f"wrote {len(rows)} rows to {out_path}", flush=True)


if __name__ == "__main__":
    main()

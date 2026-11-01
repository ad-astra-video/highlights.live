#!/usr/bin/env python3
"""Local gemma frame labeller calibration (ADAAAA-7611 AC-1, 2026-11-01).

The remote multimodal endpoint needs `SCAN_KEY` (not provisioned as a secret, and
the Hermes vision path timed out this run), but the box already serves
`cyankiwi/gemma-4-12B-it-qat-AWQ-INT4` at `http://gemma:8088` for the pipeline
itself. That is a free, keyless, local labeller candidate, so it was calibrated
on the same 10 shot-class windows and 12 `evidence:none` controls at 1 s steps.

Run it INSIDE the compose network (e.g. the perceive container): `gemma:8088` is
not reachable from the host or the agent container. Frames come from
`ffmpeg -ss <t0> -t <dur> ... -vf fps=1,scale=960:540` on the 1280x720 upload;
`cal_plan.json` is `[{"id","kind","t0","t1"}]` for the windows to read.

Result (results/gemma_labeller_cal.json): reading 0.4 s/frame over 245 frames,
the loose rule (any `SHOT=yes`) flags 10/10 shot windows **and 12/12 control
windows** (74/134 control frames), i.e. it says yes to everything; the strict
rule (`SHOT=yes` and `KIND` in saved/post/wide/blocked) gets 6/10 shots against
4/12 controls falsely shot. Bar is >=8/10 and <=2, so this is **not** a labeller
yet — but it is the cheapest layer to iterate on.
"""
import base64, glob, json, os, re, sys, time, urllib.request
URL = "http://gemma:8088/v1/chat/completions"
MODEL = "cyankiwi/gemma-4-12B-it-qat-AWQ-INT4"
PROMPT = ("Answer only, one line, no explanation: "
          "BALL=yes/no; SHOT=yes/no; KIND=saved/post/wide/blocked/none; GOAL=yes/no")
FR = "/tmp/ac1f/fr"
PLAN = json.load(open("/tmp/ac1f/cal_plan.json"))

def read(path):
    b64 = base64.b64encode(open(path, "rb").read()).decode()
    body = {"model": MODEL, "temperature": 0, "max_tokens": 40,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}}]}]}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.load(r)
    return (d["choices"][0]["message"].get("content") or "").strip()

def parse(txt):
    out = {}
    for k in ("BALL", "SHOT", "KIND", "GOAL"):
        m = re.search(rf"{k}\s*=\s*([A-Za-z_]+)", txt or "")
        out[k] = (m.group(1).lower() if m else None)
    return out

rows = []
for p in PLAN:
    files = sorted(glob.glob(os.path.join(FR, p["id"] + "_*.jpg")))
    for f in files:
        t = p["t0"] + int(re.search(r"_(\d+)\.jpg$", f).group(1)) - 1
        try:
            txt = read(f)
        except Exception as e:            # failed read = unmeasured, never disagreement
            txt, err = "", str(e)[:80]
        else:
            err = None
        rows.append({"id": p["id"], "kind": p["kind"], "t": t, "out": txt,
                     "parsed": parse(txt), "err": err})
with open("/tmp/ac1f/reads.jsonl", "w") as fh:
    for r in rows:
        fh.write(json.dumps(r) + "\n")

def win_verdict(wid):
    rs = [r for r in rows if r["id"] == wid]
    shots = [r for r in rs if r["parsed"]["SHOT"] == "yes"]
    kinds = [r["parsed"]["KIND"] for r in shots]
    goal = [r for r in rs if r["parsed"]["GOAL"] == "yes"]
    return {"frames": len(rs), "shot_frames": len(shots),
            "kinds": sorted(set(k for k in kinds if k)), "goal_frames": len(goal),
            "first_shot_t": shots[0]["t"] if shots else None,
            "errs": sum(1 for r in rs if r["err"])}

shots = [p["id"] for p in PLAN if p["kind"] == "shot"]
ctrls = [p["id"] for p in PLAN if p["kind"] == "control"]
sv = {w: win_verdict(w) for w in shots}
cv = {w: win_verdict(w) for w in ctrls}
summary = {
    "model": MODEL, "prompt": PROMPT, "warm_read_s": rows[0] and None,
    "shot_windows_reproduced": sum(1 for w in shots if sv[w]["shot_frames"] > 0),
    "shot_windows": len(shots),
    "control_windows_false_shot": sum(1 for w in ctrls if cv[w]["shot_frames"] > 0),
    "control_windows": len(ctrls),
    "control_false_shot_frames": sum(cv[w]["shot_frames"] for w in ctrls),
    "control_frames": sum(cv[w]["frames"] for w in ctrls),
    "per_window": {**{w: sv[w] for w in shots}, **{w: cv[w] for w in ctrls}},
}
json.dump(summary, open("/tmp/ac1f/cal_summary.json", "w"), indent=1)
print(json.dumps({k: v for k, v in summary.items() if k != "per_window"}))
for w in shots + ctrls:
    v = summary["per_window"][w]
    print(w, v["frames"], v["shot_frames"], ",".join(v["kinds"]) or "-", "first", v["first_shot_t"], "errs", v["errs"])

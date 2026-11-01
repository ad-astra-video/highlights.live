#!/usr/bin/env python3
"""Calibration harness for the kids_soccer frame-read labeller (ADAAAA-7611).

AC-1/AC-2 may only be closed with a reader whose reads *repeat* and whose
answers are right on windows that are already labelled. This script measures
both, on single frames:

  * **repeatability** — every second the first pass calls a shot class is read a
    second time; the pair must agree.
  * **reproduction** — each manifest shot-class window (`ground_truth=no_goal`,
    `evidence` in saved|blocked|wide) must yield at least one shot second.
  * **false-shot rate** — the `evidence: "none"` control windows must stay quiet.

Reader configuration (measured, not assumed): single frame, 2x upscale,
`temperature=0`, `chat_template_kwargs.enable_thinking=true`,
`max_tokens=12000`. Thinking-off is non-reproducible on this endpoint
(`results/frame_read_audit.json`) and the "thinking-on runs away" finding only
held for 24-cell contact sheets at a small token budget.

The endpoint exposes one multimodal model (`GET /v1/models` -> deepseek-v4.1-flash),
so no second-model vote is possible. No key is stored in the repo: pass
`SCAN_KEY`.

Usage
-----
  # record (serial: parallel requests to this endpoint time out)
  SCAN_KEY=... python3 calibrate_shot_reader.py --frames /tmp/x2frames \\
      --out results/calib_thinking_on.jsonl

  # regenerate the summary from a recorded file (no network)
  python3 calibrate_shot_reader.py --summarize results/calib_thinking_on.jsonl \\
      --json results/calib_thinking_on_summary.json
"""
import argparse
import base64
import collections
import json
import os
import re
import subprocess
import sys
import time

API_DEFAULT = "https://vllm.dpn.chat/v1/chat/completions"
MODEL_DEFAULT = "deepseek-v4.1-flash"
HERE = os.path.dirname(os.path.abspath(__file__))

PROMPT = (
    "Soccer broadcast frame. Describe the goalmouth action in one sentence, then answer on a new line: "
    "ACTION=<goal_mouth_shot|keeper_save|ball_in_net|celebration|open_play|closeup_elsewhere>. "
    "A shot means the ball is travelling toward the goal mouth or a keeper/defender is reacting to a shot "
    "in the goal area."
)
SHOT_CLASSES = {"goal_mouth_shot", "keeper_save"}
SHOT_EVIDENCE = {"saved", "blocked", "wide"}
ACTION_RE = re.compile(r"ACTION\s*=\s*([a-z_]+)", re.I)
TS_RE = re.compile(r"t=(\d+)")


def ask(frames, t, api, key, model, max_tokens, timeout):
    path = os.path.join(frames, "f_%04d.jpg" % t)
    if not os.path.exists(path):
        return {"error": "missing frame %s" % path}
    b64 = base64.b64encode(open(path, "rb").read()).decode()
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
        ]}],
        "max_tokens": max_tokens,
        "temperature": 0,
        "chat_template_kwargs": {"enable_thinking": True},
    }
    t0 = time.time()
    r = subprocess.run(
        ["curl", "-sS", "-m", str(timeout), api,
         "-H", "Content-Type: application/json",
         "-H", "Authorization: Bearer " + key,
         "--data-binary", "@-"],
        input=json.dumps(payload), capture_output=True, text=True)
    rec: dict = {"elapsed_s": round(time.time() - t0, 1)}
    if r.returncode != 0:
        rec["error"] = "curl rc=%s %s" % (r.returncode, r.stderr[:120])
        return rec
    try:
        data = json.loads(r.stdout)
        ch = data["choices"][0]
        content = ((ch.get("message") or {}).get("content") or "").strip()
        m = ACTION_RE.search(content)
        rec.update({
            "finish_reason": ch.get("finish_reason"),
            "content": content,
            "completion_tokens": (data.get("usage") or {}).get("completion_tokens"),
            "class": m.group(1).lower() if m else None,
        })
    except Exception as exc:
        rec["error"] = "parse %s %s" % (exc, r.stdout[:120])
    return rec


def sampled_seconds(win):
    lo, hi = win["t_start"], win["t_end"]
    named = sorted({int(x) for x in TS_RE.findall(win.get("frames") or "") if lo <= int(x) <= hi})
    if len(named) >= 2:
        return named[:3]
    mid = (lo + hi) // 2
    return sorted({max(lo, mid - 1), mid, min(hi, mid + 1)})


def load(path):
    out = []
    for line in open(path):
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def summarize(records):
    shot_wins = {r["id"] for r in records if r.get("group") == "shot"}
    control_wins = {r["id"] for r in records if r.get("group") == "control"}
    p1 = [r for r in records if r.get("pass") == 1]
    p2 = [r for r in records if r.get("pass") == 2]

    shot_by_win = collections.defaultdict(list)
    for r in p1:
        if r.get("group") == "shot":
            shot_by_win[r["id"]].append(r.get("class"))
    reproduced = sorted(k for k, v in shot_by_win.items() if any(c in SHOT_CLASSES for c in v))
    missed = sorted(set(shot_by_win) - set(reproduced))

    control_seconds = [r for r in p1 if r.get("group") == "control"]
    control_shot = [r for r in control_seconds if r.get("class") in SHOT_CLASSES]

    repeat_pairs = []
    p1_index = {(r["id"], r["t"]): r for r in p1}
    # A repeat read can fail (endpoint 502) and be retried; keep the last
    # successful record per (window, second) so retries do not double-count.
    p2_best = {}
    for r in p2:
        if r.get("class"):
            p2_best[(r["id"], r["t"])] = r
    p2_failed = sorted({(r["id"], r["t"]) for r in p2 if not r.get("class")} - set(p2_best))
    for (wid, t), r in p2_best.items():
        first = p1_index.get((wid, t))
        if first:
            repeat_pairs.append({
                "id": wid, "t": t,
                "pass1": first.get("class"), "pass2": r.get("class"),
                "agree": first.get("class") == r.get("class"),
            })
    agree = [p for p in repeat_pairs if p["agree"]]

    elapsed = [r["elapsed_s"] for r in records if isinstance(r.get("elapsed_s"), (int, float))]
    finishes = collections.Counter(r.get("finish_reason") for r in records)
    return {
        "reader": {
            "model": MODEL_DEFAULT, "max_tokens": 12000, "temperature": 0,
            "enable_thinking": True, "frame": "2x (1280x720)", "api": API_DEFAULT,
        },
        "records": len(records),
        "finish_reasons": dict(finishes),
        "elapsed_s": {
            "min": min(elapsed) if elapsed else None,
            "max": max(elapsed) if elapsed else None,
            "mean": round(sum(elapsed) / len(elapsed), 1) if elapsed else None,
        },
        "repeatability": {
            "pairs": len(repeat_pairs), "agree": len(agree),
            "agreement_pct": round(100.0 * len(agree) / len(repeat_pairs), 1) if repeat_pairs else None,
            "failed_reads": [{"id": w, "t": t} for w, t in p2_failed],
            "pairs_detail": repeat_pairs,
        },
        "reproduction": {
            "shot_windows": len(shot_by_win),
            "windows_with_a_shot_second": len(reproduced),
            "reproduction_pct": round(100.0 * len(reproduced) / len(shot_by_win), 1) if shot_by_win else None,
            "reproduced": reproduced,
            "missed": missed,
            "per_window_classes": {k: v for k, v in sorted(shot_by_win.items())},
        },
        "control": {
            "windows": len(control_wins),
            "seconds_read": len(control_seconds),
            "shot_seconds": len(control_shot),
            "false_shot_pct": round(100.0 * len(control_shot) / len(control_seconds), 1) if control_seconds else None,
            "false_shot_detail": [{"id": r["id"], "t": r["t"], "class": r.get("class")} for r in control_shot],
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", help="dir with f_{t:04d}.jpg 2x frames")
    ap.add_argument("--manifest", default=os.path.join(HERE, "label-manifest.json"))
    ap.add_argument("--out", help="JSONL to append reads to")
    ap.add_argument("--summarize", help="summarize an existing JSONL (no network)")
    ap.add_argument("--json", help="write the summary JSON here")
    ap.add_argument("--max-tokens", type=int, default=12000)
    ap.add_argument("--timeout", type=int, default=180)
    args = ap.parse_args()

    if args.summarize:
        summary = summarize(load(args.summarize))
        text = json.dumps(summary, indent=1)
        if args.json:
            with open(args.json, "w") as fh:
                fh.write(text + "\n")
        print(text)
        return

    if not (args.frames and args.out):
        sys.exit("pass --frames and --out, or --summarize")
    key = os.environ.get("SCAN_KEY")
    if not key:
        sys.exit("SCAN_KEY is required (no key is stored in the repo)")
    api = os.environ.get("SCAN_API", API_DEFAULT)
    model = os.environ.get("SCAN_MODEL", MODEL_DEFAULT)

    manifest = json.load(open(args.manifest))
    done = {(r["id"], r["t"], r["pass"]) for r in load(args.out)} if os.path.exists(args.out) else set()
    shot_wins = [w for w in manifest["windows"]
                 if w["ground_truth"] == "no_goal" and w.get("evidence") in SHOT_EVIDENCE]
    control_wins = [w for w in manifest["windows"]
                    if w["ground_truth"] == "no_goal" and w.get("evidence") == "none"]

    with open(args.out, "a") as fh:
        def emit(rec):
            fh.write(json.dumps(rec) + "\n")
            fh.flush()
            print(json.dumps({k: rec.get(k) for k in ("id", "t", "pass", "class", "finish_reason", "elapsed_s")}),
                  flush=True)

        for group, wins in (("shot", shot_wins), ("control", control_wins)):
            for w in wins:
                for t in sampled_seconds(w):
                    if (w["id"], t, 1) in done:
                        continue
                    rec: dict = {"id": w["id"], "group": group, "evidence": w.get("evidence"), "t": t, "pass": 1}
                    rec.update(ask(args.frames, t, api, key, model, args.max_tokens, args.timeout))
                    emit(rec)
                    time.sleep(0.5)

        shot_seconds = sorted({r["t"] for r in load(args.out)
                               if r.get("pass") == 1 and r.get("class") in SHOT_CLASSES})
        by_t = {r["t"]: r for r in load(args.out) if r.get("pass") == 1}
        for t in shot_seconds:
            src = by_t[t]
            if (src["id"], t, 2) in done:
                continue
            rec: dict = {"id": src["id"], "group": src.get("group"), "evidence": src.get("evidence"), "t": t, "pass": 2}
            rec.update(ask(args.frames, t, api, key, model, args.max_tokens, args.timeout))
            emit(rec)
            time.sleep(0.5)


if __name__ == "__main__":
    main()

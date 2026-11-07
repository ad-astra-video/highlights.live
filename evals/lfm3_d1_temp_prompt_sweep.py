#!/usr/bin/env python3
"""ADAAAA-8245 follow-up: d1-Omni-2B temperature + primitive/wording sweep.

The CEO asked to "explore the d1 model more with different temps and research
online for how others are prompting it".  Two facts constrain that:

* llama.cpp's /v1/systemone does not sample tokens.  It reads the answer off
  the label logits and applies a *calibration temperature* taken from GGUF
  metadata (`lfm3.decision.temperature.*` = 3.3829832 in d1-Omni-2B-Q8_0).
  For any request that carries media (audio/image) the server pins that
  temperature to 1.0 unless the GGUF also carries `lfm3.decision.temperature.image`;
  this build's GGUF does not, and `--override-kv` of an absent key is a no-op
  (verified: byte-identical probabilities for image=0.5/3.38/absent).
* Liquid's own card says the model "reads its answers from a single forward
  pass, so there are no sampling parameters to set".

So a *request-level* temperature sweep is not possible, and a temperature that
did exist would only rescale confidence (softmax sharpness), not reorder
candidates.  This script therefore measures what is actually controllable:

  arm=temp_sens   : threshold sweep + simulated temperature rescale of the
                    recorded T=1.0 probabilities (monotone transform check)
  arm=noul_base   : the Phase-1 three noul questions (control)
  arm=noul_event  : event-framed noul questions ("did a goal just happen")
  arm=choice_goal : one `choice` question with criteria (Liquid's recommended
                    primitive for pick-one-from-many)
  arm=score_crowd : one `score` question with a 3-level crowd-intensity rubric
                    (Liquid's documented primitive for degree/intensity)

CPU only, 0 GPU, 0 Livepeer calls, no production writes.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import statistics
import subprocess
import sys
import time
import urllib.request

NEGATIVE_PHASES = {"off_target", "warm_up"}

ARMS = {
    "noul_base": {
        "crowd_eruption": {"type": "noul", "instructions": "Does this clip contain an audible surge of crowd noise, an eruption rather than steady ambience?"},
        "whistle": {"type": "noul", "instructions": "Is a referee whistle clearly audible in this clip?"},
        "commentary_excited": {"type": "noul", "instructions": "Is the commentator's voice raised excitedly in this clip?"},
    },
    "noul_event": {
        "goal_scored": {"type": "noul", "instructions": "Did a team score a goal in this clip?"},
        "crowd_celebration": {"type": "noul", "instructions": "Is the crowd erupting in celebration in this clip, as after a goal?"},
    },

    "noul_criteria": {
        "goal_eruption": {
            "type": "noul",
            "instructions": "Does this clip capture the moment a goal is scored?",
            "criteria": {
                "yes": "Crowd noise rises sharply in celebration right after the ball crosses the line, the commentator's voice rises, and players may be seen celebrating",
                "no": "Match play, warm-up, or crowd noise that continues without a sudden celebratory roar",
            },
        },
        "whistle": {
            "type": "noul",
            "instructions": "Is a referee whistle audible in this clip?",
            "criteria": {
                "yes": "A short high-pitched whistle blast is clearly audible",
                "no": "No referee whistle can be heard above the crowd and commentary",
            },
        },
    },
    "choice_goal2": {
        "outcome2": {
            "type": "choice",
            "instructions": "Which best describes what happens in this clip?",
            "criteria": {
                "goal_celebration": "A goal was scored and the crowd erupts in celebration",
                "no_goal": "No goal: ordinary play, warm-up, or crowd noise without a celebration",
            },
        }
    },
    "choice_goal": {
        "outcome": {
            "type": "choice",
            "instructions": "Which best describes what happens in this clip?",
            "criteria": {
                "goal_celebration": "A goal was scored: the crowd erupts in celebration, the commentator shouts, a whistle may blow",
                "routine_play": "Ordinary play or a routine passage: steady crowd ambience, no celebration",
                "off_target_or_warmup": "Warm-up, training, crowd noise with no match action, or action away from the goal",
            },
        }
    },
    "score_crowd": {
        "crowd_level": {
            "type": "score",
            "instructions": "How strong is the crowd's reaction in this clip?",
            "criteria": [
                "Steady ambience: ordinary background crowd noise, no reaction",
                "Mild reaction: some noise rising, applause, or a short chant",
                "Goal eruption: a sudden loud roar celebrating a goal",
            ],
        }
    },
}

# gate score per arm -> list of answer keys max'd together
GATE_KEYS = {
    "noul_base": ["crowd_eruption", "whistle"],
    "noul_event": ["goal_scored", "crowd_celebration"],
    "noul_criteria": ["goal_eruption", "whistle"],
    "choice_goal": ["outcome.goal_celebration"],
    "choice_goal2": ["outcome2.goal_celebration"],
    "score_crowd": ["crowd_level.score"],
}


def http_json(url: str, payload: dict, timeout: float) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def extract_wav(path: str, start_s: float, dur_s: float, timeout: float = 90.0) -> bytes:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, start_s):.3f}",
           "-t", f"{dur_s:.3f}", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "-"]
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"ffmpeg failed rc={r.returncode}: {r.stderr[:200]!r}")
    return r.stdout


def pct(values: list[float], q: float) -> float:
    s = sorted(values)
    if not s:
        return 0.0
    if len(s) == 1:
        return round(s[0], 1)
    k = (len(s) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 1)


def parse_answer(resp: dict) -> dict:
    """Flatten a systemone response into {answerKey: scalar}."""
    out: dict[str, float] = {}
    answers = resp.get("answers") or {}
    for name, a in answers.items():
        if not isinstance(a, dict):
            continue
        t = a.get("type")
        if t == "noul":
            out[name] = float(a.get("noul", float("nan")))
        elif t == "score":
            out[name + ".score"] = float(a.get("score", float("nan")))
            for k, v in (a.get("probabilities") or {}).items():
                out[f"{name}.p{k}"] = float(v)
        elif t == "choice":
            out[name + ".choice"] = a.get("choice")
            for k, v in (a.get("probabilities") or {}).items():
                out[f"{name}.{k}"] = float(v)
    return out


def gate_score(row: dict, arm: str) -> float:
    ans = row.get("answers") or {}
    vals = []
    for key in GATE_KEYS[arm]:
        v = ans.get(key)
        if isinstance(v, (int, float)) and not (isinstance(v, float) and math.isnan(v)):
            vals.append(float(v))
    return max(vals) if vals else float("nan")


def evaluate(rows: list[dict], arm: str, threshold: float, temp: float = 1.0) -> dict:
    """Clip-level AC1/AC2 for one operating threshold.

    temp rescales the recorded probabilities as if the softmax temperature were
    T=temp instead of 1.0 (implied-logit approximation, sensitivity analysis only).
    """
    def score_of(r: dict) -> float:
        s = gate_score(r, arm)
        if math.isnan(s) or temp == 1.0:
            return s
        if arm == "score_crowd":
            # score is already on its rubric scale; leave it alone
            return s
        eps = 1e-6
        p = min(max(s, eps), 1 - eps)
        d = math.log(p / (1 - p))          # implied logit gap at T=1
        p2 = 1.0 / (1.0 + math.exp(-d / temp))
        return p2

    def rejected(r: dict) -> bool:
        s = score_of(r)
        return math.isnan(s) or s < threshold

    accepted = [r for r in rows if "error" not in r and r["gemmaAccepted"]]
    neg_clip_ids = sorted({r["clipId"] for r in accepted if r["clipPhase"] in NEGATIVE_PHASES})
    pos_clip_ids = sorted({r["clipId"] for r in accepted if r["clipIsHighlight"]})
    neg_elim = [c for c in neg_clip_ids if all(rejected(r) for r in accepted if r["clipId"] == c)]
    pos_lost = [c for c in pos_clip_ids if all(rejected(r) for r in accepted if r["clipId"] == c)]

    pos_acc = sum(1 for r in accepted if r["clipIsHighlight"])
    kept_pos = sum(1 for r in accepted if r["clipIsHighlight"] and not rejected(r))
    kept_neg = sum(1 for r in accepted if not r["clipIsHighlight"] and not rejected(r))
    precision = kept_pos / (kept_pos + kept_neg) if (kept_pos + kept_neg) else None

    return {
        "threshold": round(threshold, 3),
        "temp": temp,
        "ac1": f"{len(neg_elim)}/{len(neg_clip_ids)}",
        "ac1_n": len(neg_elim),
        "negClipsEliminated": neg_elim,
        "ac2": f"{len(pos_clip_ids) - len(pos_lost)}/{len(pos_clip_ids)}",
        "posClipsLost": pos_lost,
        "candidatesKept": kept_pos + kept_neg,
        "positivesKept": f"{kept_pos}/{pos_acc}",
        "precisionProjection": round(precision, 3) if precision is not None else None,
    }


def sweep_thresholds(rows: list[dict], arm: str, temps: tuple[float, ...] = (1.0,)) -> dict:
    best = None
    table = []
    steps = [round(0.02 * i, 2) for i in range(1, 50)]          # 0.02 .. 0.98
    if arm == "score_crowd":
        steps = [round(0.05 * i, 2) for i in range(1, 41)]      # 0.05 .. 2.00 on the 0-2 rubric
    for temp in temps:
        for t in steps:
            m = evaluate(rows, arm, t, temp)
            table.append(m)
            key = (m["ac1_n"], -len(m["posClipsLost"]))
            if best is None or key > best[0]:
                best = (key, m)
    # feasible = AC1 >= 3 negatives AND 0 positive clips lost
    feasible = [m for m in table if m["ac1_n"] >= 3 and not m["posClipsLost"]]
    safe = [m for m in table if not m["posClipsLost"]]
    best_safe = max(safe, key=lambda m: (m["ac1_n"], m["precisionProjection"] or 0)) if safe else None
    return {
        "steps": len(table),
        "best": best[1] if best else None,
        "best_safe": best_safe,
        "feasible_operating_points": feasible[:5],
        "feasible_count": len(feasible),
    }


def auc(rows: list[dict], arm: str) -> float | None:
    pos = [gate_score(r, arm) for r in rows if "error" not in r and r["gemmaAccepted"] and r["clipIsHighlight"]]
    neg = [gate_score(r, arm) for r in rows if "error" not in r and r["gemmaAccepted"] and not r["clipIsHighlight"]]
    pos = [v for v in pos if not math.isnan(v)]
    neg = [v for v in neg if not math.isnan(v)]
    if not pos or not neg:
        return None
    wins = 0.0
    for p in pos:
        for n in neg:
            wins += 1.0 if p > n else 0.5 if p == n else 0.0
    return round(wins / (len(pos) * len(neg)), 4)


def summarize(rows: list[dict], arm: str) -> dict:
    scored = [r for r in rows if "error" not in r]
    lat = [r["latencyMs"] for r in scored]
    s = {
        "arm": arm,
        "candidates": len(rows),
        "scored": len(scored),
        "errors": len(rows) - len(scored),
        "latency": {"p50": pct(lat, 0.50), "p95": pct(lat, 0.95), "max": round(max(lat), 1) if lat else 0.0},
        "auc_candidate": auc(rows, arm),
        "gate": GATE_KEYS[arm],
    }
    s["thresholdSweep"] = sweep_thresholds(rows, arm)
    if arm != "score_crowd":
        s["temperatureSensitivity"] = sweep_thresholds(rows, arm, temps=(0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 4.0))
    per_answer = {}
    for key in sorted({k for r in scored for k in (r.get("answers") or {})}):
        vals = [r["answers"][key] for r in scored if isinstance((r.get("answers") or {}).get(key), (int, float))]
        if vals:
            per_answer[key] = {
                "posMean": round(statistics.mean([r["answers"][key] for r in scored if r["clipIsHighlight"] and isinstance((r.get("answers") or {}).get(key), (int, float))] or [0]), 3),
                "negMean": round(statistics.mean([r["answers"][key] for r in scored if not r["clipIsHighlight"] and isinstance((r.get("answers") or {}).get(key), (int, float))] or [0]), 3),
                "min": round(min(vals), 3), "max": round(max(vals), 3),
            }
    s["perAnswer"] = per_answer
    return s


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", required=True)
    ap.add_argument("--candidates", default="/tmp/inc9-candidates-49.json")
    ap.add_argument("--arms", default="noul_base,noul_event,choice_goal,score_crowd,noul_criteria")
    ap.add_argument("--wav-cache", default="/tmp/d1_wav_cache")
    ap.add_argument("--pre-win", type=float, default=2.0)
    ap.add_argument("--post-win", type=float, default=2.0)
    ap.add_argument("--out-dir", default="/tmp/d1sweep")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--timeout", type=float, default=240.0)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    os.makedirs(args.wav_cache, exist_ok=True)
    rows = json.load(open(args.candidates))
    if args.limit:
        rows = rows[: args.limit]
    arms = [a for a in args.arms.split(",") if a]

    def wav_path(r: dict) -> str:
        name = f"{r['clipId']}_{r['ts']:.2f}_{args.pre_win}_{args.post_win}.wav".replace("/", "_")
        return os.path.join(args.wav_cache, name)

    def wav_b64(r: dict) -> str:
        p = wav_path(r)
        if os.path.exists(p) and os.path.getsize(p) > 1000:
            return base64.b64encode(open(p, "rb").read()).decode()
        start = max(0.0, r["ts"] - args.pre_win)
        wav = extract_wav(r["clipPath"], start, args.post_win + args.pre_win)
        open(p, "wb").write(wav)
        return base64.b64encode(wav).decode()

    # warm-up on the first candidate so the first scored row is not the cold one
    b64 = wav_b64(rows[0])
    for i in range(2):
        http_json(f"{args.server}/v1/systemone", {"state": "", "files": [f"data:audio/wav;base64,{b64}"],
                                                  "questions": ARMS["noul_base"]}, args.timeout)
    print("warmup done", flush=True)

    for arm in arms:
        out_rows = []
        t_start = time.time()
        for n, r in enumerate(rows, 1):
            rec = dict(r)
            try:
                payload = {"state": "", "files": [f"data:audio/wav;base64,{b64}"], "questions": ARMS[arm]}
                b64 = wav_b64(r)
                payload["files"] = [f"data:audio/wav;base64,{b64}"]
                t0 = time.perf_counter()
                resp = http_json(f"{args.server}/v1/systemone", payload, args.timeout)
                rec["latencyMs"] = round((time.perf_counter() - t0) * 1000.0, 1)
                rec["answers"] = parse_answer(resp)
                rec["raw"] = json.dumps(resp)[:800]
            except Exception as e:  # noqa: BLE001
                rec["error"] = f"{type(e).__name__}: {e}"
            out_rows.append(rec)
            if n % 10 == 0 or n == len(rows):
                print(f"{arm} [{n}/{len(rows)}] gate={gate_score(rec, arm)} {rec.get('latencyMs')}ms "
                      f"err={rec.get('error','')[:80]}", flush=True)
        jsonl = os.path.join(args.out_dir, f"d1_{arm}.jsonl")
        with open(jsonl, "w") as f:
            for rec in out_rows:
                f.write(json.dumps(rec) + "\n")
        summ = summarize(out_rows, arm)
        summ["wallSeconds"] = round(time.time() - t_start, 1)
        with open(os.path.join(args.out_dir, f"d1_{arm}_summary.json"), "w") as f:
            json.dump(summ, f, indent=2)
        print(f"=== {arm} summary ===\n" + json.dumps(summ, indent=2)[:4000], flush=True)
        b64 = None
    print("DONE", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Latency-floor probe for the LFM3-Omni CPU pre-gate (ADAAAA-8245 AC3).

The primary eval (evals/lfm3_predicate_eval.py) measures the pre-gate with the
few-shot JSON answer shape (all four predicates in one reply). AC3 asks whether
the *added gate* can fit 300 ms p95 per candidate. This probe measures the
cheapest answer shape that still yields a yes/no gate signal — a 4-token
"y/n y/n y/n" reply — so the verdict does not depend on prompt verbosity.

    python3 evals/lfm3_latency_floor_probe.py
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import statistics
import sys
import time
import urllib.request

SERVER = os.environ.get("LFM3_URL", "http://127.0.0.1:8099")
PROMPT = """Listen to the audio. Answer with three letters separated by spaces, nothing else.
Format: <crowd> <whistle> <commentary>
Use y for yes, n for no.
crowd = crowd eruption (loud surge of crowd noise)
whistle = referee whistle
commentary = excited raised commentator voice
Example answer: n n y"""


def wav(path: str, start: float, dur: float) -> str:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}",
                        "-t", f"{dur:.3f}", "-i", path, "-vn", "-ac", "1", "-ar", "16000",
                        "-f", "wav", "-"], capture_output=True)
    return base64.b64encode(r.stdout).decode()


def ask(audio_b64: str) -> tuple[str, float]:
    payload = {
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPT},
            {"type": "input_audio", "input_audio": {"data": audio_b64, "format": "wav"}},
        ]}],
        "temperature": 0.0, "max_tokens": 8, "cache_prompt": False,
    }
    req = urllib.request.Request(SERVER.rstrip("/") + "/v1/chat/completions",
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    resp = json.loads(urllib.request.urlopen(req, timeout=180).read().decode())
    ms = (time.perf_counter() - t0) * 1000.0
    return (resp["choices"][0]["message"].get("content") or "").strip(), ms


def pct(xs, q):
    s = sorted(xs)
    k = (len(s) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 1)


def main() -> int:
    manifest = json.load(open("evals/label-manifest.json"))
    trace = json.load(open("evals/inc9-trace-frames.json"))
    clips = {c["id"]: c for c in manifest["clips"]}
    cands = [e for e in trace["events"] if e.get("type") == "candidate"]
    lat, rows = [], []
    for i, c in enumerate(cands, 1):
        cl = clips[c["clipId"]]
        path = cl["source"].split(":", 2)[2]
        ts = float(c["timestamp"])
        start = max(0.0, ts - 2.0)
        a = wav(path, start, ts + 2.0 - start)
        txt, ms = ask(a)
        lat.append(ms)
        rows.append({"clipId": c["clipId"], "ts": ts, "answer": txt, "latencyMs": round(ms, 1)})
        print(f"[{i}/{len(cands)}] {c['clipId']}@{ts} {txt!r} {ms:.0f}ms", flush=True)
    out = {
        "shape": "single request, 4-token 'crowd whistle commentary' y/n answer",
        "n": len(lat),
        "p50_ms": pct(lat, 0.50),
        "p95_ms": pct(lat, 0.95),
        "max_ms": max(lat),
        "mean_ms": round(statistics.fmean(lat), 1),
        "bar_p95_ms": 300,
        "pass": pct(lat, 0.95) <= 300,
        "rows": rows,
    }
    json.dump(out, open("evals/lfm3-phase1-latency-floor.json", "w"), indent=2)
    print(json.dumps({k: v for k, v in out.items() if k != "rows"}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

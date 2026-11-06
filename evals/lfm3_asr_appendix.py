"""ASR appendix for ADAAAA-8245 Phase 1: LFM3-Omni ASR vs the deployed
faster-whisper `base` int8 baseline (CPU), on the same 10 labeled clips.

Adoption bar (appendix): WER <= baseline AND p95 <= 0.70 s/clip.
There is no human reference transcript for these clips, so WER is computed
between the two models (baseline transcript = reference) and reported as
cross-model disagreement; the limitation is recorded in the summary.

    python3 evals/lfm3_asr_appendix.py
"""

from __future__ import annotations

import base64
import difflib
import json
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.request

LFM3 = os.environ.get("LFM3_URL", "http://127.0.0.1:8099")
ASR = os.environ.get("ASR_URL", "http://172.20.0.4:8082")


def full_wav(path: str) -> str:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
                        "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "-"],
                       capture_output=True, timeout=120)
    return base64.b64encode(r.stdout).decode()


def post(url: str, payload: dict, timeout: float = 180) -> tuple[dict, float]:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    resp = json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode())
    return resp, (time.perf_counter() - t0) * 1000


def norm_words(t: str) -> list[str]:
    t = t.lower()
    t = re.sub(r"[^a-z0-9' ]+", " ", t)
    return [w for w in t.split() if w]


def wer(ref: str, hyp: str) -> float:
    r, h = norm_words(ref), norm_words(hyp)
    if not r:
        return 0.0 if not h else 1.0
    sm = difflib.SequenceMatcher(a=r, b=h, autojunk=False)
    ops = sm.get_opcodes()
    edits = 0
    for tag, i1, i2, j1, j2 in ops:
        if tag != "equal":
            edits += max(i2 - i1, j2 - j1)
    return round(edits / len(r), 4)


def pct(xs, q):
    s = sorted(xs)
    k = (len(s) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 1)


def main() -> int:
    clips = [c for c in json.load(open("evals/label-manifest.json"))["clips"]]
    rows, lat_l, lat_b, wers = [], [], [], []
    for c in clips:
        path = c["source"].split(":", 2)[2]
        a = full_wav(path)
        # LFM3-Omni ASR (model card: system prompt "Perform ASR in <language>.")
        payload = {"messages": [
            {"role": "system", "content": "Perform ASR in English."},
            {"role": "user", "content": [{"type": "input_audio",
                                          "input_audio": {"data": a, "format": "wav"}}]},
        ], "temperature": 0.0, "max_tokens": 400, "cache_prompt": False}
        lr, lms = post(LFM3.rstrip("/") + "/v1/chat/completions", payload)
        ltxt = (lr["choices"][0]["message"].get("content") or "").strip()
        # deployed baseline
        br, bms = post(ASR.rstrip("/") + "/transcribe", {"audio": a, "sample_rate": 16000})
        btxt = (br.get("text") or br.get("transcript") or "").strip()
        w = wer(btxt, ltxt)
        wers.append(w)
        lat_l.append(lms)
        lat_b.append(bms)
        rows.append({"clipId": c["id"], "phase": c.get("phase"),
                     "lfm3Text": ltxt, "baselineText": btxt, "wer": w,
                     "lfm3LatencyMs": round(lms, 1), "baselineLatencyMs": round(bms, 1)})
        print(f"{c['id']}: WER={w} lfm3={lms:.0f}ms base={bms:.0f}ms", flush=True)
        print(f"  lfm3: {ltxt[:160]!r}")
        print(f"  base: {btxt[:160]!r}", flush=True)

    out = {
        "n": len(rows),
        "werReference": "deployed faster-whisper base int8 transcript (no human reference available)",
        "werMean": round(statistics.fmean(wers), 4),
        "werMedian": round(statistics.median(wers), 4),
        "lfm3_p50_ms": pct(lat_l, 0.5), "lfm3_p95_ms": pct(lat_l, 0.95),
        "baseline_p50_ms": pct(lat_b, 0.5), "baseline_p95_ms": pct(lat_b, 0.95),
        "bar_p95_ms": 700,
        "lfm3Pass": pct(lat_l, 0.95) <= 700,
        "rows": rows,
    }
    json.dump(out, open("evals/lfm3-phase1-asr.json", "w"), indent=2)
    print(json.dumps({k: v for k, v in out.items() if k != "rows"}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

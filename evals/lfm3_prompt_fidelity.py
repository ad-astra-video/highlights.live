#!/usr/bin/env python3
"""ADAAAA-8245 follow-up: prompting-fidelity probe for LFM3-Omni outcomes.

Liquid's own guidance (docs.liquid.ai, retrieved 2026-11-07) says two different
things depending on what "outcome" means:

* LFM3-Omni-2B chat, audio understanding, multiple choice
  system: "Answer questions about the provided audio clip. Base every answer
  only on what can be heard."
  user:   the choices in the text part, ending with the exact sentence
  "Please choose the answer from the options."
  Text output is greedy; the model is non-reasoning (`--reasoning off`).

* Bounded outcomes with probabilities
  Liquid does not recommend chat prompting for these. d1-Omni-2B is a 2.17B
  decision model built on the same LFM3-Omni-2B backbone that answers
  noul/choice/score questions over audio in one forward pass, with zero output
  tokens and calibrated probabilities, served by llama.cpp 0.8.0+ at
  /v1/systemone.

This probe replays the same 49 INC-9 Stage-A candidates used by
evals/lfm3_predicate_eval.py under either prompt shape so the Phase 1 verdict
can be attributed to the signal rather than to an off-spec prompt.

  arm=chat  vendor multiple-choice prompt, one request per candidate
  arm=d1    d1-Omni-2B noul questions (crowd eruption, whistle, excited
            commentary) in a single /v1/systemone call per candidate

CPU only. 0 GPU, 0 Livepeer calls, no production writes.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.request


CHAT_SYSTEM = (
    "Answer questions about the provided audio clip. "
    "Base every answer only on what can be heard. Respond in text."
)

CHAT_QUESTIONS = ("crowd_eruption", "whistle", "commentary_excited")

# One question per request: the model collapses a numbered multi-question
# block into a single answer, so each noul-equivalent is asked as its own
# vendor-format multiple-choice turn.
CHAT_PROMPTS = {
    "crowd_eruption": (
        "Did an audible surge of crowd noise (an eruption, not steady ambience) "
        "occur in this clip?\nA. yes\nB. no\nPlease choose the answer from the options."
    ),
    "whistle": (
        "Was a referee whistle clearly audible in this clip?\n"
        "A. yes\nB. no\nPlease choose the answer from the options."
    ),
    "commentary_excited": (
        "Was the commentator's voice raised excitedly in this clip?\n"
        "A. yes\nB. no\nPlease choose the answer from the options."
    ),
}

D1_QUESTIONS = {
    "crowd_eruption": {
        "type": "noul",
        "instructions": "Does this clip contain an audible surge of crowd noise, an eruption rather than steady ambience?",
    },
    "whistle": {
        "type": "noul",
        "instructions": "Is a referee whistle clearly audible in this clip?",
    },
    "commentary_excited": {
        "type": "noul",
        "instructions": "Is the commentator's voice raised excitedly in this clip?",
    },
}

NEGATIVE_PHASES = {"off_target", "warm_up"}


def http_json(url: str, payload: dict, timeout: float) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def extract_wav(path: str, start_s: float, dur_s: float, timeout: float = 60.0) -> bytes:
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", f"{max(0.0, start_s):.3f}", "-t", f"{dur_s:.3f}",
        "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "-",
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"ffmpeg audio extract failed rc={r.returncode}: {r.stderr[:200]!r}")
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


def ask_chat(server: str, wav_b64: str, prompt: str, timeout: float) -> tuple[dict, float]:
    payload = {
        "messages": [
            {"role": "system", "content": CHAT_SYSTEM},
            {"role": "user", "content": [
                {"type": "input_audio", "input_audio": {"data": wav_b64, "format": "wav"}},
                {"type": "text", "text": prompt},
            ]},
        ],
        "temperature": 0,
        "max_tokens": 8,
        "cache_prompt": False,
    }
    t0 = time.perf_counter()
    resp = http_json(f"{server}/v1/chat/completions", payload, timeout)
    return resp, (time.perf_counter() - t0) * 1000.0


def ask_d1(server: str, wav_b64: str, timeout: float) -> tuple[dict, float]:
    # llama.cpp's systemone endpoint takes media in `files`/`images`
    # (an audio clip is accepted there); a top-level "audio" key is ignored.
    payload = {"state": "", "files": [f"data:audio/wav;base64,{wav_b64}"],
               "questions": D1_QUESTIONS}
    t0 = time.perf_counter()
    resp = http_json(f"{server}/v1/systemone", payload, timeout)
    return resp, (time.perf_counter() - t0) * 1000.0


def chat_text(resp: dict) -> str:
    try:
        return resp["choices"][0]["message"]["content"] or ""
    except Exception:  # noqa: BLE001
        return json.dumps(resp)[:400]


def parse_ab(text: str) -> str | None:
    """Parse a vendor-format multiple-choice answer: letter or yes/no word."""
    t = text.strip().lower()
    head = t[:60]
    if re.search(r"\byes\b", head):
        return "yes"
    if re.search(r"\bno\b", head):
        return "no"
    m = re.search(r"\b([ab])\b", head)
    if not m:
        return None
    return "yes" if m.group(1) == "a" else "no"


def d1_probs(resp: dict) -> dict:
    answers = resp.get("answers") or resp
    out: dict[str, float] = {}
    for name in D1_QUESTIONS:
        a = answers.get(name) if isinstance(answers, dict) else None
        if isinstance(a, dict):
            for key in ("noul", "probability", "prob", "score"):
                if isinstance(a.get(key), (int, float)):
                    out[name] = float(a[key])
                    break
        elif isinstance(a, (int, float)):
            out[name] = float(a)
    return out


def gate_chat(preds: dict) -> bool:
    return preds.get("crowd_eruption") == "yes" or preds.get("whistle") == "yes"


def summarize(rows: list[dict], arm: str, threshold: float) -> dict:
    scored = [r for r in rows if "error" not in r]
    lat = [r["latencyMs"] for r in scored]
    accepted = [r for r in scored if r["gemmaAccepted"]]

    by_phase: dict[str, list[dict]] = {}
    for r in accepted:
        by_phase.setdefault(r["clipPhase"], []).append(r)

    def rejected(r: dict) -> bool:
        if arm == "chat":
            return not gate_chat(r.get("predicates") or {})
        probs = r.get("probs") or {}
        return max([probs.get(k, 0.0) for k in ("crowd_eruption", "whistle")]) < threshold

    neg_rejected = {ph: sum(1 for r in rs if rejected(r)) for ph, rs in by_phase.items()
                    if ph in NEGATIVE_PHASES}
    neg_total = {ph: len(rs) for ph, rs in by_phase.items() if ph in NEGATIVE_PHASES}
    pos_lost = sum(1 for r in accepted if r["clipIsHighlight"] and rejected(r))
    pos_total = sum(1 for r in accepted if r["clipIsHighlight"])

    # AC2 is clip-level: a positive clip is lost when every accepted GOAL
    # inside it is rejected.
    pos_clip_ids = sorted({r["clipId"] for r in accepted if r["clipIsHighlight"]})
    pos_clips_lost = []
    for cid in pos_clip_ids:
        rs = [r for r in accepted if r["clipId"] == cid]
        if rs and all(rejected(r) for r in rs):
            pos_clips_lost.append(cid)

    # AC1 is clip-level: the clip's accepted GOALs are all rejected.
    neg_clip_ids = sorted({r["clipId"] for r in accepted if r["clipPhase"] in NEGATIVE_PHASES})
    neg_clips_eliminated = []
    for cid in neg_clip_ids:
        rs = [r for r in accepted if r["clipId"] == cid]
        if rs and all(rejected(r) for r in rs):
            neg_clips_eliminated.append(cid)

    summary = {
        "arm": arm,
        "threshold": threshold if arm == "d1" else None,
        "candidates": len(rows),
        "scored": len(scored),
        "errors": len(rows) - len(scored),
        "latency": {"p50": pct(lat, 0.50), "p95": pct(lat, 0.95),
                    "max": round(max(lat), 1) if lat else 0.0},
        "gemmaAccepted": len(accepted),
        "negativesRejected": neg_rejected,
        "negativesTotal": neg_total,
        "negativeClipsEliminated": neg_clips_eliminated,
        "negativeClipsTotal": len(neg_clip_ids),
        "ac1_clipLevel": f"{len(neg_clips_eliminated)}/{len(neg_clip_ids)}",
        "positiveClipsLost": pos_clips_lost,
        "positiveClipsTotal": len(pos_clip_ids),
        "ac2_clipLevel": f"{len(pos_clip_ids) - len(pos_clips_lost)}/{len(pos_clip_ids)}",
        "positivesLost": pos_lost,
        "positivesTotal": pos_total,
        "ac2_candidateLevel": f"{pos_total - pos_lost}/{pos_total}",
    }

    if arm == "chat":
        for name in CHAT_QUESTIONS:
            pos = [1 for r in accepted if r["clipIsHighlight"]
                   and (r.get("predicates") or {}).get(name) == "yes"]
            neg = [1 for r in accepted if not r["clipIsHighlight"]
                   and (r.get("predicates") or {}).get(name) == "yes"]
            summary.setdefault("yesRate", {})[name] = {
                "positives": f"{len(pos)}/{pos_total}",
                "negatives": f"{len(neg)}/{len(accepted) - pos_total}",
            }
    else:
        stats = {}
        for name in D1_QUESTIONS:
            pv = [r["probs"].get(name, 0.0) for r in accepted if r["probs"]]
            pp = [r["probs"].get(name, 0.0) for r in accepted if r["probs"] and r["clipIsHighlight"]]
            pn = [r["probs"].get(name, 0.0) for r in accepted if r["probs"] and not r["clipIsHighlight"]]
            stats[name] = {
                "posMean": round(statistics.mean(pp), 3) if pp else None,
                "negMean": round(statistics.mean(pn), 3) if pn else None,
                "posRange": [round(min(pp), 3), round(max(pp), 3)] if pp else None,
                "negRange": [round(min(pn), 3), round(max(pn), 3)] if pn else None,
            }
        summary["probStats"] = stats
        sweep = {}
        for t in (0.3, 0.4, 0.5, 0.6, 0.7):
            def rej_t(r: dict, t: float = t) -> bool:
                p = r.get("probs") or {}
                return max([p.get(k, 0.0) for k in ("crowd_eruption", "whistle")]) < t
            elim = [cid for cid in neg_clip_ids
                    if all(rej_t(r) for r in accepted if r["clipId"] == cid)]
            lost = [cid for cid in pos_clip_ids
                    if all(rej_t(r) for r in accepted if r["clipId"] == cid)]
            sweep[str(t)] = {"negClipsEliminated": len(elim), "posClipsLost": len(lost),
                             "ac1": f"{len(elim)}/{len(neg_clip_ids)}",
                             "ac2": f"{len(pos_clip_ids) - len(lost)}/{len(pos_clip_ids)}"}
        summary["thresholdSweep"] = sweep
    return summary


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--arm", choices=("chat", "d1"), required=True)
    ap.add_argument("--server", required=True, help="llama-server base URL")
    ap.add_argument("--candidates", required=True, help="49-row candidates.json")
    ap.add_argument("--threshold", type=float, default=0.5, help="noul gate threshold (d1)")
    ap.add_argument("--pre-win", type=float, default=2.0)
    ap.add_argument("--post-win", type=float, default=2.0)
    ap.add_argument("--warmup", type=int, default=2)
    ap.add_argument("--timeout", type=float, default=240.0)
    ap.add_argument("--out", required=True)
    ap.add_argument("--summary", required=True)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    rows = json.load(open(args.candidates))
    if args.limit:
        rows = rows[: args.limit]
    print(f"arm={args.arm} candidates={len(rows)} server={args.server}")

    def window(r: dict) -> bytes:
        start = max(0.0, r["ts"] - args.pre_win)
        end = r["ts"] + args.post_win
        return extract_wav(r["clipPath"], start, end - start)

    out_rows: list[dict] = []
    if args.warmup and rows:
        wav = base64.b64encode(window(rows[0])).decode()
        for i in range(args.warmup):
            try:
                if args.arm == "chat":
                    resp, ms = ask_chat(args.server, wav, CHAT_PROMPTS["crowd_eruption"], args.timeout)
                    print(f"warmup {i + 1}: {ms:.0f} ms {chat_text(resp)[:60]!r}")
                else:
                    resp, ms = ask_d1(args.server, wav, args.timeout)
                    print(f"warmup {i + 1}: {ms:.0f} ms {d1_probs(resp)}")
            except Exception as e:  # noqa: BLE001
                print(f"warmup FAILED: {type(e).__name__}: {e}", file=sys.stderr)
                return 2

    for n, r in enumerate(rows, 1):
        rec = dict(r)
        try:
            wav_b64 = base64.b64encode(window(r)).decode()
            if args.arm == "chat":
                preds: dict[str, str | None] = {}
                raws: dict[str, str] = {}
                per_q_ms: dict[str, float] = {}
                ms = 0.0
                for name, prompt in CHAT_PROMPTS.items():
                    resp, ms_q = ask_chat(args.server, wav_b64, prompt, args.timeout)
                    text = chat_text(resp)
                    preds[name] = parse_ab(text)
                    raws[name] = text[:80]
                    per_q_ms[name] = round(ms_q, 1)
                    ms += ms_q
                rec.update({"raw": raws, "predicates": preds, "perQuestionMs": per_q_ms})
            else:
                resp, ms = ask_d1(args.server, wav_b64, args.timeout)
                rec.update({"raw": json.dumps(resp)[:600], "probs": d1_probs(resp)})
            rec["latencyMs"] = round(ms, 1)
        except Exception as e:  # noqa: BLE001
            rec["error"] = f"{type(e).__name__}: {e}"
        out_rows.append(rec)
        print(f"[{n}/{len(rows)}] {r['clipId']}@{r['ts']} "
              f"{rec.get('predicates') or rec.get('probs')} {rec.get('latencyMs')}ms "
              f"err={rec.get('error', '')[:60]}")

    with open(args.out, "w") as f:
        for rec in out_rows:
            f.write(json.dumps(rec) + "\n")
    summary = summarize(out_rows, args.arm, args.threshold)
    with open(args.summary, "w") as f:
        json.dump(summary, f, indent=2)
    print("\n=== SUMMARY ===")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

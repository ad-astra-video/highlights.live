#!/usr/bin/env python3
"""LFM3-Omni CPU predicate pre-gate eval (ADAAAA-8245 Phase 1).

Replays the INC-9 Stage-A candidate population (evals/inc9-trace-frames.json,
49 candidates over the 10-clip INC-5 labeled set) through a CPU-only
llama.cpp serving of LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M, asking a closed-set
predicate question per candidate's trigger-window audio (and optionally its
anchor frame), and grades the pre-gate against the INC-9 Gemma decisions
already recorded in the trace.

No GPU, no Livepeer, no writes to the deployed pipeline. Pure measurement.

    python3 evals/lfm3_predicate_eval.py \
        --manifest evals/label-manifest.json \
        --trace evals/inc9-trace-frames.json \
        --server http://127.0.0.1:8099 \
        --out evals/lfm3-phase1-candidates.jsonl \
        --summary evals/lfm3-phase1-summary.json \
        --csv evals/lfm3-phase1-candidates.csv

Trigger window matches the INC-9 honest-audio convention in evals/drive_inc8.py
(crowd_energy_from_audio): [ts - 2.0s, ts + 2.0s], 16 kHz mono PCM.
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

PREDICATES = ("crowd_eruption", "whistle", "commentary_excited", "celebration_visible")

PREDICATE_PROMPT = """Grade this soccer broadcast clip on three audible signals and one visual signal.
Reply for a quiet warm-up clip would look like:
{{"crowd_eruption": "no", "whistle": "no", "commentary_excited": "no", "celebration_visible": "{celeb_example}"}}
Now reply for THIS clip in exactly the same JSON format. Fill each value with exactly one word: "yes" or "no". Never write both options in one value.
Signals:
- crowd_eruption: an audible surge of crowd noise (an eruption, not steady ambience)
- whistle: a referee whistle clearly audible
- commentary_excited: the commentator's voice raised excitedly{vis_note}
Reply with ONE single-line JSON object and nothing else."""

VIS_NOTE_WITH_IMAGE = (
    "\n- celebration_visible: players visibly celebrating the goal (arms raised, running "
    "together, hugging), seen in the provided frame"
)
VIS_NOTE_NO_IMAGE = "\n- celebration_visible: no image is provided, so always answer \"unknown\""
CELEB_EXAMPLE_WITH_IMAGE = "no"
CELEB_EXAMPLE_NO_IMAGE = "unknown"

PROB_PROMPT = (
    "Answer with exactly one word, yes or no: does this audio contain a crowd "
    "eruption or goal celebration (a loud sustained surge of crowd noise)?"
)


def http_json(url: str, payload: dict, timeout: float) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def resolve_clip_path(source: str, clip_root: str | None) -> str:
    """'host:livepeer-ai-x99:/home/brad/.../x.mp4' -> '/home/brad/.../x.mp4'."""
    p = source
    if p.startswith("host:"):
        p = p.split(":", 2)[2]
    if clip_root:
        p = os.path.join(clip_root, os.path.basename(p))
    return p


def clip_duration_s(path: str) -> float:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, timeout=20,
        )
        return float(r.stdout.decode().strip()) if r.stdout.strip() else 0.0
    except Exception:
        return 0.0


def extract_wav(path: str, start_s: float, dur_s: float, timeout: float = 60.0) -> bytes:
    """16 kHz mono s16le WAV bytes for [start_s, start_s+dur_s] (CPU ffmpeg)."""
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", f"{max(0.0, start_s):.3f}", "-t", f"{dur_s:.3f}",
        "-i", path, "-vn", "-ac", "1", "-ar", "16000",
        "-f", "wav", "-",
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"ffmpeg audio extract failed rc={r.returncode}: {r.stderr[:200]!r}")
    return r.stdout


def extract_jpeg(path: str, ts: float, width: int = 0, timeout: float = 30.0) -> bytes:
    vf = ["-vf", f"scale={width}:-2"] if width else []
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", f"{max(0.0, ts):.3f}", "-i", path,
        "-frames:v", "1", *vf, "-q:v", "4", "-f", "image2", "-",
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"ffmpeg frame extract failed rc={r.returncode}")
    return r.stdout


_JSON_RE = re.compile(r"\{[^{}]*\}", re.S)


def parse_predicates(text: str) -> dict:
    """Parse the single-line JSON object the model was asked for; tolerant of
    fences / stray prose, but never invents a 'yes'."""
    if not text:
        return {}
    cands = _JSON_RE.findall(text)
    if not cands:
        return {}
    for raw in reversed(cands):
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        out = {}
        for k in PREDICATES:
            v = obj.get(k)
            if isinstance(v, str):
                v = v.strip().lower()
                if v in ("yes", "no", "unknown"):
                    out[k] = v
        if out:
            return out
    return {}


def logprob_yes(resp: dict) -> float | None:
    """p('yes') from the first generated token's top_logprobs, or None."""
    try:
        tok = resp["choices"][0]["logprobs"]["content"][0]
    except Exception:
        return None
    best = None
    for alt in tok.get("top_logprobs") or []:
        t = (alt.get("token") or "").strip().lower().strip(".,!\"'")
        if t == "yes":
            best = alt.get("logprob")
            break
    if best is None:
        # fall back: if the chosen token itself is 'yes'
        t = (tok.get("token") or "").strip().lower().strip(".,!\"'")
        if t == "yes":
            best = tok.get("logprob")
    if best is None:
        return None
    return round(float(2.718281828459045 ** best), 6)


def ask(server: str, content: list, max_tokens: int, timeout: float,
        want_logprobs: bool = False) -> tuple[dict, float]:
    payload = {
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.0,
        "max_tokens": max_tokens,
        "stream": False,
        "cache_prompt": False,
    }
    if want_logprobs:
        payload.update({"logprobs": True, "top_logprobs": 5, "n_predict": 2})
    t0 = time.perf_counter()
    resp = http_json(server.rstrip("/") + "/v1/chat/completions", payload, timeout)
    return resp, (time.perf_counter() - t0) * 1000.0


def content_text(resp: dict) -> str:
    try:
        return (resp["choices"][0]["message"].get("content") or "").strip()
    except Exception:
        return ""


def pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    if len(s) == 1:
        return round(s[0], 1)
    k = (len(s) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 1)


def load_candidates(manifest_path: str, trace_path: str, clip_root: str | None):
    manifest = json.load(open(manifest_path))
    trace = json.load(open(trace_path))
    clips = {c["id"]: c for c in manifest["clips"]}
    events = trace["events"]
    cands, decs = {}, {}
    for e in events:
        if e.get("type") == "candidate":
            cands.setdefault(e["clipId"], []).append(e)
        elif e.get("type") == "decision":
            decs.setdefault(e["clipId"], []).append(e)

    rows = []
    for clip_id, cl in clips.items():
        cs = cands.get(clip_id, [])
        ds = decs.get(clip_id, [])
        if len(cs) != len(ds):
            print(f"WARN {clip_id}: {len(cs)} candidates vs {len(ds)} decisions", file=sys.stderr)
        for i, c in enumerate(cs):
            d = ds[i] if i < len(ds) else None
            rows.append({
                "clipId": clip_id,
                "clipPhase": cl.get("phase"),
                "clipIsHighlight": bool((cl.get("groundTruth") or {}).get("isHighlight")),
                "clipPath": resolve_clip_path(cl.get("source", ""), clip_root),
                "candidateIndex": i,
                "ts": float(c.get("timestamp", 0.0)),
                "eventType": c.get("eventType"),
                "gemmaAccepted": bool(((d or {}).get("decision") or {}).get("isHighlight")),
                "gemmaScore": ((d or {}).get("decision") or {}).get("score"),
                "gemmaReason": ((d or {}).get("decision") or {}).get("reason"),
                "gemmaTs": (d or {}).get("timestamp"),
            })
    return manifest, trace, clips, rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", default="evals/label-manifest.json")
    ap.add_argument("--trace", default="evals/inc9-trace-frames.json")
    ap.add_argument("--server", default=os.environ.get("LFM3_URL", "http://127.0.0.1:8099"))
    ap.add_argument("--clip-root", default=None)
    ap.add_argument("--pre-win", type=float, default=2.0)
    ap.add_argument("--post-win", type=float, default=2.0)
    ap.add_argument("--anchor-frame", action="store_true",
                    help="also send the frame at the candidate timestamp (vision predicate)")
    ap.add_argument("--frame-width", type=int, default=0,
                    help="downscale the anchor frame to this pixel width (0 = native)")
    ap.add_argument("--probs", action="store_true", default=True,
                    help="second pass: single yes/no question with logprobs for p(yes)")
    ap.add_argument("--no-probs", dest="probs", action="store_false")
    ap.add_argument("--warmup", type=int, default=3, help="unscored warmup requests")
    ap.add_argument("--timeout", type=float, default=180.0)
    ap.add_argument("--out", default="evals/lfm3-phase1-candidates.jsonl")
    ap.add_argument("--summary", default="evals/lfm3-phase1-summary.json")
    ap.add_argument("--csv", default="evals/lfm3-phase1-candidates.csv")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    manifest, trace, clips, rows = load_candidates(args.manifest, args.trace, args.clip_root)
    if args.limit:
        rows = rows[: args.limit]
    print(f"candidates={len(rows)} clips={len(clips)} server={args.server} anchor_frame={args.anchor_frame}")

    vis_note = VIS_NOTE_WITH_IMAGE if args.anchor_frame else VIS_NOTE_NO_IMAGE
    celeb_example = CELEB_EXAMPLE_WITH_IMAGE if args.anchor_frame else CELEB_EXAMPLE_NO_IMAGE
    prompt_text = PREDICATE_PROMPT.format(vis_note=vis_note, celeb_example=celeb_example)

    out_rows, lat_a, lat_b, errors = [], [], [], []
    scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or tempfile.mkdtemp(prefix="lfm3-8245-")

    def build_content(wav_b64: str, jpeg_b64: str | None) -> list:
        content: list = []
        if jpeg_b64:
            content.append({"type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{jpeg_b64}"}})
        content.append({"type": "text", "text": prompt_text})
        content.append({"type": "input_audio",
                        "input_audio": {"data": wav_b64, "format": "wav"}})
        return content

    # warmup (unscored) on the first candidate's audio so cold-start (model
    # load, first KV alloc, audio encoder graph) never lands in the p95.
    if args.warmup and rows:
        r0 = rows[0]
        dur = clip_duration_s(r0["clipPath"])
        start = max(0.0, r0["ts"] - args.pre_win)
        win = min(args.post_win, max(0.5, dur - r0["ts"])) if dur else args.post_win
        wav = base64.b64encode(extract_wav(r0["clipPath"], start, r0["ts"] + win - start)).decode()
        for i in range(args.warmup):
            try:
                resp, ms = ask(args.server, build_content(wav, None), 96, args.timeout)
                print(f"warmup {i + 1}: {ms:.0f} ms content={content_text(resp)[:80]!r}")
            except Exception as e:  # noqa: BLE001
                print(f"warmup FAILED: {e}", file=sys.stderr)
                return 2

    for n, r in enumerate(rows, 1):
        rec = dict(r)
        try:
            dur = clip_duration_s(r["clipPath"])
            start = max(0.0, r["ts"] - args.pre_win)
            end = r["ts"] + args.post_win
            if dur > 0:
                end = min(end, dur)
            dur_w = max(0.5, end - start)
            wav = extract_wav(r["clipPath"], start, dur_w)
            wav_b64 = base64.b64encode(wav).decode()
            jpeg_b64 = None
            if args.anchor_frame:
                jpeg_b64 = base64.b64encode(
                    extract_jpeg(r["clipPath"], r["ts"], args.frame_width)).decode()
            rec.update({"audioStartS": round(start, 3), "audioDurS": round(dur_w, 3),
                        "audioBytes": len(wav), "anchorFrame": bool(jpeg_b64)})

            resp, ms_a = ask(args.server, build_content(wav_b64, jpeg_b64), 96, args.timeout)
            preds = parse_predicates(content_text(resp))
            usage = resp.get("usage") or {}
            tm = resp.get("timings") or {}
            rec.update({
                "raw": content_text(resp)[:600],
                "predicates": preds,
                "latencyMs": round(ms_a, 1),
                "serverPromptMs": tm.get("prompt_ms"),
                "serverPredictMs": tm.get("predicted_ms"),
                "genTokens": usage.get("completion_tokens"),
                "promptTokens": usage.get("prompt_tokens"),
            })
            lat_a.append(ms_a)

            if args.probs:
                content_b = [{"type": "text", "text": PROB_PROMPT},
                             {"type": "input_audio", "input_audio": {"data": wav_b64, "format": "wav"}}]
                resp_b, ms_b = ask(args.server, content_b, 2, args.timeout, want_logprobs=True)
                rec.update({"probPass": content_text(resp_b)[:40],
                            "pYes": logprob_yes(resp_b),
                            "latencyProbMs": round(ms_b, 1)})
                lat_b.append(ms_b)
        except Exception as e:  # noqa: BLE001
            rec["error"] = f"{type(e).__name__}: {e}"
            errors.append({"clipId": r["clipId"], "ts": r["ts"], "error": rec["error"]})
        out_rows.append(rec)
        print(f"[{n}/{len(rows)}] {r['clipId']}@{r['ts']} "
              f"preds={rec.get('predicates')} pYes={rec.get('pYes')} "
              f"{rec.get('latencyMs')}ms err={rec.get('error', '')[:60]}")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as f:
        for rec in out_rows:
            f.write(json.dumps(rec) + "\n")
    with open(args.csv, "w", newline="") as f:
        cols = ["clipId", "clipPhase", "clipIsHighlight", "candidateIndex", "ts", "eventType",
                "gemmaAccepted", "gemmaScore", "crowd_eruption", "whistle", "commentary_excited",
                "celebration_visible", "pYes", "gateKeep", "gateReject", "latencyMs",
                "latencyProbMs", "error"]
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for rec in out_rows:
            preds = rec.get("predicates") or {}
            keep = gate_keep(preds)
            w.writerow({**rec, **preds, "gateKeep": keep, "gateReject": not keep,
                        "error": rec.get("error", "")})

    summary = summarize(out_rows, clips, trace, lat_a, lat_b, args)
    with open(args.summary, "w") as f:
        json.dump(summary, f, indent=2)

    print("\n=== SUMMARY ===")
    print(json.dumps(summary["ac_verdicts"], indent=2))
    print(json.dumps(summary["latency"], indent=2))
    print(json.dumps(summary["clips"], indent=2))
    print(f"errors={len(errors)}")
    return 0


def gate_keep(preds: dict) -> bool:
    """Pre-registered primary gate rule (fixed before the run; not tuned per clip).

    Keep the candidate when the evidence set contains at least one positive
    signal that a real scoring moment produces: a crowd eruption, a referee
    whistle, or a visible celebration. A candidate that answers "no" (or
    "unknown") to every one of those is rejected before the decide call.
    """
    if not preds:
        return False  # unparseable answer -> fail closed (reject), never fail open
    return (preds.get("crowd_eruption") == "yes"
            or preds.get("whistle") == "yes"
            or preds.get("celebration_visible") == "yes")


def summarize(out_rows, clips, trace, lat_a, lat_b, args) -> dict:
    by_clip: dict[str, dict] = {}
    for clip_id, cl in clips.items():
        by_clip[clip_id] = {
            "phase": cl.get("phase"),
            "isHighlight": bool((cl.get("groundTruth") or {}).get("isHighlight")),
            "nCandidates": 0, "nGemmaAccepted": 0, "nKept": 0, "nKeptAccepted": 0,
            "keptAcceptedTs": [], "acceptedTs": [], "rejectedTs": [],
        }
    for rec in out_rows:
        b = by_clip[rec["clipId"]]
        b["nCandidates"] += 1
        keep = gate_keep(rec.get("predicates") or {})
        if rec.get("gemmaAccepted"):
            b["nGemmaAccepted"] += 1
            b["acceptedTs"].append(rec["ts"])
        if keep:
            b["nKept"] += 1
            if rec.get("gemmaAccepted"):
                b["nKeptAccepted"] += 1
                b["keptAcceptedTs"].append(rec["ts"])
        else:
            b["rejectedTs"].append(rec["ts"])
        b["_keepByTs"] = b.get("_keepByTs", {})
        b["_keepByTs"][rec["ts"]] = keep

    pos = [c for c, b in by_clip.items() if b["isHighlight"]]
    neg = [c for c, b in by_clip.items() if not b["isHighlight"]]

    def accepted_before(c):
        return any(by_clip[c]["acceptedTs"])

    def accepted_after(c):
        return by_clip[c]["nKeptAccepted"] > 0

    # candidate-level projection
    tp = sum(1 for c in pos for t in by_clip[c]["keptAcceptedTs"])
    fp = sum(1 for c in neg for t in by_clip[c]["keptAcceptedTs"])
    tp0 = sum(by_clip[c]["nGemmaAccepted"] for c in pos)
    fp0 = sum(by_clip[c]["nGemmaAccepted"] for c in neg)

    # clip-level projection (the INC-9 metrics_runner precision definition)
    tp_clip = sum(1 for c in pos if accepted_after(c))
    fp_clip = sum(1 for c in neg if accepted_after(c))
    tp_clip0 = sum(1 for c in pos if accepted_before(c))
    fp_clip0 = sum(1 for c in neg if accepted_before(c))

    neg_had_goal = [c for c in neg if accepted_before(c)]
    neg_eliminated = [c for c in neg_had_goal if not accepted_after(c)]
    pos_retained = [c for c in pos if accepted_after(c)]
    pos_lost = [c for c in pos if accepted_before(c) and not accepted_after(c)]

    lat_a_sorted = sorted(lat_a)
    stageA_total = (trace.get("stageA") or {}).get("totalCandidates")
    stageA_rej = (trace.get("stageA") or {}).get("rejected")

    ac = {
        "AC1_precision": {
            "negativesWithAcceptedGoal": len(neg_had_goal),
            "negativesEliminated": len(neg_eliminated),
            "negativesEliminatedIds": sorted(neg_eliminated),
            "positivesLost": sorted(pos_lost),
            "precisionBefore_pct_clip": round(100.0 * tp_clip0 / max(1, tp_clip0 + fp_clip0), 1),
            "precisionAfter_pct_clip": round(100.0 * tp_clip / max(1, tp_clip + fp_clip), 1),
            "precisionBefore_pct_cand": round(100.0 * tp0 / max(1, tp0 + fp0), 1),
            "precisionAfter_pct_cand": round(100.0 * tp / max(1, tp + fp), 1),
            "pass": len(neg_eliminated) >= 3 and not pos_lost,
        },
        "AC2_recall": {
            "positivesTotal": len(pos),
            "positivesRetained": len(pos_retained),
            "positivesLost": sorted(pos_lost),
            "pass": len(pos_lost) == 0 and len(pos_retained) == len(pos) and len(pos) == 10,
        },
        "AC3_latency": {
            "gateLatencyMs_p50": pct(lat_a, 0.50),
            "gateLatencyMs_p95": pct(lat_a, 0.95),
            "gateLatencyMs_max": round(max(lat_a), 1) if lat_a else None,
            "probPassLatencyMs_p95": pct(lat_b, 0.95),
            "bar_p95_ms": 300,
            "pass": (pct(lat_a, 0.95) or 1e9) <= 300,
        },
        "AC5_noise_split": {
            "note": "This pre-gate is measured separately from the Stage-A audio_gate FP rate.",
            "stageA_candidates": stageA_total,
            "stageA_rejected": stageA_rej,
            "stageA_fp_rate": round(stageA_rej / stageA_total, 4) if stageA_total else None,
            "pregate_candidates": len(out_rows),
            "pregate_rejected": sum(1 for r in out_rows if not gate_keep(r.get("predicates") or {})),
            "pregate_reject_rate": round(
                sum(1 for r in out_rows if not gate_keep(r.get("predicates") or {})) / max(1, len(out_rows)), 4),
        },
    }
    kill = []
    if len(neg_eliminated) < 2:
        kill.append("<2 of 4 negatives rejected")
    if pos_lost:
        kill.append("positive lost: " + ",".join(sorted(pos_lost)))
    if (pct(lat_a, 0.95) or 1e9) > 300:
        kill.append("p95 > 300 ms")
    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "server": args.server,
        "anchorFrame": args.anchor_frame,
        "probs": args.probs,
        "preWinS": args.pre_win,
        "postWinS": args.post_win,
        "nCandidates": len(out_rows),
        "nErrors": sum(1 for r in out_rows if r.get("error")),
        "gateRule": "keep iff crowd_eruption==yes OR whistle==yes OR celebration_visible==yes "
                    "(unparseable => reject)",
        "clips": by_clip,
        "latency": {
            "gate_n": len(lat_a), "gate_p50_ms": pct(lat_a, 0.50),
            "gate_p95_ms": pct(lat_a, 0.95), "gate_max_ms": round(max(lat_a), 1) if lat_a else None,
            "gate_mean_ms": round(statistics.fmean(lat_a), 1) if lat_a else None,
            "prob_n": len(lat_b), "prob_p95_ms": pct(lat_b, 0.95),
        },
        "ac_verdicts": ac,
        "killCriteriaTriggered": kill,
        "adopted": not kill,
    }


if __name__ == "__main__":
    sys.exit(main())

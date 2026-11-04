#!/usr/bin/env python3
"""Profile the Gemma decide VLM for maximum concurrent decide requests (ADAAAA-8004).

The CEO ask this answers: "profile the maximum decide requests concurrently to
achieve the minimum tokens / s needed." It drives the vLLM OpenAI-compatible
endpoint the decide workers call (`services/decide/app/gemma.py`) at increasing
concurrency and reports, per level:

  - requests completed / failed
  - wall time of the batch
  - completion tokens per second, aggregate and per request
  - prompt (prefill) tokens per second
  - per-request latency p50 / p95
  - TTFT when vLLM streams (--stream)

Design notes:

- Standard library only: it must run on the box with no extra install
  (`python3 docker/gemma-concurrency-bench.py ...`).
- The request shape matters. A decide call carries up to ~30 frames (~280 soft
  tokens each) plus one audio window; a text-only run measures decode speed but
  NOT the prefill cost that dominates decide. Pass `--frames-dir` with N jpeg
  frames to send a decide-shaped multimodal prompt, and `--frames-per-request`
  to match the window you are quoting.
- Each level is run `--rounds` times; the report keeps the median batch so one
  cold start (vLLM graph capture) does not masquerade as a steady-state number.
- It never writes to the model server: chat completions only.

Usage (on the box, from the repo root):

    python3 docker/gemma-concurrency-bench.py \
        --url http://gemma:8088/v1/chat/completions \
        --model cyankiwi/gemma-4-12B-it-qat-AWQ-INT4 \
        --concurrency 1,2,4,8 --max-tokens 600 --rounds 3

    # decide-shaped (30 frames), the number the $/decide quote needs:
    python3 docker/gemma-concurrency-bench.py --frames-dir /tmp/frames30 \
        --frames-per-request 30 --concurrency 1,2,4,8 --max-tokens 600
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request

PROMPT = (
    "You are the live highlight observer for a soccer match. "
    "Given the frames of one observation window, decide whether a notable event "
    "(goal, save, near miss, card) happened. Reply with a short JSON object: "
    '{"notable": bool, "eventType": string, "confidence": number, "reason": string}.'
)


def _b64(path: str) -> str:
    with open(path, "rb") as fh:
        return base64.b64encode(fh.read()).decode()


def _frame_paths(frames_dir: str, count: int) -> list[str]:
    if not frames_dir:
        return []
    names = sorted(
        n for n in os.listdir(frames_dir) if n.lower().endswith((".jpg", ".jpeg", ".png"))
    )
    if not names:
        raise SystemExit(f"no jpeg/png frames in {frames_dir}")
    return [os.path.join(frames_dir, n) for n in names[:count]]


def build_payload(args, images: list[str], stream: bool) -> dict:
    content: list[dict] = [{"type": "text", "text": PROMPT}]
    for _ in range(args.repeat_text):
        content.append({"type": "text", "text": "Observation window: frames attached."})
    for img in images:
        content.append(
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{_b64(img)}"}}
        )
    return {
        "model": args.model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": args.max_tokens,
        "temperature": 0.0,
        "stream": stream,
    }


def one_request(args, payload: dict) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        args.url, data=data, headers={"Content-Type": "application/json"}
    )
    t0 = time.monotonic()
    ttft = None
    completion_tokens = 0
    prompt_tokens = 0
    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            if payload.get("stream"):
                for raw in resp:
                    line = raw.decode().strip()
                    if not line.startswith("data:"):
                        continue
                    body = line[5:].strip()
                    if body == "[DONE]":
                        break
                    try:
                        chunk = json.loads(body)
                    except json.JSONDecodeError:
                        continue
                    if ttft is None and chunk.get("choices"):
                        ttft = time.monotonic() - t0
                    completion_tokens += 1
                # Streaming usage is absent unless requested; count chunks as a
                # lower bound on tokens (one token per delta).
                prompt_tokens = 0
            else:
                body = json.loads(resp.read().decode())
                usage = body.get("usage") or {}
                completion_tokens = int(usage.get("completion_tokens") or 0)
                prompt_tokens = int(usage.get("prompt_tokens") or 0)
        elapsed = time.monotonic() - t0
        return {
            "ok": True,
            "latency": elapsed,
            "ttft": ttft,
            "completion_tokens": completion_tokens,
            "prompt_tokens": prompt_tokens,
        }
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": f"HTTP {exc.code}: {exc.read()[:300].decode(errors='replace')}",
                "latency": time.monotonic() - t0}
    except Exception as exc:  # noqa: BLE001 - a failed request is a datum, not a crash
        return {"ok": False, "error": repr(exc), "latency": time.monotonic() - t0}


def run_level(args, payload: dict, concurrency: int) -> dict:
    results: list[dict] = []
    lock = threading.Lock()

    def worker() -> None:
        r = one_request(args, payload)
        with lock:
            results.append(r)

    threads = [threading.Thread(target=worker) for _ in range(concurrency)]
    t0 = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.monotonic() - t0

    ok = [r for r in results if r["ok"]]
    lat = sorted(r["latency"] for r in ok)
    comp = sum(r["completion_tokens"] for r in ok)
    prompt = sum(r["prompt_tokens"] for r in ok)
    ttfts = sorted(r["ttft"] for r in ok if r.get("ttft") is not None)
    p95 = lat[min(len(lat) - 1, int(0.95 * len(lat)))] if lat else None

    def per_wall(tokens: int) -> float:
        return round(tokens / wall, 2) if wall > 0 else 0.0

    return {
        "concurrency": concurrency,
        "requests": len(results),
        "ok": len(ok),
        "failed": len(results) - len(ok),
        "wall_s": round(wall, 3),
        "completion_tokens": comp,
        "prompt_tokens": prompt,
        "completion_tokens_per_s": per_wall(comp),
        "prompt_tokens_per_s": per_wall(prompt),
        "per_request_tokens_per_s": round(comp / wall / concurrency, 2) if concurrency else 0.0,
        "latency_p50_s": round(statistics.median(lat), 3) if lat else None,
        "latency_p95_s": round(p95, 3) if p95 is not None else None,
        "ttft_p50_s": round(statistics.median(ttfts), 3) if ttfts else None,
        "errors": [r["error"] for r in results if not r["ok"]][:3],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("GEMMA_BENCH_URL", "http://gemma:8088/v1/chat/completions"))
    ap.add_argument("--model", default=os.environ.get("GEMMA_MODEL", "cyankiwi/gemma-4-12B-it-qat-AWQ-INT4"))
    ap.add_argument("--concurrency", default="1,2,4,8", help="comma-separated levels")
    ap.add_argument("--max-tokens", type=int, default=600)
    ap.add_argument("--rounds", type=int, default=2, help="batches per level; median is reported")
    ap.add_argument("--frames-dir", default="", help="directory of jpeg frames for a decide-shaped prompt")
    ap.add_argument("--frames-per-request", type=int, default=30)
    ap.add_argument("--repeat-text", type=int, default=0, help="extra text blocks (prefill filler)")
    ap.add_argument("--timeout", type=float, default=180.0)
    ap.add_argument("--stream", action="store_true", help="stream to measure TTFT")
    ap.add_argument("--out", default="", help="write the JSON report here")
    args = ap.parse_args()

    frames = _frame_paths(args.frames_dir, args.frames_per_request)
    payload = build_payload(args, frames, args.stream)
    levels = [int(v) for v in args.concurrency.split(",") if v.strip()]

    report = {
        "url": args.url,
        "model": args.model,
        "frames_per_request": len(frames),
        "max_tokens": args.max_tokens,
        "rounds": args.rounds,
        "stream": args.stream,
        "levels": [],
    }
    print(f"benchmarking {args.url} model={args.model} frames={len(frames)} "
          f"max_tokens={args.max_tokens} levels={levels}", flush=True)
    for level in levels:
        samples = [run_level(args, payload, level) for _ in range(max(1, args.rounds))]
        ok_samples = [s for s in samples if s["ok"]]
        pick = (
            sorted(ok_samples, key=lambda s: s["completion_tokens_per_s"])[len(ok_samples) // 2]
            if ok_samples
            else samples[0]
        )
        report["levels"].append({"level": level, "median": pick, "all": samples})
        print(
            f"c={level:<2} ok={pick['ok']}/{pick['requests']} "
            f"wall={pick['wall_s']}s comp_tok/s={pick['completion_tokens_per_s']} "
            f"prompt_tok/s={pick['prompt_tokens_per_s']} "
            f"lat_p50={pick['latency_p50_s']}s lat_p95={pick['latency_p95_s']}s "
            f"ttft_p50={pick['ttft_p50_s']}s",
            flush=True,
        )
        if pick["errors"]:
            print(f"        errors: {pick['errors'][:1]}", flush=True)

    best = max(
        (lv["median"] for lv in report["levels"] if lv["median"]["ok"] > 0),
        key=lambda m: m["completion_tokens_per_s"],
        default=None,
    )
    if best:
        report["max_completion_tokens_per_s"] = best["completion_tokens_per_s"]
        report["at_concurrency"] = best["concurrency"]
        print(
            f"\nMAX completion tok/s = {best['completion_tokens_per_s']} at concurrency {best['concurrency']}",
            flush=True,
        )

    text = json.dumps(report, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"report written to {args.out}", flush=True)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())

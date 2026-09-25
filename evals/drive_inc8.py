#!/usr/bin/env python3
"""INC-8 (ADAAAA-4484) deployed-pipeline soccer drive.

Re-drives the INC-5 labeled soccer eval clips through the DEPLOYED perceive +
decide pipeline and emits an OutboundEvents trace that `metrics_runner.py` can
score against the $6 acceptance bars.

Why this exists: the INC-7 drive (de9af11) POSTed raw frames to /app/analyze
with NO gameHint, so perceive's sport-agnostic tracker emitted the generic
shooter label KILL for every soccer moment and the GOAL classification path
(sport_specific_event_type, ADAAAA-4193) never activated -> recall 0%. This
driver is the INC-7 one with the fix applied: it delivers gameHint='soccer'
(and preferLabels) on every /analyze, so perceive activates the closed
vocabulary and classifies the strike as GOAL, and it routes each GOAL/MOVE
candidate to the Gemma decide /highlight contract for the HighlightDecision.

Run on the GPU box (livepeer-ai-x99) next to the deployed containers:

    python3 evals/drive_inc8.py \
        --manifest evals/label-manifest.json \
        --perceive http://127.0.0.1:8080 \
        --decide   http://127.0.0.1:9090 \
        --game-hint soccer \
        --out evals/inc8-trace.json

(clips should be reachable from the box at the path in the manifest's
`source` after the `host:` prefix is stripped; use --clip-root to override.)

Pure stdlib + `requests`/`urllib`; no runtime deps on the box beyond ffmpeg.
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid


def resolve_clip_path(source: str, clip_root: str | None) -> str:
    """Manifest sources look like 'host:livepeer-ai-x99:/home/brad/...mp4'.
    Strip 'host:<name>:' if present, else take the path component."""
    path = source
    for tok in ("host:", "livepeer-ai-x99:"):
        if path.startswith(tok):
            path = path[len(tok):]
    # strip any leading 'host:<anything>:' pattern
    if ":" in path and not path.startswith("/"):
        path = path.split(":", 1)[1]
    if clip_root and not os.path.isabs(path):
        path = os.path.join(clip_root, path)
    return path


def extract_frames(clip_path: str, fps: float, start_s: float, end_s: float, workdir: str):
    """ffmpeg -> one JPEG per second in [start_s, end_s] at `fps`. Yields
    (index, timestamp, base64-jpeg)."""
    outpat = os.path.join(workdir, "f_%03d.jpg")
    dur = max(0.0, end_s - start_s)
    cmd = [
        "ffmpeg", "-v", "error", "-ss", f"{start_s:.3f}",
        "-i", clip_path, "-t", f"{dur:.3f}",
        "-vf", f"fps={fps}", "-q:v", "3", "-frames:v", "300",
        "-y", outpat,
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    frames = sorted(f for f in os.listdir(workdir) if f.startswith("f_") and f.endswith(".jpg"))
    out = []
    for i, fn in enumerate(frames):
        with open(os.path.join(workdir, fn), "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        out.append((i, start_s + (i + 0.5) / fps, b64))
    return out


def http_json(url: str, payload: dict, timeout: float = 60.0,
              headers: dict | None = None) -> dict:
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers=hdrs, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def analyze_frame(perceive: str, sid: str, seq: int, ts: float, b64: str,
                  game_hint: str, prefer: list[str], latent: list[float]) -> dict | None:
    """POST one frame to perceive /app/analyze. Returns the candidate dict (if
    any) and appends the wall-clock round-trip to `latent`. perceive binds a
    session per stream and requires X-Session-Id on every /analyze."""
    body = {"seq": seq, "timestamp": ts, "image": b64, "gameHint": game_hint, "preferLabels": prefer}
    t0 = time.monotonic()
    try:
        resp = http_json(f"{perceive}/app/analyze", body, timeout=120.0,
                         headers={"X-Session-Id": sid})
    finally:
        latent.append(time.monotonic() - t0)
    return resp.get("candidate")


def decide(decide_url: str, sid: str, cand: dict, game_hint: str,
           image_b64: str) -> dict:
    """POST a candidate to decide /highlight (Gemma). Returns the decision dict."""
    payload = {
        "sessionId": sid,
        "eventType": cand["eventType"],
        "timestamp": cand["timestamp"],
        "gameHint": game_hint,
        "evidence": {"trackCount": 1, "maxVelocity": 0.0, "ocrHits": 0},
        "images": [{"role": "full", "base64": image_b64}],
        "frames": [],
        "reasoningEffort": "none",
    }
    try:
        d = http_json(f"{decide_url}/highlight", payload, timeout=120.0)
        return d
    except Exception as e:  # Gemma unavailable -> score as non-highlight, note it
        return {"isHighlight": False, "score": 0.0, "eventType": cand["eventType"],
                "reason": f"decide transport error: {e}"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", default="evals/label-manifest.json")
    ap.add_argument("--perceive", default=os.environ.get("PERCEIVE_URL", "http://127.0.0.1:8080"))
    ap.add_argument("--decide", default=os.environ.get("DECIDE_URL", "http://127.0.0.1:9090"))
    ap.add_argument("--game-hint", default="soccer")
    ap.add_argument("--prefer-labels", default="player,soccer ball,goal")
    ap.add_argument("--fps", type=float, default=1.0)
    ap.add_argument("--clip-root", default=None, help="override dir for clip files")
    ap.add_argument("--dry-run", action="store_true", help="extract frames only; do not POST")
    ap.add_argument("--out", default="evals/inc8-trace.json")
    ap.add_argument("--latency-out", default=None)
    args = ap.parse_args()

    with open(args.manifest) as fh:
        manifest = json.load(fh)
    clips = manifest["clips"] if isinstance(manifest, dict) else manifest
    prefer = [s.strip() for s in args.prefer_labels.split(",") if s.strip()]

    events: list[dict] = []
    latent: list[float] = []
    stage_total = 0
    stage_rejected = 0
    tracking = {}

    print(f"INC-8 drive: {len(clips)} clips, gameHint='{args.game_hint}', fps={args.fps}")
    for clip in clips:
        cid = clip["id"]
        mode = clip.get("mode", "live")
        src = resolve_clip_path(clip.get("source", ""), args.clip_root)
        start_s = float(clip.get("startS", 0.0))
        end_s = float(clip.get("endS", 0.0))
        sid = f"inc8-{cid}-{uuid.uuid4().hex[:6]}"
        print(f"  [{mode}] {cid}: {src} [{start_s}-{end_s}s]")
        if not os.path.exists(src):
            print(f"    ! clip missing; skipping")
            continue
        with tempfile.TemporaryDirectory(prefix="inc8_") as td:
            frames = extract_frames(src, args.fps, start_s, end_s, td)
            if args.dry_run:
                print(f"    dry: {len(frames)} frames")
                continue
            cand_ts_by_seq = {}
            for i, ts, b64 in frames:
                cand = analyze_frame(args.perceive, sid, i, ts, b64, args.game_hint, prefer, latent)
                if cand is not None:
                    stage_total += 1
                    cand_ts_by_seq[i] = cand
                    events.append({"type": "candidate", "clipId": cid,
                                   "eventType": cand["eventType"], "timestamp": cand["timestamp"]})
            if cand_ts_by_seq:
                # route to decide with the anchored frame
                for i, cand in cand_ts_by_seq.items():
                    frame_b64 = frames[i][2] if i < len(frames) else ""
                    dec = decide(args.decide, sid, cand, args.game_hint, frame_b64)
                    events.append({"type": "decision", "clipId": cid, "timestamp": cand["timestamp"] + 2.0,
                                   "decision": dec})
                    if not dec.get("isHighlight"):
                        stage_rejected += 1
                    print(f"    cand={cand['eventType']} @{cand['timestamp']}s -> decided isHighlight={dec.get('isHighlight')}")

    trace = {
        "events": events,
        "stageA": {"totalCandidates": stage_total, "rejected": stage_rejected},
        "tracking": tracking,
    }
    with open(args.out, "w") as fh:
        json.dump(trace, fh, indent=2)
    print(f"\nWrote {len(events)} events -> {args.out}")
    if args.latency_out and latent:
        with open(args.latency_out, "w") as fh:
            json.dump({"n": len(latent), "mean": sum(latent) / len(latent),
                       "max": max(latent), "latencies": latent}, fh, indent=2)
        print(f"Wrote latency -> {args.latency_out} (mean {sum(latent)/len(latent):.3f}s, max {max(latent):.3f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

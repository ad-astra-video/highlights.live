#!/usr/bin/env python3
"""ADAAAA-7089 soccer pass-1 prompt A/B drive (child of ADAAAA-7087).

Drives the DEPLOYED perceive service once per labeled clip to collect the
honest multimodal evidence (candidates, per-frame observations, frames, audio
reaction proxy), then calls the DEPLOYED gemma (llama-server) DIRECTLY with
`apps.gemma.build_prompt(variant=...)` for EVERY prompt variant on the SAME
collected evidence. The prompt is the ONLY variable: perceive output, frames,
candidate set and reaction summary are identical across variants for a clip.

Emits one `metrics_runner.py`-scorable VOD trace per variant under the out dir:

    <out>/vod_ab_trace_<V>.json    (events = candidate + decision, stageA, tracking)

Decision events carry `framesJudged` (= len of the temporal frame window the
model actually saw, capped at decideWindowN) plus the model's real `reason`, so
A4 depth / A7 reaction-cited score exactly like the ADAAAA-4959 baseline.

Run on the GPU box (livepeer-ai-x99) next to the deployed containers; services
are reached directly over the `highlights-live` bridge by IP, clips by path.

    python3 evals/drive_prompt_ab.py \
        --manifest evals/label-manifest.json \
        --perceive http://172.20.0.7:8080 \
        --gemma http://172.20.0.6:8088 \
        --clips-root /home/brad/highlights.live/docker/data/clips \
        --out-dir /tmp/promtab/out \
        --variants v0,A,B,C,D

Pure stdlib (urllib) on the box; no httpx/requests needed. `apps` package on
sys.path supplies build_prompt/parse_decision (repo gemma.py + decider.py).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid


# ---------------------------------------------------------------- import app --
# The repo's `services/decide/app` package is expected at --apps-dir (a dir that
# contains gemma.py + decider.py as a namespace package `app`).
def _load_app(apps_dir: str):
    sys.path.insert(0, apps_dir)
    from app.gemma import build_prompt, parse_decision  # noqa: F401
    return build_prompt, parse_decision


# ------------------------------------------------------------------- clip path
def resolve_clip_path(source: str, clip_root: str | None) -> str:
    path = source
    for tok in ("host:", "livepeer-ai-x99:"):
        if path.startswith(tok):
            path = path[len(tok):]
    if ":" in path and not path.startswith("/"):
        path = path.split(":", 1)[1]
    if clip_root and not os.path.isabs(path):
        path = os.path.join(clip_root, path)
    return path


# ------------------------------------------------------------------- ffmpeg ----
def extract_frames(clip_path: str, fps: float, start_s: float, end_s: float,
                   workdir: str):
    outpat = os.path.join(workdir, "f_%03d.jpg")
    dur = max(0.0, end_s - start_s)
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{start_s:.3f}", "-i", clip_path,
           "-t", f"{dur:.3f}", "-vf", f"fps={fps}", "-q:v", "3",
           "-frames:v", "400", "-y", outpat]
    subprocess.run(cmd, check=True, capture_output=True)
    frames = sorted(f for f in os.listdir(workdir)
                    if f.startswith("f_") and f.endswith(".jpg"))
    out = []
    for i, fn in enumerate(frames):
        with open(os.path.join(workdir, fn), "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        out.append((i, start_s + (i + 0.5) / fps, b64))
    return out


# --------------------------------------------------------------------- HTTP ----
def http_json(url: str, payload: dict, timeout: float = 120.0,
              headers: dict | None = None) -> dict:
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def analyze_frame(perceive: str, sid: str, seq: int, ts: float, b64: str,
                  game_hint: str, prefer: list[str], latent: list[float]):
    body = {"seq": seq, "timestamp": ts, "image": b64, "gameHint": game_hint,
            "preferLabels": prefer}
    t0 = time.monotonic()
    try:
        resp = http_json(f"{perceive}/app/analyze", body, timeout=120.0,
                         headers={"X-Session-Id": sid})
    finally:
        latent.append(time.monotonic() - t0)
    obs = resp.get("observation") or {}
    return resp.get("candidate"), obs


# ------------------------------------------------- audio reaction (INC-9) -----
_MEAN_VOL_RE = re.compile(rb"mean_volume:\s*(-?\d+(?:\.\d+)?)")


def _mean_volume_db(clip_path: str, start_s: float, len_s: float) -> float | None:
    start_s = max(0.0, start_s)
    cmd = ["ffmpeg", "-hide_banner", "-ss", f"{start_s:.3f}", "-t",
           f"{len_s:.3f}", "-i", clip_path, "-af", "volumedetect",
           "-f", "null", "-"]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=30)
    except Exception:
        return None
    m = _MEAN_VOL_RE.search(r.stderr or b"")
    if not m:
        return None
    try:
        return float(m.group(1))
    except (TypeError, ValueError):
        return None


def clip_duration_s(clip_path: str) -> float:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", clip_path],
            capture_output=True, timeout=20)
        return float(r.stdout.decode().strip()) if r.stdout.strip() else 0.0
    except Exception:
        return 0.0


def crowd_energy_from_audio(clip_path: str, ts: float,
                            pre_win_s: float = 2.0, reac_win_s: float = 2.0):
    if not clip_path or not os.path.exists(clip_path):
        return 0.0, ""
    dur = clip_duration_s(clip_path)
    base_start = max(0.0, ts - pre_win_s)
    reac_start = min(ts, dur) if dur > 0 else ts
    if dur > 0 and reac_start + reac_win_s > dur:
        reac_win_s = max(0.5, dur - reac_start)
    base_db = _mean_volume_db(clip_path, base_start, pre_win_s)
    reac_db = _mean_volume_db(clip_path, reac_start, reac_win_s)
    if base_db is None or reac_db is None:
        return 0.0, ""
    base_amp = 10.0 ** (base_db / 20.0)
    reac_amp = 10.0 ** (reac_db / 20.0)
    rise = (reac_amp - base_amp) / max(base_amp, 1e-9) if base_amp > 1e-9 else 0.0
    suddenness = max(0.0, min(rise / 3.0, 1.0))
    loudness = max(0.0, min((reac_db + 52.0) / 40.0, 1.0))
    ce = round(suddenness * loudness, 3)
    if ce >= 0.55:
        kind = "burst"
    elif ce >= 0.18:
        kind = "swell"
    else:
        kind = ""
    return ce, kind


# ------------------------------------------- celebration discriminator (INC-9)
GOAL_MOUTH_REGIONS = [(0.00, 0.12, 0.30, 0.90), (0.70, 0.12, 1.00, 0.90)]
CLUSTER_RADIUS = 0.12
PLAYER_MIN_AREA = 0.004


def _norm_center(b):
    return ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)


def _in_goal_region(cx, cy):
    return any(x1 <= cx <= x2 and y1 <= cy <= y2
               for x1, y1, x2, y2 in GOAL_MOUTH_REGIONS)


def _obs_ball_bbox(obs):
    for o in obs.get("objects") or []:
        if "ball" in (o.get("label") or "").lower():
            b = o.get("bbox")
            if b and len(b) == 4:
                return b
    for t in obs.get("tracks") or []:
        if (t.get("kind") or "") == "ball":
            b = t.get("bbox")
            if b and len(b) == 4:
                return b
    return None


def ball_in_goal_mouth(obs) -> bool:
    b = _obs_ball_bbox(obs)
    if not b:
        return False
    cx, cy = _norm_center(b)
    return _in_goal_region(cx, cy)


def _player_centers_in_goal_region(obs):
    players = []
    objs = obs.get("objects") or []
    for o in objs:
        label = (o.get("label") or "").lower()
        if "ball" in label:
            continue
        b = o.get("bbox")
        if not b or len(b) != 4:
            continue
        x1, y1, x2, y2 = (float(v) for v in b)
        if (x2 - x1) * (y2 - y1) < PLAYER_MIN_AREA:
            continue
        cx, cy = _norm_center([x1, y1, x2, y2])
        if _in_goal_region(cx, cy):
            players.append((cx, cy))
    if players:
        return players
    for t in obs.get("tracks") or []:
        if (t.get("kind") or "") == "ball" or (t.get("label") or "").lower() == "ball":
            continue
        b = t.get("bbox")
        if not b or len(b) != 4:
            continue
        x1, y1, x2, y2 = (float(v) for v in b)
        if (x2 - x1) * (y2 - y1) < PLAYER_MIN_AREA:
            continue
        cx, cy = _norm_center([x1, y1, x2, y2])
        if _in_goal_region(cx, cy):
            players.append((cx, cy))
    return players


def celebration_cluster(obs) -> int:
    players = _player_centers_in_goal_region(obs)
    if not players:
        return 0
    best = 1
    for i, (ax, ay) in enumerate(players):
        c = 1
        for j, (bx, by) in enumerate(players):
            if i == j:
                continue
            if (ax - bx) ** 2 + (ay - by) ** 2 <= CLUSTER_RADIUS ** 2:
                c += 1
        best = max(best, c)
    return best


# ----------------------------------------------------------- direct gemma call
def gemma_call(gemma: str, model: str, build_prompt, parse_decision,
               variant: str, event_type: str, evidence: dict,
               game_hint: str, frame_window: list[str],
               timeout_s: float = 180.0) -> dict:
    """POST to llama-server /v1/chat/completions directly with
    build_prompt(variant) on the SAME evidence/frames. Mirrors apps.gemma.ask()
    modality order (images -> text -> [audio]) but drives the variant switch."""
    content = [
        {"type": "image_url",
         "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}
        for b64 in frame_window
    ]
    prompt = build_prompt(event_type, evidence, game_hint,
                          n_frames=len(frame_window), has_audio=False,
                          variant=variant)
    content.append({"type": "text", "text": prompt})
    payload = {
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.0,
        "reasoning_effort": "none",
        "max_tokens": 1200,
        "stream": False,
    }
    if model:
        payload["model"] = model
    try:
        resp = http_json(f"{gemma.rstrip('/')}/v1/chat/completions", payload,
                         timeout=timeout_s)
        text = resp["choices"][0]["message"]["content"]
    except Exception as e:  # gemma unavailable -> note, score as non-highlight
        return {"isHighlight": False, "score": 0.0, "eventType": event_type,
                "reason": f"gemma transport error: {e}", "source": "error"}
    return parse_decision(text)


def _build_evidence(obs, cand, reaction):
    ev = {
        "trackCount": len(obs.get("tracks") or []),
        "maxVelocity": 0.0,
        "ocrHits": 0,
        "reaction": reaction,
    }
    if cand.get("ballVelocity"):
        try:
            ev["maxVelocity"] = float(
                cand["ballVelocity"].get("speedMps") or 0.0)
        except (TypeError, ValueError):
            pass
    return ev


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", default="evals/label-manifest.json")
    ap.add_argument("--perceive", default=os.environ.get("PERCEIVE_URL",
                                                        "http://172.20.0.7:8080"))
    ap.add_argument("--gemma", default=os.environ.get("GEMMA_URL",
                                                      "http://172.20.0.6:8088"))
    ap.add_argument("--gemma-model", default=os.environ.get("GEMMA_MODEL", ""))
    ap.add_argument("--apps-dir", default="/tmp/promtab",
                    help="dir holding the `app` package (gemma.py+decider.py)")
    ap.add_argument("--game-hint", default="soccer")
    ap.add_argument("--prefer-labels", default="player,soccer ball,goal")
    ap.add_argument("--fps", type=float, default=2.0, help="sampleFps (baseline)")
    ap.add_argument("--decide-frames", type=int, default=24,
                    help="decideWindowN: temporal frames from candidate moment")
    ap.add_argument("--clip-root", default=None)
    ap.add_argument("--out-dir", default="/tmp/promtab/out")
    ap.add_argument("--variants", default="v0,A,B,C,D")
    ap.add_argument("--clip-id", default=None,
                    help="only drive this clip id (smoke test)")
    args = ap.parse_args()

    build_prompt, parse_decision = _load_app(args.apps_dir)

    with open(args.manifest) as fh:
        manifest = json.load(fh)
    clips = manifest["clips"] if isinstance(manifest, dict) else manifest
    prefer = [s.strip() for s in args.prefer_labels.split(",") if s.strip()]
    variants = [v.strip() for v in args.variants.split(",") if v.strip()]

    os.makedirs(args.out_dir, exist_ok=True)
    # Per-variant accumulators
    events_by_v = {v: [] for v in variants}
    stage_total_by_v = {v: 0 for v in variants}
    stage_rejected_by_v = {v: 0 for v in variants}
    latent = []
    per_variant_calls = {v: 0 for v in variants}
    per_variant_secs = {v: 0.0 for v in variants}

    selected = [c for c in clips
                if not args.clip_id or c["id"] == args.clip_id]
    print(f"prompt-AB drive: {len(selected)} clips, gameHint='{args.game_hint}', "
          f"fps={args.fps}, decideWindowN={args.decide_frames}, "
          f"variants={variants}")

    for clip in selected:
        cid = clip["id"]
        src = resolve_clip_path(clip.get("source", ""), args.clip_root)
        start_s = float(clip.get("startS", 0.0))
        end_s = float(clip.get("endS", 0.0))
        sid = f"ab-{cid}-{uuid.uuid4().hex[:6]}"
        print(f"  [drive] {cid}: {src} [{start_s}-{end_s}s]")
        if not os.path.exists(src):
            print(f"    ! clip missing; skipping")
            continue
        with tempfile.TemporaryDirectory(prefix="ab_") as td:
            frames = extract_frames(src, args.fps, start_s, end_s, td)
            print(f"    {len(frames)} frames @ {args.fps}fps")
            cand_seq = {}
            for i, ts, b64 in frames:
                cand, obs = analyze_frame(args.perceive, sid, i, ts, b64,
                                          args.game_hint, prefer, latent)
                if cand is not None:
                    cand_seq[i] = (cand, obs)
            if not cand_seq:
                print(f"    no candidates")
                continue
            for i, (cand, obs) in sorted(cand_seq.items()):
                frame_b64 = frames[i][2] if i < len(frames) else ""
                window = [frames[j][2]
                          for j in range(i, min(i + args.decide_frames,
                                                len(frames)))
                          if frames[j][2]]
                ce, kind = crowd_energy_from_audio(src, cand["timestamp"])
                n_tracks = len(obs.get("tracks") or [])
                cluster = celebration_cluster(obs)
                bigm = ball_in_goal_mouth(obs)
                reaction = {
                    "crowdEnergy": ce, "audioKind": kind,
                    "humansInMotion": n_tracks, "celebrationCluster": cluster,
                    "ballInGoalMouth": bigm,
                }
                if cand.get("ballVelocity"):
                    try:
                        reaction["ballSpeedMps"] = float(
                            cand["ballVelocity"].get("speedMps") or 0.0)
                    except (TypeError, ValueError):
                        pass
                if cand.get("ballPossession"):
                    reaction["ballPossessionId"] = \
                        cand["ballPossession"].get("possessingPlayerId", "")
                evidence = _build_evidence(obs, cand, reaction)
                for v in variants:
                    events_by_v[v].append(
                        {"type": "candidate", "clipId": cid,
                         "eventType": cand["eventType"],
                         "timestamp": cand["timestamp"]})
                    stage_total_by_v[v] += 1
                    t0 = time.monotonic()
                    dec = gemma_call(args.gemma, args.gemma_model, build_prompt,
                                     parse_decision, v, cand["eventType"],
                                     evidence, args.game_hint, window)
                    per_variant_secs[v] += time.monotonic() - t0
                    per_variant_calls[v] += 1
                    events_by_v[v].append(
                        {"type": "decision", "clipId": cid,
                         "timestamp": cand["timestamp"] + 2.0,
                         "framesJudged": len(window),
                         "decision": dec, "reaction": reaction,
                         "frameWindow": len(window)})
                    if not dec.get("isHighlight"):
                        stage_rejected_by_v[v] += 1
                    print(f"      V{v}: cand={cand['eventType']} "
                          f"@{cand['timestamp']}s frames={len(window)} "
                          f"ce={ce}/{kind or 'none'} cluster={cluster} "
                          f"ballMouth={int(bigm)} -> "
                          f"isHighlight={dec.get('isHighlight')} "
                          f"score={dec.get('score')} "
                          f"reject={not dec.get('isHighlight')}")

    # Write per-variant traces
    for v in variants:
        trace = {
            "events": events_by_v[v],
            "stageA": {"totalCandidates": stage_total_by_v[v],
                       "rejected": stage_rejected_by_v[v]},
            "tracking": {},
            "_meta": {
                "issue": "ADAAAA-7089", "variant": v,
                "gameHint": args.game_hint, "fps": args.fps,
                "decideWindowN": args.decide_frames,
                "gemmaCalls": per_variant_calls[v],
                "gemmaSeconds": round(per_variant_secs[v], 1),
            },
        }
        out = os.path.join(args.out_dir, f"vod_ab_trace_{v}.json")
        with open(out, "w") as fh:
            json.dump(trace, fh, indent=2)
        print(f"wrote {out} ({len(events_by_v[v])} events, "
              f"{stage_total_by_v[v]} candidates, "
              f"{stage_rejected_by_v[v]} rejected, "
              f"{per_variant_calls[v]} gemma calls / "
              f"{per_variant_secs[v]:.1f}s)")

    print(f"\nperceive analyze calls: {len(latent)}, "
          f"mean {sum(latent)/max(len(latent),1):.3f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())

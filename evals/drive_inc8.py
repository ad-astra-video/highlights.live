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
import re
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
                  game_hint: str, prefer: list[str], latent: list[float]):
    """POST one frame to perceive /app/analyze. Returns (candidate_dict|None,
    n_tracks) where n_tracks is the honest count of tracks perceive detected on
    this frame (the cheap visual humans-in-motion celebration cue the deployed
    live pipeline forwards as buildReactionEvidence(..., trackCount)). Appends
    the wall-clock round-trip to `latent`. perceive binds a session per stream
    and requires X-Session-Id on every /analyze."""
    body = {"seq": seq, "timestamp": ts, "image": b64, "gameHint": game_hint, "preferLabels": prefer}
    t0 = time.monotonic()
    try:
        resp = http_json(f"{perceive}/app/analyze", body, timeout=120.0,
                         headers={"X-Session-Id": sid})
    finally:
        latent.append(time.monotonic() - t0)
    obs = resp.get("observation") or {}
    tracks = obs.get("tracks") or []
    return resp.get("candidate"), len(tracks)


# --- honest people-reaction evidence (INC-9 / ADAAAA-4496) -------------------
# The deployed live pipeline feeds crowd/audience reaction context into the
# decide() stage via buildReactionEvidence (services/server/src/analyzer.ts).
# The INC-8 eval drive sent none, so Gemma could not tell a real goal (crowd
# erupts) from warm-up (quiet): soc-goal-01 was rejected on every anchor frame
# and precision fell because warm-up/off-target GOAL candidates were accepted
# without reaction context. Here we derive the SAME reaction dimension honestly
# from the clip's real audio — a sudden loudness increase around the candidate
# is the crowd-energy proxy. We NEVER feed ground-truth labels or
# manifest.reaction as pipeline input; only the clip's own audio is used.

_MEAN_VOL_RE = re.compile(rb"mean_volume:\s*(-?\d+(?:\.\d+)?)")


def _mean_volume_db(clip_path: str, start_s: float, len_s: float) -> float | None:
    """Return the mean loudness (dB) of [start_s, start_s+len_s] via ffmpeg
    volumedetect, or None when the clip has no decodable audio stream."""
    start_s = max(0.0, start_s)
    cmd = [
        "ffmpeg", "-hide_banner", "-ss", f"{start_s:.3f}", "-t", f"{len_s:.3f}",
        "-i", clip_path, "-af", "volumedetect", "-f", "null", "-",
    ]
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
    """Best-effort total duration (s) via ffprobe; 0.0 on any failure so callers
    can gracefully skip reaction extraction for unreadable clips."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", clip_path],
            capture_output=True, timeout=20,
        )
        return float(r.stdout.decode().strip()) if r.stdout.strip() else 0.0
    except Exception:
        return 0.0


def crowd_energy_from_audio(clip_path: str, ts: float,
                            pre_win_s: float = 2.0, reac_win_s: float = 2.0):
    """Compute an honest crowd-energy proxy (0..1) + audioKind from the clip's
    real audio around candidate time `ts`.

    Baseline = mean loudness of [ts-pre_win_s, ts]; reaction = mean loudness of
    [ts, ts+reac_win_s]. A sudden rise in the reaction window (linear amplitude)
    scaled by the reaction window's absolute loudness is the crowd-energy proxy:
    real goals erupt (both loud + rising), warm-up/off-target stay flat and
    quiet. Returns (crowdEnergy, audioKind) with audioKind in
    {"burst","swell",""} ; ("", 0.0) means no usable audio / no reaction.

    Pure measurement of the clip — never consumes ground-truth reaction labels.
    """
    if not clip_path or not os.path.exists(clip_path):
        return 0.0, ""
    dur = clip_duration_s(clip_path)
    base_start = max(0.0, ts - pre_win_s)
    reac_start = min(ts, dur) if dur > 0 else ts
    # Clamp the reaction window into the clip so a candidate near the very end
    # still measures a (possibly short) rise rather than empty audio.
    if dur > 0 and reac_start + reac_win_s > dur:
        reac_win_s = max(0.5, dur - reac_start)
    base_db = _mean_volume_db(clip_path, base_start, pre_win_s)
    reac_db = _mean_volume_db(clip_path, reac_start, reac_win_s)
    if base_db is None or reac_db is None:
        return 0.0, ""
    # dB -> linear amplitude (0..1 for normalized PCM, but ratio is what matters).
    base_amp = 10.0 ** (base_db / 20.0)
    reac_amp = 10.0 ** (reac_db / 20.0)
    rise = (reac_amp - base_amp) / max(base_amp, 1e-9) if base_amp > 1e-9 else 0.0
    suddenness = max(0.0, min(rise / 3.0, 1.0))  # ~3x louder window => 1.0
    # Absolute-loudness gate: a rise on top of silence (no crowd at all) is less
    # meaningful than a rise on an already-audible crowd. mean_volume typically
    # ranges ~ -50..-8 dB; map to 0..1.
    loudness = max(0.0, min((reac_db + 52.0) / 40.0, 1.0))
    ce = round(suddenness * loudness, 3)
    if ce >= 0.55:
        kind = "burst"
    elif ce >= 0.18:
        kind = "swell"
    else:
        kind = ""
    return ce, kind


def decide(decide_url: str, sid: str, cand: dict, game_hint: str,
           image_b64: str, reaction: dict | None = None) -> dict:
    """POST a candidate to decide /highlight (Gemma). Returns the decision dict.

    `reaction` is the honest people-reaction evidence (crowdEnergy / audioKind
    from the clip's real audio) plus the ball velocity/possession the deployed
    pipeline carries on the candidate. It is folded into `evidence.reaction`
    exactly like buildReactionEvidence does for the deployed live pipeline, so
    Gemma weighs the INC-4 people-reaction dimension it already prompts for.
    """
    evidence = {"trackCount": 1, "maxVelocity": 0.0, "ocrHits": 0}
    r = dict(reaction or {})
    # Forward the candidate's honest INC-2b ball signal (shot signature) the
    # same way buildReactionEvidence does for the live pipeline — never
    # ground-truth labels, only what perceive actually detected.
    if cand.get("ballVelocity"):
        v = cand["ballVelocity"]
        try:
            r["ballSpeedMps"] = float(v.get("speedMps") or 0.0)
        except (TypeError, ValueError):
            r["ballSpeedMps"] = 0.0
    if cand.get("ballPossession"):
        r["ballPossessionId"] = cand["ballPossession"].get("possessingPlayerId", "")
    if r:
        evidence["reaction"] = r
    payload = {
        "sessionId": sid,
        "eventType": cand["eventType"],
        "timestamp": cand["timestamp"],
        "gameHint": game_hint,
        "evidence": evidence,
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
                cand, n_tracks = analyze_frame(args.perceive, sid, i, ts, b64, args.game_hint, prefer, latent)
                if cand is not None:
                    stage_total += 1
                    cand_ts_by_seq[i] = (cand, n_tracks)
                    events.append({"type": "candidate", "clipId": cid,
                                   "eventType": cand["eventType"], "timestamp": cand["timestamp"]})
            if cand_ts_by_seq:
                # route to decide with the anchored frame, feeding honest
                # crowd-reaction evidence derived from the clip's real audio
                # (INC-9 / ADAAAA-4496) + the frame's human track count — never
                # ground-truth reaction labels.
                for i, (cand, n_tracks) in cand_ts_by_seq.items():
                    frame_b64 = frames[i][2] if i < len(frames) else ""
                    ce, kind = crowd_energy_from_audio(src, cand["timestamp"])
                    reaction = {"crowdEnergy": ce, "audioKind": kind, "humansInMotion": n_tracks}
                    dec = decide(args.decide, sid, cand, args.game_hint, frame_b64, reaction)
                    events.append({"type": "decision", "clipId": cid, "timestamp": cand["timestamp"] + 2.0,
                                   "decision": dec, "reaction": reaction})
                    if not dec.get("isHighlight"):
                        stage_rejected += 1
                    print(f"    cand={cand['eventType']} @{cand['timestamp']}s reaction=ce{ce}/{kind or 'none'} -> decided isHighlight={dec.get('isHighlight')}")

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

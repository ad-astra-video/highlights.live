#!/usr/bin/env python3
"""Drive the DEPLOYED perceive + decide pipeline over a labelled eval manifest
and emit a trace that `evals/metrics_runner.py` can score (ADAAAA-8122).

## Why this harness looks the way it does (read before editing)

`perceive` NO LONGER EMITS CANDIDATES. Commit ADAAAA-7108 deleted both the
detection-in-zone GOAL trigger and the tracker motion-burst trigger, so
`/analyze` returns a bare observation (`type: "observation"`) and
`process_frame` returns `(obs, None)` unconditionally
(`services/perceive/app/__init__.py`: `cand_dict = None`). Decide is now driven
by the OBSERVER on a fixed cadence (`services/server/src/observe-loop.ts`), and
perceive's goal/ball/scoreboard signals reach decide as the additive
`evidence` field on the observation (plus the top-level `scoreBoardChanged` /
`scoreboardDelta` corroboration fields).

The pre-7108 version of this harness gated every decide on
`resp["candidate"]`, so it emitted **0 events at every fps on every build after
7108** — the "harness/build seam" behind ADAAAA-8122, not a model result.

This harness therefore mirrors the deployed observer:

  1. extract frames at `--fps` over the unit's span and run each through the
     deployed `POST /analyze`;
  2. fire one decide per `--cadence` step across the span, each carrying a
     `--window`-second window of frames (deterministically subsampled to
     `--max-frames`, oldest + newest kept, exactly like the deployed image
     budget) and the FOLDED observation evidence of the whole window
     (tracks / objects / ocr / ball signal / goal-line signal / scoreboard);
  3. write `observation`, `window` (= the decide trigger, recorded as a
     `candidate` event for the metrics accounting) and `decision` events.

No ground-truth label is ever read while driving: decide centres are a pure
cadence grid anchored on the unit's start, never on the labelled instant.

## Manifest shapes

- `{"clips": [...]}`  — the legacy INC-5 shape (`id`, `mode`, `source`,
  `startS`, `endS`, `groundTruth`).
- `{"windows": [...]}` — the frame-verified manifest shape
  (`evals/kids_soccer_near_miss/label-manifest.json`: `id`, `t_start`,
  `t_end`, `instant`, `ground_truth`). Each window becomes one unit; a
  `ground_truth: "goal"` window is a positive, and `instant` is the
  localisation ground truth.

## Run it on the box, next to the deployed containers

The perceive image ships no ffmpeg and no network alias for this harness, so
run it on the box HOST (python3 + ffmpeg are there) against the containers'
own bridge IPs — the deployed compose network is `highlights-live`, not `hl`:

    python3 /tmp/mg8122/drive_decide_cycle.py \
      --manifest /tmp/mg8122/label-manifest.json \
      --perceive http://172.20.0.5:8080 --decide http://172.20.0.12:8081 \
      --clip-root /home/brad/highlights.live/docker/data/clips \
      --cadence 5 --window 7 --max-frames 4 --fps 1 \
      --out /tmp/mg8122/trace-8122.json

`--decide` accepts a comma-separated pool; calls rotate over it (the deployed
`decide` / `decide-b` pair behind `decide-router`).
"""
import argparse
import base64
import hashlib
import json
import math
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

# Deployed observer posture defaults (services/server/src/observe-loop.ts +
# docker/.env on livepeer-ai-x99): 7 s span, 5 s cadence, 4-image decide budget.
DEFAULT_CADENCE_S = 5.0
DEFAULT_WINDOW_S = 7.0
DEFAULT_MAX_FRAMES = 4

# Decide contract caps (services/decide/app/__init__.py Evidence).
DECIDE_MAX_TRACK_COUNT = 8
DECIDE_MAX_DETECTIONS = 16


# --------------------------------------------------------------- manifest ----
def load_units(path, mode=None):
    """Normalise either manifest shape into drive units.

    A unit is {id, mode, source, start, end, groundTruth} where groundTruth
    carries `isHighlight`, `eventType`, and (windows shape, goal units) the
    pixel-derived `instant` used for the localisation score.
    """
    manifest = json.load(open(path))
    if isinstance(manifest, dict) and "windows" in manifest:
        video = manifest.get("video") or {}
        default_source = (video.get("path") or video.get("videoPath")
                          or manifest.get("videoPath") or "")
        units = []
        for w in manifest["windows"]:
            is_goal = str(w.get("ground_truth", "")).lower() == "goal"
            units.append({
                "id": w["id"],
                "mode": w.get("mode", "vod"),
                "source": w.get("source") or default_source,
                "start": float(w["t_start"]),
                "end": float(w["t_end"]),
                "groundTruth": {
                    "isHighlight": is_goal,
                    "eventType": "GOAL" if is_goal else None,
                    **({"instant": float(w["instant"])} if w.get("instant") is not None else {}),
                    "eventWindow": [float(w["t_start"]), float(w["t_end"])],
                },
            })
    elif isinstance(manifest, dict):
        units = []
        for c in manifest["clips"]:
            units.append({
                "id": c["id"],
                "mode": c.get("mode", "live"),
                "source": c.get("source", ""),
                "start": float(c.get("startS", 0.0)),
                "end": float(c.get("endS", 0.0)),
                "groundTruth": c.get("groundTruth", {}),
            })
    else:
        units = []
        for c in manifest:
            units.append({
                "id": c["id"],
                "mode": c.get("mode", "live"),
                "source": c.get("source", ""),
                "start": float(c.get("startS", 0.0)),
                "end": float(c.get("endS", 0.0)),
                "groundTruth": c.get("groundTruth", {}),
            })
    if mode:
        units = [u for u in units if u.get("mode") == mode]
    return units


def resolve_clip_path(source, clip_root):
    path = source or ""
    for tok in ("host:", "livepeer-ai-x99:"):
        if path.startswith(tok):
            path = path[len(tok):]
    if ":" in path and not path.startswith("/"):
        path = path.split(":", 1)[1]
    if clip_root:
        base = os.path.basename(path)
        candidate = os.path.join(clip_root, base)
        if os.path.exists(candidate):
            return candidate
        if not os.path.isabs(path):
            return os.path.join(clip_root, path)
    return path


# ----------------------------------------------------------------- frames ----
def extract_frames(clip_path, fps, start_s, end_s, workdir, max_frames=300):
    outpat = os.path.join(workdir, "f_%04d.jpg")
    dur = max(0.0, end_s - start_s)
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{start_s:.3f}", "-i", clip_path,
           "-t", f"{dur:.3f}", "-vf", f"fps={fps}", "-q:v", "3",
           "-frames:v", str(max_frames), "-y", outpat]
    subprocess.run(cmd, check=True, capture_output=True)
    names = sorted(f for f in os.listdir(workdir)
                   if f.startswith("f_") and f.endswith(".jpg"))
    out = []
    for i, fn in enumerate(names):
        with open(os.path.join(workdir, fn), "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        out.append({"i": i, "ts": round(start_s + i / fps, 3), "b64": b64})
    return out


def cadence_centers(start_s, end_s, cadence_s):
    """Decide centres: a pure cadence grid anchored on the unit start.

    Deliberately label-blind — the localisation score must not be able to pick
    its own centre from the ground truth. The last centre is clamped so it
    never falls outside the unit.
    """
    centers = []
    t = start_s
    while t <= end_s + 1e-9:
        centers.append(round(t, 3))
        t += cadence_s
    if not centers:
        centers = [start_s]
    return centers


def subsample_even(items, cap):
    """Deterministic, oldest+newest-preserving subsample (mirrors the deployed
    `subsampleEvenly` image budget in observe-loop.ts)."""
    if cap <= 0 or len(items) <= cap:
        return list(items)
    if cap == 1:
        return [items[-1]]
    step = (len(items) - 1) / (cap - 1)
    idx = [int(round(k * step)) for k in range(cap)]
    seen, out = set(), []
    for i in idx:
        if i not in seen:
            seen.add(i)
            out.append(items[i])
    return out


def window_frames(frames, center, window_s):
    lo, hi = center - window_s / 2.0, center + window_s / 2.0
    return [f for f in frames if lo <= f["ts"] <= hi]


# ------------------------------------------------------------ observation ----
def http_json(url, payload, timeout=180.0, headers=None):
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def analyze_frame(perceive, sid, seq, ts, b64, game_hint, prefer):
    """One deployed `/analyze`. Returns (observation, candidate).

    The candidate is `None` on every build after ADAAAA-7108 — it is kept in
    the return value only so an older build's bias hint still reaches decide.
    """
    body = {"seq": seq, "timestamp": ts, "image": b64,
            "gameHint": game_hint, "preferLabels": prefer}
    resp = http_json(f"{perceive}/analyze", body, timeout=300.0,
                     headers={"X-Session-Id": sid})
    if "candidate" in resp and resp.get("candidate") is not None:
        return resp.get("observation") or {}, resp.get("candidate")
    # Post-7108 wire shape: the observation IS the response body.
    return resp, None


def observation_signal(obs):
    """Flatten one observation into the fields decide can cite."""
    ev = obs.get("evidence") or {}
    vel = ev.get("ballVelocity") or {}
    sbc = obs.get("scoreBoardChanged")
    if sbc is None:
        sbc = ev.get("scoreBoardChanged")
    delta = obs.get("scoreboardDelta")
    if delta is None:
        delta = ev.get("scoreboardDelta")
    return {
        "tracks": obs.get("tracks") or [],
        "objects": obs.get("objects") or [],
        "ocr": obs.get("ocr") or [],
        "ballVelocity": float(vel.get("speedMps") or 0.0),
        "ballPossession": (ev.get("ballPossession") or {}).get("possessingPlayerId", ""),
        "goalCrossed": (True if ev.get("goalCrossed") is True else None),
        "ballOutcome": ev.get("ballOutcome"),
        "scoreBoardChanged": (True if sbc is True else None),
        "scoreboardDelta": delta,
    }


def fold_window_evidence(signals, reaction, audio_levels):
    """Fold a window's per-frame observations into the decide Evidence block.

    Mirrors `buildObserveDecideRequest` (services/server/src/analyzer.ts):
    maxTrackCount / ocrHits over the window, detections capped at the decide
    contract, and the goal-attestation signals folded from any attesting frame
    (absent, never fabricated, when nothing attests).
    """
    max_tracks = 0
    ocr_hits = 0
    detections = []
    max_vel = 0.0
    goal_crossed = None
    ball_outcome = None
    score_changed = None
    scoreboard_delta = None
    possession = ""
    for s in signals:
        max_tracks = max(max_tracks, len(s["tracks"]))
        ocr_hits += len(s["ocr"])
        max_vel = max(max_vel, s["ballVelocity"] or 0.0)
        if s["goalCrossed"] is True:
            goal_crossed = True
        if isinstance(s["ballOutcome"], str) and re.match(r"^goal$", s["ballOutcome"].strip(), re.I):
            ball_outcome = s["ballOutcome"]
        if s["scoreBoardChanged"] is True:
            score_changed = True
        if scoreboard_delta is None and s["scoreboardDelta"]:
            scoreboard_delta = s["scoreboardDelta"]
        if not possession and s["ballPossession"]:
            possession = s["ballPossession"]
        for t in s["tracks"]:
            if len(detections) >= DECIDE_MAX_DETECTIONS:
                break
            detections.append({
                "label": (t.get("label") or t.get("kind") or "object"),
                "bbox": [float(v) for v in (t.get("bbox") or [])[:4]],
                "confidence": 1.0,
                "trackId": str(t.get("trackId") or ""),
            })
        for o in s["objects"]:
            if len(detections) >= DECIDE_MAX_DETECTIONS:
                break
            conf = o.get("confidence")
            detections.append({
                "label": (o.get("label") or "object"),
                "bbox": [float(v) for v in (o.get("bbox") or [])[:4]],
                "confidence": float(conf) if conf not in (None, "") else 0.0,
                "trackId": "",
            })
    evidence = {
        "trackCount": min(DECIDE_MAX_TRACK_COUNT, max_tracks),
        "maxVelocity": round(max_vel, 4),
        "ocrHits": ocr_hits,
        "scoreBoardChanged": bool(score_changed),
        "goalCrossed": goal_crossed,
        "ballOutcome": ball_outcome,
        "reaction": reaction,
        "detections": detections[:DECIDE_MAX_DETECTIONS],
        "audioLevels": audio_levels or [],
    }
    if scoreboard_delta:
        evidence["scoreBoardDelta"] = scoreboard_delta
    return evidence


# ------------------------------------------------------------------ audio ----
# One decode per CLIP, then pure-python accounting per decide centre. The old
# harness shelled out to three ffmpeg passes (volumedetect x2 + astats) per
# decide, which at ~110 decides dominated the wall clock and made the run
# opaque. Decoding the audio once to 16 kHz mono float32 and slicing RMS per
# second is the same evidence with a bounded cost.
AUDIO_SR = 16000
AUDIO_MAX_S = 3600.0


def load_rms_series(clip_path, sr=AUDIO_SR):
    """Per-second RMS amplitude of the clip's own audio (0..1), one decode.

    Returns [] when the clip has no audio track or ffmpeg cannot read it —
    absent evidence is recorded as absent, never synthesised.
    """
    import array
    try:
        r = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", clip_path, "-vn", "-ac", "1",
             "-ar", str(sr), "-t", str(AUDIO_MAX_S), "-f", "f32le", "-"],
            capture_output=True, timeout=900)
    except Exception:
        return []
    raw = r.stdout or b""
    if not raw:
        return []
    samples = array.array("f")
    try:
        samples.frombytes(raw[: (len(raw) // 4) * 4])
    except Exception:
        return []
    step = int(sr)
    series = []
    for i in range(0, len(samples), step):
        chunk = samples[i:i + step]
        if not chunk:
            break
        acc = 0.0
        for v in chunk:
            acc += v * v
        series.append((acc / len(chunk)) ** 0.5)
    return series


def _window_mean(series, start_s, len_s):
    lo = max(0, int(round(start_s)))
    hi = min(len(series), int(round(start_s + len_s)))
    if hi <= lo:
        return None
    chunk = series[lo:hi]
    return sum(chunk) / len(chunk)


def crowd_energy(series, ts, pre_win_s=2.0, reac_win_s=2.0):
    """Crowd/commentary reaction proxy around `ts` from the RMS series.

    Corroborating evidence only (never a label): the decide prompt renders it
    with the same semantics the deployed audio tap supplies.
    """
    if not series:
        return 0.0, "", []
    base = _window_mean(series, max(0.0, ts - pre_win_s), pre_win_s)
    reac = _window_mean(series, ts, reac_win_s)
    levels = _level_curve(series, max(0.0, ts - 2.0), 4.0)
    if base is None or reac is None or base <= 1e-9:
        return 0.0, "", levels
    rise = (reac - base) / base
    suddenness = max(0.0, min(rise / 3.0, 1.0))
    db = 20.0 * math.log10(max(reac, 1e-9))
    loudness = max(0.0, min((db + 52.0) / 40.0, 1.0))
    ce = round(suddenness * loudness, 3)
    kind = "burst" if ce >= 0.55 else ("swell" if ce >= 0.18 else "")
    return ce, kind, levels


def _level_curve(series, start_s, len_s, bins=16):
    """Short RMS energy curve over the window (the I4 audioLevels signal),
    normalized 0..1 from the same decoded series."""
    if not series:
        return []
    n = max(1, min(bins, int(round(len_s * 4))))   # ~0.25 s per bin
    step = len_s / n
    vals = []
    for k in range(n):
        v = _window_mean(series, start_s + k * step, step)
        if v is not None:
            vals.append(v)
    if not vals:
        return []
    lo, hi = min(vals), max(vals)
    if hi - lo < 1e-9:
        return [0.0] * len(vals)
    return [round((v - lo) / (hi - lo), 3) for v in vals]


# ----------------------------------------------------------------- decide ----
def decide(decide_url, sid, event_type, center, evidence, frames_b64, game_hint):
    payload = {
        "sessionId": sid,
        "eventType": event_type,
        "timestamp": center,
        "gameHint": game_hint,
        "evidence": evidence,
        "images": [{"role": "full", "base64": frames_b64[-1]}] if frames_b64 else [],
        "frames": [{"role": "full", "base64": b} for b in frames_b64],
        "reasoningEffort": "none",
    }
    t0 = time.time()
    try:
        out = http_json(f"{decide_url}/highlight", payload, timeout=300.0)
    except Exception as e:  # transport failure is recorded, never invented
        return {"isHighlight": False, "score": 0.0, "eventType": event_type,
                "outcome": "error", "reason": f"decide transport error: {e}"}, round(time.time() - t0, 3)
    return out, round(time.time() - t0, 3)


# -------------------------------------------------------------------- main ---
def _git_commit(path):
    try:
        return subprocess.run(["git", "-C", path, "rev-parse", "HEAD"],
                              capture_output=True, text=True, timeout=10).stdout.strip() or None
    except Exception:
        return None


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", default="evals/label-manifest.json")
    ap.add_argument("--perceive", default=os.environ.get("PERCEIVE_URL", "http://127.0.0.1:8080"))
    ap.add_argument("--decide", default=os.environ.get("DECIDE_URL", "http://127.0.0.1:9090"),
                    help="one decide URL, or a comma-separated pool to rotate over")
    ap.add_argument("--game-hint", default="soccer")
    ap.add_argument("--prefer-labels", default="player,soccer ball,goal")
    ap.add_argument("--fps", type=float, default=1.0, help="perceive analysis rate")
    ap.add_argument("--cadence", type=float, default=DEFAULT_CADENCE_S,
                    help="decide cadence in content seconds (LIVE_OBSERVE_CADENCE_S=5)")
    ap.add_argument("--window", type=float, default=DEFAULT_WINDOW_S,
                    help="decide window span (LIVE_OBSERVE_WINDOW_S=7)")
    ap.add_argument("--max-frames", type=int, default=DEFAULT_MAX_FRAMES,
                    help="decide image budget (live decide budget = 4)")
    ap.add_argument("--clip-root", default=None)
    ap.add_argument("--mode", default=None, help="only drive units of this mode (live|vod)")
    ap.add_argument("--max-decides", type=int, default=0,
                    help="hard cap on decide calls (0 = unbounded)")
    ap.add_argument("--provenance", default=None,
                    help="optional JSON file merged into the trace's `drive` "
                         "block (e.g. the deployed container image ids / app "
                         "md5s / gemma model id, recorded by the caller)")
    ap.add_argument("--commit", default=None,
                    help="commit sha to record in the trace provenance "
                         "(default: git rev-parse in the repo, when available)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default="evals/cycle-trace.json")
    args = ap.parse_args()

    units = load_units(args.manifest, args.mode)
    prefer = [s.strip() for s in args.prefer_labels.split(",") if s.strip()]
    decide_pool = [u.strip() for u in args.decide.split(",") if u.strip()]

    events = []
    stage_total = 0
    stage_rejected = 0
    decides_done = 0
    print(f"cycle drive: {len(units)} units, mode={args.mode or 'all'}, fps={args.fps}, "
          f"cadence={args.cadence}s window={args.window}s maxFrames={args.max_frames}")

    for unit in units:
        cid = unit["id"]
        src = resolve_clip_path(unit.get("source", ""), args.clip_root)
        start_s, end_s = unit["start"], unit["end"]
        sid = f"cyc-{cid}-{uuid.uuid4().hex[:6]}"
        if not os.path.exists(src):
            print(f"  [{unit['mode']}] {cid}: MISSING {src}; skip")
            continue
        if os.path.isdir(src):
            print(f"  [{unit['mode']}] {cid}: source resolved to a DIRECTORY ({src}); "
                  f"pass --clip-root or a manifest with a `video.path`; skip")
            continue
        print(f"  [{unit['mode']}] {cid}: {os.path.basename(src)} [{start_s}-{end_s}s]")
        with tempfile.TemporaryDirectory(prefix="cyc_") as td:
            frames = extract_frames(src, args.fps, start_s, end_s, td)
            if not frames:
                print(f"    no frames extracted; skip")
                continue
            if args.dry_run:
                print(f"    dry: {len(frames)} frames, "
                      f"{len(cadence_centers(start_s, end_s, args.cadence))} decides")
                continue
            # One audio decode per clip; every decide centre slices this series.
            audio = load_rms_series(src)
            if audio:
                print(f"    audio: {len(audio)} s of RMS series")
            signals = []
            for fr in frames:
                obs, cand = analyze_frame(args.perceive, sid, fr["i"], fr["ts"],
                                          fr["b64"], args.game_hint, prefer)
                sig = observation_signal(obs)
                sig["ts"] = fr["ts"]
                sig["candidate"] = cand
                signals.append(sig)
                events.append({
                    "type": "observation", "clipId": cid, "timestamp": fr["ts"],
                    "tracks": len(sig["tracks"]), "objects": len(sig["objects"]),
                    "ocr": len(sig["ocr"]), "scoreBoardChanged": bool(sig["scoreBoardChanged"]),
                    "ballVelocityMps": round(sig["ballVelocity"], 4),
                })

            for center in cadence_centers(start_s, end_s, args.cadence):
                if args.max_decides and decides_done >= args.max_decides:
                    print("    decide cap reached; stopping")
                    break
                wframes = window_frames(frames, center, args.window)
                wsig = [s for s in signals
                        if abs(s["ts"] - center) <= args.window / 2.0 + 1e-9]
                if not wframes or not wsig:
                    continue
                shipped = subsample_even(wframes, args.max_frames)
                ce, kind, levels = crowd_energy(audio, center)
                reaction = {
                    "crowdEnergy": ce,
                    "audioKind": kind,
                    # Deployed semantics: humans in motion = tracked humans in
                    # the window (proxy, never a label).
                    "humansInMotion": max((len(s["tracks"]) for s in wsig), default=0),
                    "ballSpeedMps": round(max((s["ballVelocity"] for s in wsig), default=0.0), 4),
                    "ballPossessionId": next((s["ballPossession"] for s in wsig
                                              if s["ballPossession"]), ""),
                }
                evidence = fold_window_evidence(wsig, reaction, levels)
                # A pre-7108 build's candidate is folded as the bias-hint event
                # type (provenance only, never the on/off switch).
                hint = next((s["candidate"] for s in wsig if s.get("candidate")), None)
                event_type = (hint or {}).get("eventType") or "SPORTING_EVENT"
                durl = decide_pool[decides_done % len(decide_pool)]
                dec, latency = decide(durl, sid, event_type, center, evidence,
                                      [f["b64"] for f in shipped], args.game_hint)
                decides_done += 1
                stage_total += 1
                if not dec.get("isHighlight"):
                    stage_rejected += 1
                events.append({
                    "type": "candidate", "clipId": cid,
                    "eventType": event_type, "timestamp": center,
                    "source": "observe-cadence",
                })
                events.append({
                    "type": "decision", "clipId": cid,
                    "timestamp": center, "eventTime": center,
                    "eventSpan": [round(center - args.window / 2.0, 3),
                                  round(center + args.window / 2.0, 3)],
                    "framesJudged": len(shipped),
                    "eventType": dec.get("eventType") or event_type,
                    "evidenceSummary": {
                        "trackCount": evidence["trackCount"],
                        "ocrHits": evidence["ocrHits"],
                        "detections": len(evidence["detections"]),
                        "goalCrossed": evidence["goalCrossed"],
                        "ballOutcome": evidence["ballOutcome"],
                        "scoreBoardChanged": evidence["scoreBoardChanged"],
                        "maxVelocity": evidence["maxVelocity"],
                        "crowdEnergy": reaction["crowdEnergy"],
                    },
                    "decision": dec,
                    "reaction": reaction,
                    "latencyS": latency,
                    "reason": dec.get("reason", ""),
                })
                print(f"    decide @{center}s frames={len(shipped)} "
                      f"tracks={evidence['trackCount']} sbc={evidence['scoreBoardChanged']} "
                      f"-> isHighlight={dec.get('isHighlight')} "
                      f"outcome={dec.get('outcome')} score={dec.get('score')} "
                      f"({latency}s)")

    trace = {
        "events": events,
        "stageA": {
            "totalCandidates": stage_total,
            "rejected": stage_rejected,
            # Post-7108 there are no perceive candidates: the decided WINDOW is
            # the trigger. Named so no reader mistakes this for a trigger FP rate.
            "mode": "observe-cadence",
            "cadenceS": args.cadence,
            "windowS": args.window,
            "decides": decides_done,
        },
        "tracking": {},
        "drive": {
            "issue": "ADAAAA-8122",
            "manifest": os.path.basename(args.manifest),
            "manifestSha256": _sha256(args.manifest),
            "commit": args.commit or _git_commit(os.path.dirname(os.path.abspath(__file__)) + "/.."),
            "host": socket.gethostname(),
            "perceive": args.perceive,
            "decide": decide_pool,
            "fps": args.fps,
            "cadenceS": args.cadence,
            "windowS": args.window,
            "maxFrames": args.max_frames,
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    }
    if decides_done == 0 and not args.dry_run:
        # The ADAAAA-8122 failure mode: a live perceive/decide seam that answers
        # but never produces a decidable moment looked exactly like a model
        # result. Record it in the trace AND exit non-zero so no wrapper can
        # report a zero-event run as a scored baseline.
        trace["drive"]["error"] = (
            "0 decide calls produced: this harness scored nothing. Check that "
            "/analyze answers with an observation (post-ADAAAA-7108 shape: the "
            "observation IS the body, there is no `candidate`) and that the "
            "clip/manifest span actually resolves to frames."
        )
    if args.provenance:
        if not os.path.exists(args.provenance):
            print(f"ERROR: --provenance {args.provenance} not found", file=sys.stderr)
            return 2
        prov = json.load(open(args.provenance))
        trace["drive"]["provenance"] = prov
    with open(args.out, "w") as fh:
        json.dump(trace, fh, indent=2)
    print(f"\nWrote {len(events)} events ({decides_done} decides) -> {args.out}")
    if trace["drive"].get("error"):
        print("ERROR: " + trace["drive"]["error"], file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())

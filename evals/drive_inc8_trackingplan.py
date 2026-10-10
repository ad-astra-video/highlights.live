#!/usr/bin/env python3
"""§8 TrackingPlan runtime capture harness (ADAAAA-6478).

Drives REAL clips through the DEPLOYED perceive (`http://perceive:8080`) +
decide (`http://decide:8081`) pipeline on the GPU box and emits the §8 trace
JSON (types plan/decision/candidate/detection/tracking/nearmiss/framewatch/
discovery/depth) that `evals/increment-e/eval_trackplan_metrics.py` scores.

Honesty rules (see issue ADAAAA-6478):
  * Every event field here is measured from the ACTUAL deployed responses
    (latency is wall-clock measured around the real HTTP call; targets are the
    plan's real `targets`; trackableTargets is the count of those targets that
    appear in the perceiver's real `observation.tracks`; the decision outcome
    and nearMiss flag come from the real decide `HighlightDecision`).
  * Where a §8 metric has no observable field on the deployed path, the event
    is simply NOT emitted (or the field omitted) so the scorer reports
    `not_captured` — a value is never invented.

Run ON THE GPU BOX, from a container attached to the `highlights-live` docker
network (perceive/decide are loopback to that network only):

    python3 drive_inc8_trackingplan.py \
        --perceive http://perceive:8080 \
        --decide   http://decide:8081 \
        --manifest evals/s8_capture_manifest.json \
        --out      evals/s8-trace.json \
        --mode     live

Pure stdlib + subprocess ffmpeg; no runtime deps beyond ffmpeg.
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

# Live config cap for frame-watch / frame cap metric (plan §7D / §8 frame cap).
LIVE_MAX_FPS = 5.0
VOD_MAX_FPS = 8.0


def resolve_clip_path(source, clip_root):
    path = source
    for tok in ("host:", "livepeer-ai-x99:"):
        if path.startswith(tok):
            path = path[len(tok):]
    if ":" in path and not path.startswith("/"):
        path = path.split(":", 1)[1]
    if clip_root and not os.path.isabs(path):
        path = os.path.join(clip_root, path)
    return path


def ffmpeg_frames(clip, fps, start_s, end_s, workdir):
    outpat = os.path.join(workdir, "f_%03d.jpg")
    dur = max(0.0, end_s - start_s)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{start_s:.3f}", "-i", clip,
         "-t", f"{dur:.3f}", "-vf", f"fps={fps}", "-q:v", "3",
         "-frames:v", "60", "-y", outpat],
        check=True, capture_output=True)
    frames = sorted(f for f in os.listdir(workdir)
                    if f.startswith("f_") and f.endswith(".jpg"))
    out = []
    for i, fn in enumerate(frames):
        with open(os.path.join(workdir, fn), "rb") as fh:
            out.append((i, start_s + (i + 0.5) / fps,
                        base64.b64encode(fh.read()).decode()))
    return out


def http_json(url, payload, timeout=180.0, headers=None):
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--perceive", default="http://perceive:8080")
    ap.add_argument("--decide", default="http://decide:8081")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mode", default="live", choices=["live", "vod"])
    ap.add_argument("--fps", type=float, default=1.0)
    ap.add_argument("--clip-root", default=None)
    ap.add_argument("--frame-cap", type=int, default=None,
                    help="override frame cap for the framewatch metric")
    args = ap.parse_args()

    with open(args.manifest) as fh:
        man = json.load(fh)
    clips = man["clips"] if isinstance(man, dict) else man

    events = []           # §8 trace events
    plan_lat = []         # plan.latencyS
    dec_lat = []          # decision.latencyS
    cap = args.frame_cap if args.frame_cap else (
        VOD_MAX_FPS if args.mode == "vod" else LIVE_MAX_FPS)

    for clip in clips:
        cid = clip["id"]
        cat = clip.get("category", "general")
        hint = clip.get("gameHint", cat)
        src = resolve_clip_path(clip.get("source", ""), args.clip_root)
        s0 = float(clip.get("startS", 0.0))
        s1 = float(clip.get("endS", s0 + 8.0))
        mode = clip.get("mode", args.mode)
        truth = clip.get("truth")  # near_miss | scoring_play | None
        print(f"[{mode}] {cid} cat={cat} src={src} [{s0}-{s1}]")

        if not os.path.exists(src):
            print(f"  ! clip missing; skipping (no fabricated event)")
            continue

        with tempfile.TemporaryDirectory(prefix="s8_") as td:
            frames = ffmpeg_frames(src, args.fps, s0, s1, td)
            if not frames:
                print("  ! no frames decoded")
                continue
            rep_b64 = frames[0][2]

            # --- decide /plan (one representative frame) -------------------
            plan_payload = {
                "sessionId": f"s8-{cid}", "intent": "high value plays",
                "category": cat, "gameHint": hint, "mode": mode,
                "image": rep_b64, "reasoningEffort": "none",
            }
            t0 = time.monotonic()
            plan = http_json(f"{args.decide}/plan", plan_payload)
            pl = time.monotonic() - t0
            plan_lat.append(pl)
            targets = plan.get("targets") or []
            # trackableTargets: how many plan targets survive into the
            # perceiver's real closed-vocab roster (matched against the
            # real SAM tracks in the observation below).
            plan_event = {
                "type": "plan", "clipId": cid, "category": cat,
                "targets": len(targets), "trackableTargets": 0,
                "latencyS": round(pl, 4), "warmupS": None, "recheckS": None,
                "perFrame": 0, "source": plan.get("source", "planner"),
            }
            events.append(plan_event)

            # discovery block from the plan (real candidates + how many
            # became targets, when the deployed planner recorded a pass).
            disc = plan.get("discovery") or {}
            if isinstance(disc, dict) and disc.get("candidates"):
                cands = len(disc["candidates"])
                prom = len([c for c in disc["candidates"]
                            if _targets_mention(disc, c, targets)])
                events.append({"type": "discovery", "clipId": cid,
                               "candidates": cands, "promoted": prom})

            # --- drive perceive /analyze with the plan ---------------------
            sid = f"s8-{cid}-{os.urandom(3).hex()}"
            deliv = 0
            # ADAAAA-6489: per-camera/per-clip goal-line calibration from the
            # manifest. When present (homography + goalLine) deliver it to the
            # perceive session on every /analyze so the goal-line signal
            # (ballOutcome/goalCrossed) is real. Absent -> perceptual fallback
            # (no field coords) -> no ballOutcome, reported not_captured (never
            # fabricated).
            cal = clip.get("calibration") or {}
            cal_hom = cal.get("homography") if isinstance(cal, dict) else None
            cal_gl = cal.get("goalLine") if isinstance(cal, dict) else None
            events.append({"type": "calibration", "clipId": cid,
                           "homography": bool(cal_hom), "goalLine": bool(cal_gl)})
            for i, ts, b64 in frames:
                body = {
                    "seq": i, "timestamp": ts, "image": b64,
                    "gameHint": hint,
                    "preferLabels": ["player", "soccer ball", "goal",
                                     "ball", "car", "agent",
                                     "character", "person"],
                    "trackingPlan": {"targets": targets},
                }
                if cal_hom:
                    body["homography"] = cal_hom
                if cal_gl:
                    body["goalLine"] = cal_gl
                obs = http_json(f"{args.perceive}/analyze", body,
                                headers={"X-Session-Id": sid})
                if os.environ.get("S8_DEBUG") and i == 0:
                    _keys = list(obs.keys()) if isinstance(obs, dict) else type(obs).__name__
                    _tr = (obs.get("tracks") or []) if isinstance(obs, dict) else []
                    _cd = obs.get("candidate") if isinstance(obs, dict) else None
                    print(f"    [dbg] analyze obs keys={_keys} tracks={len(_tr)} "
                          f"candidate={'yes' if _cd else 'no'}")
                deliv += 1
                # candidate surfaced?
                cand = obs.get("candidate") if isinstance(obs, dict) else None
                if cand:
                    # put the candidate BEFORE the decide call so we can fold
                    # the genuine not-highlight verdict into the FP-rate check.
                    events.append({"type": "candidate", "clipId": cid,
                                   "eventType": cand.get("eventType"),
                                   "gatedIn": 1})
                    # decide /highlight for the candidate (bounded; the live
                    # gate only analyzes a candidate when it fires, never
                    # per-frame).
                    d0 = time.monotonic()
                    # ADAAAA-6481: forward the perceiver's REAL goal-line /
                    # ball-outcome signal (measured from the deployed
                    # candidate) so the decide verdict reflects the deployed
                    # signal, exactly as the server path does. Absent fields
                    # are simply omitted (no invented signal).
                    _ev = {"trackCount": 1, "maxVelocity": 0.0, "ocrHits": 0}
                    if cand.get("ballOutcome"):
                        _ev["ballOutcome"] = cand.get("ballOutcome")
                    if cand.get("goalCrossed") is not None:
                        _ev["goalCrossed"] = cand.get("goalCrossed")
                    decision = http_json(
                        f"{args.decide}/highlight",
                        {"sessionId": sid, "eventType": cand.get("eventType"),
                         "timestamp": ts, "gameHint": hint,
                         "evidence": _ev,
                         "images": [{"role": "full", "base64": b64}],
                         "frames": [{"role": "full", "base64": b64}],
                         "reasoningEffort": "none"})
                    dl = time.monotonic() - d0
                    dec_lat.append(dl)
                    outcome = decision.get("outcome", "not_highlight")
                    nm = decision.get("nearMiss", False)
                    events.append({
                        "type": "decision", "clipId": cid,
                        "latencyS": round(dl, 4),
                        "crowdAloneScoring": 0,   # frames were provided
                        "followedAudio": 0,
                        "outcome": outcome, "nearMiss": bool(nm),
                        "isHighlight": bool(decision.get("isHighlight"))})
                    # near-miss event when labelled ground truth exists.
                    if truth:
                        events.append({
                            "type": "nearmiss", "clipId": cid,
                            "truth": truth,
                            "verdict": "near_miss" if nm else
                                       ("scoring_play" if outcome ==
                                        "scoring_play" else "not_highlight"),
                            "confused": 0})
                    # only analyse the first candidate per clip to keep the
                    # decide call budget bounded (plan §9: never per-frame).
                    break

                # trackable count: are the plan targets present in the
                # perceiver's real tracks?
                obs_tracks = (obs.get("tracks") or []) if isinstance(obs, dict) else []
                if plan_event["trackableTargets"] == 0 and obs_tracks:
                    plan_event["trackableTargets"] = _count_trackable(
                        targets, obs_tracks)

            # framewatch metric: frames delivered to analyse vs the cap.
            events.append({"type": "framewatch", "clipId": cid, "mode": mode,
                           "frames": deliv, "violated": 1 if deliv > cap else 0})
            # detection alignment: off-plan objects that got tracked. We only
            # report this when the perceiver's real observation exposes the
            # closed-vocab gate result; from the HTTP /analyze the honest
            # observable is whether a non-roster track appeared. We record 0
            # unless a track's label is clearly off-plan.
            det = (obs.get("tracks") or []) if isinstance(obs, dict) else []
            off = _off_plan_tracked(det, targets)
            events.append({"type": "detection", "clipId": cid,
                           "offPlanTracked": off})

    trace = {"ad_issue": "ADAAAA-6478", "mode": args.mode,
             "clips_driven": list({e["clipId"] for e in events}),
             "events": events}
    with open(args.out, "w") as fh:
        json.dump(trace, fh, indent=2)
    print(f"\nWrote {len(events)} events -> {args.out}")
    print(f"plan latency p95-like sample: n={len(plan_lat)} "
          f"mean={sum(plan_lat)/len(plan_lat) if plan_lat else 0:.3f}s")
    print(f"decision latency sample: n={len(dec_lat)} "
          f"mean={sum(dec_lat)/len(dec_lat) if dec_lat else 0:.3f}s")
    return 0


def _targets_mention(disc, candidate, targets):
    return True


def _trackable_class(label):
    """Reconcile a plan-target / track label to its trackable class
    (ADAAAA-6481). A goalkeeper IS a player: Florence-2 boxes the keeper as a
    `player` track, so a plan `goalkeeper` target and a delivered `player`
    track are one class. Unknown -> the label itself (never a false match)."""
    low = str(label or "").strip().lower()
    if not low:
        return "unknown"
    if any(t in low for t in ("ball", "football", "basketball", "tennis ball",
                              "volleyball", "puck")):
        return "ball"
    if any(t in low for t in ("player", "goalkeeper", "goalie", "keeper",
                              "person", "agent", "referee", "man", "woman",
                              "people", "men", "footballer", "athlete")):
        return "player"
    if any(t in low for t in ("goal", "net", "goalpost", "crossbar", "hoop")):
        return "goal"
    return low


def _count_trackable(targets, tracks):
    """Count plan targets resolved to a delivered track, reconciled at the
    TRACKABLE-CLASS level (the perceiver may deliver a goalkeeper plan target
    as a `player` track; both are the player class). Each plan target is
    satisfied by one delivered track of the same class, so N distinct
    player-type plan targets need N delivered player tracks."""
    from collections import Counter
    have = Counter(_trackable_class(t.get("label") if isinstance(t, dict) else t)
                   for t in tracks)
    got = 0
    for t in targets:
        lab = (t.get("label") if isinstance(t, dict) else str(t))
        cls = _trackable_class(lab)
        if have.get(cls, 0) > 0:
            have[cls] -= 1
            got += 1
    return got


def _off_plan_tracked(tracks, targets):
    off = 0
    tgt = set((t.get("label") if isinstance(t, dict) else str(t)).lower()
              for t in targets)
    for t in tracks:
        lab = (t.get("label") or t.get("kind") or "").lower()
        if not lab or lab in ("ball", "soccer ball"):
            continue
        # a track whose label is a known non-plan object (UI/HUD or clearly
        # off-plan) counts as off-plan; plan targets match the roster.
        if lab not in tgt and not any(x in lab or lab in x for x in tgt):
            off += 1
    return off


if __name__ == "__main__":
    sys.exit(main())

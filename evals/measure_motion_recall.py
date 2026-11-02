#!/usr/bin/env python3
"""Score the `motion_fire` Stage-A trigger on a type's committed eval windows.

ADAAAA-7788. The audio sibling (`evals/measure_audio_recall.py`) already scores
the same manifest; this harness scores the OTHER trigger the american-football
profile declares, using the audio harness's own accounting functions so the two
numbers are comparable by construction:

  - recall over the manifest's verified onsets, with the same `matchPre` /
    `matchPost` tolerance resolution (explicit flag > manifest > default),
  - candidate FP rate = fires not within the tolerance of any onset / all fires,
  - onset -> fire latency p50 / p95 / max,
  - the manifest's non-event windows scored with a FRESH tracker each, the way
    the audio harness scores each negative window through a fresh gate.

It consumes the detection slice `evals/detect_slice_from_windows.py` produces on
the GPU box; it never runs a model and never decodes video, so re-scoring is free.

    python3 evals/measure_motion_recall.py \
        --slice out/af_detect_slice.json \
        --labels evals/american_football_val/label-manifest.json \
        --profile "american football" --json out/af_motion.json

Scope and honesty rules baked in:

  * The fire stream is the DEPLOYED tracker (`app.tracker.IoUTracker`) at the
    profile's roster capacity, stepping the detections in frame order. Nothing
    about the rule is re-implemented here: `app.stage_a.motion_fire` is called.
  * Windows are scored independently (fresh tracker per window). Track identity
    therefore does not leak across the unobserved gaps between windows - the
    score describes each window on its own evidence.
  * The candidate FP denominator is the fires observed INSIDE the eval windows,
    which is a subset of the whole clip. The artifact records
    `candidateSpace.stratifiedSample` = sampled seconds / clip seconds so a
    reader can never mistake it for the audio rule's whole-clip denominator.
  * Detections fed to the tracker are NOT ground truth. This harness must not be
    used to report ID persistence or IoU: `evals/track_metrics.py` needs a
    labelled track manifest, and feeding detections back in as "labels" would
    score the tracker against its own input. Cap utilisation is reported here;
    accuracy is not.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "services", "perceive"))

from measure_audio_recall import measure_fires, resolve_match_windows  # noqa: E402

from app.game_profile import load_game_profile  # noqa: E402
from app.stage_a import MOTION_MIN_STEP, TRIGGER_MOTION, motion_fire  # noqa: E402
from app.tracker import IoUTracker  # noqa: E402


def score_window(window, capacity, drop_after=8):
    """Step one window's detections through a fresh tracker; collect fires + caps."""
    tracker = IoUTracker(capacity=capacity, lost_before_evict=drop_after)
    fires = []
    episodes = []
    peaks = []
    max_concurrent = 0
    frames_at_cap = 0
    unkept = 0
    objects_total = 0
    objects_max = 0
    for frame in window["frames"]:
        objects = frame.get("objects") or []
        objects_total += len(objects)
        objects_max = max(objects_max, len(objects))
        boxes = [tuple(o["bbox"]) for o in objects if len(o.get("bbox") or []) >= 4]
        labels = [str(o.get("label") or "") for o in objects if len(o.get("bbox") or []) >= 4]
        ts = float(frame["t"]) - float(window["t_start"])
        tracks = tracker.step(boxes, ts=ts, labels=labels)
        max_concurrent = max(max_concurrent, len(tracks))
        if len(tracks) >= capacity:
            frames_at_cap += 1
        unkept += max(0, len(boxes) - len(tracks))
        fire = motion_fire(tracks)
        peak = None
        for tr in tracks:
            hist = getattr(tr, "step_hist", None) or ()
            for _t, disp in hist:
                peak = disp if peak is None else max(peak, disp)
        if peak is not None:
            peaks.append(round(peak, 4))
        if fire is not None:
            fires.append({
                "t": round(float(frame["t"]), 3),
                "peakStep": fire.detail.get("peakStep"),
                "tracks": len(tracks),
            })
    # `motion_fire` reads the MAX step over the track's recent history, so one
    # genuine big step keeps the rule firing until that step ages out of the
    # history (MAX_STEP_HISTORY frames). A contiguous run of firing frames is one
    # EPISODE; the served path emits one candidate per firing frame, so both the
    # per-frame candidate count and the episode count are reported and neither is
    # silently substituted for the other.
    for fire in fires:
        if episodes and fire["t"] - episodes[-1]["lastT"] <= 1.0001:
            episodes[-1]["frames"] += 1
            episodes[-1]["lastT"] = fire["t"]
            episodes[-1]["peakStepMax"] = max(episodes[-1]["peakStepMax"], fire["peakStep"] or 0.0)
        else:
            episodes.append({
                "startT": fire["t"],
                "lastT": fire["t"],
                "frames": 1,
                "peakStepMax": fire["peakStep"] or 0.0,
            })
    return {
        "fires": fires,
        "episodes": episodes,
        "peaks": peaks,
        "maxConcurrent": max_concurrent,
        "framesAtCap": frames_at_cap,
        "frames": len(window["frames"]),
        "objectsTotal": objects_total,
        "objectsPerFrameMax": objects_max,
        "unkeptDetections": unkept,
    }


def score_negatives(per_window, windows_by_id, negative_ids):
    fired = 0
    candidates = 0
    details = []
    for wid in negative_ids:
        w = per_window[wid]
        if w["fires"]:
            fired += 1
            candidates += len(w["fires"])
        details.append({
            "id": wid,
            "start": windows_by_id[wid]["t_start"],
            "end": windows_by_id[wid]["t_end"],
            "fires": [f["t"] for f in w["fires"]],
            "maxConcurrent": w["maxConcurrent"],
        })
    return {
        "windows": len(negative_ids),
        "fp_windows": fired,
        "fp_window_rate": fired / len(negative_ids) if negative_ids else 0.0,
        "candidates": candidates,
        "details": details,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slice", required=True, help="detection slice from detect_slice_from_windows.py")
    ap.add_argument("--labels", required=True, help="label manifest the slice was built from")
    ap.add_argument("--profile", required=True)
    ap.add_argument("--mode", default="vod", choices=["vod", "live"],
                    help="roster capacity to run at (vod=8, live=3 by charter)")
    ap.add_argument("--match-pre", type=float, default=None)
    ap.add_argument("--match-post", type=float, default=None)
    ap.add_argument("--json", required=True)
    args = ap.parse_args()

    manifest = json.load(open(args.labels))
    slice_doc = json.load(open(args.slice))
    profile = load_game_profile(args.profile)
    cap = profile.tracking_roster.capacity(args.mode)

    windows_by_id = {w["id"]: w for w in manifest["windows"]}
    slice_ids = {w["id"] for w in slice_doc["windows"]}
    missing = sorted(set(windows_by_id) - slice_ids)
    if missing:
        raise SystemExit(f"slice is missing manifest windows {missing} - not a complete measurement")

    pre, post = resolve_match_windows(args.match_pre, args.match_post, manifest)
    onsets = sorted(float(w["instant_s"]) for w in manifest["windows"] if w.get("kind") == "scoring")
    negative_ids = [w["id"] for w in manifest["windows"] if w.get("kind") != "scoring"]

    per_window = {}
    for w in slice_doc["windows"]:
        per_window[w["id"]] = score_window(w, cap)

    fires_all = sorted(f["t"] for w in per_window.values() for f in w["fires"])
    episodes_all = [ep for wid in per_window for ep in per_window[wid]["episodes"]]
    lats = []
    for onset in onsets:
        hits = [f for f in fires_all if onset - pre <= f <= onset + post]
        if hits:
            lats.append(round(min(hits) - onset, 2))
    main_row = measure_fires(fires_all, lats, [TRIGGER_MOTION] * len(fires_all),
                             onsets, pre, post)
    # Same accounting on the episode stream: one candidate per contiguous firing
    # run instead of one per firing frame.
    episode_starts = sorted(ep["startT"] for ep in episodes_all)
    ep_lats = []
    for onset in onsets:
        hits = [f for f in episode_starts if onset - pre <= f <= onset + post]
        if hits:
            ep_lats.append(round(min(hits) - onset, 2))
    episode_row = measure_fires(episode_starts, ep_lats, [TRIGGER_MOTION] * len(episode_starts),
                                onsets, pre, post)

    clip_s = float(manifest["video"]["duration_s"])
    sampled_s = float(slice_doc["frames"]) / float(slice_doc["fps"])
    doc = {
        "trigger": TRIGGER_MOTION,
        "profile": profile.key,
        "mode": args.mode,
        "capacity": cap,
        "motionMinStep": MOTION_MIN_STEP,
        "fps": slice_doc["fps"],
        "matchWindow": {"pre": pre, "post": post},
        "clip": slice_doc["clip"],
        "slice": args.slice,
        "frames": slice_doc["frames"],
        "latencyMeasuredMsPerFrame": slice_doc.get("latency", {}).get("meanMsPerFrame"),
        "candidateSpace": {
            "definition": "fires observed inside the manifest's eval windows (all fires, any window kind)",
            "stratifiedSample": round(sampled_s / clip_s, 5),
            "sampledSeconds": round(sampled_s, 1),
            "clipSeconds": round(clip_s, 1),
            "note": "NOT the audio rule's whole-clip candidate denominator; see RESULTS.md",
        },
        "main": main_row,
        "episodes": episode_row,
        "negatives": score_negatives(per_window, windows_by_id, negative_ids),
        "roster": {
            "capacity": cap,
            "maxConcurrent": max(w["maxConcurrent"] for w in per_window.values()),
            "framesAtCap": sum(w["framesAtCap"] for w in per_window.values()),
            "frames": sum(w["frames"] for w in per_window.values()),
            "objectsTotal": sum(w["objectsTotal"] for w in per_window.values()),
            "unkeptDetections": sum(w["unkeptDetections"] for w in per_window.values()),
            "objectsPerFrameMax": max(w["objectsPerFrameMax"] for w in per_window.values()),
        },
        "windows": {
            wid: {
                "kind": windows_by_id[wid].get("kind"),
                "fires": [f["t"] for f in per_window[wid]["fires"]],
                "maxConcurrent": per_window[wid]["maxConcurrent"],
                "peakStepMax": max(per_window[wid]["peaks"]) if per_window[wid]["peaks"] else None,
                "objectsTotal": per_window[wid]["objectsTotal"],
            }
            for wid in per_window
        },
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.json)) or ".", exist_ok=True)
    with open(args.json, "w") as fh:
        json.dump(doc, fh, indent=1)

    m = main_row
    neg = doc["negatives"]
    print(f"motion_fire  profile={profile.key} mode={args.mode} cap={cap} "
          f"frames={slice_doc['frames']} match=-{pre}/+{post}s")
    print(f"  events {m['events']}  candidates {m['candidates']}  "
          f"recall {m['recall']:.2f} ({m['recalled']}/{m['events']})  "
          f"fp {m['fp']}  candidate FP rate {m['fp_rate']:.4f}")
    print(f"  onset->fire p50 {m['p50']:.2f}s  p95 {m['p95']:.2f}s  max {m['max_lat']:.2f}s")
    e = episode_row
    print(f"  episodes (sticky history collapsed): {e['candidates']} candidates, "
          f"recall {e['recall']:.2f}, candidate FP rate {e['fp_rate']:.4f}")
    print(f"  negatives {neg['fp_windows']}/{neg['windows']} windows fired "
          f"({neg['fp_window_rate']:.2f}), {neg['candidates']} fires")
    print(f"  roster cap {cap}: maxConcurrent {doc['roster']['maxConcurrent']}, "
          f"framesAtCap {doc['roster']['framesAtCap']}/{doc['roster']['frames']}, "
          f"objects/frame max {doc['roster']['objectsPerFrameMax']}, "
          f"unkept {doc['roster']['unkeptDetections']}")
    print(f"  candidate space: {doc['candidateSpace']['stratifiedSample']:.2%} of the clip")
    print(f"wrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

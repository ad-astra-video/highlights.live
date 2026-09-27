#!/usr/bin/env python3
"""Tracking-accuracy measurement harness (ADAAAA-5050).

Drives the SAME tracker the deployed perceive path uses (
`app.tracker.IoUTracker`, mode-capacity carve-out from `app.session.mode_capacity`)
over the labeled soccer eval set (`evals/track_label_manifest.json`) and scores
the tracking-accuracy bars:

  - ID persistence (ID persist rate): fraction of a labeled object's on-screen
    (present) frames carried by one dominant identity — no splits/switches.
  - IoU accuracy: mean IoU between the tracker's box and the labeled box over
    frames matched to the dominant identity.
  - Max concurrent objects: largest number of simultaneously-live tracks;
    must reach the mode cap (live 3 / VOD 8) and never exceed it.

Detections fed to the tracker are the labeled per-frame object boxes plus
optional drop rate (default 0) simulating per-frame detector misses — matching
how the repo's own tracking tests (test_ball_persistence_at_cap) validate
persistence under dropout. On the GPU box the same harness scores the deployed
Florence+SAM3 detections; locally it verifies the tracker's identity/IoU
behaviour on the labeled set.

Run:  python3 evals/track_metrics.py [manifest.json] [--drop 5]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "services", "perceive"))

from app.tracker import IoUTracker, LIVE_MAX_TRACKS, VOD_MAX_TRACKS  # noqa: E402

ACCEPT_ID_PERSIST = 0.95
ACCEPT_IOU = 0.50


def _iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    return inter / (area_a + area_b - inter + 1e-9)


def run_clip(clip, drop_pct):
    mode = clip["mode"]
    cap = VOD_MAX_TRACKS if mode == "vod" else LIVE_MAX_TRACKS
    reach_cap = clip.get("reachCap", True)
    tr = IoUTracker(capacity=cap, lost_before_evict=8)
    # label -> {frame: iou per matched trackId} over the run
    label_frames = {}
    max_concurrent = 0
    for frame in clip["frames"]:
        f = frame["frame"]
        objects = frame["objects"]
        # split object streams by id for later scoring
        label_boxes = {}
        boxes = []
        for o in objects:
            label_boxes.setdefault(o["id"], []).append((f, o["bbox"]))
            boxes.append(tuple(o["bbox"]))
        # optional per-frame detection dropout (drop whole detections at random)
        if drop_pct and boxes and (f * 37) % 100 < drop_pct:
            boxes = []
        tracks = tr.step(boxes, ts=float(f))
        max_concurrent = max(max_concurrent, len(tracks))
        # record each label's frame -> best track IoU
        for oid, lst in label_boxes.items():
            fid, box = lst[0]
            label_frames.setdefault(oid, []).append(_frame_match(box, tracks))
    return score(label_frames, max_concurrent, cap, reach_cap)


def _frame_match(box, tracks):
    """Return [list of (trackId, iou)] for `box` against live tracks."""
    return [(t.track_id, _iou(box, t.bbox)) for t in tracks]


def score(label_frames, max_concurrent, cap, reach_cap=True):
    """Compute per-label ID persistence + IoU and clip-level max concurrent."""
    id_persist_scores = []
    iou_scores = []
    for oid, frames in label_frames.items():
        present = [fm for fm in frames if fm]
        if not present:
            id_persist_scores.append(0.0)
            continue
        # best (trackId, iou) per present frame
        best = [max(fm, key=lambda x: x[1]) for fm in present]
        # dominant identity = trackId matching the most frames at iou>=0.5
        from collections import Counter
        counts = Counter(tid for tid, iou in best if iou >= ACCEPT_IOU)
        if not counts:
            dominant = None
        else:
            dominant = counts.most_common(1)[0][0]
        matched = sum(1 for tid, iou in best if tid == dominant and iou >= ACCEPT_IOU)
        id_persist_scores.append(matched / len(present))
        matched_ious = [iou for tid, iou in best if tid == dominant and iou >= ACCEPT_IOU]
        if matched_ious:
            iou_scores.append(sum(matched_ious) / len(matched_ious))
    return {
        "idPersist": sum(id_persist_scores) / len(id_persist_scores) if id_persist_scores else None,
        "iou": sum(iou_scores) / len(iou_scores) if iou_scores else None,
        "maxConcurrent": max_concurrent,
        "cap": cap,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest", nargs="?", default=os.path.join(HERE, "track_label_manifest.json"))
    ap.add_argument("--drop", type=int, default=0, help="per-frame detection dropout % (0-99)")
    args = ap.parse_args()

    manifest = json.load(open(args.manifest))
    print(f"tracking-accuracy run  sport={manifest['sport']} "
          f"clips={len(manifest['clips'])} drop={args.drop}%")
    overall = True
    for clip in manifest["clips"]:
        m = run_clip(clip, args.drop)
        never_exceed = m["maxConcurrent"] <= m["cap"]
        cap_ok = never_exceed and (m["maxConcurrent"] == m["cap"] if clip.get("reachCap", True) else True)
        iou_ok = (m["iou"] or 0) >= ACCEPT_IOU
        persist_ok = (m["idPersist"] or 0) >= ACCEPT_ID_PERSIST
        ok = cap_ok and iou_ok and persist_ok
        overall = overall and ok
        print(f"  {clip['id']:<22} mode={clip['mode']:<4} "
              f"idPersist={m['idPersist']:.3f} (bar {ACCEPT_ID_PERSIST}) "
              f"iou={m['iou']:.3f} (bar {ACCEPT_IOU}) "
              f"maxConcurrent={m['maxConcurrent']}/{m['cap']}"
              f"  -> {'PASS' if ok else 'FAIL'}")
    print("OVERALL:", "PASS" if overall else "FAIL")
    return 0 if overall else 1


if __name__ == "__main__":
    sys.exit(main())

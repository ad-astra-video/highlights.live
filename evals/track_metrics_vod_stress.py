#!/usr/bin/env python3
"""VOD-length identity stress (ADAAAA-5069).

Replicates the QA-measured real-video failure (ADAAAA-5062: VOD idPersist 0.655,
min slot 0.324): on a VOD-length clip (hundreds of frames at 5fps), per-frame
detector DROPOUT bursts longer than `lost_before_evict`, box DRIFT across frames
(real players move), and player ENTER/EXIT. These are exactly the conditions that
evict a confirmed track and re-seed it with a fresh id, dropping ID persistence.

Scores the same metric as `track_metrics.py` (ID persistence = fraction of a
labeled object's present frames carried by one dominant identity, bar >=0.95)
and max-concurrent (never exceed the mode cap).

Two tracker configs are compared:
  - old:   resurrection disabled (resurrect_window_frames=0, confirm_frames=1)
           -> reproduces the QA re-seed behaviour.
  - new:   the hardened tracker (ADAAAA-5069).
"""
from __future__ import annotations

import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "services", "perceive"))
from app.tracker import IoUTracker, VOD_MAX_TRACKS  # noqa: E402

ACCEPT_ID_PERSIST = 0.95
SEED = 7


def _iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter == 0:
        return 0.0
    return inter / (max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1) + max(0.0, bx2 - bx1) * max(0.0, by2 - by1) - inter + 1e-9)


def gen_clip(nframes=240, nplayer=8, drop_burst=6, drift=0.12):
    """Deterministic VOD-length clip.

    Each player has a base box that DRIFTS linearly across the frame (players
    run), with intermittent DETECTION-DROPOUT BURSTS longer than lost_before_evict,
    and occasionally a player EXITS the frame and re-enters elsewhere.

    Returns (frames, ground_truth) where frames is a list of per-frame box lists
    and ground_truth maps object id -> [(frame, bbox)] present frames.
    """
    rng = __import__("random").Random(SEED)
    frames = []
    ground_truth = {}
    # player id -> (x_anchor, y_anchor); distinct grid positions (no permanent
    # overlap — real players cross briefly, they don't sit on top of each other).
    players = {}
    for p in range(nplayer):
        col = p % 4
        row = p // 4
        x = 0.03 + 0.86 * col / 3.0
        y = 0.08 + 0.24 * row
        players[p] = {"x": x, "y": y}
    for f in range(nframes):
        boxes = []
        for p, state in players.items():
            # linear drift (players run)
            state["x"] = state["x"] + drift / nframes * ((p % 3) - 1)
            state["y"] = state["y"] + drift / nframes * ((p % 2) - 0)
            x, y = state["x"], state["y"]
            # player EXIT: brief off-screen window, then re-enters near a shifted spot
            in_frame = True
            if f % 61 < 3 and p in (0, 4):
                in_frame = False  # 3-frame exit window (enter/exit test)
            # detection DROPOUT burst longer than lost_before_evict
            elif f % 47 < drop_burst and p % 2 == 0:
                in_frame = False
            if not in_frame:
                continue
            bx1, by1, bx2, by2 = x, y, x + 0.07, y + 0.13
            boxes.append((bx1, by1, bx2, by2))
            ground_truth.setdefault(f"p{p}", []).append((f, (bx1, by1, bx2, by2)))
        frames.append(boxes)
    return frames, ground_truth


def run(tracker_kind):
    frames, ground_truth = gen_clip()
    cap = VOD_MAX_TRACKS
    if tracker_kind == "old":
        tr = IoUTracker(capacity=cap, lost_before_evict=4, confirm_frames=1, resurrect_window_frames=0)
    else:
        tr = IoUTracker(capacity=cap, lost_before_evict=4, confirm_frames=2, resurrect_window_frames=20)
    label_frames = {oid: [] for oid in ground_truth}
    max_concurrent = 0
    for f, boxes in enumerate(frames):
        tracks = tr.step(boxes, ts=float(f))
        max_concurrent = max(max_concurrent, len(tracks))
        for oid, lst in ground_truth.items():
            present = [x for x in lst if x[0] == f]
            if present:
                box = present[0][1]
                label_frames[oid].append([(t.track_id, _iou(box, t.bbox)) for t in tracks])
            # non-present frame contributes nothing to persistence (only present frames count)
    # score
    idp = []
    for oid, frames_ in label_frames.items():
        present = [fm for fm in frames_ if fm]
        if not present:
            continue
        best = [max(fm, key=lambda x: x[1]) for fm in present]
        counts = Counter(tid for tid, iou in best if iou >= 0.5)
        dominant = counts.most_common(1)[0][0] if counts else None
        matched = sum(1 for tid, iou in best if tid == dominant and iou >= 0.5)
        idp.append(matched / len(present))
    id_persist = sum(idp) / len(idp) if idp else None
    return id_persist, max_concurrent, cap, idp


def main():
    for kind in ("old", "new"):
        idp, maxc, cap, per_slot = run(kind)
        ok = idp is not None and idp >= ACCEPT_ID_PERSIST and maxc <= cap
        min_slot = f"{min(per_slot):.3f}" if per_slot else "n/a"
        print(f"[{kind:>3}] VOD idPersist={idp:.3f} (bar {ACCEPT_ID_PERSIST}) "
              f"min_slot={min_slot} "
              f"maxConcurrent={maxc}/{cap} -> {'PASS' if ok else 'FAIL'}")


if __name__ == "__main__":
    main()

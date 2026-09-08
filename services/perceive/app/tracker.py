"""IoU-blob tracker (CPU stub standing in for Florence+SAM3 in local/offline
testing). Produces real tracks from actual frames: background-diff foreground
-> connected components -> keep the two largest blobs -> match by IoU across
frames. Emits a CandidateEvent when a track's location jumps sharply.

This is compute, not fabrication: feed it a real frame and it returns real
tracks. Swap in Florence+SAM3 behind the same `step()` contract on GPU hosts.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import numpy as np

MAX_TRACKS = 2

BBox = Tuple[float, float, float, float]  # x1, y1, x2, y2 normalized 0..1


@dataclass
class Track:
    track_id: str
    slot: int  # 0 | 1
    bbox: BBox
    kind: str = "unknown"
    label: str = ""
    lost_frames: int = 0
    last_seen: float = 0.0
    # for velocity-jump candidate detection
    prev_center: Optional[Tuple[float, float]] = None
    moved_frames: int = 0
    moved: float = 0.0  # accumulated matched-frame displacement (normalized units)
    last_step_disp: float = 0.0  # |dx|+|dy| of the most recent matched step


@dataclass
class CandidateEvent:
    event_type: str
    timestamp: float
    track_id: str


def _iou(a: BBox, b: BBox) -> float:
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


def foreground_blobs(gray: np.ndarray, prev: Optional[np.ndarray], thresh: float = 28.0) -> List[BBox]:
    """Return bounding boxes of the largest two foreground regions.

    gray/prev are float32 in [0,255], shape (H,W). Regions smaller than
    `min_area_frac` of the image are noise and dropped.
    """
    if prev is None:
        return []
    diff = np.abs(gray - prev)
    mask = (diff > thresh).astype(np.uint8)
    H, W = mask.shape
    if mask.sum() < max(1, 0.0005 * mask.size):
        return []
    from scipy import ndimage
    labels, n = ndimage.label(mask)
    if n == 0:
        return []
    min_px = 0.0015 * mask.size  # ignore sub-threshold noise
    blobs: List[Tuple[float, float, float]] = []  # (w, h, cx, cy)
    for i in range(1, n + 1):
        ys, xs = np.nonzero(labels == i)
        if len(xs) < min_px:
            continue
        x1, x2 = xs.min() / W, xs.max() / W
        y1, y2 = ys.min() / H, ys.max() / H
        w, h = x2 - x1, y2 - y1
        if w < 0.02 or h < 0.02:  # reject slivers
            continue
        blobs.append((w * h, w, h, (x1 + x2) / 2, (y1 + y2) / 2))
    blobs.sort(key=lambda b: -b[0])  # largest area first
    out: List[BBox] = []
    for _area, w, h, cx, cy in blobs[:MAX_TRACKS]:
        x1, y1 = max(0.0, cx - w / 2), max(0.0, cy - h / 2)
        x2, y2 = min(1.0, cx + w / 2), min(1.0, cy + h / 2)
        out.append((x1, y1, x2, y2))
    return out


class IoUTracker:
    # A fast single-step move (normalized |dx|+|dy|) reads as a high-value
    # action/combat moment -> KILL-tier candidate. Slower drift -> MOVE.
    FAST_STEP = 0.15

    def __init__(self, jump_velocity: float = 0.2, lost_before_evict: int = 8, cooldown_s: float = 2.0):
        self.tracks: List[Track] = []
        self.jump_velocity = jump_velocity
        self.lost_before_evict = lost_before_evict
        self.cooldown_s = cooldown_s
        self.last_candidate: float = -1e9

    def step(self, boxes: List[BBox], ts: float) -> List[Track]:
        """Match new boxes to existing tracks: IoU if they overlap, else nearest
        centroid within a distance gate (so a fast-moving blob stays ONE track).
        Create/evict as needed; accumulate per-frame displacement."""
        unmatched = list(boxes)
        matched_tracks: set[int] = set()
        for tr in list(self.tracks):
            best_i, best_score, best_type = None, 0.0, None
            for i, b in enumerate(unmatched):
                iou = _iou(tr.bbox, b)
                if iou >= 0.05 and iou > best_score:
                    best_i, best_score, best_type = i, iou, "iou"
                else:
                    cd = self._centroid_gate(tr.bbox, b)
                    if cd is not None and cd > best_score:
                        best_i, best_score, best_type = i, cd, "gate"
            if best_i is not None:
                new_bbox = unmatched.pop(best_i)
                new_center = ((new_bbox[0] + new_bbox[2]) / 2, (new_bbox[1] + new_bbox[3]) / 2)
                if tr.prev_center is not None:
                    disp = abs(new_center[0] - tr.prev_center[0]) + abs(new_center[1] - tr.prev_center[1])
                    tr.moved += disp
                    tr.last_step_disp = disp
                tr.prev_center = new_center
                tr.bbox = new_bbox
                tr.lost_frames = 0
                tr.last_seen = ts
                matched_tracks.add(id(tr))
            else:
                tr.lost_frames += 1
                if tr.lost_frames > self.lost_before_evict:
                    self.tracks.remove(tr)

        # create tracks for remaining unmatched boxes into free slots (0,1)
        used = {t.slot for t in self.tracks}
        free_slots = [s for s in (0, 1) if s not in used]
        for b in unmatched:
            if not free_slots:
                break
            slot = free_slots.pop(0)
            tr = Track(track_id=f"t{int(time.time()*1000)}-{slot}", slot=slot, bbox=b, kind="unknown", last_seen=ts)
            self.tracks.append(tr)
            used.add(slot)

        self.tracks.sort(key=lambda t: t.slot)
        return list(self.tracks)

    @staticmethod
    def _centroid_gate(a: BBox, b: BBox, gate: float = 0.20) -> float | None:
        """Return a match confidence from centroid proximity, or None if too far."""
        ca = ((a[0] + a[2]) / 2, (a[1] + a[3]) / 2)
        cb = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
        d = abs(ca[0] - cb[0]) + abs(ca[1] - cb[1])
        if d >= gate:
            return None
        return gate - d  # closer == higher score (max 0.14)

    def candidate(self, ts: float) -> Optional[CandidateEvent]:
        """Emit a candidate on a sharp track move, rate-limited by cooldown."""
        if ts - self.last_candidate < self.cooldown_s:
            return None
        for tr in self.tracks:
            if tr.moved >= self.jump_velocity:
                event_type = "KILL" if tr.last_step_disp >= self.FAST_STEP else "MOVE"
                tr.moved = 0.0
                tr.last_step_disp = 0.0
                self.last_candidate = ts
                return CandidateEvent(event_type=event_type, timestamp=ts, track_id=tr.track_id)
        return None

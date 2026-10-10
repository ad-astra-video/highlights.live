"""IoU-blob tracker (CPU stub standing in for Florence+SAM3 in local/offline
testing). Produces real tracks from actual frames: background-diff foreground
-> connected components -> keep the two largest blobs -> match by IoU across
frames. Emits a CandidateEvent when a track's location jumps sharply.

This is compute, not fabrication: feed it a real frame and it returns real
tracks. Swap in Florence+SAM3 behind the same `step()` contract on GPU hosts.
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, List, Optional, Tuple

import numpy as np

# Schema ceiling (VOD chart target). Live sessions run at a lower capacity
# (see LIVE_MAX_TRACKS in packages/events). `IoUTracker`/`HybridTracker` accept
# an explicit `capacity` so the session can raise/lower it per mode.
MAX_TRACKS = 8
LIVE_MAX_TRACKS = 3
VOD_MAX_TRACKS = 8

BBox = Tuple[float, float, float, float]  # x1, y1, x2, y2 normalized 0..1


def kind_from_label(label: str) -> str:
    """Map an (in-roster) detection label to a coarse TrackKind.

    The tracker surfaces a track's label to the user; `kind` is a coarse
    category (schema TrackKind). An in-roster label must never survive as the
    meaningless "unknown" default, or the user sees "unknown" on every box even
    though the closed-vocab gate labeled the detection (ADAAAA-5056).
    """
    l = (label or "").strip().lower()
    if not l:
        return "unknown"
    if "ball" in l:
        return "ball"
    if l in ("player", "goalkeeper", "referee", "agent", "person", "people", "man", "woman", "men", "head"):
        return "player"
    if l in ("goal", "net", "hoop", "structure"):
        return "structure"
    if l in ("racket", "weapon", "proj"):
        return "proj"
    return "unknown"


@dataclass
class Track:
    track_id: str
    slot: int  # 0..capacity-1
    bbox: BBox
    kind: str = "unknown"
    label: str = ""
    lost_frames: int = 0
    last_seen: float = 0.0
    # INC-6 tracked-object semantics: a user-selected find-and-track target
    # persisted across frames while on screen. `onto_frames` counts the frames
    # it was matched (on-screen) over the tracked window; `accuracy` is the
    # continuity metric matched/(matched+lost) since selection (1.0 = never lost).
    selected: bool = False
    onto_frames: int = 0
    # VOD ID-persistence hardening (ADAAAA-5069): a track only becomes a
    # permanent identity after it has been matched for `confirm_frames`
    # CONSECUTIVE frames. A tentative (unconfirmed) track that is lost before
    # confirmation is dropped without reserving identity/slot, so a single
    # spurious or short-lived detection cannot fragment a real object's ID.
    confirmed: bool = False
    stable_frames: int = 0
    # for velocity-jump candidate detection
    prev_center: Optional[Tuple[float, float]] = None
    moved_frames: int = 0
    moved: float = 0.0  # accumulated matched-frame displacement (normalized units)
    last_step_disp: float = 0.0  # |dx|+|dy| of the most recent matched step
    # Recent (timestamp, |dx|+|dy|) for the current motion burst, so a candidate
    # can be ANCHORED at the peak single-step (the strike moment) instead of the
    # later frame where accumulated displacement happens to cross the threshold.
    step_hist: Deque[Tuple[float, float]] = field(default_factory=lambda: deque(maxlen=10))

    @property
    def accuracy(self) -> Optional[float]:
        """INC-6 tracking continuity: matched / (matched + lost) over the tracked
        window; None when we have never matched this track on-screen."""
        if not self.selected or self.onto_frames <= 0:
            return None
        return self.onto_frames / float(self.onto_frames + max(0, self.lost_frames))


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


def foreground_blobs(gray: np.ndarray, prev: Optional[np.ndarray], thresh: float = 28.0, capacity: int = MAX_TRACKS) -> List[BBox]:
    """Return bounding boxes of the largest `capacity` foreground regions.

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
    for _area, w, h, cx, cy in blobs[:capacity]:
        x1, y1 = max(0.0, cx - w / 2), max(0.0, cy - h / 2)
        x2, y2 = min(1.0, cx + w / 2), min(1.0, cy + h / 2)
        out.append((x1, y1, x2, y2))
    return out


class IoUTracker:
    # A fast single-step move (normalized |dx|+|dy|) reads as a high-value
    # action/combat moment -> KILL-tier candidate. Slower drift -> MOVE.
    FAST_STEP = 0.15

    def __init__(self, jump_velocity: float = 0.2, lost_before_evict: int = 8, cooldown_s: float = 2.0, capacity: int = MAX_TRACKS, confirm_frames: int = 2, resurrect_window_frames: int = 15, anchor_label: str | None = None):
        self.tracks: List[Track] = []
        self.jump_velocity = jump_velocity
        self.lost_before_evict = lost_before_evict
        self.cooldown_s = cooldown_s
        self.capacity = max(1, int(capacity))
        self.last_candidate: float = -1e9
        # Slots that refuse automatic eviction (control `lock`). A locked slot
        # that loses its object keeps its last bbox instead of being dropped.
        self.locked: set[int] = set()
        # Plan anchor (ADAAAA-6463, anchor-slot policy): the plan's primary
        # tracked object label. New detections matching the anchor get priority
        # for the lowest free slot so the anchor object keeps the primary slot.
        self.anchor_label = (anchor_label or "").strip().lower()
        # VOD ID-persistence hardening (ADAAAA-5069).
        # `confirm_frames`: a detection must be matched on this many CONSECUTIVE
        # frames before its track is promoted to a permanent identity. This
        # stops a single spurious/short-lived detection from grabbing a slot and
        # fragmenting a real object's ID when it re-detects.
        self.confirm_frames = max(1, int(confirm_frames))
        # `resurrect_window_frames`: after a CONFIRMED track is evicted (object
        # dropped out of detection / exited), remember its last identity + box
        # for this many frames. If a detection reappears near that box within
        # the window, reuse the SAME track id (dropout-tolerant matching) instead
        # of minting a new identity and splitting the object's ID.
        self.resurrect_window_frames = max(0, int(resurrect_window_frames))
        self._frame = 0
        # recently-evicted confirmed identities: {track_id: (bbox, evicted_frame)}
        self._ghosts: dict = {}

    # --- operator control (§3.4) -------------------------------------------
    def seed(self, bbox: BBox, kind: str = "unknown", label: str = "", slot: int | None = None, ts: float = 0.0, selected: bool = False) -> Track:
        """Force a track into a slot from an operator-provided box. Replaces any
        existing occupant of that slot. Returns the created Track. `selected=True`
        marks it as an INC-6 find-and-track target (persisted + accuracy tracked)."""
        # normalize bbox to 0..1
        b = tuple(min(max(float(x), 0.0), 1.0) for x in bbox)
        if slot is not None:
            slot = min(max(int(slot), 0), self.capacity - 1)
        else:
            used = {t.slot for t in self.tracks}
            slot = next((s for s in range(self.capacity) if s not in used), 0)
        # evict any current occupant of the slot
        self.tracks = [t for t in self.tracks if t.slot != slot]
        tr = Track(track_id=f"seed-{int(time.time()*1000)}-{slot}", slot=slot, bbox=b, kind=kind, label=label, last_seen=ts, selected=selected)
        # An operator/selection seed is a deliberate, trusted identity, so it is
        # confirmed immediately (INC-6 find-and-track target).
        if selected:
            tr.confirmed = True
            tr.stable_frames = self.confirm_frames
        self.tracks.append(tr)
        self.tracks.sort(key=lambda t: t.slot)
        return tr

    def evict(self, slot: int) -> bool:
        """Drop a specific slot (operator `evict`, or auto after lost frames when
        the slot is not locked). Returns True if a slot was removed."""
        before = len(self.tracks)
        self.tracks = [t for t in self.tracks if t.slot != int(slot)]
        self.locked.discard(int(slot))
        return len(self.tracks) < before

    def lock(self, slot: int) -> None:
        """Prevent automatic eviction of a slot (operator `lock`)."""
        self.locked.add(int(slot))

    def set_anchor(self, label: str | None) -> None:
        """Set the plan anchor label (ADAAAA-6463 anchor-slot policy).

        New detections whose label contains the anchor get priority for the
        lowest free slot, so the plan's primary object holds the primary slot.
        Empty/None clears the anchor (no preferential seeding).
        """
        self.anchor_label = (label or "").strip().lower()

    def step(self, boxes: List[BBox], ts: float, labels: Optional[List[str]] = None) -> List[Track]:
        """Match new boxes to existing tracks: IoU if they overlap, else nearest
        centroid within a distance gate (so a fast-moving blob stays ONE track).
        Create/evict as needed; accumulate per-frame displacement.

        VOD ID-persistence hardening (ADAAAA-5069):
          - CONFIRMATION: a brand-new detection only becomes a permanent identity
            after it is matched on `confirm_frames` consecutive frames. A track
            that is lost before confirmation is dropped without reserving a slot
            or identity (a single spurious/short-lived detection cannot fragment
            a real object's ID).
          - RESURRECTION: when a CONFIRMED track is evicted (per-frame detector
            dropout on real video, or enter/exit), its identity is remembered for
            `resurrect_window_frames`. A box that reappears near its last bbox is
            matched to the SAME track id instead of minting a new identity, so
            the object's ID persists across short detection gaps.

        `labels` (optional, parallel to `boxes`) carries each detection's label.
        New tracks are seeded with it (and a derived kind) so the boxes the UI
        surfaces carry the detector's in-roster label instead of a hard-coded
        "unknown" (ADAAAA-5056). An existing track keeps its label when it is
        re-matched (identity persistence).
        """
        self._frame += 1
        self._prune_ghosts()
        unmatched = list(boxes)
        # Stub path and callers that omit labels pass an empty/absent list while
        # still handing new boxes; keep a parallel array so pops stay in lockstep.
        if labels is not None and len(labels) == len(boxes):
            u_labels = list(labels)
        else:
            u_labels = [None] * len(boxes)
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
                u_labels.pop(best_i)  # keep labels parallel to unmatched boxes
                new_center = ((new_bbox[0] + new_bbox[2]) / 2, (new_bbox[1] + new_bbox[3]) / 2)
                if tr.prev_center is not None:
                    disp = abs(new_center[0] - tr.prev_center[0]) + abs(new_center[1] - tr.prev_center[1])
                    tr.moved += disp
                    tr.last_step_disp = disp
                    tr.step_hist.append((ts, disp))
                tr.prev_center = new_center
                tr.bbox = new_bbox
                tr.lost_frames = 0
                # INC-6: a selected find-and-track target counts each matched
                # (on-screen) frame, feeding the continuity/accuracy metric.
                if tr.selected:
                    tr.onto_frames += 1
                tr.last_seen = ts
                # Confirmation: consecutive stable matches promote to identity.
                if not tr.confirmed:
                    tr.stable_frames += 1
                    if tr.stable_frames >= self.confirm_frames:
                        tr.confirmed = True
                matched_tracks.add(id(tr))
            else:
                tr.lost_frames += 1
                # Locked slots survive repeated lost frames (operator pinned them).
                if tr.lost_frames > self.lost_before_evict and tr.slot not in self.locked:
                    self.tracks.remove(tr)
                    # Remember a CONFIRMED identity that timed out (per-frame
                    # detector dropout / enter-exit) so a near reappearance can
                    # resurrect the same id. Unconfirmed tracks leave no ghost.
                    if tr.confirmed and self.resurrect_window_frames > 0:
                        self._ghosts[tr.track_id] = (tr.bbox, self._frame)

        # create tracks for remaining unmatched boxes into free slots
        used = {t.slot for t in self.tracks}
        free_slots = [s for s in range(self.capacity) if s not in used]
        # Anchor-slot policy (ADAAAA-6463): order new detections so the plan's
        # anchor-labeled object is seeded FIRST into the lowest free slot. The
        # anchor keeps the primary slot among the new arrivals; everything else
        # fills the remaining slots in detection order.
        anchor_first: List[int] = []
        other: List[int] = []
        for i in range(len(unmatched)):
            lab = (u_labels[i] or "").strip().lower() if i < len(u_labels) else ""
            if self.anchor_label and self.anchor_label in lab:
                anchor_first.append(i)
            else:
                other.append(i)
        order = anchor_first + other
        for i in order:
            if not free_slots:
                break
            b = unmatched[i]
            # Dropout-tolerant matching: prefer resurrecting a recently-evicted
            # identity over minting a new one.
            tid = self._resurrect(b)
            slot = free_slots.pop(0)
            lab = u_labels[i] or ""
            if tid is not None:
                tr = Track(track_id=tid, slot=slot, bbox=b, kind=kind_from_label(lab), label=lab, last_seen=ts, confirmed=True)
            else:
                tr = Track(track_id=f"t{int(time.time()*1000)}-{slot}", slot=slot, bbox=b, kind=kind_from_label(lab), label=lab, last_seen=ts)
            self.tracks.append(tr)
            used.add(slot)

        self.tracks.sort(key=lambda t: t.slot)
        return list(self.tracks)

    def _prune_ghosts(self) -> None:
        """Drop resurrection candidates older than the window."""
        if self.resurrect_window_frames <= 0:
            self._ghosts.clear()
            return
        cutoff = self._frame - self.resurrect_window_frames
        self._ghosts = {tid: v for tid, v in self._ghosts.items() if v[1] > cutoff}

    def _resurrect(self, box: BBox) -> Optional[str]:
        """Return a reused track id for a detection that reappears near a
        recently-evicted confirmed track, else None. A box must IoU-overlap or
        sit within the movement gate of the ghost's last box to be the same
        object (enter/exit + dropout tolerance without aliasing two objects)."""
        if not self._ghosts:
            return None
        best_tid, best_score = None, 0.0
        for tid, (bbox, _when) in self._ghosts.items():
            iou = _iou(bbox, box)
            score = iou
            if iou < 0.05:
                cd = self._centroid_gate(bbox, box)
                if cd is not None:
                    score = cd
                else:
                    continue
            if score > best_score:
                best_tid, best_score = tid, score
        if best_tid is None:
            return None
        self._ghosts.pop(best_tid)
        return best_tid

    def seed_reuse_identity(self, bbox: BBox, ts: float = 0.0, kind: str = "unknown", label: str = "") -> Track:
        """Seed a slot from a fresh detection, PRESERVING identity when the box
        reappears near a recently-evicted confirmed track (used by the SAM path's
        `_reseed_from`). Falls back to a fresh id for genuinely new objects.

        Returns the created/updated Track. Confirmed when it resurrected an
        existing identity (so it is not re-fragmented by confirmation)."""
        tid = self._resurrect(bbox)
        used = {t.slot for t in self.tracks}
        slot = next((s for s in range(self.capacity) if s not in used), 0)
        tr = Track(track_id=tid or f"t{int(time.time()*1000)}-{slot}", slot=slot, bbox=bbox, kind=kind, label=label, last_seen=ts, confirmed=tid is not None)
        self.tracks = [t for t in self.tracks if t.slot != slot]
        self.tracks.append(tr)
        self.tracks.sort(key=lambda t: t.slot)
        return tr

    @staticmethod
    def _centroid_gate(a: BBox, b: BBox, gate: float = 0.20) -> float | None:
        """Return a match confidence from centroid proximity, or None if too far."""
        ca = ((a[0] + a[2]) / 2, (a[1] + a[3]) / 2)
        cb = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
        d = abs(ca[0] - cb[0]) + abs(ca[1] - cb[1])
        if d >= gate:
            return None
        return gate - d  # closer == higher score (max 0.14)

    @staticmethod
    def _anchor_step(tr: "Track") -> Tuple[float, float]:
        """Anchor a candidate at the peak single-step of the just-crossed burst.

        `tr.moved` is ACCUMULATED displacement, so it can cross `jump_velocity`
        one or more frames AFTER the explosive moment (a fast strike spreads
        over 2+ sampled frames; the threshold lands on the follow-through). Return
        the (timestamp, displacement) of the single biggest step in the burst so
        the emitted candidate points at the strike, not the late-crossing frame.
        """
        if not tr.step_hist:
            return (tr.last_seen, tr.last_step_disp)
        return max(tr.step_hist, key=lambda p: p[1])

    def candidate(self, ts: float) -> Optional[CandidateEvent]:
        """Emit a candidate on a sharp track move, rate-limited by cooldown.

        The candidate's `timestamp` is anchored at the peak single-step in the
        burst (the strike moment), and its event type is classified from that
        anchored step — so a GOAL strike is reported at/around the moment it
        happens instead of a post-strike frame. Fall back to the current frame
        when the burst is a single step (peak == here).
        """
        if ts - self.last_candidate < self.cooldown_s:
            return None
        for tr in self.tracks:
            if tr.moved >= self.jump_velocity:
                anchor_ts, anchor_disp = self._anchor_step(tr)
                event_type = "KILL" if anchor_disp >= self.FAST_STEP else "MOVE"
                tr.moved = 0.0
                tr.last_step_disp = 0.0
                tr.step_hist.clear()
                self.last_candidate = ts
                return CandidateEvent(event_type=event_type, timestamp=anchor_ts, track_id=tr.track_id)
        return None

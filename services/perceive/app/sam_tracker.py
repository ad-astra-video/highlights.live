"""Hybrid Florence+SAM3 tracker (plan §3.5 "Florence+SAM3 behind step()").

Florence-2 is the open-domain DETECTOR (finds objects, gives class labels) but it
is not a tracker and its labels are unreliable on un-trained content (game UI).
SAM 3.x is the SEGMENTATION/TRACKER: given a prompt it propagates a precise mask
frame-to-frame AND handles all cross-frame object state. We pair them:

  - Every frame: the SAM backend advances one frame (segmentation tracker
    propagates every tracked target's mask). No Florence dependence at runtime.
  - Only when needed: Florence-2 re-detects to (re)seed SAM prompts:
      * SAM lost a target (no mask -> that slot needs a fresh detection), or
      * re-detect cadence elapsed, or
      * the user changed the target (control `seed` -> re-prompt that slot).

The class reuses IoUTracker for the box-level candidate/velocity logic so the
handoff controller stays small and the existing CD behaviour (candidate events,
velocity jump -> KILL/MOVE) is unchanged. When no SAM backend is available
(CPU / not installed) it degrades EXACTLY to today's Florence->IoU path.

The concrete SAM backend is injected (stub for CPU/tests; real SAM 3.1 behind
PERCEIVE_TRACKER=florence_sam + SAM3 SDK on a GPU/3.12 host). We do not
hard-import the SAM3 SDK here so this module always imports on CPU.
"""
from __future__ import annotations

import os
from typing import Callable, Dict, List, Optional

import numpy as np

from .tracker import BBox, CandidateEvent, IoUTracker, MAX_TRACKS, Track

# A detect callable: rgb frame (HxWx3 uint8) -> [{label, confidence, bbox}] (Florence <OD>)
DetectFn = Callable[[np.ndarray], List[dict]]


class SamBackend:
    """Per-frame segmentation-tracker backend (SAM 3.x behind HybridTracker).

    `advance(prompts)` runs the tracker forward ONE frame given the current
    slot->prompt map (re-seeding any slot whose prompt changed, per SAM 3's
    reset-then-add semantics), then `get(slot)` returns that slot's box (or
    None when the target is absent this frame). SAM owns all cross-frame state.
    """

    def ready(self) -> bool:
        raise NotImplementedError

    def advance(self, prompts: Dict[int, BBox]) -> None:
        raise NotImplementedError

    def get(self, slot: int) -> Optional[BBox]:
        raise NotImplementedError


class HybridTracker:
    """Florence(detect) + SAM(track) hybrid. Same public surface as IoUTracker.

    Pass `detect` (Florence) and `backend` (SAM). With no backend it falls back
    to IoU over Florence boxes — the previous behaviour exactly.
    """

    def __init__(
        self,
        detect: Optional[DetectFn] = None,
        backend: Optional[SamBackend] = None,
        redetect_every: int = 10,          # force a Florence re-detect each N frames
        lost_before_redetect: int = 2,     # SAM-miss frames before we ask Florence
        jump_velocity: float = 0.2,
        lost_before_evict: int = 8,
        cooldown_s: float = 2.0,
    ):
        self._detect = detect
        self._backend = backend
        self.redetect_every = redetect_every
        self.lost_before_redetect = lost_before_redetect
        self._iou = IoUTracker(jump_velocity=jump_velocity, lost_before_evict=lost_before_evict, cooldown_s=cooldown_s)
        # slot -> box prompt SAM is currently tracking; slot -> miss count
        self._prompts: Dict[int, BBox] = {}
        self._miss: Dict[int, int] = {}
        self._since_detect = 0

    @property
    def tracks(self) -> List[Track]:
        return self._iou.tracks

    # --- operator control (delegated, plus SAM re-prompt on seed) -----------
    def seed(self, bbox: BBox, kind: str = "unknown", label: str = "", slot: int | None = None, ts: float = 0.0) -> Track:
        tr = self._iou.seed(bbox, kind=kind, label=label, slot=slot, ts=ts)
        if slot is None:  # match the slot IoUTracker chose
            slot = tr.slot
        self._prompts[slot] = tr.bbox  # user changed / set target -> SAM re-prompts here
        self._miss[slot] = 0
        return tr

    def evict(self, slot: int) -> bool:
        self._prompts.pop(slot, None)
        self._miss.pop(slot, None)
        return self._iou.evict(slot)

    def lock(self, slot: int) -> None:
        self._iou.lock(slot)

    def candidate(self, ts: float) -> Optional[CandidateEvent]:
        return self._iou.candidate(ts)

    # --- frame step ---------------------------------------------------------
    def step_frame(self, frame_rgb: np.ndarray, ts: float, florence_boxes: Optional[List[BBox]] = None) -> List[Track]:
        """Advance one frame. `florence_boxes` come from the caller's Florence
        pass THIS frame (already computed upstream) and seed the IoU layer when
        SAM is off or can't be used."""
        if self._backend is not None and self._backend.ready() and self._prompts:
            boxes = self._sam_step(frame_rgb, florence_boxes)
        else:
            # No SAM: pure Florence -> IoU (unchanged behaviour).
            boxes = florence_boxes or []
            self._since_detect += 1
        return self._iou.step(boxes, ts)

    def _sam_step(self, frame_rgb: np.ndarray, florence_boxes: Optional[List[BBox]] = None) -> List[BBox]:
        """Run SAM one frame ahead for every tracked slot, deciding when to ask
        Florence to re-detect. Returns the boxes to feed the IoU CD layer.

        Re-detect re-prompting uses the caller's already-computed Florence boxes
        for THIS frame when provided (no redundant model pass); otherwise falls
        back to calling the injected `detect` callable."""
        self._since_detect += 1
        need_redetect = self._since_detect >= self.redetect_every
        self._backend.advance(dict(self._prompts))  # one frame's compute for all slots
        sam_boxes: List[BBox] = []
        for slot in list(self._prompts.keys()):
            b = self._backend.get(slot)
            if b is None:
                self._miss[slot] = self._miss.get(slot, 0) + 1
                if self._miss[slot] >= self.lost_before_redetect:
                    need_redetect = True  # SAM lost this target -> Florence must refind it
            else:
                self._miss[slot] = 0
                self._prompts[slot] = b  # carry the prompt forward
                sam_boxes.append(b)

        if need_redetect:
            if florence_boxes is None and self._detect is not None:
                det = self._detect(frame_rgb) or []
                florence_boxes = [d["bbox"] for d in det if d.get("bbox")]
            self._reseed_from(florence_boxes or [])
            self._since_detect = 0
            return florence_boxes or sam_boxes
        return sam_boxes

    def _reseed_from(self, boxes: List[BBox]) -> None:
        """Re-prompt SAM slots from a fresh Florence detection set."""
        boxes = list(boxes)
        # refresh existing tracked slots with the nearest detected box when possible
        for slot in list(self._prompts.keys()):
            tr = next((t for t in self._iou.tracks if t.slot == slot), None)
            if tr is not None:
                best = _nearest_box(tr.bbox, boxes)
                if best is not None:
                    self._prompts[slot] = best
                    self._miss[slot] = 0
                    boxes.remove(best)
        # seed empty slots from remaining detections
        free = [s for s in range(MAX_TRACKS) if s not in self._prompts]
        for slot, b in zip(free, boxes):
            self._iou.seed(b)
            self._prompts[slot] = b
            self._miss[slot] = 0


def _real_sam3_backend() -> Optional[SamBackend]:
    """Concrete SAM 3.x tracker, lazily imported so CPU hosts stay safe.
    `clip_path` comes from the environment on GPU/VOD runs."""
    try:
        from .sam3_backend import Sam3Backend

        return Sam3Backend(clip_path=os.environ.get("PERCEIVE_SAM_CLIP"))
    except Exception:
        return None


def make_tracker() -> "IoUTracker":
    """Construct the tracker per PERCEIVE_TRACKER (default `iou`). `florence_sam`
    opts into the Florence+SAM hybrid; without a real SAM backend it falls back
    to the exact Florence->IoU behaviour."""
    mode = os.environ.get("PERCEIVE_TRACKER", "iou")
    if mode == "florence_sam":
        b = _real_sam3_backend()
        if b is not None:
            return HybridTracker(detect=None, backend=b)
    return IoUTracker()


def _nearest_box(ref: BBox, boxes: List[BBox]) -> Optional[BBox]:
    best, bestd = None, None
    for i, b in enumerate(boxes):
        d = abs(ref[0] - b[0]) + abs(ref[1] - b[1]) + abs(ref[2] - b[2]) + abs(ref[3] - b[3])
        if bestd is None or d < bestd:
            best, bestd = i, d
    return best if best is None else boxes[best]

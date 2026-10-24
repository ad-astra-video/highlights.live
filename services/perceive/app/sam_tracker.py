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

from .tracker import BBox, CandidateEvent, IoUTracker, MAX_TRACKS, Track, kind_from_label

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
        capacity: int = MAX_TRACKS,
        anchor_label: str | None = None,
        ball_label: str | None = None,     # ADAAAA-7217 Inc A: dedicated locked ball SAM slot
        ball_hold_frames: int = 5,         # ball-miss frames held before re-detect (eviction guard)
    ):
        self._detect = detect
        self._backend = backend
        self.redetect_every = redetect_every
        self.lost_before_redetect = lost_before_redetect
        self.capacity = max(1, int(capacity))
        self._iou = IoUTracker(jump_velocity=jump_velocity, lost_before_evict=lost_before_evict, cooldown_s=cooldown_s, capacity=self.capacity, anchor_label=anchor_label)
        # slot -> box prompt SAM is currently tracking; slot -> miss count
        self._prompts: Dict[int, BBox] = {}
        self._miss: Dict[int, int] = {}
        self._since_detect = 0
        # ADAAAA-7217 (Increment A): a dedicated, LOCKED ball SAM slot. The ball
        # is small/fast and a generic slot would be auto-evicted after a few
        # lost frames, so this slot is pinned (never evicted) and holds the last
        # known box forward during a detection gap (reusing the BallTracker
        # eviction-guard semantics at the SAM level). Florence re-identifies the
        # ball only when the slot reports sustained absence (SAM loss).
        self.ball_label = ball_label
        self.ball_hold_frames = max(1, int(ball_hold_frames))
        self._ball_slot: Optional[int] = None
        self._ball_prompt: Optional[BBox] = None   # current SAM box
        self._ball_held: Optional[BBox] = None     # last known box (eviction guard)
        self._ball_miss = 0
        self._ball_on_screen = False
        self._ball_on_screen_frames = 0
        self._ball_present_frames = 0
        self._ball_tail_frames = 0

    @property
    def tracks(self) -> List[Track]:
        return self._iou.tracks

    # --- operator control (delegated, plus SAM re-prompt on seed) -----------
    def seed(self, bbox: BBox, kind: str = "unknown", label: str = "", slot: int | None = None, ts: float = 0.0, selected: bool = False) -> Track:
        tr = self._iou.seed(bbox, kind=kind, label=label, slot=slot, ts=ts, selected=selected)
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

    def set_anchor(self, label: str | None) -> None:
        """Set the plan anchor label (ADAAAA-6463) — delegate to the IoU layer."""
        self._iou.set_anchor(label)

    # --- dedicated locked ball SAM slot (ADAAAA-7217 Increment A) ------------
    @property
    def ball_live(self) -> bool:
        """True once the ball has been identified and SAM is tracking it."""
        return self._ball_slot is not None

    @property
    def ball_miss_frames(self) -> int:
        return self._ball_miss

    def ball_box(self) -> Optional[BBox]:
        """The ball's current SAM box, or the held last-known box while within
        the eviction-guard hold window, else None (ball absent / off screen)."""
        if self._ball_slot is None:
            return None
        box = self._ball_prompt
        if box is None and self._ball_held is not None and self._ball_miss <= self.ball_hold_frames:
            box = self._ball_held
        return box

    def ball_needs_redetect(self) -> bool:
        """True when the SAM ball slot has reported sustained absence (>= the
        hold window) and Florence must re-identify the ball to re-seed it."""
        return self._ball_slot is not None and self._ball_miss > self.ball_hold_frames and self._ball_prompt is None

    def ball_persistence(self) -> float:
        """Fraction of on-screen frames for which a ball track was emitted
        (matches the BallTracker >=95% persistence target)."""
        if self._ball_on_screen_frames == 0:
            return 1.0
        return self._ball_present_frames / self._ball_on_screen_frames

    def seed_ball(self, bbox: BBox, ts: float = 0.0) -> None:
        """Reserve/lock the dedicated ball SAM slot and seed it from `bbox`.

        Bypasses the generic (player) slot pool, so the ball never competes for a
        player slot and is never auto-evicted. Sets the SAM prompt and marks the
        ball on-screen. `bbox` is a normalized [x1,y1,x2,y2] box.
        """
        if self._ball_slot is None:
            used = set(self._prompts.keys())
            free = [s for s in range(self.capacity) if s not in used]
            slot = free[0] if free else 0
            self._ball_slot = slot
            # Pin the slot so the IO layer never auto-evicts the ball track.
            self._iou.lock(slot)
        b: BBox = (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
        self._ball_prompt = b
        self._ball_held = b
        self._ball_miss = 0
        self._ball_on_screen = True
        self._prompts[self._ball_slot] = b
        self._miss[self._ball_slot] = 0
        # Reflect the ball as a confirmed, selected (find-and-track) track so it
        # surfaces in `tracks` with the ball label/kind, matching prior output.
        self._iou.seed(b, kind="ball", label=self.ball_label or "", slot=self._ball_slot, ts=ts, selected=True)

    def candidate(self, ts: float) -> Optional[CandidateEvent]:
        return self._iou.candidate(ts)

    # --- frame step ---------------------------------------------------------
    def step_frame(self, frame_rgb: np.ndarray, ts: float, florence_boxes: Optional[List[BBox]] = None, labels: Optional[List[str]] = None) -> List[Track]:
        """Advance one frame. `florence_boxes` are the caller's already-computed
        Florence detections for THIS frame; they seed the IoU layer (and, on a
        cold SAM start, the SAM prompts) — see `_sam_step` for the gating rule.
        `labels` (parallel to `florence_boxes`) carries each detection's in-roster
        label so tracks are seeded with it instead of "unknown" (ADAAAA-5056).
        With no SAM backend this degrades to pure Florence -> IoU."""
        if self._backend is not None and self._backend.ready():
            boxes, box_labels, box_slots = self._sam_step(frame_rgb, florence_boxes, labels)
        else:
            # No SAM: pure Florence -> IoU (unchanged behaviour).
            boxes = florence_boxes or []
            box_labels = labels
            box_slots = None
            self._since_detect += 1
        return self._iou.step(boxes, ts, labels=box_labels, box_slots=box_slots)

    def _sam_step(self, frame_rgb: np.ndarray, florence_boxes: Optional[List[BBox]] = None, labels: Optional[List[str]] = None) -> tuple[List[BBox], Optional[List[str]], Optional[List[Optional[int]]]]:
        """Run SAM one frame ahead for every tracked slot.

        Gating (rule: Florence IDENTIFIES, SAM TRACKS — SAM never runs with
        nothing to track):
          - Nothing tracked yet but Florence identified objects this frame:
            BOOTSTRAP — seed SAM prompts from those detections first, then step.
          - Nothing tracked AND no new identification this frame: idle frame —
            do NOT call SAM at all (no `advance()`), just return Florence's
            (empty) boxes for the IoU/CD layer.
          - Otherwise advance all prompts (SAM follows what's already been
            identified); ask Florence to re-detect on cadence / SAM loss /
            target change. Re-detect uses the caller's Florence boxes for this
            frame when provided (no redundant model pass), else `detect`.
        `labels` (parallel to `florence_boxes`) carries each detection's in-roster
        label so reseeded tracks keep the gated label (ADAAAA-5056).
        Returns (boxes to feed the IoU CD layer, labels parallel to those boxes)."""
        self._since_detect += 1
        # Bootstrap / idle gating: only call SAM when there is a target to track.
        if not self._prompts:
            if florence_boxes:
                self._reseed_from(list(florence_boxes), labels)  # Florence identified -> seed SAM
                self._since_detect = 0
            else:
                return (florence_boxes or []), labels, None  # nothing identified -> skip SAM
        need_redetect = self._since_detect >= self.redetect_every
        self._backend.advance(dict(self._prompts))  # one frame's compute for all slots
        sam_boxes: List[BBox] = []
        sam_labels: List[str] = []
        sam_slots: List[Optional[int]] = []   # ADAAAA-7305: slot provenance for IoU same-slot matching
        for slot in list(self._prompts.keys()):
            is_ball = slot == self._ball_slot
            b = self._backend.get(slot)
            if b is None:
                self._miss[slot] = self._miss.get(slot, 0) + 1
                if is_ball:
                    self._ball_miss = self._ball_miss + 1
                    # ADAAAA-7217 (Inc A): eviction guard for the ball — hold the
                    # last known box forward during the hold window (also fed to
                    # the IO layer so the ball track never flickers), and only
                    # after sustained absence mark the slot as needing Florence
                    # re-identification (via ROI recovery in process_frame).
                    if self._ball_miss <= self.ball_hold_frames and self._ball_held is not None:
                        sam_boxes.append(self._ball_held)
                        sam_labels.append(self.ball_label or "")
                        sam_slots.append(self._ball_slot)
                    else:
                        self._ball_prompt = None
                        if self._ball_miss > self.ball_hold_frames:
                            need_redetect = True
                elif self._miss[slot] >= self.lost_before_redetect:
                    need_redetect = True  # SAM lost this target -> Florence must refind it
            else:
                self._miss[slot] = 0
                self._prompts[slot] = b  # carry the prompt forward
                if is_ball:
                    self._ball_miss = 0
                sam_boxes.append(b)
                sam_slots.append(slot)
                # Keep the slot's known label on the SAM-propated box.
                tr = next((t for t in self._iou.tracks if t.slot == slot), None)
                sam_labels.append(tr.label if tr is not None else "")
            if is_ball:
                self._update_ball_state(b)  # b may be None (held handled above)

        if need_redetect:
            if florence_boxes is None and self._detect is not None:
                det = self._detect(frame_rgb) or []
                florence_boxes = [d["bbox"] for d in det if d.get("bbox")]
                labels = [str(d.get("label", "") or "") for d in det if d.get("bbox")]
            self._reseed_from(florence_boxes or [], labels)
            self._since_detect = 0
            # ADAAAA-7305: feed the IoU layer the SAM-PROPAGATED tracked boxes on
            # a redetect frame, not the raw Florence detections. `_reseed_from`
            # already re-seeded the SAM prompts (and, on SAM loss, re-identified
            # the target) and minted new IoU tracks for newly detected objects,
            # so an already-tracked slot (the dedicated ball slot OR an
            # operator-selected `player #N` slot) must NOT appear lost just
            # because this frame's Florence detections are being made available —
            # returning the raw detections dropped the SAM box and drove the
            # selected track's onto_frames to 0 / accuracy to None. Fall back to
            # the fresh detections only when no tracked box was produced this
            # frame (all slots lost -> the fresh detections seed the IoU layer).
            ret_boxes = sam_boxes or florence_boxes or []
            ret_labels = sam_labels or labels
            ret_slots = sam_slots if sam_boxes else None
            return ret_boxes, ret_labels, ret_slots
        return sam_boxes, sam_labels, sam_slots

    def _reseed_from(self, boxes: List[BBox], labels: Optional[List[str]] = None) -> None:
        """Re-prompt SAM slots from a fresh Florence detection set."""
        boxes = list(boxes)
        u_labels = list(labels) if labels is not None else [None] * len(boxes)
        # ADAAAA-7217 (Increment A): route a ball detection to the dedicated
        # locked ball SAM slot — never the generic (player) slot pool, so the
        # ball can't be evicted or displaced by a player box.
        if self.ball_label and boxes:
            for i, b in enumerate(boxes):
                lab = (u_labels[i] or "").lower()
                if "ball" in lab or lab == self.ball_label.lower():
                    bb = boxes.pop(i)
                    u_labels.pop(i)
                    if self._ball_slot is None:
                        self.seed_ball(bb)  # first identification bootstraps the slot
                    else:
                        # Re-identify (SAM loss): refresh the ball prompt/held box
                        # and re-arm the survive-without-eviction guard.
                        self._ball_prompt = bb
                        self._ball_held = bb
                        self._ball_miss = 0
                        self._ball_on_screen = True
                        self._prompts[self._ball_slot] = bb
                        self._miss[self._ball_slot] = 0
                        btr = next((t for t in self._iou.tracks if t.slot == self._ball_slot), None)
                        if btr is not None:
                            btr.bbox = bb
                            btr.lost_frames = 0
                    break
        # refresh existing tracked slots with a SAME-CLASS detection when possible
        for slot in list(self._prompts.keys()):
            if slot == self._ball_slot:
                continue  # ball is refreshed above / by its own guard
            tr = next((t for t in self._iou.tracks if t.slot == slot), None)
            if tr is not None:
                best = _nearest_box(tr.bbox, boxes)
                if best is not None:
                    bi = boxes.index(best)
                    lab = u_labels[bi] or ""
                    # ADAAAA-7243: only adopt a detection that belongs to the
                    # SLOT's own trackable class. The per-frame roster (e.g.
                    # soccer: ball+goal) holds non-player classes; taking the
                    # nearest such box would re-prompt the player slot onto a
                    # different object AND clobber an operator-named selected
                    # track's identity (seeded "player #9" -> "goal"), so the
                    # player-by-number track stops surfacing its label/accuracy.
                    if lab and kind_from_label(lab) != tr.kind:
                        continue
                    self._prompts[slot] = best
                    self._miss[slot] = 0
                    tr.bbox = best
                    # ADAAAA-5056/7243: an operator-selected track keeps its
                    # identity label (e.g. "player #9"); untagged auto tracks
                    # adopt the detection's gated in-roster label.
                    if lab and not tr.selected:
                        tr.label = lab
                        tr.kind = kind_from_label(lab)
                    boxes.pop(bi)
                    u_labels.pop(bi)
        # seed empty slots from remaining detections (mode capacity)
        free = [s for s in range(self.capacity) if s not in self._prompts]
        for slot, (b, lab) in zip(free, zip(boxes, u_labels)):
            # ADAAAA-5069: reuse a recently-evicted identity when this box is a
            # re-appearance (dropout-tolerant), so SAM re-detect does not mint a
            # fresh track id and split a real object's ID.
            # ADAAAA-5056: seed with the gated in-roster label so the surfaced
            # box never falls back to "unknown".
            self._iou.seed_reuse_identity(b, ts=0.0, kind=kind_from_label(lab or ""), label=lab or "")
            self._prompts[slot] = b
            self._miss[slot] = 0


    def _update_ball_state(self, sam_box: Optional[BBox]) -> None:
        """Update the ball's on-screen/persistence metric for the current frame.

        A 'present' frame emits a ball box (the real SAM box, or the eviction-
        guard held box while within the hold window — matching BallTracker,
        where a held box still counts as on-screen). Frames beyond the hold
        window are absent; the on-screen interval closes (and the dead tail is
        rolled back) once the ball is gone long enough, so a mid-shot gap does
        not count against the >=95% persistence target.
        """
        if sam_box is not None:
            self._ball_prompt = sam_box
            self._ball_held = sam_box
        present = self.ball_box() is not None
        if present:
            self._ball_on_screen = True
            self._ball_on_screen_frames += 1
            self._ball_present_frames += 1
            self._ball_tail_frames = 0
        else:
            self._ball_tail_frames += 1
            if self._ball_on_screen and self._ball_tail_frames >= max(self.ball_hold_frames, 1) + 1:
                self._ball_on_screen = False
                self._ball_on_screen_frames -= self._ball_tail_frames
                self._ball_tail_frames = 0


def _real_sam3_backend(clip_path: str | None = None) -> Optional[SamBackend]:
    """Concrete SAM 3.x tracker, lazily imported so CPU hosts stay safe.
    `clip_path` is the this-job recorded stream (or PERCEIVE_SAM_CLIP on standalone
    VOD runs)."""
    try:
        from .sam3_backend import Sam3Backend

        return Sam3Backend(clip_path=clip_path)
    except Exception:
        return None


def make_tracker(clip_path: str | None = None, capacity: int = MAX_TRACKS, anchor_label: str | None = None) -> "IoUTracker":
    """Construct the tracker per PERCEIVE_TRACKER (default `iou`). `florence_sam`
    opts into the Florence+SAM hybrid; without a real SAM backend it falls back
    to the exact Florence->IoU behaviour.

    `clip_path` (per JOB, takes precedence over the global PERCEIVE_SAM_CLIP)
    is the full recorded stream for this session: the Sam3Backend opens a SAM
    session on it and steps one frame per `advance()` as frames arrive, so the
    persistent session tracks across the whole stream — Florence re-detects only
    on SAM loss / cadence / target change.

    `capacity` is the mode's track slot count (INC-6: default 8 VOD; live
    sessions pass LIVE_MAX_TRACKS=3). `anchor_label` is the plan anchor
    (ADAAAA-6463 anchor-slot policy): the anchor object is prioritized for the
    primary slot.
    """
    mode = os.environ.get("PERCEIVE_TRACKER", "iou")
    if mode == "florence_sam":
        b = _real_sam3_backend(clip_path or os.environ.get("PERCEIVE_SAM_CLIP"))
        if b is not None:
            return HybridTracker(detect=None, backend=b, capacity=capacity, anchor_label=anchor_label)
    return IoUTracker(capacity=capacity, anchor_label=anchor_label)


def _nearest_box(ref: BBox, boxes: List[BBox]) -> Optional[BBox]:
    best, bestd = None, None
    for i, b in enumerate(boxes):
        d = abs(ref[0] - b[0]) + abs(ref[1] - b[1]) + abs(ref[2] - b[2]) + abs(ref[3] - b[3])
        if bestd is None or d < bestd:
            best, bestd = i, d
    return best if best is None else boxes[best]

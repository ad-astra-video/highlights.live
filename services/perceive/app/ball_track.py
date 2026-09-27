"""Eviction-guarded ball track (INC-2b / ADAAAA-4326).

The ball is small and fast. A generic IoU/centroid tracker (see ``tracker.py``)
matches a fast-moving small blob poorly and auto-evicts a slot after a few lost
frames, so a missed Florence-2 ``<OD>`` "sports ball" detection on even one busy
frame drops the ball and it has to be re-found from scratch. That flicker is
unacceptable for the ball-centric candidate signal: the track must persist while
the ball is on screen.

This ``BallTracker`` solves it with a DEDICATED, eviction-guarded slot:

  - One ball slot only -- it never shares ``MAX_TRACKS`` with the player tracks.
  - Never auto-evicts: a brief detection gap HOLDS the last known box forward
    (``loss_hold_frames``), bridging single/multi-frame detection misses, so the
    frame-to-frame track (and the SAM3 prompt it feeds) survives.
  - Re-acquires instantly from the next real "sports ball" detection.
  - Reports a persistence metric (present frames / on-screen frames) so QA can
    verify the >=95% on-screen persistence target.

It is a pure box-level tracker (no model): feed it per-frame Florence ball
bboxes. In the full pipeline (later slice) the same held/updated box is pushed to
the SAM3 backend's dedicated ball slot, which is ``lock()``ed so it is never
auto-evicted there either -- the guard lives here at the box layer.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

BBox = Tuple[float, float, float, float]  # x1, y1, x2, y2 normalized 0..1


@dataclass
class BallState:
    """Per-frame ball-track result."""

    present: bool  # a ball track exists this frame (detected or held)
    bbox: Optional[BBox]  # the ball box emitted this frame (None when absent)
    lost_frames: int  # consecutive frames since the last real detection
    held: bool  # True when the box was carried forward, not freshly detected
    real: bool  # True when this frame had an actual "sports ball" detection


def _pick_largest(boxes: Sequence[BBox]) -> Optional[BBox]:
    """Choose the largest-area ball box (usually there is exactly one)."""
    best: Optional[BBox] = None
    best_area = -1.0
    for b in boxes:
        x1, y1, x2, y2 = (float(v) for v in b)
        area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
        if area > best_area:
            best_area = area
            best = (x1, y1, x2, y2)
    return best


class BallTracker:
    """One eviction-guarded ball slot.

    ``loss_hold_frames`` frames of missed detections are bridged by holding the
    last known box forward; beyond that the ball is reported absent (off screen
    or genuinely occluded) but the slot is never destroyed, so it re-acquires
    on the next real detection without needing a fresh slot or re-seed.

    ``off_screen_after`` frames without a real detection end the current
    on-screen interval (the ball likely left the shot); the next real detection
    starts a new one. On-screen persistence is tracked across these intervals.
    """

    def __init__(self, loss_hold_frames: int = 5, off_screen_after: int = 20):
        self.loss_hold_frames = max(1, int(loss_hold_frames))
        self.off_screen_after = max(1, int(off_screen_after))
        self._box: Optional[BBox] = None
        self._confirmed = False  # we have ever seen a real ball detection
        self._lost = 0
        self._on_screen = False  # within an on-screen interval this frame
        self._on_screen_frames = 0
        self._present_frames = 0
        self._last_det = 0.0
        # Consecutive on-screen frames since the last present frame in the open
        # interval; rolled back when the interval closes (the "ball left the
        # shot" tail must not count as on-screen miss time).
        self._tail_frames = 0

    # ------------------------------------------------------------------ state
    @property
    def ball_box(self) -> Optional[BBox]:
        """Most recent ball box (held or detected)."""
        return self._box

    @property
    def confirmed(self) -> bool:
        return self._confirmed

    @property
    def lost_frames(self) -> int:
        return self._lost

    # ------------------------------------------------------------------ step
    def step(self, boxes: Optional[Sequence[BBox]], ts: float = 0.0) -> BallState:
        """Advance one frame with this frame's Florence ``<OD>`` ball detections.

        ``boxes`` are raw ball bboxes for this frame (empty / None when Florence
        found no ball this frame). Returns the emitted ``BallState``.
        """
        picked = _pick_largest(boxes) if boxes else None
        if picked is not None:
            # Real detection -- refresh the box, the ball is on screen.
            self._box = picked
            self._confirmed = True
            self._on_screen = True
            self._lost = 0
            self._last_det = ts
            held = False
            present = True
            real = True
        elif self._confirmed and self._on_screen and self._lost < self.loss_hold_frames:
            # Eviction guard: bridge a missed detection by holding the last box.
            self._lost += 1
            held = True
            present = True
            real = False
        else:
            # No ball, and outside the hold window: absent this frame.
            self._lost += 1
            held = False
            present = False
            real = False
            if self._on_screen and self._lost >= self.off_screen_after:
                # Ball left the shot for long enough -- end the on-screen
                # interval and roll back the dead tail so it does not count as
                # on-screen miss time (mid-shot occlusion gaps still counted).
                self._on_screen = False
                self._on_screen_frames -= self._tail_frames
                self._tail_frames = 0

        if self._on_screen:
            self._on_screen_frames += 1
            if present:
                self._present_frames += 1
                self._tail_frames = 0
            else:
                self._tail_frames += 1

        return BallState(
            present=present,
            bbox=self._box if present else None,
            lost_frames=self._lost,
            held=held,
            real=real,
        )

    # --------------------------------------------------------------- metrics
    def persistence(self) -> float:
        """Fraction of on-screen frames for which a ball track was emitted."""
        if self._on_screen_frames == 0:
            return 1.0
        return self._present_frames / self._on_screen_frames

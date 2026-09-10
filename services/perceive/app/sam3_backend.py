"""SAM 3.1 backend for HybridTracker: per-frame, multi-mask, reusing SAM 3's own
state machinery.

We do NOT reimplement tracking. We wrap the repo's `build_sam3_video_predictor`
and drive it the same way its own classes do, but step ONE frame per call
(`propagate_in_video(start_frame_idx=f, max_frame_num_to_track=1)`) instead of
consuming the whole clip in one loop. All cross-frame object state is SAM's:
`inference_state["cached_frame_outputs"]`, per-object masked keyed by obj_id in
`out["obj_id_to_mask"]` (the repo's multi-mask-across-frames convention).

Slot pairing: HybridTracker tracks up to MAX_TRACKS slabs; each slot maps 1:1 to
a SAM obj_id. A box prompt becomes a single positive center point (classic SAM
box->point reduction). Per frame we read each tracked obj_id's mask and turn it
into a bbox; a slot whose object is absent that frame returns None so
HybridTracker asks Florence to re-detect.

`sam3` hard-depends on `triton` (GPU) and gated checkpoints, so the import is
lazy: on CPU/no-SDK `ready()` is False and HybridTracker falls back to
Florence->IoU. The same `advance(prompts)/get(slot)` contract is unit-tested
against a fake predictor that mimics the repo's handle_request /
handle_stream_request surface.
"""
from __future__ import annotations

from typing import Dict, List, Optional

import numpy as np

from .sam_tracker import SamBackend
from .tracker import BBox

MAX_TRACKS = 2


# --------------------------------------------------------------------------
# geometry helpers (testable without sam3)
# --------------------------------------------------------------------------
def mask_to_bbox(mask: "np.ndarray", h: int, w: int) -> Optional[BBox]:
    """Binary mask (H,W) -> normalized bbox (x1,y1,x2,y2), None if empty."""
    ys, xs = np.nonzero(mask)
    if len(xs) == 0 or len(ys) == 0:
        return None
    return (
        float(max(0.0, xs.min() / w)),
        float(max(0.0, ys.min() / h)),
        float(min(1.0, (xs.max() + 1) / w)),
        float(min(1.0, (ys.max() + 1) / h)),
    )


def box_to_point(box: BBox) -> "np.ndarray":
    """Box prompt -> single positive center point (normalized) for add_prompt."""
    return np.array([[(box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0]], dtype=np.float32)


def _as_numpy_mask(m) -> Optional["np.ndarray"]:
    try:
        if hasattr(m, "cpu"):
            m = m.detach().cpu().numpy()
        arr = np.asarray(m).squeeze()
        if arr.ndim == 3:  # [1,H,W] or [C,H,W] -> pick the foreground plane
            arr = arr[0] if arr.shape[0] in (1, 2) else arr.argmax(0)
        return (arr > 0).astype(bool) if arr.ndim == 2 else None
    except Exception:
        return None


# --------------------------------------------------------------------------
# backend
# --------------------------------------------------------------------------
class Sam3Backend(SamBackend):
    """Per-frame SAM 3.x tracker. `predictor_factory` defaults to the repo's
    build_sam3_video_predictor (lazy). `advance()` runs exactly one frame's
    propagation for every active slot; `get(slot)` peeks the cached result."""

    def __init__(self, predictor_factory=None, clip_path: str | None = None):
        self._factory = predictor_factory or self._default_predictor
        self._clip_path = clip_path
        self._predictor = None
        self._session_id: Optional[str] = None
        self._hw: Optional[tuple[int, int]] = None          # (H, W) of masks
        self._frame_idx = 0
        self._seeded: Dict[int, BBox] = {}                  # slot -> prompt we seeded
        self._last_returned: Dict[int, Optional[BBox]] = {} # slot -> box we last returned
        self._current: Dict[int, Optional[BBox]] = {}       # slot -> this frame's box
        self._started = False

    # --- plumbing -----------------------------------------------------------
    @staticmethod
    def _default_predictor():
        from sam3.model_builder import build_sam3_video_predictor  # lazy: triton/GPU
        return build_sam3_video_predictor()

    def ready(self) -> bool:
        if not self._started:
            self._start()
        return self._started and self._session_id is not None

    def _start(self) -> bool:
        try:
            if self._clip_path:
                self._predictor = self._factory()
                resp = self._predictor.handle_request(
                    {"type": "start_session", "resource_path": self._clip_path}
                )
                self._session_id = resp.get("session_id")
            self._started = self._session_id is not None
        except Exception:
            self._predictor, self._session_id, self._started = None, None, False
        return self._started

    def _request(self, req: dict):
        return self._predictor.handle_request(req)

    def _propagate_one_frame(self, frame_idx: int) -> Dict[int, Optional[BBox]]:
        """Ask SAM to propagate one frame; return slot(by obj_id) -> box or None."""
        try:
            gen = self._predictor.handle_stream_request(
                {
                    "type": "propagate_in_video",
                    "session_id": self._session_id,
                    "start_frame_idx": frame_idx,
                    "max_frame_num_to_track": 1,
                }
            )
            result = next(gen, None)
        except Exception:
            result = None
        if not result:
            return {}
        out = result.get("outputs") or {}
        obj_id_to_mask = out.get("obj_id_to_mask") or {}
        parsed: Dict[int, Optional[BBox]] = {}
        for oid, m in obj_id_to_mask.items():
            oid = int(oid)
            mask = _as_numpy_mask(m)
            if mask is None or not mask.any():
                parsed[oid] = None
                continue
            if mask.ndim == 2:
                h, w = mask.shape
                if self._hw is None:
                    self._hw = (h, w)
                parsed[oid] = mask_to_bbox(mask, h, w)
        return parsed

    # --- SamBackend contract ------------------------------------------------
    def advance(self, prompts: Dict[int, BBox]) -> None:
        """Propagate exactly one frame for all active slots.

        Distinguishes two reasons a slot's prompt can differ from what we seeded:
          * SAM DRIFT  -> the prompt equals the box we ourselves last returned
                          (HybridTracker carried our mask bbox forward). Not a
                          target change: normal tracking, keep seeding as-is.
          * EXTERNAL   -> a new target (user seed / Florence re-detect) where the
                          prompt differs from our last returned box. Re-prompt.
        Only external changes reseed (SAM 3: reset + re-add)."""
        if not self.ready():
            return
        changed = {
            s: p
            for s, p in prompts.items()
            if self._seeded.get(s) != p and self._last_returned.get(s) != p
        }
        if changed:
            if self._seeded:  # already tracking prompts -> reset then re-add all
                self._request({"type": "reset_session", "session_id": self._session_id})
                for s, p in list(self._seeded.items()):
                    if s not in changed and s in prompts:
                        self._add_prompt(s, p)
            for s, p in changed.items():
                self._add_prompt(s, p)
                self._seeded[s] = p
        for s in list(self._seeded):
            if s not in prompts:  # dropped target
                self._seeded.pop(s, None)
        self._current = self._propagate_one_frame(self._frame_idx)
        self._frame_idx += 1
        # remember the boxes WE produced this frame -> drift won't look like a
        # target change on the next advance
        self._last_returned = {s: self._current.get(s) for s in prompts}

    def _add_prompt(self, obj_id: int, box: BBox) -> None:
        self._request(
            {
                "type": "add_prompt",
                "session_id": self._session_id,
                "frame_index": self._frame_idx,
                "points": box_to_point(box),
                "point_labels": np.array([1], dtype=np.int32),
                "obj_id": obj_id,
            }
        )

    def get(self, slot: int) -> Optional[BBox]:
        return self._current.get(slot)

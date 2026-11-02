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

import os
import threading
from typing import Dict, List, Optional

import numpy as np

from .sam_tracker import SamBackend
from .tracker import BBox

# Schema ceiling (VOD target, INC-6). Live sessions cap lower; the capacity is
# threaded through the tracker the backend serves.
MAX_TRACKS = 8


def _env_flag(name: str, default: str = "0") -> bool:
    return str(os.environ.get(name, default) or "0").strip().lower() in ("1", "true", "yes", "on")


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


# ADAAAA-7345: a single center point is a weak prompt for a LARGE target such as
# a player: on the census clip the `player #N` masklet died a few frames after
# the mid-stream seed while the tiny frame-0 ball propagated at 100%. Give
# player-sized boxes a small positive point cluster (center + 4 inset corners)
# so the tracker anchors on the torso rather than one pixel that may land on a
# jersey number, the pitch, or a neighbouring shirt.
# Below this normalized area the box is a small object (e.g. the ball), and the
# single center point is kept unchanged so the verified 100% ball propagation
# is not perturbed.
MULTI_POINT_MIN_AREA = 0.008
_INSET_FRACTIONS = ((0.5, 0.5), (0.3, 0.3), (0.7, 0.3), (0.3, 0.7), (0.7, 0.7))


def box_to_points(box: BBox, min_area: float = MULTI_POINT_MIN_AREA) -> "np.ndarray":
    """Box prompt -> positive points (normalized) for SAM3's tracker path.

    Small boxes (the ball) get the classic single center point; player-sized
    boxes get a center + inset-corner cluster. The center point is ALWAYS first
    so callers/tests that read `points[0]` keep seeing the box center.
    """
    x1, y1, x2, y2 = box
    w = max(0.0, x2 - x1)
    h = max(0.0, y2 - y1)
    if w * h < min_area:
        return box_to_point(box)
    pts = np.array([[x1 + fx * w, y1 + fy * h] for fx, fy in _INSET_FRACTIONS],
                   dtype=np.float32)
    return pts


def _load_frame_images(frames_dir: str, limit: int | None = None) -> list:
    """Load a decoded-frame directory as PIL images (SAM3 decoder-free input).

    SAM3's `load_resource_as_video_frames` accepts a list of PIL images and
    indexes it exactly like a decoded video, so this is what lets a SAM session
    run in an image that ships neither cv2 nor torchcodec.
    """
    import glob
    from PIL import Image

    files: list[str] = []
    for ext in ("*.jpg", "*.jpeg", "*.png", "*.webp"):
        files.extend(glob.glob(os.path.join(frames_dir, ext)))
    files = sorted(files)
    if limit is not None:
        files = files[:limit]
    return [Image.open(fp).convert("RGB") for fp in files]


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
# Shared SAM 3 predictor, built once off-loop by preload.preload_sam3() at
# container startup. Building the GPU predictor (build_sam3_video_predictor) is
# a multi-second blocking op; reusing one predictor across Sam3Backends means
# the first VOD pass never pays it mid-call. SAM 3 hosts multiple sessions on a
# single predictor (each start_session gets its own session_id), so sharing is
# safe. Falls back to a per-backend factory when no shared predictor exists.
_shared_predictor = None
_shared_lock = threading.Lock()


def preload_sam3() -> bool:
    """Build the shared SAM 3 GPU predictor once (idempotent, thread-safe).
    Returns True when a shared predictor is available for Sam3Backend to reuse.
    Never raises: on CPU / no-SDK / gated-weights-missing it returns False and
    each backend builds (or skips) its own as before."""
    global _shared_predictor
    with _shared_lock:
        if _shared_predictor is not None:
            return True
        try:
            _shared_predictor = Sam3Backend._default_predictor()
            return _shared_predictor is not None
        except Exception:
            _shared_predictor = None
            return False


def _get_shared_predictor():
    with _shared_lock:
        return _shared_predictor


class Sam3Backend(SamBackend):
    """Per-frame SAM 3.x tracker. `predictor_factory` defaults to the repo's
    build_sam3_video_predictor (lazy). `advance()` runs exactly one frame's
    propagation for every active slot; `get(slot)` peeks the cached result.

    Uses the shared preloaded predictor (see preload_sam3) when available, so
    all sessions reuse one GPU build instead of each paying it. When an
    explicit `predictor_factory` is passed (tests / bespoke predictors), that
    factory always wins and the shared predictor is ignored.
    """

    # HybridTracker passes the CLIP frame index through `advance(..., frame_index=)`.
    supports_frame_index = True

    def __init__(self, predictor_factory=None, clip_path: str | None = None,
                 frames: list | None = None):
        self._explicit_factory = predictor_factory
        self._clip_path = clip_path
        # ADAAAA-7820: SAM3 opens a session from a video file via cv2/torchcodec,
        # NEITHER of which exists in the perceive image, so `start_session` on a
        # .mp4 raised and was silently swallowed -> SAM never advanced and every
        # "SAM3" track was really Florence->IoU. SAM3's loader ALSO accepts a
        # LIST OF PIL IMAGES, which needs no decoder: pass `frames` (or set
        # PERCEIVE_SAM_FRAMES_DIR to a decoded-frame directory) to open the
        # session that way.
        self._frames = frames
        self._frames_dir = os.environ.get("PERCEIVE_SAM_FRAMES_DIR") or None
        self.start_error: Optional[str] = None
        self._predictor = None
        self._session_id: Optional[str] = None
        self._hw: Optional[tuple[int, int]] = None          # (H, W) of masks
        self._frame_idx = 0
        self._seeded: Dict[int, BBox] = {}                  # slot -> prompt we seeded
        self._last_returned: Dict[int, Optional[BBox]] = {} # slot -> box we last returned
        self._current: Dict[int, Optional[BBox]] = {}       # slot -> this frame's box
        self._started = False
        # ADAAAA-7345: per-slot consecutive miss counter + the last box SAM
        # produced for that slot. SAM3's video tracker drops a masklet it loses
        # confidence in (`removed_obj_ids`), and it never re-registers it by
        # itself: the mid-stream `player #N` slot then returns None forever
        # (measured 0.2 accuracy / 3.9% on-screen) while the easy frame-0 ball
        # survives. When a slot misses, re-anchor its prompt at the CURRENT
        # frame from the last known box so the tracker re-detects the object
        # instead of writing it off.
        self._misses: Dict[int, int] = {}
        self._removed_obj_ids: set[int] = set()
        # ADAAAA-7345: SAM3 is built with hotstart_delay=15, so its propagate
        # stream buffers results and is meant to be consumed as a window; a
        # one-frame step recomputes two frames per advance and never builds a
        # real clip memory. Propagate a window and serve the cached per-frame
        # boxes so each clip frame is computed exactly once.
        self.propagate_window = int(
            os.environ.get("PERCEIVE_SAM_PROPAGATE_WINDOW", "16") or 16
        )
        self._box_cache: Dict[int, Dict[int, Optional[BBox]]] = {}
        self._removed_by_frame: Dict[int, set[int]] = {}
        self.recover_after_misses = 1     # re-prompt on the first missed frame
        self.recover_max_misses = 30      # stop re-prompting after this many misses
        # ADAAAA-7820: slot -> SAM obj_id. Normally obj_id == slot (stable 1:1),
        # but a masklet SAM REMOVED is re-registered under a FRESH obj_id: the
        # removed id stays in SAM's action history and its metadata row is
        # popped, so re-adding the same id is the path that historically failed
        # to bring the mid-stream player back.
        self._obj_ids: Dict[int, int] = {}
        self._next_obj_id = 100
        # last TIGHT mask bbox per slot — the mask-derived prompt used on
        # re-anchor instead of the stale detection/seed box.
        self._last_mask_box: Dict[int, BBox] = {}
        self._last_mask_ids: List[int] = []
        self._prompt_source: Dict[int, str] = {}
        # ADAAAA-7820 instrumentation: per-frame slot timeline, only recorded
        # when PERCEIVE_SAM_DEBUG is set so the production path is unchanged.
        self.debug = _env_flag("PERCEIVE_SAM_DEBUG")
        self.timeline: List[dict] = []
        self.backfill_frames: List[dict] = []
        self.backfill_calls = 0

    # --- plumbing -----------------------------------------------------------
    @staticmethod
    def _default_predictor():
        from sam3.model_builder import build_sam3_video_predictor  # lazy: triton/GPU
        return build_sam3_video_predictor()

    def ready(self) -> bool:
        if not self._started:
            self._start()
        return self._started and self._session_id is not None

    def _session_resource(self):
        """What to hand `start_session`: a PIL frame list when we have one.

        SAM3 decodes a video path with cv2/torchcodec, which the perceive image
        does not ship. A list of PIL images is the decoder-free equivalent and
        indexes identically (frame i == list index i).
        """
        if self._frames is not None:
            return self._frames
        if self._frames_dir:
            limit = int(os.environ.get("PERCEIVE_SAM_FRAMES_LIMIT", "0") or 0) or None
            self._frames = _load_frame_images(self._frames_dir, limit=limit)
            return self._frames
        return self._clip_path

    def _start(self) -> bool:
        try:
            resource = self._session_resource()
            if resource is not None:
                # Prefer the preloaded shared predictor (reuse the boot build);
                # an explicit factory (tests) always wins over the shared one.
                if self._explicit_factory is not None:
                    self._predictor = self._explicit_factory()
                else:
                    self._predictor = _get_shared_predictor()
                    if self._predictor is None:
                        self._predictor = Sam3Backend._default_predictor()
                resp = self._predictor.handle_request(
                    {"type": "start_session", "resource_path": resource}
                )
                self._session_id = resp.get("session_id")
            self._started = self._session_id is not None
        except Exception as e:
            # ADAAAA-7820: this used to be swallowed, which hid a completely
            # disabled SAM backend behind a plausible-looking Florence track.
            self.start_error = repr(e)
            import logging
            logging.getLogger(__name__).warning(
                "sam3 start_session failed resource=%s: %s",
                "frames[%d]" % len(self._frames or []) if self._frames else self._clip_path,
                e,
            )
            self._predictor, self._session_id, self._started = None, None, False
        return self._started

    def _request(self, req: dict):
        return self._predictor.handle_request(req)

    # --- slot <-> obj_id bookkeeping ----------------------------------------
    def _obj_id(self, slot: int) -> int:
        return self._obj_ids.get(slot, slot)

    def _slot_for_obj(self, obj_id: int) -> Optional[int]:
        for slot, oid in self._obj_ids.items():
            if oid == obj_id:
                return slot
        if obj_id in self._seeded:      # default 1:1 mapping
            return obj_id
        return None

    def _fresh_obj_id(self, slot: int) -> int:
        oid = self._next_obj_id
        self._next_obj_id += 1
        self._obj_ids[slot] = oid
        return oid

    def _parse_outputs(self, out: dict) -> Dict[int, Optional[BBox]]:
        """One propagated frame's masks -> slot -> box (or None).

        ADAAAA-7345 ROOT CAUSE: the client does NOT yield `obj_id_to_mask`.
        `Sam3VideoInference._postprocess_output` returns exactly
        `out_obj_ids`, `out_probs`, `out_boxes_xywh`, `out_binary_masks`,
        `frame_stats` — the per-object mask dict stays internal (it is only
        used to fill `inference_state["cached_frame_outputs"]`). The backend
        read `out["obj_id_to_mask"]`, so every frame parsed as "no objects"
        and the whole workstream measured zero masks. Parse the parallel
        arrays the client actually returns; keep the dict form as a
        compatibility path for fakes/older clients.
        """
        parsed: Dict[int, Optional[BBox]] = {}
        ids = out.get("out_obj_ids")
        masks = out.get("out_binary_masks")
        if ids is not None and masks is not None:
            id_list = [int(o) for o in list(ids)]
            self._last_mask_ids = sorted(id_list)
            mask_list = list(masks)
            for i, oid in enumerate(id_list):
                m = mask_list[i] if i < len(mask_list) else None
                slot = self._slot_for_obj(oid)
                if slot is None:
                    continue
                mask = _as_numpy_mask(m)
                if mask is None or not mask.any() or mask.ndim != 2:
                    parsed[slot] = None
                    continue
                h, w = mask.shape
                if self._hw is None:
                    self._hw = (h, w)
                b = mask_to_bbox(mask, h, w)
                parsed[slot] = b
                if b is not None:
                    self._last_mask_box[slot] = b
            return parsed
        obj_id_to_mask = out.get("obj_id_to_mask") or {}
        self._last_mask_ids = sorted(int(o) for o in obj_id_to_mask)
        for oid, m in obj_id_to_mask.items():
            oid = int(oid)
            slot = self._slot_for_obj(oid)
            if slot is None:
                continue
            mask = _as_numpy_mask(m)
            if mask is None or not mask.any():
                parsed[slot] = None
                continue
            if mask.ndim == 2:
                h, w = mask.shape
                if self._hw is None:
                    self._hw = (h, w)
                b = mask_to_bbox(mask, h, w)
                parsed[slot] = b
                if b is not None:
                    self._last_mask_box[slot] = b
        return parsed

    def _propagate_window(self, frame_idx: int,
                          direction: str = "forward",
                          max_frames: Optional[int] = None,
                          session_id: Optional[str] = None) -> Dict[int, Dict[int, Optional[BBox]]]:
        """Propagate a WINDOW from `frame_idx`; return frame -> slot -> box|None.

        ADAAAA-7345: the SAM3 video model is built with `hotstart_delay=15`
        (`model_builder` ~line 1175), so its propagate stream buffers results
        and expects the caller to consume a window; stepping one frame per call
        recomputes frames 2x and never builds real clip memory. The separate
        "zero masks" defect was NOT here: it was reading `obj_id_to_mask`,
        which the client never yields (see `_parse_outputs`).
        """
        window = int(self.propagate_window if max_frames is None else max_frames)
        window = max(1, window)
        out_by_frame: Dict[int, Dict[int, Optional[BBox]]] = {}
        try:
            gen = self._predictor.handle_stream_request(
                {
                    "type": "propagate_in_video",
                    "session_id": session_id or self._session_id,
                    # SAM3's client reads `start_frame_index` (with "index"),
                    # NOT `start_frame_idx`; the wrong key drops the start to
                    # None and re-tracks from the earliest annotation frame.
                    "start_frame_index": frame_idx,
                    "max_frame_num_to_track": window,
                    "propagation_direction": direction,
                }
            )
            for result in gen or []:
                if not isinstance(result, dict):
                    continue
                fi = int(result.get("frame_index", frame_idx))
                out = result.get("outputs") or {}
                # ADAAAA-7345: masklets SAM dropped are reported per frame so a
                # mid-stream target can be re-registered instead of staying
                # dark for the rest of the clip.
                self._removed_by_frame[fi] = {
                    int(x) for x in (out.get("removed_obj_ids") or [])
                }
                out_by_frame[fi] = self._parse_outputs(out)
        except Exception:
            return out_by_frame
        return out_by_frame

    def _boxes_for_frame(self, frame_idx: int) -> Dict[int, Optional[BBox]]:
        """Boxes for `frame_idx`, propagating a window on a cache miss.

        A window propagate is the unit SAM3 accepts, so its yields are cached:
        `advance()` is still called once per clip frame and each frame is
        computed exactly once (the pre-fix path recomputed two frames on
        every call for no result).
        """
        cached = self._box_cache.pop(frame_idx, None)
        if cached is not None:
            self._removed_obj_ids = self._removed_by_frame.get(frame_idx, set())
            return cached
        # Stale cache (a reset, a re-seed, or a jump in frame index).
        self._box_cache.clear()
        out_by_frame = self._propagate_window(frame_idx)
        if not out_by_frame:
            return {}
        self._box_cache.update(out_by_frame)
        self._removed_obj_ids = self._removed_by_frame.get(frame_idx, set())
        return self._box_cache.pop(frame_idx, {})

    # --- SamBackend contract ------------------------------------------------
    def advance(self, prompts: Dict[int, BBox], frame_index: Optional[int] = None) -> None:
        """Propagate exactly one frame for all active slots.

        `frame_index` (ADAAAA-7820) is the CLIP frame index when the caller knows
        it. Without it the backend falls back to counting its own advances,
        which drifts whenever SAM is idle for a stretch (no prompts yet) and
        puts a mid-stream prompt annotation at the wrong frame — SAM then
        re-tracks from frame 0 and drops the masklet within a few frames.

        Distinguishes two reasons a slot's prompt can differ from what we seeded:
          * SAM DRIFT  -> the prompt equals the box we ourselves last returned
                          (HybridTracker carried our mask bbox forward). Not a
                          target change: normal tracking, keep seeding as-is.
          * EXTERNAL   -> a new target (user seed / Florence re-detect) where the
                          prompt differs from our last returned box. Re-prompt.
        Only external changes reseed (SAM 3: reset + re-add)."""
        if not self.ready():
            return
        if frame_index is not None:
            self._frame_idx = int(frame_index)
        # ADAAAA-7820 measurement knob: restore the PRE-7820 re-anchor path
        # (same obj_id, prompt comes from the caller's carried box) so the
        # baseline can be measured on the SAME build as the fixes. Off by
        # default -> new behaviour.
        legacy_recover = _env_flag("PERCEIVE_SAM_RECOVER_LEGACY")
        changed = {
            s: p
            for s, p in prompts.items()
            if self._seeded.get(s) != p and self._last_returned.get(s) != p
        }
        reset = False
        if changed:
            if self._seeded:  # already tracking prompts -> reset then re-add all
                self._request({"type": "reset_session", "session_id": self._session_id})
                reset = True
                # The window cache was computed under the previous prompts;
                # those frames are stale after a reset.
                self._box_cache.clear()
                self._removed_by_frame.clear()
                for s, _ in list(self._seeded.items()):
                    if s not in changed and s in prompts:
                        # ADAAAA-7305: re-add from the CURRENT prompt, not the
                        # stale seed. A long-tracked slot (e.g. the ball seeded
                        # at frame 0) whose prompt drifted would otherwise be
                        # reset back to its frame-0 box when a NEW slot (the
                        # mid-stream `track-player #N` target) joins, throwing
                        # the established track off and losing its box.
                        self._add_prompt(s, prompts[s], source="carry")
            for s, p in changed.items():
                self._add_prompt(s, p, source="external")
                self._seeded[s] = p
        for s in list(self._seeded):
            if s not in prompts:  # dropped target
                self._seeded.pop(s, None)
                self._misses.pop(s, None)
                self._obj_ids.pop(s, None)
                self._last_mask_box.pop(s, None)
                self._prompt_source.pop(s, None)
        # ADAAAA-7345/7820: re-anchor any slot that came back empty on the
        # previous frame (SAM dropped the masklet or lost it) at the CURRENT
        # frame. The prompt is derived from the last ACCEPTED MASK's tight
        # bbox (not the stale OD/seed box) and, when SAM reported the masklet
        # as removed, the object is re-registered under a FRESH obj_id.
        reanchored: set[int] = set()
        for s in list(self._seeded):
            if s not in prompts:
                continue
            misses = self._misses.get(s, 0)
            if not (misses >= self.recover_after_misses and misses <= self.recover_max_misses):
                continue
            oid = self._obj_id(s)
            removed = oid in self._removed_obj_ids
            if legacy_recover:
                box = prompts[s]
            else:
                if removed:
                    oid = self._fresh_obj_id(s)
                box = self._last_mask_box.get(s) or prompts[s]
            self._add_prompt(s, box, source="mask", obj_id=oid)
            reanchored.add(s)
        if reanchored:
            # Cached outputs for this frame and later were computed BEFORE the
            # re-anchor prompt existed, so they no longer reflect the session
            # state. Drop them; the window is re-propagated from here.
            for f in [f for f in self._box_cache if f >= self._frame_idx]:
                self._box_cache.pop(f, None)
        self._current = self._boxes_for_frame(self._frame_idx)
        self._frame_idx += 1
        # per-slot miss accounting drives the recovery above
        for s in prompts:
            if self._current.get(s) is None:
                self._misses[s] = self._misses.get(s, 0) + 1
            else:
                self._misses[s] = 0
        # remember the boxes WE produced this frame -> drift won't look like a
        # target change on the next advance
        self._last_returned = {s: self._current.get(s) for s in prompts}
        if self.debug:
            self._record_frame(prompts, reanchored, reset)

    def _record_frame(self, prompts: Dict[int, BBox], reanchored, reset: bool) -> None:
        slots = {}
        for s in prompts:
            box = self._current.get(s)
            slots[str(s)] = {
                "obj_id": self._obj_id(s),
                "state": "matched" if box is not None else "lost",
                "reanchor": s in reanchored,
                "source": self._prompt_source.get(s),
                "misses": self._misses.get(s, 0),
                "box": [round(float(v), 4) for v in box] if box else None,
            }
        self.timeline.append({
            "frame": int(self._frame_idx - 1),
            "reset": bool(reset),
            "removed_obj_ids": sorted(self._removed_obj_ids),
            "mask_obj_ids": list(self._last_mask_ids),
            "slots": slots,
        })
        if len(self.timeline) > 4000:  # bound memory on very long clips
            del self.timeline[:1000]

    def _add_prompt(self, slot: int, box: BBox, source: str = "external",
                    obj_id: Optional[int] = None) -> None:
        # ADAAAA-7305: obj_id-based video tracking uses SAM3's TRACKER prompt
        # path (`add_tracker_new_points`), which requires `points` (+`obj_id`)
        # and FORBIDS a box at the same time. The client's
        # `sam3_video_inference.add_prompt` asserts points XOR boxes, and the
        # box path (`super().add_prompt`) is a semantic single-object prompt
        # that `reset_state`s and does NOT register per-obj_id tracking — so
        # sending `bounding_boxes` either crashes the call or drops obj_id.
        # We therefore keep the point prompt(s) + obj_id, which is the only form
        # that yields the per-slot `obj_id_to_mask` this backend consumes.
        # (Verified against the real client in the perceive image.)
        #
        # ADAAAA-7345: player-sized boxes get a positive point CLUSTER
        # (center + 4 inset corners) instead of a lone center pixel; small
        # objects (the ball) keep the single center point. A predictor that
        # rejects multi-point prompts falls back to the single point so the
        # tracker never dies on a prompt-form change.
        oid = self._obj_id(slot) if obj_id is None else obj_id
        self._obj_ids[slot] = oid
        self._prompt_source[slot] = source
        pts = box_to_points(box)
        if len(pts) > 1:
            try:
                self._request(
                    {
                        "type": "add_prompt",
                        "session_id": self._session_id,
                        "frame_index": self._frame_idx,
                        "points": pts,
                        "point_labels": np.ones(len(pts), dtype=np.int32),
                        "obj_id": oid,
                    }
                )
                return
            except Exception:
                pass
        self._request(
            {
                "type": "add_prompt",
                "session_id": self._session_id,
                "frame_index": self._frame_idx,
                "points": box_to_point(box),
                "point_labels": np.array([1], dtype=np.int32),
                "obj_id": oid,
            }
        )

    def get(self, slot: int) -> Optional[BBox]:
        return self._current.get(slot)

    # --- ADAAAA-7820: reverse propagation -----------------------------------
    def backfill_backward(self, frame_index: int, prompts: Dict[int, BBox]) -> List[dict]:
        """Propagate the given prompts BACKWARD from `frame_index` to frame 0.

        Runs in a SECOND SAM session on the same clip so the forward session's
        state is untouched: seed the prompt at `frame_index`, then propagate
        with `propagation_direction="backward"` for `frame_index + 1` frames.
        Returns per-frame `{frame, slot, bbox}` for every frame where a mask
        came back. This is what lets on-screen be measured over the WHOLE clip
        instead of only the frames after the mid-stream seed.
        Never raises: a predictor that cannot host a second session returns [].
        """
        if not self._clip_path or not prompts:
            return []
        sid = None
        out_frames: List[dict] = []
        self.backfill_calls += 1
        try:
            pred = self._predictor
            resp = pred.handle_request(
                {"type": "start_session", "resource_path": self._clip_path}
            )
            sid = (resp or {}).get("session_id")
            if sid is None:
                return []
            for slot, box in prompts.items():
                pts = box_to_points(box)
                pred.handle_request(
                    {
                        "type": "add_prompt",
                        "session_id": sid,
                        "frame_index": int(frame_index),
                        "points": pts,
                        "point_labels": np.ones(len(pts), dtype=np.int32),
                        "obj_id": int(slot),
                    }
                )
            gen = pred.handle_stream_request(
                {
                    "type": "propagate_in_video",
                    "session_id": sid,
                    "start_frame_index": int(frame_index),
                    "propagation_direction": "backward",
                    "max_frame_num_to_track": int(frame_index) + 1,
                }
            )
            for res in gen or []:
                if not res:
                    continue
                fi = int(res.get("frame_index", frame_index))
                outs = res.get("outputs") or {}
                for oid, m in (outs.get("obj_id_to_mask") or {}).items():
                    slot = int(oid)
                    mask = _as_numpy_mask(m)
                    if mask is None or not mask.any() or mask.ndim != 2:
                        continue
                    h, w = mask.shape
                    b = mask_to_bbox(mask, h, w)
                    if b is not None:
                        out_frames.append({"frame": fi, "slot": slot,
                                           "bbox": [round(float(v), 4) for v in b]})
        except Exception:
            return out_frames
        finally:
            if sid is not None:
                try:
                    self._predictor.handle_request(
                        {"type": "close_session", "session_id": sid}
                    )
                except Exception:
                    pass
        self.backfill_frames = out_frames
        return out_frames


def timeline_summary(timeline: List[dict], slot: int) -> dict:
    """Aggregate a per-frame slot timeline into a compact death/alive summary."""
    key = str(slot)
    matched = lost = reanchors = 0
    first_lost = last_matched = None
    removed_at: List[int] = []
    for row in timeline or []:
        st = (row.get("slots") or {}).get(key)
        if st is None:
            continue
        f = row.get("frame")
        if st.get("reanchor"):
            reanchors += 1
        if st.get("state") == "matched":
            matched += 1
            last_matched = f
        else:
            lost += 1
            if first_lost is None:
                first_lost = f
        oid = st.get("obj_id")
        if oid in (row.get("removed_obj_ids") or []):
            removed_at.append(f)
    return {
        "slot": slot,
        "frames_present": matched + lost,
        "matched_frames": matched,
        "lost_frames": lost,
        "reanchor_prompts": reanchors,
        "first_lost_frame": first_lost,
        "last_matched_frame": last_matched,
        "removed_at_frames": removed_at,
    }

#!/usr/bin/env python3
"""sam3_seed_quality.py — SAM3 seed-quality + track-persistence measurement for a
seeded player slot (ADAAAA-7287; gate for ADAAAA-7275).

Closes the gap in `measure_molmo2_ab.py`: the A/B driver computes detection
precision/recall and a per-class seed-IoU-vs-GT, but never runs the detector's
player seed box through the SAM3 backend, so it cannot report whether a seeded
player slot (`sam_player_box`) is KEPT across frames. This module supplies that
missing measure (today the detector reports `sam_player_box: null` / track lost
every frame per ADAAAA-7262 / ADAAAA-7243, so the ADAAAA-7275 go/no-go question
cannot be answered).

Given a detector arm's player seed box (normalized [x1,y1,x2,y2]), it wires the
seed box through the repo SAM3 backend — the perceive `HybridTracker` (see
`services/perceive/app/sam_tracker.py`) with the real `Sam3Backend` on the GPU
box, or a prompt-propagating stub in fixture mode, exactly as `measure_7219.py`
does — and reports, per frame:

  - seed IoU        : overlap of the detector's seed box vs the GT player box
  - sam_player_box  : the seeded player slot's current SAM box (None = lost)
  - slot_kept       : whether the seeded player slot was matched this frame
  - seeded          : whether the seed was adopted (guard-maintained)

and aggregates:

  - sampled seed IoU (mean / median)
  - sam_player_box_null_frames  (frames with NO seeded player box)
  - track persistence (onto / (onto + lost) for the selected seeded slot)
  - slot_kept_frames / window

The over-large-seed failure mode (ADAAAA-7262) is accounted for by the same
`is_plausible_player_seed_box` guard the perceive control handler uses: an
implausible seed box is rejected BEFORE seeding, so the slot reports
`sam_player_box=None` and `persistence=0.0` — the metric never silently tracks a
whole-frame scorebug box as if it were a player.

Fixture self-check (no GPU, CPU stub SAM):
    python3 evals/sam3_seed_quality.py --fixture

Run a detector arm's player seed box through SAM3 and report persistence:
    python3 evals/sam3_seed_quality.py \
        --seed-box 0.27,0.31,0.35,0.69 --gt-boxes evals/ab_eval_manifest.jsonl \
        --backend stub --out /tmp/sam3_seed_quality.json

GPU-box real-SAM run (requires perceive Sam3Backend / SAM3 triton session):
    PERCEIVE_TRACKER=florence_sam \
    python3 evals/sam3_seed_quality.py \
        --seed-box 0.27,0.31,0.35,0.69 --gt-boxes evals/ab_eval_manifest.jsonl \
        --backend real --clip <clip> --device cuda --out /tmp/sam3_seed_quality.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from statistics import median

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "services", "perceive"))

# Mirrors `app/player_id.py` (ADAAAA-7262): a seeded player box must be a tight,
# SAM3-trackable single-player box; a near-full-frame box (whose <OCR> reads the
# jersey number off a scorebug) must never become the seed target.
MAX_PLAYER_SEED_AREA = 0.30
MAX_PLAYER_SEED_SIDE = 0.70

DEFAULT_VOCAB = ["player", "soccer ball", "goalkeeper", "goal", "referee"]
ACCEPT_PERSIST = 0.90  # ADAAAA-7275 target for the seeded player slot


# --- pure helpers (stdlib-only so the fixture runs anywhere) ------------------

def iou(a, b):
    if not a or not b:
        return 0.0
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


def is_plausible_player_seed_box(bbox, max_area=MAX_PLAYER_SEED_AREA, max_side=MAX_PLAYER_SEED_SIDE):
    """True when a player seed box is a tight single-player box (the ADAAAA-7262
    guard). Mirrors `app.player_id.is_plausible_player_seed_box`; kept here so
    the fixture self-check runs without depending on the perceive package."""
    if not bbox or len(bbox) != 4:
        return False
    x1, y1, x2, y2 = (float(v) for v in bbox)
    w = max(0.0, x2 - x1)
    h = max(0.0, y2 - y1)
    if w > max_side or h > max_side:
        return False
    return w * h <= max_area


def _gt_box(row):
    """Return the normalized GT 'player' box from a manifest row (first player),
    else None."""
    for o in row.get("objects", []):
        lab = str(o.get("label", "")).strip().lower()
        if lab in ("player", "goalkeeper"):
            b = o.get("bbox")
            if b and len(b) == 4:
                return tuple(float(v) for v in b)
    return None


def load_gt_boxes(path):
    """Load per-frame GT player boxes from a JSONL manifest (one row per frame)."""
    rows = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return [ _gt_box(r) for r in rows ], rows


def _dummy_frame(w=64, h=64):
    import numpy as np
    return np.zeros((h, w, 3), dtype=np.uint8)


# --- SAM backend selection ----------------------------------------------------

class StubSamBackend:
    """Prompt-propagating stub (matches `measure_7219.StubSamBackend`): every
    seeded slot's box is carried forward each frame, modelling IDEAL SAM3
    propagation for the fixture without a GPU. `collapse_after` lets a caller
    emulate SAM losing a target after N frames (over-large-seed collapse)."""

    def __init__(self, collapse_after=None):
        self._cur = {}
        self._collapse_after = collapse_after
        self._frame = 0

    def ready(self):
        return True

    def advance(self, prompts):
        self._cur = dict(prompts)

    def get(self, slot):
        if self._collapse_after is not None:
            self._frame += 1
            if self._frame > self._collapse_after:
                return None
        return self._cur.get(slot)


def build_tracker(mode, capacity=8, clip=None, detect=None, backend=None):
    """Build the perceive HybridTracker used to run the seed box through SAM3.

    `mode == 'real'`  attempts the real `Sam3Backend` (GPU box, SAM3 triton
                      session); if it is not constructible (CPU / no session) a
                      stub is used and a warning is emitted.
    `mode == 'stub'`  a prompt-propagating stub (CPU fixture).
    """
    from app.sam_tracker import HybridTracker, make_tracker

    if mode == "real":
        try:
            if os.environ.get("PERCEIVE_TRACKER", "iou") != "florence_sam":
                os.environ["PERCEIVE_TRACKER"] = "florence_sam"
            tr = make_tracker(clip, capacity=capacity)
            from app.sam3_backend import Sam3Backend as _SB
            if isinstance(getattr(tr, "_backend", None), _SB):
                return tr, "real"
            print("[warn] real Sam3Backend not constructed; using stub SAM", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"[warn] could not build real Sam3Backend ({e}); using stub SAM", file=sys.stderr)
    return HybridTracker(backend=backend or StubSamBackend(), ball_label=None,
                         capacity=capacity, detect=detect), "stub"


# --- the measure --------------------------------------------------------------

def measure_seed_quality(seed_box, gt_boxes, mode="stub", capacity=8, clip=None,
                         frames_root="", rows=None, seed_label="player #9",
                         apply_guard=True, backend=None, collapse_after=None):
    """Run `seed_box` through the SAM3 backend across the eval frames.

    Args:
      seed_box:  normalized [x1,y1,x2,y2] detector player seed box (or None).
      gt_boxes:  per-frame normalized GT player box (or None when absent).
      mode:      'stub' (CPU fixture) or 'real' (GPU Sam3Backend).
      rows:      optional manifest rows (used only to read real frame paths).
      apply_guard: apply `is_plausible_player_seed_box` before seeding.

    Returns a dict with per-frame samples + aggregate seed-quality metrics.
    """
    n = len(gt_boxes)
    tr, used_backend = build_tracker(mode, capacity=capacity, clip=clip,
                                     backend=backend)
    plausible = is_plausible_player_seed_box(seed_box) if seed_box else False
    # A detector that never produced a player box that frame set the seed is the
    # "no seed" case -> slot absent.
    if seed_box is None or (apply_guard and not plausible):
        perframe = []
        for f in range(n):
            gt = gt_boxes[f]
            perframe.append({
                "frame": f, "seed_iou": iou(seed_box, gt) if seed_box and gt else None,
                "sam_player_box": None, "slot_kept": False, "seeded": False,
                "reason": "no_seed" if seed_box is None else "overlarge_seed_rejected",
            })
        return _aggregate(seed_box, perframe, tr, used_backend, plausible,
                          n, apply_guard, reason="no_seed" if seed_box is None else "overlarge_seed_rejected")

    slot = 1
    tr.seed(tuple(float(v) for v in seed_box), kind="player", label=seed_label,
            slot=slot, ts=0.0, selected=True)
    perframe = []
    for f in range(n):
        rgb = _dummy_frame()
        # read a real frame when the manifest provides one
        if rows and f < len(rows):
            from PIL import Image
            import numpy as np
            p = rows[f].get("image")
            if not p and frames_root:
                p = os.path.join(frames_root, "f%04d.png" % int(rows[f].get("frame", f)))
            if p and os.path.exists(p):
                rgb = np.asarray(Image.open(p).convert("RGB"))
        tr.step_frame(rgb, ts=float(f), florence_boxes=[], labels=[])
        trk = next((t for t in tr.tracks if t.slot == slot), None)
        # A slot is KEPT this frame only if it was matched (SAM emitted a box);
        # a lost frame keeps the IoU track's stale bbox but real SAM produced no
        # box, so report `sam_player_box` as None (the "track lost" signal that
        # ADAAAA-7262/7243 observe as `sam_player_box: null`).
        sam_box = None
        kept = False
        if trk is not None and trk.lost_frames == 0 and trk.bbox is not None:
            kept = True
            sam_box = tuple(float(v) for v in trk.bbox)
        gt = gt_boxes[f]
        perframe.append({
            "frame": f,
            "seed_iou": iou(seed_box, gt) if gt else None,
            "sam_player_box": sam_box,
            "slot_kept": kept,
            "seeded": True,
        })
    return _aggregate(seed_box, perframe, tr, used_backend, plausible,
                      n, apply_guard, reason="seeded")


def _aggregate(seed_box, perframe, tr, used_backend, plausible, n, apply_guard, reason):
    seed_iou_vals = [p["seed_iou"] for p in perframe if p["seed_iou"] is not None]
    kept_frames = sum(1 for p in perframe if p["slot_kept"])
    null_frames = sum(1 for p in perframe if p["sam_player_box"] is None)
    # track-level continuity for the selected seeded slot (matches measure_7219)
    track_acc = None
    if plausible and reason == "seeded":
        trk = next((t for t in tr.tracks if getattr(t, "selected", False)), None)
        if trk is not None:
            track_acc = trk.accuracy
    persistence = kept_frames / n if n else 0.0
    return {
        "seed_box": list(seed_box) if seed_box else None,
        "backend": used_backend,
        "guard_applied": apply_guard,
        "plausible_seed": plausible,
        "reason": reason,
        "frames": n,
        "seed_iou_mean": sum(seed_iou_vals) / len(seed_iou_vals) if seed_iou_vals else None,
        "seed_iou_median": median(seed_iou_vals) if seed_iou_vals else None,
        "seed_iou_sampled_frames": len(seed_iou_vals),
        "sam_player_box_null_frames": null_frames,
        "slot_kept_frames": kept_frames,
        "track_persistence": persistence,
        "track_accuracy": track_acc,
        "persistence_accept": persistence >= ACCEPT_PERSIST,
        "per_frame": perframe,
    }


def _print_report(r):
    print("=== SAM3 SEED-QUALITY + TRACK-PERSISTENCE (ADAAAA-7287) ===")
    print(f"seed box            : {r['seed_box']}")
    print(f"guard              : applied={r['guard_applied']} plausible={r['plausible_seed']} reason={r['reason']}")
    print(f"backend            : {r['backend']}  frames={r['frames']}")
    print(f"seed IoU mean/med  : {r['seed_iou_mean']} / {r['seed_iou_median']}  ({r['seed_iou_sampled_frames']} sampled)")
    print(f"sam_player_box null: {r['sam_player_box_null_frames']}/{r['frames']} frames")
    print(f"slot kept          : {r['slot_kept_frames']}/{r['frames']} frames")
    print(f"track persistence  : {r['track_persistence']*100:.1f}%  (track accuracy {r['track_accuracy']})  [>=90%]")
    print("OVERALL:", "PASS (persists)" if r["persistence_accept"] else "FAIL")


# --- fixture self-check -------------------------------------------------------

def fixture_self_check() -> int:
    """Self-check that the metric accounts for the over-large-seed failure mode.

    Case 1 (perfect seed): a tight, plausible player seed box that overlaps the GT
      box -> SAM holds the slot -> high seed IoU + high persistence.
    Case 2 (over-large seed, ADAAAA-7262): a near-full-frame seed box -> the guard
      rejects it (never seeded) -> sam_player_box None every frame, persistence 0.
    Case 3 (collapse if the over-large box WERE seeded): bypassing the guard and
      feeding the over-large box to a SAM backend that cannot propagate a
      whole-frame prompt loses the target -> persistence collapses (< 90%).
    """
    import numpy as np
    gt = [ (0.27, 0.31, 0.35, 0.69) for _ in range(10) ]  # 10-frame window
    perfect = (0.27, 0.31, 0.35, 0.69)     # tight, plausible, matches GT
    overlarge = (0.02, 0.02, 0.98, 0.85)   # near-full-frame (area ~0.84 > 0.30)

    ok = True
    # Case 1
    r1 = measure_seed_quality(perfect, gt, mode="stub")
    _print_report(r1)
    c1 = (r1["plausible_seed"] is True and r1["reason"] == "seeded"
          and r1["track_persistence"] >= ACCEPT_PERSIST
          and r1["seed_iou_mean"] is not None and r1["seed_iou_mean"] >= 0.90
          and r1["sam_player_box_null_frames"] == 0)
    print(f"  [fixture 1] perfect seed -> persists: {c1}")
    ok = ok and c1

    # Case 2
    r2 = measure_seed_quality(overlarge, gt, mode="stub")
    _print_report(r2)
    c2 = (r2["plausible_seed"] is False and r2["reason"] == "overlarge_seed_rejected"
          and r2["sam_player_box_null_frames"] == len(gt)
          and r2["track_persistence"] == 0.0
          and all(p["sam_player_box"] is None for p in r2["per_frame"]))
    print(f"  [fixture 2] over-large seed -> null/persistence 0: {c2}")
    ok = ok and c2

    # Case 3: over-large box WAS seeded (guard bypassed) into a SAM backend that
    # cannot propagate a whole-frame prompt -> persistence collapses.
    r3 = measure_seed_quality(overlarge, gt, mode="stub", apply_guard=False,
                              backend=StubSamBackend(collapse_after=2))
    _print_report(r3)
    c3 = (r3["reason"] == "seeded" and r3["track_persistence"] < ACCEPT_PERSIST
          and r3["sam_player_box_null_frames"] > 0
          and sum(1 for p in r3["per_frame"] if p["slot_kept"]) < len(gt))
    print(f"  [fixture 3] seeded over-large box -> persistence collapse: {c3}")
    ok = ok and c3

    print("\nFIXTURE:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="SAM3 seed-quality + track-persistence for a seeded player slot (ADAAAA-7287)")
    ap.add_argument("--fixture", action="store_true", help="run the built-in fixture self-check (CPU stub; no GPU)")
    ap.add_argument("--seed-box", default=None, help="detector player seed box as x1,y1,x2,y2 (normalized)")
    ap.add_argument("--gt-boxes", default=None, help="JSONL manifest with per-frame GT player objects")
    ap.add_argument("--frames-root", default="", help="real frame dir (fNNNN.png) when the manifest refers to frames")
    ap.add_argument("--backend", choices=["stub", "real"], default="stub")
    ap.add_argument("--clip", default=None, help="clip path binding the real SAM3 session (backend=real)")
    ap.add_argument("--mode", choices=["live", "vod"], default="vod")
    ap.add_argument("--capacity", type=int, default=8)
    ap.add_argument("--no-guard", action="store_true", help="seed the box even if implausible (demonstrate collapse)")
    ap.add_argument("--out", default=None, help="write the JSON report here")
    args = ap.parse_args()

    if args.fixture:
        rc = fixture_self_check()
    else:
        if not args.seed_box or not args.gt_boxes:
            print("ERROR: provide --seed-box + --gt-boxes (or use --fixture)", file=sys.stderr)
            return 2
        seed = tuple(float(v) for v in args.seed_box.split(","))
        if len(seed) != 4:
            print("ERROR: --seed-box must be x1,y1,x2,y2", file=sys.stderr)
            return 2
        gt_boxes, rows = load_gt_boxes(args.gt_boxes)
        r = measure_seed_quality(seed, gt_boxes, mode=args.backend,
                                 capacity=(3 if args.mode == "live" else args.capacity),
                                 clip=args.clip, frames_root=args.frames_root,
                                 rows=rows, apply_guard=not args.no_guard)
        if args.out:
            with open(args.out, "w") as fh:
                json.dump(r, fh, indent=2, default=str)
            print(f"[info] report written: {args.out}")
        _print_report(r)
        rc = 0 if r["persistence_accept"] else 1
    return rc


if __name__ == "__main__":
    sys.exit(main())

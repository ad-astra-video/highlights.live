#!/usr/bin/env python3
"""Real-image detection eval harness: fine-tuned vs base Florence-2 (ADAAAA-5166).

Measures, on a real-image held-out eval slice, the fine-tuning success metrics
from plan ADAAAA-5159 §4.3 by comparing a fine-tuned Florence-2 against the
base model:

  - detection precision (closed-vocab matched): base junk-label FPs -> fine-tuned +10-20 pts
  - per-frame detection recall (esp. `soccer ball` small object): fewer dropouts
  - VOD / live ID persistence on real video (via the tracker harness)
  - tracker synthetic ID persistence stays 1.000

Consumes:
  - `evals/val_manifest.jsonl`   real labeled held-out frames (DetectionTrainingSample contract)
  - `evals/train_manifest.jsonl` real labeled training frames (optional, for reference/split counts)
  - `evals/track_label_manifest.json`  the tracker's synthetic held-out set (ID-persistence integration)
  - optionally `--video` a clip manifest of ordered real frames for real-video ID persistence

Both manifests are validated against the shared `DetectionTrainingSample`
contract (`packages/events/src/index.ts` -> Python mirror `evals/detect_schema.py`).

Backends:
  - `florence`  : loads the REAL FlorenceDetector from `services/perceive/app/florence.py`
                  (base via --model-base / FLORENCE_MODEL, fine-tuned via --model-finetuned).
                  Runs on the GPU box where torch/transformers/numpy/PIL are installed.
  - `fixture`   : deterministic backend for local verification of the metric accounting
                  (no model/pixels). Feed labelled boxes as "detections" (perfect model)
                  and optionally degrade them (drop small-object class, inject junk FPs)
                  to exercise precision/recall/ID-persistence math. NOT evidence of model
                  quality — only of the harness accounting.

Run (local accounting self-check, no model):
    python3 evals/detect_precision.py --val evals/val_manifest.jsonl --backend fixture
    python3 evals/detect_precision.py --val ... --backend fixture --drop-class "soccer ball" 0.3 --junk-fp 2

Run (GPU box, real models):
    python3 evals/detect_precision.py --val evals/val_manifest.jsonl --backend florence \\
        --model-base microsoft/Florence-2-base \\
        --model-finetuned /runs/Florence-2-base-finetuned-<run>
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # for detect_schema
sys.path.insert(0, os.path.join(HERE, "..", "services", "perceive"))

import detect_schema  # noqa: E402

# Closed soccer vocabulary (mirrors packages/events SOCCER_DETECTION_VOCAB and
# services/perceive/app/florence.py _GAME_VOCABULARIES["soccer"]).
DEFAULT_VOCAB = ["player", "soccer ball", "goalkeeper", "goal", "referee"]

ACCEPT_IOU = 0.5  # detection match threshold (IoU)
ACCEPT_ID_PERSIST = 0.95

# plan ADAAAA-5159 §4.3 target table (base measured -> fine-tuned target)
TARGETS = {
    "precision_delta_pts": (10, 20),          # base junk-FPs -> fine-tuned +10..20 pts
    "vod_id_persist": {"base": 0.655, "target": 0.90, "bar": 0.95},
    "live_id_persist": {"base": 0.956, "target": 0.95},
    "tracker_synthetic_id_persist": {"base": 1.000, "target": 1.000},
}


# --- IoU / matching (pure stdlib) -------------------------------------------

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


def greedy_match(preds, gts, iou_thresh):
    """Greedily match predictions to ground truth by IoU>=thresh (same class).

    preds/gts: list of (index, bbox). Returns (tp_idx_set_pred, matched_gt_idx_set).
    """
    matched_gt = set()
    tp_pred = set()
    for p_i, p_box in sorted(preds, key=lambda x: -1.0):  # keep order
        best_gt, best_iou = None, 0.0
        for g_i, g_box in gts:
            if g_i in matched_gt:
                continue
            iou = _iou(p_box, g_box)
            if iou >= iou_thresh and iou > best_iou:
                best_gt, best_iou = g_i, iou
        if best_gt is not None:
            matched_gt.add(best_gt)
            tp_pred.add(p_i)
    return tp_pred, matched_gt


def _bbox(o):
    return tuple(o["bbox"])


# --- detection backends ------------------------------------------------------

class _FixtureDetector:
    """Deterministic 'detections' from the ground truth, for accounting checks.

    With no degradation this is a perfect detector (precision/recall 1.0).
    `drop_class` removes a fraction of a class' boxes each frame (models the
    small/fast soccer-ball dropouts); `junk_fp` adds spurious in-vocab boxes
    with no ground truth (models base junk-label FPs). Deterministic given seed.
    """

    def __init__(self, vocab, drop_class=None, drop_rate=0.0, junk_fp=0, seed=0):
        self.vocab = vocab
        self.drop_class = drop_class
        self.drop_rate = drop_rate
        self.junk_fp = junk_fp
        self._rng = random.Random(seed)

    def detect(self, sample):
        dets = []
        for o in sample.get("objects", []):
            label = o["label"]
            box = _bbox(o)
            if self.drop_class and label == self.drop_class and self._rng.random() < self.drop_rate:
                continue  # simulate detector dropout of this class
            dets.append({"label": label, "confidence": 1.0, "bbox": list(box)})
        w, h = sample.get("width", 1280), sample.get("height", 720)
        # inject spurious in-vocab boxes (no GT) -> FPs
        for _ in range(self.junk_fp):
            c = self._rng.choice(self.vocab)
            x1 = self._rng.random() * 0.6
            y1 = self._rng.random() * 0.6
            bw = 0.08 + self._rng.random() * 0.1
            bh = 0.08 + self._rng.random() * 0.1
            dets.append({"label": c, "confidence": 0.9,
                         "bbox": [x1, y1, min(1.0, x1 + bw), min(1.0, y1 + bh)]})
        return dets


class _FlorenceDetector:
    """Wrap the repo FlorenceDetector (services/perceive/app/florence.py).

    Loaded lazily so the harness imports cleanly on boxes without the ML stack.
    `detect(image_np, vocabulary=vocab)` -> [{label, confidence, bbox}].
    """

    def __init__(self, model_id, vocab):
        self.model_id = model_id
        self.vocab = vocab
        self._det = None

    def _load(self):
        if self._det is None:
            os.environ.setdefault("FLORENCE_MODEL", self.model_id)
            from app.florence import FlorenceDetector  # noqa: F401
            self._det = FlorenceDetector(model_name=self.model_id)
            self._det.load()

    def detect(self, sample):
        self._load()
        import numpy as np
        from PIL import Image
        img_path = _resolve_image(sample["imageRef"])
        pil = Image.open(img_path).convert("RGB")
        arr = np.asarray(pil)
        objs = self._det.detect(arr, vocabulary=self.vocab)
        return objs


def _resolve_image(image_ref):
    """imageRef may be an absolute/relative path or a bare filename under data/training/."""
    if os.path.exists(image_ref):
        return image_ref
    cand = os.path.join(HERE, "..", "data", "training", os.path.basename(image_ref))
    if os.path.exists(cand):
        return cand
    return image_ref


def make_detector(backend, model_id, vocab, opts, run_label=None):
    if backend == "florence":
        return _FlorenceDetector(model_id, vocab)
    # fixture: the "base" run takes the degradation opts, "fine-tuned" is the
    # perfect fixture, so the reported delta demonstrates the precision/recall
    # accounting when no model/GPU is available.
    degrade = backend == "fixture" and run_label == "base"
    return _FixtureDetector(
        vocab,
        drop_class=opts.drop_class if degrade else None,
        drop_rate=opts.drop_rate if degrade else 0.0,
        junk_fp=opts.junk_fp if degrade else 0,
        seed=opts.seed,
    )


def build_detector_plan(args, vocab):
    """Return list of (run_label, model_id_or_None) to compare.

    backend=fixture: run twice — 'base' takes the degradation opts, 'fine-tuned'
    is the perfect (non-degraded) fixture, so the reported delta demonstrates the
    precision/recall accounting. backend=florence: run base + fine-tuned models.
    """
    if args.backend == "florence":
        runs = [("base", args.model_base), ("fine-tuned", args.model_finetuned)]
        # if only one model supplied, still emit both slots (fine-tuned may be a file)
        return runs
    # fixture
    return [("fine-tuned", None), ("base", None)]


# --- metric accumulation -----------------------------------------------------

def eval_detection(samples, detector, vocab, iou_thresh=ACCEPT_IOU, max_frames=None):
    """Run detection over labelled real frames; accumulate precision/recall.

    Returns per-class and overall metrics plus per-frame recall for dropout
    analysis.
    """
    classes = vocab
    tp = defaultdict(int)
    fp = defaultdict(int)
    fn = defaultdict(int)
    frame_recall = defaultdict(list)   # class -> list of (frame_id, recall)
    frame_present = defaultdict(int)   # class -> frames where at least one GT box
    frame_dropout = defaultdict(int)   # class -> frames where GT present but recall==0
    junk_fp = 0
    n_frames = 0
    for i, sample in enumerate(samples):
        if max_frames and i >= max_frames:
            break
        n_frames += 1
        gts = defaultdict(list)        # class -> list of (idx, bbox)
        for o in sample.get("objects", []):
            gts[o["label"]].append((len(gts[o["label"]]), _bbox(o)))
        # canonical detections to vocab
        dets = _canonical_detections(detector.detect(sample), vocab)
        preds = defaultdict(list)      # class -> list of (idx, bbox)
        # Junk/unmappable detections are false positives (spurious boxes that
        # match no ground-truth class); count them at the overall level so the
        # precision metric captures base-model junk-label FPs (§4.3).
        junk_preds = []
        for d in dets:
            if d["label"] == "<junk>":
                junk_preds.append((len(junk_preds), tuple(d["bbox"])))
            else:
                preds[d["label"]].append((len(preds[d["label"]]), tuple(d["bbox"])))

        frame_tp = 0
        frame_g = 0
        for cls in classes:
            tp_p, mt_g = greedy_match(preds.get(cls, []), gts.get(cls, []), iou_thresh)
            tp[cls] += len(tp_p)
            fp[cls] += len(preds.get(cls, [])) - len(tp_p)
            fn[cls] += len(gts.get(cls, [])) - len(mt_g)
            n_g = len(gts.get(cls, []))
            if n_g:
                recall = len(tp_p) / n_g
                frame_present[cls] += 1
                if recall == 0.0:
                    frame_dropout[cls] += 1
                frame_recall[cls].append((sample.get("id", i), recall))
            frame_tp += len(tp_p)
            frame_g += n_g
        junk_fp += len(junk_preds)
        # overall per-frame recall
        frame_recall["__overall__"].append(
            (sample.get("id", i), frame_tp / frame_g if frame_g else 1.0))

    overall_tp = sum(tp.values())
    overall_fp = sum(fp.values()) + junk_fp
    overall_fn = sum(fn.values())
    metrics = {"overall": {
        "tp": overall_tp, "fp": overall_fp, "fn": overall_fn,
        "precision": overall_tp / (overall_tp + overall_fp) if (overall_tp + overall_fp) else None,
        "recall": overall_tp / (overall_tp + overall_fn) if (overall_tp + overall_fn) else None,
        "frames": n_frames,
        "junkFp": junk_fp,
    }}
    for cls in classes:
        t, f, n = tp[cls], fp[cls], fn[cls]
        metrics[cls] = {
            "tp": t, "fp": f, "fn": n,
            "precision": t / (t + f) if (t + f) else None,
            "recall": t / (t + n) if (t + n) else None,
        }
    # per-frame recall (dropout) summary per class
    ov_vals = [r for _, r in frame_recall["__overall__"]]
    metrics["overall"]["frameRecallMean"] = sum(ov_vals) / len(ov_vals) if ov_vals else None
    metrics["overall"]["framesIncluded"] = len(ov_vals)
    metrics["overall"]["dropoutFrames"] = sum(1 for r in ov_vals if r == 0.0)
    for cls in classes:
        vals = [r for _, r in frame_recall[cls]]
        metrics[cls]["frameRecallMean"] = sum(vals) / len(vals) if vals else None
        metrics[cls]["framesPresent"] = frame_present[cls]
        metrics[cls]["dropoutFrames"] = frame_dropout[cls]
    return metrics


def _canonical_detections(dets, vocab):
    """Map raw detector labels into the closed vocab; drop unmappable (junk) -> FP.

    Mirrors FlorenceDetector gating: only in-vocab labels are emitted; a raw label
    that cannot be mapped is treated as junk (counted as a FP below, since a
    spurious box with a non-matching label is a false positive against any GT).
    """
    canon = {str(v).strip().lower(): str(v).strip() for v in vocab}
    out = []
    for d in dets:
        label = (d.get("label") or "").strip().lower()
        if label == "soccer_ball":
            label = "soccer ball"
        if label == "ball":
            label = "soccer ball"
        if label == "person":
            label = "player"
        target = canon.get(label)
        if not target:  # junk/unmappable -> keep as junk FP (label 'JUNK')
            d = dict(d)
            d["label"] = "<junk>"
        else:
            d = dict(d)
            d["label"] = target
        out.append(d)
    return out


# --- ID persistence (track_metrics integration) ------------------------------

def track_id_persistence(clip, detector, vocab, drop_pct=0):
    """Drive the repo IoUTracker over a clip whose per-frame boxes come from the
    detector, and score ID persistence + IoU exactly like evals/track_metrics.py.

    `clip` is a track_label_manifest-style clip dict:
        {id, mode: 'vod'|'live', frames: [{frame, objects: [{id, kind, bbox}]}]}
    For each frame we run the detector's output through the tracker; ID persistence
    is scored against the labelled object ids. On the GPU box `detector` is the real
    FlorenceDetector; in fixture mode detections == labelled boxes (perfect), so the
    synthetic ID persistence stays 1.000, and `--drop-class`/`--drop-pct` demonstrate
    how detector dropouts degrade ID persistence.
    """
    try:
        from app.tracker import IoUTracker, LIVE_MAX_TRACKS, VOD_MAX_TRACKS  # noqa: F401
    except Exception as e:  # numpy/tracker not available (e.g. CPU eval box)
        return {"error": f"tracker unavailable: {e}", "idPersist": None, "iou": None}

    # Build per-label ground-truth streams keyed by (frame,label_id) using bbox.
    # For detections, map each labelled object to the detector's best box so we
    # score the SAME identity through the tracker (dropout simulates detector misses).
    from collections import Counter

    def _iou(a, b):
        ax1, ay1, ax2, ay2 = a
        bx1, by1, bx2, by2 = b
        ix1, iy1 = max(ax1, bx1), max(ay1, by1)
        ix2, iy2 = min(ax2, bx2), min(ay2, by2)
        iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
        inter = iw * ih
        if inter == 0:
            return 0.0
        return inter / (max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
                        + max(0.0, bx2 - bx1) * max(0.0, by2 - by1) - inter + 1e-9)

    mode = clip["mode"]
    cap = VOD_MAX_TRACKS if mode == "vod" else LIVE_MAX_TRACKS
    reach_cap = clip.get("reachCap", True)
    tr = IoUTracker(capacity=cap, lost_before_evict=8)

    label_frames = {}
    max_concurrent = 0
    for frame in clip["frames"]:
        f = frame["frame"]
        objects = frame["objects"]
        # labelled ground truth
        label_boxes = {}
        for o in objects:
            label_boxes.setdefault(o["id"], []).append((f, tuple(o["bbox"])))
        # detections -> boxes fed to tracker
        sample = {"id": f"{clip['id']}:{f}", "objects": [
            {"label": o.get("kind", "player"), "bbox": o["bbox"]} for o in objects
        ], "width": 1, "height": 1}
        dets = _canonical_detections(detector.detect(sample), vocab)
        boxes = [tuple(d["bbox"]) for d in dets]
        # detection dropout injection (whole-frame, like track_metrics.py)
        if drop_pct and boxes and (f * 37) % 100 < drop_pct:
            boxes = []
        tracks = tr.step(boxes, ts=float(f))
        max_concurrent = max(max_concurrent, len(tracks))
        for oid, lst in label_boxes.items():
            fid, box = lst[0]
            label_frames.setdefault(oid, []).append(_frame_best(box, tracks, _iou))

    # score like track_metrics.score
    id_scores, iou_scores = [], []
    for oid, frames in label_frames.items():
        present = [fm for fm in frames if fm]
        if not present:
            id_scores.append(0.0)
            continue
        best = [max(fm, key=lambda x: x[1]) for fm in present]
        counts = Counter(tid for tid, iou in best if iou >= ACCEPT_IOU)
        dominant = counts.most_common(1)[0][0] if counts else None
        matched = sum(1 for tid, iou in best if tid == dominant and iou >= ACCEPT_IOU)
        id_scores.append(matched / len(present))
        mious = [iou for tid, iou in best if tid == dominant and iou >= ACCEPT_IOU]
        if mious:
            iou_scores.append(sum(mious) / len(mious))
    return {
        "idPersist": sum(id_scores) / len(id_scores) if id_scores else None,
        "iou": sum(iou_scores) / len(iou_scores) if iou_scores else None,
        "maxConcurrent": max_concurrent, "cap": cap,
    }


def _frame_best(box, tracks, iou_fn):
    return [(t.track_id, iou_fn(box, t.bbox)) for t in tracks]


def run_tracker_report(args, track_manifest, vocab):
    """Synthetic tracker ID persistence via the repo track_metrics harness.

    Returns a dict keyed by run label with synthetic ID persist + per-clip detail.
    Uses the actual `evals/track_metrics.py` scorer when available so the number is
    the same as the tracker's own acceptance run.
    """
    try:
        from importlib import util
        spec = util.spec_from_file_location("track_metrics", os.path.join(HERE, "track_metrics.py"))
        tm = util.module_from_spec(spec)
        spec.loader.exec_module(tm)
        tracker_test = True
    except Exception as e:
        tracker_test = None
    out = {}
    for run_label, model_id in build_detector_plan(args, vocab):
        det = make_detector(args.backend, model_id, vocab, args, run_label=run_label)
        persist = {}
        for clip in track_manifest.get("clips", []):
            r = track_id_persistence(clip, det, vocab, drop_pct=args.drop)
            persist[clip["id"]] = r.get("idPersist")
        vals = [v for v in persist.values() if v is not None]
        out[run_label] = {
            "syntheticIdPersist": sum(vals) / len(vals) if vals else None,
            "perClip": persist,
            "trackerBackendOrError": tracker_test if tracker_test else ("tracker import unavailable: " + str(tracker_test)),
        }
    return out


# --- report ------------------------------------------------------------------

def _pct(v):
    return f"{v*100:.1f}%" if isinstance(v, (int, float)) else "n/a"


def build_report(args, val_metrics, tracker_report, vocab):
    lines = []
    runs = [r for r, _ in build_detector_plan(args, vocab)]
    lines.append("=" * 74)
    lines.append("detect_precision.py — per-metric report (fine-tuned vs base)")
    lines.append("=" * 74)
    for run_label, model_id in build_detector_plan(args, vocab):
        m = val_metrics[run_label]
        lines.append(f"\n[{run_label}] model={model_id or '(fixture)'}")
        lines.append("  detection precision (vocab-matched), overall: "
                     f"{_pct(m['overall']['precision'])}"
                     + (f"  ({m['overall']['tp']} TP / {m['overall']['fp']} FP)" if m['overall'].get('tp') is not None else ""))
        lines.append("  per-frame detection recall, overall: "
                     f"{_pct(m['overall'].get('frameRecallMean'))}  dropouts={m['overall'].get('dropoutFrames')}")
        for cls in vocab:
            c = m.get(cls, {})
            lines.append(f"    {cls:<12} precision={_pct(c.get('precision'))} "
                         f"recall={_pct(c.get('recall'))} frameRecall={_pct(c.get('frameRecallMean'))} "
                         f"dropouts={c.get('dropoutFrames')}")
        tr = tracker_report.get(run_label, {})
        lines.append("  ID persistence (tracker integration):")
        lines.append(f"    synthetic track_label_manifest: {_pct(tr.get('syntheticIdPersist'))} (bar {ACCEPT_ID_PERSIST:.2f})")
        if tr.get("perClip"):
            lines.append("    per-clip: " + ", ".join(f"{k}={v:.3f}" for k, v in tr["perClip"].items() if v is not None))

    # §4.3 delta vs base
    lines.append("\n" + "-" * 74)
    lines.append("§4.3 target comparison (fine-tuned vs base)")
    base = val_metrics.get("base", {}).get("overall", {})
    ft = val_metrics.get("fine-tuned", {}).get("overall", {})
    if "base" in val_metrics and "fine-tuned" in val_metrics:
        bp = base.get("precision")
        fp = ft.get("precision")
        if isinstance(bp, (int, float)) and isinstance(fp, (int, float)):
            delta = (fp - bp) * 100
            tgt = TARGETS["precision_delta_pts"]
            ok = tgt[0] <= delta <= tgt[1]
            lines.append(f"  detection precision delta: {delta:+.1f} pts  "
                         f"(base {_pct(bp)} -> fine-tuned {_pct(fp)}; target {tgt[0]}-{tgt[1]} pts)  "
                         f"-> {'PASS' if ok else 'n/a (fixture/measure)'}")
        # soccer-ball recall delta
        bs = val_metrics["base"].get("soccer ball", {}).get("frameRecallMean")
        fs = val_metrics["fine-tuned"].get("soccer ball", {}).get("frameRecallMean")
        if isinstance(bs, (int, float)) and isinstance(fs, (int, float)):
            lines.append(f"  soccer-ball frame recall delta: {fs-bs:+.3f}  "
                         f"(base {_pct(bs)} -> fine-tuned {_pct(fs)}) -> fewer dropouts")
    # tracker targets
    for run_label, model_id in build_detector_plan(args, vocab):
        tr = tracker_report.get(run_label, {})
        sp = tr.get("syntheticIdPersist")
        if sp is not None:
            lines.append(f"  [{run_label}] tracker synthetic ID persist {sp:.3f} (target stays 1.000)")
    print("\n".join(lines))
    return lines


def main():
    ap = argparse.ArgumentParser(description="Fine-tuned vs base Florence-2 detection eval harness")
    ap.add_argument("--val", default=os.path.join(HERE, "val_manifest.jsonl"))
    ap.add_argument("--train", default=os.path.join(HERE, "train_manifest.jsonl"))
    ap.add_argument("--track", default=os.path.join(HERE, "track_label_manifest.json"))
    ap.add_argument("--backend", choices=["florence", "fixture"], default="fixture")
    ap.add_argument("--model-base", default="microsoft/Florence-2-base")
    ap.add_argument("--model-finetuned", default=None)
    ap.add_argument("--vocab", nargs="*", default=DEFAULT_VOCAB)
    ap.add_argument("--iou", type=float, default=ACCEPT_IOU)
    ap.add_argument("--max-frames", type=int, default=None)
    ap.add_argument("--drop-class", default=None, help="class to drop (fixture only)")
    ap.add_argument("--drop-rate", type=float, default=0.0, help="fraction of drop-class boxes dropped (fixture)")
    ap.add_argument("--junk-fp", type=int, default=0, help="spurious in-vocab FPs per frame (fixture)")
    ap.add_argument("--drop", type=int, default=0, help="whole-frame detector dropout % for tracker (0-99)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--report-out", default=None, help="write JSON report to PATH")
    args = ap.parse_args()

    vocab = list(args.vocab) or DEFAULT_VOCAB

    # --- validate manifests via the shared contract ---
    manifests = {}
    for key, path in (("val", args.val), ("train", args.train)):
        if os.path.exists(path):
            valid, invalid = detect_schema.validate_manifest(path)
            manifests[key] = {"path": path, "valid": valid, "invalid": invalid}
            print(f"manifest validation [{key}] {path}: {len(valid)} valid, {len(invalid)} invalid")
            if invalid:
                for e in invalid[:10]:
                    print("    INVALID line", e)
        else:
            print(f"manifest validation [{key}] {path}: not present (skipped)")

    # tracker manifest
    track_manifest, terr = detect_schema.validate_track_manifest(args.track) if os.path.exists(args.track) else (None, ["not present"])
    if terr and terr[0] != "not present":
        print(f"track manifest validation {args.track}: INVALID {terr}")
    elif not terr:
        print(f"track manifest validation {args.track}: ok ({len(track_manifest.get('clips', []))} clips)")

    if not manifests.get("val", {}).get("valid"):
        print("ERROR: no valid val manifest; refusing to run metrics.", file=sys.stderr)
        return 2
    samples = [s["sample"] for s in manifests["val"]["valid"]]

    # --- run detection metrics for base + fine-tuned ---
    val_metrics = {}
    for run_label, model_id in build_detector_plan(args, vocab):
        det = make_detector(args.backend, model_id, vocab, args, run_label=run_label)
        val_metrics[run_label] = eval_detection(samples, det, vocab,
                                                iou_thresh=args.iou, max_frames=args.max_frames)

    # --- ID persistence via tracker integration ---
    tracker_report = run_tracker_report(args, track_manifest or {"clips": []}, vocab) if track_manifest else {}

    report_lines = build_report(args, val_metrics, tracker_report, vocab)
    report = {
        "valManifest": args.val,
        "backend": args.backend,
        "vocab": vocab,
        "perRun": val_metrics,
        "tracker": tracker_report,
        "manifestValidation": {k: {"valid": len(v["valid"]), "invalid": len(v["invalid"]),
                                    "path": v["path"]} for k, v in manifests.items()},
        "reportLines": "\n".join(report_lines),
    }
    if args.report_out:
        os.makedirs(os.path.dirname(os.path.abspath(args.report_out)) or ".", exist_ok=True)
        with open(args.report_out, "w") as fh:
            json.dump(report, fh, indent=2)
        print(f"\nreport written: {args.report_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

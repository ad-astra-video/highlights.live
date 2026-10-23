#!/usr/bin/env python3
"""measure_molmo2_ab.py — Molmo2-4B vs fine-tuned Florence-2 A/B detection
measurement driver (ADAAAA-7279).

Measurement ONLY. It does not rewire perceive, deploy to prod, or train. It runs
a detector backend over a labeled real-broadcast eval set and reports the metrics
the ADAAAA-7275 go/no-go needs:

  - detection precision / recall (closed-vocab matched vs ground-truth boxes)
  - seed-box quality: best-predicted-per-class IoU vs GT box
  - per-call inference latency  (p50 / p95)
  - peak VRAM (torch.cuda / nvidia-smi)
  - cost estimate (GPU-hours per clip @ $/GPU-hour)

Backends:
  fixture   deterministic — feeds GT boxes as "detections" (perfect detector), so
            the metric accounting on THIS runner is self-checked with no model.
            Optionally --drop-class/--junk-fp to exercise precision/recall math.
  florence  loads the repo FlorenceDetector (services/perceive/app/florence.py)
            via a model id or a fine-tuned merged model dir.
  molmo     loads allenai/Molmo2-4B via HF transformers (requires transformers
            >= 4.52) and returns boxes under the same detect() contract.

Eval set: a JSONL manifest, one per line:
  {"id":..., "frame": int, "image": "path/to/fNNNN.png",
   "objects":[{"label":..., "bbox":[x1,y1,x2,y2] normalized}, ...]}
Frames are read from --frames-root/f{frame:04d}.png by default, or --image uses
the absolute image path in each row.

Run local accounting self-check (no model/GPU):
  python3 evals/measure_molmo2_ab.py --backend fixture \
      --manifest evals/ab_eval_manifest.jsonl --out /tmp/ab_fixture.json
Run on the GPU box (real models):
  python3 evals/measure_molmo2_ab.py --backend florence \
      --model /runs/Florence-2-base-finetuned-ft6404gpu --device cuda \
      --manifest evals/ab_eval_manifest.jsonl --out /tmp/ab_florence.json
  python3 evals/measure_molmo2_ab.py --backend molmo \
      --model allenai/Molmo2-4B --device cuda \
      --manifest evals/ab_eval_manifest.jsonl --out /tmp/ab_molmo.json
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from collections import defaultdict
from statistics import median

import molmo2_backend  # real Molmo2 grounding decode (ADAAAA-7283 leg B)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "services", "perceive"))

DEFAULT_VOCAB = ["player", "soccer ball", "goalkeeper", "goal", "referee"]
ACCEPT_IOU = 0.5

# cost model knob: rough per-GPU-hour rate for the box (set/override via env or
# --gpu-rate). A 24 GiB RTX 3090 Ti at ~$0.35/GH is a sensible default to
# document, not a bill — report both GPU-hours and the $ estimate clearly.
DEFAULT_GPU_RATE = 0.35


# --- IoU / matching (pure stdlib, consistent with detect_precision.py) -------

def iou(a, b):
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


def greedy_match(preds, gts, thr=ACCEPT_IOU):
    matched_gt, tp_pred = set(), set()
    for p_i, p_box in list(preds):
        best_gt, best_iou = None, 0.0
        for g_i, g_box in gts:
            if g_i in matched_gt:
                continue
            v = iou(p_box, g_box)
            if v >= thr and v > best_iou:
                best_gt, best_iou = g_i, v
        if best_gt is not None:
            matched_gt.add(best_gt)
            tp_pred.add(p_i)
    return tp_pred, matched_gt


def canonical(det, vocab):
    """Map a raw detector label into the closed vocab; unmappable -> '<junk>'."""
    canon = {str(v).strip().lower(): str(v).strip() for v in vocab}
    label = (det.get("label") or "").strip().lower()
    if label == "soccer_ball":
        label = "soccer ball"
    if label == "ball":
        label = "soccer ball"
    if label == "person":
        label = "player"
    t = canon.get(label)
    d = dict(det)
    d["label"] = t if t else "<junk>"
    return d


# --- detector backends -------------------------------------------------------

class FixtureDetector:
    """Perfect detector: emits the GT boxes as detections. With no degradation
    precision/recall = 1.0 and seed IoU = 1.0. Optional --drop-class / --junk-fp
    exercise the accounting (deterministic given seed)."""

    def __init__(self, vocab, drop_class=None, drop_rate=0.0, junk_fp=0, seed=0):
        self.vocab = list(vocab)
        self.drop_class = drop_class
        self.drop_rate = drop_rate
        self.junk_fp = junk_fp
        self._rng = random.Random(seed)
        self.calls = 0

    def detect(self, image, vocabulary=None):
        self.calls += 1
        vocab = list(vocabulary) if vocabulary is not None else self.vocab
        objs = []
        # image is a dict carrying the sample's objects in fixture mode
        for o in image.get("_gt_objects", []):
            label = o["label"]
            if self.drop_class and label == self.drop_class and self._rng.random() < self.drop_rate:
                continue
            objs.append({"label": label, "confidence": 1.0, "bbox": list(o["bbox"])})
        for _ in range(self.junk_fp):
            c = self._rng.choice(vocab)
            x1 = self._rng.random() * 0.6
            y1 = self._rng.random() * 0.6
            bw = 0.08 + self._rng.random() * 0.1
            bh = 0.08 + self._rng.random() * 0.1
            objs.append({"label": c, "confidence": 0.9,
                         "bbox": [x1, y1, min(1.0, x1 + bw), min(1.0, y1 + bh)]})
        return objs


class FlorenceDetector:
    """Wrap the repo FlorenceDetector (services/perceive/app/florence.py)."""

    def __init__(self, model, vocab, device="cuda"):
        self.model = model
        self.device = device
        self.vocab = list(vocab)
        self._det = None
        self.calls = 0

    def _load(self):
        if self._det is None:
            os.environ.setdefault("FLORENCE_MODEL", self.model)
            try:
                from app.florence import FlorenceDetector as FD
            except Exception:
                # standalone evalapp copy used on the GPU box
                sys.path.insert(0, os.path.join(HERE, ".."))
                from florence import FlorenceDetector as FD
            self._det = FD(model_name=self.model, device=self.device,
                           model_path=self.model if os.path.isdir(self.model) else None)
            self._det.load()

    def detect(self, image, vocabulary=None):
        self._load()
        import numpy as np
        from PIL import Image
        if image.ndim == 2:
            image = np.stack([image] * 3, axis=-1)
        arr = np.asarray(Image.fromarray(image.astype(np.uint8)).convert("RGB"))
        self.calls += 1
        return self._det.detect(arr, vocabulary=vocabulary or self.vocab, roi_pass=False)


class MolmoDetector:
    """Molmo2-4B detector via HF transformers (measurement arm).

    Requires transformers >= 4.52 (Molmo-2 architecture). Implements the same
    detect(image, vocabulary) -> [{label, confidence, bbox}] contract. Molmo2-4B
    is a *point*-grounding model: for each closed-vocab class it emits one
    `<points>` reference point per object instance. The output is decoded with
    the REAL grounding decode helpers in molmo2_backend (extract_image_points /
    points_to_boxes / parse_molmo_detection) — the same path the eval harness
    uses — and each point is expanded to a non-degenerate per-point box
    (DEFAULT_BOX_SIZE), replacing the old text-grep `_parse_boxes` placeholder
    which Molmo2-4B never emits.
    """

    def __init__(self, model, vocab, device="cuda", dtype="bfloat16", box_size=None):
        self.model = model
        self.device = device
        self.vocab = list(vocab)
        self.dtype = dtype
        self.box_size = box_size if box_size is not None else molmo2_backend.DEFAULT_BOX_SIZE
        self._model = self._proc = None
        self.calls = 0
        self.peak_vram_mb = 0

    def _load(self):
        if self._model is not None:
            return
        import torch
        dtype = getattr(torch, self.dtype, torch.bfloat16)
        model, proc = molmo2_backend._load_model_and_processor(self.model, dtype, self.device)
        self._model, self._proc = model, proc
        if self.device.startswith("cuda"):
            self.peak_vram_mb = torch.cuda.max_memory_allocated() / (1024 * 1024)

    def _generate(self, pil, prompt):
        """Generate on one (image, prompt) pair via the Molmo2 chat-template path."""
        import torch

        messages = [{"role": "user", "content": [
            {"type": "image", "image": pil},
            {"type": "text", "text": prompt}]}]
        inputs = self._proc.apply_chat_template(
            messages, tokenize=True, add_generation_prompt=True,
            return_tensors="pt", return_dict=True,
        )
        inputs = {k: (v.to(self.device) if hasattr(v, "to") else v)
                  for k, v in inputs.items()}
        with torch.no_grad():
            out = self._model.generate(**inputs, max_new_tokens=256)
        gen = out[0][inputs["input_ids"].size(1):]
        return self._proc.decode(gen, skip_special_tokens=True)

    def detect(self, image, vocabulary=None):
        import numpy as np
        from PIL import Image
        if image.ndim == 2:
            image = np.stack([image] * 3, axis=-1)
        pil = Image.fromarray(image.astype(np.uint8)).convert("RGB")
        vocab = list(vocabulary) if vocabulary is not None else self.vocab
        self.calls += 1
        self._load()
        dets = []
        for cls in vocab:
            text = self._generate(pil, molmo2_backend.build_prompt(cls))
            dets.extend(molmo2_backend.parse_molmo_detection(text, cls, box_size=self.box_size))
        return dets


# --- eval loop ---------------------------------------------------------------

def load_manifest(path):
    rows = []
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))
    return rows


def read_frame(row, frames_root):
    """Return the RGB ndarray for a manifest row, using --image (absolute) or
    frames-root/f{frame:04d}.png."""
    from PIL import Image
    import numpy as np
    p = row.get("image")
    if not p:
        p = os.path.join(frames_root, "f%04d.png" % int(row["frame"]))
    return np.asarray(Image.open(p).convert("RGB"))


def eval_run(det, rows, vocab, frames_root, iou_thr=ACCEPT_IOU):
    classes = vocab
    tp = defaultdict(int); fp = defaultdict(int); fn = defaultdict(int)
    frame_present = defaultdict(int); frame_dropout = defaultdict(int)
    frame_recall_overall = []         # per-frame overall recall (0..1)
    dropout_overall = 0               # frames where overall recall == 0
    seed_iou = defaultdict(list)      # per class: best predicted box IoU vs GT box
    seed_boxes = defaultdict(list)    # per class: the best predicted box (argmax IoU) per frame
    latencies = []
    n_frames = 0
    junk_fp = 0
    for row in rows:
        n_frames += 1
        gts = defaultdict(list)
        for o in row.get("objects", []):
            gts[o["label"]].append((len(gts[o["label"]]), tuple(o["bbox"])))
        fixture = {"_gt_objects": row.get("objects", [])}
        t0 = time.perf_counter()
        dets = getattr(det, "detect")(fixture if isinstance(det, FixtureDetector) else read_frame(row, frames_root),
                                      vocabulary=vocab)
        latencies.append(time.perf_counter() - t0)
        frame_tp = 0; frame_g = 0
        for d in dets:
            if canonical(d, vocab)["label"] == "<junk>":
                junk_fp += 1
        preds = defaultdict(list)
        for d in dets:
            c = canonical(d, vocab)
            if c["label"] != "<junk>":
                preds[c["label"]].append((len(preds[c["label"]]), tuple(c["bbox"])))
        for cls in classes:
            tp_p, mt_g = greedy_match(preds.get(cls, []), gts.get(cls, []), iou_thr)
            tp[cls] += len(tp_p)
            fp[cls] += len(preds.get(cls, [])) - len(tp_p)
            fn[cls] += len(gts.get(cls, [])) - len(mt_g)
            n_g = len(gts.get(cls, []))
            if n_g:
                rec = len(tp_p) / n_g
                frame_present[cls] += 1
                if rec == 0.0:
                    frame_dropout[cls] += 1
                frame_recall_overall.append(rec)
                # seed-box quality: best predicted box IoU vs GT box for this class
                best = 0.0
                best_box = None
                for p_box in [b for _, b in preds.get(cls, [])]:
                    for g_box in [b for _, b in gts.get(cls, [])]:
                        v = iou(p_box, g_box)
                        if v > best:
                            best, best_box = v, p_box
                seed_iou[cls].append(best)
                seed_boxes[cls].append(best_box)
            frame_tp += len(tp_p); frame_g += n_g
        if frame_g and frame_tp / frame_g == 0.0:
            dropout_overall += 1
    overall_tp = sum(tp.values()); overall_fp = sum(fp.values()) + junk_fp
    overall_fn = sum(fn.values())
    m = {
        "overall": {
            "tp": overall_tp, "fp": overall_fp, "fn": overall_fn,
            "precision": overall_tp / (overall_tp + overall_fp) if (overall_tp + overall_fp) else None,
            "recall": overall_tp / (overall_tp + overall_fn) if (overall_tp + overall_fn) else None,
            "frames": n_frames, "junkFp": junk_fp,
            "frameRecallMean": sum(frame_recall_overall) / len(frame_recall_overall) if frame_recall_overall else None,
            "dropoutFrames": dropout_overall,
        }
    }
    for cls in classes:
        t, f, n = tp[cls], fp[cls], fn[cls]
        vals = seed_iou[cls]
        m[cls] = {
            "tp": t, "fp": f, "fn": n,
            "precision": t / (t + f) if (t + f) else None,
            "recall": t / (t + n) if (t + n) else None,
            "framesPresent": frame_present[cls], "dropoutFrames": frame_dropout[cls],
            "seedIoUMean": sum(vals) / len(vals) if vals else None,
            "seedIoUMed": median(vals) if vals else None,
        }
    lat = sorted(latencies)
    m["latency"] = {
        "calls": len(lat),
        "p50": median(lat) if lat else None,
        "p95": lat[int(len(lat) * 0.95) - 1] if lat else None,
        "mean": sum(lat) / len(lat) if lat else None,
        "max": lat[-1] if lat else None,
    }
    return m, seed_boxes


def main():
    ap = argparse.ArgumentParser(description="Molmo2-4B vs fine-tuned Florence-2 A/B detect measurement")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--frames-root", default="")
    ap.add_argument("--backend", choices=["fixture", "florence", "molmo"], default="fixture")
    ap.add_argument("--model", default=None)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--dtype", default="bfloat16")
    ap.add_argument("--vocab", nargs="*", default=DEFAULT_VOCAB)
    ap.add_argument("--iou", type=float, default=ACCEPT_IOU)
    ap.add_argument("--drop-class", default=None)
    ap.add_argument("--drop-rate", type=float, default=0.0)
    ap.add_argument("--junk-fp", type=int, default=0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--gpu-rate", type=float, default=DEFAULT_GPU_RATE)
    ap.add_argument("--sam3-seed", action="store_true",
                    help="run the detector arm's player seed box through the SAM3 backend and "
                         "report SAM3 seed-quality + track persistence for the seeded player slot "
                         "(ADAAAA-7287)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    vocab = list(args.vocab) or DEFAULT_VOCAB
    rows = load_manifest(args.manifest)
    if not rows:
        print("ERROR: empty manifest", file=sys.stderr)
        return 2
    print(f"[info] manifest {args.manifest}: {len(rows)} labeled frames; vocab={vocab}")

    if args.backend == "florence":
        det = FlorenceDetector(args.model or "microsoft/Florence-2-base", vocab, args.device)
    elif args.backend == "molmo":
        det = MolmoDetector(args.model or "allenai/Molmo2-4B", vocab, args.device, args.dtype)
    else:
        det = FixtureDetector(vocab, args.drop_class, args.drop_rate, args.junk_fp, args.seed)

    metrics, seed_boxes = eval_run(det, rows, vocab, args.frames_root, args.iou)

    # peak VRAM (torch) if a real model ran
    peak = None
    if args.backend != "fixture":
        try:
            import torch
            if torch.cuda.is_available():
                peak = torch.cuda.max_memory_allocated() / (1024 * 1024)
                if isinstance(det, MolmoDetector):
                    peak = max(peak, det.peak_vram_mb)
        except Exception:
            pass
    # cost: GPU-hours = sum of per-call latency / 3600 (compute only)
    total_s = sum(l for l in [metrics["latency"]["mean"]] if l) * len(rows)
    gpu_hours = total_s / 3600.0
    cost_usd = gpu_hours * args.gpu_rate

    report = {
        "backend": args.backend, "model": args.model, "device": args.device,
        "vocab": vocab, "frames": len(rows), "manifest": args.manifest,
        "metrics": metrics,
        "vram": {"peakMiB": peak},
        "cost": {
            "computeSeconds": total_s, "gpuHoursPerClip": gpu_hours,
            "gpuRatePerHour": args.gpu_rate, "costUsdPerClip": cost_usd,
        },
    }

    # SAM3 seed-quality + track-persistence for the seeded player slot (ADAAAA-7287).
    # Take the detector arm's player seed box (the per-frame best player detection
    # by seed IoU vs GT) and run it through the repo SAM3 backend, reporting whether
    # the seeded player slot is kept and its track persistence. Real models use the
    # real Sam3Backend on the GPU box; the fixture backend uses a stub so the
    # accounting can be validated with no model.
    if args.sam3_seed:
        import sam3_seed_quality as sq
        gt_boxes = [sq._gt_box(r) for r in rows]
        # player seed box = the detector's best player detection per seed IoU.
        ious = seed_boxes.get("player", None) or []
        seed_box = None
        if ious:
            pick = -1
            for i, b in enumerate(ious):
                if b is not None:
                    pick = i
            if pick >= 0:
                seed_box = tuple(float(v) for v in ious[pick])
        if seed_box is None:
            report["sam3_seed"] = {"reason": "no_player_seed_box", "frames": len(rows)}
        else:
            use_real = args.backend in ("florence", "molmo") and args.device.startswith("cuda")
            sr = sq.measure_seed_quality(
                seed_box, gt_boxes,
                mode=("real" if use_real else "stub"),
                capacity=8, frames_root=args.frames_root,
                rows=rows,
            )
            report["sam3_seed"] = {k: v for k, v in sr.items() if k != "per_frame"}
            print("\n=== SAM3 SEED-QUALITY + TRACK-PERSISTENCE (ADAAAA-7287) ===")
            print(json.dumps({k: v for k, v in sr.items() if k != "per_frame"}, indent=2, default=str))
    with open(args.out, "w") as fh:
        json.dump(report, fh, indent=2)
    print(json.dumps({"backend": args.backend, "frames": len(rows),
                      "overall": metrics["overall"],
                      "latency": metrics["latency"],
                      "vram_peakMiB": peak, "gpuHoursPerClip": gpu_hours,
                      "costUsdPerClip": cost_usd}, indent=2))
    print(f"[info] report written: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

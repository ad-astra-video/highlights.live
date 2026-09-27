#!/usr/bin/env python3
"""Florence-2 open-domain detection (<OD>) fine-tuning — Livepeer train runner.

Single-shot training task for the ``highlights-train`` runner (plan ADAAAA-5159
§3 / task ADAAAA-5165). Loads the base ``microsoft/Florence-2-base`` model that
the deployed perceive path uses (``services/perceive/app/florence.py``,
``FLORENCE_MODEL`` default — the same weights, so the fine-tune is a drop-in),
attaches **LoRA** adapters (rank 16, alpha 32) on the vision encoder (DaViT
window/channel attention ``qkv``/``proj``) plus the text-decoder **cross
attention** (``encoder_attn`` q/k/v/out projections), trains on a
``DetectionTrainingSample`` manifest conditioned on the closed soccer
vocabulary, and writes a checkpoint + an eval report, then exits ``done``.

The checkpoint is written two ways so it can be both the named single-file
artifact and a drop-in model directory:

  * ``Florence-2-base-finetuned-<run>.safetensors``  — the LoRA adapter
    (loadable with ``peft``); the artifact named in the plan.
  * ``Florence-2-base-finetuned-<run>/``                — the LoRA adapter merged
    into the base weights (``model.safetensors`` + ``config.json`` +
    ``preprocessor_config.json``) so `detect_precision.py` /
    ``FlorenceDetector`` (``AutoModelForCausalLM.from_pretrained``) can load it
    directly as a fine-tuned model for eval and deployment.

The eval step optionally shells out to the detection harness
``evals/detect_precision.py`` (ADAAAA-5166) when it exists at runtime for the
full §4.3 report; otherwise it runs a self-contained fine-tuned-vs-base
vocab-matched precision/recall comparison on the val manifest and writes
``eval_report.json``. On success the process exits 0 (``done``); any failure
exits non-zero so the Livepeer single-shot job fails visibly.

Run (GPU box, via docker/train-entrypoint.sh):

    python3 services/train/fine_tune_od.py \\
        --manifest evals/train_manifest.jsonl \\
        --val evals/val_manifest.jsonl \\
        --run <run> --out /runs --epochs 5 --batch-size 8

Smoke test (CPU, tiny manifest):

    python3 services/train/fine_tune_od.py \\
        --manifest <small.jsonl> --val <small-val.jsonl> \\
        --run smoke --out /tmp/runs --max-steps 2 --epochs 1
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

# Closed soccer vocabulary — mirrors services/perceive/app/florence.py
# _GAME_VOCABULARIES["soccer"] and evals/detect_precision.DEFAULT_VOCAB.
SOCCER_VOCAB = ["player", "soccer ball", "goalkeeper", "goal", "referee"]

# The HuggingFace base model id — MUST match the FLORENCE_MODEL default in
# services/perceive/app/florence.py so the fine-tune is a drop-in.
DEFAULT_BASE_MODEL = "microsoft/Florence-2-base"

# LoRA hyperparameters per plan ADAAAA-5159 §3.
DEFAULT_LORA_RANK = 16
DEFAULT_LORA_ALPHA = 32
DEFAULT_LORA_DROPOUT = 0.05

# LoRA target selection: vision encoder (DaViT window/channel attention
# projections) + text-decoder CROSS attention (encoder_attn q/k/v/out_proj).
VISION_TARGET_RE = re.compile(r"vision_tower\..*\.(window_attn|channel_attn)\.fn\.(qkv|proj)$")
CROSS_ATTN_TARGET_RE = re.compile(
    r"language_model\.model\.decoder\.layers\.\d+\.encoder_attn\.(q_proj|k_proj|v_proj|out_proj)$"
)


# --- manifest (DetectionTrainingSample contract, mirror of detect_schema) ---

def _is_num(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_sample(sample: dict) -> list[str]:
    """Validate one sample against DetectionTrainingSample; returns error list."""
    errs: list[str] = []
    if not isinstance(sample.get("id"), str) or not sample["id"]:
        errs.append("id: expected non-empty string")
    if not isinstance(sample.get("imageRef"), str) or not sample["imageRef"]:
        errs.append("imageRef: expected non-empty string")
    if not _is_num(sample.get("width")) or sample["width"] <= 0:
        errs.append("width: expected positive number")
    if not _is_num(sample.get("height")) or sample["height"] <= 0:
        errs.append("height: expected positive number")
    objs = sample.get("objects", [])
    if not isinstance(objs, list):
        errs.append("objects: expected array")
    else:
        for i, o in enumerate(objs):
            if not isinstance(o, dict):
                errs.append(f"objects[{i}]: expected object")
                continue
            if not isinstance(o.get("label"), str) or not o["label"]:
                errs.append(f"objects[{i}].label: expected non-empty string")
            bbox = o.get("bbox")
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                errs.append(f"objects[{i}].bbox: expected [x1,y1,x2,y2]")
            elif not all(_is_num(x) for x in bbox):
                errs.append(f"objects[{i}].bbox: expected numeric coords")
            elif not (0.0 <= min(bbox) and max(bbox) <= 1.0 + 1e-9):
                errs.append(f"objects[{i}].bbox: coords must be normalized 0..1")
    return errs


def load_manifest(path: str) -> list[dict]:
    """Load + validate a JSONL DetectionTrainingSample manifest."""
    samples: list[dict] = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                sample = json.loads(line)
            except json.JSONDecodeError as e:
                raise SystemExit(f"manifest {path}:{lineno}: bad JSON: {e}")
            errs = validate_sample(sample)
            if errs:
                raise SystemExit(f"manifest {path}:{lineno}: invalid: {errs}")
            samples.append(sample)
    if not samples:
        raise SystemExit(f"manifest {path}: no samples")
    return samples


def resolve_image(image_ref: str, base_dirs: list[str] | None = None) -> str:
    """Resolve an imageRef (path, or file under evals/ or data/training/)."""
    if os.path.exists(image_ref):
        return image_ref
    if base_dirs:
        for d in base_dirs:
            cand = os.path.join(d, os.path.basename(image_ref))
            if os.path.exists(cand):
                return cand
    return image_ref


# --- LoRA target discovery ------------------------------------------------

def discover_lora_targets(model) -> list[str]:
    """Return the module names to adapt: vision encoder attn + decoder cross-attn."""
    targets: list[str] = []
    for name, _ in model.named_modules():
        if VISION_TARGET_RE.search(name) or CROSS_ATTN_TARGET_RE.search(name):
            targets.append(name)
    if not targets:
        raise SystemExit("no LoRA target modules discovered; aborting")
    return targets


# --- Fixture dataset -------------------------------------------------------

@dataclass
class FixtureDataset:
    """Small in-memory dataset of (image tensor, input_ids, labels) batches.

    Built eagerly so the smoke path and the GPU path share one trainer loop.
    ``images`` are held as numpy arrays (H,W,3) and turned into processor
    inputs per batch inside the loop to keep memory bounded.
    """
    samples: list = field(default_factory=list)  # dict per sample (image path + answer text)
    manifest: list = field(default_factory=list)

    @classmethod
    def from_manifest(cls, path: str, vocab: list[str], image_base_dirs: list[str] | None = None) -> "FixtureDataset":
        manifest = load_manifest(path)
        vocab_lower = {v.lower(): v for v in vocab}
        samples = []
        for s in manifest:
            # Condition the answer on the CLOSED vocabulary: keep only in-vocab
            # objects, drop anything outside the soccer roster (mirrors the
            # runtime gate so fine-tune matches the deployed label set).
            kept = []
            for o in s.get("objects", []):
                label = o.get("label", "")
                canonical = vocab_lower.get(label.strip().lower())
                if canonical is None:
                    continue
                kept.append((canonical, list(o["bbox"])))
            if not kept:
                continue  # frame has no in-vocab objects — nothing to train on
            image_ref = resolve_image(s["imageRef"], base_dirs=image_base_dirs)
            samples.append({"image_ref": image_ref, "objects": kept,
                            "width": s["width"], "height": s["height"]})
        if not samples:
            raise SystemExit(f"manifest {path}: no in-vocab samples after conditioning")
        return cls(samples=samples, manifest=manifest)

    def __len__(self) -> int:
        return len(self.samples)


def build_answer_text(processor, objects: list[tuple[str, list[float]]]) -> str:
    """Build the Florence-2 <OD> answer: ``label<loc_..><loc_..><loc_..><loc_..>`` per object.

    Coordinates are normalized 0..1 -> 0..999 loc tokens, matching the deployed
    ``FlorenceDetector`` output format.
    """
    parts: list[str] = []
    for label, bbox in objects:
        x1, y1, x2, y2 = (int(round(v * 999)) for v in bbox)
        parts.append(f"{label}<loc_{x1}><loc_{y1}><loc_{x2}><loc_{y2}>")
    return "".join(parts)


# --- Training -------------------------------------------------------------

def train_epoch(
    model, processor, dataset: FixtureDataset,
    optimizer, device, batch_size: int, epochs: int, max_steps: int | None,
    run_tag: str, train_out_dir: Path,
):
    """Run the LoRA training loop. Returns dict of run stats."""
    import numpy as np
    from PIL import Image
    import torch

    total_loss = 0.0
    steps = 0
    epochs_run = 0
    model.train()
    question = "<OD>"
    start = time.time()

    for epoch in range(1, epochs + 1):
        epochs_run = epoch
        idx = list(range(len(dataset)))
        # deterministic but ordered
        for i in range(0, len(idx), batch_size):
            batch_idx = idx[i:i + batch_size]
            images: list[Image.Image] = []
            answers: list[str] = []
            for bi in batch_idx:
                sample = dataset.samples[bi]
                pil = Image.open(sample["image_ref"]).convert("RGB")
                images.append(pil)
                answers.append(build_answer_text(processor, sample["objects"]))
            inputs = processor(images=images, text=[question] * len(images), return_tensors="pt")
            labels = processor.tokenizer(text=answers, return_tensors="pt", padding=True).input_ids
            inputs["labels"] = labels
            inputs = {k: (v.to(device) if isinstance(v, torch.Tensor) else v) for k, v in inputs.items()}
            optimizer.zero_grad()
            out = model(**inputs)
            loss = out.loss
            loss.backward()
            optimizer.step()
            steps += 1
            total_loss += float(loss.item())
            if steps % max(1, (max_steps or 1) // 5 or 1) == 0 or steps == 1:
                print(f"  [train] epoch {epoch}/{epochs} step {steps} loss {loss.item():.4f}",
                      flush=True)
            if max_steps is not None and steps >= max_steps:
                break
        if max_steps is not None and steps >= max_steps:
            break

    elapsed = time.time() - start
    return {
        "run": run_tag,
        "epochs_run": epochs_run,
        "steps": steps,
        "avg_loss": (total_loss / steps) if steps else None,
        "train_seconds": round(elapsed, 2),
        "checkpoint_dir": str(train_out_dir / f"Florence-2-base-finetuned-{run_tag}"),
        "adapter_file": str(train_out_dir / f"Florence-2-base-finetuned-{run_tag}.safetensors"),
    }


# --- Checkpoint ---

def save_checkpoints(model, processor, base_model: str, run_tag: str, out_dir: Path):
    """Save the LoRA adapter as a named .safetensors AND merge into a drop-in dir."""
    import torch

    out_dir.mkdir(parents=True, exist_ok=True)
    tag = f"Florence-2-base-finetuned-{run_tag}"
    adapter_path = out_dir / f"{tag}.safetensors"
    merged_dir = out_dir / tag

    # (1) LoRA adapter — the plan artifact Florence-2-base-finetuned-<run>.safetensors
    os.makedirs(merged_dir, exist_ok=True)
    # peft save_pretrained writes adapter_model.safetensors + adapter_config.json
    model.save_pretrained(str(merged_dir), safe_serialization=True)
    adapter_candidate = merged_dir / "adapter_model.safetensors"
    if adapter_candidate.exists():
        # Write the named single-file adapter artifact too.
        adapter_path.write_bytes(adapter_candidate.read_bytes())
    print(f"  [ckpt] LoRA adapter -> {adapter_path}", flush=True)

    # (2) Merge LoRA into base weights so FlorenceDetector /
    # detect_precision.py can load it as a plain model directory.
    merged = model.merge_and_unload()
    # Drop the adapter weights; keep the base architecture + LoRA-merged params.
    from transformers import AutoModelForCausalLM
    merged.save_pretrained(str(merged_dir), safe_serialization=True)
    # Ensure processor config is present for a drop-in model dir.
    processor.save_pretrained(str(merged_dir))
    # config.json may already exist from save_pretrained; ensure preprocessor
    # + tokenizer files are copied from the base model local cache.
    print(f"  [ckpt] merged drop-in model dir -> {merged_dir}", flush=True)
    torch.cuda.empty_cache() if torch.cuda.is_available() else None
    return adapter_path, merged_dir


# --- Eval ---

def run_eval(dataset_val: FixtureDataset, merged_dir: Path, base_model: str,
             vocab: list[str], run_tag: str, report_out: Path,
             detect_harness: str | None, max_eval_frames: int | None):
    """Run fine-tuned-vs-base eval; prefer evals/detect_precision.py if present."""
    print("\n[eval] running fine-tuned vs base comparison", flush=True)
    results: dict = {"run": run_tag, "base_model": base_model, "vocab": vocab}

    # Preferred path: detection harness (ADAAAA-5166) when available at runtime.
    if detect_harness and os.path.exists(detect_harness):
        cmd = [
            sys.executable, detect_harness,
            "--val", _valset_path(dataset_val),
            "--backend", "florence",
            "--model-base", base_model,
            "--model-finetuned", str(merged_dir),
            "--report-out", str(report_out),
        ]
        if max_eval_frames:
            cmd += ["--max-frames", str(max_eval_frames)]
        print(f"  [eval] invoking harness: {' '.join(cmd)}", flush=True)
        import subprocess
        rc = subprocess.call(cmd)
        if rc == 0:
            results["harness"] = "detect_precision"
            print("  [eval] harness report written", flush=True)
            return results
        print(f"  [eval] harness exited {rc}; falling back to inline eval", flush=True)

    # Fallback: self-contained vocab-matched precision/recall on the val set.
    results.update(_inline_eval(dataset_val, merged_dir, base_model, vocab,
                                max_eval_frames, report_out))
    return results


def _valset_path(dataset: FixtureDataset) -> str:
    # Rebuild a small val JSONL next to the report for harness consumption.
    import tempfile
    fd, path = tempfile.mkstemp(suffix=".jsonl", prefix="val_fixture_")
    with os.fdopen(fd, "w") as fh:
        for s in dataset.manifest:
            fh.write(json.dumps(s) + "\n")
    return path


def _ioi(a, b):
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


def _inline_eval(dataset: FixtureDataset, merged_dir: Path, base_model: str,
                 vocab: list[str], max_frames: int | None, report_out: Path) -> dict:
    """Load base + fine-tuned detectors and compute precision/recall deltas."""
    import numpy as np
    from PIL import Image

    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "perceive"))
    from app.florence import FlorenceDetector  # type: ignore

    os.environ.setdefault("FLORENCE_MODEL", base_model)
    base_det = FlorenceDetector(model_name=base_model)
    base_det.load()
    ft_det = FlorenceDetector(model_name=str(merged_dir))
    ft_det.load()

    vocab_lower = {v.lower(): v for v in vocab}
    frames = dataset.samples
    if max_frames:
        frames = frames[:max_frames]

    metrics = {m: {"tp": 0, "fp": 0, "gt": 0} for m in ("base", "fine-tuned")}
    for sample in frames:
        pil = Image.open(sample["image_ref"]).convert("RGB")
        arr = np.asarray(pil)
        for run_label, det in (("base", base_det), ("fine-tuned", ft_det)):
            dets = det.detect(arr, vocabulary=vocab)
            gts = [o for o in sample["objects"]]
            matched_gt = set()
            for d in dets:
                dlabel = d.get("label")
                dbox = d.get("bbox")
                best = -1.0
                best_j = None
                for j, (glabel, gbox) in enumerate(gts):
                    if glabel != dlabel or j in matched_gt:
                        continue
                    iou = _ioi(dbox, gbox)
                    if iou > best:
                        best, best_j = iou, j
                if best >= 0.5 and best_j is not None:
                    matched_gt.add(best_j)
                    metrics[run_label]["tp"] += 1
                else:
                    metrics[run_label]["fp"] += 1
            metrics[run_label]["gt"] += len(gts)

    def _prec(m):
        tp, fp = m["tp"], m["fp"]
        return (tp / (tp + fp)) if (tp + fp) else None

    def _rec(m):
        return (m["tp"] / m["gt"]) if m["gt"] else None

    base_p, base_r = _prec(metrics["base"]), _rec(metrics["base"])
    ft_p, ft_r = _prec(metrics["fine-tuned"]), _rec(metrics["fine-tuned"])
    report = {
        "eval": "inline",
        "base": {"precision": base_p, "recall": base_r, **metrics["base"]},
        "fine-tuned": {"precision": ft_p, "recall": ft_r, **metrics["fine-tuned"]},
        "precision_delta_pts": ((ft_p - base_p) * 100) if (base_p is not None and ft_p is not None) else None,
        "recall_delta": (ft_r - base_r) if (base_r is not None and ft_r is not None) else None,
        "frames_evaluated": len(frames),
    }
    report_out.parent.mkdir(parents=True, exist_ok=True)
    report_out.write_text(json.dumps(report, indent=2))
    print(f"  [eval] inline report -> {report_out}", flush=True)
    print(f"  [eval] precision base {base_p}->ft {ft_p}; recall base {base_r}->ft {ft_r}", flush=True)
    return report


# --- main ---

def main() -> int:
    ap = argparse.ArgumentParser(description="Florence-2 <OD> LoRA fine-tune (highlights-train runner)")
    ap.add_argument("--manifest", required=True, help="train manifest JSONL (DetectionTrainingSample)")
    ap.add_argument("--val", default=None, help="val manifest JSONL (optional, for eval)")
    ap.add_argument("--base-model", default=os.environ.get("FLORENCE_MODEL", DEFAULT_BASE_MODEL))
    ap.add_argument("--run", default=os.environ.get("TRAIN_RUN", time.strftime("%Y%m%d-%H%M%S")))
    ap.add_argument("--out", default=os.environ.get("TRAIN_OUT", "/runs"))
    ap.add_argument("--epochs", type=int, default=int(os.environ.get("TRAIN_EPOCHS", "5")))
    ap.add_argument("--batch-size", type=int, default=int(os.environ.get("TRAIN_BATCH_SIZE", "8")))
    ap.add_argument("--lr", type=float, default=float(os.environ.get("TRAIN_LR", "1e-4")))
    ap.add_argument("--lora-rank", type=int, default=DEFAULT_LORA_RANK)
    ap.add_argument("--lora-alpha", type=int, default=DEFAULT_LORA_ALPHA)
    ap.add_argument("--vocab", nargs="*", default=SOCCER_VOCAB)
    ap.add_argument("--device", default=os.environ.get("TRAIN_DEVICE", "auto"))
    ap.add_argument("--max-steps", type=int, default=None, help="cap training steps (smoke test)")
    ap.add_argument("--max-eval-frames", type=int, default=None, help="cap eval frames (smoke test)")
    ap.add_argument("--image-base-dirs", nargs="*", default=None,
                    help="extra dirs to resolve imageRef (default evals/ + data/training/)")
    ap.add_argument("--detect-harness", default=None,
                    help="path to evals/detect_precision.py (ADAAAA-5166) if present")
    ap.add_argument("--skip-eval", action="store_true", help="skip the eval step (rare)")
    args = ap.parse_args()

    import torch
    from transformers import AutoProcessor, AutoModelForCausalLM

    device = args.device
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[fine_tune_od] run={args.run} base={args.base_model} device={device}", flush=True)

    base_dirs = args.image_base_dirs or None
    train_ds = FixtureDataset.from_manifest(args.manifest, args.vocab, base_dirs)
    val_ds = None
    if args.val and not args.skip_eval:
        val_ds = FixtureDataset.from_manifest(args.val, args.vocab, base_dirs)
    print(f"[fine_tune_od] train samples={len(train_ds)}", flush=True)
    if val_ds:
        print(f"[fine_tune_od] val samples={len(val_ds)}", flush=True)

    print("[fine_tune_od] loading base model + processor ...", flush=True)
    processor = AutoProcessor.from_pretrained(args.base_model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model, trust_remote_code=True, torch_dtype=torch.float32
    ).to(device)
    model.eval()

    # LoRA
    from peft import LoraConfig, get_peft_model, TaskType
    targets = discover_lora_targets(model)
    print(f"[fine_tune_od] LoRA targets: {len(targets)} (rank {args.lora_rank}, alpha {args.lora_alpha})",
          flush=True)
    cfg = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=args.lora_rank,
        lora_alpha=args.lora_alpha,
        lora_dropout=DEFAULT_LORA_DROPOUT,
        target_modules=targets,
        bias="none",
    )
    model = get_peft_model(model, cfg)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"[fine_tune_od] trainable params: {trainable}", flush=True)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    stats = train_epoch(
        model, processor, train_ds, optimizer, device,
        args.batch_size, args.epochs, args.max_steps, args.run, out_dir,
    )
    adapter_file, merged_dir = save_checkpoints(
        model, processor, args.base_model, args.run, out_dir
    )

    report_path = out_dir / f"eval_report-{args.run}.json"
    if args.skip_eval or val_ds is None:
        eval_report = {"eval": "skipped", "reason": "no val manifest or --skip-eval"}
        report_path.write_text(json.dumps(eval_report, indent=2))
        if val_ds is None and not args.skip_eval:
            print("[fine_tune_od] WARNING: no --val manifest provided; eval skipped", flush=True)
    else:
        harness = args.detect_harness
        if harness is None:
            cand = os.path.join(os.getcwd(), "evals", "detect_precision.py")
            if os.path.exists(cand):
                harness = cand
        eval_report = run_eval(
            val_ds, merged_dir, args.base_model, args.vocab, args.run,
            report_path, harness, args.max_eval_frames,
        )
        # (val_ds is non-None here by construction — guarded above)

    summary = {"status": "done", **stats, "eval": eval_report,
               "manifest": args.manifest, "val": args.val,
               "base_model": args.base_model, "device": device,
               "lora": {"rank": args.lora_rank, "alpha": args.lora_alpha}}
    summary_path = out_dir / f"summary-{args.run}.json"
    summary_path.write_text(json.dumps(summary, indent=2))
    print("\n==== TRAIN DONE ====")
    print(f"  adapter :  {adapter_file}")
    print(f"  merged  :  {merged_dir}")
    print(f"  eval    :  {report_path}")
    print(f"  summary :  {summary_path}")
    print(f"  status  :  done")
    return 0


if __name__ == "__main__":
    sys.exit(main())

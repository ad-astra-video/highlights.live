"""FastAPI single-shot app for the highlights-train runner.

Reconciles the ADAAAA-5271 deploy contract: the go-livepeer orchestrator proxies
the `highlights-train` runner at /app/train (http://train:8083, mode single-shot
per docker/runners.json), and this app turns a plain JSON train request into a
`fine_tune_od.py` subprocess run, blocks until the checkpoint + eval report are
written, then returns them. The response shape mirrors
`services/server/src/analyzer.ts` `TrainResult` (checkpoint / out / eval with
precision/recall/f1) so the server and dashboard Fine-tune page can render it.

Served by: uvicorn run:app --host 0.0.0.0 --port 8083  (see Dockerfile.train).
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger("highlights-train")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

app = FastAPI(title="highlights-train", version="0.1.0")

SCRIPT = Path(__file__).resolve().parent / "fine_tune_od.py"
# Where --out checkpoints land; the compose service bind-mounts host runs here.
TRAIN_OUT = os.environ.get("TRAIN_OUT", "/runs")
# Where the wrapper persists the incoming manifests (inside the same runs mount).
TRAIN_WORK_ROOT = Path(os.environ.get("TRAIN_WORK_ROOT", "/runs/train-work"))


class TrainRequest(BaseModel):
    """Mirrors services/server/src/analyzer.ts TrainRunRequest."""

    manifest: str = Field(..., description="JSONL DetectionTrainingSample manifest")
    val: str = Field("", description="optional held-out val manifest (JSONL)")
    epochs: int = 5
    batch_size: int = 8
    lr: float = 1e-4
    base_model: str = "microsoft/Florence-2-base"


def write_manifest(workdir: Path, run: str, kind: str, text: str) -> Path:
    """Persist an inline JSONL manifest to a workdir and return its path."""
    if not text.strip():
        raise ValueError(f"{kind} manifest is empty")
    path = workdir / f"{kind}-{run}.jsonl"
    path.write_text(text, encoding="utf-8")
    return path


def load_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:  # missing / partial file -> treat as no report
        return {}


def extract_metrics(report: dict) -> dict:
    """Surface precision/recall/f1 at the top level for the TrainResult contract,
    tolerating the eval report shapes produced by fine_tune_od.py:
      - inline eval : {fine-tuned: {precision, recall}, ...}
      - detect harness : {perRun: {fine-tuned: {overall: {precision, recall}}}}
    f1 is computed from precision+recall when the report omits it."""
    p = report.get("precision")
    r = report.get("recall")

    if not isinstance(p, (int, float)):
        ft = report.get("fine-tuned") or {}
        p = ft.get("precision")
        if not isinstance(r, (int, float)):
            r = ft.get("recall")
    if not isinstance(p, (int, float)):
        per = report.get("perRun") or {}
        ov = (per.get("fine-tuned") or {}).get("overall") or {}
        p = ov.get("precision")
        if not isinstance(r, (int, float)):
            r = ov.get("recall")

    f1 = report.get("f1")
    if not isinstance(f1, (int, float)) and isinstance(p, (int, float)) and isinstance(r, (int, float)) and (p + r) > 0:
        f1 = 2 * p * r / (p + r)
    return {"precision": p, "recall": r, "f1": f1}


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/")
def root() -> dict:
    return {"app": "highlights-train", "endpoint": "POST /app/train"}


@app.post("/app/train")
def train(req: TrainRequest) -> dict:
    run = time.strftime("%Y%m%d-%H%M%S")
    out_dir = Path(TRAIN_OUT)
    out_dir.mkdir(parents=True, exist_ok=True)
    workdir = TRAIN_WORK_ROOT / run
    workdir.mkdir(parents=True, exist_ok=True)

    try:
        manifest_path = write_manifest(workdir, run, "manifest", req.manifest)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    cmd = [
        sys.executable, str(SCRIPT),
        "--manifest", str(manifest_path),
        "--run", run,
        "--out", str(out_dir),
        "--epochs", str(req.epochs),
        "--batch-size", str(req.batch_size),
        "--lr", str(req.lr),
        "--base-model", req.base_model,
    ]
    if req.val.strip():
        val_path = write_manifest(workdir, run, "val", req.val)
        cmd += ["--val", str(val_path)]

    log.info("train run=%s epochs=%s batch=%s lr=%s base=%s", run, req.epochs, req.batch_size, req.lr, req.base_model)
    try:
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        tail = (e.stdout or "")[-2000:] + "\n" + (e.stderr or "")[-2000:]
        log.error("fine_tune_od.py failed rc=%s:\n%s", e.returncode, tail)
        raise HTTPException(status_code=500, detail=f"fine_tune_od.py failed (rc={e.returncode}); see container log")
    log.info("train run=%s complete rc=%s", run, proc.returncode)

    summary = load_json(out_dir / f"summary-{run}.json")
    report = load_json(out_dir / f"eval_report-{run}.json")

    checkpoint = summary.get("checkpoint_dir") or str(out_dir / f"Florence-2-base-finetuned-{run}")
    adapter = summary.get("adapter_file")

    eval_info = dict(report) if report else dict(summary.get("eval") or {})
    eval_status = (report or {}).get("eval") or (summary.get("eval") or {}).get("eval") or "done"
    eval_info.setdefault("eval", eval_status)
    eval_info.update({k: v for k, v in extract_metrics(report).items() if v is not None})

    return {
        "run": run,
        "checkpoint": checkpoint,
        "adapter": adapter,
        "out": str(out_dir),
        "eval": eval_info,
        "epochs": req.epochs,
        "batch_size": req.batch_size,
    }

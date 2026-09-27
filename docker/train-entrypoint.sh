#!/bin/sh
# Livepeer single-shot training entrypoint for the highlights-train runner.
#
# Runs the Florence-2 <OD> LoRA fine-tune (services/train/fine_tune_od.py) and
# exits `done` (0) on success, non-zero on failure so the Livepeer job fails
# visibly. This is a TRAINING entrypoint — NOT uvicorn.
#
# Env-driven so the scheduler can submit a job with just the run inputs:
#   TRAIN_MANIFEST   path to the training manifest (DetectionTrainingSample)
#   TRAIN_VAL        path to the held-out val manifest (optional)
#   TRAIN_RUN        run id (defaults to a timestamp)
#   TRAIN_OUT        checkpoint/eval output dir (default /runs)
#   TRAIN_EPOCHS     (default 5)
#   TRAIN_BATCH_SIZE (default 8)
#   TRAIN_LR         (default 1e-4)
#   FLORENCE_MODEL   base model id (default microsoft/Florence-2-base)
set -e

: "${TRAIN_MANIFEST:=}"
: "${TRAIN_VAL:=}"
: "${TRAIN_RUN:=$(date +%Y%m%d-%H%M%S)}"
: "${TRAIN_OUT:=/runs}"
: "${TRAIN_EPOCHS:=5}"
: "${TRAIN_BATCH_SIZE:=8}"
: "${TRAIN_LR:=1e-4}"
: "${FLORENCE_MODEL:=microsoft/Florence-2-base}"

if [ -z "$TRAIN_MANIFEST" ]; then
  echo "[train] FATAL: TRAIN_MANIFEST not set; nothing to train on" >&2
  exit 64
fi

echo "[train] highlights-train run=$TRAIN_RUN manifest=$TRAIN_MANIFEST out=$TRAIN_OUT"
echo "[train] base model: $FLORENCE_MODEL ; epochs=$TRAIN_EPOCHS batch=$TRAIN_BATCH_SIZE lr=$TRAIN_LR"

TRAIN_ARGS="--manifest $TRAIN_MANIFEST --run $TRAIN_RUN --out $TRAIN_OUT \
--epochs $TRAIN_EPOCHS --batch-size $TRAIN_BATCH_SIZE --lr $TRAIN_LR --base-model $FLORENCE_MODEL"

if [ -n "$TRAIN_VAL" ]; then
  TRAIN_ARGS="$TRAIN_ARGS --val $TRAIN_VAL"
fi
# Optional smoke/CPU caps for local validation.
if [ -n "$TRAIN_MAX_STEPS" ]; then TRAIN_ARGS="$TRAIN_ARGS --max-steps $TRAIN_MAX_STEPS"; fi
if [ -n "$TRAIN_MAX_EVAL_FRAMES" ]; then TRAIN_ARGS="$TRAIN_ARGS --max-eval-frames $TRAIN_MAX_EVAL_FRAMES"; fi
if [ -n "$TRAIN_DEVICE" ]; then TRAIN_ARGS="$TRAIN_ARGS --device $TRAIN_DEVICE"; fi

# The training service dir is /srv/train (see Dockerfile.perceive.gpu).
cd /srv/train
echo "[train] exec: python3 fine_tune_od.py $TRAIN_ARGS"
python3 fine_tune_od.py $TRAIN_ARGS
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "[train] FAILED rc=$rc" >&2
  exit "$rc"
fi
echo "[train] done (rc=0)"
exit 0

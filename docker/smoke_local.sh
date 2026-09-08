#!/bin/bash
# Local direct-mode smoke test (no orchestrator): generate a VOD, start
# perceive + decide + server directly, run a /jobs through it.
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd -W)                      # native Windows path, forward slashes
PY="$(pwd)/services/perceive/.venv/Scripts/python.exe"
export DATA_DIR="$ROOT/docker/data-smoke"
FRAMES_DIR="$ROOT/docker/data-smoke/frames"
VOD="$ROOT/docker/data-smoke/test_vod.mp4"

echo "== generate VOD =="
mkdir -p "$DATA_DIR"
"$PY" docker/gen_vod.py "$VOD"

echo "== start runners =="
cd "$(pwd)/services/perceive"; ../perceive/.venv/Scripts/python.exe -m uvicorn app:app --port 8080 >"$DATA_DIR/perceive.log" 2>&1 &
PID_P=$!
cd "$(pwd)/../decide"; ../perceive/.venv/Scripts/python.exe -m uvicorn app:app --port 8081 >"$DATA_DIR/decide.log" 2>&1 &
PID_D=$!
sleep 3

echo "== start server (direct) =="
cd "$(pwd)/../.."
PORT=3001 PERCEIVE_URL=http://127.0.0.1:8080 DECIDE_URL=http://127.0.0.1:8081 \
  DATA_DIR="$DATA_DIR" npx tsx services/server/src/index.ts >"$DATA_DIR/server.log" 2>&1 &
PID_S=$!
sleep 4

cleanup() { kill $PID_S $PID_D $PID_P 2>/dev/null || true; }
trap cleanup EXIT

curl -sf http://127.0.0.1:8080/health && echo " perceive ok"
curl -sf http://127.0.0.1:8081/health && echo " decide ok"
curl -sf http://127.0.0.1:3001/health && echo " server ok"

echo "== POST /jobs =="
curl -s -X POST http://127.0.0.1:3001/jobs -H 'Content-Type: application/json' \
  --data-raw "{\"videoPath\":\"$VOD\",\"gameHint\":\"valorant\"}" | tee "$DATA_DIR/job.json"
echo
echo "== highlights =="
curl -s http://127.0.0.1:3001/highlights
echo
echo "== clips on disk =="
ls -la "$DATA_DIR"/clips/ 2>/dev/null || echo "no clips dir"

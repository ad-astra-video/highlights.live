#!/usr/bin/env bash
# Local OFFCHAIN end-to-end via Docker Compose (orchestrator + runners + server).
# 1) generate synthetic VOD  2) up the stack  3) POST a job  4) assert a highlight+clip.
set -euo pipefail
cd "$(dirname "$0")"
PY=../services/perceive/.venv/Scripts/python.exe
D=data

echo "==> [1/4] generating synthetic VOD"
mkdir -p "$D"
HOST_VOD="$(pwd -W)/$D/test_vod.mp4"        # host path (Windows venv python is native)
[ -f "$HOST_VOD" ] || "$PY" gen_vod.py "$HOST_VOD"

echo "==> [2/4] building + starting stack (go-livepeer v0.9.2 orchestrator)"
docker compose -f docker-compose.yml up -d --build

echo "==> [3/4] waiting for server"
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:3000/health >/dev/null && break
  sleep 2
done
curl -sf http://127.0.0.1:3000/health >/dev/null
echo "server healthy"

echo "==> [4/4] posting job (orchestrator-proxied perceive+decide)"
JOB=$(curl -sf -X POST http://127.0.0.1:3000/jobs \
  -H 'content-type: application/json' \
  -d '{"videoPath":"/data/test_vod.mp4","gameHint":"esports","source":"file","preferLabels":["highlights-perceive","highlights-decide"]}')
echo "job response: $JOB"
JID=$(echo "$JOB" | python -c "import sys,json;print(json.load(sys.stdin)['job']['id'])")
for i in $(seq 1 60); do
  ST=$(curl -sf http://127.0.0.1:3000/jobs/$JID | python -c "import sys,json;print(json.load(sys.stdin)['job']['status'])")
  [ "$ST" = "done" ] && break
  [ "$ST" = "failed" ] && { echo "JOB FAILED"; curl -sf http://127.0.0.1:3000/jobs/$JID; exit 1; }
  sleep 2
done
echo "final status: $ST"
echo "==> highlights =="
curl -sf http://127.0.0.1:3000/highlights | python -m json.tool
echo "==> host clips =="
ls -la "$D/clips" 2>/dev/null

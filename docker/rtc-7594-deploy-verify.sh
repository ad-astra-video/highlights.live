#!/usr/bin/env bash
# ADAAAA-7594 — one-shot deploy + verification for the media RTC rail.
#
# Run this ON the box (livepeer-ai-x99) once the fleet exec path is up, e.g.
#   bash docker/rtc-7594-deploy-verify.sh            # deploy + prove the image
#   bash docker/rtc-7594-deploy-verify.sh --fault    # + mid-stream decode-failure proof (AC3)
#   bash docker/rtc-7594-deploy-verify.sh --report   # only print the counters
#
# It does exactly what the issue asks for and nothing else:
#   1. reconciles the box deploy tree to origin/master (the deploy target),
#   2. rebuilds + recreates ONLY the media service on the existing compose path,
#   3. proves the running image carries the ADAAAA-7594 fix (not just that a
#      build exited 0) by reading the code inside the container,
#   4. prints the AC counters from the container: `[rtc] frame ... frames=`,
#      `[rtc] obs ... liveMs=`, `[rtc] audio ... audioPackets=`, `[rtc] close`,
#      `[media] write-failed`, plus RestartCount / RestartPolicy / ExitCode.
#
# --fault drives a real mid-stream decoder failure (SIGKILL the one-shot ffmpeg
# children while a stream is live) and then re-reads the same counters, which is
# the AC3 literal proof: process alive, restarts unchanged, `write-failed` warn
# logged, session torn down. It does NOT change the restart policy — that is an
# operator call flagged in ADAAAA-7591.
#
# The browser-side measurement (real Chromium `getDisplayMedia` -> VP8/H264 ->
# trickle video-in) is scripts/rtc-browser-measure.py; run it from the agent host
# against the public media edge while this script watches the logs.
set -euo pipefail

CONTAINER=${CONTAINER:-highlights-media}
COMPOSE=${COMPOSE:-docker/docker-compose.yml}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:4070/health}
LOG_SINCE=${LOG_SINCE:-30m}
MODE=deploy

for arg in "$@"; do
  case "$arg" in
    --fault) MODE=fault ;;
    --report) MODE=report ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n=== %s\n' "$*"; }

# ---------------------------------------------------------------- preflight
find_deploy_dir() {
  if [ -n "${DEPLOY_DIR:-}" ]; then printf '%s' "$DEPLOY_DIR"; return; fi
  local hits
  hits=$(find /root /home /opt -maxdepth 3 -type d -name .git 2>/dev/null \
         | while read -r g; do d=$(dirname "$g"); [ -f "$d/$COMPOSE" ] && printf '%s\n' "$d"; done | head -5)
  local n; n=$(printf '%s\n' "$hits" | grep -c . || true)
  if [ "$n" -eq 1 ]; then printf '%s' "$hits"; return; fi
  echo "set DEPLOY_DIR explicitly. candidates:" >&2
  printf '%s\n' "${hits:-<none found>}" >&2
  exit 3
}

if [ "$MODE" != "report" ]; then
  DEPLOY_DIR=$(find_deploy_dir)
  cd "$DEPLOY_DIR"
  say "preflight: $DEPLOY_DIR"
  docker --version
  git --version
  git rev-parse --abbrev-ref HEAD || true
  git rev-parse --short HEAD
  test -f "$COMPOSE" || { echo "missing $COMPOSE in $DEPLOY_DIR" >&2; exit 3; }

  # ---------------------------------------------------------------- deploy
  say "deploy: reconcile to origin/master"
  git fetch --prune origin
  TARGET=$(git rev-parse --short origin/master)
  git reset --hard origin/master
  echo "HEAD=$(git rev-parse HEAD)  TARGET=$TARGET"
  # A deploy that is not exactly the deploy target is a silent stale-tree bug.
  test "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" \
    || { echo "tree != origin/master after reset" >&2; exit 4; }

  say "deploy: build + recreate $CONTAINER only"
  docker compose -f "$COMPOSE" build media
  docker compose -f "$COMPOSE" up -d --no-deps media

  say "deploy: wait for $HEALTH_URL"
  ok=0
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  [ "$ok" = 1 ] || { docker logs --tail 80 "$CONTAINER" || true; echo "media never became healthy" >&2; exit 5; }
  curl -sS "$HEALTH_URL"; echo
fi

# ------------------------------------------------------- image / fix proof
say "image identity"
IMAGE_ID=$(docker inspect -f '{{.Image}}' "$CONTAINER")
echo "container=$CONTAINER image=$IMAGE_ID"
docker image inspect "$IMAGE_ID" -f 'imageId={{.Id}} created={{.Created}}' || true

say "fix proof INSIDE the running container (ADAAAA-7594 + ADAAAA-7591)"
echo "-- rtc.ts fix markers:"
docker exec "$CONTAINER" grep -nE 'maxSegmentFrames|write-failed|keep the decoded frame|keyframeRequestMinMs' \
  /app/services/media/src/rtc.ts | head -12 || echo "MISSING: image predates the 7594 fix"
echo "-- guarded write call sites in rtc.ts:"
docker exec "$CONTAINER" grep -c 'safeWrite' /app/services/media/src/rtc.ts || true
echo "-- guarded-write module present:"
docker exec "$CONTAINER" sh -c 'ls -l /app/services/media/src/guarded-write.ts' || echo "MISSING guarded-write.ts"

say "container state (AC3 baseline)"
docker inspect -f 'status={{.State.Status}} restartCount={{.RestartCount}} exitCode={{.State.ExitCode}} restartPolicy={{.HostConfig.RestartPolicy.Name}} startedAt={{.State.StartedAt}}' "$CONTAINER"

print_counters() {
  local since="$1"
  say "rtc counters (docker logs --since $since)"
  docker logs --since "$since" "$CONTAINER" 2>&1 | grep -E '\[rtc\] (frame|obs|audio|close)|write-failed|rtc frame err|rtc err' | tail -80 || true
  say "counter digest"
  docker logs --since "$since" "$CONTAINER" 2>&1 | grep -E '\[rtc\] (frame|obs|audio)' \
    | awk '
        /\[rtc\] frame/ { f++; if (match($0, /frames=[0-9]+/)) fr[substr($0,RSTART+7,RLENGTH-7)]=1 }
        /\[rtc\] obs/   { o++; if (match($0, /liveMs=[0-9]+/)) { ms=substr($0,RSTART+7,RLENGTH-7); live=live" "ms; if(ms+0>mx)mx=ms+0 } }
        /\[rtc\] audio/ { a++; if (match($0, /audioPackets=[0-9]+/)) ap=substr($0,RSTART+13,RLENGTH-13) }
        END {
          printf "frames_log_lines=%d obs_log_lines=%d audio_log_lines=%d\n", f+0, o+0, a+0;
          if (o>0) printf "liveMs(sample)=%s max=%d\n", live, mx;
          if (a>0) printf "last_audioPackets=%s\n", ap;
        }' || true
}

if [ "$MODE" = "fault" ]; then
  say "AC3: force mid-stream decoder failures (SIGKILL the one-shot ffmpeg children)"
  BEFORE=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER")
  for i in $(seq 1 12); do
    docker exec "$CONTAINER" sh -c 'for p in $(ps -eo pid,args | grep -E "ffmpeg .*ivf|ffmpeg .*h264" | grep -v grep | awk "{print \$1}"); do kill -9 "$p"; done' || true
    sleep 1
  done
  AFTER=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER")
  say "AC3 result"
  docker inspect -f 'status={{.State.Status}} restartCount={{.RestartCount}} exitCode={{.State.ExitCode}}' "$CONTAINER"
  echo "restartCount before=$BEFORE after=$AFTER  (equal => the process was not replaced)"
  docker logs --since 5m "$CONTAINER" 2>&1 | grep -E 'write-failed|\[media\] write-failed' | tail -10 || echo "NO write-failed warn"
  print_counters 5m
else
  print_counters "$LOG_SINCE"
fi

say "done"
echo "Paste this whole output on ADAAAA-7594. Expected:"
echo "  * fix markers present in /app/services/media/src/rtc.ts"
echo "  * [rtc] frame lines with frames>=3 while a browser stream is live"
echo "  * [rtc] obs lines with liveMs in the 1-5s live target"
echo "  * [rtc] audio lines with audioPackets>0 once the browser sends its audio track"
echo "  * --fault: restarts unchanged, no exit, write-failed warn present"

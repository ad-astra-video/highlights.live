#!/usr/bin/env bash
# ADAAAA-8051: launch path for the media-rail replay driver.
#
# Every QA replay goes through this script so a replay can never leave an orphan:
#
#   1. the canonical driver (services/media/drive-8035.mjs) is copied into the
#      media container before launch, so the container always runs the fixed
#      file even after a container recreate (no image deploy needed);
#   2. the driver pid is recorded in /state/drive-<sid>.pid inside the container;
#   3. an EXIT/INT/TERM/HUP trap SIGTERMs (then SIGKILLs) that pid and removes
#      the pid file on every exit path, including a failed launch or a Ctrl-C;
#   4. --sweep reaps any pid recorded by an earlier run that outlived its
#      launcher (crash, killed run).
#
# The container image (node:24-slim) has no procps, so liveness is checked with
# the shell builtin `kill -0` and the pid file is the process table.
#
# Usage:
#   qa-drive-8035.sh --sid <mediaSessionId> [--seconds 300] [--log /state/drive-<sid>.log]
#                    [--ivf /state/kids300.vp8.ivf] [--audio-src /state/kids300_7935.mp4]
#                    [--audio-port 5621] [--fps 30] [--no-wait]
#   qa-drive-8035.sh --ps       # list recorded drivers (sid, pid, alive)
#   qa-drive-8035.sh --sweep    # SIGTERM+SIGKILL every recorded driver
#
# Exit codes: 0 replay finished and the driver is gone; 7 driver survived the
# window and had to be killed; 2 usage/launch error.
set -u

CONTAINER="${CONTAINER:-highlights-media}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DRIVER="${DRIVER:-$HERE/../services/media/drive-8035.mjs}"
CTR_DIR="/app/services/media"
MEDIA_BASE="${MEDIA_BASE:-http://127.0.0.1:4070}"

SID=""
SECONDS_REPLAY=300
LOG=""
IVF="/state/kids300.vp8.ivf"
AUDIO_SRC="/state/kids300_7935.mp4"
AUDIO_PORT=5621
FPS=30
WAIT=1
MODE="run"

usage() {
  sed -n '20,30p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --sid) SID="${2:-}"; shift 2 ;;
    --seconds) SECONDS_REPLAY="${2:-}"; shift 2 ;;
    --log) LOG="${2:-}"; shift 2 ;;
    --ivf) IVF="${2:-}"; shift 2 ;;
    --audio-src) AUDIO_SRC="${2:-}"; shift 2 ;;
    --audio-port) AUDIO_PORT="${2:-}"; shift 2 ;;
    --fps) FPS="${2:-}"; shift 2 ;;
    --no-wait) WAIT=0; shift ;;
    --ps) MODE="ps"; shift ;;
    --sweep) MODE="sweep"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "qa-drive: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

ctr_exec() { docker exec "$CONTAINER" sh -c "$1"; }
alive() { ctr_exec "kill -0 $1" >/dev/null 2>&1; }

# All pid files this launcher family has written, as "sid:pid" lines.
recorded() {
  ctr_exec 'for f in /state/drive-*.pid; do [ -f "$f" ] || continue; echo "$(basename "$f" .pid | sed "s/^drive-//"):$(cat "$f")"; done' 2>/dev/null
}

if [ "$MODE" = "ps" ]; then
  n=0
  while IFS=: read -r sid pid; do
    [ -n "${pid:-}" ] || continue
    if alive "$pid"; then echo "sid=$sid pid=$pid alive=yes"; else echo "sid=$sid pid=$pid alive=no"; fi
    n=$((n + 1))
  done <<EOF
$(recorded)
EOF
  echo "recorded=$n"
  exit 0
fi

if [ "$MODE" = "sweep" ]; then
  n=0
  while IFS=: read -r sid pid; do
    [ -n "${pid:-}" ] || continue
    if alive "$pid"; then
      echo "qa-drive: sweep SIGTERM sid=$sid pid=$pid"
      ctr_exec "kill -TERM $pid" >/dev/null 2>&1 || true
      for _ in $(seq 1 20); do alive "$pid" || break; sleep 0.25; done
      ctr_exec "kill -KILL $pid" >/dev/null 2>&1 || true
      n=$((n + 1))
    fi
    ctr_exec "rm -f /state/drive-$sid.pid" >/dev/null 2>&1 || true
  done <<EOF
$(recorded)
EOF
  echo "swept=$n"
  exit 0
fi

if [ -z "$SID" ]; then
  echo "qa-drive: --sid is required" >&2
  usage >&2
  exit 2
fi
[ -n "$LOG" ] || LOG="/state/drive-$SID.log"
PIDFILE="/state/drive-$SID.pid"

# 1. Ship the canonical driver into the container (survives container recreate).
if [ -f "$DRIVER" ]; then
  LOCAL_SHA=$(sha256sum "$DRIVER" | cut -d' ' -f1)
  docker cp "$DRIVER" "$CONTAINER:$CTR_DIR/drive-8035.mjs" >/dev/null || { echo "qa-drive: docker cp failed" >&2; exit 2; }
  CTR_SHA=$(ctr_exec "sha256sum $CTR_DIR/drive-8035.mjs | cut -d' ' -f1" 2>/dev/null | tr -d '\r')
  [ "$CTR_SHA" = "$LOCAL_SHA" ] || { echo "qa-drive: driver sha mismatch local=$LOCAL_SHA container=$CTR_SHA" >&2; exit 2; }
else
  echo "qa-drive: no canonical driver at $DRIVER, using the container copy" >&2
fi

PID=""
DETACHED=0
[ "$WAIT" = 1 ] || DETACHED=1
cleanup() {
  # --no-wait is a deliberate detach: the pid file stays for --ps/--sweep.
  if [ "$DETACHED" = 1 ]; then return; fi
  if [ -n "$PID" ] && alive "$PID"; then
    echo "qa-drive: SIGTERM driver sid=$SID pid=$PID"
    ctr_exec "kill -TERM $PID" >/dev/null 2>&1 || true
    for _ in $(seq 1 40); do alive "$PID" || break; sleep 0.25; done
    if alive "$PID"; then
      echo "qa-drive: SIGKILL driver sid=$SID pid=$PID"
      ctr_exec "kill -KILL $PID" >/dev/null 2>&1 || true
    fi
  fi
  ctr_exec "rm -f $PIDFILE" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM HUP

# 2. Launch detached; the container shell records its own pid, then execs node
#    (exec preserves the pid, so the pid file names the driver itself).
ctr_exec "rm -f $PIDFILE" >/dev/null 2>&1 || true
docker exec -d "$CONTAINER" sh -c "cd $CTR_DIR && echo \$\$ > $PIDFILE && exec env MEDIA_BASE=$MEDIA_BASE SID=$SID IVF=$IVF FPS=$FPS SECONDS=$SECONDS_REPLAY AUDIO_SRC=$AUDIO_SRC AUDIO_PORT=$AUDIO_PORT node drive-8035.mjs > $LOG 2>&1" \
  || { echo "qa-drive: docker exec failed" >&2; exit 2; }

for _ in $(seq 1 20); do
  PID=$(ctr_exec "cat $PIDFILE 2>/dev/null" 2>/dev/null | tr -d '\r\n')
  [ -n "$PID" ] && break
  sleep 0.5
done
[ -n "$PID" ] || { echo "qa-drive: driver pid file never appeared ($PIDFILE)" >&2; exit 2; }
echo "qa-drive: started sid=$SID pid=$PID seconds=$SECONDS_REPLAY log=$LOG"

[ "$WAIT" = 1 ] || exit 0

# 3. Wait for the driver to leave on its own; the trap is the backstop.
DEADLINE=$(( $(date +%s) + SECONDS_REPLAY + 120 ))
while alive "$PID"; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "qa-drive: driver sid=$SID pid=$PID outlived $SECONDS_REPLAY s + 120 s" >&2
    exit 7
  fi
  sleep 3
done

echo "qa-drive: driver sid=$SID pid=$PID exited on its own"
ctr_exec "tail -n 6 $LOG" 2>/dev/null || true
PID=""
exit 0

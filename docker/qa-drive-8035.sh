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
#                    [--evidence-dir <host dir>]
#   qa-drive-8035.sh --ps       # list recorded drivers (sid, pid, alive)
#   qa-drive-8035.sh --sweep    # SIGTERM+SIGKILL every recorded driver
#   qa-drive-8035.sh --boot-only [--sid <sid>] [--evidence-dir <dir>]
#                               # capture this boot's identity into <dir>/boot.txt
#                               # and exit: no leg, no session, no frames
#   qa-drive-8035.sh --evidence-end --sid <sid> [--evidence-dir <dir>]
#                               # append the leg-end re-read of StartedAt + the
#                               # boot line to that leg's boot.txt
#
# Boot evidence (ADAAAA-8163): every leg now records, BEFORE the drive starts,
# the server's `[boot] live decide window: N s span / M ms cadence` line,
# `docker inspect <server> .State.StartedAt`, the inspect `LogPath` and the five
# LIVE_OBSERVE_* env values, into <evidence-dir>/boot.txt (plus a durable
# boot-<sid>.txt). Both strings otherwise live only in the SERVER container's
# json.log, which docker deletes when a peer recreate replaces that container
# (ADAAAA-8145: boot 00:46:58Z, replaced 01:07:24Z, so AC1/AC6 graded
# `not_captured`). <evidence-dir> defaults to the host dir the media container
# mounts at /state — the same dir the driver's own STREAM_DONE/DRIVE_EXIT log
# (drive-<sid>.log) lands in — and can be overridden with --evidence-dir or
# $EVIDENCE_DIR. A foreground leg appends the leg-end re-read on exit; a
# `--no-wait` leg emits it when the launcher runs --evidence-end at leg end.
# This is additive: the drive path, its output lines and its knobs are unchanged
# and nothing here starts a session or sends a frame.
#
# Exit codes: 0 replay finished and the driver is gone; 7 driver survived the
# window and had to be killed; 2 usage/launch error.
set -u

CONTAINER="${CONTAINER:-highlights-media}"
# ADAAAA-8163: the server whose boot line + StartedAt AC1/AC6 grade.
SERVER="${SERVER_CONTAINER:-highlights-server}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DRIVER="${DRIVER:-$HERE/../services/media/drive-8035.mjs}"
CTR_DIR="/app/services/media"
MEDIA_BASE="${MEDIA_BASE:-http://127.0.0.1:4070}"
# ADAAAA-8163: where the leg's boot evidence goes. Empty = derive it (see
# evidence_dir): the host dir the media container mounts at /state, otherwise
# a /tmp fallback. Overridable with --evidence-dir or $EVIDENCE_DIR.
EVIDENCE_DIR="${EVIDENCE_DIR:-}"

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
  # Marker-based so a doc edit above cannot silently truncate the help text.
  sed -n '/^# Usage:/,/^# Exit codes:/p' "$0"
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
    --boot-only) MODE="boot"; shift ;;
    --evidence-end) MODE="evidend"; shift ;;
    --evidence-dir) EVIDENCE_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "qa-drive: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

ctr_exec() { docker exec "$CONTAINER" sh -c "$1"; }
alive() { ctr_exec "kill -0 $1" >/dev/null 2>&1; }

# --- ADAAAA-8163: per-leg boot evidence --------------------------------------
# AC1 grades `[boot] live decide window: N s span / M ms cadence` and AC6 grades
# `State.StartedAt`. Both strings live only in the SERVER container's json.log,
# and docker deletes that file when the container is removed/recreated, so any
# peer launcher that recreates `server` after a leg erases the leg's own boot
# identity (ADAAAA-8145). Capture it while that boot is alive.
BOOT_KEYS="LIVE_OBSERVE_WINDOW_S LIVE_OBSERVE_CADENCE_S LIVE_OBSERVE_MAX_FRAMES LIVE_OBSERVE_IN_FLIGHT LIVE_OBSERVE_CONTENT_FPS LIVE_FRAME_SCALE"
BOOT_PATTERN='[boot] live decide window'
# ADAAAA-8377 (LFR-1): the frame-scale axis. A leg's ON arm is graded from its
# decide rows' measured imageW/imageH, but the boot line states what the serving
# process RESOLVED, and `STATE.StartedAt` + this line are what prove the leg did
# not straddle a recreate that changed the scale.
BOOT_SCALE_PATTERN='[boot] live frame scale'
EVID_ACTIVE=0
EVID_FILE=""

server_started() { docker inspect "$SERVER" --format '{{.State.StartedAt}}' 2>/dev/null | tr -d '\r\n'; }
server_logpath() { docker inspect "$SERVER" --format '{{.LogPath}}' 2>/dev/null | tr -d '\r\n'; }
server_boot_line() { docker logs "$SERVER" 2>&1 | grep -F "$BOOT_PATTERN" | tail -n 1 | tr -d '\r'; }
server_scale_line() { docker logs "$SERVER" 2>&1 | grep -F "$BOOT_SCALE_PATTERN" | tail -n 1 | tr -d '\r'; }

# The host dir the media container mounts at /state: the dir the driver's own
# drive-<sid>.log (STREAM_DONE/DRIVE_EXIT) is written into. A recreate replaces
# the container, not this bind mount, which is what makes boot.txt durable.
state_host_dir() {
  docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/state"}}{{.Source}}{{end}}{{end}}' 2>/dev/null | tr -d '\r\n'
}

evidence_dir() {
  if [ -n "$EVIDENCE_DIR" ]; then printf '%s' "$EVIDENCE_DIR"; return 0; fi
  local d
  d="$(state_host_dir)"
  [ -n "$d" ] || d="${TMPDIR:-/tmp}/hl-leg-evidence"
  printf '%s' "$d"
}

# The five LIVE_OBSERVE_* values, name-complete: an unset key prints `<unset>`
# (a blank line would read as "not captured" and the shipped CONTENT_FPS default
# is deliberately unset in docker/.env). `printenv KEY...` prints bare VALUES
# with no names, so ask for the whole environment and filter — parsing the keyed
# form silently wrote `<unset>` for five keys the server did resolve.
boot_env_lines() {
  local pairs k v
  pairs="$(docker exec "$SERVER" printenv 2>/dev/null | tr -d '\r')" || true
  for k in $BOOT_KEYS; do
    v="$(printf '%s\n' "$pairs" | sed -n "s/^$k=//p" | head -n 1)"
    printf 'ENV %s=%s\n' "$k" "${v:-<unset>}"
  done
}

# evidence_write_start [sid]: write <evidence-dir>/boot.txt (+ boot-<sid>.txt).
evidence_write_start() {
  local sid="${1:-}" dir f tmp line started logpath scale
  dir="$(evidence_dir)"
  mkdir -p "$dir" || { echo "qa-drive: cannot create evidence dir $dir" >&2; return 1; }
  f="$dir/boot.txt"
  tmp="$f.$$.tmp"
  line="$(server_boot_line)"
  scale="$(server_scale_line)"
  started="$(server_started)"
  logpath="$(server_logpath)"
  {
    echo "# ADAAAA-8163 per-leg boot evidence (AC1 boot line + AC6 StartedAt)."
    echo "# Captured BEFORE the leg, while the boot that serves it is still alive:"
    echo "# a later container recreate deletes the removed container's json.log."
    echo "PHASE=start"
    echo "SID=${sid:-<none>}"
    echo "CAPTURED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "SERVER_CONTAINER=$SERVER"
    echo "SERVER_STARTED_AT=${started:-<missing>}"
    echo "SERVER_JSON_LOG=${logpath:-<missing>}"
    echo "BOOT_LINE=${line:-<missing>}"
    # ADAAAA-8377: the frame-scale axis this boot resolved (LFR-1 AC-1/AC-7).
    echo "FRAME_SCALE_LINE=${scale:-<missing>}"
    boot_env_lines
    echo "# ENV <key>=<unset> means the key is absent from the container, i.e. the"
    echo "# shipped default is in force; it is a captured value, not a gap."
  } > "$tmp" && mv "$tmp" "$f" || { echo "qa-drive: cannot write $f" >&2; return 1; }
  # boot.txt is the name the ticket asks for, but the next leg on this box
  # overwrites it, so keep a per-sid copy too.
  [ -n "$sid" ] && cp "$f" "$dir/boot-$sid.txt" 2>/dev/null
  EVID_FILE="$f"
  printf 'qa-drive: boot evidence sid=%s file=%s started_at=%s boot_line=%s\n' \
    "${sid:-<none>}" "$f" "${started:-<missing>}" "${line:-<missing>}"
  return 0
}

# evidence_write_end [sid]: append the leg-end re-read to the same boot.txt and
# say whether it is still the same boot (SAME_BOOT). Idempotent: a repeated call
# replaces the previous end block instead of stacking one.
evidence_write_end() {
  local sid="${1:-}" dir f start_started start_line now_started now_line same
  dir="$(evidence_dir)"
  f="$dir/boot.txt"
  [ -s "$f" ] || { echo "qa-drive: no boot evidence at $f to finish" >&2; return 1; }
  start_started="$(sed -n 's/^SERVER_STARTED_AT=//p' "$f" | head -n 1)"
  start_line="$(sed -n 's/^BOOT_LINE=//p' "$f" | head -n 1)"
  now_started="$(server_started)"
  now_line="$(server_boot_line)"
  [ -n "$now_line" ] || now_line="<missing>"
  if [ -n "$start_started" ] && [ "$start_started" = "$now_started" ]; then same=yes; else same=no; fi
  grep -q '^PHASE=end$' "$f" 2>/dev/null && sed -i '/^PHASE=end$/,$d' "$f"
  {
    echo "PHASE=end"
    echo "END_CAPTURED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "END_SERVER_STARTED_AT=${now_started:-<missing>}"
    echo "END_BOOT_LINE=$now_line"
    echo "SAME_BOOT=$same"
  } >> "$f" || { echo "qa-drive: cannot append to $f" >&2; return 1; }
  [ -n "$sid" ] && cp "$f" "$dir/boot-$sid.txt" 2>/dev/null
  printf 'qa-drive: boot evidence end sid=%s file=%s same_boot=%s started_at=%s boot_line=%s\n' \
    "${sid:-<none>}" "$f" "$same" "${now_started:-<missing>}" "$now_line"
  # A recreate after the leg is exactly the case this guardrail exists for; say
  # it plainly instead of leaving the reader to diff two timestamps.
  if [ "$same" = no ]; then
    echo "qa-drive: boot changed during leg sid=${sid:-<none>} start_started=${start_started:-<missing>} start_boot_line=${start_line:-<missing>}"
  fi
  return 0
}

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

if [ "$MODE" = "boot" ]; then
  # Dry run: write this boot's evidence, print it, and exit. No session, no
  # frames, no leg — the acceptance run for ADAAAA-8163.
  evidence_write_start "${SID:-}" || exit 2
  [ -n "$EVID_FILE" ] && cat "$EVID_FILE"
  exit 0
fi

if [ "$MODE" = "evidend" ]; then
  # Leg end for a `--no-wait` leg: re-read StartedAt + the boot line into the
  # leg's own boot.txt (the foreground path does this from cleanup).
  evidence_write_end "${SID:-}" || exit 2
  exit 0
fi

if [ -z "$SID" ]; then
  echo "qa-drive: --sid is required" >&2
  usage >&2
  exit 2
fi
[ -n "$LOG" ] || LOG="/state/drive-$SID.log"
PIDFILE="/state/drive-$SID.pid"

# ADAAAA-8163: capture the leg's boot identity before anything here can launch
# (a peer recreate after this point cannot erase it). Additive: a capture
# failure is reported but never blocks the drive.
evidence_write_start "$SID" || true
EVID_ACTIVE=1

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
  # ADAAAA-8163: leg end. Re-read StartedAt + the boot line into the same
  # boot.txt and grade SAME_BOOT, so a recreate that lands during the leg is
  # visible in the evidence instead of inferred later. Never changes the exit
  # path: a capture failure only prints.
  if [ "$EVID_ACTIVE" = 1 ]; then
    evidence_write_end "$SID" || true
  fi
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

[ "$WAIT" = 1 ] || {
  # ADAAAA-8163: a detached leg finishes after this launcher exits, so the
  # leg-end evidence re-read (SAME_BOOT) is the leg script's call.
  echo "qa-drive: detached leg; at leg end run $0 --evidence-end --sid $SID${EVIDENCE_DIR:+ --evidence-dir $EVIDENCE_DIR}"
  exit 0
}

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

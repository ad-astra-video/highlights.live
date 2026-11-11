#!/usr/bin/env bash
# ADAAAA-8163 AC2/AC3: behavioural test for the per-leg boot evidence in
# docker/qa-drive-8035.sh. A stub `docker` stands in for the box, so the whole
# capture path — the [boot] live decide window grep, State.StartedAt, the five
# LIVE_OBSERVE_* values, the durable boot.txt, and the leg-end SAME_BOOT re-read
# — is proven without a container, without a session and without a frame.
#
# The case that matters (ADAAAA-8145) is case 3: the evidence file keeps the
# leg's own strings after the server container is rebuilt with a new StartedAt
# and an empty json.log, i.e. exactly the recreate that erased AC1/AC6.
#
# Run: ./docker/qa-drive-boot-evidence.test.sh        (needs python3)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
DRIVER_SH="$HERE/qa-drive-8035.sh"
DRIVER_MJS="$HERE/../services/media/drive-8035.mjs"
WORK="$(mktemp -d)"
STUB_DIR="$WORK/stub"
BIN="$WORK/bin"
EVID="$WORK/evidence"
FAILS=0

trap 'rm -rf "$WORK"' EXIT INT TERM

if [ ! -f "$DRIVER_MJS" ]; then
  printf 'FAIL driver %s missing\n' "$DRIVER_MJS"; exit 1
fi
mkdir -p "$STUB_DIR" "$BIN" "$EVID"

# --- stub docker -------------------------------------------------------------
cat > "$BIN/docker" <<'STUB'
#!/usr/bin/env python3
import hashlib, os, sys

d = os.environ["STUB_DIR"]
args = sys.argv[1:]
with open(os.path.join(d, "calls.log"), "a") as f:
    f.write("docker " + " ".join(args) + "\n")

def rd(name, default=""):
    try:
        return open(os.path.join(d, name)).read()
    except FileNotFoundError:
        return default

def wr(name, val):
    open(os.path.join(d, name), "w").write(str(val))

def out(s):
    sys.stdout.write(s)

def gone():
    return rd("container_exists", "1").strip() == "0"

cmd = args[0] if args else ""

if cmd == "inspect":
    fmt = " ".join(args)
    if ".Mounts" in fmt:
        out(os.path.join(d, "media-state"))
    elif gone():
        sys.stderr.write("Error: No such object: highlights-server\n")
        sys.exit(1)
    elif ".LogPath" in fmt:
        out("/var/lib/docker/containers/deadbeef/deadbeef-json.log")
    elif ".State.StartedAt" in fmt:
        out(rd("started", "2026-11-06T00:46:58.49Z"))
    else:
        out("{}")
    sys.exit(0)

if cmd == "logs":
    if gone():
        sys.stderr.write("Error: No such container: highlights-server\n")
        sys.exit(1)
    out(rd("server.log"))
    sys.exit(0)

if cmd == "cp":
    sys.exit(0)

if cmd == "exec":
    a = args[1:]
    if "-d" in a:
        with open(os.path.join(d, "launches"), "a") as f:
            f.write("launch\n")
        sys.exit(0)
    script = " ".join(a[a.index("sh") + 2:]) if "sh" in a else " ".join(a)
    if "printenv" in script:
        # Real `printenv KEY...` prints bare VALUES with no names, so the stub
        # emulates that too: a driver that parses the keyed form must fail here
        # instead of silently recording <unset> for keys the box resolved.
        keys = [w for w in script.split() if w.startswith("LIVE_")
                or w.startswith("OBSERVE_") or w.startswith("DECIDE_")]
        if keys:
            pairs = dict(l.split("=", 1) for l in rd("env.txt").splitlines() if "=" in l)
            out("".join(pairs.get(k, "") + "\n" for k in keys))
        else:
            out(rd("env.txt"))
        sys.exit(0)
    if "sha256sum" in script:
        h = hashlib.sha256(open(os.environ["STUB_DRIVER"], "rb").read()).hexdigest()
        # The driver pipes through `cut -d' ' -f1`; a stub cannot run the pipe.
        out((h if "cut -d" in script else h + "  /app/services/media/drive-8035.mjs") + "\n")
        sys.exit(0)
    if "kill -0" in script:
        left = int(rd("alive_left", "0").strip() or "0")
        if left > 0:
            wr("alive_left", left - 1); sys.exit(0)
        sys.exit(1)
    if "cat /state/drive-" in script and ".pid" in script:
        out("4242\n"); sys.exit(0)
    if "tail -n 6" in script:
        out("\n".join(rd("driver.log").splitlines()[-6:]) + "\n"); sys.exit(0)
    sys.exit(0)

sys.exit(0)
STUB
chmod +x "$BIN/docker"

mkboot() {
  # mkboot <started-at> [log-lines...]
  started="$1"; shift
  printf '%s' "$started" > "$STUB_DIR/started"
  : > "$STUB_DIR/server.log"
  for line in "$@"; do printf '%s\n' "$line" >> "$STUB_DIR/server.log"; done
}

reset_stub() {
  rm -f "$STUB_DIR/alive_left" "$STUB_DIR/launches" "$STUB_DIR/container_exists" "$STUB_DIR/calls.log"
  printf '2026-11-06T00:46:58.49Z' > "$STUB_DIR/started"
  printf '%s\n' \
    '[boot] live decide image budget: 8 image(s)/decide' \
    '[boot] live decide window: 10 s span / 5000 ms cadence (LIVE_OBSERVE_WINDOW_S default 10)' \
    > "$STUB_DIR/server.log"
  printf '%s\n' \
    'LIVE_OBSERVE_WINDOW_S=10' \
    'LIVE_OBSERVE_CADENCE_S=5' \
    'LIVE_OBSERVE_MAX_FRAMES=8' \
    'LIVE_OBSERVE_IN_FLIGHT=2' \
    > "$STUB_DIR/env.txt"
  printf '%s\n' 'DRIVE_DONE' 'DRIVE_EXIT reason=replay-complete pid=4242 code=0' > "$STUB_DIR/driver.log"
}

drive() {
  # drive [args...] -> stdout, stderr discarded
  env PATH="$BIN:$PATH" STUB_DIR="$STUB_DIR" STUB_DRIVER="$DRIVER_MJS" \
    bash "$DRIVER_SH" "$@" 2>/dev/null
}
drive_rc() { drive "$@" >/dev/null; echo $?; }

fail() { printf 'FAIL %s\n' "$1"; FAILS=$((FAILS + 1)); }
ok() { printf 'ok   %s\n' "$1"; }

expect_substr() { # expect_substr <label> <haystack> <needle>
  case "$2" in
    *"$3"*) ok "$1" ;;
    *) fail "$1 — missing [$3] in: $2"; printf '%s\n' "$2" ;;
  esac
}

# --- case 0: syntax ----------------------------------------------------------
reset_stub
if bash -n "$DRIVER_SH"; then ok "bash -n clean"; else fail "bash -n"; fi

# --- case 1: --help still prints the original usage lines --------------------
help_out="$(drive --help)"
expect_substr "help: --sid usage line" "$help_out" "qa-drive-8035.sh --sid <mediaSessionId>"
expect_substr "help: --ps line" "$help_out" "qa-drive-8035.sh --ps       # list recorded drivers"
expect_substr "help: --sweep line" "$help_out" "qa-drive-8035.sh --sweep    # SIGTERM+SIGKILL every recorded driver"
expect_substr "help: exit codes" "$help_out" "# Exit codes: 0 replay finished and the driver is gone"
expect_substr "help: --boot-only" "$help_out" "qa-drive-8035.sh --boot-only"
expect_substr "help: --evidence-end" "$help_out" "qa-drive-8035.sh --evidence-end"

# --- case 2: dry run writes boot.txt and starts nothing ----------------------
reset_stub
out="$(drive --boot-only --sid s-dry --evidence-dir "$EVID")"
code=$?
[ "$code" = 0 ] || fail "dry run exit=$code expected 0"
expect_substr "dry run prints boot line" "$out" "BOOT_LINE=[boot] live decide window: 10 s span / 5000 ms cadence"
expect_substr "dry run prints StartedAt" "$out" "SERVER_STARTED_AT=2026-11-06T00:46:58.49Z"
for k in LIVE_OBSERVE_WINDOW_S=10 LIVE_OBSERVE_CADENCE_S=5 LIVE_OBSERVE_MAX_FRAMES=8 LIVE_OBSERVE_IN_FLIGHT=2 LIVE_OBSERVE_CONTENT_FPS=\<unset\>; do
  expect_substr "dry run env $k" "$out" "$k"
done
expect_substr "dry run prints json.log path" "$out" "SERVER_JSON_LOG=/var/lib/docker/containers/deadbeef/deadbeef-json.log"
[ -s "$EVID/boot.txt" ] && ok "dry run wrote boot.txt" || fail "dry run wrote no boot.txt"
[ -s "$EVID/boot-s-dry.txt" ] && ok "dry run wrote durable boot-<sid>.txt" || fail "no boot-s-dry.txt"
grep -qx 'PHASE=start' "$EVID/boot.txt" && ok "boot.txt phase=start" || fail "boot.txt missing PHASE=start"
if grep -q '^docker cp ' "$STUB_DIR/calls.log" 2>/dev/null || grep -q ' -d ' "$STUB_DIR/calls.log" 2>/dev/null; then
  fail "dry run shipped/launched the driver"
else
  ok "dry run started no leg (no cp, no detached exec)"
fi
[ -e "$STUB_DIR/launches" ] && fail "dry run launched a driver" || ok "dry run launched no driver"
if grep -qx 'docker exec highlights-server printenv' "$STUB_DIR/calls.log"; then
  ok "env captured with an unkeyed printenv (names included)"
else
  fail "printenv was called with key names; bare values would parse as <unset>"
fi

# --- case 3: post-leg recreate keeps the leg's own strings -------------------
# The recreate ADAAAA-8145 saw: a new container (different StartedAt), old
# json.log deleted (no boot line readable at all).
printf '2026-11-06T01:07:24.00Z' > "$STUB_DIR/started"
: > "$STUB_DIR/server.log"
out="$(drive --evidence-end --sid s-dry --evidence-dir "$EVID")"
code=$?
[ "$code" = 0 ] || fail "evidence-end exit=$code expected 0"
expect_substr "recreate: SAME_BOOT is graded no" "$out" "same_boot=no"
expect_substr "recreate: says the boot changed" "$out" "qa-drive: boot changed during leg sid=s-dry"
expect_substr "recreate: start StartedAt retained" "$(cat "$EVID/boot.txt")" "SERVER_STARTED_AT=2026-11-06T00:46:58.49Z"
expect_substr "recreate: start boot line retained" "$(cat "$EVID/boot.txt")" "BOOT_LINE=[boot] live decide window: 10 s span / 5000 ms cadence"
expect_substr "recreate: end re-read is missing" "$(cat "$EVID/boot.txt")" "END_BOOT_LINE=<missing>"
expect_substr "recreate: durable copy updated" "$(cat "$EVID/boot-s-dry.txt")" "SAME_BOOT=no"
[ "$(grep -c '^PHASE=end$' "$EVID/boot.txt")" = 1 ] && ok "one PHASE=end block" || fail "PHASE=end count $(grep -c '^PHASE=end$' "$EVID/boot.txt")"

# --- case 4: --evidence-end is idempotent -----------------------------------
drive --evidence-end --sid s-dry --evidence-dir "$EVID" >/dev/null
[ "$(grep -c '^PHASE=end$' "$EVID/boot.txt")" = 1 ] && ok "repeated end re-read does not stack" || fail "repeated end stacked"

# --- case 5: same boot across a leg reads SAME_BOOT=yes ---------------------
reset_stub
printf '1' > "$STUB_DIR/alive_left"
out="$(drive --sid s-run --seconds 1 --evidence-dir "$EVID")"
code=$?
[ "$code" = 0 ] || fail "foreground run exit=$code expected 0"
expect_substr "run: unchanged started line" "$out" "qa-drive: started sid=s-run pid=4242 seconds=1 log=/state/drive-s-run.log"
expect_substr "run: unchanged exit line" "$out" "qa-drive: driver sid=s-run pid=4242 exited on its own"
expect_substr "run: still tails the driver log" "$out" "DRIVE_EXIT reason=replay-complete pid=4242 code=0"
expect_substr "run: SAME_BOOT=yes" "$(cat "$EVID/boot.txt")" "SAME_BOOT=yes"
grep -qx 'SAME_BOOT=yes' "$EVID/boot.txt" && ok "foreground leg recorded its own end block" || fail "no SAME_BOOT=yes"
[ -e "$STUB_DIR/launches" ] && ok "foreground run launched the driver" || fail "foreground run did not launch"

# --- case 6: a detached leg leaves the end block to --evidence-end ----------
reset_stub
printf '0' > "$STUB_DIR/alive_left"
out="$(drive --sid s-det --seconds 1 --no-wait --evidence-dir "$EVID")"
code=$?
[ "$code" = 0 ] || fail "detached run exit=$code expected 0"
expect_substr "detached: start evidence written" "$out" "boot evidence sid=s-det"
expect_substr "detached: points at --evidence-end" "$out" "at leg end run"
grep -qx 'PHASE=start' "$EVID/boot.txt" && ok "detached boot.txt is start-only" || fail "detached boot.txt not start-only"
grep -q '^PHASE=end$' "$EVID/boot.txt" && fail "detached leg recorded an end block early" || ok "detached leg recorded no end block"

# --- case 7: existing --ps / --sweep paths are untouched --------------------
reset_stub
ps_out="$(drive --ps)"
expect_substr "ps: unchanged output" "$ps_out" "recorded=0"
sw_out="$(drive --sweep)"
expect_substr "sweep: unchanged output" "$sw_out" "swept=0"

# --- case 8: a missing server container does not fail the dry run -----------
reset_stub
printf '0' > "$STUB_DIR/container_exists"
out="$(drive --boot-only --sid s-gone --evidence-dir "$EVID")"
code=$?
[ "$code" = 0 ] || fail "missing server: dry run exit=$code expected 0"
expect_substr "missing server: boot line named missing" "$out" "BOOT_LINE=<missing>"
expect_substr "missing server: StartedAt named missing" "$out" "SERVER_STARTED_AT=<missing>"

if [ "$FAILS" -ne 0 ]; then
  printf '\n%s boot-evidence case(s) FAILED\n' "$FAILS"
  exit 1
fi
printf '\nall boot-evidence cases passed\n'

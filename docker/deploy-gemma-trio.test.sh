#!/usr/bin/env bash
# deploy-gemma-trio.test.sh - behavioural test for docker/deploy-gemma-trio.sh
# (ADAAAA-8608 AC2/AC3).
#
# The script is docker + nvidia-smi + python3 against a host we cannot mutate
# from a heartbeat, so the test puts stub `docker` and `nvidia-smi` binaries on
# PATH and drives the REAL script against fixture containers. That proves, at
# $0 and with no GPU:
#
#   - a clean trio exits 0 and prints the Cmd diff (AC1 shape)
#   - a drifted `--max-num-seqs`, `--gpu-memory-utilization` or read-only model
#     mount exits 8 and NAMES the field (AC2) without touching a container
#   - `apply` on a clean trio is a NO-OP: no `docker rm`, no `docker run`
#   - `apply` on a drifted trio recreates exactly the drifted worker, prints the
#     guard read, StartedAt before/after, RestartCount and health (AC3 shape)
#   - the idle guard refuses (exit 3) on GPU util, engine log `Running: N`, or
#     JOBS_ACTIVE != 0, and fails CLOSED (exit 5) when JOBS_ACTIVE is unreadable
#
# Run: ./docker/deploy-gemma-trio.test.sh        (needs python3)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/deploy-gemma-trio.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/trio-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
STATE="$WORK/state"
STUB="$WORK/stub"
mkdir -p "$STATE" "$STUB"
FAILS=0
CASE=""

ok() { printf 'PASS %s\n' "$1"; }
bad() { printf 'FAIL %s: %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); }
begin() { CASE="$1"; : >"$STATE/calls.log"; rm -f "$STATE"/*.json "$STATE"/*.logs 2>/dev/null || true; }

fixture() {
  # fixture <worker-index> [seqs] [util] [mount-rw]
  python3 - "$STATE" "$1" "${2:-}" "${3:-}" "${4:-}" <<'PY'
import json, sys
state, idx, seqs, util, rw = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
seqs = seqs or ["4", "4", "4"][idx]
util = util or ["0.50", "0.85", "0.50"][idx]
cmd = [
    "serve", "/models/gemma-4-12b-it-qat-AWQ-INT4",
    "--served-model-name", "cyankiwi/gemma-4-12B-it-qat-AWQ-INT4",
    "--host", "0.0.0.0",
    "--port", "8088",
    "--max-num-seqs", seqs,
    "--max-model-len", "32768",
    "--gpu-memory-utilization", util,
    "--kv-cache-dtype", "float16",
    "--limit-mm-per-prompt", '{"image": 64, "audio": 1, "video": 0}',
    "--mm-processor-kwargs", '{"max_soft_tokens": 280}',
    "--trust-remote-code",
]
doc = [{
    "Name": "/gemma-gpu%d" % idx,
    "Image": "sha256:fixture",
    "Created": "2026-11-10T20:35:46.032990777Z",
    "RestartCount": 0,
    "Config": {"Image": "gemma4-vllm-patched-audio:local", "Entrypoint": ["vllm"], "Cmd": cmd},
    "HostConfig": {
        "NetworkMode": "hl5090",
        "ShmSize": 17179869184,
        "RestartPolicy": {"Name": "unless-stopped"},
        "DeviceRequests": [{"Capabilities": [["gpu"]], "Count": 0, "DeviceIDs": [str(idx)]}],
        "PortBindings": {},
        "Privileged": False,
        "IpcMode": "private",
    },
    "Mounts": [{"Type": "bind", "Source": "/srv/hl5090/models", "Destination": "/models",
                "RW": rw == "rw", "Propagation": "rprivate"}],
    "State": {"Status": "running", "StartedAt": "2026-11-10T20:35:46.149622572Z"},
}]
json.dump(doc, open("%s/gemma-gpu%d.json" % (state, idx), "w"))
PY
}

# --- stub docker -------------------------------------------------------------
cat >"$STUB/docker" <<'SH'
#!/usr/bin/env bash
STATE="${TRIO_TEST_STATE:?}"
echo "docker $*" >>"$STATE/calls.log"
cmd=${1:-}
case "$cmd" in
  inspect)
    name=$2
    [ -f "$STATE/$name.json" ] || { echo "Error: No such object: $name" >&2; exit 1; }
    cat "$STATE/$name.json"
    ;;
  logs)
    name=${@: -1}
    [ -f "$STATE/$name.logs" ] && cat "$STATE/$name.logs"
    exit 0
    ;;
  exec)
    name=$2
    shift 2
    if [ "$1" = curl ]; then echo "${TRIO_TEST_HEALTH_CODE:-200}"; fi
    exit 0
    ;;
  rm)
    name=${@: -1}
    rm -f "$STATE/$name.json"
    echo "removed $name"
    ;;
  run)
    shift
    name=""; image=""; net=""; shm=""; restart=""; gpus=""; mount=""; ep=""; args=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) name=$2; shift 2 ;;
        --network) net=$2; shift 2 ;;
        --shm-size) shm=$2; shift 2 ;;
        --restart) restart=$2; shift 2 ;;
        --gpus) gpus=$2; shift 2 ;;
        -v) mount=$2; shift 2 ;;
        --entrypoint) ep=$2; shift 2 ;;
        -d) shift ;;
        *) image=$1; shift; args=("$@"); break ;;
      esac
    done
    printf '%s' "$image" >"$STATE/last_run_image"
    printf '%s\n' "$gpus" >"$STATE/last_run_gpus"
    printf '%s\n' "$mount" >"$STATE/last_run_mount"
    printf '%s\n' "$ep" >"$STATE/last_run_ep"
    printf '%s\n' "${args[@]}" >"$STATE/last_run_argv"
    python3 - "$STATE" "$name" "$image" "$net" "$shm" "$restart" "$gpus" "$mount" "$ep" "${args[@]}" <<'PY'
import json, sys, time
state, name, image, net, shm, restart, gpus, mount, ep = sys.argv[1:10]
argv = sys.argv[10:]
idx = gpus.split("=")[-1] if gpus else "0"
src, dst = mount.rsplit(":", 1)[0].split(":", 1) if mount.count(":") >= 2 else (mount, "")
doc = [{
    "Name": "/" + name, "Image": "sha256:new", "RestartCount": 0,
    "Config": {"Image": image, "Entrypoint": [ep] if ep else None, "Cmd": argv},
    "HostConfig": {
        "NetworkMode": net, "ShmSize": 16 * 1024 ** 3,
        "RestartPolicy": {"Name": restart},
        "DeviceRequests": [{"Capabilities": [["gpu"]], "Count": 0, "DeviceIDs": [idx]}],
        "PortBindings": {}, "Privileged": False, "IpcMode": "private",
    },
    "Mounts": [{"Type": "bind", "Source": src, "Destination": dst, "RW": not mount.endswith(":ro")}],
    "State": {"Status": "running", "StartedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000000000Z", time.gmtime())},
}]
json.dump(doc, open("%s/%s.json" % (state, name), "w"))
PY
    echo "sha256:new"
    ;;
  *)
    exit 0
    ;;
esac
SH

cat >"$STUB/nvidia-smi" <<'SH'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    --id=*) id=${a#--id=} ;;
  esac
done
util="${!TRIO_TEST_UTIL_VAR:-}"
[ -z "${util:-}" ] && util=0
echo "${id:-0}, ${util} %, 16818 MiB"
SH
chmod +x "$STUB/docker" "$STUB/nvidia-smi"

run() { # run <mode> [extra env assignments...]
  local mode=$1
  shift
  env PATH="$STUB:$PATH" TRIO_TEST_STATE="$STATE" LOG="$WORK/apply.log" \
      HEALTH_POLL_S=0 HEALTH_TIMEOUT_S=1 "$@" bash "$SCRIPT" "$mode"
}

# 1. clean trio ---------------------------------------------------------------
begin "check: clean trio exits 0"
fixture 0; fixture 1; fixture 2
out=$(run check 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "$CASE (exit 0)" || bad "$CASE" "exit $rc: $out"
printf '%s' "$out" | grep -q "check PASS" && ok "$CASE prints PASS" || bad "$CASE" "no PASS line"
printf '%s' "$out" | grep -q 'cmd gemma-gpu0 live=\["serve"' && ok "$CASE prints the Cmd" || bad "$CASE" "no Cmd line"
[ -s "$STATE/calls.log" ] && ! grep -qE '^docker (rm|run)' "$STATE/calls.log" \
  && ok "$CASE made no mutating docker call" || bad "$CASE" "mutating docker call in check"

# 2. drifted --max-num-seqs ---------------------------------------------------
begin "check: --max-num-seqs 3 exits 8 naming the field"
fixture 0 3; fixture 1; fixture 2
out=$(run check 2>&1); rc=$?
[ "$rc" -eq 8 ] && ok "$CASE (exit 8)" || bad "$CASE" "exit $rc"
printf '%s' "$out" | grep -q 'DRIFT gemma-gpu0 field=--max-num-seqs live=3 declared=4' \
  && ok "$CASE names the field" || bad "$CASE" "field not named: $out"
printf '%s' "$out" | grep -q 'DRIFT gemma-gpu1 field=--max-num-seqs' \
  && bad "$CASE" "reported drift on a clean worker" || ok "$CASE only the drifted worker"
grep -qE '^docker (rm|run)' "$STATE/calls.log" && bad "$CASE" "container touched" || ok "$CASE touched no container"
[ -f "$STATE/gemma-gpu0.json" ] && ok "$CASE container still present" || bad "$CASE" "container gone"

# 3. drifted --gpu-memory-utilization ----------------------------------------
begin "check: --gpu-memory-utilization 0.60 exits 8 naming the field"
fixture 0; fixture 1 "" 0.60; fixture 2
out=$(run check 2>&1); rc=$?
[ "$rc" -eq 8 ] && ok "$CASE (exit 8)" || bad "$CASE" "exit $rc"
printf '%s' "$out" | grep -q 'DRIFT gemma-gpu1 field=--gpu-memory-utilization live=0.60 declared=0.85' \
  && ok "$CASE names the field" || bad "$CASE" "field not named"

# 4. writable model mount -----------------------------------------------------
begin "check: a writable /models mount exits 8"
fixture 0; fixture 1; fixture 2 "" "" rw
out=$(run check 2>&1); rc=$?
[ "$rc" -eq 8 ] && ok "$CASE (exit 8)" || bad "$CASE" "exit $rc"
printf '%s' "$out" | grep -q 'DRIFT gemma-gpu2 field=models-mount' \
  && ok "$CASE names models-mount" || bad "$CASE" "field not named"

# 5. apply on a clean trio is a no-op ----------------------------------------
begin "apply: clean trio is a no-op"
fixture 0; fixture 1; fixture 2
out=$(run apply JOBS_ACTIVE=0 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "$CASE (exit 0)" || bad "$CASE" "exit $rc: $out"
[ "$(printf '%s' "$out" | grep -c '=== NO-OP')" -eq 3 ] && ok "$CASE three NO-OP lines" || bad "$CASE" "NO-OP count wrong"
printf '%s' "$out" | grep -q 'nothing drifted, no container recreated' && ok "$CASE says no-op" || bad "$CASE" "no no-op summary"
grep -qE '^docker (rm|run)' "$STATE/calls.log" && bad "$CASE" "recreated a clean container" || ok "$CASE no docker rm/run"

# 6. plan on a clean trio touches nothing ------------------------------------
begin "plan: clean trio touches nothing"
fixture 0; fixture 1; fixture 2
out=$(run plan JOBS_ACTIVE=0 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "$CASE (exit 0)" || bad "$CASE" "exit $rc: $out"
printf '%s' "$out" | grep -q 'plan complete: 0 worker' && ok "$CASE plans nothing" || bad "$CASE" "plan summary wrong"
grep -qE '^docker (rm|run)' "$STATE/calls.log" && bad "$CASE" "mutated" || ok "$CASE no mutation"

# 7. apply recreates only the drifted worker ---------------------------------
begin "apply: recreates the drifted worker with guard + before/after evidence"
fixture 0 3; fixture 1; fixture 2
out=$(run apply JOBS_ACTIVE=0 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "$CASE (exit 0)" || bad "$CASE" "exit $rc: $out"
printf '%s' "$out" | grep -q '=== GUARD gemma-gpu0' && ok "$CASE prints the guard read" || bad "$CASE" "no guard line"
printf '%s' "$out" | grep -q 'JOBS_ACTIVE|0' && ok "$CASE includes JOBS_ACTIVE" || bad "$CASE" "no JOBS_ACTIVE"
printf '%s' "$out" | grep -q '=== BEFORE gemma-gpu0 started=' && ok "$CASE prints StartedAt before" || bad "$CASE" "no BEFORE"
printf '%s' "$out" | grep -q '=== AFTER gemma-gpu0 started=.*restarts=0 health=200' \
  && ok "$CASE prints StartedAt/RestartCount/health after" || bad "$CASE" "no AFTER line"
grep -qE '^docker run -d --name gemma-gpu0 ' "$STATE/calls.log" && ok "$CASE ran gpu0" || bad "$CASE" "gpu0 not recreated"
grep -qE '^docker run -d --name gemma-gpu[12] ' "$STATE/calls.log" \
  && bad "$CASE" "recreated a clean worker" || ok "$CASE left clean workers alone"
[ "$(cat "$STATE/last_run_image")" = "gemma4-vllm-patched-audio:local" ] && ok "$CASE declares the image" || bad "$CASE" "wrong image"
[ "$(cat "$STATE/last_run_gpus")" = "device=0" ] && ok "$CASE pins the GPU" || bad "$CASE" "wrong --gpus"
[ "$(cat "$STATE/last_run_mount")" = "/srv/hl5090/models:/models:ro" ] && ok "$CASE mounts models read-only" || bad "$CASE" "wrong mount"
[ "$(cat "$STATE/last_run_ep")" = "vllm" ] && ok "$CASE sets --entrypoint vllm" || bad "$CASE" "wrong entrypoint"
grep -qx -- '--max-num-seqs' "$STATE/last_run_argv" && ok "$CASE passes the declared argv" || bad "$CASE" "argv missing --max-num-seqs"
out2=$(run check 2>&1); rc2=$?
[ "$rc2" -eq 0 ] && ok "$CASE recreated container passes check" || bad "$CASE" "post-apply check exit $rc2: $out2"

# 8. guard: GPU busy ---------------------------------------------------------
begin "apply: refuses when the GPU is not idle"
fixture 0 3; fixture 1; fixture 2
out=$(run apply JOBS_ACTIVE=0 TRIO_TEST_UTIL_VAR=TRIO_UTIL TRIO_UTIL=7 2>&1); rc=$?
[ "$rc" -eq 3 ] && ok "$CASE (exit 3)" || bad "$CASE" "exit $rc: $out"
printf '%s' "$out" | grep -q 'REFUSED gemma-gpu0 guard failed: gpu-busy' && ok "$CASE names gpu-busy" || bad "$CASE" "reason missing"
grep -qE '^docker (rm|run)' "$STATE/calls.log" && bad "$CASE" "mutated while busy" || ok "$CASE nothing recreated"

# 9. guard: engine log shows Running: N --------------------------------------
begin "apply: refuses when the engine log shows Running: 2"
fixture 0 3; fixture 1; fixture 2
printf 'INFO ... Running: 2 reqs, waiting: 0\n' >"$STATE/gemma-gpu0.logs"
out=$(run apply JOBS_ACTIVE=0 2>&1); rc=$?
[ "$rc" -eq 3 ] && ok "$CASE (exit 3)" || bad "$CASE" "exit $rc: $out"
printf '%s' "$out" | grep -q 'engine-running' && ok "$CASE names engine-running" || bad "$CASE" "reason missing"

# 10. guard: JOBS_ACTIVE != 0 ------------------------------------------------
begin "apply: refuses when JOBS_ACTIVE is not 0"
fixture 0 3; fixture 1; fixture 2
out=$(run apply JOBS_ACTIVE=2 2>&1); rc=$?
[ "$rc" -eq 3 ] && ok "$CASE (exit 3)" || bad "$CASE" "exit $rc: $out"
printf '%s' "$out" | grep -q 'jobs-active' && ok "$CASE names jobs-active" || bad "$CASE" "reason missing"

# 11. guard: JOBS_ACTIVE unreadable fails CLOSED -----------------------------
begin "apply: fails closed when JOBS_ACTIVE is unreadable"
fixture 0 3; fixture 1; fixture 2
out=$(run apply 2>&1); rc=$?
[ "$rc" -eq 5 ] && ok "$CASE (exit 5)" || bad "$CASE" "exit $rc: $out"
printf '%s' "$out" | grep -q 'JOBS_ACTIVE unknown' && ok "$CASE explains the read" || bad "$CASE" "no explanation"
grep -qE '^docker (rm|run)' "$STATE/calls.log" && bad "$CASE" "mutated with no guard" || ok "$CASE nothing recreated"

# 12. JOBS_ACTIVE_CMD is honoured --------------------------------------------
begin "apply: JOBS_ACTIVE_CMD supplies the guard read"
fixture 0 3; fixture 1; fixture 2
out=$(run apply JOBS_ACTIVE_CMD='echo JOBS_ACTIVE\|0' 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "$CASE (exit 0)" || bad "$CASE" "exit $rc: $out"
printf '%s' "$out" | grep -q 'JOBS_ACTIVE|0 (cmd JOBS_ACTIVE_CMD)' && ok "$CASE records the provenance" || bad "$CASE" "provenance missing"

# 13. guard mode on an idle box ----------------------------------------------
begin "guard: idle trio passes and touches nothing"
fixture 0; fixture 1; fixture 2
out=$(run guard JOBS_ACTIVE=0 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "$CASE (exit 0)" || bad "$CASE" "exit $rc: $out"
[ "$(printf '%s' "$out" | grep -c '=== GUARD gemma-gpu')" -eq 3 ] && ok "$CASE one line per worker" || bad "$CASE" "guard line count wrong"
printf '%s' "$out" | grep -q 'guard PASS: all 3 workers idle' && ok "$CASE says idle" || bad "$CASE" "no PASS line"
grep -qE '^docker (rm|run)' "$STATE/calls.log" && bad "$CASE" "mutated" || ok "$CASE no mutation"

# 14. guard mode refuses a busy worker --------------------------------------
begin "guard: busy GPU exits 3"
fixture 0; fixture 1; fixture 2
out=$(run guard JOBS_ACTIVE=0 TRIO_TEST_UTIL_VAR=TRIO_UTIL TRIO_UTIL=9 2>&1); rc=$?
[ "$rc" -eq 3 ] && ok "$CASE (exit 3)" || bad "$CASE" "exit $rc: $out"
printf '%s' "$out" | grep -q '=== BUSY gemma-gpu0 reasons=gpu-busy' && ok "$CASE names gpu-busy" || bad "$CASE" "reason missing"

# 15. usage ------------------------------------------------------------------
begin "usage: unknown mode exits 2"
out=$(run nonsense 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "$CASE (exit 2)" || bad "$CASE" "exit $rc"

printf '\n%s: %d case(s) failed\n' "$(basename "$0")" "$FAILS"
[ "$FAILS" -eq 0 ] || exit 1
exit 0

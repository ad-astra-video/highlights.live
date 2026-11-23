#!/usr/bin/env bash
# ADAAAA-8608 - the 5090 gemma trio (gemma-gpu0/1/2 on <DECIDE_HOST>) as
# infra-as-code, in the shape of /srv/hl5090/deploy-decide-pool-8344.sh.
#
# Why this exists: the trio are ad-hoc `docker run` containers with no compose
# project label, no compose file, no systemd unit and no cron that starts them
# (ADAAAA-8568 AC1). The whole spec lives in each container's immutable
# Config.Cmd, so every `--max-num-seqs` / `--gpu-memory-utilization` change had
# to be reconstructed by hand from `docker inspect` - done twice in one day
# (2 -> 4 at 08:37Z, reverted 08:54Z, re-landed 18:40Z, re-proved 20:35Z).
# This script makes the spec a diff instead:
#
#   check   READ-ONLY. Diff each live Config.Cmd (and the surrounding run
#           config) against the declared spec below, print per-field drift and
#           the argv diff, exit non-zero on mismatch. Touches no container and
#           writes nothing outside a /tmp scratch dir, so it is safe to run from
#           any heartbeat.
#   status  READ-ONLY. One line per worker: image, GPU, StartedAt, health.
#   guard   READ-ONLY. Print the idle-guard line per worker (GPU util, engine
#           log `Running: N`, JOBS_ACTIVE) and exit 3 if any worker is busy.
#           This is the read `apply` makes before a recreate, on its own - so a
#           heartbeat can prove the box is idle without planning a mutation.
#   plan    Every read `apply` does (drift + idle guard), then what it WOULD do.
#           Never mutates.
#   apply   Idle-guarded recreate, ONE WORKER AT A TIME: drift, guard, recreate
#           on the declared spec, `/health` 200 within HEALTH_TIMEOUT_S, then
#           StartedAt + RestartCount. A worker whose live config already equals
#           the declared spec is a NO-OP - `apply` never recreates a clean
#           container, so running it when nothing drifted is inert.
#
# Usage (as root, on the 5090 host, <DECIDE_HOST>):
#   /srv/hl5090/deploy-gemma-trio.sh check        # exit 0 clean, 8 drift
#   /srv/hl5090/deploy-gemma-trio.sh status
#   /srv/hl5090/deploy-gemma-trio.sh plan
#   /srv/hl5090/deploy-gemma-trio.sh apply
#
# Exit codes:
#   0  clean / apply completed
#   2  usage error
#   3  idle guard refused (a worker is busy; nothing was recreated)
#   5  JOBS_ACTIVE unreadable - the guard fails CLOSED (see below)
#   6  recreate failed (container did not come up on the declared image)
#   7  /health did not answer 200 within HEALTH_TIMEOUT_S
#   8  drift found by `check`
#
# The idle guard (AC3) reads three surfaces before touching a worker:
#   1. `nvidia-smi --id=N` utilization = 0 %
#   2. `docker logs --since 5m gemma-gpuN | grep -c 'Running: [1-9]'` = 0
#   3. JOBS_ACTIVE|0 from the production Postgres on the x99 host
# The 5090 host has NO psql client, no local Postgres container and no route to
# x99:5432 (measured 2026-11-23), so the third read CANNOT be done in-process.
# It must be supplied - either `JOBS_ACTIVE=0` after an operator read it, or
# `JOBS_ACTIVE_CMD='<command that prints JOBS_ACTIVE|<n>>'`. With neither, apply
# exits 5 instead of guessing: a guard that silently reports a clear runway is
# how a recreate strands a live leg. The x99 read is:
#
#   docker exec -i highlights-postgres psql -U highlights -d highlights -tA <<'SQL'
#   select 'JOBS_ACTIVE|' || count(*) from jobs
#   where (record::jsonb->>'completedAt') is null
#     and (record::jsonb->>'status') in
#         ('queued','active','extracting','analyzing','finalizing');
#   SQL
#
# Spend: $0. No image build, no job, no paid leg, no router change, no
# registrar touch. The registrar (trio advertises 4+4+4 = 12) remains the
# capacity source of truth; this script's drift check is deliberately
# independent of it.
#
# Overridable env: IMAGE, NETWORK, SHM_SIZE, RESTART, MODELS_SRC, MODELS_DST,
# MODEL_DIR, SERVED_NAME, MAX_NUM_SEQS ("4,4,4"), GPU_MEM_UTIL ("0.50,0.85,0.50"),
# JOBS_ACTIVE, JOBS_ACTIVE_CMD, HEALTH_TIMEOUT_S (180), HEALTH_POLL_S (3),
# LOG (/srv/hl5090/deploy-gemma-trio.log), FORCE (1 bypasses the idle guard and
# prints why - never use it on a busy GPU).
set -euo pipefail

CONTAINERS=${CONTAINERS:-"gemma-gpu0 gemma-gpu1 gemma-gpu2"}
IMAGE=${IMAGE:-gemma4-vllm-patched-audio:local}
NETWORK=${NETWORK:-hl5090}
SHM_SIZE=${SHM_SIZE:-16g}
RESTART=${RESTART:-unless-stopped}
MODELS_SRC=${MODELS_SRC:-/srv/hl5090/models}
MODELS_DST=${MODELS_DST:-/models}
MODEL_DIR=${MODEL_DIR:-/models/gemma-4-12b-it-qat-AWQ-INT4}
SERVED_NAME=${SERVED_NAME:-cyankiwi/gemma-4-12B-it-qat-AWQ-INT4}
# THE SPEC. Change a flag here, never by hand on a container. Per worker, in
# CONTAINERS order: gemma-gpu0, gemma-gpu1, gemma-gpu2.
MAX_NUM_SEQS=${MAX_NUM_SEQS:-"4,4,4"}
GPU_MEM_UTIL=${GPU_MEM_UTIL:-"0.50,0.85,0.50"}
HEALTH_TIMEOUT_S=${HEALTH_TIMEOUT_S:-180}
HEALTH_POLL_S=${HEALTH_POLL_S:-3}
LOG=${LOG:-/srv/hl5090/deploy-gemma-trio.log}
FORCE=${FORCE:-0}

export CONTAINERS IMAGE NETWORK SHM_SIZE RESTART MODELS_SRC MODELS_DST \
       MODEL_DIR SERVED_NAME MAX_NUM_SEQS GPU_MEM_UTIL HEALTH_TIMEOUT_S \
       HEALTH_POLL_S FORCE

ts() { date -u +%FT%TZ; }
say() { printf '%s %s\n' "[$(ts)]" "$*"; }
# Only the mutating modes write the persistent log; `check`/`status`/`plan`
# stay read-only on the host.
logsay() { say "$*"; [ "${LOGGING:-0}" = "1" ] && printf '%s %s\n' "[$(ts)]" "$*" >>"$LOG"; return 0; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/gemma-trio.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

emit_engine() {
  cat <<'PY'
import difflib, json, os, re, subprocess, sys, time

CONTAINERS = os.environ["CONTAINERS"].split()
IMAGE = os.environ["IMAGE"]
NETWORK = os.environ["NETWORK"]
SHM_SIZE = os.environ["SHM_SIZE"]
RESTART = os.environ["RESTART"]
MODELS_SRC = os.environ["MODELS_SRC"]
MODELS_DST = os.environ["MODELS_DST"]
MODEL_DIR = os.environ["MODEL_DIR"]
SERVED_NAME = os.environ["SERVED_NAME"]
SEQS = [x.strip() for x in os.environ["MAX_NUM_SEQS"].split(",")]
UTIL = [x.strip() for x in os.environ["GPU_MEM_UTIL"].split(",")]
HEALTH_TIMEOUT_S = int(os.environ["HEALTH_TIMEOUT_S"])
HEALTH_POLL_S = max(0, int(os.environ["HEALTH_POLL_S"]))
FORCE = os.environ.get("FORCE", "0") == "1"

if len(SEQS) != len(CONTAINERS) or len(UTIL) != len(CONTAINERS):
    sys.stderr.write("MAX_NUM_SEQS / GPU_MEM_UTIL must list one value per worker\n")
    sys.exit(2)


def ts():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def say(msg):
    print("[%s] %s" % (ts(), msg), flush=True)


def shm_bytes(spec):
    spec = str(spec).strip().lower()
    m = re.fullmatch(r"([0-9]+)([kmg]?)", spec)
    if not m:
        raise SystemExit("bad SHM_SIZE: %s" % spec)
    mult = {"": 1, "k": 1024, "m": 1024 ** 2, "g": 1024 ** 3}[m.group(2)]
    return int(m.group(1)) * mult


def declared_cmd(idx):
    # Byte-for-byte the argv the trio runs today (ADAAAA-8568 AC3), with the two
    # per-worker knobs from the spec above.
    return [
        "serve", MODEL_DIR,
        "--served-model-name", SERVED_NAME,
        "--host", "0.0.0.0",
        "--port", "8088",
        "--max-num-seqs", SEQS[idx],
        "--max-model-len", "32768",
        "--gpu-memory-utilization", UTIL[idx],
        "--kv-cache-dtype", "float16",
        "--limit-mm-per-prompt", '{"image": 64, "audio": 1, "video": 0}',
        "--mm-processor-kwargs", '{"max_soft_tokens": 280}',
        "--trust-remote-code",
    ]


def inspect(name):
    p = subprocess.run(["docker", "inspect", name], capture_output=True, text=True)
    if p.returncode != 0:
        return None, (p.stderr.strip() or "docker inspect failed")
    try:
        d = json.loads(p.stdout)
    except Exception:
        return None, "docker inspect returned unparseable JSON"
    if not isinstance(d, list) or not d:
        return None, "docker inspect returned no object"
    return d[0], None


def split_argv(argv):
    pos, flags = [], []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                flags.append((a, argv[i + 1]))
                i += 2
            else:
                flags.append((a, None))
                i += 1
        else:
            pos.append(a)
            i += 1
    return pos, flags


def compare(name, idx, d):
    """Return per-field drift lines; empty list == live matches the spec."""
    drifts = []
    cfg = d.get("Config") or {}
    host = d.get("HostConfig") or {}

    if cfg.get("Image") != IMAGE:
        drifts.append("DRIFT %s field=image live=%s declared=%s" % (name, cfg.get("Image"), IMAGE))
    ep = cfg.get("Entrypoint") or []
    if ep != ["vllm"]:
        drifts.append("DRIFT %s field=entrypoint live=%s declared=%s" % (name, json.dumps(ep), json.dumps(["vllm"])))

    live_cmd = cfg.get("Cmd") or []
    want_cmd = declared_cmd(idx)
    lpos, lflags = split_argv(live_cmd)
    wpos, wflags = split_argv(want_cmd)
    for i, w in enumerate(wpos):
        got = lpos[i] if i < len(lpos) else "<missing>"
        if got != w:
            drifts.append("DRIFT %s field=argv[%d] live=%s declared=%s" % (name, i, got, w))
    for i in range(len(wpos), len(lpos)):
        drifts.append("DRIFT %s field=argv[%d] live=%s declared=<absent>" % (name, i, lpos[i]))
    lmap = dict(lflags)
    wmap = dict(wflags)
    for flag, want in wflags:
        if flag not in lmap:
            drifts.append("DRIFT %s field=%s live=<missing> declared=%s" % (name, flag, want))
        elif lmap[flag] != want:
            drifts.append("DRIFT %s field=%s live=%s declared=%s" % (name, flag, lmap[flag], want))
    for flag in lmap:
        if flag not in wmap:
            drifts.append("DRIFT %s field=%s live=%s declared=<absent>" % (name, flag, lmap[flag]))
    if [f for f, _ in lflags] != [f for f, _ in wflags]:
        drifts.append("DRIFT %s field=argv-order live=%s declared=%s"
                      % (name, json.dumps([f for f, _ in lflags]), json.dumps([f for f, _ in wflags])))

    if host.get("NetworkMode") != NETWORK:
        drifts.append("DRIFT %s field=network live=%s declared=%s" % (name, host.get("NetworkMode"), NETWORK))
    if host.get("ShmSize") != shm_bytes(SHM_SIZE):
        drifts.append("DRIFT %s field=shm-size live=%s declared=%s" % (name, host.get("ShmSize"), shm_bytes(SHM_SIZE)))
    rp = (host.get("RestartPolicy") or {}).get("Name")
    if rp != RESTART:
        drifts.append("DRIFT %s field=restart live=%s declared=%s" % (name, rp, RESTART))
    devreq = host.get("DeviceRequests") or []
    ids = None
    if devreq:
        ids = devreq[0].get("DeviceIDs")
    if ids != [str(idx)]:
        drifts.append("DRIFT %s field=gpus live=%s declared=device=%s" % (name, json.dumps(ids), idx))
    mounts = [(m.get("Source"), m.get("Destination"), bool(m.get("RW"))) for m in (d.get("Mounts") or [])]
    want_mounts = [(MODELS_SRC, MODELS_DST, False)]
    if mounts != want_mounts:
        drifts.append("DRIFT %s field=models-mount live=%s declared=%s" % (name, json.dumps(mounts), json.dumps(want_mounts)))
    ports = host.get("PortBindings") or {}
    if ports:
        drifts.append("DRIFT %s field=ports live=%s declared=none" % (name, json.dumps(ports)))
    if host.get("Privileged"):
        drifts.append("DRIFT %s field=privileged live=true declared=false" % name)
    if host.get("IpcMode") not in (None, "private"):
        drifts.append("DRIFT %s field=ipc live=%s declared=private" % (name, host.get("IpcMode")))
    return [x for x in drifts if x]


def show_cmd(name, idx, d):
    live = json.dumps((d.get("Config") or {}).get("Cmd") or [])
    want = json.dumps(declared_cmd(idx))
    say("cmd %s live=%s" % (name, live))
    say("cmd %s declared=%s" % (name, want))
    if live != want:
        a = json.dumps(declared_cmd(idx), indent=1).splitlines()
        b = json.dumps((d.get("Config") or {}).get("Cmd") or [], indent=1).splitlines()
        for line in difflib.unified_diff(a, b, "declared/" + name, "live/" + name, lineterm="", n=1):
            say("  " + line)


def do_check():
    bad = 0
    for idx, name in enumerate(CONTAINERS):
        d, err = inspect(name)
        if err:
            say("DRIFT %s field=container live=<unreadable:%s> declared=present" % (name, err))
            bad = 1
            continue
        show_cmd(name, idx, d)
        drifts = compare(name, idx, d)
        if drifts:
            bad = 1
            for line in drifts:
                say(line)
        else:
            say("OK %s %d argv entries and run config match the declared spec" % (name, len(declared_cmd(idx))))
    if bad:
        print("check FAIL: the trio drifted from the declared spec (exit 8)", file=sys.stderr)
        return 8
    say("check PASS: gemma-gpu%d..%d match the declared spec (%s seqs, utils %s)"
        % (0, len(CONTAINERS) - 1, ",".join(SEQS), ",".join(UTIL)))
    return 0


def do_status():
    for idx, name in enumerate(CONTAINERS):
        d, err = inspect(name)
        if err:
            say("status %s unreadable (%s)" % (name, err))
            continue
        cfg = d.get("Config") or {}
        state = d.get("State") or {}
        code = subprocess.run(
            ["docker", "exec", name, "curl", "-s", "-m", "3", "-o", "/dev/null",
             "-w", "%{http_code}", "http://127.0.0.1:8088/health"],
            capture_output=True, text=True).stdout.strip() or "ERR"
        say("status %s image=%s gpu=%s state=%s started=%s restarts=%s health=%s"
            % (name, cfg.get("Image"), idx, state.get("Status"), state.get("StartedAt"),
               d.get("RestartCount"), code))
    return 0


def gpu_read(idx):
    p = subprocess.run(
        ["nvidia-smi", "--id=%d" % idx, "--query-gpu=index,utilization.gpu,memory.used",
         "--format=csv,noheader"], capture_output=True, text=True)
    if p.returncode != 0:
        return None, p.stderr.strip() or "nvidia-smi failed"
    out = p.stdout.strip()
    return out, None


def running_lines(name):
    p = subprocess.run(["docker", "logs", "--since", "5m", name], capture_output=True, text=True)
    if p.returncode != 0:
        return None, p.stderr.strip() or "docker logs failed"
    return len(re.findall(r"Running: [1-9]", p.stdout)), None


def guard(idx, name):
    """(ok, line, reasons). Never mutates."""
    gpu, gpu_err = gpu_read(idx)
    busy, run_err = running_lines(name)
    jobs = os.environ.get("JOBS_ACTIVE", "")
    problems = []
    if gpu_err:
        problems.append("gpu-unreadable")
    else:
        util = gpu.split(",")[1].strip() if "," in gpu else ""
        if not re.fullmatch(r"0+ ?%", util):
            problems.append("gpu-busy")
    if run_err:
        problems.append("log-unreadable")
    elif busy:
        problems.append("engine-running")
    if jobs == "":
        problems.append("jobs-unreadable")
    elif jobs != "0":
        problems.append("jobs-active")
    line = ("=== GUARD %s %s   %s   Running-lines-last-5m: %s   JOBS_ACTIVE|%s (%s)"
            % (name, ts(), gpu if not gpu_err else "<unreadable:%s>" % gpu_err,
               busy if run_err is None else "<unreadable:%s>" % run_err,
               jobs if jobs != "" else "<unreadable>",
               os.environ.get("JOBS_ACTIVE_SOURCE", "unset")))
    return (not problems), line, problems


def recreate(name, idx):
    args = ["docker", "run", "-d", "--name", name,
            "--network", NETWORK,
            "--shm-size", SHM_SIZE,
            "--restart", RESTART,
            "--gpus", "device=%d" % idx,
            "-v", "%s:%s:ro" % (MODELS_SRC, MODELS_DST),
            "--entrypoint", "vllm",
            IMAGE] + declared_cmd(idx)
    say("=== RECREATE %s argv=%s" % (name, json.dumps(args[1:])))
    rm = subprocess.run(["docker", "rm", "-f", name], capture_output=True, text=True)
    if rm.returncode != 0:
        say("=== RECREATE-FAILED %s docker rm: %s" % (name, rm.stderr.strip()))
        return 6
    run = subprocess.run(args, capture_output=True, text=True)
    if run.returncode != 0:
        say("=== RECREATE-FAILED %s docker run: %s" % (name, run.stderr.strip()))
        return 6
    d, err = inspect(name)
    if err:
        say("=== RECREATE-FAILED %s inspect after run: %s" % (name, err))
        return 6
    if (d.get("Config") or {}).get("Image") != IMAGE:
        say("=== RECREATE-FAILED %s came up on %s, not %s"
            % (name, (d.get("Config") or {}).get("Image"), IMAGE))
        return 6
    waited = 0
    while True:
        code = subprocess.run(
            ["docker", "exec", name, "curl", "-s", "-m", "3", "-o", "/dev/null",
             "-w", "%{http_code}", "http://127.0.0.1:8088/health"],
            capture_output=True, text=True).stdout.strip()
        if code == "200":
            break
        if waited >= HEALTH_TIMEOUT_S:
            say("=== HEALTH-TIMEOUT %s last=%s after %ds" % (name, code or "ERR", waited))
            return 7
        time.sleep(HEALTH_POLL_S)
        waited += HEALTH_POLL_S
    d, err = inspect(name)
    state = (d or {}).get("State") or {}
    say("=== AFTER %s started=%s restarts=%s health=200 (%ds)"
        % (name, state.get("StartedAt"), (d or {}).get("RestartCount"), waited))
    return 0


def do_guard():
    busy = 0
    for idx, name in enumerate(CONTAINERS):
        ok, line, problems = guard(idx, name)
        say(line)
        if not ok:
            busy = 1
            say("=== BUSY %s reasons=%s" % (name, ",".join(problems)))
    if busy:
        print("guard FAIL: a worker is busy (exit 3) - a recreate now would strand a leg", file=sys.stderr)
        return 3
    say("guard PASS: all %d workers idle (nothing was touched)" % len(CONTAINERS))
    return 0


def do_apply(dry):
    rc = 0
    recreated = 0
    planned = 0
    for idx, name in enumerate(CONTAINERS):
        d, err = inspect(name)
        if err:
            say("REFUSING %s: live container unreadable (%s)" % (name, err))
            return 6
        drifts = compare(name, idx, d)
        if not drifts:
            say("=== NO-OP %s declared spec already live (StartedAt=%s restarts=%s)"
                % (name, ((d.get("State") or {}).get("StartedAt")), d.get("RestartCount")))
            continue
        for line in drifts:
            say(line)
        ok, line, problems = guard(idx, name)
        say(line)
        if not ok:
            if not FORCE:
                say("=== REFUSED %s guard failed: %s - nothing recreated (wait for idle, or FORCE=1 with a stated reason)"
                    % (name, ",".join(problems)))
                return 3
            say("=== GUARD-OVERRIDE %s FORCE=1 bypasses %s" % (name, ",".join(problems)))
        state = d.get("State") or {}
        say("=== BEFORE %s started=%s restarts=%s" % (name, state.get("StartedAt"), d.get("RestartCount")))
        if dry:
            planned += 1
            say("=== PLAN would recreate %s on %s with %d argv entries"
                % (name, IMAGE, len(declared_cmd(idx))))
            continue
        r = recreate(name, idx)
        if r != 0:
            return r
        recreated += 1
    if dry:
        say("plan complete: %d worker(s) would be recreated, nothing touched" % planned)
        return 0
    if recreated == 0:
        say("apply complete: nothing drifted, no container recreated (no-op)")
    else:
        say("apply complete: %d worker(s) recreated on the declared spec" % recreated)
    return rc


def main():
    mode = sys.argv[1]
    if mode == "check":
        return do_check()
    if mode == "status":
        return do_status()
    if mode == "guard":
        return do_guard()
    if mode == "plan":
        return do_apply(dry=True)
    if mode == "apply":
        return do_apply(dry=False)
    sys.stderr.write("usage: engine {check|status|plan|apply}\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
PY
}

emit_engine >"$WORK/engine.py"

resolve_jobs_active() {
  # Fail closed: an unread guard is not a clear runway.
  if [ -n "${JOBS_ACTIVE:-}" ]; then
    JOBS_ACTIVE_SOURCE="env JOBS_ACTIVE"; export JOBS_ACTIVE_SOURCE; return 0
  fi
  if [ -n "${JOBS_ACTIVE_CMD:-}" ]; then
    local out rc=0
    out=$(eval "$JOBS_ACTIVE_CMD" 2>/dev/null) || rc=$?
    if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qE '^JOBS_ACTIVE\|[0-9]+$'; then
      JOBS_ACTIVE=${out#JOBS_ACTIVE|}
      JOBS_ACTIVE_SOURCE="cmd JOBS_ACTIVE_CMD"
      export JOBS_ACTIVE JOBS_ACTIVE_SOURCE
      return 0
    fi
    say "JOBS_ACTIVE_CMD did not print JOBS_ACTIVE|<n> (rc=$rc); guard fails closed"
    return 5
  fi
  say "JOBS_ACTIVE unknown: the 5090 host has no psql and no route to x99:5432."
  say "Read it on x99, then re-run with JOBS_ACTIVE=<n> (or JOBS_ACTIVE_CMD=...)."
  say "  docker exec -i highlights-postgres psql -U highlights -d highlights -tA <<'SQL'"
  say "  select 'JOBS_ACTIVE|' || count(*) from jobs"
  say "  where (record::jsonb->>'completedAt') is null"
  say "    and (record::jsonb->>'status') in ('queued','active','extracting','analyzing','finalizing');"
  say "  SQL"
  return 5
}

usage() {
  cat <<'USAGE'
usage: deploy-gemma-trio.sh {check|status|guard|plan|apply}

  check    read-only drift diff of each live worker vs the declared spec
           (exit 0 clean, 8 drift). Safe from any heartbeat.
  status   read-only one-line-per-worker state
  guard    read-only idle guard line per worker (exit 3 if busy)
  plan     drift + idle guard reads, then what apply WOULD do (no mutation)
  apply    idle-guarded recreate, one worker at a time; clean workers are NO-OP
USAGE
  return 2
}

MODE=${1:-}
case "$MODE" in
  check | --check)
    python3 "$WORK/engine.py" check
    ;;
  status | --status)
    python3 "$WORK/engine.py" status
    ;;
  guard | --guard)
    rc=0
    resolve_jobs_active || rc=$?
    [ "$rc" -ne 0 ] && exit "$rc"
    python3 "$WORK/engine.py" guard
    ;;
  plan | --plan)
    rc=0
    resolve_jobs_active || rc=$?
    [ "$rc" -ne 0 ] && exit "$rc"
    python3 "$WORK/engine.py" plan
    ;;
  apply | --apply)
    rc=0
    resolve_jobs_active || rc=$?
    [ "$rc" -ne 0 ] && exit "$rc"
    LOGGING=1 logsay "apply start (spec: seqs=$MAX_NUM_SEQS utils=$GPU_MEM_UTIL image=$IMAGE)"
    python3 "$WORK/engine.py" apply
    ;;
  "" | -h | --help)
    usage
    ;;
  *)
    say "unknown mode: $MODE"
    usage
    ;;
esac

#!/usr/bin/env python3
"""Durable funded-leg launcher: arm the guard before reporting a supervised leg.

ADAAAA-8943. Source incident: ADAAAA-8924 (rev-8 live leg). `funded_leg.py`
arms its wall-clock stop in a daemon thread INSIDE its own process, so the
process is the whole guard. The launch was `subprocess.Popen(start_new_session=
True)` from a one-shot remote exec call, and the harness vanished ~1 min after
`job created` — killed with the launching session. Nothing printed
`WALL-CLOCK STOP`, no evidence file was written, and the job ran its full
content and past it: settled `costUsd $1.4537` against a `$1.3000` cap, stopped
1783 s after create by a hand-issued operator call.

This launcher closes that hole with two rules:

  1. DETACHED LAUNCH. The harness runs in its own session (`start_new_session`,
     i.e. `setsid` in the child), with stdin on /dev/null and stdout/stderr on
     `<run-dir>/harness.log`. Its evidence and heartbeat paths are inside the
     run dir, so nothing about the leg depends on the launching terminal or
     caller staying open.

  2. ARM CHECK, BEFORE THE LEG IS CALLED SUPERVISED. The harness prints
     `[leg] arm pid=… job=…` and writes `<run-dir>/heartbeat.json` once it is
     inside its stop loop. This launcher waits up to `--arm-timeout-s`
     (default 30) for ALL of: that line in the log, a heartbeat carrying the
     harness pid and a job id, and a live pid. If any is missing it does not
     report a leg: it stops the job it can name, writes `<run-dir>/arm.json`
     with `outcome: "arm_failed"`, and exits 8 ("no supervised leg"). A leg left
     running while the launcher calls it armed is exactly the 8924 overspend.

A fallback supervisor (`leg_supervisor.py`) is launched beside the harness in
its own session as well: it stops the job if the heartbeats stop advancing,
which covers "the harness died but the caller's session did not take the job
with it". `--no-supervisor` skips it (dry runs, or a cell that forbids a second
process).

3. DURABLE DEADLINE GUARD (ADAAAA-9008). Neither process is a guarantee: on the
   ADAAAA-8998 C2 leg the harness and the supervisor died in the same second,
   which left the job metering 375 s past its authorized clock. So the deadline
   is also committed to `systemd` as a transient timer
   (`--deadline-guard auto|systemd|none`): the timer lives under PID 1, outside
   the sessions and cgroups the guard processes share, and runs
   `<run-dir>/deadline_guard_stop.py` (which mints its own token and stops the
   job) even if every process this launcher started was SIGKILLed. `auto`
   refuses a real leg that cannot commit it; `--dry-run` records
   `skipped_dry_run` (the stub job lives inside the harness process). The
   supervisor disarms the timer when the leg ends.

Everything the launcher decides is on disk, so the next reader does not have to
re-derive it:

    <run-dir>/launch.json             what was launched, when, with which argv
    <run-dir>/harness.log             the harness's own stdout/stderr
    <run-dir>/heartbeat.json          the live heartbeat (harness pid/job/deadline)
    <run-dir>/harness.pid             the harness pid
    <run-dir>/supervisor.pid          the fallback supervisor pid
    <run-dir>/supervisor.json         the supervisor's verdict (`watching` while
                                      it is armed, then what it decided)
    <run-dir>/deadline_guard.json     the durable timer's unit/fire time/readback
    <run-dir>/deadline_guard_stop.py  what the timer runs when it fires (0700)
    <run-dir>/deadline_guard_result.json  what the timer did when it fired
    <run-dir>/arm.json                this launcher's arm verdict
    <run-dir>/evidence.json           the harness evidence bundle

Exit codes:
  0  armed — the harness is detached, alive, its heartbeat names the job, and
     (for a real leg) the durable deadline guard is `active` in systemd
  8  arm failed — no live harness heartbeat/pid inside the arm window, or the
     durable deadline guard could not be committed; the job this launcher could
     name was stopped. No supervised leg exists.
  9  refused — a live harness is already registered in that run dir
     (`--force` overrides), or the harness could not be spawned at all
"""

from __future__ import annotations

import argparse
import os
import re
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Sequence, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import funded_leg as harness_mod  # noqa: E402

ARM_RE = re.compile(r"^\[leg\] arm pid=(?P<pid>\d+) job=(?P<job>\S+)", re.M)
JOB_RE = re.compile(r"^\[leg\] job (?P<job>\S+) created", re.M)

EXIT_ARMED = 0
EXIT_ARM_FAILED = 8
EXIT_REFUSED = 9


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def parse_arm_line(log_text: str) -> Optional[Dict[str, Any]]:
    """The harness's `[leg] arm pid=… job=…` line, as a dict."""
    match = ARM_RE.search(log_text or "")
    if not match:
        return None
    return {"pid": int(match.group("pid")), "job": match.group("job")}


def parse_job_id(log_text: str) -> Optional[str]:
    """The job id, from the arm line first, then the create line."""
    armed = parse_arm_line(log_text)
    if armed:
        return armed["job"]
    match = JOB_RE.search(log_text or "")
    return match.group("job") if match else None


def pid_alive(pid: Optional[int]) -> bool:
    """True when the pid exists and is signalable (EPERM still means alive)."""
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def read_pid(path: str) -> Optional[int]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return int(fh.read().strip() or 0) or None
    except (OSError, ValueError):
        return None


def _write_json(path: str, payload: Dict[str, Any]) -> None:
    harness_mod.write_json_atomic(path, payload)


def split_args(argv: Sequence[str]) -> Tuple[argparse.Namespace, List[str]]:
    """Separate this launcher's own flags from the harness's argv.

    Everything the launcher does not recognise is passed through unchanged, so
    a leg is priced/authorized exactly as the card wrote it — the launcher only
    adds the detached-launch and heartbeat plumbing.
    """
    parser = argparse.ArgumentParser(
        prog="launch_funded_leg.py",
        description=(
            "Launch evals/funded_leg/funded_leg.py detached, prove it armed, and "
            "refuse to report a leg otherwise (ADAAAA-8943)."
        ),
        add_help=False,
    )
    parser.add_argument("--run-dir", required=True,
                        help="durable directory for the log, heartbeat, pid, arm "
                             "verdict, evidence and supervisor output")
    parser.add_argument("--arm-timeout-s", type=float, default=30.0,
                        help="seconds to wait for the arm line + live pid + "
                             "heartbeat before refusing (default 30)")
    parser.add_argument("--no-arm-check", action="store_true",
                        help="skip the arm proof (a leg launched this way is NOT "
                             "evidence — it is the 8924 shape)")
    parser.add_argument("--no-supervisor", action="store_true",
                        help="do not launch the fallback supervisor")
    parser.add_argument("--supervisor-stale-s", type=float, default=45.0,
                        help="heartbeat staleness the supervisor stops on "
                             "(default 45)")
    parser.add_argument("--deadline-guard", choices=("auto", "systemd", "none"),
                        default="auto",
                        help="commit the authorized deadline to systemd as a "
                             "transient timer that fires even if every guard "
                             "process is killed (ADAAAA-9008). `auto` requires "
                             "it for a real leg and skips it for --dry-run "
                             "(default auto)")
    parser.add_argument("--deadline-guard-grace-s", type=float, default=5.0,
                        help="seconds past deadline+hard-stop-slack before the "
                             "durable timer fires (default 5)")
    parser.add_argument("--deadline-guard-prefix", default="funded-leg",
                        help="transient unit name prefix (default funded-leg)")
    parser.add_argument("--harness", default=os.path.join(HERE, "funded_leg.py"),
                        help="path to funded_leg.py (default: beside this script)")
    parser.add_argument("--supervisor-script",
                        default=os.path.join(HERE, "leg_supervisor.py"),
                        help="path to leg_supervisor.py")
    parser.add_argument("--python", default=sys.executable,
                        help="interpreter for the harness/supervisor (default: "
                             "the launcher's own)")
    parser.add_argument("--force", action="store_true",
                        help="launch even when a live harness is registered in "
                             "the run dir")
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_known_args(list(argv))


def _harness_config(args: argparse.Namespace) -> Any:
    """The four fields `funded_leg.mint_token` reads, from the harness argv."""
    return SimpleNamespace(
        token=getattr(args, "token", None),
        user_id=getattr(args, "user_id", None),
        email=getattr(args, "email", None),
        mint_token_container=getattr(args, "mint_token_container", "highlights-server"),
    )


def _runner_for(args: argparse.Namespace) -> Any:
    return harness_mod.RealRunner(
        postgres_container=getattr(args, "postgres_container", "highlights-postgres"),
        box_cmd=getattr(args, "box_cmd", "") or "",
        cyc_box_cmd=getattr(args, "cyc_box_cmd", "") or "",
        shell_cwd=getattr(args, "repo_root", "."),
    )


def stop_job(args: argparse.Namespace, job_id: str) -> Dict[str, Any]:
    """Stop the job this launcher can name. Never raises; reports the attempt.

    $0 by construction: a stop call bills nothing. It exists so an arm failure
    cannot leave a metered job running with no guard anywhere (ADAAAA-8943).
    """
    out: Dict[str, Any] = {
        "jobId": job_id,
        "attempted": True,
        "ok": False,
        "http": None,
        "tokenSource": "arg" if getattr(args, "token", None) else "minted",
        "error": None,
    }
    try:
        token = harness_mod.mint_token(_harness_config(args), _runner_for(args))
    except Exception as exc:  # no token means no stop; report it, never hide it
        out["error"] = f"token: {type(exc).__name__}: {exc}"
        return out
    try:
        res = _runner_for(args).http(
            "POST",
            f"{getattr(args, 'job_base', 'http://127.0.0.1:3000')}/jobs/{job_id}/stop",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15.0,
        )
        out["http"] = res.status
        out["ok"] = res.status in (200, 201)
        if not out["ok"]:
            out["error"] = f"HTTP {res.status}: {res.raw[:300]}"
    except Exception as exc:
        out["error"] = f"stop: {type(exc).__name__}: {exc}"
    return out


#: The durable deadline guard (ADAAAA-9008). Both guard processes can die at
#: once (the ADAAAA-8998 C2 leg lost the harness and the supervisor in the same
#: second, with no traceback), so the deadline itself is committed to `systemd`
#: as a transient timer: it lives under PID 1, outside the sessions and cgroups
#: the guard processes share, and fires even if every process this launcher
#: started is SIGKILLed.
DEADLINE_GUARD_PREFIX = "funded-leg"
DEADLINE_GUARD_GRACE_S = 5.0
DEADLINE_GUARD_SCRIPT = "deadline_guard_stop.py"
DEADLINE_GUARD_RESULT = "deadline_guard_result.json"
DEADLINE_GUARD_RECORD = "deadline_guard.json"


def _iso_from_epoch(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def deadline_guard_unit(job_id: str, fire_epoch: float,
                        prefix: str = DEADLINE_GUARD_PREFIX) -> str:
    """A valid transient unit name for this job's deadline timer."""
    safe = re.sub(r"[^A-Za-z0-9]", "-", str(job_id))[:8].strip("-").lower() or "job"
    return f"{prefix}-{safe}-{int(fire_epoch)}"


def deadline_guard_plan(
    beat: Optional[Dict[str, Any]],
    *,
    now: float,
    grace_s: float = DEADLINE_GUARD_GRACE_S,
    prefix: str = DEADLINE_GUARD_PREFIX,
) -> Dict[str, Any]:
    """When the durable timer fires, and why that time.

    The timer must not race the harness's own stop: it fires after the
    heartbeat's `deadlineEpoch`, after the harness's hard-stop slack, and after
    `grace_s` — the window in which the harness and then the supervisor are
    supposed to have stopped the leg themselves.
    """
    job_id = (beat or {}).get("jobId")
    if not job_id:
        return {"ok": False, "reason": "no job id in the heartbeat"}
    raw = (beat or {}).get("deadlineEpoch")
    try:
        deadline = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return {"ok": False, "jobId": job_id,
                "reason": "no usable deadlineEpoch in the heartbeat"}
    try:
        slack = float((beat or {}).get("hardStopSlackS") or 10.0)
    except (TypeError, ValueError):
        slack = 10.0
    fire_epoch = deadline + max(0.0, slack) + max(0.0, grace_s)
    return {
        "ok": True,
        "jobId": job_id,
        "unit": deadline_guard_unit(job_id, fire_epoch, prefix),
        "deadlineEpoch": round(deadline, 3),
        "deadlineAt": (beat or {}).get("deadlineAt") or _iso_from_epoch(deadline),
        "slackS": slack,
        "graceS": grace_s,
        "fireEpoch": round(fire_epoch, 3),
        "fireAt": _iso_from_epoch(fire_epoch),
        "delayS": round(max(1.0, fire_epoch - now), 1),
    }


def render_deadline_guard_script(
    *,
    job_id: str,
    job_base: str,
    result_path: str,
    unit: str,
    armed_for_epoch: float,
    token: Optional[str] = None,
    user_id: Optional[str] = None,
    email: Optional[str] = None,
    mint_container: str = "highlights-server",
) -> str:
    """The standalone stop script the timer runs.

    Standalone on purpose: it must not import this tooling tree, because the
    tree may have moved by the time it fires. It mints its own token inside the
    server container unless the launcher was given one, and it writes what it
    did beside the leg's other artifacts so a killed-guard leg still has a
    record of the stop.
    """
    body = '''#!/usr/bin/env python3
"""Durable deadline stop for funded leg __JOB_ID__ (ADAAAA-9008).

Armed by launch_funded_leg.py as a systemd transient timer, so it fires even if
the harness AND the supervisor were both killed. A stop call bills nothing.
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

JOB_ID = __JOB_ID__
JOB_BASE = __JOB_BASE__
TOKEN = __TOKEN__
USER_ID = __USER_ID__
EMAIL = __EMAIL__
MINT_CONTAINER = __MINT_CONTAINER__
RESULT_PATH = __RESULT_PATH__
UNIT = __UNIT__
ARMED_FOR_EPOCH = __ARMED_FOR_EPOCH__

MINT_JS = (
    "const jwt=require('jsonwebtoken');process.stdout.write(jwt.sign("
    "{sub:process.env.U,email:process.env.E||'leg-harness@highlights.local',"
    "role:'user'},process.env.JWT_SECRET,{expiresIn:'1h'}))"
)


def _iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _write(payload):
    tmp = "%s.tmp.%d" % (RESULT_PATH, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
        fh.write("\\n")
    os.replace(tmp, RESULT_PATH)


def _mint():
    if not USER_ID:
        raise RuntimeError("no token and no user id to mint one with")
    cmd = [
        "docker", "exec", "-e", "U=%s" % USER_ID,
        "-e", "E=%s" % (EMAIL or "leg-harness@highlights.local"),
        MINT_CONTAINER, "node", "-e", MINT_JS,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    token = (proc.stdout or b"").decode("utf-8", "replace").strip()
    if proc.returncode != 0 or not token:
        raise RuntimeError(
            "token mint rc=%s: %s"
            % (proc.returncode, (proc.stderr or b"").decode("utf-8", "replace")[:300])
        )
    return token


def _stop(token):
    req = urllib.request.Request(
        "%s/jobs/%s/stop" % (JOB_BASE.rstrip("/"), JOB_ID),
        data=b"{}",
        method="POST",
        headers={"Authorization": "Bearer %s" % token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, (res.read() or b"")[:300].decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, (exc.read() or b"")[:300].decode("utf-8", "replace")


def main():
    fired_at = time.time()
    token = TOKEN
    token_source = "arg" if token else "minted"
    token_error = None
    status = None
    detail = None
    error = None
    if not token:
        try:
            token = _mint()
        except Exception as exc:
            token_error = "%s: %s" % (type(exc).__name__, exc)
            error = token_error
    if token:
        try:
            status, detail = _stop(token)
        except Exception as exc:
            error = "%s: %s" % (type(exc).__name__, exc)
    ok = status in (200, 201)
    payload = {
        "fired": True,
        "unit": UNIT,
        "jobId": JOB_ID,
        "jobBase": JOB_BASE,
        "reason": "authorized_deadline_elapsed (durable deadline guard, ADAAAA-9008)",
        "armedForEpoch": ARMED_FOR_EPOCH,
        "armedForAt": _iso(ARMED_FOR_EPOCH),
        "firedAt": _iso(fired_at),
        "firedAtEpoch": round(fired_at, 3),
        "lateByS": round(fired_at - ARMED_FOR_EPOCH, 1),
        "tokenSource": token_source,
        "tokenError": token_error,
        "stop": {"http": status, "ok": ok, "detail": detail, "error": error},
    }
    _write(payload)
    print(json.dumps(payload, sort_keys=True))
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
'''
    values = {
        "__JOB_ID__": job_id,
        "__JOB_BASE__": job_base,
        "__TOKEN__": token,
        "__USER_ID__": user_id,
        "__EMAIL__": email,
        "__MINT_CONTAINER__": mint_container,
        "__RESULT_PATH__": result_path,
        "__UNIT__": unit,
        "__ARMED_FOR_EPOCH__": round(armed_for_epoch, 3),
    }
    out = body
    for key, value in values.items():
        out = out.replace(key, repr(value))
    return out


def write_deadline_guard_script(path: str, script: str) -> None:
    """Write the stop script 0700 — it may carry a bearer token (ADAAAA-9008)."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o700)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(script)


def systemctl_show(unit: str, *properties: str, timeout: float = 10.0) -> Dict[str, Any]:
    """Read back a transient unit's state. Never raises.

    One `systemctl show` call per property: with several `--property` flags,
    `--value` does NOT print in request order (measured on systemd 255, where
    `NextElapseUSecMonotonic` came out before `ActiveState`), so a positional
    read mislabels the timer's state. A `--on-active` timer is monotonic, so
    `NextElapseUSecRealtime` is legitimately empty while the monotonic property
    carries the fire time.
    """
    props = list(properties or ("ActiveState",))
    out: Dict[str, Any] = {"unit": unit, "activeState": None, "nextElapse": None,
                           "values": {}, "rc": None, "error": None}
    for prop in props:
        args = ["systemctl", "show", f"{unit}.timer",
                f"--property={prop}", "--value", "--no-pager"]
        try:
            proc = subprocess.run(args, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, timeout=timeout, check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            out["error"] = f"{type(exc).__name__}: {exc}"
            return out
        out["rc"] = proc.returncode
        value = (proc.stdout or b"").decode("utf-8", "replace").strip()
        out["values"][prop] = value
        if prop == "ActiveState":
            out["activeState"] = value or None
        if proc.returncode != 0 and out["error"] is None:
            out["error"] = value[:300]
    # `NextElapseUSecMonotonic` is boot-relative (printed as an uptime span), so
    # it is kept apart from the human-readable realtime elapse instead of being
    # presented as a wall-clock fire time.
    out["nextElapse"] = out["values"].get("NextElapseUSecRealtime") or None
    out["nextElapseMonotonic"] = out["values"].get("NextElapseUSecMonotonic") or None
    return out


def arm_deadline_guard(
    plan: Dict[str, Any],
    *,
    run_dir: str,
    job_base: str,
    python: str = sys.executable,
    token: Optional[str] = None,
    user_id: Optional[str] = None,
    email: Optional[str] = None,
    mint_container: str = "highlights-server",
    timeout: float = 30.0,
) -> Dict[str, Any]:
    """Commit the deadline to `systemd`; report whether it is really armed.

    Exit-code-only reads are not proof (a swallowed pipeline looks identical to
    a failure), so this writes the script, starts the transient timer, then
    reads the timer's `ActiveState` and `NextElapseUSecRealtime` back.
    """
    out: Dict[str, Any] = {
        "kind": "systemd",
        "unit": plan.get("unit"),
        "fireEpoch": plan.get("fireEpoch"),
        "fireAt": plan.get("fireAt"),
        "delayS": plan.get("delayS"),
        "armed": False,
        "systemdRunRc": None,
        "stdout": "",
        "error": None,
    }
    if not plan.get("ok"):
        out["kind"] = "failed"
        out["error"] = str(plan.get("reason"))
        return out
    script_path = os.path.join(run_dir, DEADLINE_GUARD_SCRIPT)
    result_path = os.path.join(run_dir, DEADLINE_GUARD_RESULT)
    try:
        write_deadline_guard_script(script_path, render_deadline_guard_script(
            job_id=plan["jobId"],
            job_base=job_base,
            result_path=result_path,
            unit=str(plan["unit"]),
            armed_for_epoch=float(plan["fireEpoch"]),
            token=token,
            user_id=user_id,
            email=email,
            mint_container=mint_container,
        ))
    except OSError as exc:
        out["error"] = f"script write: {type(exc).__name__}: {exc}"
        return out
    out["script"] = script_path
    out["result"] = result_path
    cmd = [
        "systemd-run",
        f"--unit={plan['unit']}",
        f"--on-active={plan['delayS']}s",
        "--collect",
        "--property=Description=funded-leg deadline guard (ADAAAA-9008)",
        python, script_path,
    ]
    out["command"] = " ".join(shlex.quote(part) for part in cmd)
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              timeout=timeout, check=False)
        out["systemdRunRc"] = proc.returncode
        out["stdout"] = (proc.stdout or b"").decode("utf-8", "replace")[-600:]
    except (OSError, subprocess.SubprocessError) as exc:
        out["error"] = f"systemd-run: {type(exc).__name__}: {exc}"
        return out
    if out["systemdRunRc"] != 0:
        out["error"] = f"systemd-run rc={out['systemdRunRc']}: {out['stdout'][-300:]}"
        return out
    shown = systemctl_show(str(plan["unit"]), "ActiveState",
                           "NextElapseUSecRealtime", "NextElapseUSecMonotonic")
    out["readback"] = shown
    out["activeState"] = shown.get("activeState")
    out["nextElapse"] = shown.get("nextElapse")
    out["armed"] = shown.get("activeState") == "active"
    out["durable"] = out["armed"]
    out["nextElapseMonotonic"] = shown.get("nextElapseMonotonic")
    if not out["armed"]:
        out["error"] = (
            f"timer not active after arming (ActiveState={shown.get('activeState')!r}): "
            f"{shown.get('error') or shown.get('rc')}"
        )
    return out


def disarm_deadline_guard(unit: Optional[str]) -> Dict[str, Any]:
    """Cancel a timer this launcher armed (used when the arm proof fails)."""
    if not unit:
        return {"unit": None, "disarmed": False}
    args = ["systemctl", "stop", f"{unit}.timer"]
    try:
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              timeout=15, check=False)
        rc = proc.returncode
        detail = (proc.stdout or b"").decode("utf-8", "replace")[-300:]
    except (OSError, subprocess.SubprocessError) as exc:
        rc, detail = None, f"{type(exc).__name__}: {exc}"
    subprocess.run(["systemctl", "reset-failed", f"{unit}.timer", f"{unit}.service"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return {"unit": unit, "disarmed": rc == 0, "rc": rc, "detail": detail}


def _spawn(
    cmd: Sequence[str],
    log_path: str,
    cwd: str,
) -> subprocess.Popen:
    """Start a child in its OWN session, outliving this process.

    `start_new_session=True` is `setsid()` in the child: it gets a new session
    and process group, so a SIGHUP/SIGKILL delivered to the launching shell's
    session (what killed the 8924 harness) does not reach it. stdin is
    /dev/null so no probe can inherit a silent pipe (ADAAAA-8644).
    """
    log = open(log_path, "ab", buffering=0)
    try:
        return subprocess.Popen(
            list(cmd),
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            cwd=cwd,
            start_new_session=True,
            close_fds=True,
            env=dict(os.environ),
        )
    finally:
        log.close()


def main(argv: Optional[Sequence[str]] = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    args, harness_args = split_args(raw)

    def log(msg: str) -> None:
        if not args.quiet:
            print(f"[launch] {msg}", flush=True)

    # Validate the harness argv here rather than 10 minutes into a quiet window.
    harness_parser = harness_mod.build_parser()
    try:
        harness_ns = harness_parser.parse_args(harness_args)
    except SystemExit as exc:  # argparse already printed the reason
        print("[launch] refused: the harness arguments did not parse",
              file=sys.stderr)
        return EXIT_REFUSED

    run_dir = os.path.abspath(args.run_dir)
    os.makedirs(run_dir, exist_ok=True)
    log_path = os.path.join(run_dir, "harness.log")
    pid_path = os.path.join(run_dir, "harness.pid")
    heartbeat_path = os.path.join(run_dir, "heartbeat.json")
    evidence_path = os.path.join(run_dir, "evidence.json")
    arm_path = os.path.join(run_dir, "arm.json")
    launch_path = os.path.join(run_dir, "launch.json")
    supervisor_pid_path = os.path.join(run_dir, "supervisor.pid")
    supervisor_log = os.path.join(run_dir, "supervisor.log")
    supervisor_evidence = os.path.join(run_dir, "supervisor.json")
    guard_path = os.path.join(run_dir, DEADLINE_GUARD_RECORD)

    existing = read_pid(pid_path)
    if existing and pid_alive(existing) and not args.force:
        print(
            f"[launch] refused: harness pid {existing} is still alive in {run_dir} "
            "(use a new --run-dir, or --force if that pid is not a leg)",
            file=sys.stderr,
        )
        return EXIT_REFUSED

    # The heartbeat and evidence paths are the leg's durable record, so the
    # launcher owns them: a leg that only writes them where the caller can see
    # them is the 8924 shape again.
    if "--heartbeat-path" not in harness_args:
        harness_args += ["--heartbeat-path", heartbeat_path]
    if "--evidence-out" not in harness_args:
        harness_args += ["--evidence-out", evidence_path]
    else:
        evidence_path = os.path.abspath(
            harness_ns.evidence_out or evidence_path
        )

    harness_cmd = [args.python, args.harness] + harness_args
    started_at = _iso_now()
    launch_record: Dict[str, Any] = {
        "launchedAt": started_at,
        "launcherPid": os.getpid(),
        "runDir": run_dir,
        "python": args.python,
        "harness": args.harness,
        "harnessArgv": harness_args,
        "harnessCommand": " ".join(shlex.quote(part) for part in harness_cmd),
        "dryRun": bool(getattr(harness_ns, "dry_run", False)),
        # `--quiet` parses as THIS launcher's flag (both scripts define one), so
        # the harness never receives it: the arm proof reads `[leg] arm` out of
        # `harness.log`, and a silent harness would have no proof line.
        "harnessQuiet": "--quiet" in harness_args,
        "armTimeoutS": args.arm_timeout_s,
        "armCheck": not args.no_arm_check,
        "supervisor": None,
    }
    _write_json(launch_path, launch_record)

    try:
        proc = _spawn(harness_cmd, log_path, os.getcwd())
    except Exception as exc:
        _write_json(arm_path, {
            "outcome": "spawn_failed",
            "reason": f"{type(exc).__name__}: {exc}",
            "at": _iso_now(),
        })
        print(f"[launch] refused: harness spawn failed: {exc}", file=sys.stderr)
        return EXIT_REFUSED
    with open(pid_path, "w", encoding="utf-8") as fh:
        fh.write(f"{proc.pid}\n")
    launch_record["harnessPid"] = proc.pid
    log(f"harness pid {proc.pid} launched detached (own session) -> {log_path}")

    def spawn_supervisor(guard_unit: Optional[str]) -> None:
        """Start the fallback supervisor beside the harness, in its own session.

        ADAAAA-9008: spawned after the durable deadline guard is armed, so it
        also owns disarming that timer when the leg ends. A supervisor that
        cannot start is a named gap, not a silent one.
        """
        if args.no_supervisor:
            return
        sup_cmd = [
            args.python, args.supervisor_script,
            "--run-dir", run_dir,
            "--heartbeat", heartbeat_path,
            "--stale-s", str(args.supervisor_stale_s),
            "--arm-timeout-s", str(args.arm_timeout_s),
            "--slack-s", str(getattr(harness_ns, "hard_stop_slack_s", 10.0)),
            "--job-base", getattr(harness_ns, "job_base", "http://127.0.0.1:3000"),
            "--evidence-out", supervisor_evidence,
        ]
        if guard_unit:
            sup_cmd += ["--deadline-guard-unit", guard_unit]
        for flag, key in (
            ("--token", "token"), ("--user-id", "user_id"), ("--email", "email"),
            ("--mint-token-container", "mint_token_container"),
            ("--postgres-container", "postgres_container"),
            ("--box-cmd", "box_cmd"), ("--repo-root", "repo_root"),
        ):
            value = getattr(harness_ns, key, None)
            if value:
                sup_cmd += [flag, str(value)]
        sup_cmd.append("--quiet")
        try:
            sup = _spawn(sup_cmd, supervisor_log, os.getcwd())
            with open(supervisor_pid_path, "w", encoding="utf-8") as fh:
                fh.write(f"{sup.pid}\n")
            launch_record["supervisor"] = {
                "pid": sup.pid,
                "command": " ".join(shlex.quote(part) for part in sup_cmd),
                "staleS": args.supervisor_stale_s,
                "evidence": supervisor_evidence,
                "deadlineGuardUnit": guard_unit,
            }
            log(f"fallback supervisor pid {sup.pid} (stale heartbeat >= "
                f"{args.supervisor_stale_s:.0f} s)")
        except Exception as exc:
            # A supervisor that cannot start is a named gap, not a silent one.
            launch_record["supervisor"] = {
                "pid": None,
                "error": f"{type(exc).__name__}: {exc}",
            }
            log(f"WARNING: fallback supervisor did not start: {exc}")
    _write_json(launch_path, launch_record)

    if args.no_arm_check:
        spawn_supervisor(None)
        _write_json(launch_path, launch_record)
        _write_json(arm_path, {
            "outcome": "arm_check_skipped",
            "at": _iso_now(),
            "reason": "(--no-arm-check) — this leg is NOT evidence of a supervised run",
            "harnessPid": proc.pid,
            "log": log_path,
            "evidence": evidence_path,
        })
        log("ARM CHECK SKIPPED (--no-arm-check): this leg is not evidence")
        return EXIT_ARMED

    # ---- the arm proof ----------------------------------------------------
    deadline = time.time() + max(0.0, args.arm_timeout_s)
    reason: Optional[str] = None
    beat: Optional[Dict[str, Any]] = None
    armed: Optional[Dict[str, Any]] = None
    exited_early: Optional[int] = None
    while True:
        text = _read_text(log_path)
        armed = parse_arm_line(text)
        beat = harness_mod.read_json(heartbeat_path)
        alive = pid_alive(proc.pid)
        beat_ok = bool(
            beat
            and beat.get("jobId")
            and int(beat.get("pid") or 0) == proc.pid
            and beat.get("phase") in ("armed", "running", "stopping")
        )
        if armed and armed["pid"] == proc.pid and beat_ok and alive:
            break
        rc = proc.poll()
        if rc is not None:
            exited_early = rc
            # A short leg can arm and finish before the next sample. That is a
            # supervised leg; anything else is a harness that died young.
            finished_beat = harness_mod.read_json(heartbeat_path) or {}
            if armed and armed["pid"] == proc.pid and (
                beat_ok or finished_beat.get("phase") == "finished"
            ):
                beat = finished_beat or beat
                break
            reason = f"harness exited rc={rc} before arming"
            break
        if time.time() >= deadline:
            missing = []
            if not armed:
                missing.append("no `[leg] arm` line")
            if not beat_ok:
                missing.append("no heartbeat naming this pid and a job")
            if not alive:
                missing.append("harness pid not alive")
            reason = (
                f"not armed within {args.arm_timeout_s:.0f} s: " + ", ".join(missing)
            )
            break
        time.sleep(0.25)

    verified = reason is None and armed is not None

    if not verified:
        job_id = parse_job_id(_read_text(log_path))
        stop = {"jobId": job_id, "attempted": False, "ok": False, "http": None,
                "tokenSource": None, "error": None}
        if job_id and not getattr(harness_ns, "dry_run", False):
            log(f"ARM FAILED — stopping job {job_id} instead of leaving it unguarded")
            stop = stop_job(harness_ns, job_id)
        elif job_id:
            stop["error"] = "dry-run: the stub job lives in the dead harness process"
        _write_json(arm_path, {
            "outcome": "arm_failed",
            "reason": reason,
            "at": _iso_now(),
            "harnessPid": proc.pid,
            "harnessExitedRc": exited_early,
            "jobId": job_id,
            "stop": stop,
            "armLine": armed,
            "heartbeat": beat,
            "log": log_path,
            "evidence": evidence_path,
            "logTail": _read_text(log_path)[-2000:],
        })
        print(
            "[launch] ARM FAILED: "
            + str(reason)
            + (f" — job {job_id} stopped (HTTP {stop['http']})"
               if stop.get("ok")
               else f" — job {job_id} STOP NOT CONFIRMED ({stop.get('error')})"
               if job_id else " — nothing was metered"),
            file=sys.stderr,
        )
        print("[launch] no supervised leg exists; do not grade this run",
              file=sys.stderr)
        return EXIT_ARM_FAILED

    assert armed is not None  # the arm proof above returns EXIT_ARM_FAILED otherwise

    # ---- the durable deadline guard (ADAAAA-9008) -------------------------
    # An armed harness plus an armed supervisor is still not a guarantee: on the
    # ADAAAA-8998 C2 leg both were killed in the same second and the job metered
    # 375 s past its clock. The deadline itself is therefore committed to
    # systemd, which lives outside every session/cgroup the guards share.
    dry_run = bool(getattr(harness_ns, "dry_run", False))
    guard_plan = deadline_guard_plan(
        beat,
        now=time.time(),
        grace_s=args.deadline_guard_grace_s,
        prefix=args.deadline_guard_prefix,
    )
    if args.deadline_guard == "none":
        guard: Dict[str, Any] = {
            "kind": "disabled",
            "armed": False,
            "durable": False,
            "reason": "(--deadline-guard none) — no layer survives SIGKILL of both guards",
            "plan": guard_plan,
        }
    elif dry_run and args.deadline_guard == "auto":
        guard = {
            "kind": "skipped_dry_run",
            "armed": False,
            "durable": False,
            "reason": (
                "dry-run: the stub job lives inside the harness process, so there "
                "is nothing an external timer could stop"
            ),
            "plan": guard_plan,
        }
    else:
        guard = arm_deadline_guard(
            guard_plan,
            run_dir=run_dir,
            job_base=getattr(harness_ns, "job_base", "http://127.0.0.1:3000"),
            python=args.python,
            token=getattr(harness_ns, "token", None),
            user_id=getattr(harness_ns, "user_id", None),
            email=getattr(harness_ns, "email", None),
            mint_container=getattr(harness_ns, "mint_token_container", "highlights-server"),
        )
        guard["durable"] = bool(guard.get("armed"))
        guard["plan"] = guard_plan
    guard_record = {**guard, "at": _iso_now(), "dryRun": dry_run}
    _write_json(guard_path, guard_record)

    if args.deadline_guard != "none" and not dry_run and not guard.get("durable"):
        # Do not run a metered leg with no layer that survives both guards: that
        # is the 8998 shape. Stop the job it can name and refuse the leg.
        disarm = disarm_deadline_guard(guard.get("unit"))
        job_id = armed["job"]
        stop = stop_job(harness_ns, job_id) if job_id else {
            "jobId": job_id, "attempted": False, "ok": False, "http": None,
            "tokenSource": None, "error": "no job id",
        }
        _write_json(arm_path, {
            "outcome": "arm_failed",
            "reason": f"no durable deadline guard: {guard.get('error') or guard.get('reason')}",
            "at": _iso_now(),
            "harnessPid": proc.pid,
            "jobId": job_id,
            "stop": stop,
            "deadlineGuard": guard_record,
            "deadlineGuardDisarmed": disarm,
            "armLine": armed,
            "heartbeat": beat,
            "log": log_path,
            "evidence": evidence_path,
            "logTail": _read_text(log_path)[-2000:],
        })
        print(
            "[launch] ARM FAILED: the authorized deadline could not be committed "
            f"({guard.get('error') or guard.get('reason')})"
            + (f" — job {job_id} stopped (HTTP {stop['http']})" if stop.get("ok")
               else f" — job {job_id} STOP NOT CONFIRMED ({stop.get('error')})"),
            file=sys.stderr,
        )
        print("[launch] no supervised leg exists; do not grade this run",
              file=sys.stderr)
        return EXIT_ARM_FAILED

    spawn_supervisor(guard.get("unit") if guard.get("durable") else None)
    _write_json(launch_path, launch_record)
    durable = bool(guard.get("durable")) and bool(
        (launch_record.get("supervisor") or {}).get("pid")
    )

    _write_json(arm_path, {
        "outcome": "armed",
        "at": _iso_now(),
        "harnessPid": proc.pid,
        "jobId": armed["job"],
        "heartbeatPath": heartbeat_path,
        "heartbeat": beat,
        "evidence": evidence_path,
        "log": log_path,
        "supervisor": launch_record.get("supervisor"),
        "deadlineGuard": guard_record,
        "durable": durable,
        "deadlineAt": (beat or {}).get("deadlineAt"),
        "authorizedDurationS": (beat or {}).get("authorizedDurationS"),
        "capUsd": (beat or {}).get("capUsd"),
    })
    log(
        f"ARMED: pid={proc.pid} job={armed['job']} "
        f"stop=harness@{(beat or {}).get('deadlineAt')} "
        f"(cap ${(beat or {}).get('capUsd')})"
    )
    if guard.get("durable"):
        log(
            f"deadline guard armed: unit={guard.get('unit')} fires "
            f"{guard.get('fireAt')} ({guard.get('delayS')}s) "
            f"state={guard.get('activeState')}"
        )
    else:
        log(
            "WARNING: no durable deadline guard "
            f"({guard.get('kind')}: {guard.get('error') or guard.get('reason')}) — "
            "if both guard processes die, nothing stops the job (ADAAAA-9008)"
        )
    log(f"heartbeat {heartbeat_path}")
    log(f"evidence  {evidence_path}")
    log("the harness runs in its own session: closing this shell does not stop it")
    return EXIT_ARMED


if __name__ == "__main__":
    sys.exit(main())

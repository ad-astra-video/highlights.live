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

Everything the launcher decides is on disk, so the next reader does not have to
re-derive it:

    <run-dir>/launch.json       what was launched, when, with which argv
    <run-dir>/harness.log       the harness's own stdout/stderr
    <run-dir>/heartbeat.json    the live heartbeat (harness pid/job/deadline)
    <run-dir>/harness.pid       the harness pid
    <run-dir>/supervisor.pid    the fallback supervisor pid
    <run-dir>/supervisor.json   the supervisor's verdict (when it intervenes)
    <run-dir>/arm.json          this launcher's arm verdict
    <run-dir>/evidence.json     the harness evidence bundle

Exit codes:
  0  armed — the harness is detached, alive, and its heartbeat names the job
  8  arm failed — no live harness heartbeat/pid inside the arm window; the job
     this launcher could name was stopped. No supervised leg exists.
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

    if not args.no_supervisor:
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
        "deadlineAt": (beat or {}).get("deadlineAt"),
        "authorizedDurationS": (beat or {}).get("authorizedDurationS"),
        "capUsd": (beat or {}).get("capUsd"),
    })
    log(
        f"ARMED: pid={proc.pid} job={armed['job']} "
        f"stop=harness@{(beat or {}).get('deadlineAt')} "
        f"(cap ${(beat or {}).get('capUsd')})"
    )
    log(f"heartbeat {heartbeat_path}")
    log(f"evidence  {evidence_path}")
    log("the harness runs in its own session: closing this shell does not stop it")
    return EXIT_ARMED


if __name__ == "__main__":
    sys.exit(main())

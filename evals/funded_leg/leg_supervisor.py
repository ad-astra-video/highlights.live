#!/usr/bin/env python3
"""Fallback supervisor: stop the leg when the harness's heartbeats stop.

ADAAAA-8943. `funded_leg.py` arms its wall-clock stop in a daemon thread inside
its own process, so that process is the whole guard. On the ADAAAA-8924 rev-8
live leg the harness was killed together with the launching exec session about a
minute after `job created`: no `WALL-CLOCK STOP`, no evidence file, and the job
ran its full content and past it. The operator stopped it 1783 s after create;
settled `costUsd $1.4537` against a `$1.3000` cap.

This supervisor is the second stop. It is launched by
`evals/funded_leg/launch_funded_leg.py` in its OWN session, beside the harness,
and it reads the harness heartbeat file (`--heartbeat-path`). Two conditions
make it act, and both are cases where no harness process can act:

  * the heartbeat went STALE (`now - beatAt > --stale-s`): the harness died, was
    killed, or is wedged, so nothing inside it can issue the stop;
  * the heartbeat's absolute `deadlineEpoch` passed by more than `--slack-s` and
    the leg has not reported `finished`: the stop thread did not fire in time.

A heartbeat whose phase is `finished` ends the supervisor with no stop: the
harness ended the leg itself. The supervisor never stops a job it cannot name
from a heartbeat, and it never stops twice.

ADAAAA-9008: this process can be killed too. On the ADAAAA-8998 C2 leg both
guard processes vanished in the same second, `supervisor.log` was 0 bytes and
no `supervisor.json` existed — so a reader could not tell "never armed" from
"killed while watching", and the job metered 375 s past its clock. This
supervisor now:

  * writes `<run-dir>/supervisor.json` with `outcome: "watching"` as soon as it
    has a heartbeat, and refreshes `lastBeatAt` every `--watch-beat-s`, so its
    own liveness is on disk instead of implied by a log that may be empty;
  * ALWAYS logs its start and its death (even under `--quiet`, which only
    silences per-poll noise), so a zero-byte log is impossible;
  * catches SIGTERM/SIGINT/SIGHUP, records the death (`outcome:
    "killed_while_watching"` + the signal), and issues the stop itself when the
    last heartbeat still names a live phase — a guard that is being torn down
    stops the job instead of leaving it unguarded. Only SIGKILL is uncatchable,
    and `launch_funded_leg.py` arms a systemd transient timer as the layer that
    survives even SIGKILL (ADAAAA-9008).

Everything it decides is written to `--evidence-out` (default
`<run-dir>/supervisor.json`):

    { "outcome": "watching" | "finished" | "stopped_stale_heartbeat"
                 | "stopped_deadline" | "killed_while_watching"
                 | "no_arm" | "stop_unconfirmed",
      "jobId": …, "pid": …, "lastBeatAt": …, "staleS": …,
      "stop": { "attempted": …, "ok": …, "http": …, "error": … } }

Exit codes:
  0  the leg finished on its own, or the supervisor's stop was confirmed
  2  a stop was attempted and NOT confirmed — the job may still be live
  3  no heartbeat appeared inside the arm window (nothing to supervise)
  4  refused — unusable config
  6  killed by a caught signal while watching (the stop is in the record)

$0 to prove: a stop call bills nothing, and the unit tests drive `decide()`
directly, so no funded leg is needed to test this.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Callable, Dict, Optional, Sequence

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import funded_leg as harness_mod  # noqa: E402

EXIT_OK = 0
EXIT_STOP_UNCONFIRMED = 2
EXIT_NO_ARM = 3
EXIT_REFUSED = 4
EXIT_KILLED = 6

#: Heartbeat phases that mean "the harness is inside its stop loop".
LIVE_PHASES = ("armed", "running", "stopping")

#: Outcomes that mean the supervisor acted (i.e. its verdict is terminal).
STOP_ACTIONS = ("stop_stale_heartbeat", "stopped_deadline")

#: Outcomes whose stop may still be needed if the process is being torn down.
ACTING_ACTIONS = ("wait",) + STOP_ACTIONS


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _signal_name(signum: int) -> str:
    try:
        return signal.Signals(signum).name
    except ValueError:  # pragma: no cover - unknown signal number
        return f"SIG{signum}"


def _epoch_from_iso(value: Any) -> Optional[float]:
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc
        ).timestamp()
    except ValueError:
        return None


def beat_epoch(beat: Dict[str, Any], path: str) -> Optional[float]:
    """When the harness last beat: the field first, the file's mtime second.

    The mtime fallback matters for a heartbeat written by an older harness (or
    truncated mid-write): a supervisor that cannot date the last beat would
    either never act or act immediately, and both are wrong.
    """
    epoch = _epoch_from_iso(beat.get("beatAt"))
    if epoch is not None:
        return epoch
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def decide(
    beat: Optional[Dict[str, Any]],
    *,
    now: float,
    stale_s: float,
    slack_s: float,
    last_beat_at: Optional[float],
) -> Dict[str, Any]:
    """What the supervisor should do with this heartbeat, and why.

    Pure: no clock, no I/O, no stop call. The caller passes `now` and the epoch
    of the last beat, so every branch is testable at $0.
    """
    if not beat:
        return {"action": "no_arm", "reason": "no heartbeat on disk"}
    phase = beat.get("phase")
    job_id = beat.get("jobId")
    if phase == "finished":
        return {
            "action": "finished",
            "reason": f"the harness reported phase=finished ({beat.get('status')})",
            "jobId": job_id,
        }
    if not job_id:
        return {
            "action": "no_arm",
            "reason": "heartbeat names no job, so there is nothing to stop",
        }
    if phase not in LIVE_PHASES:
        return {
            "action": "no_arm",
            "reason": f"heartbeat phase `{phase}` is not a live phase",
            "jobId": job_id,
        }
    if last_beat_at is not None and (now - last_beat_at) > stale_s:
        return {
            "action": "stop_stale_heartbeat",
            "reason": (
                f"the harness heartbeat is stale by {now - last_beat_at:.1f} s "
                f"(> {stale_s:.0f} s): no harness process can issue the stop"
            ),
            "jobId": job_id,
            "staleByS": round(now - last_beat_at, 1),
        }
    deadline = beat.get("deadlineEpoch")
    try:
        deadline_f = float(deadline) if deadline is not None else None
    except (TypeError, ValueError):
        deadline_f = None
    if deadline_f is not None and now > deadline_f + max(0.0, slack_s):
        return {
            "action": "stopped_deadline",
            "reason": (
                f"the heartbeat deadline {beat.get('deadlineAt')} passed by "
                f"{now - deadline_f:.1f} s with no finished phase: the in-process "
                "stop thread did not fire"
            ),
            "jobId": job_id,
            "lateByS": round(now - deadline_f, 1),
        }
    return {
        "action": "wait",
        "reason": (
            f"heartbeat phase={phase}, last beat "
            f"{(now - last_beat_at):.1f} s ago" if last_beat_at is not None
            else f"heartbeat phase={phase}"
        ),
        "jobId": job_id,
    }


def stop_job(args: argparse.Namespace, job_id: str) -> Dict[str, Any]:
    """Issue `POST /jobs/{id}/stop`. Never raises; reports the attempt."""
    out: Dict[str, Any] = {
        "jobId": job_id,
        "attempted": True,
        "ok": False,
        "http": None,
        "error": None,
    }
    cfg = SimpleNamespace(
        token=getattr(args, "token", None),
        user_id=getattr(args, "user_id", None),
        email=getattr(args, "email", None),
        mint_token_container=getattr(args, "mint_token_container", "highlights-server"),
    )
    runner = harness_mod.RealRunner(
        postgres_container=getattr(args, "postgres_container", "highlights-postgres"),
        box_cmd=getattr(args, "box_cmd", "") or "",
        cyc_box_cmd=getattr(args, "cyc_box_cmd", "") or "",
        shell_cwd=getattr(args, "repo_root", "."),
    )
    try:
        token = harness_mod.mint_token(cfg, runner)
    except Exception as exc:  # no token means no stop; say so, never hide it
        out["error"] = f"token: {type(exc).__name__}: {exc}"
        return out
    try:
        res = runner.http(
            "POST",
            f"{args.job_base.rstrip('/')}/jobs/{job_id}/stop",
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


def write_verdict(path: Optional[str], payload: Dict[str, Any]) -> None:
    if not path:
        return
    try:
        harness_mod.write_json_atomic(path, payload)
    except OSError as exc:
        print(f"[supervisor] verdict write failed: {exc}", file=sys.stderr)


def start_record(
    *,
    beat: Optional[Dict[str, Any]],
    heartbeat_path: str,
    stale_s: float,
    slack_s: float,
    watch_beat_s: float,
    pid: Optional[int] = None,
    deadline_guard_unit: Optional[str] = None,
) -> Dict[str, Any]:
    """The `outcome: "watching"` record written before any decision is needed.

    ADAAAA-9008: the 8998 leg left `supervisor.log` at 0 bytes and no
    `supervisor.json` at all, so "the supervisor never armed" and "the
    supervisor armed and was killed" read identically. This record makes the
    armed-and-watching state durable, and the periodic refresh keeps
    `lastBeatAt` honest until a terminal outcome replaces it.
    """
    at = _iso_now()
    return {
        "outcome": "watching",
        "at": at,
        "startedAt": at,
        "pid": pid if pid is not None else os.getpid(),
        "heartbeatPath": heartbeat_path,
        "jobId": (beat or {}).get("jobId"),
        "harnessPid": (beat or {}).get("pid"),
        "lastBeatAt": (beat or {}).get("beatAt"),
        "legSeconds": (beat or {}).get("legSeconds"),
        "deadlineAt": (beat or {}).get("deadlineAt"),
        "deadlineEpoch": (beat or {}).get("deadlineEpoch"),
        "authorizedDurationS": (beat or {}).get("authorizedDurationS"),
        "capUsd": (beat or {}).get("capUsd"),
        "staleS": stale_s,
        "slackS": slack_s,
        "watchBeatS": watch_beat_s,
        "deadlineGuardUnit": deadline_guard_unit,
        "stop": {"attempted": False},
    }


def death_record(
    *,
    signum: int,
    beat: Optional[Dict[str, Any]],
    decision: Optional[Dict[str, Any]],
    stop_result: Optional[Dict[str, Any]],
    started_at: Optional[str],
    stale_s: float,
    slack_s: float,
    deadline_guard_unit: Optional[str] = None,
) -> Dict[str, Any]:
    """The record a supervisor writes when it is killed by a caught signal.

    A killed guard is a fact the next reader must be able to see: which signal,
    when, on which heartbeat, and whether the job got stopped on the way out.
    """
    try:
        name = signal.Signals(signum).name
    except ValueError:  # pragma: no cover - an unknown signal number
        name = f"SIG{signum}"
    live = bool(beat) and (beat or {}).get("phase") in LIVE_PHASES
    return {
        "outcome": "killed_while_watching",
        "at": _iso_now(),
        "startedAt": started_at,
        "signal": name,
        "signalNumber": int(signum),
        "reason": (
            f"{name} while watching a {((beat or {}).get('phase')) or 'missing'} "
            "heartbeat: the supervisor can no longer act, so it stops the job "
            "as it exits (ADAAAA-9008)"
        ),
        "jobId": (beat or {}).get("jobId"),
        "harnessPid": (beat or {}).get("pid"),
        "pid": os.getpid(),
        "lastBeatAt": (beat or {}).get("beatAt"),
        "legSeconds": (beat or {}).get("legSeconds"),
        "deadlineAt": (beat or {}).get("deadlineAt"),
        "authorizedDurationS": (beat or {}).get("authorizedDurationS"),
        "capUsd": (beat or {}).get("capUsd"),
        "staleS": stale_s,
        "slackS": slack_s,
        "heartbeatPhase": (beat or {}).get("phase"),
        "heartbeatLive": live,
        "lastDecision": decision,
        "deadlineGuardUnit": deadline_guard_unit,
        "stop": stop_result or {"attempted": False},
        "source": "leg_supervisor (killed while watching)",
    }


def systemctl(*args: str, timeout: float = 10.0) -> Dict[str, Any]:
    """Run `systemctl` and report what it said. Never raises.

    ADAAAA-9008: the supervisor owns the disarm of the launcher's deadline
    timer, so a clean leg leaves no timer behind. Best effort — a cell without
    systemd simply reports `rc=None`.
    """
    out: Dict[str, Any] = {"argv": ["systemctl", *args], "rc": None, "stdout": "", "error": None}
    try:
        proc = subprocess.run(
            ["systemctl", *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
        out["rc"] = proc.returncode
        out["stdout"] = (proc.stdout or b"").decode("utf-8", "replace")[-400:]
    except (OSError, subprocess.SubprocessError) as exc:
        out["error"] = f"{type(exc).__name__}: {exc}"
    return out


def disarm_deadline_guard(unit: Optional[str], log: Callable[[str], None]) -> Optional[Dict[str, Any]]:
    """Stop the launcher's deadline timer once the leg is over.

    $0: this only touches a local timer. Failing to disarm is harmless (the
    timer's stop is idempotent on a terminal job) but it is recorded, because a
    timer left firing on a finished leg is noise the next reader should see.
    """
    if not unit:
        return None
    stopped = systemctl("stop", f"{unit}.timer")
    systemctl("reset-failed", f"{unit}.timer", f"{unit}.service")
    log(f"deadline guard disarmed: unit={unit} rc={stopped.get('rc')}")
    return {"unit": unit, "disarmed": stopped.get("rc") == 0, **stopped}


def supervise(
    *,
    heartbeat_path: str,
    evidence_out: Optional[str],
    stale_s: float,
    slack_s: float,
    arm_timeout_s: float,
    poll_s: float,
    stop: Callable[[str], Dict[str, Any]],
    log: Callable[[str], None],
    now: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
    watch_beat_s: float = 10.0,
    deadline_guard_unit: Optional[str] = None,
    disarm: Optional[Callable[[Optional[str]], Any]] = None,
    state: Optional[Dict[str, Any]] = None,
) -> int:
    """The supervisor loop. `stop` and `now` are injected so tests own them.

    ADAAAA-9008: `state` is the same dict the signal handler reads, so a
    SIGTERM arrives with the last beat and the guard unit instead of a guess.
    """
    state = state if state is not None else {}
    state["heartbeatPath"] = heartbeat_path
    state["deadlineGuardUnit"] = deadline_guard_unit
    armed_deadline = now() + max(0.0, arm_timeout_s)
    beat: Optional[Dict[str, Any]] = None
    while now() < armed_deadline:
        beat = harness_mod.read_json(heartbeat_path)
        if beat:
            break
        sleep(poll_s)
    if not beat:
        beat = harness_mod.read_json(heartbeat_path)
    if not beat:
        verdict = {
            "outcome": "no_arm",
            "at": _iso_now(),
            "reason": (
                f"no heartbeat at {heartbeat_path} inside {arm_timeout_s:.0f} s; "
                "the launcher's arm check owns this case"
            ),
            "heartbeatPath": heartbeat_path,
        }
        write_verdict(evidence_out, verdict)
        log("no heartbeat appeared: nothing to supervise")
        return EXIT_NO_ARM

    log(f"watching {heartbeat_path}")
    # The armed-and-watching state is on disk before the first decision: a
    # supervisor killed while watching must not look like one that never armed.
    watching = start_record(
        beat=beat,
        heartbeat_path=heartbeat_path,
        stale_s=stale_s,
        slack_s=slack_s,
        watch_beat_s=watch_beat_s,
        deadline_guard_unit=deadline_guard_unit,
    )
    write_verdict(evidence_out, watching)
    state["startedAt"] = watching["startedAt"]
    state["beat"] = beat
    last_watch_write = now()
    last_action = "wait"
    while True:
        beat = harness_mod.read_json(heartbeat_path)
        last_beat_at = beat_epoch(beat or {}, heartbeat_path)
        decision = decide(
            beat,
            now=now(),
            stale_s=stale_s,
            slack_s=slack_s,
            last_beat_at=last_beat_at,
        )
        state["beat"] = beat
        state["decision"] = decision
        action = decision["action"]
        if action != last_action:
            log(f"{action}: {decision['reason']}")
            last_action = action
        if action == "wait" and watch_beat_s > 0 and (now() - last_watch_write) >= watch_beat_s:
            # Keep the watching record's liveness honest without a write per poll.
            watching = start_record(
                beat=beat,
                heartbeat_path=heartbeat_path,
                stale_s=stale_s,
                slack_s=slack_s,
                watch_beat_s=watch_beat_s,
                deadline_guard_unit=deadline_guard_unit,
            )
            watching["startedAt"] = state.get("startedAt")
            watching["lastDecision"] = decision
            write_verdict(evidence_out, watching)
            last_watch_write = now()
        if action == "finished":
            disarmed = disarm(deadline_guard_unit) if disarm else None
            write_verdict(evidence_out, {
                "outcome": "finished",
                "at": _iso_now(),
                "reason": decision["reason"],
                "jobId": decision.get("jobId"),
                "pid": (beat or {}).get("pid"),
                "lastBeatAt": (beat or {}).get("beatAt"),
                "staleS": stale_s,
                "deadlineGuardUnit": deadline_guard_unit,
                "deadlineGuardDisarmed": disarmed,
                "stop": {"attempted": False},
            })
            return EXIT_OK
        if action == "no_arm":
            write_verdict(evidence_out, {
                "outcome": "no_arm",
                "at": _iso_now(),
                "reason": decision["reason"],
                "heartbeat": beat,
                "staleS": stale_s,
                "stop": {"attempted": False},
            })
            return EXIT_NO_ARM
        if action in STOP_ACTIONS:
            job_id = decision["jobId"]
            log(f"STOPPING job {job_id}: {decision['reason']}")
            result = stop(job_id)
            verdict = {
                "outcome": action,
                "at": _iso_now(),
                "reason": decision["reason"],
                "jobId": job_id,
                "pid": (beat or {}).get("pid"),
                "lastBeatAt": (beat or {}).get("beatAt"),
                "deadlineAt": (beat or {}).get("deadlineAt"),
                "authorizedDurationS": (beat or {}).get("authorizedDurationS"),
                "capUsd": (beat or {}).get("capUsd"),
                "staleS": stale_s,
                "staleByS": decision.get("staleByS"),
                "lateByS": decision.get("lateByS"),
                "stop": result,
                "deadlineGuardUnit": deadline_guard_unit,
                "source": "leg_supervisor (the harness could not issue the stop)",
            }
            if result.get("ok"):
                verdict["outcome"] = (
                    "stopped_stale_heartbeat"
                    if action == "stop_stale_heartbeat"
                    else "stopped_deadline"
                )
                # The job is stopped, so the durable timer has nothing left to do.
                verdict["deadlineGuardDisarmed"] = (
                    disarm(deadline_guard_unit) if disarm else None
                )
                write_verdict(evidence_out, verdict)
                log(f"stop confirmed (HTTP {result.get('http')})")
                return EXIT_OK
            verdict["outcome"] = "stop_unconfirmed"
            write_verdict(evidence_out, verdict)
            log(f"STOP NOT CONFIRMED: {result.get('error')}")
            return EXIT_STOP_UNCONFIRMED
        sleep(poll_s)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="leg_supervisor.py",
        description=(
            "Stop a funded leg when the harness heartbeat goes stale or its "
            "authorized deadline passes without a finished phase (ADAAAA-8943)."
        ),
    )
    p.add_argument("--run-dir", default=None, help="the launcher's run dir")
    p.add_argument("--heartbeat", required=True,
                   help="the harness heartbeat JSON (`--heartbeat-path`)")
    p.add_argument("--evidence-out", default=None,
                   help="write the verdict here (default <run-dir>/supervisor.json)")
    p.add_argument("--stale-s", type=float, default=45.0,
                   help="stop when the last beat is older than this (default 45)")
    p.add_argument("--slack-s", type=float, default=10.0,
                   help="tolerated lateness past deadlineEpoch (default 10)")
    p.add_argument("--arm-timeout-s", type=float, default=30.0,
                   help="seconds to wait for the first heartbeat (default 30)")
    p.add_argument("--poll-s", type=float, default=2.0,
                   help="seconds between heartbeat reads (default 2)")
    p.add_argument("--watch-beat-s", type=float, default=10.0,
                   help="seconds between liveness refreshes of the watching "
                        "record (0 disables; default 10)")
    p.add_argument("--deadline-guard-unit", default=None,
                   help="the launcher's systemd timer unit; disarmed when the "
                        "leg ends (ADAAAA-9008)")
    p.add_argument("--job-base", default="http://127.0.0.1:3000",
                   help="the job API base")
    p.add_argument("--token", default=None,
                   help="bearer token (default: mint one like the harness)")
    p.add_argument("--user-id", default=None)
    p.add_argument("--email", default=None)
    p.add_argument("--mint-token-container", default="highlights-server")
    p.add_argument("--postgres-container", default="highlights-postgres")
    p.add_argument("--box-cmd", default="")
    p.add_argument("--cyc-box-cmd", default="")
    p.add_argument("--repo-root", default=".")
    p.add_argument("--quiet", action="store_true")
    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(list(sys.argv[1:] if argv is None else argv))

    def log(msg: str) -> None:
        if not args.quiet:
            print(f"[supervisor] {msg}", flush=True)

    def log_always(msg: str) -> None:
        # Start/death lines ignore `--quiet`: a supervisor log that reads 0 bytes
        # after a killed guard is exactly the ADAAAA-9008 forensic gap, and
        # `--quiet` only exists to silence per-poll noise.
        print(f"[supervisor] {msg}", file=sys.stderr, flush=True)

    evidence_out = args.evidence_out
    if not evidence_out and args.run_dir:
        evidence_out = os.path.join(os.path.abspath(args.run_dir), "supervisor.json")
    if not args.heartbeat:
        print("[supervisor] refused: --heartbeat is required", file=sys.stderr)
        return EXIT_REFUSED
    if args.stale_s <= 0 and args.slack_s < 0:
        print("[supervisor] refused: --stale-s must be > 0", file=sys.stderr)
        return EXIT_REFUSED

    heartbeat_path = os.path.abspath(args.heartbeat)
    guard_unit = args.deadline_guard_unit
    state: Dict[str, Any] = {"startedAt": _iso_now()}

    def on_signal(signum: int, _frame: Any) -> None:
        """A guard being torn down stops the job it was guarding.

        SIGKILL cannot be caught, so this is not the whole answer — the
        launcher's systemd timer is the layer that survives SIGKILL
        (ADAAAA-9008). What this does close is the caught-signal case, which
        must never look like a clean exit.
        """
        beat = harness_mod.read_json(heartbeat_path) or state.get("beat")
        last_beat_at = beat_epoch(beat or {}, heartbeat_path)
        decision = decide(
            beat,
            now=time.time(),
            stale_s=args.stale_s,
            slack_s=args.slack_s,
            last_beat_at=last_beat_at,
        )
        job_id = decision.get("jobId")
        stop_result: Optional[Dict[str, Any]] = None
        if job_id and decision.get("action") in ACTING_ACTIONS:
            log_always(
                f"{_signal_name(signum)} while watching: stopping job {job_id} "
                "on the way out (no guard is left to do it)"
            )
            stop_result = stop_job(args, job_id)
            log_always(f"exit stop HTTP {stop_result.get('http')} ok={stop_result.get('ok')}")
        else:
            log_always(
                f"{_signal_name(signum)} while watching: nothing to stop "
                f"(action={decision.get('action')})"
            )
        write_verdict(evidence_out, death_record(
            signum=signum,
            beat=beat,
            decision=decision,
            stop_result=stop_result,
            started_at=state.get("startedAt"),
            stale_s=args.stale_s,
            slack_s=args.slack_s,
            deadline_guard_unit=guard_unit,
        ))
        os._exit(EXIT_KILLED)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            signal.signal(sig, on_signal)
        except (ValueError, OSError):  # pragma: no cover - non-main thread
            pass

    log_always(
        f"start pid={os.getpid()} heartbeat={heartbeat_path} "
        f"stale-s={args.stale_s:g} slack-s={args.slack_s:g} "
        f"deadline-guard={guard_unit or '-'} verdict={evidence_out or '-'}"
    )

    return supervise(
        heartbeat_path=heartbeat_path,
        evidence_out=evidence_out,
        stale_s=args.stale_s,
        slack_s=args.slack_s,
        arm_timeout_s=args.arm_timeout_s,
        poll_s=args.poll_s,
        watch_beat_s=args.watch_beat_s,
        deadline_guard_unit=guard_unit,
        disarm=lambda unit: disarm_deadline_guard(unit, log_always),
        state=state,
        stop=lambda job_id: stop_job(args, job_id),
        log=log,
    )


if __name__ == "__main__":
    sys.exit(main())

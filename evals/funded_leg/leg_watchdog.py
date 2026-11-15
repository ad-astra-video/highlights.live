#!/usr/bin/env python3
"""Launcher-side watchdog: keep watching the leg after the arm proof passed.

ADAAAA-9012. Source incident: ADAAAA-8998 leg `d46c3788` (file-sim, kids300,
cap $1.45, abort $1.31, authorized 1200 s). `harness.log` ends at
`[leg] heartbeat t=793.8s status=active` with no `WALL-CLOCK STOP`,
`heartbeat.json` froze at that same beat, `supervisor.log` was 0 bytes, there
was no `supervisor.json` and no `evidence.json`. The job kept billing and the
API stopped it 372 s past the authorization, settling `cancelled`
`costUsd 1.2683`. `arm.json` had said `outcome: "armed"` with a live supervisor
pid — so the arm proof passed and the leg was still unattended.

`launch_funded_leg.py` used to exit 0 the moment the arm proof passed. That is
the gap this module closes: the launcher spawns this watchdog in its own
session, and it keeps reading the heartbeat for the whole leg.

Two triggers, both on the watchdog's OWN clock (never on the harness's
cooperation):

  * STALL — the heartbeat has not advanced for more than
    `stall_factor × stale_s` (default 2 × 45 s). Two missed supervisor windows
    is not an instrument blip; it is a harness that stopped beating.
  * DEADLINE — `deadlineEpoch + hardStopSlackS` has passed on the wall clock,
    whatever the heartbeat says. This needs no heartbeat field at all: the
    launcher passes the epoch in on the argv.

On either trigger it issues `POST /jobs/{id}/stop` itself and writes what it
did: `watchdog.json`, plus `capBreach` / `stopSourceClass` into `arm.json` (and
into `evidence.json` once the harness has written it), so the leg is refused by
the grader instead of being graded as a supervised run. A stop from here is
`stopSourceClass: "external"` by construction: it is not the harness's stop.

Exit codes:
  0  the leg reached a terminal state (or a stop this watchdog issued was
     confirmed); nothing left to guard
  2  a stop was attempted and NOT confirmed — the job may still be live
  3  nothing to watch (no heartbeat naming a job, no job id given)
  4  refused — unusable config

$0 to prove: a stop call bills nothing, the job record read is read-only, and
every branch is a pure function of (`beat`, `now`, `stall_s`, `deadline_stop`)
that the tests drive directly.
"""

from __future__ import annotations

import argparse
import json
import os
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
EXIT_NOTHING = 3
EXIT_REFUSED = 4

TERMINAL = ("done", "failed", "cancelled")

#: How long after an outside stop to wait for the harness to publish evidence,
#: so the watchdog's reading can be folded into the bundle the grader reads.
EVIDENCE_WAIT_S = 90.0


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
    """When the harness last beat: the field first, the file's mtime second."""
    epoch = _epoch_from_iso((beat or {}).get("beatAt"))
    if epoch is not None:
        return epoch
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def decide_watch(
    beat: Optional[Dict[str, Any]],
    *,
    now: float,
    stale_s: float,
    stall_factor: float,
    deadline_stop_epoch: Optional[float],
    job_id: Optional[str],
    job_status: Optional[str],
    last_beat_at: Optional[float],
) -> Dict[str, Any]:
    """What the watchdog should do, and why. Pure — no clock, no I/O."""
    beat = beat or {}
    named = beat.get("jobId") or job_id
    if job_status in TERMINAL:
        return {
            "action": "finished",
            "reason": f"the job is terminal (status={job_status})",
            "jobId": named,
        }
    if beat.get("phase") == "finished":
        return {
            "action": "finished",
            "reason": f"the harness reported phase=finished ({beat.get('status')})",
            "jobId": named,
        }
    if not named:
        return {
            "action": "nothing",
            "reason": "no heartbeat jobId and no --job-id: nothing to watch",
        }
    stall_s = max(0.0, stale_s) * max(1.0, stall_factor)
    if last_beat_at is not None and (now - last_beat_at) > stall_s:
        return {
            "action": "stopped_stall_heartbeat",
            "reason": (
                f"the heartbeat has not advanced for {now - last_beat_at:.1f} s "
                f"(> {stall_s:.0f} s = {stall_factor:g} x stale-s {stale_s:g}): "
                "the harness is not beating, so no harness process can stop it"
            ),
            "jobId": named,
            "stallByS": round(now - last_beat_at, 1),
            "stallS": round(stall_s, 1),
            "trigger": "heartbeat_stall",
        }
    if deadline_stop_epoch is not None and now > deadline_stop_epoch:
        return {
            "action": "stopped_deadline",
            "reason": (
                f"the authorized deadline + hard-stop slack passed by "
                f"{now - deadline_stop_epoch:.1f} s on the watchdog's own clock "
                "with the job still live"
            ),
            "jobId": named,
            "lateByS": round(now - deadline_stop_epoch, 1),
            "trigger": "own_clock_deadline",
        }
    return {
        "action": "wait",
        "reason": (
            f"job {named} live, heartbeat "
            + (
                f"{now - last_beat_at:.1f} s old"
                if last_beat_at is not None
                else "undated"
            )
        ),
        "jobId": named,
    }


def _runner(args: argparse.Namespace) -> Any:
    return harness_mod.RealRunner(
        postgres_container=getattr(args, "postgres_container", "highlights-postgres"),
        box_cmd=getattr(args, "box_cmd", "") or "",
        cyc_box_cmd=getattr(args, "cyc_box_cmd", "") or "",
        shell_cwd=getattr(args, "repo_root", "."),
    )


def _token(args: argparse.Namespace, runner: Any) -> Dict[str, Any]:
    """Mint or reuse a bearer token, and report which it was."""
    out: Dict[str, Any] = {
        "tokenSource": "arg" if getattr(args, "token", None) else "minted",
        "token": None,
        "tokenError": None,
    }
    cfg = SimpleNamespace(
        token=getattr(args, "token", None),
        user_id=getattr(args, "user_id", None),
        email=getattr(args, "email", None),
        mint_token_container=getattr(args, "mint_token_container", "highlights-server"),
    )
    try:
        out["token"] = harness_mod.mint_token(cfg, runner)
    except Exception as exc:  # no token means no stop; say so, never hide it
        out["tokenError"] = f"{type(exc).__name__}: {exc}"
    return out


def job_record(
    job_base: str, job_id: str, token: Optional[str], *, timeout: float = 15.0
) -> Dict[str, Any]:
    """Read the job record back. Never raises; `ok` says whether it landed.

    The record is the leg's own money statement (`status`, `costUsd`,
    `stopRequestedAt`, billed counts), so a stop is not "confirmed" on an HTTP
    status alone.
    """
    out: Dict[str, Any] = {"ok": False, "status": None, "error": None, "record": None}
    if not token:
        out["error"] = "no token: cannot read the job record"
        return out
    req = None
    try:
        import urllib.error
        import urllib.request

        req = urllib.request.Request(
            f"{job_base.rstrip('/')}/jobs/{job_id}",
            method="GET",
            headers={"Authorization": f"Bearer {token}"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = (res.read() or b"{}").decode("utf-8", "replace")
        body = json.loads(raw or "{}")
        record = body.get("job") if isinstance(body, dict) and isinstance(
            body.get("job"), dict
        ) else body
        out["record"] = record if isinstance(record, dict) else None
        out["status"] = (out["record"] or {}).get("status")
        out["ok"] = out["record"] is not None
    except Exception as exc:
        out["error"] = f"{type(exc).__name__}: {exc}"
    return out


def snapshot(record: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The few fields a reader needs to grade a stop, named explicitly."""
    record = record or {}
    observe = record.get("observeMetrics") if isinstance(
        record.get("observeMetrics"), dict
    ) else {}
    return {
        "status": record.get("status"),
        "costUsd": record.get("costUsd"),
        "perceiveSessionS": record.get("perceiveSessionS"),
        "decideCalls": record.get("decideCalls"),
        "confirmCalls": record.get("confirmCalls") or observe.get("confirmDiveCount"),
        "summaryCalls": record.get("summaryCalls"),
        "stopRequestedAt": record.get("stopRequestedAt"),
        "stopReason": record.get("stopReason"),
        "error": record.get("error"),
        "finishedAt": record.get("finishedAt"),
    }


def cap_breach(
    snap: Dict[str, Any], cap_usd: Optional[float], *, source: str
) -> Optional[Dict[str, Any]]:
    """The overspend, when the settled cost is over the cap. Never a guess."""
    if cap_usd is None or not snap:
        return None
    try:
        cost = float(snap.get("costUsd"))
        cap = float(cap_usd)
    except (TypeError, ValueError):
        return None
    overspend = max(0.0, cost - cap)
    if overspend <= 1e-9:
        return None
    return {
        "capUsd": cap,
        "settledCostUsd": round(cost, 6),
        "overspendUsd": round(overspend, 6),
        "stopSource": source,
        "cause": (
            "the leg was stopped from outside the harness after the heartbeat "
            "stopped advancing, so no wall-clock or metered-ceiling stop of its "
            "own fired"
        ),
    }


def stop_job(args: argparse.Namespace, job_id: str, tok: Dict[str, Any]) -> Dict[str, Any]:
    """Issue `POST /jobs/{id}/stop` with a token this process owns."""
    out: Dict[str, Any] = {
        "jobId": job_id,
        "attempted": True,
        "ok": False,
        "http": None,
        "tokenSource": tok.get("tokenSource"),
        "tokenError": tok.get("tokenError"),
        "error": None,
    }
    token = tok.get("token")
    if not token:
        out["error"] = f"token: {tok.get('tokenError') or 'no token'}"
        return out
    try:
        res = _runner(args).http(
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


def _merge_json(path: Optional[str], payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Read-merge-write a JSON artifact. Returns the body it wrote, or None."""
    if not path:
        return None
    existing = harness_mod.read_json(path) or {}
    merged = {**existing, **payload}
    try:
        harness_mod.write_json_atomic(path, merged)
    except OSError as exc:
        print(f"[watchdog] {path} write failed: {exc}", file=sys.stderr)
        return None
    return merged


def watch(
    *,
    run_dir: str,
    arm_path: Optional[str],
    evidence_path: Optional[str],
    verdict_path: str,
    heartbeat_path: str,
    stale_s: float,
    stall_factor: float,
    deadline_stop_epoch: Optional[float],
    hard_stop_slack_s: float,
    job_id: Optional[str],
    cap_usd: Optional[float],
    timeout_s: float,
    poll_s: float,
    read_record: Callable[[str], Dict[str, Any]],
    stop: Callable[[str], Dict[str, Any]],
    log: Callable[[str], None],
    now: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Watch until the leg ends, and stop it if nothing else can.

    `read_record`/`stop`/`now` are injected so every branch is provable at $0.
    """
    started_at = _iso_now()
    seen_beat_at: Optional[float] = None
    record = {
        "outcome": "watching",
        "at": started_at,
        "startedAt": started_at,
        "pid": os.getpid(),
        "heartbeatPath": heartbeat_path,
        "jobId": job_id,
        "staleS": stale_s,
        "stallFactor": stall_factor,
        "stallS": round(max(0.0, stale_s) * max(1.0, stall_factor), 1),
        "hardStopSlackS": hard_stop_slack_s,
        "deadlineStopEpoch": deadline_stop_epoch,
        "deadlineStopAt": (
            datetime.fromtimestamp(deadline_stop_epoch, timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            )
            if deadline_stop_epoch is not None
            else None
        ),
        "capUsd": cap_usd,
        "trigger": "watching",
        "stop": {"attempted": False},
    }
    harness_mod.write_json_atomic(verdict_path, record)
    log(
        f"watching job={job_id or '-'} heartbeat={heartbeat_path} "
        f"stall={record['stallS']}s deadline={record['deadlineStopAt'] or '-'}"
    )

    # The launcher writes `arm.json` right after spawning this process; acting
    # before it exists would leave a stop with no arm proof beside it.
    if arm_path:
        waited = 0.0
        while waited < 10.0 and not harness_mod.read_json(arm_path):
            sleep(0.2)
            waited += 0.2

    end = now() + max(1.0, timeout_s)
    decision: Dict[str, Any] = {"action": "wait", "reason": "starting"}
    last_action: Optional[str] = None
    while now() < end:
        beat = harness_mod.read_json(heartbeat_path)
        last_beat_at = beat_epoch(beat or {}, heartbeat_path)
        if last_beat_at is not None:
            seen_beat_at = last_beat_at
        read = read_record(beat.get("jobId") or job_id) if (beat or job_id) else {
            "ok": False, "status": None, "error": "no job id", "record": None,
        }
        decision = decide_watch(
            beat,
            now=now(),
            stale_s=stale_s,
            stall_factor=stall_factor,
            deadline_stop_epoch=deadline_stop_epoch,
            job_id=job_id,
            job_status=read.get("status"),
            last_beat_at=seen_beat_at,
        )
        if decision["action"] != last_action:
            log(f"{decision['action']}: {decision['reason']}")
            last_action = decision["action"]
        if decision["action"] == "finished":
            harness_mod.write_json_atomic(verdict_path, {
                **record,
                "outcome": "finished",
                "at": _iso_now(),
                "reason": decision["reason"],
                "jobId": decision.get("jobId"),
                "lastBeatAt": (beat or {}).get("beatAt"),
                "jobStatus": read.get("status"),
                "trigger": "job_terminal",
                "stop": {"attempted": False},
            })
            return EXIT_OK
        if decision["action"] == "nothing":
            harness_mod.write_json_atomic(verdict_path, {
                **record,
                "outcome": "nothing_to_watch",
                "at": _iso_now(),
                "reason": decision["reason"],
                "stop": {"attempted": False},
            })
            return EXIT_NOTHING
        if decision["action"] in ("stopped_stall_heartbeat", "stopped_deadline"):
            job_id_named = decision["jobId"]
            log(f"STOPPING job {job_id_named}: {decision['reason']}")
            result = stop(job_id_named)
            # Read the record back AT ONCE: a dry-run stub lives inside the
            # harness process, which leaves the leg as soon as it sees the stop,
            # and a real job settles within a beat. A read after a sleep can find
            # the server gone and report nothing.
            after = read_record(job_id_named)
            snap = snapshot(after.get("record"))
            if snap.get("status") not in TERMINAL:
                for _ in range(5):
                    sleep(max(0.2, poll_s))
                    again = read_record(job_id_named)
                    retry = snapshot(again.get("record"))
                    if retry.get("status") in TERMINAL:
                        snap, after = retry, again
                        break
            breach = cap_breach(snap, cap_usd, source="launcher_watchdog")
            # Symmetry with supervisor.json: the stop response carries the record
            # it left behind, not a separate field a reader has to join.
            result["jobRecord"] = snap
            result["jobRecordError"] = after.get("error")
            named = job_id_named
            verdict = {
                **record,
                "outcome": decision["action"] if result.get("ok") else "stop_unconfirmed",
                "at": _iso_now(),
                "reason": decision["reason"],
                "jobId": named,
                "trigger": decision.get("trigger"),
                "stallByS": decision.get("stallByS"),
                "lateByS": decision.get("lateByS"),
                "lastBeatAt": (beat or {}).get("beatAt"),
                "heartbeatPhase": (beat or {}).get("phase"),
                "stop": result,
                # A launcher-side stop is not the harness's stop: the grader
                # must refuse the leg, exactly as it refuses an operator stop.
                "stopSourceClass": "external" if result.get("ok") else None,
                "stopSource": "launcher_watchdog",
                "jobRecord": snap,
                "capBreach": breach,
            }
            harness_mod.write_json_atomic(verdict_path, verdict)
            # The arm verdict is the artifact a reader opens first; put the
            # watchdog's answer in it rather than only beside it.
            _merge_json(arm_path, {
                "watch": {
                    "outcome": verdict["outcome"],
                    "at": verdict["at"],
                    "trigger": verdict.get("trigger"),
                    "reason": verdict["reason"],
                    "stallByS": verdict.get("stallByS"),
                    "lateByS": verdict.get("lateByS"),
                    "lastBeatAt": verdict.get("lastBeatAt"),
                    "stop": result,
                    "jobRecord": snap,
                    "verdict": verdict_path,
                },
                "stopSource": "launcher_watchdog",
                "stopSourceClass": verdict["stopSourceClass"],
                "capBreach": breach,
            })
            if result.get("ok"):
                log(f"stop confirmed (HTTP {result.get('http')}); job {snap.get('status')}")
                _fold_into_evidence(
                    evidence_path, verdict, log=log, poll_s=poll_s, now=now,
                    sleep=sleep,
                )
                return EXIT_OK
            log(f"STOP NOT CONFIRMED: {result.get('error')}")
            return EXIT_STOP_UNCONFIRMED
        sleep(poll_s)

    harness_mod.write_json_atomic(verdict_path, {
        **record,
        "outcome": "watch_timeout",
        "at": _iso_now(),
        "reason": f"the watchdog window ({timeout_s:.0f} s) ran out",
        "lastDecision": decision,
        "stop": {"attempted": False},
    })
    log("watch window ran out with the leg still live: nothing else could stop it")
    return EXIT_OK


def _fold_into_evidence(
    evidence_path: Optional[str],
    verdict: Dict[str, Any],
    *,
    log: Callable[[str], None],
    poll_s: float,
    now: Callable[[], float],
    sleep: Callable[[float], None],
) -> Optional[Dict[str, Any]]:
    """Add the watchdog's reading to the harness bundle, after it is written.

    The harness writes `evidence.json` when it leaves the leg, which is after an
    outside stop, so a bounded wait is the honest way to fold this in. Never
    rewrites the harness's own numbers: it adds `launcherWatch`, and only fills
    `stopSourceClass` if the harness left it out.
    """
    if not evidence_path:
        return None
    end = now() + EVIDENCE_WAIT_S
    while now() < end:
        body = harness_mod.read_json(evidence_path)
        if body and "leg" in body:
            update: Dict[str, Any] = {"launcherWatch": verdict}
            if not body.get("stopSourceClass"):
                update["stopSourceClass"] = verdict.get("stopSourceClass")
            if verdict.get("capBreach") and not body.get("capBreach"):
                update["capBreach"] = verdict["capBreach"]
            written = _merge_json(evidence_path, update)
            log(f"folded the watchdog reading into {os.path.basename(evidence_path)}")
            return written
        sleep(max(0.2, poll_s))
    log("evidence.json never appeared: the watchdog verdict stands alone")
    return None


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="leg_watchdog.py",
        description=(
            "Keep watching a launched funded leg after the arm proof, and stop "
            "the job when the heartbeat stalls or the authorized deadline "
            "passes with the job still live (ADAAAA-9012)."
        ),
    )
    p.add_argument("--run-dir", required=True)
    p.add_argument("--heartbeat", required=True,
                   help="the harness heartbeat JSON (`--heartbeat-path`)")
    p.add_argument("--arm", default=None,
                   help="the launcher's arm.json (default <run-dir>/arm.json)")
    p.add_argument("--evidence", default=None,
                   help="the harness evidence (default <run-dir>/evidence.json)")
    p.add_argument("--evidence-out", default=None,
                   help="write the watchdog verdict here (default "
                        "<run-dir>/watchdog.json)")
    p.add_argument("--job-id", default=None,
                   help="the job to watch, independent of the heartbeat")
    p.add_argument("--stale-s", type=float, default=45.0,
                   help="the heartbeat staleness the supervisor uses (default 45)")
    p.add_argument("--stall-factor", type=float, default=2.0,
                   help="stall trip = this x --stale-s (default 2)")
    p.add_argument("--deadline-epoch", type=float, default=None,
                   help="the heartbeat's deadlineEpoch, passed on the argv so "
                        "the watchdog's clock does not depend on the heartbeat")
    p.add_argument("--hard-stop-slack-s", type=float, default=10.0)
    p.add_argument("--cap-usd", type=float, default=None)
    p.add_argument("--watch-timeout-s", type=float, default=3600.0,
                   help="hard bound on the watch window (default 3600)")
    p.add_argument("--poll-s", type=float, default=2.0)
    p.add_argument("--job-base", default="http://127.0.0.1:3000")
    p.add_argument("--token", default=None)
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
            print(f"[watchdog] {msg}", flush=True)

    def log_always(msg: str) -> None:
        # Start/death/stop lines ignore `--quiet`: a watchdog log that reads 0
        # bytes is the ADAAAA-9008 forensic gap repeated (ADAAAA-9012). The
        # quiet flag exists to silence per-poll noise, and this loop only logs
        # on an action change.
        print(f"[watchdog] {msg}", file=sys.stderr, flush=True)

    run_dir = os.path.abspath(args.run_dir)
    verdict_path = args.evidence_out or os.path.join(run_dir, "watchdog.json")
    arm_path = os.path.abspath(args.arm) if args.arm else os.path.join(run_dir, "arm.json")
    evidence_path = (
        os.path.abspath(args.evidence) if args.evidence
        else os.path.join(run_dir, "evidence.json")
    )
    if args.stale_s <= 0:
        print("[watchdog] refused: --stale-s must be > 0", file=sys.stderr)
        return EXIT_REFUSED

    tok = _token(args, _runner(args))

    timeout_s = args.watch_timeout_s
    if args.deadline_epoch is not None:
        # Never outlive the leg it guards by more than one stall window plus the
        # slack: a watchdog still running an hour after the deadline is noise.
        bounded = (
            args.deadline_epoch
            + max(0.0, args.hard_stop_slack_s)
            + args.stale_s * max(1.0, args.stall_factor)
            + EVIDENCE_WAIT_S
            - time.time()
        )
        timeout_s = min(timeout_s, max(30.0, bounded))

    try:
        return watch(
            run_dir=run_dir,
            arm_path=arm_path,
            evidence_path=evidence_path,
            verdict_path=verdict_path,
            heartbeat_path=os.path.abspath(args.heartbeat),
            stale_s=args.stale_s,
            stall_factor=args.stall_factor,
            deadline_stop_epoch=(
                args.deadline_epoch + max(0.0, args.hard_stop_slack_s)
                if args.deadline_epoch is not None
                else None
            ),
            hard_stop_slack_s=args.hard_stop_slack_s,
            job_id=args.job_id,
            cap_usd=args.cap_usd,
            timeout_s=timeout_s,
            poll_s=args.poll_s,
            read_record=lambda job_id: job_record(args.job_base, job_id, tok.get("token")),
            stop=lambda job_id: stop_job(args, job_id, tok),
            log=log_always,
        )
    except Exception as exc:  # a watchdog that dies says so on disk
        harness_mod.write_json_atomic(verdict_path, {
            "outcome": "crashed",
            "at": _iso_now(),
            "error": f"{type(exc).__name__}: {exc}",
            "jobId": args.job_id,
            "stop": {"attempted": False},
        })
        print(f"[watchdog] crashed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_STOP_UNCONFIRMED


if __name__ == "__main__":
    sys.exit(main())

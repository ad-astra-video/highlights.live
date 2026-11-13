#!/usr/bin/env python3
"""Funded-leg harness: a leg that cannot spend outside its authorized shape.

ADAAAA-8489. Source incident: ADAAAA-8483 disclosure 2 — a cell authorized at
<= 300 s / <= $0.50 ran `perceiveSessionS 544.5` and spent $0.6197 because the
leg's stop loop lost its stop moment and a human had to notice. This harness
replaces the hand-held stop and the hand-held gate check with two hard rules:

  1. PREFLIGHT (before ANY metered call). The leg refuses to start unless the
     box has been quiet for the whole window: 0 nonterminal jobs, media node
     `capacity.activeSessions 0`, all lease counters 0, and no `session=cyc-`
     on the decide pool. A closed gate exits 3 and creates nothing.
  2. HARD WALL-CLOCK STOP. The stop is driven by the wall clock, never by
     media progress or stop-moment bookkeeping (the 8483 failure mode). At
     `authorized_duration_s` the leg stops itself; if the stop is not confirmed
     within `hard_stop_slack_s` (<= 10 s) the process exits non-zero instead of
     leaving a live job behind. A metered-cost ceiling aborts even earlier.

     ADAAAA-8529 (item 1): the metered ceiling is graded on
     `max(record costUsd, projection)` where the projection is the METER'S OWN
     CLOCK — elapsed since job create x `metered_rate_usd_per_s` — not just the
     record's `perceiveSessionS`. On the live rail `costUsd` AND
     `perceiveSessionS` are only written at settlement, so a guard that reads
     the record has nothing to abort on for the whole leg it exists for (leg
     `7d99d651`: shape read `actualCostUsd 0.0` while the leg metered
     $0.55-0.58). The clock projection is readable from the first second.

     ADAAAA-8832: the projection is priced in the unit the BUILD BILLS, not a
     single per-second rate. The billing identity is
     `costUsd = decideFee x (decideCalls + confirmCalls) + summaryFee x
     summaryCalls + perceiveSessionS/3600 x PERCEIVE_PER_HOUR_USD`
     (`packages/events/src/decide-knob.ts`, `services/server/src/api.ts`), so a
     decide-billed leg's clock projection is `elapsed x (decideFee/cadence +
     perceive accrual)`. Leg `27bd816f` (a 540 s browser share) was stopped at
     357 s because the guard projected wall clock at the $0.0011381/perceive-s
     rate instead: $0.4414 against a $0.414 abort point, while the leg's real
     spend at that instant was ~$0.2353 (71 decides at $0.0033324). A leg that
     bills by the decide must not be priced by the perceive second.

     Second rule from the same defect: a projection never overrides a READABLE
     billed figure. When the record discloses a positive `costUsd`, the guard
     runs on it (plus any record-disclosed billed units); the clock is a
     fallback for a dark record only. A clock extrapolation that disagrees with
     the money already accounted must not stop a leg.

Every run writes an evidence JSON whose `shape` block carries the
authorized-vs-actual duration and cost side by side, so an overshoot is a field
in the evidence rather than something a reader has to discover.

ADAAAA-8529 evidence items (the leg is refused, not silently graded, when the
artifact under test cannot be named):

  * `build` — the build sha plus the served-vs-git md5 of the four files the
    delivery tail runs through. A mismatch or an unreadable probe refuses the
    leg before any metered call: a leg graded on an unrecorded build is a grade
    of an unknown artifact. Beside it, `decideConfig` records the decide config
    in force (pool, model, window keep-ratio, frame budget) read from the server
    container's environment — those values are not in the tree, so the sha alone
    cannot name the artifact (ADAAAA-8525 changes live decide window sending and
    `decideE2e` is the dominant p50 stage).
  * `preflight.allQuiet` — the quiet verdict the harness itself reached, so a
    derived field downstream cannot contradict a quiet window.
  * `clips` — the clip count plus, when it is 0, the stage fields that carry
    the persist->export tail instead (item 2 met by stage fields, stated).
  * `leg.startedAt`/`leg.finishedAt`/`leg.durationS` — the duration the grader
    can read even though a live `done` record carries no timestamps.

Dry-run (`--dry-run`) runs the whole loop against an in-process stub API: no
GPU, no box, no metered call. That is how the hard stop and the gate refusal
are proved; a funded cell runs the same code with the real endpoints.

Exit codes:
  0  within the authorized shape (duration and cost)
  2  OVER the authorized shape (the leg ran, and it overshot)
  3  gate closed at preflight — refused, nothing metered
  4  stop unconfirmed — live job may remain; do not report the leg as valid
  5  leg setup/start failed (job create, session create, or driver launch)
  6  build identity unverified — refused, nothing metered
  7  stopped OUTSIDE the guard — the leg's stop came from an operator/external
     call (or the job ended by itself past its shape), so the harness refuses to
     grade it and flags any cap breach in `capBreach`. See ADAAAA-8943.

ADAAAA-8943 — the guard must survive the caller. On the rev-8 live leg
(ADAAAA-8924) the harness process was killed together with the launching exec
session ~1 min after `job created`: no `WALL-CLOCK STOP` line, no evidence
file, and the job ran to its content end and past it. The operator stopped it
1783 s after create, settled `costUsd $1.4537` against a `$1.3000` cap, and
nothing in the bundle named the stop as unguarded. Three changes:

  * `--heartbeat-path` — the harness writes an atomic heartbeat JSON (pid, job,
    phase, deadline, stop state) while it runs, and prints an `[leg] arm ...`
    line and periodic `[leg] heartbeat ...` lines on stdout. A launcher can
    prove the guard is live from outside this process before it hands the leg
    over (`evals/funded_leg/launch_funded_leg.py`), and a fallback supervisor
    can stop the job if the heartbeats stop (`leg_supervisor.py`).
  * the stop is classified. A leg whose terminal state arrived without this
    process issuing a stop is `operator_api` (a stop the harness did not make)
    or `job_content_end`, never reported as a harness stop. Evidence carries
    `leg.stopSource`/`stopSourceClass`.
  * such a leg is NOT gradable: exit 7, `result.outcome
    "stopped_outside_guard"`, and `capBreach` with the overspend when the
    settled cost crossed the cap. A grade over a leg that ran without a guard
    is a grade of an unknown shape.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Sequence, Tuple

VERSION = "1.5.0"

#: ADAAAA-8529 item 2: the four files a live leg is served from. A leg graded on
#: an unrecorded build is a grade of an unknown artifact, so the harness records
#: the served md5 of each and refuses when any one differs from
#: `git show <build>:<path>`.
DEFAULT_BUILD_FILES = (
    "services/server/src/live-delivery.ts",
    "services/server/src/live.ts",
    "services/server/src/observe-loop.ts",
    "packages/events/src/index.ts",
)

#: ADAAAA-8529 item 2, extended by the ruling on ADAAAA-8528: a build sha alone
#: does not name the artifact a leg was graded on, because the decide config is
#: not in the tree — it is in the server's environment. `decideE2e` is the
#: dominant stage in the p50 bar, and ADAAAA-8525 changes live decide window
#: sending, so a leg graded across that change without these values recorded is
#: a grade of an unknown artifact, exactly like an unrecorded md5.
DEFAULT_DECIDE_CONFIG_KEYS = (
    "DECIDE_URL",              # the pool the decide calls go through
    "GEMMA_MODEL",             # the model the decide workers serve
    "LIVE_DECIDE_KEEP_RATIO",  # the live window keep-ratio
    "LIVE_OBSERVE_MAX_FRAMES", # the frame budget the window is sent at
    "LIVE_OBSERVE_CADENCE_S",  # the decide cadence the projection is priced at
)

#: ADAAAA-8832: the build's billed unit, mirrored from the shipped contract so a
#: decide-billed leg is priced by the decide. These four constants are the whole
#: `costUsd` identity (`services/server/src/api.ts`,
#: `packages/events/src/decide-knob.ts`, `packages/events/src/highlight-summary.ts`);
#: the harness prices the projection with them instead of guessing one $/s rate
#: for every rail.
DECIDE_USD_PER_DECIDE = 0.0033324
DECIDE_CADENCE_DEFAULT_S = 5.0
SUMMARY_FEE_RATIO = 1.5
PERCEIVE_PER_HOUR_USD = 0.01

#: The two metering bases the guard can price a leg in.
BILLING_BASES = ("decide", "perceive")

#: Decide pool containers whose session markers count against the gate.
#: On the box the pool is proxied by `decide-pool-8183` (x99) to the workers on
#: the 5090 host, so pass `--cyc-box-cmd` when the containers are not local.
DEFAULT_POOL_CONTAINERS = ("decide-gpu0", "decide-gpu1", "decide-gpu2")

#: The decide workers log `session=<jobId>` per decision. `session=cyc-` is a
#: subset of this pattern (older builds prefixed ids with `cyc-`), so counting
#: every `session=` line proves the `session=cyc-` clause as well.
DEFAULT_CYC_PATTERN = "session="

#: Emits `<container>:<count>` per container, or `<container>:-1` when the
#: container is absent. `-1` is a failed probe, never a silent zero.
CYC_SNIPPET = (
    'for c in {containers}; do '
    'if docker inspect -f 1 "$c" >/dev/null 2>&1; then '
    'printf "%s:" "$c"; docker logs --since {since} "$c" 2>/dev/null '
    '| grep -c {pattern}; '
    'else printf "%s:-1\\n" "$c"; fi; done'
)

#: Nonterminal job predicate used by every gate read in this harness.
NONTERMINAL_SQL = (
    "select count(*) from jobs where status not in ('done','failed','cancelled')"
)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def write_json_atomic(path: str, payload: Dict[str, Any]) -> None:
    """Write a JSON file so a reader never sees a half-written document.

    ADAAAA-8943: the heartbeat is read by another process (the launcher's arm
    check, the fallback supervisor). A truncate-then-write there can be read as
    an empty file and misdiagnosed as "the harness died".
    """
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def read_json(path: str) -> Optional[Dict[str, Any]]:
    """Read a JSON object, or None when it is absent/unreadable."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            body = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    return body if isinstance(body, dict) else None


def record_stop_fields(record: Any) -> Dict[str, Any]:
    """The stop-signalling fields a job record discloses (ADAAAA-8943).

    A harness stop and an operator stop both set `stopRequestedAt`, so these
    fields cannot say WHO stopped the job. They say a stop was requested at all,
    which is what separates an externally-requested stop from a job that simply
    ran out of content.
    """
    if not isinstance(record, dict):
        return {}
    out: Dict[str, Any] = {}
    for key in ("status", "stopRequestedAt", "stopReason", "error", "finishedAt"):
        if key in record:
            out[key] = record.get(key)
    return out


def classify_stop_source(
    *,
    harness_stop_issued: bool,
    harness_stop_reason: str,
    terminal_without_harness_stop: bool,
    record: Any,
) -> Dict[str, str]:
    """Name where the leg's stop actually came from.

    ADAAAA-8943. The incident leg settled `stop source: operator API stop` while
    the bundle reported the harness's own reason, so a reader could not see that
    the guard never fired. Three shapes:

      * `harness` — this process issued the stop that ended the leg.
      * `external` — the job reached a terminal state with a stop request this
        process did not make (an operator `POST /jobs/{id}/stop`, a cancel).
      * `job_self_ended` — the job ended on its own with no stop request at all
        (its content ran out). Not an unguarded stop, but it is graded against
        the authorized duration like any other end.
    """
    stop = record_stop_fields(record)
    error = str(stop.get("error") or "").lower()
    external_signalled = bool(stop.get("stopRequestedAt")) or "stop" in error
    if harness_stop_issued and not terminal_without_harness_stop:
        return {
            "stopSource": harness_stop_reason or "harness",
            "stopSourceClass": "harness",
            "stopSourceLine": (
                f"STOP-SOURCE: harness (`{harness_stop_reason}`) — the guard "
                "issued the stop"
            ),
        }
    if external_signalled:
        detail = stop.get("stopReason") or stop.get("error") or "stopRequestedAt set"
        return {
            "stopSource": "operator_api",
            "stopSourceClass": "external",
            "stopSourceLine": (
                "STOP-SOURCE: operator_api — the leg reached a terminal state "
                f"without a harness stop (`{detail}`); the authorized stop never "
                "fired, so this leg is NOT gradable"
            ),
        }
    if terminal_without_harness_stop:
        return {
            "stopSource": "job_content_end",
            "stopSourceClass": "job_self_ended",
            "stopSourceLine": (
                "STOP-SOURCE: job_content_end — the job ended on its own with no "
                "stop request; the harness did not issue the stop"
            ),
        }
    return {
        "stopSource": harness_stop_reason or "unknown",
        "stopSourceClass": "harness",
        "stopSourceLine": f"STOP-SOURCE: `{harness_stop_reason or 'unknown'}`",
    }


class GateClosed(RuntimeError):
    """The quiet-window preflight found the box busy. Nothing metered."""

    def __init__(self, reason: str, sample: "GateSample"):
        super().__init__(reason)
        self.reason = reason
        self.sample = sample


class SetupFailed(RuntimeError):
    """The leg could not be created, driven, or metered."""

    def __init__(self, message: str, job_id: Optional[str] = None) -> None:
        super().__init__(message)
        self.job_id = job_id


class BuildUnverified(RuntimeError):
    """The served build could not be matched to a git commit. Nothing metered."""

    def __init__(self, block: Dict[str, Any]) -> None:
        super().__init__(block.get("line") or "build identity unverified")
        self.block = block


@dataclass
class GateSample:
    at: str
    nonterminal_jobs: Optional[int]
    active_sessions: Optional[int]
    leases: Dict[str, Optional[int]]
    cyc_by_container: Dict[str, Optional[int]]
    server_health: Optional[str] = None
    errors: List[str] = field(default_factory=list)

    def problems(self) -> List[str]:
        out: List[str] = []
        if self.nonterminal_jobs is None:
            out.append("jobs probe failed")
        elif self.nonterminal_jobs != 0:
            out.append(f"nonterminal jobs = {self.nonterminal_jobs}")
        if self.active_sessions is None:
            out.append("activeSessions probe failed")
        elif self.active_sessions != 0:
            out.append(f"activeSessions = {self.active_sessions}")
        leases = self.leases or {}
        if not leases:
            out.append("leases probe failed")
        for key in ("active", "grace", "awaitingClient", "paying", "total"):
            if key not in leases:
                continue
            val = leases.get(key)
            if val is None:
                out.append(f"leases.{key} probe failed")
            elif val != 0:
                out.append(f"leases.{key} = {val}")
        if not self.cyc_by_container:
            out.append("decide-pool session probe failed")
        for container, count in (self.cyc_by_container or {}).items():
            if count is None:
                out.append(f"{container}: session=cyc- probe failed")
            elif count != 0:
                out.append(f"{container}: {count} session=cyc- line(s)")
        if self.server_health not in (None, "ok"):
            out.append(f"server health = {self.server_health}")
        return out

    def as_dict(self) -> Dict[str, Any]:
        return {
            "at": self.at,
            "nonterminalJobs": self.nonterminal_jobs,
            "activeSessions": self.active_sessions,
            "leases": self.leases,
            "cycByContainer": self.cyc_by_container,
            "serverHealth": self.server_health,
            # ADAAAA-8644: the exception text behind a failed probe. Without it
            # a `cannot prove quiet` refusal reads as a busy box.
            "errors": list(self.errors),
            "problems": self.problems(),
        }


# --------------------------------------------------------------------------
# Runners: the only two places that touch the outside world.
# --------------------------------------------------------------------------


@dataclass
class HttpResult:
    status: int
    body: Any
    raw: str = ""


class RealRunner:
    """Box access: local docker/psql by default, or through a remote prefix.

    `box_cmd` prefixes every control-host command (postgres, server, driver) and
    `cyc_box_cmd` prefixes the decide-pool log probe, so the same script can run
    from a workstation that reaches the fleet over a remote shell
    (e.g. `python3 .../komodo.py livepeer-ai-x99`). HTTP is issued through the
    same prefix when `box_cmd` is set, because the API/media ports listen on the
    control host only.
    """

    def __init__(
        self,
        postgres_container: str = "highlights-postgres",
        db_user: str = "highlights",
        db_name: str = "highlights",
        box_cmd: str = "",
        cyc_box_cmd: str = "",
        cyc_pattern: str = DEFAULT_CYC_PATTERN,
        shell_cwd: str = ".",
        log: Optional[List[str]] = None,
    ) -> None:
        self.postgres_container = postgres_container
        self.db_user = db_user
        self.db_name = db_name
        self.box_cmd = box_cmd.strip()
        self.cyc_box_cmd = cyc_box_cmd.strip()
        self.cyc_pattern = cyc_pattern
        self.shell_cwd = shell_cwd
        self.commands: List[str] = log if log is not None else []

    def _run(
        self,
        command: str,
        prefix: str,
        timeout: float = 60.0,
        stdin_data: Optional[str] = None,
    ) -> subprocess.CompletedProcess:
        cmd = f"{prefix} {shlex.quote(command)}" if prefix else command
        self.commands.append(cmd)
        # Never inherit the launcher's stdin (ADAAAA-8644). A `screen`/pipe
        # launcher leaves stdin open but silent, and a probe that reads stdin
        # (`psql -f -`) then blocks until `timeout` instead of seeing EOF. Under
        # `/dev/null` it sees EOF and exits 0 with no rows — a false zero. A
        # caller that needs stdin must pass `stdin_data`; `subprocess` then wires
        # a fresh pipe, and every other probe reads an explicit `/dev/null`.
        stdin_kwargs: Dict[str, Any] = (
            {"input": stdin_data} if stdin_data is not None else {"stdin": subprocess.DEVNULL}
        )
        proc = subprocess.run(
            cmd,
            shell=True,
            cwd=self.shell_cwd,
            text=True,
            capture_output=True,
            timeout=timeout,
            **stdin_kwargs,
        )
        # Remote shells append their own exit footer to stdout; it must not be
        # parsed as probe output (it glues onto the last line).
        if proc.stdout:
            proc.stdout = _strip_remote_footer(proc.stdout)
        return proc

    # -- SQL ---------------------------------------------------------------
    def sql(self, query: str) -> List[str]:
        inner = (
            f"docker exec -i {shlex.quote(self.postgres_container)} "
            f"psql -U {shlex.quote(self.db_user)} -d {shlex.quote(self.db_name)} "
            "-At -F '|' -f -"
        )
        if self.box_cmd:
            # Remote: carry the SQL as base64 so no quoting layer can eat it.
            b64 = base64.b64encode(query.encode()).decode()
            inner = f"echo {b64} | base64 -d | {inner}"
            sql_stdin: Optional[str] = None
        else:
            # Local: psql reads the query from `-f -`, so it must be fed here.
            # Leaving it to inherited stdin is the ADAAAA-8644 defect.
            sql_stdin = query
        proc = self._run(inner, self.box_cmd, stdin_data=sql_stdin)
        if proc.returncode != 0:
            raise RuntimeError(
                f"psql failed rc={proc.returncode}: {proc.stderr.strip()[:300]}"
            )
        return [line for line in proc.stdout.splitlines() if line.strip()]

    # -- HTTP --------------------------------------------------------------
    def http(
        self,
        method: str,
        url: str,
        body: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: float = 15.0,
    ) -> HttpResult:
        hdrs = {"Accept": "application/json"}
        if body is not None:
            hdrs["Content-Type"] = "application/json"
        if headers:
            hdrs.update(headers)
        if self.box_cmd:
            return self._http_remote(method, url, body, hdrs, timeout)

        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
                status = resp.status
        except urllib.error.HTTPError as exc:  # 4xx/5xx still carries a body
            raw = exc.read().decode("utf-8", "replace")
            status = exc.code
        try:
            parsed: Any = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = raw
        return HttpResult(status=status, body=parsed, raw=raw)

    def _http_remote(
        self,
        method: str,
        url: str,
        body: Optional[Dict[str, Any]],
        headers: Dict[str, str],
        timeout: float,
    ) -> HttpResult:
        parts = [
            "curl -sS",
            f"-m {int(timeout)}",
            f"-X {shlex.quote(method)}",
            "-w " + shlex.quote("HTTPSTATUS:%{http_code}"),
        ]
        for key, value in headers.items():
            parts.append(f"-H {shlex.quote(f'{key}: {value}')}")
        if body is not None:
            payload = base64.b64encode(json.dumps(body).encode()).decode()
            parts.append(f"--data-binary {shlex.quote(f'@-')}")
            inner = f"echo {payload} | base64 -d | " + " ".join(parts) + " " + shlex.quote(url)
        else:
            inner = " ".join(parts) + " " + shlex.quote(url)
        proc = self._run(inner, self.box_cmd, timeout=timeout + 15)
        marker = "HTTPSTATUS:"
        raw_body, sep, tail = proc.stdout.rpartition(marker)
        if not sep:
            raise RuntimeError(
                f"remote HTTP {method} {url} failed rc={proc.returncode}: "
                f"{(proc.stderr or proc.stdout).strip()[:300]}"
            )
        status_text = tail.strip().split()[0] if tail.strip() else ""
        try:
            status = int(status_text)
        except ValueError:
            raise RuntimeError(
                f"remote HTTP {method} {url}: unparseable status {status_text!r}"
            )
        raw = raw_body
        try:
            parsed: Any = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = raw
        return HttpResult(status=status, body=parsed, raw=raw)

    # -- decide-pool session markers --------------------------------------
    def cyc_counts(
        self, since_iso: str, containers: Sequence[str]
    ) -> Dict[str, Optional[int]]:
        snippet = CYC_SNIPPET.format(
            containers=" ".join(shlex.quote(c) for c in containers),
            since=since_iso,
            pattern=shlex.quote(self.cyc_pattern),
        )
        proc = self._run(snippet, self.cyc_box_cmd, timeout=120)
        return parse_cyc_output(proc.stdout, proc.returncode)

    # -- local shell -------------------------------------------------------
    def shell(self, command: str, timeout: float = 120.0) -> subprocess.CompletedProcess:
        return self._run(command, self.box_cmd, timeout=timeout)


def _strip_remote_footer(stdout: str) -> str:
    """Remove a remote runner's `__KOMODO_EXIT_CODE:` footer from stdout."""
    return re.sub(r"__KOMODO_EXIT_CODE:[^\n]*\n?", "", stdout)


def parse_cyc_output(stdout: str, returncode: int = 0) -> Dict[str, Optional[int]]:
    """Parse `<container>:<count>` lines; -1 / unparseable reads as a failed probe."""
    counts: Dict[str, Optional[int]] = {}
    for line in (stdout or "").splitlines():
        line = line.strip()
        if ":" not in line:
            continue
        name, _, raw = line.rpartition(":")
        try:
            value = int(raw.strip())
        except ValueError:
            counts[name] = None
            continue
        counts[name] = None if value < 0 else value
    if not counts and returncode != 0:
        return {}
    return counts


class StubRunner:
    """Dry-run access: everything is the in-process stub API, nothing is spent."""

    def __init__(self, stub: "StubApi") -> None:
        self.stub = stub
        self.commands: List[str] = []

    def sql(self, query: str) -> List[str]:
        self.commands.append(f"stub-sql: {query}")
        return [str(self.stub.gate["nonterminal"])]
    def http(
        self,
        method: str,
        url: str,
        body: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: float = 15.0,
    ) -> HttpResult:
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"},
            method=method,
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return HttpResult(status=resp.status, body=json.loads(raw or "{}"), raw=raw)

    def cyc_counts(self, since_iso: str, containers: Sequence[str]) -> Dict[str, int]:
        self.commands.append(f"stub-cyc: {since_iso} {','.join(containers)}")
        return {c: int(self.stub.gate["cyc"]) for c in containers}

    def shell(self, command: str, timeout: float = 120.0) -> subprocess.CompletedProcess:
        self.commands.append(f"stub-shell: {command}")
        self.stub.driver_starts += 1
        return subprocess.CompletedProcess(args=command, returncode=0, stdout="", stderr="")


# --------------------------------------------------------------------------
# Dry-run stub API. One in-process HTTP server, no external process.
# --------------------------------------------------------------------------


class StubApi:
    """A stand-in for `highlights-server` + media node + postgres + docker logs.

    Scenarios:
      clean        gate idle; the leg never reaches a terminal state by itself
                   (the stub's `liveEdge` advances forever), so only the
                   harness's wall-clock stop can end it.
      busy         gate busy: 1 nonterminal job, 1 active session, 1 lease, and
                   a `session=cyc-` line on the pool — the 8483 shape.
      stop-stuck   gate idle, but `/jobs/{id}/stop` never takes: proves the
                   unconfirmed-stop exit path.
      clean-no-cost  costUsd stays 0 mid-leg while perceiveSessionS advances
                   (the ADAAAA-8529 projection path).
      decide-dark  the ADAAAA-8832 shape: a decide-billed leg whose record
                   discloses neither costUsd nor perceiveSessionS nor a decide
                   count, so the guard has only the meter's clock.
      decide-record  as `decide-dark` plus the record's own `decideCalls`
                   (a leg on a build that discloses its billed count mid-leg).
      live-cost-dark-session  costUsd is READABLE while perceiveSessionS is
                   dark: the billed figure must win over any clock projection.
      no-cost-source  both cost and metered time unreadable: the leg must be
                   refused.
      operator-stop-overspend  ADAAAA-8943: the job flips to `cancelled` with a
                   stop request this process did not make, settled ABOVE the
                   cap. The leg must be refused as ungradable with the breach in
                   the evidence.
      operator-stop-within     the same outside stop, settled UNDER the cap: still
                   not gradable, but no breach to flag.
    """

    def __init__(self, scenario: str, cost_per_s: float = 0.0016) -> None:
        self.scenario = scenario
        self.cost_per_s = cost_per_s
        self.live_cost = scenario not in (
            "clean-no-cost",
            "no-cost-source",
            "decide-dark",
            "decide-record",
        )
        self.metered = scenario not in (
            "no-cost-source",
            "decide-dark",
            "decide-record",
            "live-cost-dark-session",
        )
        # ADAAAA-8832: a decide-billed leg's guard prices the meter's clock at
        # `decideFee / cadence`, so the stub advances the recorded decide count
        # at that same cadence when the scenario says the record discloses it.
        self.decide_cadence_s = 5.0
        self.decide_live = scenario == "decide-record"
        busy = scenario == "busy"
        self.gate = {
            "nonterminal": 1 if busy else 0,
            "activeSessions": 1 if busy else 0,
            "leases": 1 if busy else 0,
            "cyc": 1 if busy else 0,
        }
        self.job: Optional[Dict[str, Any]] = None
        self.stop_calls = 0
        # ADAAAA-8943: the outside stop this stub performs itself, and the cost
        # it settles at (the 8924 incident's $1.4537 against a $1.30 cap).
        self.external_stop_after_s = (
            2.0 if scenario.startswith("operator-stop") else None
        )
        self.external_stop_cost_usd = {
            "operator-stop-overspend": 1.4537,
            "operator-stop-within": 0.98,
        }.get(scenario, 0.0)
        self.stop_attempts_at: List[float] = []
        self.metered_job_creates = 0
        self.metered_session_creates = 0
        self.driver_starts = 0
        self._lock = threading.Lock()
        self._httpd: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> str:
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:  # silence
                pass

            def _send(self, code: int, payload: Any) -> None:
                raw = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _body(self) -> Dict[str, Any]:
                length = int(self.headers.get("Content-Length") or 0)
                if not length:
                    return {}
                return json.loads(self.rfile.read(length).decode() or "{}")

            def do_GET(self) -> None:  # noqa: N802
                path = self.path.split("?")[0]
                if path == "/health":
                    g = stub.gate
                    self._send(
                        200,
                        {
                            "status": "ok",
                            "billing": "live",
                            "capacity": {
                                "maxSessions": 1,
                                "activeSessions": g["activeSessions"],
                                "availableSessions": max(0, 1 - g["activeSessions"]),
                            },
                            "leases": {
                                "active": g["leases"],
                                "grace": 0,
                                "awaitingClient": 0,
                                "paying": g["leases"],
                                "total": g["leases"],
                            },
                        },
                    )
                elif path.startswith("/jobs/"):
                    self._send(200, {"job": stub.job_state()})
                elif path == "/stub/state":
                    self._send(200, stub.snapshot())
                else:
                    self._send(404, {"error": "not found"})

            def do_POST(self) -> None:  # noqa: N802
                path = self.path.split("?")[0]
                body = self._body()
                if path == "/jobs":
                    with stub._lock:
                        stub.metered_job_creates += 1
                        stub.job = {
                            "id": "stub-job-0001",
                            "status": "running",
                            "costUsd": 0.0,
                            "perceiveSessionS": 0.0,
                            "createdAt": _now().isoformat().replace("+00:00", "Z"),
                            "_t0": time.monotonic(),
                            "_stoppedAt": None,
                        }
                        if stub.decide_live:
                            stub.job["decideCalls"] = 0
                    self._send(201, {"job": stub.job})
                elif path == "/sessions":
                    with stub._lock:
                        stub.metered_session_creates += 1
                    self._send(201, {"sessionId": "stub-session-0001"})
                elif path.endswith("/stop"):
                    with stub._lock:
                        stub.stop_calls += 1
                        stub.stop_attempts_at.append(time.monotonic())
                        if stub.job is not None and stub.scenario != "stop-stuck":
                            stub.job["status"] = "cancelled"
                            stub.job["_stoppedAt"] = time.monotonic()
                    self._send(200, {"job": stub.job_state()})
                elif path == "/stub/sql":
                    q = str(body.get("q", ""))
                    key = "nonterminal" if "from jobs" in q else "leases"
                    self._send(200, {"rows": [str(stub.gate[key])]})
                else:
                    self._send(404, {"error": "not found"})

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}"

    def stop(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)

    # -- state -------------------------------------------------------------
    def job_state(self) -> Optional[Dict[str, Any]]:
        if self.job is None:
            return None
        elapsed = time.monotonic() - float(self.job["_t0"])
        if (
            self.external_stop_after_s is not None
            and self.job["status"] == "running"
            and elapsed >= self.external_stop_after_s
        ):
            # ADAAAA-8943: an outside stop — no harness process asked for this.
            self.job["status"] = "cancelled"
            self.job["stopRequestedAt"] = _iso(_now())
            self.job["error"] = "stopped (cancelled via API)"
            self.job["_stoppedAt"] = time.monotonic()
        if self.job["status"] == "running":
            self.job["costUsd"] = round(elapsed * self.cost_per_s, 6) if self.live_cost else 0.0
            self.job["perceiveSessionS"] = round(elapsed, 1) if self.metered else 0.0
            if self.decide_live:
                self.job["decideCalls"] = int(elapsed / self.decide_cadence_s)
        elif self.external_stop_after_s is not None:
            # The settled figure an outside stop leaves behind (ADAAAA-8943).
            self.job["costUsd"] = self.external_stop_cost_usd
            self.job["perceiveSessionS"] = round(elapsed, 1) if self.metered else 0.0
        out = {k: v for k, v in self.job.items() if not k.startswith("_")}
        return out

    def snapshot(self) -> Dict[str, Any]:
        return {
            "scenario": self.scenario,
            "gate": dict(self.gate),
            "stopCalls": self.stop_calls,
            "meteredJobCreates": self.metered_job_creates,
            "meteredSessionCreates": self.metered_session_creates,
            "driverStarts": self.driver_starts,
            "job": self.job_state(),
        }


# --------------------------------------------------------------------------
# Preflight: the quiet-window gate.
# --------------------------------------------------------------------------


@dataclass
class Config:
    authorized_duration_s: float
    cap_usd: float
    quiet_window_s: float
    hard_stop_slack_s: float
    abort_at_usd: float
    poll_s: float
    settle_timeout_s: float
    job_base: str
    media_base: str
    job_source: str
    game_hint: Optional[str]
    sample_fps: float
    video_path: Optional[str]
    pool_containers: Sequence[str]
    driver_cmd: Optional[str]
    token: Optional[str]
    user_id: Optional[str]
    email: Optional[str]
    mint_token_container: str
    metered_rate_usd_per_s: float
    gpu_hours: Optional[float]
    repo_root: str = "."
    build_sha: str = ""
    build_container: str = "highlights-server"
    build_prefix: str = "/app"
    build_files: Sequence[str] = DEFAULT_BUILD_FILES
    decide_config_container: str = "highlights-server"
    decide_config_keys: Sequence[str] = DEFAULT_DECIDE_CONFIG_KEYS
    clips_container: str = "highlights-server"
    clips_dir: str = "/data/clips"
    # ADAAAA-8832: the unit the build bills, and the terms of its price.
    billing_basis: str = "decide"
    decide_fee_usd: float = DECIDE_USD_PER_DECIDE
    decide_cadence_s: float = DECIDE_CADENCE_DEFAULT_S
    summary_fee_ratio: float = SUMMARY_FEE_RATIO
    perceive_usd_per_hour: float = PERCEIVE_PER_HOUR_USD
    # ADAAAA-8943: the on-disk heartbeat another process reads to prove the
    # guard is alive, and how often it is refreshed.
    heartbeat_path: Optional[str] = None
    heartbeat_s: float = 5.0


@dataclass
class BillingBasis:
    """The unit the served build bills, and the $/s its clock projection uses.

    ADAAAA-8832. `decide` prices a leg the way the shipped `costUsd` does — a
    per-decide fee every `cadence` seconds plus the perceive accrual — so a
    540 s browser share projects to ~$0.36 instead of the ~$0.61 the
    perceive-second rate claims. `perceive` keeps the 8515/8529 cells working:
    metered (perceive) seconds x their own authorized rate.
    """

    basis: str = "decide"
    decide_fee_usd: float = DECIDE_USD_PER_DECIDE
    decide_cadence_s: float = DECIDE_CADENCE_DEFAULT_S
    summary_fee_ratio: float = SUMMARY_FEE_RATIO
    perceive_usd_per_hour: float = PERCEIVE_PER_HOUR_USD
    perceive_rate_usd_per_s: float = 0.0011381
    source: str = "authorized"

    def usd_per_s(self) -> float:
        if self.basis == "decide":
            if self.decide_cadence_s <= 0:
                return 0.0
            return self.decide_fee_usd / self.decide_cadence_s + (
                self.perceive_usd_per_hour / 3600.0
            )
        return self.perceive_rate_usd_per_s

    def summary_fee_usd(self) -> float:
        return self.decide_fee_usd * self.summary_fee_ratio

    def line(self) -> str:
        if self.basis == "decide":
            return (
                f"decide ${self.decide_fee_usd:.7f}/decide at a "
                f"{self.decide_cadence_s:g} s cadence + "
                f"${self.perceive_usd_per_hour:g}/perceive-hour accrual = "
                f"${self.usd_per_s():.7f}/s ({self.source})"
            )
        return (
            f"perceive ${self.perceive_rate_usd_per_s:.7f}/perceive-s ({self.source})"
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "basis": self.basis,
            "decideFeeUsd": self.decide_fee_usd,
            "decideCadenceS": self.decide_cadence_s,
            "summaryFeeUsdPerCall": round(self.summary_fee_usd(), 8),
            "summaryFeeRatio": self.summary_fee_ratio,
            "perceiveUsdPerHour": self.perceive_usd_per_hour,
            "perceiveRateUsdPerS": self.perceive_rate_usd_per_s,
            "usdPerS": round(self.usd_per_s(), 10),
            "source": self.source,
            "line": self.line(),
        }


def unit_cost_usd(
    billing: BillingBasis,
    decide_calls: Optional[int] = None,
    confirm_calls: Optional[int] = None,
    summary_calls: Optional[int] = None,
    perceive_session_s: float = 0.0,
) -> Optional[float]:
    """Price the record's own billed units; None when it discloses none.

    `confirm_calls` is the dive/confirm lane: the shipped `costUsd` bills it at
    the same decide fee (`billableConfirmCalls` in
    `services/server/src/job-settlement.ts`), so a record that discloses it is
    priced for it. Omitting the term would under-price exactly the legs that
    promote clips mid-leg.

    `None` is "the record told us nothing" and never a zero — a zero here would
    read as a leg that billed nothing, which is how the 8816 estimate went wrong
    in the first place.
    """
    if decide_calls is None and summary_calls is None and confirm_calls is None:
        return None
    decides = max(0, int(decide_calls or 0))
    confirms = max(0, int(confirm_calls or 0))
    summaries = max(0, int(summary_calls or 0))
    return (
        billing.decide_fee_usd * (decides + confirms)
        + billing.summary_fee_usd() * summaries
        + (max(0.0, perceive_session_s) / 3600.0) * billing.perceive_usd_per_hour
    )


def billing_basis_from_config(cfg: Config) -> BillingBasis:
    """Resolve the config into the billing basis the guard prices in."""
    return BillingBasis(
        basis=cfg.billing_basis,
        decide_fee_usd=cfg.decide_fee_usd,
        decide_cadence_s=cfg.decide_cadence_s,
        summary_fee_ratio=cfg.summary_fee_ratio,
        perceive_usd_per_hour=cfg.perceive_usd_per_hour,
        perceive_rate_usd_per_s=cfg.metered_rate_usd_per_s,
    )


def _int_or_none(value: Any) -> Optional[int]:
    """A non-negative int, or None when the field is absent/unparseable."""
    if value is None or isinstance(value, bool):
        return None
    try:
        out = int(value)
    except (TypeError, ValueError):
        return None
    return out if out >= 0 else None


def project_metered_cost(
    billing: BillingBasis,
    clock_s: float,
    record_perceive_session_s: float = 0.0,
    record_decide_calls: Optional[int] = None,
    record_confirm_calls: Optional[int] = None,
    record_summary_calls: Optional[int] = None,
) -> Dict[str, Any]:
    """The mid-leg spend projection, priced in the unit the build bills.

    ADAAAA-8832. Two readings, both on the billed unit:

      * the meter's clock x the basis rate — readable from job create, and the
        only reading a dark live record offers;
      * the record's own counts (`decideCalls`/`confirmCalls`/`summaryCalls`),
        priced exactly, when the record discloses them.

    The larger is the guard, and `projectedFrom` names which reading it came
    from. The clock is an upper bound only while the cadence holds, so an exact
    count that exceeds it wins; a count that reads lower never prices the
    projection BELOW the clock, because a leg that has metered longer than its
    counts claim still has to be held to its projection.
    """
    rate = billing.usd_per_s()
    projection_s = max(0.0, clock_s)
    projected_from = "clock"
    if billing.basis == "perceive" and record_perceive_session_s > projection_s:
        projection_s = record_perceive_session_s
        projected_from = "record_perceiveSessionS"
    clock_usd = projection_s * rate
    units = unit_cost_usd(
        billing,
        decide_calls=record_decide_calls,
        confirm_calls=record_confirm_calls,
        summary_calls=record_summary_calls,
        perceive_session_s=record_perceive_session_s,
    )
    if units is not None and units > clock_usd:
        return {
            "usd": units,
            "projectedFrom": "record_units",
            "fromBasis": billing.basis,
            "rateUsdPerS": rate,
            "clockUsd": round(clock_usd, 6),
            "recordUnitsUsd": round(units, 6),
            "projectionS": round(projection_s, 3),
        }
    return {
        "usd": clock_usd,
        "projectedFrom": projected_from,
        "fromBasis": billing.basis,
        "rateUsdPerS": rate,
        "clockUsd": round(clock_usd, 6),
        "recordUnitsUsd": round(units, 6) if units is not None else None,
        "projectionS": round(projection_s, 3),
    }


def sample_gate(runner: Any, cfg: Config, quiet_since: datetime) -> GateSample:
    sample = GateSample(
        at=_iso(_now()),
        nonterminal_jobs=None,
        active_sessions=None,
        leases={},
        cyc_by_container={},
    )
    try:
        rows = runner.sql(NONTERMINAL_SQL)
        # A count query always returns one row. No row means the query never ran
        # (the ADAAAA-8644 `/dev/null` arm), not that the box is idle.
        if not rows:
            raise RuntimeError("jobs probe returned no rows")
        sample.nonterminal_jobs = int(rows[0])
    except Exception as exc:  # probe failure must read as "cannot prove quiet"
        sample.errors.append(f"jobs: {exc}")

    try:
        res = runner.http("GET", f"{cfg.media_base}/health")
        body = res.body if isinstance(res.body, dict) else {}
        if res.status != 200:
            sample.errors.append(f"media health HTTP {res.status}")
        sample.active_sessions = (body.get("capacity") or {}).get("activeSessions")
        sample.leases = (body.get("leases") or {}) or {}
        server = runner.http("GET", f"{cfg.job_base}/health")
        sb = server.body if isinstance(server.body, dict) else {}
        sample.server_health = sb.get("status") if server.status == 200 else f"HTTP {server.status}"
    except Exception as exc:
        sample.errors.append(f"health: {exc}")

    try:
        sample.cyc_by_container = runner.cyc_counts(
            _iso(quiet_since), cfg.pool_containers
        )
    except Exception as exc:
        sample.errors.append(f"cyc: {exc}")

    # ADAAAA-8644: probe errors are carried in `errors` and folded into the
    # refusal reason by preflight(), so `server_health` stays the server's own
    # answer instead of being overwritten with an unrelated probe failure.
    return sample


def preflight(runner: Any, cfg: Config, log) -> List[GateSample]:
    """Hold the gate closed unless the whole window is quiet. Never metered."""
    quiet_since = _now() - timedelta(seconds=cfg.quiet_window_s)
    # 15 s point samples over a 10 min window; the cyc probe looks back the whole
    # window on every sample, so its coverage is continuous.
    interval = max(5.0, min(15.0, cfg.quiet_window_s / 40.0))
    deadline = time.monotonic() + cfg.quiet_window_s
    samples: List[GateSample] = []
    while True:
        sample = sample_gate(runner, cfg, quiet_since)
        samples.append(sample)
        problems = sample.problems()
        if problems:
            reason = "; ".join(problems)
            if sample.errors:
                # Name the cause: a probe that failed to read is not a busy box.
                reason = f"{reason} (probe errors: {'; '.join(sample.errors)})"
            raise GateClosed(reason, sample)
        log(
            f"preflight {sample.at} quiet: jobs 0, activeSessions 0, leases 0, "
            f"cyc 0/{len(cfg.pool_containers)}"
        )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(interval, remaining))
    return samples


def preflight_block(
    samples: Sequence[GateSample],
    quiet_window_s: float,
    verdict: str,
    reason: Optional[str] = None,
) -> Dict[str, Any]:
    """The preflight evidence block, including the harness's OWN quiet verdict.

    ADAAAA-8529 item 4: `verdict: open` already means "quiet window proved".
    The 8516 bundle re-derived the window outside this script and published
    `allQuiet: false` beside 19 all-quiet samples and `verdict: open`, which
    reads to a reviewer as a gate violation. `allQuiet` is now emitted here, from
    the same predicate that decides the verdict, so the two cannot disagree.
    """
    quiet = [s for s in samples if not s.problems()]
    block: Dict[str, Any] = {
        "verdict": verdict,
        "allQuiet": verdict == "open" and bool(samples) and len(quiet) == len(samples),
        "quietWindowS": quiet_window_s,
        "sampleCount": len(samples),
        "quietSamples": len(quiet),
        "notQuietSamples": len(samples) - len(quiet),
        # ADAAAA-8644: probe failures travel with the bundle, stamped with the
        # sample they came from, so a refusal names its cause.
        "errors": [f"{s.at}: {err}" for s in samples for err in s.errors],
        "windowFrom": samples[0].at if samples else None,
        "windowTo": samples[-1].at if samples else None,
        "samples": [s.as_dict() for s in samples],
    }
    if reason is not None:
        block["reason"] = reason
    return block


# --------------------------------------------------------------------------
# Leg
# --------------------------------------------------------------------------


@dataclass
class LegResult:
    job_id: str
    session_id: Optional[str]
    started_at: str
    created_at: str
    finished_at: str
    started_monotonic: float
    stop_reason: str
    stop_issued_monotonic: Optional[float]
    stop_confirmed: bool
    settled_status: Optional[str]
    cost_usd: float
    perceive_session_s: float
    duration_s: float
    stop_calls: int
    driver_rc: Optional[int]
    cost_source: str = "none"
    projected_cost_usd: float = 0.0
    driver_output_tail: str = ""
    # ADAAAA-8529 item 1: the METER'S clock at the stop instant (elapsed since job
    # create), and which source the projection was taken from.
    metered_projection_s: float = 0.0
    projected_from: str = "none"
    # ADAAAA-8832: the unit the projection was priced in, the $/s that unit
    # implies, and the priced reading the guard actually stopped on.
    projected_basis: str = "decide"
    metered_usd_per_s: float = 0.0
    record_units_usd: Optional[float] = None
    record_decide_calls: Optional[int] = None
    record_confirm_calls: Optional[int] = None
    record_summary_calls: Optional[int] = None
    guard_source: str = "none"
    # ADAAAA-8529 item 1: what the record itself disclosed mid-leg. `dark` is the
    # live rail's normal state (costUsd/perceiveSessionS land only at settlement),
    # and it must stay visible instead of reading as a zero cost.
    record_cost_source: str = "dark"
    # ADAAAA-8529 item 5: the leg's delivered rows, for the stage-field fallback
    # when nothing recorded a screen share.
    delivered_rows: List[Dict[str, Any]] = field(default_factory=list)
    # ADAAAA-8943: where the stop came from, so a leg the guard never stopped is
    # never reported as a supervised leg.
    stop_source: str = "harness"
    stop_source_class: str = "harness"
    stop_source_line: str = ""
    harness_stop_issued: bool = True
    terminal_without_harness_stop: bool = False
    record_stop: Dict[str, Any] = field(default_factory=dict)
    armed_at: Optional[str] = None
    heartbeat_path: Optional[str] = None


def _job_field(body: Any, key: str, default: Any = None) -> Any:
    if isinstance(body, dict):
        job = body.get("job") if isinstance(body.get("job"), dict) else body
        if isinstance(job, dict):
            return job.get(key, default)
    return default


def _record_count(record: Any, key: str) -> Optional[int]:
    """A billed count the record discloses at top level or under observeMetrics.

    ADAAAA-8832: `None` means the field is absent — the live rail is dark on
    these counts mid-leg — and must stay distinguishable from a real 0.
    """
    if not isinstance(record, dict):
        return None
    if key in record:
        return _int_or_none(record.get(key))
    observe = record.get("observeMetrics")
    if isinstance(observe, dict) and key in observe:
        return _int_or_none(observe.get(key))
    return None


def mint_token(cfg: Config, runner: Any) -> str:
    if cfg.token:
        return cfg.token
    if not cfg.user_id:
        raise SetupFailed(
            "no token: pass --token, set HL_LEG_TOKEN, or pass --user-id so the "
            "harness can mint one inside the server container"
        )
    script = (
        "const jwt=require('jsonwebtoken');"
        "process.stdout.write(jwt.sign("
        "{sub:process.env.U,email:process.env.E||'leg-harness@highlights.local',"
        "role:'user'},process.env.JWT_SECRET,{expiresIn:'4h'}))"
    )
    cmd = (
        f"docker exec -e U={shlex.quote(cfg.user_id)} "
        f"-e E={shlex.quote(cfg.email or 'leg-harness@highlights.local')} "
        f"{shlex.quote(cfg.mint_token_container)} node -e {shlex.quote(script)}"
    )
    proc = runner.shell(cmd, timeout=60)
    token = (proc.stdout or "").strip()
    if proc.returncode != 0 or not token:
        raise SetupFailed(f"token mint failed rc={proc.returncode}: {proc.stderr[:300]}")
    return token


def run_leg(runner: Any, cfg: Config, log) -> LegResult:
    token = mint_token(cfg, runner)
    headers = {"Authorization": f"Bearer {token}"}
    started = _now()

    body: Dict[str, Any] = {"source": cfg.job_source, "sampleFps": cfg.sample_fps}
    if cfg.game_hint:
        body["gameHint"] = cfg.game_hint
    if cfg.video_path:
        body["videoPath"] = cfg.video_path
    created = runner.http("POST", f"{cfg.job_base}/jobs", body=body, headers=headers)
    job_id = _job_field(created.body, "id")
    if created.status not in (200, 201) or not job_id:
        raise SetupFailed(f"job create HTTP {created.status}: {created.raw[:300]}")
    log(f"job {job_id} created {_iso(started)}")

    # ADAAAA-8529 item 1: the server bills the perceive meter from the top of
    # runLiveJob — i.e. from this create, not from driver start — so the meter's
    # own clock is `now - t_create`. On the live rail the job record does NOT
    # disclose costUsd or perceiveSessionS until settlement (leg `7d99d651` read
    # both as 0 for all 480 s), so this clock is the only guard available
    # mid-leg, and it is available from the first second.
    t_create = time.monotonic()

    session_id: Optional[str] = None
    session = runner.http(
        "POST",
        f"{cfg.media_base}/sessions",
        body={"jobId": job_id, "sampleFps": cfg.sample_fps},
        headers=headers,
    )
    if isinstance(session.body, dict):
        session_id = session.body.get("sessionId") or (
            (session.body.get("session") or {}).get("id")
            if isinstance(session.body.get("session"), dict)
            else None
        )
    if session.status not in (200, 201) or not session_id:
        # The job exists but nothing is driving it: stop before leaving it.
        runner.http("POST", f"{cfg.job_base}/jobs/{job_id}/stop", headers=headers)
        raise SetupFailed(f"session create HTTP {session.status}: {session.raw[:300]}")
    log(f"media session {session_id}")

    driver_rc: Optional[int] = None
    driver_tail = ""
    if cfg.driver_cmd:
        cmd = cfg.driver_cmd.format(
            sid=session_id, job=job_id, seconds=int(cfg.authorized_duration_s)
        )
        proc = runner.shell(cmd, timeout=60)
        driver_rc = proc.returncode
        driver_tail = ((proc.stdout or "") + (proc.stderr or ""))[-500:]
        log(f"driver launched rc={driver_rc}")
        if driver_rc != 0:
            runner.http("POST", f"{cfg.job_base}/jobs/{job_id}/stop", headers=headers)
            raise SetupFailed(f"driver launch rc={driver_rc}: {driver_tail}")

    t0 = time.monotonic()
    window_started = _now()
    deadline = t0 + cfg.authorized_duration_s
    billing = billing_basis_from_config(cfg)
    done_event = threading.Event()
    stop_issued: Optional[float] = None
    stop_confirmed = False
    stop_calls = 0
    stop_lock = threading.Lock()
    stop_reason = "ended"
    state: Dict[str, Any] = {
        "cost": 0.0,
        "perceive_session_s": 0.0,
        "status": "running",
        "cost_source": "none",
        "record_cost_source": "dark",
        "projected": 0.0,
        "projected_from": "none",
        "projection_basis": billing.basis,
        "record_units_usd": None,
        "record_decide_calls": None,
        "record_confirm_calls": None,
        "record_summary_calls": None,
        "guard_source": "none",
        "metered_projection_s": 0.0,
        "live_readable": False,
        "record": {},
    }

    # ---- ADAAAA-8943: the arm/heartbeat contract --------------------------
    # The harness's own process is the only stop it can issue. On ADAAAA-8924
    # the process died with the launching exec session and nothing else was
    # watching, so the job ran past its cap. These two surfaces make the guard
    # observable and replaceable from outside this process:
    #
    #   * the stdout lines `[leg] arm pid=… job=…` and `[leg] heartbeat …`,
    #     which `launch_funded_leg.py` requires inside ~30 s before it reports
    #     a supervised leg (and which it stops the job without, if the harness
    #     died before arming);
    #   * a heartbeat JSON on disk with the same facts plus the absolute stop
    #     deadline, which `leg_supervisor.py` reads to stop the job if the beats
    #     stop.
    armed_at = _now()
    deadline_at = window_started + timedelta(seconds=cfg.authorized_duration_s)
    deadline_epoch = deadline_at.timestamp()
    last_beat = 0.0

    def heartbeat_payload(phase: str, status: Optional[str]) -> Dict[str, Any]:
        return {
            "harness": {"name": "funded_leg", "version": VERSION},
            "pid": os.getpid(),
            "phase": phase,
            "jobId": job_id,
            "sessionId": session_id,
            "armedAt": _iso(armed_at),
            "beatAt": _iso(_now()),
            "legSeconds": round(max(0.0, time.monotonic() - t0), 3),
            "authorizedDurationS": cfg.authorized_duration_s,
            "hardStopSlackS": cfg.hard_stop_slack_s,
            "capUsd": cfg.cap_usd,
            "abortAtUsd": cfg.abort_at_usd,
            "deadlineAt": _iso(deadline_at),
            "deadlineEpoch": round(deadline_epoch, 3),
            "status": status,
            "stopIssued": stop_issued is not None,
            "stopReason": stop_reason if stop_issued is not None else None,
        }

    def beat(phase: str, status: Optional[str] = None) -> None:
        if not cfg.heartbeat_path:
            return
        try:
            write_json_atomic(cfg.heartbeat_path, heartbeat_payload(phase, status))
        except OSError as exc:  # a heartbeat that cannot be written is not a guard
            log(f"heartbeat write failed: {exc}")

    armed_pid = os.getpid()
    log(
        f"arm pid={armed_pid} job={job_id} heartbeat="
        f"{cfg.heartbeat_path or '-'} deadline={_iso(deadline_at)}"
    )
    beat("armed")
    last_beat = time.monotonic()

    def poll_state() -> str:
        res = runner.http("GET", f"{cfg.job_base}/jobs/{job_id}", headers=headers)
        status = _job_field(res.body, "status", "unknown")
        raw = res.body.get("job") if isinstance(res.body, dict) and isinstance(res.body.get("job"), dict) else res.body
        has_cost_field = isinstance(raw, dict) and "costUsd" in raw
        has_session_field = isinstance(raw, dict) and "perceiveSessionS" in raw
        state["status"] = status
        if isinstance(raw, dict):
            state["record"] = raw
        state["cost"] = float(_job_field(res.body, "costUsd", 0.0) or 0.0)
        state["perceive_session_s"] = float(
            _job_field(res.body, "perceiveSessionS", 0.0) or 0.0
        )
        # ADAAAA-8529 item 1 / ADAAAA-8832: the clock projection, priced in the
        # unit the build bills. The record's own metered figure wins once it
        # exists (it is the billed quantity); a record that also discloses its
        # decide/summary counts is priced exactly and takes the larger reading.
        #
        # It is a MID-LEG reading: once the stop is issued the leg's metered time
        # is fixed, so settlement must not keep advancing it (that inflated the
        # graded projection on an already-stopped leg).
        record_s = state["perceive_session_s"] if has_session_field else 0.0
        state["record_decide_calls"] = _record_count(raw, "decideCalls")
        state["record_confirm_calls"] = _record_count(raw, "confirmCalls")
        state["record_summary_calls"] = _record_count(raw, "summaryCalls")
        if stop_issued is None and status not in ("done", "failed", "cancelled"):
            state["metered_projection_s"] = max(0.0, time.monotonic() - t_create)
            projection = project_metered_cost(
                billing,
                state["metered_projection_s"],
                record_perceive_session_s=record_s,
                record_decide_calls=state["record_decide_calls"],
                record_confirm_calls=state["record_confirm_calls"],
                record_summary_calls=state["record_summary_calls"],
            )
            state["projected_from"] = projection["projectedFrom"]
            state["projection_basis"] = projection["fromBasis"]
            state["projected"] = round(projection["usd"], 6)
            state["record_units_usd"] = projection["recordUnitsUsd"]
        if state["cost"] > 0:
            state["cost_source"] = "live_cost"
            state["record_cost_source"] = "live"
            state["live_readable"] = True
        elif record_s > 0:
            # Metered seconds are readable from the record, so it is the source.
            state["cost_source"] = "projected_cost"
            state["record_cost_source"] = "live"
        else:
            # The live rail: the record is dark, and the projection is the guard.
            state["cost_source"] = "projected_cost"
            state["record_cost_source"] = "dark"
        if has_cost_field:
            state["live_readable"] = True
        return status

    def issue_stop(reason: str, allow_retry: bool = True) -> bool:
        """Wall-clock stop. Idempotent; retried only on an unconfirmed stop."""
        nonlocal stop_issued, stop_confirmed, stop_calls, stop_reason
        with stop_lock:
            if stop_confirmed:
                return True
            if stop_issued is None:
                stop_issued = time.monotonic()
                stop_reason = reason
            attempts = 3 if allow_retry else 1
            for attempt in range(attempts):
                stop_calls += 1
                try:
                    res = runner.http(
                        "POST",
                        f"{cfg.job_base}/jobs/{job_id}/stop",
                        headers=headers,
                        timeout=10.0,
                    )
                    log(f"stop attempt {attempt + 1} HTTP {res.status} reason={reason}")
                except Exception as exc:  # a dead stop route is not a success
                    log(f"stop attempt {attempt + 1} failed: {exc}")
                status = poll_state()
                if status in ("done", "failed", "cancelled"):
                    stop_confirmed = True
                    return True
                if attempt < attempts - 1:
                    time.sleep(min(2.0, cfg.hard_stop_slack_s / 3.0))
            return False

    def watchdog() -> None:
        """The 8483 fix: the stop is wall clock, not media progress."""
        remaining = deadline - time.monotonic()
        if remaining > 0 and done_event.wait(remaining):
            return
        if not stop_confirmed and stop_issued is None:
            log(
                f"WALL-CLOCK STOP at {cfg.authorized_duration_s:.0f} s "
                f"(reason=authorized_duration)"
            )
            issue_stop("authorized_duration")

    thread = threading.Thread(target=watchdog, daemon=True)
    thread.start()

    terminal_end = False
    try:
        while True:
            status = poll_state()
            if status in ("done", "failed", "cancelled"):
                # ADAAAA-8943: the job reached a terminal state without this
                # process issuing the stop. That is an unguarded end (an operator
                # stop, or the content running out), and it must not be reported
                # as a harness stop.
                terminal_end = stop_issued is None
                break
            now = time.monotonic()
            if now - last_beat >= cfg.heartbeat_s:
                last_beat = now
                log(
                    f"heartbeat t={max(0.0, now - t0):.1f}s status={status} "
                    f"cost=${state['cost']:.4f} projected=${state['projected']:.4f}"
                )
                beat("running", status)
            if now >= deadline:
                # Belt as well as braces: the loop never relies on the watchdog
                # thread having run, and never on a stop moment.
                issue_stop("authorized_duration")
                break
            # CEO A1 / ADAAAA-8529 item 1 / ADAAAA-8832: the guard prices the
            # unit the build bills. A READABLE costUsd is the money already
            # accounted, so no clock extrapolation may override it — a
            # projection that fires with costUsd at half the cap must not stop a
            # leg (leg 27bd816f stopped at 357 s of 540 s that way, leaving
            # $0.2247 of the cap unspent). A dark record falls back to the
            # projection: clock x the decide unit rate, or the perceive-second
            # rate for a perceive-billed cell, plus any record-disclosed billed
            # units.
            if state["cost"] > 0:
                effective = max(state["cost"], state["record_units_usd"] or 0.0)
                guard_source = "live_cost"
            else:
                effective = max(state["cost"], state["projected"])
                guard_source = "projected_cost"
            state["guard_source"] = guard_source
            if effective >= cfg.abort_at_usd:
                log(
                    f"metered ceiling {cfg.abort_at_usd:.4f} reached on {guard_source} "
                    f"(live=${state['cost']:.4f}, projected="
                    f"${state['projected']:.4f} from {state['projected_from']} on the "
                    f"{state['projection_basis']} unit at "
                    f"{billing.usd_per_s():.7f}/s = {billing.line()}, "
                    f"{state['metered_projection_s']:.1f} s metered, record "
                    f"{state['record_cost_source']}, record decideCalls "
                    f"{state['record_decide_calls']}, record units "
                    f"${state['record_units_usd'] or 0.0:.4f}) — stopping"
                )
                issue_stop(guard_source)
                break
            time.sleep(cfg.poll_s)
    finally:
        # Any exit path stops the leg: exception, keyboard, or normal end. A job
        # that is ALREADY terminal is not stopped again — a no-op stop here would
        # relabel an unguarded end as `harness_exit` (ADAAAA-8943).
        if not terminal_end and not stop_confirmed and stop_issued is None:
            issue_stop("harness_exit")
        done_event.set()

    # Settle: the job must be terminal before the cost figure is graded.
    settle_deadline = time.monotonic() + cfg.settle_timeout_s
    while time.monotonic() < settle_deadline:
        status = poll_state()
        if status in ("done", "failed", "cancelled"):
            break
        time.sleep(min(2.0, cfg.poll_s))
    if state["status"] not in ("done", "failed", "cancelled"):
        # One last bounded retry, then declare the stop unconfirmed.
        issue_stop(stop_reason, allow_retry=True)
        status = poll_state()
    # ADAAAA-8832: the terminal patch carries the settled `costUsd`, and it can
    # land a beat after the status flips. Re-read once, bounded, so the evidence
    # names the money actually billed instead of a mid-leg zero (leg 27bd816f
    # published `costUsd 0.0` on a leg that settled at $0.2353).
    if state["cost"] <= 0:
        settled_by = time.monotonic() + min(2.0, cfg.settle_timeout_s)
        while state["cost"] <= 0 and time.monotonic() < settled_by:
            time.sleep(min(0.5, cfg.poll_s))
            poll_state()
    stop_time = stop_issued or time.monotonic()
    duration_s = max(0.0, stop_time - t0)
    rows = (
        ((state["record"].get("observeMetrics") or {}).get("deliveredLatency") or {}).get(
            "rows"
        )
        or []
    )
    # ADAAAA-8943: name the stop source before the evidence is built. A leg that
    # reached a terminal state without this process's stop is not a supervised
    # leg, whatever reason this harness would have reported for it.
    harness_stop_issued = stop_issued is not None and not terminal_end
    stop_block = classify_stop_source(
        harness_stop_issued=harness_stop_issued,
        harness_stop_reason=stop_reason,
        terminal_without_harness_stop=terminal_end,
        record=state["record"],
    )
    log(stop_block["stopSourceLine"])
    log(
        f"finished status={state['status']} duration={duration_s:.1f}s "
        f"cost=${float(state['cost']):.4f} stop={stop_block['stopSource']}"
    )
    beat("finished", state["status"])
    return LegResult(
        job_id=job_id,
        session_id=session_id,
        # ADAAAA-8529 item 3: `startedAt`/`finishedAt` are the LEG WINDOW (t0 ->
        # stop), so `finishedAt - startedAt` reproduces `durationS` exactly; the
        # job-create instant is carried separately as `created_at`.
        started_at=_iso(window_started),
        created_at=_iso(started),
        finished_at=_iso(window_started + timedelta(seconds=duration_s)),
        started_monotonic=t0,
        stop_reason=stop_reason,
        stop_issued_monotonic=stop_issued,
        stop_confirmed=bool(state["status"] in ("done", "failed", "cancelled")),
        settled_status=state["status"],
        cost_usd=float(state["cost"]),
        perceive_session_s=float(state["perceive_session_s"]),
        duration_s=duration_s,
        stop_calls=stop_calls,
        driver_rc=driver_rc,
        cost_source=state["cost_source"],
        projected_cost_usd=float(state["projected"]),
        driver_output_tail=driver_tail,
        metered_projection_s=float(state["metered_projection_s"]),
        projected_from=state["projected_from"],
        projected_basis=state["projection_basis"],
        metered_usd_per_s=float(billing.usd_per_s()),
        record_units_usd=(
            float(state["record_units_usd"])
            if state["record_units_usd"] is not None
            else None
        ),
        record_decide_calls=state["record_decide_calls"],
        record_confirm_calls=state["record_confirm_calls"],
        record_summary_calls=state["record_summary_calls"],
        guard_source=state["guard_source"],
        record_cost_source=state["record_cost_source"],
        delivered_rows=list(rows),
        stop_source=stop_block["stopSource"],
        stop_source_class=stop_block["stopSourceClass"],
        stop_source_line=stop_block["stopSourceLine"],
        harness_stop_issued=harness_stop_issued,
        terminal_without_harness_stop=terminal_end,
        record_stop=record_stop_fields(state["record"]),
        armed_at=_iso(armed_at),
        heartbeat_path=cfg.heartbeat_path,
    )


# --------------------------------------------------------------------------
# Authorized vs actual
# --------------------------------------------------------------------------


def compare_shape(
    authorized_duration_s: float,
    cap_usd: float,
    actual_duration_s: float,
    actual_cost_usd: float,
    duration_tolerance_s: float = 10.0,
    cost_epsilon_usd: float = 1e-6,
    metered_session_s: Optional[float] = None,
    metered_rate_usd_per_s: Optional[float] = None,
    gpu_hours: Optional[float] = None,
    abort_source: Optional[str] = None,
    metered_projection_s: Optional[float] = None,
    billing_basis: Optional[str] = None,
    projected_basis: Optional[str] = None,
    cost_readable: bool = False,
    stop_source: Optional[str] = None,
    stop_source_class: Optional[str] = None,
) -> Dict[str, Any]:
    """Grade the leg against its authorization.

    The duration bar carries the harness's documented tolerance (<= 10 s, AC1);
    a stop that fires a fraction of a second past the mark is inside the shape.
    The cost bar has no tolerance: any metered overshoot is OVER.

    ADAAAA-8529 item 1: the metered projection is `max(the record's
    perceiveSessionS, the METER'S CLOCK at the stop)` x the authorized rate.
    Master's grading rule is kept exactly — `max(costUsd, projection)` — but the
    projection is no longer blind on a live leg, where the record discloses
    neither figure until settlement. The block names which source it used, so a
    reviewer never has to guess what a cost headroom was measured from.

    ADAAAA-8832: `metered_rate_usd_per_s` is the rate of the unit the leg BILLS
    (decide fee / cadence, or the perceive-second rate), and
    `projected_basis`/`billing_basis` name it on the line and in the block. A
    shape graded at the wrong basis is what made the 8816 leg look like it had
    $0.0186 of cost headroom while it really had $0.2247.
    """
    over_duration = max(0.0, actual_duration_s - authorized_duration_s)
    ratio = (
        (metered_session_s / actual_duration_s)
        if (metered_session_s is not None and actual_duration_s > 0)
        else None
    )
    record_s = metered_session_s if metered_session_s is not None else 0.0
    clock_s = metered_projection_s if metered_projection_s is not None else 0.0
    projected: Optional[float] = None
    projected_from = "none"
    if (metered_session_s is not None or metered_projection_s is not None) and (
        metered_rate_usd_per_s is not None
    ):
        # The record's metered figure is the billed quantity and wins when it is
        # the larger of the two; otherwise the meter's clock is the best reading.
        if clock_s > record_s:
            projected = clock_s * metered_rate_usd_per_s
            projected_from = "clock"
        else:
            projected = record_s * metered_rate_usd_per_s
            projected_from = "record_perceiveSessionS"
    # Grade on the same figure the guard aborts on. When costUsd is not readable
    # and the projection is the cost source, grading the live $0.00 as "actual"
    # would report an over-cap leg as WITHIN — the exact after-the-fact blind spot
    # this evidence block exists to close (8515 A1 item 4).
    graded_cost = (
        max(actual_cost_usd, projected)
        if projected is not None and not cost_readable
        else actual_cost_usd
    )
    over_cost = max(0.0, graded_cost - cap_usd)
    duration_over = over_duration > duration_tolerance_s + 1e-9
    cost_over = over_cost > cost_epsilon_usd
    verdict = "OVER" if (duration_over or cost_over) else "WITHIN"
    metered_bits = ""
    if metered_session_s is not None:
        metered_bits = (
            f", metered perceiveSessionS {metered_session_s:.1f} s"
            + (f" ({ratio:.3f}x wall)" if ratio is not None else "")
        )
    if projected is not None:
        basis_note = f" on the {projected_basis or billing_basis} unit" if (projected_basis or billing_basis) else ""
        metered_bits += (
            f", projected ${projected:.4f} from {projected_from}"
            + (
                f" ({clock_s:.1f} s metered at ${metered_rate_usd_per_s:.7f}/s{basis_note})"
                if projected_from in ("clock", "record_units")
                else ""
            )
        )
        if projected > cap_usd + 1e-9:
            metered_bits += " (OVER cap)"
        # Name the grading rule on the line itself (ADAAAA-8529 item 1): a reader
        # must be able to see that the graded figure is `max(costUsd,
        # projection)` and not the record's mid-leg zero.
        metered_bits += (
            f", graded max(costUsd ${actual_cost_usd:.4f}, projection ${projected:.4f})"
        )
    line = (
        f"AUTHORIZED-VS-ACTUAL: authorized duration <= {authorized_duration_s:.1f} s / "
        f"cap ${cap_usd:.4f} -> actual {actual_duration_s:.1f} s / "
        f"${actual_cost_usd:.4f} "
        f"(duration {'over by ' if over_duration else 'headroom '}"
        f"{over_duration or authorized_duration_s - actual_duration_s:.2f} s, "
        f"cost {'over by ' if over_cost else 'headroom '}$"
        f"{over_cost or cap_usd - graded_cost:.4f}{metered_bits}) — {verdict}"
    )
    table = (
        "| shape | authorized | actual | delta |\n"
        "|---|---:|---:|---:|\n"
        f"| duration (wall) | <= {authorized_duration_s:.1f} s | "
        f"{actual_duration_s:.1f} s | "
        f"{'+' if over_duration else ''}{actual_duration_s - authorized_duration_s:.1f} s |\n"
        f"| metered cost (graded) | <= ${cap_usd:.4f} | ${graded_cost:.4f} | "
        f"{'+' if over_cost else ''}${graded_cost - cap_usd:.4f} |"
    )
    if projected is not None and abs(projected - actual_cost_usd) > cost_epsilon_usd:
        table += (
            f"\n| live costUsd | - | ${actual_cost_usd:.4f} | - |"
        )
    if metered_session_s is not None:
        table += (
            f"\n| perceiveSessionS | - | {metered_session_s:.1f} s | "
            + (f"{ratio:.3f}x wall |" if ratio is not None else "n/a |")
        )
    if metered_projection_s is not None:
        table += (
            f"\n| mid-leg metered clock | - | {metered_projection_s:.1f} s | - |"
        )
    if projected is not None:
        basis_note = (
            f", {projected_basis or billing_basis} unit"
            if (projected_basis or billing_basis)
            else ""
        )
        table += (
            f"\n| projected cost @ ${metered_rate_usd_per_s:.7f}/s "
            f"({projected_from}{basis_note}) | "
            f"<= ${cap_usd:.4f} | "
            f"${projected:.4f} | {'+' if projected > cap_usd else ''}"
            f"${projected - cap_usd:.4f} |"
        )
    if gpu_hours is not None:
        table += f"\n| GPU-hours | - | {gpu_hours:.3f} | n/a |"
    if abort_source or stop_source:
        # ADAAAA-8943: the graded stop source is the CLASSIFIED one, so a leg an
        # operator stopped reads `operator_api (external)` here instead of the
        # reason the harness would have reported for its own absent stop.
        label = stop_source or abort_source
        if stop_source_class and stop_source_class != "harness":
            label = f"{label} ({stop_source_class})"
        table += f"\n| stop source | - | `{label}` | - |"
    return {
        "authorizedDurationS": authorized_duration_s,
        "authorizedCapUsd": cap_usd,
        "actualDurationS": round(actual_duration_s, 3),
        "actualCostUsd": round(actual_cost_usd, 6),
        "gradedCostUsd": round(graded_cost, 6),
        "durationOvershootS": round(over_duration, 3),
        "costOvershootUsd": round(over_cost, 6),
        "meteredPerceiveSessionS": (
            round(metered_session_s, 3) if metered_session_s is not None else None
        ),
        "meteredWallRatio": round(ratio, 4) if ratio is not None else None,
        "meteredRateUsdPerS": metered_rate_usd_per_s,
        "meteredProjectionSAtStop": (
            round(metered_projection_s, 3) if metered_projection_s is not None else None
        ),
        "projectedCostUsd": round(projected, 6) if projected is not None else None,
        "projectedFrom": projected_from,
        "billingBasis": billing_basis,
        "meteredRateBasis": projected_basis or billing_basis,
        "costReadable": cost_readable,
        "projectedOverCap": bool(projected is not None and projected > cap_usd + 1e-9),
        "gpuHours": gpu_hours,
        "abortSource": abort_source,
        "stopSource": stop_source or abort_source,
        "stopSourceClass": stop_source_class or "harness",
        "verdict": verdict,
        "line": line,
        "table": table,
    }


# --------------------------------------------------------------------------
# Evidence probes: build identity (item 2) and clips (item 5)
# --------------------------------------------------------------------------

_MD5_RE = re.compile(r"\b([0-9a-f]{32})\b")


def _md5_from_stdout(stdout: str) -> Optional[str]:
    """First 32-hex token on stdout (md5sum prints `<md5>  <path>`)."""
    for line in (stdout or "").splitlines():
        match = _MD5_RE.search(line)
        if match:
            return match.group(1)
    return None


def _shell_md5(runner: Any, command: str) -> Optional[str]:
    """Run one command and return its md5, or None when the probe cannot answer.

    A probe failure is never a silent pass: None propagates to
    `verify_build`, which refuses the leg.
    """
    try:
        proc = runner.shell(command, timeout=120)
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    return _md5_from_stdout(proc.stdout or "")


def resolve_build_sha(runner: Any, cfg: Config) -> Optional[str]:
    if cfg.build_sha.strip():
        return cfg.build_sha.strip()
    try:
        proc = runner.shell(f"git -C {shlex.quote(cfg.repo_root)} rev-parse HEAD", timeout=60)
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    first = (proc.stdout or "").strip().split()
    if first and re.fullmatch(r"[0-9a-f]{7,40}", first[0]):
        return first[0]
    return None


def verify_build(runner: Any, cfg: Config) -> Dict[str, Any]:
    """Prove the served files are the build the evidence names.

    ADAAAA-8529 item 2: the 8516 leg was graded on an artifact nobody recorded —
    no attachment carried the build sha or a served-vs-git md5 pair, so the grade
    described an unknown build. Each pair is
    `md5(container:<prefix>/<path>)` vs `md5(git show <sha>:<path>)`;
    `verdict: verified` only when every pair matches, and the leg is refused
    (exit 6) on `mismatch` or `unreadable`.
    """
    sha = resolve_build_sha(runner, cfg)
    files: List[Dict[str, Any]] = []
    for path in cfg.build_files:
        served_path = f"{cfg.build_prefix.rstrip('/')}/{path}"
        served_cmd = (
            f"docker exec {shlex.quote(cfg.build_container)} md5sum {shlex.quote(served_path)}"
        )
        git_cmd = (
            f"git -C {shlex.quote(cfg.repo_root)} show "
            f"{shlex.quote(f'{sha}:{path}' if sha else f'HEAD:{path}')} | md5sum"
        )
        served_md5 = _shell_md5(runner, served_cmd)
        git_md5 = _shell_md5(runner, git_cmd)
        files.append(
            {
                "path": path,
                "servedPath": served_path,
                "servedMd5": served_md5,
                "gitMd5": git_md5,
                "match": bool(served_md5 and git_md5 and served_md5 == git_md5),
            }
        )
    matched = sum(1 for f in files if f["match"])
    if sha is None:
        verdict = "unreadable"
    elif matched == len(files) and files:
        verdict = "verified"
    elif any(f["servedMd5"] is None or f["gitMd5"] is None for f in files):
        verdict = "unreadable"
    else:
        verdict = "mismatch"
    mismatched = [f["path"] for f in files if not f["match"]]
    line = (
        f"BUILD-IDENTITY: {sha or 'sha unresolved'} — {matched}/{len(files)} served "
        f"files in {cfg.build_container}:{cfg.build_prefix} match git show"
        + (f"; differing: {', '.join(mismatched)}" if mismatched else "")
        + f" — {verdict}"
    )
    return {
        "sha": sha,
        "container": cfg.build_container,
        "prefix": cfg.build_prefix,
        "files": files,
        "matched": matched,
        "mismatched": mismatched,
        "verdict": verdict,
        "line": line,
    }


def probe_decide_config(runner: Any, cfg: Config) -> Dict[str, Any]:
    """Read the decide config in force from the server container's environment.

    One `sh -c` loop rather than N `printenv` calls: `printenv KEY` exits 1 when
    the key is unset, which would make an intentionally-unset keep-ratio look
    like a probe failure. Here an unset key prints `KEY=` and the block records
    it as null — "the code default was in force" is a value, not a hole.
    """
    keys = list(cfg.decide_config_keys)
    inner = (
        "for k in " + " ".join(shlex.quote(k) for k in keys) + "; do "
        'printf "%s=%s\\n" "$k" "$(printenv "$k")"; done'
    )
    command = (
        f"docker exec {shlex.quote(cfg.decide_config_container)} sh -c {shlex.quote(inner)}"
    )
    try:
        proc = runner.shell(command, timeout=120)
    except Exception as exc:
        return {"status": f"failed: {exc}", "values": {}, "command": command}
    if proc.returncode != 0:
        return {
            "status": f"failed: rc={proc.returncode} {(proc.stderr or '').strip()[:200]}",
            "values": {},
            "command": command,
        }
    values: Dict[str, Optional[str]] = {}
    for line in (proc.stdout or "").splitlines():
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        if key in keys:
            values[key] = value.strip() or None
    return {"status": "ok", "values": values, "command": command}


def decide_config_block(probe: Dict[str, Any], cfg: Config) -> Dict[str, Any]:
    """The decide config the leg ran under, or `unreadable` (which refuses it).

    There is nothing to compare against in git — the point is that the values are
    ON the evidence, so a later reader can tell whether ADAAAA-8525's window
    change was in force. A key the probe could not answer is not a skip: it is
    an unnameable artifact, so the verdict drops to `unreadable` and the leg is
    refused with the build-identity refusal (exit 6).
    """
    keys = list(cfg.decide_config_keys)
    values = probe.get("values") or {}
    missing = [k for k in keys if k not in values]
    verdict = "recorded" if probe.get("status") == "ok" and not missing else "unreadable"

    def show(key: str) -> str:
        value = values.get(key)
        return f"{value} ({key})" if value is not None else f"unset ({key} — code default in force)"

    line = (
        f"DECIDE-CONFIG: pool {show('DECIDE_URL')} | model {show('GEMMA_MODEL')} | "
        f"window keep-ratio {show('LIVE_DECIDE_KEEP_RATIO')} | "
        f"frame budget {show('LIVE_OBSERVE_MAX_FRAMES')} | "
        f"cadence {show('LIVE_OBSERVE_CADENCE_S')}"
    )
    if verdict != "recorded":
        parts: List[str] = []
        if probe.get("status") != "ok":
            parts.append(str(probe.get("status")))
        if missing:
            parts.append(f"unreadable keys: {', '.join(missing)}")
        line = f"DECIDE-CONFIG: unreadable; {'; '.join(parts)} — {verdict}"
    return {
        "container": cfg.decide_config_container,
        "keys": keys,
        "values": values,
        "missing": missing,
        "status": probe.get("status"),
        "verdict": verdict,
        "line": line,
        "command": probe.get("command"),
    }


def artifact_refusal(
    build_block: Dict[str, Any], decide_block: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """The refusal record when the leg cannot name the artifact it would grade.

    `None` means both probes answered: the build is `verified` and the decide
    config is `recorded`. Anything else is exit 6 — nothing metered, and the
    refusal itself is evidence, because it names which half was unknown.
    """
    if build_block.get("verdict") != "verified":
        return {
            "outcome": "build_unverified",
            "exitCode": 6,
            "message": (
                "build identity unverified: the served files do not match the "
                "build sha, so a grade of this leg would grade an unknown "
                "artifact — refused before any metered call"
            ),
        }
    if decide_block.get("verdict") != "recorded":
        return {
            "outcome": "decide_config_unreadable",
            "exitCode": 6,
            "message": (
                "decide config in force could not be read (pool/model/keep-ratio): "
                "a leg graded without it grades an unknown artifact — refused "
                "before any metered call"
            ),
        }
    return None


def probe_clips(runner: Any, cfg: Config, job_id: str) -> Dict[str, Any]:
    """Count the leg's clip files inside the server container. Never fatal."""
    inner = (
        f"for f in {cfg.clips_dir}/{job_id}-*.mp4; do "
        '[ -e "$f" ] || continue; '
        'printf "%s\\t%s\\n" "$f" "$(stat -c %s "$f" 2>/dev/null || echo 0)"; done'
    )
    command = f"docker exec {shlex.quote(cfg.clips_container)} sh -c {shlex.quote(inner)}"
    try:
        proc = runner.shell(command, timeout=120)
    except Exception as exc:
        return {"status": f"failed: {exc}", "files": [], "command": command}
    if proc.returncode != 0:
        return {
            "status": f"failed: rc={proc.returncode} {(proc.stderr or '').strip()[:200]}",
            "files": [],
            "command": command,
        }
    files: List[Dict[str, Any]] = []
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line or "\t" not in line:
            continue
        path, _, size = line.partition("\t")
        try:
            bytes_ = int(size.strip())
        except ValueError:
            bytes_ = None
        files.append({"path": path.strip(), "bytes": bytes_})
    return {"status": "ok", "files": files, "command": command}


def _median(values: Sequence[float]) -> Optional[int]:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return int(round(ordered[mid]))
    return int(round((ordered[mid - 1] + ordered[mid]) / 2))


def stage_fields(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """The persist->export tail as the delivered rows carry it (item 5)."""
    persist: List[float] = []
    delivered: List[float] = []
    for row in rows:
        ack = row.get("persistAckMs")
        if isinstance(ack, (int, float)):
            persist.append(float(ack))
        total = row.get("deliveredLatencyMs")
        if isinstance(total, (int, float)):
            delivered.append(float(total))
    return {
        "rows": len(rows),
        "rowsWithPersistAck": len(persist),
        "rowsWithZeroPersistAck": sum(1 for v in persist if v == 0),
        "persistAckMsMedian": _median(persist),
        "persistAckMsMax": max(persist) if persist else None,
        "deliveredLatencyP50Ms": _median(delivered),
        "deliveredLatencyMaxMs": max(delivered) if delivered else None,
    }


def clips_block(
    probe: Dict[str, Any], rows: Sequence[Dict[str, Any]], cfg: Config, job_id: str
) -> Dict[str, Any]:
    """The `clips` evidence block, and how item 2 is actually met.

    ADAAAA-8529 item 5: `clips.produced: 0` on the 8516 leg left evidence item 2
    (the persist->export tail) with no clip to read it from, and nothing said so.
    A file-sim / driven leg records no screen share, so the tail is measured from
    the delivered rows instead — and this block states that, per leg, instead of
    leaving a reviewer to notice an empty list.
    """
    files = list(probe.get("files") or [])
    produced = len(files)
    stage = stage_fields(rows)
    item2_source = "clip_files" if produced > 0 else "stage_fields"
    block: Dict[str, Any] = {
        "produced": produced,
        "container": cfg.clips_container,
        "dir": cfg.clips_dir,
        "jobGlob": f"{job_id}-*.mp4",
        "probe": probe.get("status"),
        "files": files,
        "item2Source": item2_source,
        # Item 2 is met either way: by the clip files' btime/mtime when a
        # recording exists, by the stage fields when none does. It is never empty.
        "item2Met": produced > 0 or stage["rowsWithPersistAck"] > 0,
        "stageFields": stage,
    }
    if produced == 0:
        block["reason"] = (
            f"no clip files matched {job_id}-*.mp4 in {cfg.clips_container}:{cfg.clips_dir}"
        )
        if stage["rows"] == 0:
            block["note"] = (
                "item 2 (persist->export tail) is UNMEASURED on this leg: no clips and no "
                "delivered rows carrying persistAckMs"
            )
        else:
            block["note"] = (
                "item 2 (persist->export tail) is met by the stage fields only: "
                f"{stage['rows']} delivered rows, {stage['rowsWithPersistAck']} carrying "
                f"persistAckMs ({stage['rowsWithZeroPersistAck']} at 0 ms), "
                f"persistAckMs max {stage['persistAckMsMax']} ms, deliveredLatency "
                f"p50 {stage['deliveredLatencyP50Ms']} ms / max "
                f"{stage['deliveredLatencyMaxMs']} ms"
            )
    return block


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

# ADAAAA-8515 A1: the guard point sits below the cap so the leg can never
# meter the cap itself. At $0.0011381/s the $0.65 cap is 571 s of metered
# time; $0.60 is 527 s, so the projection crosses the abort point with ~44 s
# of metered headroom left before the cap.
ABORT_MARGIN_USD = 0.05


def default_abort_at_usd(cap_usd: float) -> float:
    """Cap less the $0.05 guard margin (10% for caps under $0.50)."""
    margin = min(ABORT_MARGIN_USD, cap_usd * 0.1)
    return max(0.0, cap_usd - margin)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Run one funded leg inside its authorized shape (ADAAAA-8489)."
    )
    p.add_argument("--authorized-duration-s", type=float, required=True,
                   help="authorized leg duration; the stop fires at this wall-clock mark")
    p.add_argument("--cap-usd", type=float, required=True,
                   help="authorized metered cost cap for the leg")
    p.add_argument("--quiet-window-min", type=float, default=10.0,
                   help="required idle window before start (default 10)")
    p.add_argument("--hard-stop-slack-s", type=float, default=10.0,
                   help="max seconds after the deadline before a stop is declared "
                        "unconfirmed (must be <= 10; default 10)")
    p.add_argument("--abort-at-usd", type=float, default=None,
                   help="stop early at this metered cost (default: cap - $0.05, "
                        "i.e. $0.60 on the $0.65 cap)")
    p.add_argument("--metered-rate-usd-per-s", type=float, default=0.0011381,
                   help="authorized $/perceive-second, used by the 'perceive' "
                        "billing basis (default 0.0011381, the 8515 rate)")
    p.add_argument("--billing-basis", default="decide", choices=list(BILLING_BASES),
                   help="the unit the served build bills, and the basis the guard "
                        "prices the clock projection in: 'decide' (default — "
                        "decideFee / cadence, the shipped costUsd identity) or "
                        "'perceive' (perceive-seconds x --metered-rate-usd-per-s)")
    p.add_argument("--decide-fee-usd", type=float, default=DECIDE_USD_PER_DECIDE,
                   help=f"per-decide fee the build bills "
                        f"(default {DECIDE_USD_PER_DECIDE})")
    p.add_argument("--decide-cadence-s", type=float, default=None,
                   help="decide cadence the projection is priced at; default reads "
                        "LIVE_OBSERVE_CADENCE_S from the decide-config probe, else "
                        f"{DECIDE_CADENCE_DEFAULT_S:g} s")
    p.add_argument("--summary-fee-ratio", type=float, default=SUMMARY_FEE_RATIO,
                   help=f"summary fee as a multiple of the decide fee "
                        f"(default {SUMMARY_FEE_RATIO})")
    p.add_argument("--perceive-usd-per-hour", type=float, default=PERCEIVE_PER_HOUR_USD,
                   help=f"perceive list price per hour accrued into costUsd "
                        f"(default {PERCEIVE_PER_HOUR_USD})")
    p.add_argument("--cost-source-grace-s", type=float, default=None,
                   help="deprecated (ADAAAA-8529): the metered clock is always a "
                        "cost source, so a leg is never refused for a dark record")
    p.add_argument("--build-sha", default="",
                   help="build sha the served files must match (default: git -C "
                        "<repo-root> rev-parse HEAD)")
    p.add_argument("--build-container", default="highlights-server",
                   help="container the leg's files are served from (default highlights-server)")
    p.add_argument("--build-prefix", default="/app",
                   help="path inside the container that maps to the repo root (default /app)")
    p.add_argument("--build-file", action="append", default=None,
                   help="repo-relative file to verify served-vs-git (repeatable; "
                        "default: live-delivery.ts, live.ts, observe-loop.ts, "
                        "packages/events/src/index.ts)")
    p.add_argument("--no-build-check", action="store_true",
                   help="skip the build-identity probe (a leg run this way is NOT "
                        "evidence — the grade cannot name its artifact)")
    p.add_argument("--clips-container", default="highlights-server",
                   help="container the leg's clip files live in (default highlights-server)")
    p.add_argument("--clips-dir", default="/data/clips",
                   help="clip directory inside that container (default /data/clips)")
    p.add_argument("--gpu-hours", type=float, default=None,
                   help="actual GPU-hours for the evidence block (operator-measured)")
    p.add_argument("--poll-s", type=float, default=1.0)
    p.add_argument("--settle-timeout-s", type=float, default=60.0,
                   help="how long to wait for the job to reach a terminal status")
    p.add_argument("--job-base", default="http://127.0.0.1:3000")
    p.add_argument("--media-base", default="http://127.0.0.1:4070")
    p.add_argument("--job-source", default="browser", choices=["browser", "file-sim", "rtmp"])
    p.add_argument("--game-hint", default="soccer")
    p.add_argument("--sample-fps", type=float, default=3.0)
    p.add_argument("--video-path", default=None)
    p.add_argument("--pool-container", action="append", default=None,
                   help="decide-pool container to read session markers from "
                        "(repeatable; default decide-gpu0/1/2)")
    p.add_argument("--cyc-pattern", default=DEFAULT_CYC_PATTERN,
                   help="log pattern counted as a live pool session "
                        "(default 'session=', a superset of 'session=cyc-')")
    p.add_argument("--box-cmd", default="",
                   help="prefix every control-host command (postgres, curl, driver) "
                        "when the box is remote, e.g. "
                        "'python3 /paperclip/.hermes/skills/komodo/scripts/komodo.py "
                        "livepeer-ai-x99'")
    p.add_argument("--cyc-box-cmd", default="",
                   help="prefix the decide-pool log probe when the pool host is "
                        "remote, e.g. 'python3 .../komodo.py ai-server-5090x3-1'")
    p.add_argument("--driver-cmd", default=None,
                   help="driver launched after session create; placeholders "
                        "{sid} {job} {seconds}")
    p.add_argument("--token", default=os.environ.get("HL_LEG_TOKEN"))
    p.add_argument("--user-id", default=os.environ.get("HL_LEG_USER_ID"))
    p.add_argument("--email", default=os.environ.get("HL_LEG_EMAIL"))
    p.add_argument("--mint-token-container", default="highlights-server")
    p.add_argument("--postgres-container", default="highlights-postgres")
    p.add_argument("--repo-root", default=".")
    p.add_argument("--decide-config-key", action="append", default=None,
                   help="server env key recorded as the decide config in force "
                        "(repeatable; default DECIDE_URL/GEMMA_MODEL/"
                        "LIVE_DECIDE_KEEP_RATIO/LIVE_OBSERVE_MAX_FRAMES)")
    p.add_argument("--decide-config-container", default="highlights-server")
    p.add_argument("--evidence-out", default=None,
                   help="write the evidence JSON here (also printed to stdout)")
    p.add_argument("--heartbeat-path", default=None,
                   help="ADAAAA-8943: write the harness heartbeat JSON here. "
                        "`launch_funded_leg.py` arms on this file plus the `[leg] "
                        "arm` line, and `leg_supervisor.py` stops the job when the "
                        "beats stop")
    p.add_argument("--heartbeat-s", type=float, default=5.0,
                   help="seconds between heartbeats (default 5)")
    p.add_argument("--dry-run", action="store_true",
                   help="run against the in-process stub; no box, no metered call")
    p.add_argument("--stub-scenario", default="clean",
                   choices=["clean", "clean-no-cost", "decide-dark", "decide-record",
                            "live-cost-dark-session", "no-cost-source", "busy",
                            "stop-stuck", "operator-stop-overspend",
                            "operator-stop-within"])
    p.add_argument("--preflight-only", action="store_true",
                   help="run the quiet-window preflight and exit; creates nothing "
                        "(the $0 way to verify the real probes)")
    p.add_argument("--quiet", action="store_true")
    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.hard_stop_slack_s > 10.0:
        print("refusing: --hard-stop-slack-s must be <= 10 s (ADAAAA-8489 AC1)",
              file=sys.stderr)
        return 5
    if args.authorized_duration_s <= 0 or args.cap_usd <= 0:
        print("refusing: duration and cap must be positive", file=sys.stderr)
        return 5
    if args.billing_basis == "perceive":
        if args.metered_rate_usd_per_s <= 0:
            print("refusing: --metered-rate-usd-per-s must be positive on the "
                  "perceive basis; the session-time projection is a required "
                  "cost source", file=sys.stderr)
            return 5
    else:
        # ADAAAA-8832: the decide basis needs a positive fee and a positive
        # cadence to derive one $/s; without them there is no readable cost
        # source for the clock fallback, and a wall-clock stop alone cannot hold
        # a metered cap.
        if args.decide_fee_usd <= 0:
            print("refusing: --decide-fee-usd must be positive on the decide "
                  "basis; the decide unit is the cost source", file=sys.stderr)
            return 5
        if args.decide_cadence_s is not None and args.decide_cadence_s <= 0:
            print("refusing: --decide-cadence-s must be positive on the decide "
                  "basis; the decide unit is the cost source", file=sys.stderr)
            return 5
    abort_at_usd = (
        args.abort_at_usd
        if args.abort_at_usd is not None
        else default_abort_at_usd(args.cap_usd)
    )
    if abort_at_usd <= 0 or abort_at_usd >= args.cap_usd:
        print(
            f"refusing: abort point ${abort_at_usd:.4f} must be > 0 and below "
            f"the ${args.cap_usd:.4f} cap; the guard needs margin to hold the cap",
            file=sys.stderr,
        )
        return 5

    lines: List[str] = []

    def log(msg: str) -> None:
        lines.append(msg)
        if not args.quiet:
            print(f"[leg] {msg}", flush=True)

    cfg = Config(
        authorized_duration_s=args.authorized_duration_s,
        cap_usd=args.cap_usd,
        quiet_window_s=args.quiet_window_min * 60.0,
        hard_stop_slack_s=args.hard_stop_slack_s,
        abort_at_usd=abort_at_usd,
        poll_s=args.poll_s,
        settle_timeout_s=args.settle_timeout_s,
        job_base=args.job_base,
        media_base=args.media_base,
        job_source=args.job_source,
        game_hint=args.game_hint,
        sample_fps=args.sample_fps,
        video_path=args.video_path,
        pool_containers=tuple(args.pool_container or DEFAULT_POOL_CONTAINERS),
        driver_cmd=args.driver_cmd,
        token=args.token,
        user_id=args.user_id,
        email=args.email,
        mint_token_container=args.mint_token_container,
        metered_rate_usd_per_s=args.metered_rate_usd_per_s,
        billing_basis=args.billing_basis,
        decide_fee_usd=args.decide_fee_usd,
        decide_cadence_s=(
            args.decide_cadence_s
            if args.decide_cadence_s is not None
            else DECIDE_CADENCE_DEFAULT_S
        ),
        summary_fee_ratio=args.summary_fee_ratio,
        perceive_usd_per_hour=args.perceive_usd_per_hour,
        gpu_hours=args.gpu_hours,
        repo_root=args.repo_root,
        build_sha=args.build_sha,
        build_container=args.build_container,
        build_prefix=args.build_prefix,
        build_files=tuple(args.build_file or DEFAULT_BUILD_FILES),
        decide_config_container=args.decide_config_container,
        decide_config_keys=tuple(args.decide_config_key or DEFAULT_DECIDE_CONFIG_KEYS),
        clips_container=args.clips_container,
        clips_dir=args.clips_dir,
        heartbeat_path=args.heartbeat_path,
        heartbeat_s=args.heartbeat_s,
    )
    if args.cost_source_grace_s is not None:
        log(
            "note: --cost-source-grace-s is a no-op since ADAAAA-8529 — the metered "
            "clock is always a cost source, so a dark record no longer refuses the leg"
        )

    stub: Optional[StubApi] = None
    if args.dry_run:
        stub = StubApi(args.stub_scenario)
        base = stub.start()
        runner: Any = StubRunner(stub)
        cfg.job_base = base
        cfg.media_base = base
        cfg.token = "stub-token"
        log(f"dry-run: stub API at {base} scenario={args.stub_scenario}")
    else:
        runner = RealRunner(
            postgres_container=args.postgres_container,
            box_cmd=args.box_cmd,
            cyc_box_cmd=args.cyc_box_cmd,
            cyc_pattern=args.cyc_pattern,
            shell_cwd=args.repo_root,
        )

    _billing_rate = billing_basis_from_config(cfg).usd_per_s()
    evidence: Dict[str, Any] = {
        "harness": {
            "name": "funded_leg",
            "version": VERSION,
            "issue": "ADAAAA-8489",
            "followUps": ["ADAAAA-8832", "ADAAAA-8943"],
            "dryRun": bool(args.dry_run),
            "stubScenario": args.stub_scenario if args.dry_run else None,
        },
        "authorized": {
            "durationS": cfg.authorized_duration_s,
            "capUsd": cfg.cap_usd,
            "abortAtUsd": round(cfg.abort_at_usd, 6),
            "abortMarginUsd": round(cfg.cap_usd - cfg.abort_at_usd, 6),
            # ADAAAA-8832: the billing basis the guard priced in, beside the
            # rate it implies. `meteredRateUsdPerS` stays for readers of the
            # older bundles; it is the perceive-basis rate only.
            "billing": billing_basis_from_config(cfg).as_dict(),
            "billingBasis": cfg.billing_basis,
            "decideFeeUsd": cfg.decide_fee_usd,
            "decideCadenceS": cfg.decide_cadence_s,
            "meteredRateUsdPerS": cfg.metered_rate_usd_per_s,
            "abortAtMeteredS": (
                round(cfg.abort_at_usd / _billing_rate, 2) if _billing_rate > 0 else None
            ),
            "capMeteredS": (
                round(cfg.cap_usd / _billing_rate, 2) if _billing_rate > 0 else None
            ),
            "hardStopSlackS": cfg.hard_stop_slack_s,
            "quietWindowS": cfg.quiet_window_s,
            "guard": (
                "max(costUsd, projection) where projection = metered x the billed "
                "unit rate, metered = max(record perceiveSessionS, seconds since "
                "job create); a READABLE costUsd beats the projection"
            ),
        },
        "probeCommands": [],
    }

    def finish(code: int, extra: Optional[Dict[str, Any]] = None) -> int:
        if extra:
            evidence.update(extra)
        # ADAAAA-8832: the billing basis can move after `authorized` is built —
        # the decide-config probe names the cadence actually in force — so the
        # authorized block is re-derived from the final config here rather than
        # published from an assumption.
        auth = evidence["authorized"]
        billing_now = billing_basis_from_config(cfg)
        rate_now = billing_now.usd_per_s()
        auth["billing"] = billing_now.as_dict()
        auth["billingBasis"] = cfg.billing_basis
        auth["decideFeeUsd"] = cfg.decide_fee_usd
        auth["decideCadenceS"] = cfg.decide_cadence_s
        auth["abortAtMeteredS"] = (
            round(cfg.abort_at_usd / rate_now, 2) if rate_now > 0 else None
        )
        auth["capMeteredS"] = (
            round(cfg.cap_usd / rate_now, 2) if rate_now > 0 else None
        )
        if stub is not None:
            evidence["stub"] = stub.snapshot()
        evidence["probeCommands"] = list(getattr(runner, "commands", []))
        if args.evidence_out:
            with open(args.evidence_out, "w", encoding="utf-8") as fh:
                json.dump(evidence, fh, indent=2, sort_keys=True)
                fh.write("\n")
        if not args.quiet:
            print(json.dumps(evidence, indent=2, sort_keys=True))
        if "shape" in evidence:
            print("\n" + evidence["shape"]["line"])
            print(evidence["shape"]["table"])
        if "clips" in evidence and evidence["clips"].get("note"):
            print("\n" + evidence["clips"]["note"])
        return code

    # ---- artifact identity (item 2) --------------------------------------
    # Runs BEFORE the quiet window: a leg whose served build or decide config
    # cannot be named is refused in seconds instead of after a 10 minute gate.
    if args.dry_run or args.no_build_check:
        evidence["build"] = {
            "sha": None,
            "container": cfg.build_container,
            "prefix": cfg.build_prefix,
            "files": [],
            "matched": 0,
            "mismatched": [],
            "verdict": "skipped",
            "line": (
                "BUILD-IDENTITY: skipped (dry-run stub; no served files to hash)"
                if args.dry_run
                else "BUILD-IDENTITY: skipped (--no-build-check) — this leg is NOT evidence"
            ),
        }
        evidence["decideConfig"] = {
            "container": cfg.decide_config_container,
            "keys": list(cfg.decide_config_keys),
            "values": {},
            "missing": [],
            "status": "skipped",
            "verdict": "skipped",
            "line": (
                "DECIDE-CONFIG: skipped (dry-run stub) — this leg is NOT evidence"
                if args.dry_run
                else "DECIDE-CONFIG: skipped (--no-build-check) — this leg is NOT evidence"
            ),
        }
        if not args.dry_run:
            log(evidence["build"]["line"])
            log(evidence["decideConfig"]["line"])
    else:
        build = verify_build(runner, cfg)
        evidence["build"] = build
        log(build["line"])
        if build["verdict"] == "verified":
            decide_cfg = decide_config_block(probe_decide_config(runner, cfg), cfg)
            evidence["decideConfig"] = decide_cfg
            log(decide_cfg["line"])
            # ADAAAA-8832: price the projection at the cadence the server is
            # actually running. A 3 s cadence bills 1.67x what a 5 s one does,
            # so the harness must not assume the default it was written against.
            if cfg.billing_basis == "decide" and args.decide_cadence_s is None:
                probed = (decide_cfg.get("values") or {}).get("LIVE_OBSERVE_CADENCE_S")
                try:
                    cadence = float(probed) if probed is not None else 0.0
                except (TypeError, ValueError):
                    cadence = 0.0
                if cadence > 0:
                    cfg.decide_cadence_s = cadence
                    log(
                        f"decide cadence {cadence:g} s read from "
                        f"LIVE_OBSERVE_CADENCE_S; projection priced on it"
                    )
                else:
                    log(
                        f"decide cadence unreadable on the box "
                        f"({probed!r}); projection priced at the "
                        f"{cfg.decide_cadence_s:g} s default"
                    )
        else:
            # Short-circuit: do not spend a probe on a leg already refused.
            decide_cfg = {
                "container": cfg.decide_config_container,
                "keys": list(cfg.decide_config_keys),
                "values": {},
                "missing": [],
                "status": "not probed",
                "verdict": "not probed",
                "line": "DECIDE-CONFIG: not probed (build identity already refused)",
            }
            evidence["decideConfig"] = decide_cfg
        refusal = artifact_refusal(build, decide_cfg)
        if refusal is not None:
            evidence["meteredCalls"] = {
                "jobCreates": 0,
                "sessionCreates": 0,
                "driverStarts": 0,
            }
            evidence["result"] = refusal
            log(f"REFUSED: {refusal['outcome']} — nothing metered")
            return finish(6)

    # ---- preflight -------------------------------------------------------
    try:
        samples = preflight(runner, cfg, log)
        evidence["preflight"] = preflight_block(samples, cfg.quiet_window_s, "open")
        evidence["gateAtStart"] = samples[-1].as_dict()
    except GateClosed as exc:
        evidence["preflight"] = preflight_block(
            [exc.sample], cfg.quiet_window_s, "closed", exc.reason
        )
        evidence["preflight"]["sample"] = exc.sample.as_dict()
        evidence["meteredCalls"] = {
            "jobCreates": 0,
            "sessionCreates": 0,
            "driverStarts": 0,
        }
        evidence["result"] = {
            "outcome": "refused_gate_closed",
            "exitCode": 3,
            "message": "gate not idle: the leg refused to start before any metered call",
        }
        log(f"REFUSED: gate closed — {exc.reason}")
        return finish(3)

    if args.preflight_only:
        evidence["meteredCalls"] = {
            "jobCreates": 0,
            "sessionCreates": 0,
            "driverStarts": 0,
        }
        evidence["result"] = {
            "outcome": "preflight_open_only",
            "exitCode": 0,
            "message": "quiet window proved; no leg started, nothing metered",
        }
        log("preflight open — exiting without a leg (--preflight-only)")
        return finish(0)

    # ---- leg -------------------------------------------------------------
    try:
        result = run_leg(runner, cfg, log)
    except SetupFailed as exc:
        evidence["result"] = {
            "outcome": "setup_failed",
            "exitCode": 5,
            "message": str(exc),
        }
        if getattr(exc, "job_id", None):
            evidence["leg"] = {"jobId": exc.job_id, "stopReason": "setup_failed"}
        log(f"SETUP FAILED: {exc}")
        return finish(5)
    except Exception as exc:  # unexpected: never leave a live job unflagged
        evidence["result"] = {
            "outcome": "harness_error",
            "exitCode": 4,
            "message": f"{type(exc).__name__}: {exc}",
        }
        log(f"HARNESS ERROR: {type(exc).__name__}: {exc}")
        return finish(4)

    shape = compare_shape(
        cfg.authorized_duration_s,
        cfg.cap_usd,
        result.duration_s,
        result.cost_usd,
        duration_tolerance_s=cfg.hard_stop_slack_s,
        metered_session_s=result.perceive_session_s,
        metered_rate_usd_per_s=result.metered_usd_per_s,
        gpu_hours=cfg.gpu_hours,
        abort_source=result.stop_reason,
        metered_projection_s=result.metered_projection_s,
        billing_basis=cfg.billing_basis,
        projected_basis=result.projected_basis,
        # ADAAAA-8832: a readable billed figure is the money accounted, so the
        # shape is graded on it rather than on a clock extrapolation of it.
        cost_readable=result.record_cost_source == "live",
        stop_source=result.stop_source,
        stop_source_class=result.stop_source_class,
    )
    within_slack = shape["durationOvershootS"] <= cfg.hard_stop_slack_s
    clips_probe = (
        {"status": "skipped (dry-run)", "files": []}
        if args.dry_run
        else probe_clips(runner, cfg, result.job_id)
    )
    evidence["clips"] = clips_block(clips_probe, result.delivered_rows, cfg, result.job_id)
    evidence["leg"] = {
        "jobId": result.job_id,
        "sessionId": result.session_id,
        "startedAt": result.started_at,
        "finishedAt": result.finished_at,
        "jobCreatedAt": result.created_at,
        "durationSource": "harness_clock",
        "stopReason": result.stop_reason,
        "stopCalls": result.stop_calls,
        "stopConfirmed": result.stop_confirmed,
        "settledStatus": result.settled_status,
        "durationS": round(result.duration_s, 3),
        "costUsd": round(result.cost_usd, 6),
        "perceiveSessionS": result.perceive_session_s,
        "costSource": result.cost_source,
        # ADAAAA-8529 item 1: the record was dark mid-leg, so the guard ran on the
        # meter's clock; the projection at the stop instant is evidence, not a
        # post-hoc reconstruction.
        "recordCostSource": result.record_cost_source,
        "meteredProjectionS": round(result.metered_projection_s, 3),
        "projectedFrom": result.projected_from,
        "projectedCostUsd": round(result.projected_cost_usd, 6),
        # ADAAAA-8832: the basis the projection was priced in, and the guard
        # reading the stop actually used.
        "projectedBasis": result.projected_basis,
        "billingBasis": cfg.billing_basis,
        "meteredUsdPerS": round(result.metered_usd_per_s, 10),
        "recordUnitsUsd": (
            round(result.record_units_usd, 6)
            if result.record_units_usd is not None
            else None
        ),
        "recordDecideCalls": result.record_decide_calls,
        "recordConfirmCalls": result.record_confirm_calls,
        "recordSummaryCalls": result.record_summary_calls,
        "guardSource": result.guard_source,
        "meteredRateUsdPerS": cfg.metered_rate_usd_per_s,
        "gpuHours": cfg.gpu_hours,
        "driverRc": result.driver_rc,
        "driverOutputTail": result.driver_output_tail,
        # ADAAAA-8943: where the stop came from. A leg the harness did not stop
        # is never reported as a supervised leg.
        "stopSource": result.stop_source,
        "stopSourceClass": result.stop_source_class,
        "stopSourceLine": result.stop_source_line,
        "harnessStopIssued": result.harness_stop_issued,
        "terminalWithoutHarnessStop": result.terminal_without_harness_stop,
        "recordStop": result.record_stop,
        "arm": {
            "pid": os.getpid(),
            "armedAt": result.armed_at,
            "heartbeatPath": result.heartbeat_path,
            "heartbeatS": cfg.heartbeat_s,
            "contract": (
                "`[leg] arm pid=… job=…` on stdout plus this heartbeat file; "
                "`launch_funded_leg.py` refuses without both inside its arm "
                "window and stops the job, `leg_supervisor.py` stops the job when "
                "the beats stop advancing"
            ),
        },
    }
    evidence["shape"] = shape
    evidence["meteredCalls"] = {
        "jobCreates": 1,
        "sessionCreates": 1,
        "driverStarts": 1 if cfg.driver_cmd else 0,
    }

    # ADAAAA-8943: an outside stop means the authorized stop never fired. The leg
    # is not gradable, and any cap breach is a field rather than something a
    # reader has to notice (the 8924 leg settled $1.4537 against a $1.30 cap and
    # its bundle reported a normal grade).
    if result.stop_source_class == "external":
        overspend = max(0.0, result.cost_usd - cfg.cap_usd)
        breach = None
        if overspend > 1e-9:
            breach = {
                "capUsd": cfg.cap_usd,
                "settledCostUsd": round(result.cost_usd, 6),
                "overspendUsd": round(overspend, 6),
                "stopSource": result.stop_source,
                "cause": (
                    "the leg was stopped from outside the harness: no wall-clock "
                    "or metered-ceiling stop fired, so it metered past its "
                    "authorized window"
                ),
            }
            evidence["capBreach"] = breach
        evidence["result"] = {
            "outcome": "stopped_outside_guard",
            "exitCode": 7,
            "gradable": False,
            "message": (
                f"{result.stop_source_line}. "
                + (
                    f"CAP BREACH: settled ${result.cost_usd:.4f} vs cap "
                    f"${cfg.cap_usd:.4f} (overspend ${overspend:.4f})."
                    if breach
                    else "No cap breach on the settled figure."
                )
            ),
        }
        log(f"STOPPED OUTSIDE THE GUARD — NOT GRADABLE, exiting 7")
        if breach:
            log(
                f"CAP BREACH: settled ${breach['settledCostUsd']:.4f} vs cap "
                f"${breach['capUsd']:.4f} -> overspend "
                f"${breach['overspendUsd']:.4f}"
            )
        return finish(7)

    if not result.stop_confirmed:
        evidence["result"] = {
            "outcome": "stop_unconfirmed",
            "exitCode": 4,
            "message": (
                "the stop was not confirmed inside the slack window; treat the leg "
                "as unverified and stop the job by hand"
            ),
        }
        log("STOP UNCONFIRMED — exiting 4")
        return finish(4)
    if not within_slack:
        evidence["result"] = {
            "outcome": "duration_overshoot_beyond_slack",
            "exitCode": 4,
            "message": f"duration overshoot {shape['durationOvershootS']} s > slack",
        }
        log("DURATION OVERSHOOT BEYOND SLACK — exiting 4")
        return finish(4)

    code = 0 if shape["verdict"] == "WITHIN" else 2
    evidence["result"] = {
        "outcome": "within_shape" if code == 0 else "over_shape",
        "exitCode": code,
        "gradable": True,
        "message": shape["line"],
    }
    log(shape["line"])
    return finish(code)


if __name__ == "__main__":
    sys.exit(main())

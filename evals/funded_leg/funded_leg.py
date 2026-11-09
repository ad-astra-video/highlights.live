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

Every run writes an evidence JSON whose `shape` block carries the
authorized-vs-actual duration and cost side by side, so an overshoot is a field
in the evidence rather than something a reader has to discover.

Dry-run (`--dry-run`) runs the whole loop against an in-process stub API: no
GPU, no box, no metered call. That is how the hard stop and the gate refusal
are proved; a funded cell runs the same code with the real endpoints.

Exit codes:
  0  within the authorized shape (duration and cost)
  2  OVER the authorized shape (the leg ran, and it overshot)
  3  gate closed at preflight — refused, nothing metered
  4  stop unconfirmed — live job may remain; do not report the leg as valid
  5  leg setup/start failed (job create, session create, or driver launch)
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

VERSION = "1.0.0"

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

    def _run(self, command: str, prefix: str, timeout: float = 60.0) -> subprocess.CompletedProcess:
        cmd = f"{prefix} {shlex.quote(command)}" if prefix else command
        self.commands.append(cmd)
        proc = subprocess.run(
            cmd, shell=True, cwd=self.shell_cwd, text=True, capture_output=True, timeout=timeout
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
        proc = self._run(inner, self.box_cmd)
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
    """

    def __init__(self, scenario: str, cost_per_s: float = 0.0016) -> None:
        self.scenario = scenario
        self.cost_per_s = cost_per_s
        # `clean-no-cost` models a leg whose billed costUsd stays 0 mid-leg while
        # perceiveSessionS advances (the projection path). `no-cost-source`
        # models both being unreadable: the leg must be refused.
        self.live_cost = scenario not in ("clean-no-cost", "no-cost-source")
        self.metered = scenario != "no-cost-source"
        busy = scenario == "busy"
        self.gate = {
            "nonterminal": 1 if busy else 0,
            "activeSessions": 1 if busy else 0,
            "leases": 1 if busy else 0,
            "cyc": 1 if busy else 0,
        }
        self.job: Optional[Dict[str, Any]] = None
        self.stop_calls = 0
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
        if self.job["status"] == "running":
            self.job["costUsd"] = round(elapsed * self.cost_per_s, 6) if self.live_cost else 0.0
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
    cost_source_grace_s: float
    gpu_hours: Optional[float]


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
        sample.nonterminal_jobs = int(rows[0]) if rows else 0
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

    if sample.errors:
        # An unreadable probe is not "quiet"; fold it into problems() output.
        sample.server_health = sample.server_health or f"probe errors: {sample.errors}"
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
            raise GateClosed("; ".join(problems), sample)
        log(
            f"preflight {sample.at} quiet: jobs 0, activeSessions 0, leases 0, "
            f"cyc 0/{len(cfg.pool_containers)}"
        )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(interval, remaining))
    return samples


# --------------------------------------------------------------------------
# Leg
# --------------------------------------------------------------------------


@dataclass
class LegResult:
    job_id: str
    session_id: Optional[str]
    started_at: str
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


def _job_field(body: Any, key: str, default: Any = None) -> Any:
    if isinstance(body, dict):
        job = body.get("job") if isinstance(body.get("job"), dict) else body
        if isinstance(job, dict):
            return job.get(key, default)
    return default


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
    deadline = t0 + cfg.authorized_duration_s
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
        "projected": 0.0,
        "live_readable": False,
    }

    def poll_state() -> str:
        res = runner.http("GET", f"{cfg.job_base}/jobs/{job_id}", headers=headers)
        status = _job_field(res.body, "status", "unknown")
        raw = res.body.get("job") if isinstance(res.body, dict) and isinstance(res.body.get("job"), dict) else res.body
        has_cost_field = isinstance(raw, dict) and "costUsd" in raw
        has_session_field = isinstance(raw, dict) and "perceiveSessionS" in raw
        state["status"] = status
        state["cost"] = float(_job_field(res.body, "costUsd", 0.0) or 0.0)
        state["perceive_session_s"] = float(
            _job_field(res.body, "perceiveSessionS", 0.0) or 0.0
        )
        state["projected"] = round(
            state["perceive_session_s"] * cfg.metered_rate_usd_per_s, 6
        )
        if state["cost"] > 0:
            state["cost_source"] = "live_cost"
            state["live_readable"] = True
        elif state["perceive_session_s"] > 0 and has_session_field:
            # Metered seconds are readable, so the projection is a valid guard
            # even while the billed figure is still 0.
            state["cost_source"] = "projected_cost"
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

    try:
        while True:
            status = poll_state()
            if status in ("done", "failed", "cancelled"):
                break
            now = time.monotonic()
            if now >= deadline:
                # Belt as well as braces: the loop never relies on the watchdog
                # thread having run, and never on a stop moment.
                issue_stop("authorized_duration")
                break
            # CEO A1: a wall-clock stop alone cannot hold the cap when metered
            # seconds inflate (8483: 544.5 s metered inside a 300 s window).
            # Abort on whichever source is higher: the billed figure or the
            # metered-second projection at the authorized $/s.
            effective = max(state["cost"], state["projected"])
            if effective >= cfg.abort_at_usd:
                source = (
                    "live_cost"
                    if state["cost"] >= state["projected"]
                    else "projected_cost"
                )
                log(
                    f"metered ceiling {cfg.abort_at_usd:.4f} reached on {source} "
                    f"(live=${state['cost']:.4f}, projected="
                    f"${state['projected']:.4f} at {cfg.metered_rate_usd_per_s:.7f}/s, "
                    f"metered={state['perceive_session_s']:.1f} s) — stopping"
                )
                issue_stop(source)
                break
            if (
                state["cost_source"] == "none"
                and now - t0 >= cfg.cost_source_grace_s
            ):
                issue_stop("no_cost_source")
                raise SetupFailed(
                    "no readable cost source: neither costUsd nor perceiveSessionS "
                    f"moved in {cfg.cost_source_grace_s:.0f} s — a leg without a "
                    "metered guard is not authorized to run",
                    job_id=job_id,
                )
            time.sleep(cfg.poll_s)
    finally:
        # Any exit path stops the leg: exception, keyboard, or normal end.
        if not stop_confirmed and stop_issued is None:
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
    stop_time = stop_issued or time.monotonic()
    return LegResult(
        job_id=job_id,
        session_id=session_id,
        started_at=_iso(started),
        started_monotonic=t0,
        stop_reason=stop_reason,
        stop_issued_monotonic=stop_issued,
        stop_confirmed=bool(state["status"] in ("done", "failed", "cancelled")),
        settled_status=state["status"],
        cost_usd=float(state["cost"]),
        perceive_session_s=float(state["perceive_session_s"]),
        duration_s=max(0.0, stop_time - t0),
        stop_calls=stop_calls,
        driver_rc=driver_rc,
        cost_source=state["cost_source"],
        projected_cost_usd=float(state["projected"]),
        driver_output_tail=driver_tail,
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
) -> Dict[str, Any]:
    """Grade the leg against its authorization.

    The duration bar carries the harness's documented tolerance (<= 10 s, AC1);
    a stop that fires a fraction of a second past the mark is inside the shape.
    The cost bar has no tolerance: any metered overshoot is OVER.
    """
    over_duration = max(0.0, actual_duration_s - authorized_duration_s)
    over_cost = max(0.0, actual_cost_usd - cap_usd)
    duration_over = over_duration > duration_tolerance_s + 1e-9
    cost_over = over_cost > cost_epsilon_usd
    verdict = "OVER" if (duration_over or cost_over) else "WITHIN"
    ratio = (
        (metered_session_s / actual_duration_s)
        if (metered_session_s is not None and actual_duration_s > 0)
        else None
    )
    projected = (
        (metered_session_s * metered_rate_usd_per_s)
        if (metered_session_s is not None and metered_rate_usd_per_s is not None)
        else None
    )
    metered_bits = ""
    if metered_session_s is not None:
        metered_bits = (
            f", metered perceiveSessionS {metered_session_s:.1f} s"
            + (f" ({ratio:.3f}x wall)" if ratio is not None else "")
        )
        if projected is not None:
            metered_bits += f", projected ${projected:.4f}"
            if projected > cap_usd + 1e-9:
                metered_bits += " (OVER cap)"
    line = (
        f"AUTHORIZED-VS-ACTUAL: authorized duration <= {authorized_duration_s:.1f} s / "
        f"cap ${cap_usd:.4f} -> actual {actual_duration_s:.1f} s / "
        f"${actual_cost_usd:.4f} "
        f"(duration {'over by ' if over_duration else 'headroom '}"
        f"{over_duration or authorized_duration_s - actual_duration_s:.2f} s, "
        f"cost {'over by ' if over_cost else 'headroom '}$"
        f"{over_cost or cap_usd - actual_cost_usd:.4f}{metered_bits}) — {verdict}"
    )
    table = (
        "| shape | authorized | actual | delta |\n"
        "|---|---:|---:|---:|\n"
        f"| duration (wall) | <= {authorized_duration_s:.1f} s | "
        f"{actual_duration_s:.1f} s | "
        f"{'+' if over_duration else ''}{actual_duration_s - authorized_duration_s:.1f} s |\n"
        f"| metered cost | <= ${cap_usd:.4f} | ${actual_cost_usd:.4f} | "
        f"{'+' if over_cost else ''}${actual_cost_usd - cap_usd:.4f} |"
    )
    if metered_session_s is not None:
        table += (
            f"\n| perceiveSessionS | - | {metered_session_s:.1f} s | "
            + (f"{ratio:.3f}x wall |" if ratio is not None else "n/a |")
        )
    if projected is not None:
        table += (
            f"\n| projected cost @ ${metered_rate_usd_per_s:.7f}/s | <= ${cap_usd:.4f} | "
            f"${projected:.4f} | {'+' if projected > cap_usd else ''}"
            f"${projected - cap_usd:.4f} |"
        )
    if gpu_hours is not None:
        table += f"\n| GPU-hours | - | {gpu_hours:.3f} | n/a |"
    if abort_source:
        table += f"\n| stop source | - | `{abort_source}` | - |"
    return {
        "authorizedDurationS": authorized_duration_s,
        "authorizedCapUsd": cap_usd,
        "actualDurationS": round(actual_duration_s, 3),
        "actualCostUsd": round(actual_cost_usd, 6),
        "durationOvershootS": round(over_duration, 3),
        "costOvershootUsd": round(over_cost, 6),
        "meteredPerceiveSessionS": (
            round(metered_session_s, 3) if metered_session_s is not None else None
        ),
        "meteredWallRatio": round(ratio, 4) if ratio is not None else None,
        "meteredRateUsdPerS": metered_rate_usd_per_s,
        "projectedCostUsd": round(projected, 6) if projected is not None else None,
        "projectedOverCap": bool(projected is not None and projected > cap_usd + 1e-9),
        "gpuHours": gpu_hours,
        "abortSource": abort_source,
        "verdict": verdict,
        "line": line,
        "table": table,
    }


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


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
                   help="stop early at this metered cost (default: cap - min(0.05, 5%%))")
    p.add_argument("--metered-rate-usd-per-s", type=float, default=0.0011381,
                   help="authorized $/perceive-second for the cost projection "
                        "(default 0.0011381, the 8515 rate)")
    p.add_argument("--cost-source-grace-s", type=float, default=15.0,
                   help="how long a leg may run before neither costUsd nor "
                        "perceiveSessionS is readable; then it is refused (default 15)")
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
    p.add_argument("--evidence-out", default=None,
                   help="write the evidence JSON here (also printed to stdout)")
    p.add_argument("--dry-run", action="store_true",
                   help="run against the in-process stub; no box, no metered call")
    p.add_argument("--stub-scenario", default="clean",
                   choices=["clean", "clean-no-cost", "no-cost-source", "busy", "stop-stuck"])
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
        abort_at_usd=(
            args.abort_at_usd
            if args.abort_at_usd is not None
            else args.cap_usd - min(0.05, args.cap_usd * 0.05)
        ),
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
        cost_source_grace_s=args.cost_source_grace_s,
        gpu_hours=args.gpu_hours,
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

    evidence: Dict[str, Any] = {
        "harness": {
            "name": "funded_leg",
            "version": VERSION,
            "issue": "ADAAAA-8489",
            "dryRun": bool(args.dry_run),
            "stubScenario": args.stub_scenario if args.dry_run else None,
        },
        "authorized": {
            "durationS": cfg.authorized_duration_s,
            "capUsd": cfg.cap_usd,
            "abortAtUsd": round(cfg.abort_at_usd, 6),
            "meteredRateUsdPerS": cfg.metered_rate_usd_per_s,
            "hardStopSlackS": cfg.hard_stop_slack_s,
            "quietWindowS": cfg.quiet_window_s,
        },
        "probeCommands": [],
    }

    def finish(code: int, extra: Optional[Dict[str, Any]] = None) -> int:
        if extra:
            evidence.update(extra)
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
        return code

    # ---- preflight -------------------------------------------------------
    try:
        samples = preflight(runner, cfg, log)
        evidence["preflight"] = {
            "verdict": "open",
            "quietWindowS": cfg.quiet_window_s,
            "samples": [s.as_dict() for s in samples],
        }
        evidence["gateAtStart"] = samples[-1].as_dict()
    except GateClosed as exc:
        evidence["preflight"] = {
            "verdict": "closed",
            "quietWindowS": cfg.quiet_window_s,
            "reason": exc.reason,
            "sample": exc.sample.as_dict(),
        }
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
        metered_rate_usd_per_s=cfg.metered_rate_usd_per_s,
        gpu_hours=cfg.gpu_hours,
        abort_source=result.stop_reason,
    )
    within_slack = shape["durationOvershootS"] <= cfg.hard_stop_slack_s
    evidence["leg"] = {
        "jobId": result.job_id,
        "sessionId": result.session_id,
        "startedAt": result.started_at,
        "stopReason": result.stop_reason,
        "stopCalls": result.stop_calls,
        "stopConfirmed": result.stop_confirmed,
        "settledStatus": result.settled_status,
        "durationS": round(result.duration_s, 3),
        "costUsd": round(result.cost_usd, 6),
        "perceiveSessionS": result.perceive_session_s,
        "costSource": result.cost_source,
        "projectedCostUsd": round(result.projected_cost_usd, 6),
        "meteredRateUsdPerS": cfg.metered_rate_usd_per_s,
        "gpuHours": cfg.gpu_hours,
        "driverRc": result.driver_rc,
        "driverOutputTail": result.driver_output_tail,
    }
    evidence["shape"] = shape
    evidence["meteredCalls"] = {
        "jobCreates": 1,
        "sessionCreates": 1,
        "driverStarts": 1 if cfg.driver_cmd else 0,
    }

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
        "message": shape["line"],
    }
    log(shape["line"])
    return finish(code)


if __name__ == "__main__":
    sys.exit(main())

"""ADAAAA-8943 tests: the guard must survive the caller. Stdlib only, $0.

The incident (ADAAAA-8924 rev-8 live leg) was not a bad stop *rule*: it was that
the only stop lived inside a process the launching session killed. These tests
prove the three properties that close it, without a funded leg:

  1. `launch_funded_leg.py` runs the harness detached and refuses to call a leg
     supervised unless the arm line, the heartbeat and a live pid all arrived;
  2. killing the LAUNCHER (its whole session, as in 8924) leaves the harness
     running to its own `authorized_duration` stop and writing evidence;
  3. `leg_supervisor.py` issues the stop itself when the heartbeat goes stale —
     proved against a real HTTP stop endpoint on localhost;
  4. an operator-stopped leg is refused (exit 7) with `capBreach` naming the
     overspend, instead of being graded as a supervised leg.

Run: python3 -m unittest discover -s evals/funded_leg -v
"""

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, Optional
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import funded_leg  # noqa: E402
import launch_funded_leg  # noqa: E402
import leg_supervisor  # noqa: E402

HARNESS = os.path.join(HERE, "funded_leg.py")
LAUNCHER = os.path.join(HERE, "launch_funded_leg.py")
SUPERVISOR = os.path.join(HERE, "leg_supervisor.py")


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def wait_for(predicate: Callable[[], Any], timeout: float, interval: float = 0.2) -> Any:
    """Poll until `predicate` is truthy; return its last value either way."""
    end = time.time() + timeout
    value: Any = None
    while time.time() < end:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return predicate()


def read_json(path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


class StopSourceClassificationTest(unittest.TestCase):
    """The bundle must name who stopped the leg (pass bar 4)."""

    def test_harness_stop_is_the_harness(self):
        block = funded_leg.classify_stop_source(
            harness_stop_issued=True,
            harness_stop_reason="authorized_duration",
            terminal_without_harness_stop=False,
            record={"status": "cancelled", "stopRequestedAt": "2026-11-13T12:50:12Z"},
        )
        self.assertEqual(block["stopSourceClass"], "harness")
        self.assertEqual(block["stopSource"], "authorized_duration")
        self.assertIn("STOP-SOURCE: harness", block["stopSourceLine"])

    def test_an_operator_stop_is_external_even_when_the_record_has_a_stop_field(self):
        # The 8924 shape: `stopRequestedAt` set by someone else's API call.
        block = funded_leg.classify_stop_source(
            harness_stop_issued=False,
            harness_stop_reason="ended",
            terminal_without_harness_stop=True,
            record={
                "status": "cancelled",
                "stopRequestedAt": "2026-11-13T12:50:12Z",
                "error": "stopped (cancelled via API)",
            },
        )
        self.assertEqual(block["stopSourceClass"], "external")
        self.assertEqual(block["stopSource"], "operator_api")
        self.assertIn("NOT gradable", block["stopSourceLine"])

    def test_a_job_that_ended_on_its_own_is_not_external(self):
        block = funded_leg.classify_stop_source(
            harness_stop_issued=False,
            harness_stop_reason="ended",
            terminal_without_harness_stop=True,
            record={"status": "done"},
        )
        self.assertEqual(block["stopSourceClass"], "job_self_ended")
        self.assertEqual(block["stopSource"], "job_content_end")

    def test_shape_table_names_the_classified_stop_source(self):
        shape = funded_leg.compare_shape(
            60, 1.30, 1200.0, 1.4537,
            abort_source="ended",
            stop_source="operator_api",
            stop_source_class="external",
        )
        self.assertIn("`operator_api (external)`", shape["table"])
        self.assertNotIn("| stop source | - | `ended`", shape["table"])
        self.assertEqual(shape["stopSource"], "operator_api")
        self.assertEqual(shape["stopSourceClass"], "external")

    def test_harness_stop_keeps_the_plain_reason_in_the_table(self):
        shape = funded_leg.compare_shape(
            60, 1.30, 60.0, 0.20,
            abort_source="authorized_duration",
            stop_source="authorized_duration",
            stop_source_class="harness",
        )
        self.assertIn("| stop source | - | `authorized_duration` | - |", shape["table"])


class OperatorStopRefusalTest(unittest.TestCase):
    """Pass bar 4: an outside stop is refused, and the breach is a field."""

    def _run(self, scenario: str, cap: float) -> tuple:
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "evidence.json")
            code = funded_leg.main([
                "--dry-run", "--quiet", "--stub-scenario", scenario,
                "--authorized-duration-s", "60", "--cap-usd", str(cap),
                "--quiet-window-min", "0.1", "--evidence-out", out,
            ])
            return code, read_json(out)

    def test_operator_stop_over_the_cap_exits_7_and_names_the_overspend(self):
        code, evidence = self._run("operator-stop-overspend", 1.30)
        self.assertEqual(code, 7)
        self.assertIsNotNone(evidence)
        self.assertEqual(evidence["result"]["outcome"], "stopped_outside_guard")
        self.assertFalse(evidence["result"]["gradable"])
        self.assertEqual(evidence["leg"]["stopSource"], "operator_api")
        self.assertEqual(evidence["leg"]["stopSourceClass"], "external")
        self.assertFalse(evidence["leg"]["harnessStopIssued"])
        self.assertTrue(evidence["leg"]["terminalWithoutHarnessStop"])
        breach = evidence["capBreach"]
        self.assertAlmostEqual(breach["settledCostUsd"], 1.4537, places=4)
        self.assertAlmostEqual(breach["capUsd"], 1.30, places=4)
        self.assertAlmostEqual(breach["overspendUsd"], 0.1537, places=4)
        self.assertEqual(breach["stopSource"], "operator_api")

    def test_operator_stop_under_the_cap_is_still_not_gradable(self):
        code, evidence = self._run("operator-stop-within", 1.30)
        self.assertEqual(code, 7)
        self.assertFalse(evidence["result"]["gradable"])
        self.assertNotIn("capBreach", evidence)
        self.assertIn("No cap breach", evidence["result"]["message"])

    def test_a_harness_stop_is_gradable(self):
        code, evidence = self._run("clean", 0.65)
        self.assertEqual(code, 0)
        self.assertEqual(evidence["leg"]["stopSourceClass"], "harness")
        self.assertTrue(evidence["result"]["gradable"])
        self.assertNotIn("capBreach", evidence)


class LauncherDetachmentTest(unittest.TestCase):
    """Pass bars 1-3: detached launch, arm proof, and survival of the caller."""

    def test_the_arm_proof_accepts_a_leg_that_is_really_armed(self):
        with tempfile.TemporaryDirectory() as run_dir:
            proc = subprocess.Popen(
                [
                    sys.executable, LAUNCHER,
                    "--run-dir", run_dir, "--no-supervisor",
                    "--arm-timeout-s", "40", "--quiet",
                    "--dry-run", "--stub-scenario", "clean",
                    "--authorized-duration-s", "8", "--cap-usd", "0.65",
                    "--quiet-window-min", "0.1", "--quiet",
                ],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            try:
                arm_path = os.path.join(run_dir, "arm.json")

                def armed():
                    body = read_json(arm_path)
                    return body if body and body.get("outcome") == "armed" else None

                arm = wait_for(armed, 45)
                self.assertIsNotNone(
                    arm, f"launcher never armed: {proc.stdout.read(4000)!r}"
                    if proc.poll() is not None else "launcher never armed"
                )
                self.assertEqual(arm["jobId"], "stub-job-0001")
                heartbeat = arm["heartbeat"]
                self.assertEqual(heartbeat["phase"] in ("armed", "running"), True)
                self.assertEqual(heartbeat["jobId"], "stub-job-0001")
                self.assertIsNotNone(heartbeat["deadlineEpoch"])
                launch = read_json(os.path.join(run_dir, "launch.json")) or {}
                self.assertEqual(launch["harnessPid"], arm["harnessPid"])
                # `--quiet` is consumed by the launcher itself (both scripts
                # define it), so the harness always gets to print its arm line
                # into harness.log — the proof the arm check reads.
                self.assertFalse(launch["harnessQuiet"])
                self.assertNotIn("--quiet", launch["harnessArgv"])
                # The harness runs in its own session, not the launcher's group.
                self.assertNotEqual(os.getpgid(arm["harnessPid"]), os.getpgid(0))
                self.assertTrue(launch_funded_leg.pid_alive(arm["harnessPid"]))
                # ADAAAA-9008: a dry run cannot commit the deadline (the stub
                # job lives in the harness process), and it says so instead of
                # implying a durable guard exists.
                guard = arm["deadlineGuard"]
                self.assertEqual(guard["kind"], "skipped_dry_run")
                self.assertFalse(guard["durable"])
                self.assertFalse(arm["durable"])
                self.assertEqual(
                    read_json(os.path.join(run_dir, "deadline_guard.json"))["kind"],
                    "skipped_dry_run",
                )
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=20)
                if proc.stdout is not None:
                    proc.stdout.close()

    def test_killing_the_launchers_session_does_not_take_the_guard_down(self):
        """The 8924 shape: the caller's session dies, the leg must still stop."""
        with tempfile.TemporaryDirectory() as run_dir:
            proc = subprocess.Popen(
                [
                    sys.executable, LAUNCHER,
                    "--run-dir", run_dir, "--no-supervisor",
                    "--arm-timeout-s", "40", "--quiet",
                    "--dry-run", "--stub-scenario", "clean",
                    "--authorized-duration-s", "8", "--cap-usd", "0.65",
                    "--quiet-window-min", "0.1", "--quiet",
                ],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            arm_path = os.path.join(run_dir, "arm.json")
            arm = wait_for(
                lambda: (b if (b := read_json(arm_path)) and b.get("outcome") == "armed" else None),
                45,
            )
            self.assertIsNotNone(arm, "launcher never armed")

            # Kill the launcher AND its whole session/process group, which is
            # what took the 8924 harness down.
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            proc.wait(timeout=20)
            time.sleep(0.5)
            self.assertTrue(
                launch_funded_leg.pid_alive(arm["harnessPid"]),
                "the harness died with the launching session",
            )

            evidence_path = os.path.join(run_dir, "evidence.json")

            def stopped():
                body = read_json(evidence_path)
                return body if body and body.get("leg", {}).get("stopSource") else None

            evidence = wait_for(stopped, 40)
            self.assertIsNotNone(evidence, "the detached harness wrote no evidence")
            leg = evidence["leg"]
            self.assertEqual(leg["stopSourceClass"], "harness")
            self.assertEqual(leg["stopSource"], "authorized_duration")
            self.assertTrue(leg["harnessStopIssued"])
            self.assertEqual(evidence["result"]["outcome"], "within_shape")
            self.assertTrue(evidence["result"]["gradable"])
            self.assertLessEqual(leg["durationS"], 8 + 10)
            self.assertIn("STOP-SOURCE: harness", leg["stopSourceLine"])

    def test_a_harness_that_dies_before_arming_is_refused(self):
        with tempfile.TemporaryDirectory() as run_dir:
            stub = os.path.join(run_dir, "dead_harness.py")
            with open(stub, "w", encoding="utf-8") as fh:
                fh.write("import sys\nsys.exit(0)\n")
            proc = subprocess.run(
                [
                    sys.executable, LAUNCHER,
                    "--run-dir", run_dir, "--no-supervisor", "--harness", stub,
                    "--arm-timeout-s", "5", "--quiet", "--dry-run",
                    "--authorized-duration-s", "30", "--cap-usd", "0.10",
                ],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
            )
            self.assertEqual(proc.returncode, 8, proc.stdout.decode()[-2000:])
            arm = read_json(os.path.join(run_dir, "arm.json"))
            self.assertEqual(arm["outcome"], "arm_failed")
            self.assertIn("before arming", arm["reason"])
            self.assertIn("no supervised leg exists", proc.stdout.decode())

    def test_a_leg_that_never_arms_is_stopped_by_the_launcher(self):
        """Pass bar 2: an arm failure stops the job it can name, at $0."""
        _StopHandler.received = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), _StopHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as run_dir:
                stub = os.path.join(run_dir, "half_harness.py")
                with open(stub, "w", encoding="utf-8") as fh:
                    # Creates the job, then dies before arming — the 8924 shape
                    # minus the detached launch, which is what the arm check is
                    # for.
                    fh.write(
                        "print('[leg] job stub-job-123 created 2026-11-13T12:21:00Z', flush=True)\n"
                        "import sys\nsys.exit(0)\n"
                    )
                proc = subprocess.run(
                    [
                        sys.executable, LAUNCHER,
                        "--run-dir", run_dir, "--no-supervisor", "--harness", stub,
                        "--arm-timeout-s", "5", "--quiet",
                        "--authorized-duration-s", "30", "--cap-usd", "0.10",
                        "--token", "dry-run-token",
                        "--job-base", f"http://127.0.0.1:{server.server_address[1]}",
                    ],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
                )
                self.assertEqual(proc.returncode, 8, proc.stdout.decode()[-2000:])
                arm = read_json(os.path.join(run_dir, "arm.json"))
                self.assertEqual(arm["jobId"], "stub-job-123")
                self.assertTrue(arm["stop"]["attempted"])
                self.assertTrue(arm["stop"]["ok"], arm["stop"])
                self.assertEqual(arm["stop"]["http"], 200)
                self.assertIn("/jobs/stub-job-123/stop", _StopHandler.received)
        finally:
            server.shutdown()
            server.server_close()


class SupervisorDecisionTest(unittest.TestCase):
    """The fallback supervisor's rules, without a clock or a network."""

    def _beat(self, **over: Any) -> Dict[str, Any]:
        now = time.time()
        beat = {
            "phase": "running",
            "jobId": "job-1",
            "pid": 4242,
            "beatAt": _iso(datetime.now(timezone.utc)),
            "deadlineEpoch": now + 600,
            "deadlineAt": _iso(datetime.now(timezone.utc) + timedelta(seconds=600)),
        }
        beat.update(over)
        return beat

    def test_a_fresh_heartbeat_is_not_stopped(self):
        now = time.time()
        decision = leg_supervisor.decide(
            self._beat(), now=now, stale_s=45, slack_s=10, last_beat_at=now,
        )
        self.assertEqual(decision["action"], "wait")

    def test_a_stale_heartbeat_is_stopped(self):
        now = time.time()
        decision = leg_supervisor.decide(
            self._beat(), now=now, stale_s=45, slack_s=10, last_beat_at=now - 90,
        )
        self.assertEqual(decision["action"], "stop_stale_heartbeat")
        self.assertEqual(decision["jobId"], "job-1")
        self.assertAlmostEqual(decision["staleByS"], 90.0, places=1)

    def test_a_passed_deadline_is_stopped(self):
        now = time.time()
        decision = leg_supervisor.decide(
            self._beat(deadlineEpoch=now - 60), now=now, stale_s=45, slack_s=10,
            last_beat_at=now,
        )
        self.assertEqual(decision["action"], "stopped_deadline")

    def test_a_deadline_inside_the_slack_is_not(self):
        now = time.time()
        decision = leg_supervisor.decide(
            self._beat(deadlineEpoch=now - 5), now=now, stale_s=45, slack_s=10,
            last_beat_at=now,
        )
        self.assertEqual(decision["action"], "wait")

    def test_a_finished_heartbeat_is_never_stopped(self):
        now = time.time()
        decision = leg_supervisor.decide(
            self._beat(phase="finished"), now=now, stale_s=1, slack_s=0,
            last_beat_at=now - 3600,
        )
        self.assertEqual(decision["action"], "finished")

    def test_a_heartbeat_with_no_job_has_nothing_to_stop(self):
        now = time.time()
        decision = leg_supervisor.decide(
            self._beat(jobId=None), now=now, stale_s=1, slack_s=0, last_beat_at=now,
        )
        self.assertEqual(decision["action"], "no_arm")

    def test_no_heartbeat_at_all_is_no_arm(self):
        decision = leg_supervisor.decide(
            None, now=time.time(), stale_s=45, slack_s=10, last_beat_at=None,
        )
        self.assertEqual(decision["action"], "no_arm")


class SupervisorLoopTest(unittest.TestCase):
    """`supervise()` drives the decision into exactly one stop."""

    def test_a_stale_heartbeat_produces_one_stop_and_a_verdict(self):
        with tempfile.TemporaryDirectory() as tmp:
            beat_path = os.path.join(tmp, "heartbeat.json")
            verdict_path = os.path.join(tmp, "supervisor.json")
            funded_leg.write_json_atomic(beat_path, {
                "phase": "running",
                "jobId": "job-7",
                "pid": 99,
                "beatAt": _iso(datetime.now(timezone.utc) - timedelta(seconds=120)),
                "deadlineEpoch": time.time() + 600,
                "deadlineAt": _iso(datetime.now(timezone.utc) + timedelta(seconds=600)),
                "authorizedDurationS": 600,
                "capUsd": 1.30,
            })
            calls = []

            def fake_stop(job_id: str) -> Dict[str, Any]:
                calls.append(job_id)
                return {"jobId": job_id, "attempted": True, "ok": True, "http": 200,
                        "error": None}

            code = leg_supervisor.supervise(
                heartbeat_path=beat_path,
                evidence_out=verdict_path,
                stale_s=30, slack_s=10, arm_timeout_s=5, poll_s=0.05,
                stop=fake_stop, log=lambda _msg: None,
            )
            self.assertEqual(code, 0)
            self.assertEqual(calls, ["job-7"])
            verdict = read_json(verdict_path)
            self.assertEqual(verdict["outcome"], "stopped_stale_heartbeat")
            self.assertEqual(verdict["jobId"], "job-7")
            self.assertTrue(verdict["stop"]["ok"])
            self.assertIn("leg_supervisor", verdict["source"])

    def test_a_finished_heartbeat_exits_without_stopping(self):
        with tempfile.TemporaryDirectory() as tmp:
            beat_path = os.path.join(tmp, "heartbeat.json")
            verdict_path = os.path.join(tmp, "supervisor.json")
            funded_leg.write_json_atomic(beat_path, {
                "phase": "finished", "jobId": "job-8", "pid": 99,
                "beatAt": _iso(datetime.now(timezone.utc)),
                "status": "done",
            })
            calls = []
            code = leg_supervisor.supervise(
                heartbeat_path=beat_path, evidence_out=verdict_path,
                stale_s=1, slack_s=0, arm_timeout_s=5, poll_s=0.05,
                stop=lambda job_id: calls.append(job_id) or {"ok": True},
                log=lambda _msg: None,
            )
            self.assertEqual(code, 0)
            self.assertEqual(calls, [])
            self.assertEqual(read_json(verdict_path)["outcome"], "finished")

    def test_an_unconfirmed_stop_is_not_reported_as_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            beat_path = os.path.join(tmp, "heartbeat.json")
            verdict_path = os.path.join(tmp, "supervisor.json")
            funded_leg.write_json_atomic(beat_path, {
                "phase": "running", "jobId": "job-9", "pid": 99,
                "beatAt": _iso(datetime.now(timezone.utc) - timedelta(seconds=120)),
                "deadlineEpoch": time.time() + 600,
            })
            code = leg_supervisor.supervise(
                heartbeat_path=beat_path, evidence_out=verdict_path,
                stale_s=30, slack_s=10, arm_timeout_s=5, poll_s=0.05,
                stop=lambda job_id: {"jobId": job_id, "attempted": True,
                                     "ok": False, "http": 500, "error": "HTTP 500"},
                log=lambda _msg: None,
            )
            self.assertEqual(code, leg_supervisor.EXIT_STOP_UNCONFIRMED)
            self.assertEqual(read_json(verdict_path)["outcome"], "stop_unconfirmed")


class _StopHandler(BaseHTTPRequestHandler):
    received: list = []

    def do_POST(self) -> None:  # noqa: N802 (http.server API)
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        _StopHandler.received.append(self.path)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *args: Any) -> None:  # silence the test server
        return


class SupervisorStopIntegrationTest(unittest.TestCase):
    """Pass bar 3's second arm: the fallback supervisor issues a real stop."""

    def test_the_supervisor_posts_a_stop_when_the_heartbeat_is_stale(self):
        _StopHandler.received = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), _StopHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                beat_path = os.path.join(tmp, "heartbeat.json")
                verdict_path = os.path.join(tmp, "supervisor.json")
                funded_leg.write_json_atomic(beat_path, {
                    "phase": "running", "jobId": "stub-job-9", "pid": 99,
                    "beatAt": _iso(datetime.now(timezone.utc) - timedelta(seconds=120)),
                    "deadlineEpoch": time.time() + 600,
                })
                proc = subprocess.run(
                    [
                        sys.executable, SUPERVISOR,
                        "--heartbeat", beat_path, "--evidence-out", verdict_path,
                        "--stale-s", "30", "--poll-s", "0.2", "--arm-timeout-s", "5",
                        "--job-base", f"http://127.0.0.1:{server.server_address[1]}",
                        "--token", "dry-run-token", "--quiet",
                    ],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
                )
                self.assertEqual(proc.returncode, 0, proc.stdout.decode()[-2000:])
                verdict = read_json(verdict_path)
                self.assertEqual(verdict["outcome"], "stopped_stale_heartbeat")
                self.assertTrue(verdict["stop"]["ok"])
                self.assertEqual(verdict["stop"]["http"], 200)
                self.assertIn("/jobs/stub-job-9/stop", _StopHandler.received)
        finally:
            server.shutdown()
            server.server_close()


class DeadlineGuardPlanTest(unittest.TestCase):
    """ADAAAA-9008: when the durable timer fires, and why it cannot fire early.

    Both guards can die at once, so the deadline itself is committed to systemd.
    The timer must not race the harness's own stop (deadline), nor the
    supervisor's deadline window (deadline + hard-stop slack).
    """

    def _beat(self, **over: Any) -> Dict[str, Any]:
        now = time.time()
        beat = {
            "phase": "running",
            "jobId": "d46c3788-04c1-430d-9e28-9b9ef4232a10",
            "pid": 2762347,
            "beatAt": _iso(datetime.now(timezone.utc)),
            "deadlineEpoch": now + 600,
            "deadlineAt": _iso(datetime.now(timezone.utc) + timedelta(seconds=600)),
            "hardStopSlackS": 10.0,
            "authorizedDurationS": 600.0,
        }
        beat.update(over)
        return beat

    def test_it_fires_after_deadline_slack_and_grace(self):
        now = time.time()
        plan = launch_funded_leg.deadline_guard_plan(
            self._beat(deadlineEpoch=now + 100), now=now, grace_s=5.0,
        )
        self.assertTrue(plan["ok"], plan)
        self.assertAlmostEqual(plan["fireEpoch"], now + 115, places=1)
        self.assertAlmostEqual(plan["delayS"], 115, places=1)
        self.assertEqual(plan["slackS"], 10.0)
        self.assertEqual(plan["graceS"], 5.0)

    def test_the_unit_name_is_a_valid_transient_unit(self):
        plan = launch_funded_leg.deadline_guard_plan(self._beat(), now=time.time())
        unit = plan["unit"]
        self.assertRegex(unit, r"^[A-Za-z0-9:_.-]+$")
        self.assertLessEqual(len(unit), 64)
        self.assertTrue(unit.startswith("funded-leg-"))
        self.assertIn("d46c3788", unit)

    def test_a_heartbeat_with_no_deadline_is_not_armed(self):
        plan = launch_funded_leg.deadline_guard_plan(
            self._beat(deadlineEpoch=None), now=time.time(),
        )
        self.assertFalse(plan["ok"])
        self.assertIn("deadlineEpoch", plan["reason"])

    def test_no_heartbeat_is_not_armed(self):
        plan = launch_funded_leg.deadline_guard_plan(None, now=time.time())
        self.assertFalse(plan["ok"])
        self.assertIn("job id", plan["reason"])


class DeadlineGuardScriptTest(unittest.TestCase):
    """The timer's script must stop the job with no tooling tree and no guards."""

    def test_the_script_posts_the_stop_and_writes_its_result(self):
        _StopHandler.received = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), _StopHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                result_path = os.path.join(tmp, "deadline_guard_result.json")
                script_path = os.path.join(tmp, "deadline_guard_stop.py")
                launch_funded_leg.write_deadline_guard_script(
                    script_path,
                    launch_funded_leg.render_deadline_guard_script(
                        job_id="stub-job-9008",
                        job_base=f"http://127.0.0.1:{server.server_address[1]}",
                        result_path=result_path,
                        unit="funded-leg-stub-9008",
                        armed_for_epoch=time.time() - 3,
                        token="dry-run-token",
                    ),
                )
                # The script may carry a bearer token, so it is owner-only.
                self.assertEqual(os.stat(script_path).st_mode & 0o777, 0o700)
                proc = subprocess.run(
                    [sys.executable, script_path],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
                )
                self.assertEqual(proc.returncode, 0, proc.stdout.decode()[-2000:])
                self.assertIn("/jobs/stub-job-9008/stop", _StopHandler.received)
                body = read_json(result_path)
                self.assertTrue(body["fired"])
                self.assertTrue(body["stop"]["ok"])
                self.assertEqual(body["stop"]["http"], 200)
                self.assertEqual(body["tokenSource"], "arg")
                self.assertEqual(body["jobId"], "stub-job-9008")
                self.assertGreaterEqual(body["lateByS"], 1.0)
        finally:
            server.shutdown()
            server.server_close()

    def test_a_script_that_cannot_mint_says_so_instead_of_claiming_a_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            result_path = os.path.join(tmp, "deadline_guard_result.json")
            script_path = os.path.join(tmp, "deadline_guard_stop.py")
            launch_funded_leg.write_deadline_guard_script(
                script_path,
                launch_funded_leg.render_deadline_guard_script(
                    job_id="stub-job-9009",
                    job_base="http://127.0.0.1:9",
                    result_path=result_path,
                    unit="funded-leg-stub-9009",
                    armed_for_epoch=time.time(),
                    token=None,
                    user_id=None,
                ),
            )
            proc = subprocess.run(
                [sys.executable, script_path],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
            )
            self.assertEqual(proc.returncode, 2, proc.stdout.decode()[-2000:])
            body = read_json(result_path)
            self.assertFalse(body["stop"]["ok"])
            self.assertIn("no token", body["tokenError"])


class DeadlineGuardArmTest(unittest.TestCase):
    """A timer that is not `active` in systemd is not an armed guard."""

    def _plan(self) -> Dict[str, Any]:
        return launch_funded_leg.deadline_guard_plan(
            {
                "jobId": "stub-job-9010",
                "deadlineEpoch": time.time() + 60,
                "deadlineAt": _iso(datetime.now(timezone.utc) + timedelta(seconds=60)),
                "hardStopSlackS": 10.0,
            },
            now=time.time(),
            grace_s=1.0,
        )

    def test_an_inactive_timer_is_reported_unarmed(self):
        plan = self._plan()
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(launch_funded_leg.subprocess, "run") as run:
                run.return_value = subprocess.CompletedProcess(
                    args=[], returncode=0,
                    stdout=b"Running timer as unit: funded-leg-stub.timer\n",
                )
                with mock.patch.object(
                    launch_funded_leg, "systemctl_show",
                    return_value={"unit": plan["unit"], "activeState": "inactive",
                                  "nextElapse": None, "rc": 0, "error": None},
                ):
                    guard = launch_funded_leg.arm_deadline_guard(
                        plan, run_dir=tmp, job_base="http://127.0.0.1:9", token="t",
                    )
                # The script is written before the timer is started, so a leg
                # that cannot commit the timer still leaves the stop command on
                # disk for an operator to run by hand.
                script_written = os.path.exists(guard["script"])
        self.assertFalse(guard["armed"])
        self.assertFalse(guard["durable"])
        self.assertIn("not active", guard["error"])
        self.assertTrue(script_written)

    def test_an_active_timer_is_armed_and_read_back(self):
        plan = self._plan()
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(launch_funded_leg.subprocess, "run") as run:
                run.return_value = subprocess.CompletedProcess(
                    args=[], returncode=0,
                    stdout=b"Running timer as unit: funded-leg-stub.timer\n",
                )
                with mock.patch.object(
                    launch_funded_leg, "systemctl_show",
                    return_value={"unit": plan["unit"], "activeState": "active",
                                  "nextElapse": "Sat 2026-11-14 06:44:27 UTC",
                                  "rc": 0, "error": None},
                ):
                    guard = launch_funded_leg.arm_deadline_guard(
                        plan, run_dir=tmp, job_base="http://127.0.0.1:9", token="t",
                    )
        self.assertTrue(guard["armed"])
        self.assertTrue(guard["durable"])
        self.assertEqual(guard["activeState"], "active")
        self.assertEqual(guard["systemdRunRc"], 0)

    def test_a_failed_systemd_run_is_not_armed(self):
        plan = self._plan()
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(launch_funded_leg.subprocess, "run") as run:
                run.return_value = subprocess.CompletedProcess(
                    args=[], returncode=1, stdout=b"Failed to connect to bus\n",
                )
                guard = launch_funded_leg.arm_deadline_guard(
                    plan, run_dir=tmp, job_base="http://127.0.0.1:9", token="t",
                )
        self.assertFalse(guard["armed"])
        self.assertIn("systemd-run rc=1", guard["error"])


class SystemctlShowTest(unittest.TestCase):
    """The read-back must label values by property, not by output position.

    Measured on systemd 255: with several `--property` flags, `--value` printed
    `NextElapseUSecMonotonic` BEFORE `ActiveState`, so a positional read labelled
    the timer's state as its elapse time. One call per property is the fix.
    """

    def _run(self, values_by_property: Dict[str, str]):
        def side_effect(argv, **_kwargs):
            prop = next(a.split("=", 1)[1] for a in argv if a.startswith("--property="))
            return subprocess.CompletedProcess(
                args=list(argv), returncode=0,
                stdout=(values_by_property.get(prop, "") + "\n").encode(),
            )
        return side_effect

    def test_each_property_is_read_on_its_own(self):
        with mock.patch.object(launch_funded_leg.subprocess, "run") as run:
            run.side_effect = self._run({
                "ActiveState": "active",
                "NextElapseUSecRealtime": "",
                "NextElapseUSecMonotonic": "18446744073709551615",
            })
            shown = launch_funded_leg.systemctl_show(
                "funded-leg-x", "ActiveState",
                "NextElapseUSecRealtime", "NextElapseUSecMonotonic",
            )
            self.assertEqual(run.call_count, 3)
            for call in run.call_args_list:
                self.assertEqual(sum(1 for a in call.args[0] if a.startswith("--property=")), 1)
        self.assertEqual(shown["activeState"], "active")
        self.assertIsNone(shown["nextElapse"])
        self.assertEqual(shown["nextElapseMonotonic"], "18446744073709551615")
        self.assertEqual(shown["values"]["NextElapseUSecRealtime"], "")

    def test_a_realtime_elapse_wins_when_both_are_present(self):
        with mock.patch.object(launch_funded_leg.subprocess, "run") as run:
            run.side_effect = self._run({
                "ActiveState": "active",
                "NextElapseUSecRealtime": "Sat 2026-11-14 06:44:27 UTC",
                "NextElapseUSecMonotonic": "18446744073709551615",
            })
            shown = launch_funded_leg.systemctl_show(
                "funded-leg-y", "ActiveState",
                "NextElapseUSecRealtime", "NextElapseUSecMonotonic",
            )
        self.assertEqual(shown["nextElapse"], "Sat 2026-11-14 06:44:27 UTC")


class DeadlineGuardRefusalTest(unittest.TestCase):
    """A real leg may not run with no layer that survives both guards.

    ADAAAA-9008: the 8998 leg had `arm.json: armed` and still metered past its
    clock because the only two guards were processes something killed together.
    So `--deadline-guard auto` on a real leg refuses (exit 8) when the timer
    cannot be committed, and stops the job it can name on the way out.
    """

    def _stub_harness(self, run_dir: str) -> str:
        stub = os.path.join(run_dir, "arming_harness.py")
        with open(stub, "w", encoding="utf-8") as fh:
            fh.write(
                "import argparse, json, os, time\n"
                "p = argparse.ArgumentParser()\n"
                "p.add_argument('--heartbeat-path')\n"
                "p.add_argument('--evidence-out')\n"
                "ns, _ = p.parse_known_args()\n"
                "now = time.time()\n"
                "json.dump({'phase': 'running', 'jobId': 'stub-job-9013',\n"
                "           'pid': os.getpid(), 'legSeconds': 0.0,\n"
                "           'beatAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now)),\n"
                "           'deadlineEpoch': now + 30, 'authorizedDurationS': 30,\n"
                "           'hardStopSlackS': 10.0, 'capUsd': 0.10},\n"
                "          open(ns.heartbeat_path, 'w'))\n"
                "print('[leg] arm pid=%d job=stub-job-9013' % os.getpid(), flush=True)\n"
                "time.sleep(20)\n"
            )
        return stub

    def test_a_leg_with_no_durable_guard_is_refused_and_stopped(self):
        _StopHandler.received = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), _StopHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as run_dir:
                stub = self._stub_harness(run_dir)
                unarmed = {
                    "kind": "failed",
                    "unit": "funded-leg-stub-9013-1",
                    "armed": False,
                    "durable": False,
                    "error": "systemd-run rc=1: Failed to connect to bus",
                }
                with mock.patch.object(
                    launch_funded_leg, "arm_deadline_guard", return_value=unarmed,
                ):
                    rc = launch_funded_leg.main([
                        "--run-dir", run_dir, "--harness", stub,
                        "--no-supervisor", "--quiet", "--arm-timeout-s", "15",
                        "--token", "dry-run-token",
                        "--job-base", f"http://127.0.0.1:{server.server_address[1]}",
                        "--authorized-duration-s", "30", "--cap-usd", "0.10",
                    ])
                self.assertEqual(rc, launch_funded_leg.EXIT_ARM_FAILED)
                arm = read_json(os.path.join(run_dir, "arm.json")) or {}
                self.assertEqual(arm["outcome"], "arm_failed")
                self.assertIn("no durable deadline guard", arm["reason"])
                self.assertEqual(arm["jobId"], "stub-job-9013")
                self.assertTrue(arm["stop"]["attempted"])
                self.assertTrue(arm["stop"]["ok"], arm["stop"])
                self.assertEqual(arm["stop"]["http"], 200)
                self.assertIn("/jobs/stub-job-9013/stop", _StopHandler.received)
                guard = read_json(os.path.join(run_dir, "deadline_guard.json")) or {}
                self.assertEqual(guard["kind"], "failed")
                self.assertFalse(guard["durable"])
                # Refused before a supervisor exists: no supervised leg at all.
                launch = read_json(os.path.join(run_dir, "launch.json")) or {}
                self.assertIsNone(launch.get("supervisor"))
                pid = (launch or {}).get("harnessPid")
                if pid and launch_funded_leg.pid_alive(pid):
                    os.kill(pid, signal.SIGKILL)
        finally:
            server.shutdown()
            server.server_close()


class SupervisorDeathTest(unittest.TestCase):
    """ADAAAA-9008: a killed supervisor must be visible and must still stop."""

    def test_sigterm_while_watching_is_recorded_and_stops_the_job(self):
        _StopHandler.received = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), _StopHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                beat_path = os.path.join(tmp, "heartbeat.json")
                verdict_path = os.path.join(tmp, "supervisor.json")
                funded_leg.write_json_atomic(beat_path, {
                    "phase": "running", "jobId": "stub-job-9011", "pid": 99,
                    "beatAt": _iso(datetime.now(timezone.utc)),
                    "legSeconds": 12.0,
                    "deadlineEpoch": time.time() + 600,
                    "deadlineAt": _iso(datetime.now(timezone.utc) + timedelta(seconds=600)),
                    "authorizedDurationS": 600, "capUsd": 1.45,
                    "hardStopSlackS": 10.0,
                })
                proc = subprocess.Popen(
                    [
                        sys.executable, SUPERVISOR,
                        "--heartbeat", beat_path, "--evidence-out", verdict_path,
                        # stale-s is huge on purpose: this is the killed-guard
                        # case, not the stale one.
                        "--stale-s", "3600", "--poll-s", "0.1",
                        "--arm-timeout-s", "10", "--watch-beat-s", "0.2",
                        "--job-base", f"http://127.0.0.1:{server.server_address[1]}",
                        "--token", "dry-run-token", "--quiet",
                    ],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                )
                try:
                    watching = wait_for(
                        lambda: (b if (b := read_json(verdict_path))
                                 and b.get("outcome") == "watching" else None),
                        20,
                    )
                    self.assertIsNotNone(watching, "no `watching` record was written")
                    self.assertEqual(watching["jobId"], "stub-job-9011")
                    self.assertEqual(watching["harnessPid"], 99)
                    self.assertIsNotNone(watching["deadlineAt"])

                    proc.send_signal(signal.SIGTERM)
                    rc = proc.wait(timeout=30)
                    self.assertEqual(rc, leg_supervisor.EXIT_KILLED)
                    death = read_json(verdict_path)
                    self.assertEqual(death["outcome"], "killed_while_watching")
                    self.assertEqual(death["signal"], "SIGTERM")
                    self.assertTrue(death["heartbeatLive"])
                    self.assertTrue(death["stop"]["attempted"])
                    self.assertTrue(death["stop"]["ok"])
                    self.assertIn("/jobs/stub-job-9011/stop", _StopHandler.received)
                    out = proc.stdout.read().decode() if proc.stdout else ""
                    self.assertIn("start pid=", out)
                    self.assertIn("SIGTERM while watching", out)
                finally:
                    if proc.poll() is None:
                        proc.kill()
                    proc.wait(timeout=20)
                    if proc.stdout is not None:
                        proc.stdout.close()
        finally:
            server.shutdown()
            server.server_close()

    def test_a_supervisor_killed_on_a_finished_leg_does_not_stop_it(self):
        """A torn-down supervisor must not amputate a leg that already ended."""
        _StopHandler.received = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), _StopHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                beat_path = os.path.join(tmp, "heartbeat.json")
                verdict_path = os.path.join(tmp, "supervisor.json")
                funded_leg.write_json_atomic(beat_path, {
                    "phase": "finished", "jobId": "stub-job-9012", "pid": 99,
                    "beatAt": _iso(datetime.now(timezone.utc)),
                    "status": "done",
                })
                proc = subprocess.Popen(
                    [
                        sys.executable, SUPERVISOR,
                        "--heartbeat", beat_path, "--evidence-out", verdict_path,
                        "--stale-s", "3600", "--poll-s", "0.1",
                        "--arm-timeout-s", "10", "--watch-beat-s", "0.2",
                        "--job-base", f"http://127.0.0.1:{server.server_address[1]}",
                        "--token", "dry-run-token", "--quiet",
                    ],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                )
                try:
                    rc = proc.wait(timeout=30)
                    self.assertEqual(rc, leg_supervisor.EXIT_OK)
                    self.assertEqual(read_json(verdict_path)["outcome"], "finished")
                    self.assertEqual(_StopHandler.received, [])
                finally:
                    if proc.poll() is None:
                        proc.kill()
                    proc.wait(timeout=20)
                    if proc.stdout is not None:
                        proc.stdout.close()
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()

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


if __name__ == "__main__":
    unittest.main()

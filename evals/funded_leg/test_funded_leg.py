"""ADAAAA-8489 harness tests. Stdlib only; dry-run stub, no box, no spend.

Run: python3 -m unittest discover -s evals/funded_leg -v
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import funded_leg  # noqa: E402


def run_harness(args):
    """Run main() in-process and return (exit code, evidence dict or None)."""
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "evidence.json")
        code = funded_leg.main(["--dry-run", "--quiet", "--evidence-out", out] + args)
        evidence = None
        if os.path.exists(out):
            with open(out, "r", encoding="utf-8") as fh:
                evidence = json.load(fh)
    return code, evidence


class CompareShapeTest(unittest.TestCase):
    def test_within(self):
        shape = funded_leg.compare_shape(300, 0.65, 299.4, 0.4821)
        self.assertEqual(shape["verdict"], "WITHIN")
        self.assertEqual(shape["durationOvershootS"], 0.0)
        self.assertEqual(shape["costOvershootUsd"], 0.0)
        self.assertIn("AUTHORIZED-VS-ACTUAL", shape["line"])
        self.assertIn("300.0 s", shape["line"])
        self.assertIn("$0.6500", shape["line"])

    def test_over(self):
        shape = funded_leg.compare_shape(300, 0.5, 544.5, 0.6197)
        self.assertEqual(shape["verdict"], "OVER")
        self.assertAlmostEqual(shape["durationOvershootS"], 244.5)
        self.assertAlmostEqual(shape["costOvershootUsd"], 0.1197)
        self.assertIn("over by", shape["line"])
        self.assertIn("OVER", shape["line"])

    def test_table_names_both_sides(self):
        shape = funded_leg.compare_shape(60, 0.1, 60.4, 0.05)
        self.assertIn("| shape | authorized | actual | delta |", shape["table"])
        self.assertIn("<= 60.0 s", shape["table"])
        self.assertIn("<= $0.1000", shape["table"])


class GateClosedTest(unittest.TestCase):
    def test_busy_gate_refuses_before_any_metered_call(self):
        code, evidence = run_harness(
            [
                "--stub-scenario", "busy",
                "--authorized-duration-s", "60",
                "--cap-usd", "0.65",
                "--quiet-window-min", "0.2",
                "--poll-s", "0.2",
                "--settle-timeout-s", "1",
            ]
        )
        self.assertEqual(code, 3)
        self.assertEqual(evidence["preflight"]["verdict"], "closed")
        self.assertEqual(evidence["result"]["outcome"], "refused_gate_closed")
        self.assertEqual(
            evidence["meteredCalls"],
            {"jobCreates": 0, "sessionCreates": 0, "driverStarts": 0},
        )
        stub = evidence["stub"]
        self.assertEqual(stub["meteredJobCreates"], 0)
        self.assertEqual(stub["meteredSessionCreates"], 0)
        self.assertIsNone(stub["job"])
        # The refusal names the offending readings, not just "busy".
        reason = evidence["preflight"]["reason"]
        self.assertIn("nonterminal jobs = 1", reason)
        self.assertIn("activeSessions = 1", reason)
        self.assertIn("session=cyc-", reason)

    def test_unreadable_probe_is_not_quiet(self):
        sample = funded_leg.GateSample(
            at="t",
            nonterminal_jobs=None,
            active_sessions=0,
            leases={"active": 0, "total": 0},
            cyc_by_container={"decide-gpu0": 0},
            errors=["jobs: psql failed"],
        )
        self.assertIn("jobs probe failed", sample.problems())


class HardStopTest(unittest.TestCase):
    def test_stop_fires_at_authorized_shape_with_stop_moment_never_reached(self):
        # The stub job never terminates on its own: its edge advances forever and
        # only the harness's wall clock can end it (the ADAAAA-8483 failure mode).
        code, evidence = run_harness(
            [
                "--stub-scenario", "clean",
                "--authorized-duration-s", "2",
                "--cap-usd", "0.65",
                "--quiet-window-min", "0.08",
                "--hard-stop-slack-s", "2",
                "--poll-s", "0.2",
                "--settle-timeout-s", "3",
            ]
        )
        self.assertEqual(code, 0)
        leg = evidence["leg"]
        self.assertEqual(leg["stopReason"], "authorized_duration")
        self.assertTrue(leg["stopConfirmed"])
        self.assertEqual(leg["settledStatus"], "cancelled")
        self.assertGreaterEqual(evidence["stub"]["stopCalls"], 1)
        # <= authorized + the 10 s rule; here the stub answers instantly.
        self.assertGreaterEqual(leg["durationS"], 2.0)
        self.assertLessEqual(leg["durationS"], 2.0 + 2.0)
        self.assertEqual(evidence["shape"]["verdict"], "WITHIN")

    def test_unconfirmed_stop_exits_nonzero(self):
        code, evidence = run_harness(
            [
                "--stub-scenario", "stop-stuck",
                "--authorized-duration-s", "1",
                "--cap-usd", "0.65",
                "--quiet-window-min", "0.08",
                "--hard-stop-slack-s", "1",
                "--poll-s", "0.2",
                "--settle-timeout-s", "0.5",
            ]
        )
        self.assertEqual(code, 4)
        self.assertEqual(evidence["result"]["outcome"], "stop_unconfirmed")
        self.assertFalse(evidence["leg"]["stopConfirmed"])

    def test_cost_ceiling_stops_a_leg_that_would_run_longer(self):
        code, evidence = run_harness(
            [
                "--stub-scenario", "clean",
                "--authorized-duration-s", "60",
                "--cap-usd", "0.65",
                "--abort-at-usd", "0.002",
                "--quiet-window-min", "0.08",
                "--poll-s", "0.2",
                "--settle-timeout-s", "3",
            ]
        )
        self.assertEqual(code, 0)
        self.assertEqual(evidence["leg"]["stopReason"], "cost_cap")
        self.assertLess(evidence["leg"]["durationS"], 10.0)
        self.assertLess(evidence["leg"]["costUsd"], 0.65)

class MeteredProjectionTest(unittest.TestCase):
    """ADAAAA-8516 A1: the stop bounds metered time, not only wall clock."""

    def test_projection_stops_before_the_wall_clock(self):
        code, evidence = run_harness(
            [
                "--stub-scenario", "clean",
                "--authorized-duration-s", "30",
                "--cap-usd", "0.65",
                "--abort-at-usd", "0.05",
                # 10x the cap record's rate: the projection, not the clock or the
                # stub's own cost field, has to end this leg.
                "--metered-usd-per-s", "0.01",
                "--quiet-window-min", "0.08",
                "--poll-s", "0.2",
                "--settle-timeout-s", "3",
            ]
        )
        self.assertEqual(code, 0)
        leg = evidence["leg"]
        self.assertEqual(leg["stopReason"], "metered_projection_cap")
        self.assertLess(leg["durationS"], 30.0)
        self.assertGreaterEqual(leg["meteredProjectionS"], 4.9)
        self.assertLess(leg["meteredProjectedUsd"], 0.65)
        self.assertEqual(evidence["authorized"]["meteredUsdPerS"], 0.01)

    def test_evidence_carries_the_metered_wall_ratio(self):
        code, evidence = run_harness(
            [
                "--stub-scenario", "clean",
                "--authorized-duration-s", "2",
                "--cap-usd", "0.65",
                "--quiet-window-min", "0.05",
                "--poll-s", "0.2",
                "--settle-timeout-s", "3",
            ]
        )
        self.assertEqual(code, 0)
        leg = evidence["leg"]
        self.assertIn("meteredProjectionS", leg)
        self.assertIn("perceiveSessionS", leg)
        self.assertIn("costUsd", leg)
        self.assertIsNotNone(leg["meteredWallRatio"])

    def test_default_abort_matches_the_cap_record(self):
        # ADAAAA-8515: a $0.65 cap aborts at $0.60 projected, not 5 % off ($0.6175).
        code, evidence = run_harness(
            [
                "--stub-scenario", "clean",
                "--authorized-duration-s", "1",
                "--cap-usd", "0.65",
                "--quiet-window-min", "0.05",
                "--poll-s", "0.2",
                "--settle-timeout-s", "3",
            ]
        )
        self.assertEqual(code, 0)
        self.assertAlmostEqual(evidence["authorized"]["abortAtUsd"], 0.60, places=4)

    def test_missing_projection_rate_refuses_the_leg(self):
        # A1: neither a live meter nor a session-time projection = not authorized.
        code, evidence = run_harness(
            [
                "--stub-scenario", "clean",
                "--authorized-duration-s", "1",
                "--cap-usd", "0.65",
                "--metered-usd-per-s", "0",
            ]
        )
        self.assertEqual(code, 5)
        self.assertIsNone(evidence)


class LegShapeTest(unittest.TestCase):
    def test_slack_above_ten_seconds_is_refused(self):
        code, evidence = run_harness(
            [
                "--authorized-duration-s", "1",
                "--cap-usd", "0.65",
                "--quiet-window-min", "0.08",
                "--hard-stop-slack-s", "11",
            ]
        )
        self.assertEqual(code, 5)


class PreflightWindowTest(unittest.TestCase):
    def test_quiet_window_is_sampled_end_to_end(self):
        code, evidence = run_harness(
            [
                "--authorized-duration-s", "1",
                "--cap-usd", "0.65",
                "--quiet-window-min", "0.08",
                "--poll-s", "0.2",
                "--settle-timeout-s", "2",
            ]
        )
        self.assertEqual(code, 0)
        self.assertEqual(evidence["preflight"]["verdict"], "open")
        self.assertGreaterEqual(len(evidence["preflight"]["samples"]), 2)
        for sample in evidence["preflight"]["samples"]:
            self.assertEqual(sample["problems"], [])
        # Every probe the gate used is recorded, so the proof is auditable.
        self.assertTrue(any("from jobs" in c for c in evidence["probeCommands"]))


class PreflightOnlyTest(unittest.TestCase):
    def test_preflight_only_opens_without_a_leg(self):
        code, evidence = run_harness(
            [
                "--preflight-only",
                "--authorized-duration-s", "300",
                "--cap-usd", "0.65",
                "--quiet-window-min", "0.08",
            ]
        )
        self.assertEqual(code, 0)
        self.assertEqual(evidence["result"]["outcome"], "preflight_open_only")
        self.assertEqual(evidence["meteredCalls"]["jobCreates"], 0)
        self.assertIsNone(evidence["stub"]["job"])


class CycProbeTest(unittest.TestCase):
    def test_counts_parse(self):
        out = "decide-gpu0:0\ndecide-gpu1:3\ndecide-gpu2:-1\n"
        self.assertEqual(
            funded_leg.parse_cyc_output(out),
            {"decide-gpu0": 0, "decide-gpu1": 3, "decide-gpu2": None},
        )

    def test_missing_container_is_a_failed_probe_not_zero(self):
        self.assertIsNone(funded_leg.parse_cyc_output("decide-gpu0:-1")["decide-gpu0"])

    def test_no_output_with_failure_is_empty(self):
        self.assertEqual(funded_leg.parse_cyc_output("", 1), {})

    def test_default_pattern_covers_the_cyc_clause(self):
        # session=cyc- ids are a subset of session= ids, so a zero count on the
        # superset proves the clause; the marker today is session=<jobId>.
        self.assertIn("session=", funded_leg.DEFAULT_CYC_PATTERN)
        self.assertIn("session=cyc-", "session=cyc-1234-abcd")


if __name__ == "__main__":
    unittest.main()

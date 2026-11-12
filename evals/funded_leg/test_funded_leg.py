"""ADAAAA-8489 harness tests. Stdlib only; dry-run stub, no box, no spend.

Run: python3 -m unittest discover -s evals/funded_leg -v
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from typing import Any
from unittest import mock

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

    def test_metered_seconds_and_ratio_are_in_the_block(self):
        shape = funded_leg.compare_shape(
            300, 0.65, 300.0, 0.6197,
            metered_session_s=544.5, metered_rate_usd_per_s=0.0011381,
            gpu_hours=0.373, abort_source="authorized_duration",
        )
        self.assertAlmostEqual(shape["meteredWallRatio"], 1.815)
        self.assertIn("perceiveSessionS 544.5 s", shape["line"])
        self.assertIn("1.815x wall", shape["line"])
        self.assertIn("| perceiveSessionS |", shape["table"])
        self.assertIn("| GPU-hours |", shape["table"])
        self.assertIn("authorized_duration", shape["table"])
        self.assertAlmostEqual(shape["projectedCostUsd"], 544.5 * 0.0011381, places=4)

    def test_metered_projection_row_flags_over_cap(self):
        shape = funded_leg.compare_shape(
            300, 0.65, 300.0, 0.6197,
            metered_session_s=908, metered_rate_usd_per_s=0.0011381,
        )
        # 908 s x 0.0011381 = $1.033 — the A1 inflation case.
        self.assertGreater(shape["projectedCostUsd"], 0.65)

    def test_projected_over_cap_is_over_even_when_costusd_reads_zero(self):
        # A1 item 4: when the projection is the cost source, grading the live
        # $0.00 as "actual" would publish an over-cap leg as WITHIN.
        shape = funded_leg.compare_shape(
            480, 0.65, 11.0, 0.0,
            metered_session_s=580.0, metered_rate_usd_per_s=0.0011381,
            abort_source="projected_cost",
        )
        self.assertAlmostEqual(shape["projectedCostUsd"], 0.6601, places=4)
        self.assertEqual(shape["verdict"], "OVER")
        self.assertAlmostEqual(shape["costOvershootUsd"], 0.0101, places=4)
        self.assertAlmostEqual(shape["gradedCostUsd"], shape["projectedCostUsd"])
        self.assertIn("OVER", shape["line"])
        self.assertIn("| live costUsd |", shape["table"])

    def test_default_abort_point_holds_the_ceo_margin(self):
        # 8515 A1: $0.65 cap -> abort at $0.60 -> 527 s at the authorized rate,
        # 44 s short of the 571 s the cap itself would meter.
        self.assertAlmostEqual(funded_leg.default_abort_at_usd(0.65), 0.60)
        self.assertAlmostEqual(funded_leg.default_abort_at_usd(2.00), 1.95)
        self.assertAlmostEqual(funded_leg.default_abort_at_usd(0.03), 0.027)
        rate = 0.0011381
        self.assertAlmostEqual(0.65 / rate, 571.1, places=1)
        self.assertAlmostEqual(0.60 / rate, 527.2, places=1)


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
        self.assertEqual(evidence["leg"]["stopReason"], "live_cost")
        self.assertEqual(evidence["leg"]["costSource"], "live_cost")
        self.assertLess(evidence["leg"]["durationS"], 10.0)
        self.assertLess(evidence["leg"]["costUsd"], 0.65)

    def test_projected_cost_stops_when_the_billed_figure_is_not_readable(self):
        # CEO A1: if costUsd stays 0 mid-leg, metered seconds x the authorized
        # $/s is the guard. 0.002 / 0.0011381 = 1.76 s of metered time.
        code, evidence = run_harness(
            [
                "--stub-scenario", "clean-no-cost",
                "--authorized-duration-s", "60",
                "--cap-usd", "0.65",
                "--abort-at-usd", "0.002",
                "--quiet-window-min", "0.08",
                "--poll-s", "0.2",
                "--settle-timeout-s", "3",
            ]
        )
        self.assertEqual(code, 0)
        self.assertEqual(evidence["leg"]["stopReason"], "projected_cost")
        self.assertEqual(evidence["leg"]["costSource"], "projected_cost")
        self.assertLess(evidence["leg"]["durationS"], 10.0)
        self.assertGreater(evidence["leg"]["perceiveSessionS"], 0)
        self.assertAlmostEqual(evidence["shape"]["meteredWallRatio"], 1.0, places=1)

    def test_default_abort_point_is_sixty_cents_on_the_065_cap(self):
        # No --abort-at-usd: the 8515 A1 guard point must be $0.60, and the
        # evidence must say what that is in metered seconds (527 s) versus the
        # cap itself (571 s). Rate compressed so the crossing is quick; the
        # comparison is the same max(live, metered x rate) >= abort check.
        code, evidence = run_harness(
            [
                "--stub-scenario", "clean-no-cost",
                "--authorized-duration-s", "60",
                "--cap-usd", "0.65",
                "--billing-basis", "perceive",
                "--metered-rate-usd-per-s", "0.2",
                "--quiet-window-min", "0.08",
                "--poll-s", "0.05",
                "--settle-timeout-s", "3",
            ]
        )
        self.assertEqual(code, 0)
        self.assertEqual(evidence["authorized"]["abortAtUsd"], 0.60)
        self.assertEqual(evidence["authorized"]["abortMarginUsd"], 0.05)
        self.assertEqual(evidence["authorized"]["abortAtMeteredS"], 3.0)
        self.assertEqual(evidence["authorized"]["capMeteredS"], 3.25)
        self.assertEqual(evidence["leg"]["stopReason"], "projected_cost")
        self.assertEqual(evidence["shape"]["verdict"], "WITHIN")

    def test_an_abort_point_at_or_above_the_cap_is_refused(self):
        code, evidence = run_harness(
            [
                "--authorized-duration-s", "60",
                "--cap-usd", "0.65",
                "--abort-at-usd", "0.65",
                "--quiet-window-min", "0.08",
            ]
        )
        self.assertEqual(code, 5)
        self.assertIsNone(evidence)

    def test_a_dark_record_is_guarded_by_the_metered_clock(self):
        # ADAAAA-8529 item 1: on the live rail the record discloses neither
        # costUsd nor perceiveSessionS until settlement (leg 7d99d651 read 0.0/0.0
        # for all 480 s). Master's guard read only the record, so it had nothing
        # to abort on; the meter's clock is readable from job create.
        code, evidence = run_harness(
            [
                "--stub-scenario", "no-cost-source",
                "--authorized-duration-s", "60",
                "--cap-usd", "0.65",
                "--abort-at-usd", "0.002",
                "--quiet-window-min", "0.08",
                "--poll-s", "0.2",
                "--settle-timeout-s", "2",
            ]
        )
        self.assertEqual(code, 0)
        leg = evidence["leg"]
        self.assertEqual(leg["stopReason"], "projected_cost")
        self.assertEqual(leg["costSource"], "projected_cost")
        self.assertEqual(leg["recordCostSource"], "dark")
        self.assertGreater(leg["meteredProjectionS"], 0.0)
        # 0.002 / 0.0011381 = 1.76 s of metered time, so the stop is early.
        self.assertLess(leg["durationS"], 10.0)
        shape = evidence["shape"]
        self.assertEqual(shape["projectedFrom"], "clock")
        self.assertGreater(shape["gradedCostUsd"], 0.0)
        self.assertIn("from clock", shape["line"])
        self.assertIn("| mid-leg metered clock |", shape["table"])

    def test_a_leg_with_no_metered_rate_is_refused(self):
        # With no rate there is no projection, and a wall-clock stop alone cannot
        # hold a metered cap (8483 metered 544.5 s inside a 300 s window). The
        # refusal is basis-specific: the perceive basis needs its rate, the
        # decide basis needs its fee/cadence (ADAAAA-8832).
        code, evidence = run_harness(
            [
                "--authorized-duration-s", "60",
                "--cap-usd", "0.65",
                "--billing-basis", "perceive",
                "--metered-rate-usd-per-s", "0",
                "--quiet-window-min", "0.08",
            ]
        )
        self.assertEqual(code, 5)
        self.assertIsNone(evidence)

    def test_a_decide_billed_leg_with_no_fee_is_refused(self):
        code, evidence = run_harness(
            [
                "--authorized-duration-s", "60",
                "--cap-usd", "0.65",
                "--billing-basis", "decide",
                "--decide-fee-usd", "0",
                "--quiet-window-min", "0.08",
            ]
        )
        self.assertEqual(code, 5)
        self.assertIsNone(evidence)

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


def make_config(**overrides):
    """A Config with every required field set; tests override only what they use."""
    kwargs: Any = dict(
        authorized_duration_s=480.0,
        cap_usd=0.65,
        quiet_window_s=600.0,
        hard_stop_slack_s=10.0,
        abort_at_usd=0.60,
        poll_s=1.0,
        settle_timeout_s=60.0,
        job_base="http://127.0.0.1:3000",
        media_base="http://127.0.0.1:4070",
        job_source="browser",
        game_hint="soccer",
        sample_fps=3.0,
        video_path=None,
        pool_containers=funded_leg.DEFAULT_POOL_CONTAINERS,
        driver_cmd=None,
        token="t",
        user_id=None,
        email=None,
        mint_token_container="highlights-server",
        metered_rate_usd_per_s=0.0011381,
        gpu_hours=None,
        repo_root=".",
    )
    kwargs.update(overrides)
    return funded_leg.Config(**kwargs)


class FakeShellRunner:
    """Answers `shell()` from a needle -> (rc, stdout) table. No box, no shell."""

    def __init__(self, rules, default=(1, "")):
        self.rules = rules
        self.default = default
        self.commands = []

    def shell(self, command, timeout=120.0):
        self.commands.append(command)
        for needle, (rc, stdout) in self.rules.items():
            if needle in command:
                return subprocess.CompletedProcess(
                    args=command, returncode=rc, stdout=stdout, stderr=""
                )
        rc, stdout = self.default
        return subprocess.CompletedProcess(args=command, returncode=rc, stdout=stdout, stderr="")


class BuildIdentityTest(unittest.TestCase):
    """ADAAAA-8529 item 2: the leg is refused on an unnamed build."""

    SHA = "b20e6b9c0ffee1234567890abcdef1234567890"

    def runner(self, served_md5="a" * 32, git_md5="a" * 32):
        rules = {}
        for path in funded_leg.DEFAULT_BUILD_FILES:
            rules[f"md5sum /app/{path}"] = (0, f"{served_md5}  /app/{path}\n")
            rules[f"show {self.SHA}:{path}"] = (0, f"{git_md5}  -\n")
        return FakeShellRunner(rules)

    def test_verified_when_every_pair_matches(self):
        block = funded_leg.verify_build(
            self.runner(), make_config(build_sha=self.SHA)
        )
        self.assertEqual(block["verdict"], "verified")
        self.assertEqual(block["matched"], len(funded_leg.DEFAULT_BUILD_FILES))
        self.assertEqual(block["sha"], self.SHA)
        self.assertEqual(block["mismatched"], [])
        for entry in block["files"]:
            self.assertEqual(entry["servedMd5"], entry["gitMd5"])
            self.assertTrue(entry["match"])
        self.assertIn("BUILD-IDENTITY", block["line"])
        self.assertIn("verified", block["line"])

    def test_mismatch_names_the_differing_file(self):
        block = funded_leg.verify_build(
            self.runner(served_md5="b" * 32, git_md5="a" * 32),
            make_config(build_sha=self.SHA),
        )
        self.assertEqual(block["verdict"], "mismatch")
        self.assertEqual(block["matched"], 0)
        self.assertEqual(len(block["mismatched"]), len(funded_leg.DEFAULT_BUILD_FILES))
        self.assertIn("differing:", block["line"])

    def test_one_differing_file_is_enough_to_refuse(self):
        rules = {}
        for path in funded_leg.DEFAULT_BUILD_FILES:
            served = "b" * 32 if path.endswith("index.ts") else "a" * 32
            rules[f"md5sum /app/{path}"] = (0, f"{served}  /app/{path}\n")
            rules[f"show {self.SHA}:{path}"] = (0, f"{'a' * 32}  -\n")
        block = funded_leg.verify_build(
            FakeShellRunner(rules), make_config(build_sha=self.SHA)
        )
        self.assertEqual(block["verdict"], "mismatch")
        self.assertEqual(block["mismatched"], ["packages/events/src/index.ts"])

    def test_unreadable_probe_is_not_verified(self):
        block = funded_leg.verify_build(
            FakeShellRunner({}, default=(1, "")), make_config(build_sha=self.SHA)
        )
        self.assertEqual(block["verdict"], "unreadable")
        self.assertNotEqual(block["verdict"], "verified")

    def test_unresolved_sha_is_unreadable(self):
        block = funded_leg.verify_build(
            FakeShellRunner({}, default=(1, "")), make_config(build_sha="")
        )
        self.assertIsNone(block["sha"])
        self.assertEqual(block["verdict"], "unreadable")

    def test_sha_is_read_from_the_checkout_when_not_given(self):
        rules = {"rev-parse HEAD": (0, f"{self.SHA}\n")}
        for path in funded_leg.DEFAULT_BUILD_FILES:
            rules[f"md5sum /app/{path}"] = (0, f"{'a' * 32}  /app/{path}\n")
            rules[f"show {self.SHA}:{path}"] = (0, f"{'a' * 32}  -\n")
        block = funded_leg.verify_build(FakeShellRunner(rules), make_config())
        self.assertEqual(block["sha"], self.SHA)
        self.assertEqual(block["verdict"], "verified")

    def test_dry_run_evidence_marks_the_build_probe_skipped(self):
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
        self.assertEqual(evidence["build"]["verdict"], "skipped")
        self.assertIn("dry-run", evidence["build"]["line"])
        self.assertEqual(evidence["decideConfig"]["verdict"], "skipped")
        self.assertIn("dry-run", evidence["decideConfig"]["line"])


class DecideConfigTest(unittest.TestCase):
    """ADAAAA-8529 item 2 (ruling on ADAAAA-8528): record the decide config.

    The build sha names the tree; it does not name the decide pool, the model the
    workers serve, or the live window keep-ratio, because those live in the
    server's environment. `decideE2e` is the dominant p50 stage, so a leg graded
    across ADAAAA-8525's window change without them is a grade of an unknown
    artifact.
    """

    VALUES = {
        "DECIDE_URL": "http://decide-router:8081",
        "GEMMA_MODEL": "cyankiwi/gemma-4-12B-it-qat-AWQ-INT4",
        "LIVE_DECIDE_KEEP_RATIO": "0.35",
        "LIVE_OBSERVE_MAX_FRAMES": "8",
        "LIVE_OBSERVE_CADENCE_S": "5",
    }

    def runner(self, values=None, rc=0):
        values = self.VALUES if values is None else values
        stdout = "".join(f"{k}={v}\n" for k, v in values.items())
        return FakeShellRunner({"printenv": (rc, stdout)}, default=(rc, stdout))

    def probe(self, values=None, rc=0):
        return funded_leg.probe_decide_config(self.runner(values, rc), make_config())

    def test_records_pool_model_and_window_keep_ratio(self):
        block = funded_leg.decide_config_block(self.probe(), make_config())
        self.assertEqual(block["verdict"], "recorded")
        self.assertEqual(block["values"]["DECIDE_URL"], "http://decide-router:8081")
        self.assertEqual(
            block["values"]["GEMMA_MODEL"], "cyankiwi/gemma-4-12B-it-qat-AWQ-INT4"
        )
        self.assertEqual(block["values"]["LIVE_DECIDE_KEEP_RATIO"], "0.35")
        self.assertIn("pool http://decide-router:8081", block["line"])
        self.assertIn("model cyankiwi/gemma-4-12B-it-qat-AWQ-INT4", block["line"])
        self.assertIn("window keep-ratio 0.35 (LIVE_DECIDE_KEEP_RATIO)", block["line"])
        # ADAAAA-8832: the cadence is what the projection is priced at, so a leg
        # that names the build must name the cadence too.
        self.assertEqual(block["values"]["LIVE_OBSERVE_CADENCE_S"], "5")
        self.assertIn("LIVE_OBSERVE_CADENCE_S", funded_leg.DEFAULT_DECIDE_CONFIG_KEYS)

    def test_an_unset_key_is_recorded_as_the_code_default_not_a_hole(self):
        # LIVE_DECIDE_KEEP_RATIO unset is a real posture: config.ts leaves it
        # undefined and observe-loop applies its own default.
        values = dict(self.VALUES)
        values["LIVE_DECIDE_KEEP_RATIO"] = ""
        block = funded_leg.decide_config_block(self.probe(values), make_config())
        self.assertEqual(block["verdict"], "recorded")
        self.assertIsNone(block["values"]["LIVE_DECIDE_KEEP_RATIO"])
        self.assertIn("unset (LIVE_DECIDE_KEEP_RATIO", block["line"])
        self.assertIn("code default in force", block["line"])

    def test_a_failed_probe_is_unreadable_and_refuses_the_leg(self):
        block = funded_leg.decide_config_block(self.probe(rc=1), make_config())
        self.assertEqual(block["verdict"], "unreadable")
        self.assertIn("DECIDE-CONFIG: unreadable", block["line"])
        self.assertIn("failed: rc=1", block["line"])

    def test_a_key_the_probe_did_not_answer_is_unreadable(self):
        values = {k: v for k, v in self.VALUES.items() if k != "GEMMA_MODEL"}
        block = funded_leg.decide_config_block(self.probe(values), make_config())
        self.assertEqual(block["verdict"], "unreadable")
        self.assertEqual(block["missing"], ["GEMMA_MODEL"])

    def test_the_probe_reads_one_sh_loop_not_n_printenv_calls(self):
        # `printenv KEY` exits 1 on an unset key, which would make a real default
        # look like a probe failure; the loop always exits 0.
        runner = self.runner()
        funded_leg.probe_decide_config(runner, make_config())
        self.assertEqual(len(runner.commands), 1)
        self.assertIn("for k in", runner.commands[0])
        self.assertIn("DECIDE_URL", runner.commands[0])
        self.assertIn("docker exec highlights-server", runner.commands[0])

    def test_every_key_defaults_are_the_ones_the_ruling_names(self):
        self.assertIn("DECIDE_URL", funded_leg.DEFAULT_DECIDE_CONFIG_KEYS)
        self.assertIn("GEMMA_MODEL", funded_leg.DEFAULT_DECIDE_CONFIG_KEYS)
        self.assertIn("LIVE_DECIDE_KEEP_RATIO", funded_leg.DEFAULT_DECIDE_CONFIG_KEYS)

    def test_an_unrecorded_decide_config_refuses_the_leg(self):
        # The gate is one decision for both halves of the artifact: a verified
        # build with an unreadable decide config still refuses (exit 6).
        verified = {"verdict": "verified", "line": "BUILD-IDENTITY: verified"}
        unreadable = funded_leg.decide_config_block(self.probe(rc=1), make_config())
        refusal = funded_leg.artifact_refusal(verified, unreadable)
        self.assertIsNotNone(refusal)
        assert refusal is not None
        self.assertEqual(refusal["exitCode"], 6)
        self.assertEqual(refusal["outcome"], "decide_config_unreadable")
        self.assertIn("pool/model/keep-ratio", refusal["message"])

        recorded = funded_leg.decide_config_block(self.probe(), make_config())
        self.assertIsNone(funded_leg.artifact_refusal(verified, recorded))

    def test_a_mismatched_build_is_named_as_the_refusal_reason(self):
        mismatched = {"verdict": "mismatch", "line": "BUILD-IDENTITY: mismatch"}
        recorded = {"verdict": "recorded", "line": "DECIDE-CONFIG: recorded"}
        refusal = funded_leg.artifact_refusal(mismatched, recorded)
        self.assertIsNotNone(refusal)
        assert refusal is not None
        self.assertEqual(refusal["outcome"], "build_unverified")
        self.assertEqual(refusal["exitCode"], 6)


class PreflightAllQuietTest(unittest.TestCase):
    """ADAAAA-8529 item 4: the harness's own quiet verdict is the evidence."""

    def test_open_window_is_all_quiet(self):
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
        pre = evidence["preflight"]
        self.assertEqual(pre["verdict"], "open")
        self.assertTrue(pre["allQuiet"])
        self.assertEqual(pre["quietSamples"], pre["sampleCount"])
        self.assertEqual(pre["notQuietSamples"], 0)

    def test_closed_window_is_not_all_quiet(self):
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
        pre = evidence["preflight"]
        self.assertEqual(pre["verdict"], "closed")
        self.assertFalse(pre["allQuiet"])
        self.assertEqual(pre["notQuietSamples"], 1)
        self.assertIn("nonterminal jobs = 1", pre["reason"])



class ClipsEvidenceTest(unittest.TestCase):
    """ADAAAA-8529 item 5: at 0 clips, item 2 is met by the stage fields, stated."""

    ROWS = [
        {"triggerTs": 104.6, "deliveredLatencyMs": 4228, "fireLagMs": 444,
         "decideE2eMs": 3774, "acceptWaitMs": 0, "acceptMs": 10, "persistAckMs": 0},
        {"triggerTs": 200.0, "deliveredLatencyMs": 4112, "fireLagMs": 300,
         "decideE2eMs": 3810, "acceptWaitMs": 0, "acceptMs": 2, "persistAckMs": 0},
    ]

    def test_zero_clips_names_the_stage_fields(self):
        block = funded_leg.clips_block(
            {"status": "ok", "files": []}, self.ROWS, make_config(), "job-1"
        )
        self.assertEqual(block["produced"], 0)
        self.assertEqual(block["item2Source"], "stage_fields")
        self.assertTrue(block["item2Met"])
        self.assertEqual(block["stageFields"]["rows"], 2)
        self.assertEqual(block["stageFields"]["rowsWithZeroPersistAck"], 2)
        self.assertIn("job-1-*.mp4", block["reason"])
        self.assertIn("met by the stage fields only", block["note"])
        self.assertIn("persistAckMs", block["note"])

    def test_clip_files_are_the_item_2_source_when_present(self):
        block = funded_leg.clips_block(
            {"status": "ok", "files": [{"path": "/data/clips/job-1-1046.mp4", "bytes": 512}]},
            self.ROWS,
            make_config(),
            "job-1",
        )
        self.assertEqual(block["produced"], 1)
        self.assertEqual(block["item2Source"], "clip_files")
        self.assertTrue(block["item2Met"])
        self.assertNotIn("note", block)

    def test_no_rows_and_no_clips_is_unmeasured_not_pass(self):
        block = funded_leg.clips_block({"status": "ok", "files": []}, [], make_config(), "job-1")
        self.assertEqual(block["item2Source"], "stage_fields")
        self.assertFalse(block["item2Met"])
        self.assertIn("UNMEASURED", block["note"])

    def test_failed_probe_is_reported_not_treated_as_zero(self):
        block = funded_leg.clips_block(
            {"status": "failed: rc=1 no such container", "files": []},
            self.ROWS,
            make_config(),
            "job-1",
        )
        self.assertEqual(block["probe"], "failed: rc=1 no such container")
        self.assertEqual(block["produced"], 0)


class Leg8516ReplayTest(unittest.TestCase):
    """$0 replay of the ADAAAA-8516 leg evidence that opened this ticket.

    Every assertion is a field of the attached leg, not a new measurement:
    fixtures/leg8516-evidence.json is the trimmed harness-evidence + bundle of
    job 7d99d651.
    """

    FIXTURE = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "fixtures", "leg8516-evidence.json"
    )

    @classmethod
    def setUpClass(cls):
        with open(cls.FIXTURE, "r", encoding="utf-8") as fh:
            cls.leg = json.load(fh)

    def test_item_4_the_window_is_all_quiet_although_the_bundle_said_false(self):
        samples = [
            funded_leg.GateSample(
                at=s["at"],
                nonterminal_jobs=s.get("nonterminalJobs"),
                active_sessions=s.get("activeSessions"),
                leases=s.get("leases") or {},
                cyc_by_container=s.get("cycByContainer") or {},
                server_health=s.get("serverHealth"),
                errors=[],
            )
            for s in self.leg["preflight"]["samples"]
        ]
        block = funded_leg.preflight_block(
            samples, self.leg["preflight"]["quietWindowS"], "open"
        )
        # The bundle derived `allQuiet: false` for this window (item 4).
        self.assertEqual(len(samples), 19)
        self.assertEqual(block["verdict"], "open")
        self.assertTrue(block["allQuiet"])
        self.assertEqual(block["quietSamples"], 19)
        self.assertEqual(block["windowFrom"], "2026-11-09T22:17:54Z")
        self.assertEqual(block["windowTo"], "2026-11-09T22:27:41Z")

    def test_item_5_the_leg_produced_no_clips_and_says_so(self):
        self.assertEqual(self.leg["clips"]["produced"], 0)
        block = funded_leg.clips_block(
            {"status": "ok", "files": []},
            self.leg["deliveredRows"],
            make_config(),
            self.leg["jobId"],
        )
        self.assertEqual(block["produced"], 0)
        self.assertEqual(block["item2Source"], "stage_fields")
        self.assertTrue(block["item2Met"])
        # 6/6 delivered rows carry persistAckMs, all of them 0: the 8495 fix.
        self.assertEqual(block["stageFields"]["rows"], 6)
        self.assertEqual(block["stageFields"]["rowsWithZeroPersistAck"], 6)
        self.assertEqual(block["stageFields"]["persistAckMsMax"], 0)
        self.assertEqual(block["stageFields"]["deliveredLatencyMaxMs"], 4228)

    def test_item_1_the_shape_now_carries_the_projection_it_was_graded_on(self):
        # What the leg published: `actualCostUsd 0.0`, "cost headroom $0.6500",
        # on a leg that metered $0.55-0.58 — the projection existed in `leg`
        # (506.88 s) but never reached the shape.
        self.assertIn("actual 480.0 s / $0.0000", self.leg["shape"]["line"])
        self.assertIn("headroom $0.6500", self.leg["shape"]["line"])
        self.assertAlmostEqual(self.leg["leg"]["meteredProjectionS"], 506.88, places=2)
        self.assertAlmostEqual(self.leg["settled"]["costUsd"], 0.3577, places=4)

        shape = funded_leg.compare_shape(
            480.0,
            0.65,
            480.0,
            self.leg["leg"]["costUsd"],
            metered_session_s=self.leg["settled"]["perceiveSessionS"],
            metered_rate_usd_per_s=self.leg["leg"]["meteredUsdPerS"],
            metered_projection_s=self.leg["leg"]["meteredProjectionS"],
            abort_source=self.leg["leg"]["stopReason"],
        )
        self.assertEqual(shape["projectedFrom"], "clock")
        self.assertAlmostEqual(shape["projectedCostUsd"], 0.5769, places=4)
        self.assertAlmostEqual(shape["gradedCostUsd"], 0.5769, places=4)
        self.assertEqual(shape["verdict"], "WITHIN")
        self.assertIn("from clock", shape["line"])
        self.assertIn("$0.5769", shape["line"])
        self.assertIn("| mid-leg metered clock | - | 506.9 s |", shape["table"])
        # The grading rule is ON the line, not only in the block: the funded leg
        # printed "cost headroom $0.6500" while metering $0.55-0.58 (item 1).
        self.assertIn("graded max(costUsd $0.0000, projection $0.5769)", shape["line"])
        # The graded figure is the projection, not the live zero.
        self.assertGreater(shape["gradedCostUsd"], 0.0)

    def test_item_1_the_projection_would_stop_a_leg_that_crosses_the_abort_point(self):
        # The 8516 leg stopped at 480 s with the projection at $0.5769, under the
        # $0.60 guard point. At the same rate the guard crosses $0.60 at 527 s of
        # metered time, so a leg authorized past that stops before the wall clock.
        rate = self.leg["leg"]["meteredUsdPerS"]
        shape = funded_leg.compare_shape(
            600.0,
            0.65,
            600.0,
            0.0,
            metered_projection_s=600.0,
            metered_rate_usd_per_s=rate,
            abort_source="projected_cost",
        )
        self.assertGreater(shape["gradedCostUsd"], 0.65)
        self.assertEqual(shape["verdict"], "OVER")
        self.assertTrue(shape["projectedOverCap"])
        self.assertAlmostEqual(0.60 / rate, 527.2, places=1)

    def test_item_3_the_record_carries_no_timestamps_so_the_harness_leg_block_must(self):
        timestamps = self.leg["recordTimestamps"]
        self.assertIsNone(timestamps["startedAt"])
        self.assertIsNone(timestamps["endedAt"])
        self.assertIsNone(timestamps["finishedAt"])
        # What the grader reads instead: the harness's own leg window.
        self.assertEqual(self.leg["leg"]["durationS"], 480.0)
        self.assertEqual(self.leg["leg"]["startedAt"], "2026-11-09T22:28:03Z")
        self.assertEqual(self.leg["harness"]["version"], "1.1.0")

    def test_item_2_the_leg_evidence_names_no_build(self):
        # Neither attachment carries a build sha or a served-vs-git md5 pair, which
        # is why the harness now refuses a leg it cannot identify.
        self.assertNotIn("build", self.leg)
        block = funded_leg.verify_build(
            FakeShellRunner({"rev-parse HEAD": (1, "")}), make_config()
        )
        self.assertEqual(block["verdict"], "unreadable")
        self.assertNotEqual(block["verdict"], "verified")


class PostgresHarnessStdinTest(unittest.TestCase):
    """ADAAAA-8644: `psql -f -` must be fed the query, never inherited stdin.

    Two failure arms on the old `RealRunner.sql()` (`subprocess.run` with no
    `input=`):
      * an open-but-silent inherited stdin blocks psql until the 60 s timeout;
      * an inherited `/dev/null` gives EOF, so psql runs nothing and exits 0
        with no rows — a false "nonterminal jobs = 0".
    The fake `docker` below stands in for psql: it accepts the query only on
    stdin and prints the job count, so a probe that reads nothing cannot pass.
    """

    BUSY = "1"
    IDLE = "0"

    FAKE_DOCKER = """#!/bin/sh
# Fake `docker exec -i ... psql -At -f -`: the SQL must arrive on stdin.
query=$(cat)
case "$query" in
  *"from jobs"*) ;;
  *) echo "fake-psql: no query on stdin" >&2; exit 2 ;;
esac
printf '%s\\n' "${FAKE_JOBS:-0}"
"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmpdir = self._tmp.name
        docker = os.path.join(self.tmpdir, "docker")
        with open(docker, "w", encoding="utf-8") as fh:
            fh.write(self.FAKE_DOCKER)
        os.chmod(docker, 0o755)
        self.env = dict(os.environ)
        self.env["PATH"] = self.tmpdir + os.pathsep + self.env.get("PATH", "")
        self.evals_dir = os.path.dirname(os.path.abspath(__file__))

    def tearDown(self):
        self._tmp.cleanup()

    def _probe_in_child(self, stdin, jobs):
        """Run `RealRunner.sql(NONTERMINAL_SQL)` in a child with the given stdin."""
        script = (
            "import sys\n"
            f"sys.path.insert(0, {self.evals_dir!r})\n"
            "import funded_leg\n"
            "rows = funded_leg.RealRunner().sql(funded_leg.NONTERMINAL_SQL)\n"
            "print('ROWS:' + '|'.join(rows))\n"
        )
        env = dict(self.env)
        env["FAKE_JOBS"] = jobs
        proc = subprocess.Popen(
            [sys.executable, "-c", script],
            stdin=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        try:
            # `wait` leaves `proc.stdin` open (communicate() would close it), so
            # the child keeps the launcher-style open pipe for the whole probe.
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
            self.fail("sql() hung on an inherited open stdin (the 60 s timeout arm)")
        assert proc.stdout is not None and proc.stderr is not None
        out = proc.stdout.read()
        err = proc.stderr.read()
        proc.stdout.close()
        proc.stderr.close()
        if proc.stdin is not None:
            proc.stdin.close()
        return proc.returncode, out, err

    def test_unclosed_inherited_stdin_still_reads_the_jobs_count(self):
        # The `screen`/pipe launcher shape: stdin is a pipe nobody writes or
        # closes. The old code blocked here until its 60 s timeout.
        code, out, err = self._probe_in_child(subprocess.PIPE, self.BUSY)
        self.assertEqual(code, 0, err)
        self.assertEqual(out.strip(), "ROWS:1")

    def test_busy_box_reads_one_and_idle_box_reads_zero(self):
        # The false-zero arm: with inherited /dev/null, psql used to run nothing
        # and exit 0 with empty output, so a busy box read 0.
        code, out, err = self._probe_in_child(subprocess.DEVNULL, self.BUSY)
        self.assertEqual(code, 0, err)
        self.assertEqual(out.strip(), "ROWS:1")
        code, out, err = self._probe_in_child(subprocess.DEVNULL, self.IDLE)
        self.assertEqual(code, 0, err)
        self.assertEqual(out.strip(), "ROWS:0")

    def test_local_sql_passes_the_query_as_input_not_inherited_stdin(self):
        calls = {}

        def fake_run(cmd, **kwargs):
            calls.update(kwargs)
            return subprocess.CompletedProcess(cmd, 0, "1\n", "")

        with mock.patch.object(funded_leg.subprocess, "run", fake_run):
            rows = funded_leg.RealRunner().sql(funded_leg.NONTERMINAL_SQL)
        self.assertEqual(rows, ["1"])
        self.assertEqual(calls["input"], funded_leg.NONTERMINAL_SQL)
        self.assertNotIn("stdin", calls)  # input= already owns the pipe

    def test_box_cmd_mode_does_not_add_a_second_stdin_source(self):
        # Remote mode already pipes the base64 SQL in; feeding `input` as well
        # would be a second stdin source.
        calls = {}

        def fake_run(cmd, **kwargs):
            calls.update(kwargs)
            return subprocess.CompletedProcess(cmd, 0, "0\n", "")

        runner = funded_leg.RealRunner(box_cmd="komodo livepeer-ai-x99 --")
        with mock.patch.object(funded_leg.subprocess, "run", fake_run):
            rows = runner.sql(funded_leg.NONTERMINAL_SQL)
        self.assertEqual(rows, ["0"])
        self.assertNotIn("input", calls)
        self.assertEqual(calls["stdin"], subprocess.DEVNULL)
        self.assertIn("base64 -d", runner.commands[-1])

    def test_other_probes_do_not_inherit_stdin(self):
        calls = {}

        def fake_run(cmd, **kwargs):
            calls.update(kwargs)
            return subprocess.CompletedProcess(cmd, 0, "", "")

        with mock.patch.object(funded_leg.subprocess, "run", fake_run):
            funded_leg.RealRunner().shell("true")
        self.assertEqual(calls["stdin"], subprocess.DEVNULL)

    def test_empty_probe_output_is_not_a_false_zero(self):
        class EmptySqlRunner:
            def sql(self, query):
                return []

        sample = funded_leg.sample_gate(
            EmptySqlRunner(), make_config(), funded_leg._now()
        )
        self.assertIsNone(sample.nonterminal_jobs)
        self.assertTrue(any("no rows" in err for err in sample.errors))
        self.assertIn("jobs probe failed", sample.problems())

    def test_evidence_bundle_names_a_probe_failure(self):
        class FailingSqlRunner:
            def sql(self, query):
                raise subprocess.TimeoutExpired("psql", 60)

            def http(self, method, url, body=None, headers=None, timeout=15.0):
                return funded_leg.HttpResult(
                    status=200,
                    body={"capacity": {"activeSessions": 0}, "leases": {"total": 0}},
                )

            def cyc_counts(self, since_iso, containers):
                return {c: 0 for c in containers}

        cfg = make_config(quiet_window_s=1.0)
        with self.assertRaises(funded_leg.GateClosed) as ctx:
            funded_leg.preflight(FailingSqlRunner(), cfg, lambda _m: None)
        reason = ctx.exception.reason
        self.assertIn("jobs probe failed", reason)
        self.assertIn("probe errors", reason)
        self.assertIn("timed out", reason)

        block = funded_leg.preflight_block(
            [ctx.exception.sample], cfg.quiet_window_s, "closed", reason=reason
        )
        self.assertEqual(block["verdict"], "closed")
        self.assertTrue(block["errors"])
        self.assertIn("timed out", " ".join(block["errors"]))
        self.assertTrue(block["samples"][0]["errors"])

    def test_a_quiet_window_bundle_carries_no_errors(self):
        sample = funded_leg.GateSample(
            at="t",
            nonterminal_jobs=0,
            active_sessions=0,
            leases={"active": 0, "total": 0},
            cyc_by_container={"decide-gpu0": 0},
        )
        block = funded_leg.preflight_block([sample], 600.0, "open")
        self.assertEqual(block["errors"], [])
        self.assertEqual(block["samples"][0]["errors"], [])


class DecideBillingTest(unittest.TestCase):
    """ADAAAA-8832: the guard prices the unit the build bills.

    Leg 27bd816f (540 s, cap $0.46, abort $0.414) was stopped at 357.5 s on a
    clock projection priced at the perceive-second rate: $0.4414 against
    $0.414, while the leg's real spend at that instant was ~$0.2353 (71 decides
    at $0.0033324). A decide-billed leg priced by the perceive second is priced
    at ~1.7x its real spend, so the projection fires with half the cap unspent.
    """

    def test_the_decide_unit_rate_is_the_shipped_cost_identity(self):
        billing = funded_leg.BillingBasis(basis="decide")
        self.assertAlmostEqual(
            billing.usd_per_s(),
            funded_leg.DECIDE_USD_PER_DECIDE / funded_leg.DECIDE_CADENCE_DEFAULT_S
            + funded_leg.PERCEIVE_PER_HOUR_USD / 3600.0,
            places=12,
        )
        # ~$0.00067/s of decide unit, against $0.0011381/s of perceive second.
        self.assertAlmostEqual(billing.usd_per_s(), 0.0006692578, places=10)
        self.assertLess(billing.usd_per_s(), 0.0011381)

    def test_the_8816_clock_on_the_decide_unit_is_under_the_abort_point(self):
        billing = funded_leg.BillingBasis(basis="decide")
        at_stop = funded_leg.project_metered_cost(billing, 387.868)
        self.assertEqual(at_stop["projectedFrom"], "clock")
        self.assertEqual(at_stop["fromBasis"], "decide")
        self.assertAlmostEqual(at_stop["usd"], 0.2596, places=3)
        # The projection that stopped the leg ($0.4414) is the perceive basis.
        perceive = funded_leg.project_metered_cost(
            funded_leg.BillingBasis(basis="perceive"), 387.868
        )
        self.assertAlmostEqual(perceive["usd"], 0.4414, places=3)
        self.assertGreaterEqual(perceive["usd"], 0.414)
        # On the decide unit the same instant is $0.1547 short of the guard.
        self.assertLess(at_stop["usd"], 0.414 - 0.15)

    def test_the_full_540_s_shape_fits_the_cap_on_the_decide_unit(self):
        billing = funded_leg.BillingBasis(basis="decide")
        at_end = funded_leg.project_metered_cost(billing, 540.0)
        self.assertAlmostEqual(at_end["usd"], 0.3614, places=3)
        self.assertLess(at_end["usd"], 0.414)   # under the guard point
        self.assertLess(at_end["usd"], 0.46)    # and under the cap

    def test_record_units_win_when_the_record_discloses_more_than_the_clock(self):
        # A leg whose record discloses its billed counts is priced exactly; the
        # summary lane bills at 1.5x the decide fee (SUMMARY_FEE_RATIO).
        billing = funded_leg.BillingBasis(basis="decide")
        clock = funded_leg.project_metered_cost(billing, 300.0)
        self.assertAlmostEqual(clock["usd"], 0.2008, places=3)
        exact = funded_leg.project_metered_cost(
            billing, 300.0, record_decide_calls=71, record_summary_calls=4
        )
        self.assertEqual(exact["projectedFrom"], "record_units")
        self.assertAlmostEqual(exact["recordUnitsUsd"], 0.2566, places=3)
        self.assertAlmostEqual(exact["usd"], 0.2566, places=3)

    def test_an_absent_record_count_is_none_not_zero(self):
        billing = funded_leg.BillingBasis(basis="decide")
        self.assertIsNone(funded_leg.unit_cost_usd(billing, decide_calls=None))
        # A real zero count is priced, not dropped.
        self.assertEqual(funded_leg.unit_cost_usd(billing, decide_calls=0), 0.0)
        self.assertIsNone(funded_leg._record_count({"costUsd": 0.0}, "decideCalls"))
        self.assertEqual(
            funded_leg._record_count({"observeMetrics": {"decideCalls": 7}}, "decideCalls"), 7
        )

    def test_the_confirm_lane_is_billed_at_the_decide_fee(self):
        # The shipped `costUsd` bills `confirmCalls` at the decide fee
        # (`billableConfirmCalls`), so the exact-units reading must price it or a
        # leg that promotes clips mid-leg is under-priced by the guard.
        billing = funded_leg.BillingBasis(basis="decide")
        priced = funded_leg.unit_cost_usd(
            billing, decide_calls=71, confirm_calls=6, perceive_session_s=365.0
        )
        self.assertIsNotNone(priced)
        assert priced is not None
        self.assertAlmostEqual(
            priced,
            funded_leg.DECIDE_USD_PER_DECIDE * 77 + 365.0 / 3600.0 * 0.01,
            places=9,
        )
        clock = funded_leg.project_metered_cost(billing, 300.0)
        with_confirms = funded_leg.project_metered_cost(
            billing, 300.0, record_decide_calls=71, record_confirm_calls=6
        )
        self.assertEqual(with_confirms["projectedFrom"], "record_units")
        self.assertGreater(with_confirms["usd"], clock["usd"])
        self.assertEqual(
            funded_leg._record_count(
                {"observeMetrics": {"confirmCalls": 6}}, "confirmCalls"
            ),
            6,
        )

    def test_a_decide_billed_leg_at_half_the_cap_keeps_running(self):
        # The test this ticket asks for: a decide-billed leg that reaches 0.5 x
        # its cap on the decide unit runs on to the authorized shape. The leg's
        # record is dark (the live rail's mid-leg state), so the guard has only
        # the meter's clock — priced per decide, at ~$0.00067/s.
        code, evidence = run_harness(
            [
                "--stub-scenario", "decide-dark",
                "--authorized-duration-s", "5",
                "--cap-usd", "0.005",
                "--quiet-window-min", "0.08",
                "--hard-stop-slack-s", "2",
                "--poll-s", "0.2",
                "--settle-timeout-s", "3",
            ]
        )
        self.assertEqual(code, 0)
        leg = evidence["leg"]
        self.assertEqual(leg["stopReason"], "authorized_duration")
        self.assertEqual(leg["projectedBasis"], "decide")
        self.assertEqual(leg["billingBasis"], "decide")
        self.assertAlmostEqual(leg["meteredUsdPerS"], 0.0006692578, places=9)
        self.assertGreaterEqual(leg["durationS"], 4.5)
        # It reached at least 0.5 x the cap and kept running.
        self.assertGreaterEqual(evidence["shape"]["projectedCostUsd"], 0.005 * 0.5)
        self.assertLess(leg["projectedCostUsd"], 0.0045)
        self.assertEqual(evidence["authorized"]["billingBasis"], "decide")

    def test_the_perceive_basis_stops_the_same_shape_early(self):
        # The defect this ticket fixes, as a regression guard: at the same shape
        # the perceive-second rate crosses the abort point at ~3.9 s instead of
        # running the 5 s the leg was authorized for.
        code, evidence = run_harness(
            [
                "--stub-scenario", "decide-dark",
                "--authorized-duration-s", "5",
                "--cap-usd", "0.005",
                "--billing-basis", "perceive",
                "--quiet-window-min", "0.08",
                "--hard-stop-slack-s", "2",
                "--poll-s", "0.2",
                "--settle-timeout-s", "3",
            ]
        )
        self.assertEqual(code, 0)
        leg = evidence["leg"]
        self.assertEqual(leg["stopReason"], "projected_cost")
        self.assertEqual(leg["projectedBasis"], "perceive")
        self.assertLess(leg["durationS"], 4.5)

    def test_a_three_second_cadence_prices_higher_than_five(self):
        # The cadence is read from the box (LIVE_OBSERVE_CADENCE_S), because a
        # 3 s cadence bills 1.67x what a 5 s one does on the same share.
        five = funded_leg.BillingBasis(basis="decide", decide_cadence_s=5.0)
        three = funded_leg.BillingBasis(basis="decide", decide_cadence_s=3.0)
        self.assertAlmostEqual(three.usd_per_s() / five.usd_per_s(), 1.667, places=2)
        self.assertAlmostEqual(three.usd_per_s(), 0.0011136, places=6)

    def test_a_readable_cost_at_half_the_cap_is_not_overridden_by_the_clock(self):
        # The ticket's other half: a projection that fires with costUsd at half
        # the cap must not stop a leg. The record here bills $0.0016/s and is
        # readable; a $0.01/s clock projection would cross the $0.009 abort
        # point at 0.9 s. The billed figure wins, so the leg runs its 5 s.
        code, evidence = run_harness(
            [
                "--stub-scenario", "live-cost-dark-session",
                "--authorized-duration-s", "5",
                "--cap-usd", "0.01",
                "--billing-basis", "perceive",
                "--metered-rate-usd-per-s", "0.01",
                "--quiet-window-min", "0.08",
                "--hard-stop-slack-s", "2",
                "--poll-s", "0.2",
                "--settle-timeout-s", "3",
            ]
        )
        self.assertEqual(code, 0)
        leg = evidence["leg"]
        self.assertEqual(leg["stopReason"], "authorized_duration")
        self.assertEqual(leg["guardSource"], "live_cost")
        self.assertEqual(leg["costSource"], "live_cost")
        self.assertEqual(leg["perceiveSessionS"], 0.0)  # dark metered field
        self.assertGreaterEqual(leg["durationS"], 4.5)
        self.assertAlmostEqual(leg["costUsd"], 0.008, places=2)


class Leg8832ReplayTest(unittest.TestCase):
    """$0 replay of the leg this ticket was opened on (job 27bd816f, 8816)."""

    FIXTURE = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "fixtures", "leg8832-evidence.json"
    )

    @classmethod
    def setUpClass(cls):
        with open(cls.FIXTURE, "r", encoding="utf-8") as fh:
            cls.leg = json.load(fh)

    def test_the_stop_was_a_projection_on_the_perceive_second(self):
        leg = self.leg["leg"]
        self.assertEqual(leg["stopReason"], "projected_cost")
        self.assertEqual(leg["projectedFrom"], "clock")
        self.assertEqual(leg["perceiveSessionS"], 0.0)
        self.assertEqual(leg["recordCostSource"], "dark")
        self.assertAlmostEqual(leg["projectedCostUsd"], 0.4414, places=4)
        self.assertGreaterEqual(leg["projectedCostUsd"], self.leg["authorized"]["abortAtUsd"])
        self.assertAlmostEqual(leg["durationS"], 357.494, places=3)

    def test_the_same_instant_on_the_decide_unit_keeps_the_leg_running(self):
        billing = funded_leg.BillingBasis(basis="decide")
        at_stop = funded_leg.project_metered_cost(
            billing, self.leg["leg"]["meteredProjectionS"]
        )
        self.assertLess(at_stop["usd"], self.leg["authorized"]["abortAtUsd"])
        self.assertGreater(self.leg["authorized"]["abortAtUsd"] - at_stop["usd"], 0.15)
        # The leg's settled spend agrees with the decide unit, not the perceive
        # second: 71 decides at $0.0033324 + the 365 s perceive accrual.
        settled = self.leg["settled"]
        priced = funded_leg.unit_cost_usd(
            billing,
            decide_calls=settled["decideCalls"],
            perceive_session_s=settled["perceiveSessionS"],
        )
        self.assertAlmostEqual(priced, settled["costUsd"], delta=0.01)
        self.assertAlmostEqual(
            self.leg["authorized"]["capUsd"] - settled["costUsd"], 0.2247, places=4
        )


if __name__ == "__main__":
    unittest.main()

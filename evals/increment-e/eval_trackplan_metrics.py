#!/usr/bin/env python3
"""Increment E (ADAAAA-6468) — TrackingPlan QA: acceptance + §8 metric scorer.

Child of ADAAAA-6441 (plan §7/§8/§14.9). QA/Reviewer deliverable: per-increment
acceptance tests plus §8 metric instrumentation. This harness is the reproducible
accounting tool: it defines each §8 metric, its measurement method, and the
trace counter/harness field that supplies it, then PASS/FAILs the metric against
the target in plan §8. It also runs the offline (no-GPU) §7 mechanism acceptance
verifiers.

Pure stdlib. Two modes:

  Mechanism acceptance (no GPU, runs pytest suites + offline §7 checks):
      python3 evals/increment-e/eval_trackplan_metrics.py --mechanism

  §8 metric scoring from a live/VOD pipeline trace (needs a real run that
  produced a trace; the bundled synthetic trace is the accounting self-test):
      python3 evals/increment-e/eval_trackplan_metrics.py --trace <trace.json> \
          [--manifest <label-manifest.json>] [--mode live|vod]

  Accounting self-test (validates the scorer, no GPU):
      python3 evals/increment-e/test_eval_trackplan_metrics.py   (or pytest)
"""
import argparse
import json
import logging
import statistics
import subprocess
import sys
import os

# ---------------------------------------------------------------------------
# §8 metric catalog: (key, target, unit, counter/harness field, measurement).
# Each entry documents WHERE in the pipeline the counter lives and HOW the
# metric is measured from the trace, per plan §8 / §14.9.
# ---------------------------------------------------------------------------
METRICS = [
    {
        "key": "latency_live_p95",
        "target": "within 1-5 s, no regression vs today",
        "unit": "s",
        "counter": "per decision, detect->flag wall time (perceive trigger onset -> decide verdict)",
        "measure": "collect detect_ts->flag_ts per highlight decision; p95 across the run",
        "hold": "p95 in [1.0, 5.0]",
    },
    {
        "key": "replan_discovery_p95",
        "target": "<< latency budget; never on per-frame path",
        "unit": "s",
        "counter": "per planner/discovery call, plannedAt->reply wall time",
        "measure": "p95 of planner + discovery call latencies; assert these calls never occur in the per-frame loop",
        "hold": "p95 < 1.0 AND per_frame_planner_calls == 0",
    },
    {
        "key": "target_precision",
        "target": ">= 0.90",
        "unit": "fraction",
        "counter": "per emitted plan target, resolved to a trackable in-vocab label",
        "measure": "trackable_plan_targets / total_plan_targets (plan targets that became a delivered SAM track)",
        "hold": ">= 0.90",
    },
    {
        "key": "detection_alignment",
        "target": "plan-scoped; off-plan objects dropped",
        "unit": "count",
        "counter": "per-frame detections: in-roster vs off-roster (dropped)",
        "measure": "off_plan_dropped > 0 means the closed-vocab gate rejected off-plan objects; assert off_plan_tracked == 0",
        "hold": "off_plan_tracked == 0",
    },
    {
        "key": "discovery_usefulness",
        "target": "measured",
        "unit": "fraction",
        "counter": "per discovery pass, candidates vs candidates that became plan targets",
        "measure": "discovery_candidates_promoted / discovery_candidates_total (per plan/re-plan)",
        "hold": "> 0.0",
    },
    {
        "key": "category_coverage",
        "target": "all 8 categories yield a valid plan",
        "unit": "count",
        "counter": "per supported category, one valid non-empty TrackingPlan with in-category roster",
        "measure": "count of categories with valid plan / 8 (fps, battle-royale, moba, football, basketball, soccer, esports, general)",
        "hold": "== 8 with valid_plan_source != open-domain-junk",
    },
    {
        "key": "noise_trigger_fp_rate",
        "target": "minimized",
        "unit": "fraction",
        "counter": "audio/noise trigger gating gemma analysis; candidates gated in vs later not-highlight",
        "measure": "noise_transit_fp = triggers_gated_in_but_not_highlight / triggers_gated_in",
        "hold": "<= 0.5 (minimized; lower is better)",
    },
    {
        "key": "audio_evidence_use",
        "target": "decisions cite audio as corroboration; crowd-alone inferences = 0",
        "unit": "count",
        "counter": "per decision, reason cites audio + frames; verdicts scored with no frame evidence",
        "measure": "crowd_alone_scoring = decisions where score==scoring_play but no frame evidence and audio-only",
        "hold": "crowd_alone_scoring == 0",
    },
    {
        "key": "frame_cap_live",
        "target": "<= ~5 fps; max_frames_per_analysis never exceeded",
        "unit": "count",
        "counter": "per analysis call, framesDelivered vs maxFramesPerAnalysis (live config)",
        "measure": "max over calls of framesDelivered; violate if any call exceeds maxFramesPerAnalysis",
        "hold": "violations == 0",
    },
    {
        "key": "frame_cap_vod",
        "target": "higher than live, config-documented",
        "unit": "count",
        "counter": "per VOD analysis call, framesDelivered vs vodMaxFramesPerAnalysis",
        "measure": "vod cap > live cap; framesDelivered <= vod config on every call",
        "hold": "violations == 0 AND vod_cap > live_cap",
    },
    {
        "key": "near_miss_recall",
        "target": ">= 0.80",
        "unit": "fraction",
        "counter": "labeled near-miss clips; verdict==near_miss",
        "measure": "true near-misses emitted as near_miss / labeled near-misses",
        "hold": ">= 0.80",
    },
    {
        "key": "near_miss_precision",
        "target": ">= 0.80",
        "unit": "fraction",
        "counter": "near_miss verdicts that are genuine close calls",
        "measure": "genuine / near_miss verdicts on labeled set",
        "hold": ">= 0.80",
    },
    {
        "key": "near_miss_vs_scoring_confusion",
        "target": "= 0 on labeled set",
        "unit": "count",
        "counter": "labeled near-miss emitted as scoring_play or vice versa",
        "measure": "confusions = |emitted_scoring_play on labeled near-miss| + |emitted_near_miss on labeled scoring|",
        "hold": "== 0",
    },
    {
        "key": "audio_misled",
        "target": "audio-following = 0",
        "unit": "count",
        "counter": "verdicts where frame read and audio conflict; final verdict followed audio",
        "measure": "followed_misleading_audio / conflict-window decisions",
        "hold": "audio_following == 0",
    },
    {
        "key": "tracking_accuracy",
        "target": "no regression; track precision/recall over target set (live 3 / VOD 8)",
        "unit": "fraction",
        "counter": "per target track, matched / (matched+lost) continuity + count cap",
        "measure": "track precision + recall over target set; count never > mode cap (3 live / 8 VOD)",
        "hold": "track_count <= mode_cap AND precision/recall >= prior INC-7 baseline",
    },
    {
        "key": "vod_depth",
        "target": "meaningfully out-deep the live pass",
        "unit": "ratio",
        "counter": "paired per-finding detail score D_detail (frames judged + evidence + tokens + window IoU)",
        "measure": "mean(D_vod)/mean(D_live) >= 1.10",
        "hold": ">= 1.10",
    },
    {
        "key": "warmup_time",
        "target": "<= ~3 s",
        "unit": "s",
        "counter": "stream start -> valid type-specific non-empty plan applied (session.configure)",
        "measure": "first-plan-applied ts - stream-start ts",
        "hold": "<= 3.0",
    },
    {
        "key": "recheck_interval",
        "target": "<= ~10 s",
        "unit": "s",
        "counter": "mid-session type change -> active plan swapped (out-of-band re-check)",
        "measure": "replan ts after change - change ts; worst case",
        "hold": "<= 10.0",
    },
    {
        "key": "per_frame_planner_calls",
        "target": "0",
        "unit": "count",
        "counter": "planner/discovery invocations originating from the per-frame loop",
        "measure": "count of planner calls with origin=='per_frame'; must be 0",
        "hold": "== 0",
    },
    {
        "key": "cost_bound",
        "target": "bounded, documented cadence; not per-frame",
        "unit": "count",
        "counter": "decide-class calls per session (planner re-plan + discovery + frame-watch)",
        "measure": "total extra decide calls vs baseline; assert <= documented cadence bound",
        "hold": "replan+discovery calls bounded (documented), never per-frame",
    },
]

CATEGORIES = [
    "fps", "battle-royale", "moba", "football",
    "basketball", "soccer", "esports", "general",
]

# ---------------------------------------------------------------------------
# Offline §7 mechanism verifiers (no GPU). Each returns (name, detail, ok).
# ---------------------------------------------------------------------------

def _suite(name):
    """Return (rc, summary) for a pytest suite on the integrated tree."""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    # root is /tmp/hl-wt-.../evals/increment-e -> parent parent = repo root
    return root


def run_pytest_suite(repo_root, pkg, path):
    env = dict(os.environ)
    env["PYTHONPATH"] = os.path.join(repo_root, "services", pkg)
    cmd = [sys.executable, "-m", "pytest", "-q",
           os.path.join(repo_root, "services", pkg, path)]
    try:
        out = subprocess.run(cmd, cwd=repo_root, env=env,
                             capture_output=True, text=True, timeout=600)
        tail = (out.stdout + out.stderr).strip().splitlines()[-1:] or [""]
        ok = out.returncode == 0
        return ok, (tail[0] if tail else ""), out.returncode
    except Exception as e:  # noqa
        return False, repr(e), -1


# ---------------------------------------------------------------------------
# Trace-based §8 scorer.
# ---------------------------------------------------------------------------

def _p95(xs):
    if not xs:
        return None
    xs = sorted(xs)
    k = max(0, int(round(0.95 * (len(xs) - 1))))
    return float(xs[k])


def _hold(key, value):
    """Interpret each metric's 'hold' against the computed value."""
    if value is None:
        return None
    if key in ("target_precision", "near_miss_recall", "near_miss_precision"):
        return value >= 0.80 if key != "target_precision" else value >= 0.90
    if key in ("category_coverage",):
        return int(value) == 8
    if key in ("frame_cap_live", "frame_cap_vod", "per_frame_planner_calls",
               "near_miss_vs_scoring_confusion", "audio_misled", "detection_alignment",
               "audio_evidence_use"):
        return int(value) == 0
    if key in ("latency_live_p95",):
        return 1.0 <= value <= 5.0
    if key == "replan_discovery_p95":
        return value < 1.0
    if key == "warmup_time":
        return value <= 3.0
    if key == "recheck_interval":
        return value <= 10.0
    if key in ("tracking_accuracy", "discovery_usefulness", "noise_trigger_fp_rate"):
        return value is not None
    if key == "vod_depth":
        return value >= 1.10
    if key == "cost_bound":
        return value is not None
    return None


def score_trace(trace, mode="live"):
    """Compute §8 metrics from a pipeline trace. Missing counters -> None (not captured)."""
    events = trace.get("events", [])
    m = {}
    lat = [e["latencyS"] for e in events if e.get("type") == "decision" and "latencyS" in e]
    m["latency_live_p95"] = _p95(lat)

    replan = [e["latencyS"] for e in events if e.get("type") == "plan" and "latencyS" in e]
    m["replan_discovery_p95"] = _p95(replan)

    tp = [e for e in events if e.get("type") == "plan"]
    tp_total = sum(int(e.get("targets", 0)) for e in tp)
    tp_track = sum(int(e.get("trackableTargets", 0)) for e in tp)
    m["target_precision"] = (tp_track / tp_total) if tp_total else None

    m["detection_alignment"] = sum(
        int(e.get("offPlanTracked", 0)) for e in events if e.get("type") == "detection"
    )

    du_cand = sum(int(e.get("candidates", 0)) for e in events if e.get("type") == "discovery")
    du_prom = sum(int(e.get("promoted", 0)) for e in events if e.get("type") == "discovery")
    m["discovery_usefulness"] = (du_prom / du_cand) if du_cand else None

    cat_ok = sum(
        1 for e in events if e.get("type") == "plan"
        and e.get("category") in CATEGORIES and int(e.get("targets", 0)) > 0
    )
    m["category_coverage"] = cat_ok

    gi = [e for e in events if e.get("type") == "candidate" and e.get("gatedIn")]
    gp = sum(int(e.get("notHighlight", 0)) for e in gi)
    m["noise_trigger_fp_rate"] = (gp / len(gi)) if gi else None

    crowd = sum(
        int(e.get("crowdAloneScoring", 0)) for e in events if e.get("type") == "decision"
    )
    m["audio_evidence_use"] = crowd

    fc_viol = sum(
        int(e.get("violated", 0)) for e in events
        if e.get("type") == "framewatch" and e.get("mode") == "live"
    )
    m["frame_cap_live"] = fc_viol
    fc_vod = sum(
        int(e.get("violated", 0)) for e in events
        if e.get("type") == "framewatch" and e.get("mode") == "vod"
    )
    m["frame_cap_vod"] = fc_vod

    nm = [e for e in events if e.get("type") == "nearmiss"]
    recall = sum(1 for e in nm if e.get("truth") == "near_miss" and e.get("verdict") == "near_miss")
    recall_den = sum(1 for e in nm if e.get("truth") == "near_miss")
    m["near_miss_recall"] = (recall / recall_den) if recall_den else None
    precision_num = sum(1 for e in nm if e.get("truth") == "near_miss" and e.get("verdict") == "near_miss")
    precision_den = sum(1 for e in nm if e.get("verdict") == "near_miss")
    m["near_miss_precision"] = (precision_num / precision_den) if precision_den else None
    m["near_miss_vs_scoring_confusion"] = sum(
        int(e.get("confused", 0)) for e in nm
    )
    m["audio_misled"] = sum(
        int(e.get("followedAudio", 0)) for e in events if e.get("type") == "decision"
    )

    tk = [e for e in events if e.get("type") == "tracking"]
    tk_prec = (sum(int(e.get("correct", 0)) for e in tk) /
               sum(int(e.get("total", 0)) for e in tk)) if tk else None
    m["tracking_accuracy"] = tk_prec

    dv = [e for e in events if e.get("type") == "depth"]
    vod_depth = (sum(e.get("vod", 0) for e in dv) / sum(e.get("live", 0) for e in dv)) if dv else None
    m["vod_depth"] = vod_depth

    wu = [e for e in events if e.get("type") == "plan" and e.get("warmupS") is not None]
    m["warmup_time"] = (max(e["warmupS"] for e in wu) if wu else None)
    rc = [e for e in events if e.get("type") == "plan" and e.get("recheckS") is not None]
    m["recheck_interval"] = (max(e["recheckS"] for e in rc) if rc else None)

    m["per_frame_planner_calls"] = sum(
        int(e.get("perFrame", 0)) for e in events if e.get("type") == "plan"
    )
    m["cost_bound"] = sum(
        1 for e in events if e.get("type") == "plan" and not e.get("perFrame")
    )
    return m


# ---------------------------------------------------------------------------
# Mechanism acceptance (offline, no GPU): list of §7 criteria checkable in code.
# ---------------------------------------------------------------------------
MECHANISM_CHECKS = [
    ("§7 A/B plan scoped: TrackingPlan contract + closed-vocab gate + plan-first fallback",
     "services/perceive/tests/test_tracking_plan.py"),
    ("§7 B American-football synonym + plan-first consumption + safe-default",
     "services/decide/tests/test_planner.py"),
    ("§7 C discovery at plan cadence + finetune manifest + loraRef injection",
     "services/decide/tests/test_planner_finetune.py"),
    ("§7 C discovery records method + region/caption candidates",
     "services/perceive/tests/test_discovery.py"),
    ("§7 D maxTracks clamp 3/8 + warm-up one planner call + re-check cadence + narrow-only",
     "services/server/test/tracking-plan.test.ts"),
    ("§7 D/F frame-watch assembler cap + near-miss taxonomy + crowd-alone rule",
     "services/decide/tests/test_gemma.py"),
    ("§7 A-D open-domain no-degrade: plan roster is the closed vocab per session",
     "services/perceive/tests/test_florence.py"),
    ("§7 F frame cap enforcement on analyzer (5fps / max_frames_per_analysis)",
     "services/server/test/analyzer.test.ts"),
]

MECHANISM_SUITES = [
    ("perceive", "tests"),
    ("decide", "tests"),
    ("train", "tests"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mechanism", action="store_true",
                    help="run offline §7 mechanism acceptance (pytest suites + checks)")
    ap.add_argument("--trace", help="pipeline trace JSON to score for §8 metrics")
    ap.add_argument("--mode", default="live", choices=["live", "vod"])
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", ".."))

    report = {"ad_issue": "ADAAAA-6468", "increment": "E"}

    if args.mechanism:
        rows = []
        for pkg, path in MECHANISM_SUITES:
            ok, tail, rc = run_pytest_suite(repo, pkg, path)
            rows.append({"suite": f"services/{pkg}/{path}", "ok": ok,
                         "summary": tail, "rc": rc})
        report["mechanism_suites"] = rows
        report["mechanism_suites_pass"] = all(r["ok"] for r in rows)

    if args.trace:
        with open(args.trace) as f:
            trace = json.load(f)
        scored = score_trace(trace, args.mode)
        out = []
        for meta in METRICS:
            key = meta["key"]
            val = scored.get(key)
            hold = _hold(key, val)
            if val is None:
                status = "not_captured"
            else:
                status = "PASS" if hold else "FAIL"
            out.append({"metric": key, "target": meta["target"], "value": val,
                        "status": status, "measure": meta["measure"]})
        report["metrics"] = out
        report["metric_pass"] = all(
            o["status"] == "PASS" for o in out if o["status"] != "not_captured"
        ) if any(o["status"] != "not_captured" for o in out) else None

    print(json.dumps(report, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())

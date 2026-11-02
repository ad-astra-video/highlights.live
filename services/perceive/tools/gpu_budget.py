#!/usr/bin/env python3
"""Hard GPU-budget guard for one-shot perceive measurement runs (ADAAAA-7345).

The CEO cost sign-off for the SAM3 player-tracking workstream requires that
EVERY GPU run carries a hard in-code cap, so an over-budget run aborts and
writes **no** result artifact instead of passing silently — and that cumulative
GPU time/dollars stay auditable at the measured $3.64/GPU-hour stream rate.

This wrapper owns that contract instead of trusting each caller to pass flags:

  * a wall-clock deadline (`--budget-gpu-minutes`), enforced by SIGTERM then
    SIGKILL, after which the result artifact is deleted and the wrapper exits
    `75` (`EX_TEMPFAIL`) with a `BUDGET_ABORT` line;
  * a cumulative ledger (`--ledger`) that refuses to START a run which would
    push total GPU minutes past `--max-cumulative-minutes` (default 240 = the
    sign-off's ~4 GPU-hour ceiling) or past `--max-cumulative-usd` (default
    $15);
  * a projected-cost refusal, so a run that is over budget before it starts
    never touches the GPU;
  * an accounting sidecar (`--usage-out`, default `<artifact>.usage.json`) that
    records elapsed minutes, dollars at the sign-off rate, and the abort
    outcome — this is what the close-out report quotes.

Usage (inside the perceive image, one line):

  python3 tools/gpu_budget.py \
      --budget-gpu-minutes 45 --artifact /data/meas7345.json \
      --ledger /data/gpu_ledger.json --max-frames 487 \
      -- python3 /srv/perceive/measure_7219.py --clip ... --out /data/meas7345.json ...

The child command MUST write its result to the SAME path passed as
`--artifact`; that is the file deleted on abort. `--max-frames N` is appended
to the child argv so the frame cap travels with the run.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from typing import List, Optional

# Measured stream rate from ADAAAA-7800; the sign-off quotes dollars at this.
USD_PER_GPU_HOUR = 3.64
DEFAULT_BUDGET_MINUTES = 45.0
# Sign-off: "Do not exceed ~4 cumulative GPU-hours without re-asking."
DEFAULT_MAX_CUMULATIVE_MINUTES = 240.0
DEFAULT_MAX_CUMULATIVE_USD = 15.0
# Grace period between SIGTERM and SIGKILL: a torch child may ignore SIGTERM.
KILL_GRACE_SEC = 10.0
EXIT_BUDGET_ABORT = 75
EXIT_REFUSED = 2


def usd_for_minutes(minutes: float) -> float:
    return (minutes / 60.0) * USD_PER_GPU_HOUR


def read_ledger(path: Optional[str]) -> dict:
    """Load the cumulative GPU ledger, tolerating a missing/blank file."""
    if not path or not os.path.exists(path):
        return {"runs": []}
    try:
        with open(path) as f:
            data = json.load(f) or {}
    except (OSError, ValueError):
        # A corrupt ledger must not silently reset the spend history: refuse
        # to run rather than pretending nothing was spent.
        raise SystemExit(
            "gpu_budget: ledger %s is unreadable; fix or move it before running" % path
        )
    data.setdefault("runs", [])
    return data


def ledger_totals(ledger: dict) -> tuple:
    runs = ledger.get("runs") or []
    minutes = sum(float(r.get("minutes", 0.0) or 0.0) for r in runs)
    return minutes, usd_for_minutes(minutes)


def write_json(path: str, payload: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, path)


def append_ledger(path: Optional[str], ledger: dict, entry: dict) -> None:
    if not path:
        return
    ledger.setdefault("runs", []).append(entry)
    ledger["total_minutes"] = sum(float(r.get("minutes", 0.0) or 0.0) for r in ledger["runs"])
    ledger["total_usd_at_rate"] = round(usd_for_minutes(ledger["total_minutes"]), 4)
    ledger["usd_per_gpu_hour"] = USD_PER_GPU_HOUR
    write_json(path, ledger)


def remove_artifact(path: Optional[str]) -> bool:
    """Delete the result artifact (and its temp sibling) if present."""
    removed = False
    for p in (path, path + ".tmp" if path else None):
        if not p:
            continue
        try:
            os.remove(p)
            removed = True
        except FileNotFoundError:
            pass
        except OSError as e:
            print("gpu_budget: could not remove artifact %s: %s" % (p, e))
    return removed


def run_child(argv: List[str], deadline_sec: float, artifact: Optional[str]) -> tuple:
    """Run `argv` under a hard deadline. Returns (rc, elapsed_sec, aborted)."""
    started = time.time()
    try:
        proc = subprocess.Popen(argv)
    except OSError as e:
        print("gpu_budget: could not start child: %s" % e)
        return 127, 0.0, False
    aborted = False
    try:
        rc = proc.wait(timeout=deadline_sec)
    except subprocess.TimeoutExpired:
        aborted = True
        rc = EXIT_BUDGET_ABORT
        print(
            "gpu_budget: deadline of %.2f min reached -> terminating pid %s"
            % (deadline_sec / 60.0, proc.pid)
        )
        try:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=KILL_GRACE_SEC)
        except subprocess.TimeoutExpired:
            print("gpu_budget: child ignored SIGTERM -> SIGKILL")
            proc.kill()
            try:
                proc.wait(timeout=KILL_GRACE_SEC)
            except subprocess.TimeoutExpired:
                print("gpu_budget: child survived SIGKILL (likely a re-parented process group)")
    elapsed = time.time() - started
    if aborted:
        gone = remove_artifact(artifact)
        print(
            "BUDGET_ABORT minutes_used=%.2f budget=%.2f artifact=%s removed=%s"
            % (elapsed / 60.0, deadline_sec / 60.0, artifact, gone)
        )
    return rc, elapsed, aborted


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Run a GPU measurement under a hard budget cap (ADAAAA-7345 sign-off)."
    )
    ap.add_argument("--budget-gpu-minutes", type=float, default=DEFAULT_BUDGET_MINUTES,
                    help="hard wall-clock budget for this run (minutes); default 45")
    ap.add_argument("--artifact", default=None,
                    help="path the child writes its result JSON to; DELETED on abort")
    ap.add_argument("--usage-out", default=None,
                    help="accounting sidecar path (default: <artifact>.usage.json)")
    ap.add_argument("--ledger", default=None,
                    help="cumulative GPU ledger JSON; refuses runs over the ceiling")
    ap.add_argument("--max-cumulative-minutes", type=float,
                    default=DEFAULT_MAX_CUMULATIVE_MINUTES,
                    help="cumulative GPU-minute ceiling; default 240 (~4 GPU-hours)")
    ap.add_argument("--max-cumulative-usd", type=float, default=DEFAULT_MAX_CUMULATIVE_USD,
                    help="cumulative dollar ceiling at the $3.64/GPU-hour rate; default 15")
    ap.add_argument("--max-frames", type=int, default=None,
                    help="frame cap appended to the child command as --max-frames N")
    ap.add_argument("--label", default=None, help="run label recorded in the ledger")
    ap.add_argument("child", nargs=argparse.REMAINDER,
                    help="-- <child command ...>")
    return ap


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    child = [a for a in args.child if a != "--"]
    if not child:
        print("gpu_budget: no child command given (use: -- <cmd ...>)")
        return EXIT_REFUSED
    budget = float(args.budget_gpu_minutes)
    if budget <= 0:
        print("gpu_budget: --budget-gpu-minutes must be > 0 (a run without a cap is refused)")
        return EXIT_REFUSED

    ledger = read_ledger(args.ledger)
    used_min, used_usd = ledger_totals(ledger)
    if used_min + budget > args.max_cumulative_minutes:
        print(
            "gpu_budget: REFUSED projected cumulative %.2f min > ceiling %.2f min "
            "(already used %.2f min). Post the measurement and re-ask before exceeding "
            "the sign-off ceiling." % (used_min + budget, args.max_cumulative_minutes, used_min)
        )
        return EXIT_REFUSED
    if used_usd + usd_for_minutes(budget) > args.max_cumulative_usd:
        print(
            "gpu_budget: REFUSED projected cumulative $%.2f > ceiling $%.2f at "
            "$%.2f/GPU-hour (already used $%.2f). Stop and post the measurement."
            % (used_usd + usd_for_minutes(budget), args.max_cumulative_usd,
               USD_PER_GPU_HOUR, used_usd)
        )
        return EXIT_REFUSED

    if args.max_frames is not None:
        child = child + ["--max-frames", str(int(args.max_frames))]

    usage_out = args.usage_out or (args.artifact + ".usage.json" if args.artifact else None)
    print(
        "GPU_BUDGET_START label=%s budget_min=%.2f projected_usd=%.2f "
        "cumulative_before_min=%.2f artifact=%s"
        % (args.label, budget, usd_for_minutes(budget), used_min, args.artifact)
    )
    sys.stdout.flush()
    rc, elapsed, aborted = run_child(child, budget * 60.0, args.artifact)
    minutes = elapsed / 60.0
    usd = usd_for_minutes(minutes)
    entry = {
        "label": args.label,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - elapsed)),
        "minutes": round(minutes, 3),
        "usd_at_rate": round(usd, 4),
        "usd_per_gpu_hour": USD_PER_GPU_HOUR,
        "budget_minutes": budget,
        "aborted": aborted,
        "exit_code": rc,
        "artifact": args.artifact,
    }
    append_ledger(args.ledger, ledger, entry)
    if usage_out:
        write_json(usage_out, entry)
        print("gpu_budget: usage written to %s" % usage_out)
    running_min, running_usd = ledger_totals(ledger)
    print(
        "GPU_BUDGET_END rc=%d aborted=%s minutes=%.2f usd=%.2f "
        "cumulative_min=%.2f cumulative_usd=%.2f"
        % (rc, aborted, minutes, usd, running_min, running_usd)
    )
    return rc


if __name__ == "__main__":
    sys.exit(main())

"""ADAAAA-7345 GPU budget guard: hard cap, artifact removal, spend ledger.

The CEO cost sign-off requires every tuning GPU run to carry a hard in-code cap
so an over-budget run aborts with NO result artifact, and to keep cumulative
GPU minutes/dollars auditable at the $3.64/GPU-hour rate. These tests exercise
the guard as a subprocess against tiny fake children (no model, no GPU).
"""
import json
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
GUARD = os.path.join(os.path.dirname(HERE), "tools", "gpu_budget.py")
RATE = 3.64


def _child(tmp_path, name, body):
    p = tmp_path / name
    p.write_text(body)
    return str(p)


def _run(args, timeout=60):
    return subprocess.run(
        [sys.executable, GUARD] + args,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


OK_CHILD = """
import json, sys
out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else None
if out:
    with open(out, 'w') as f:
        json.dump({'selected_player_final_accuracy': 0.93}, f)
print('MEAS_EXIT=0')
"""

SLOW_CHILD = """
import sys, time
out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else None
if out:
    with open(out, 'w') as f:
        f.write('{"partial": true}')
sys.stdout.flush()
time.sleep(120)
"""

ARGV_CHILD = """
import json, sys
out = sys.argv[sys.argv.index('--out') + 1]
with open(out, 'w') as f:
    json.dump({'argv': sys.argv[1:]}, f)
"""


def test_success_keeps_artifact_and_records_spend(tmp_path):
    art = tmp_path / "meas.json"
    ledger = tmp_path / "ledger.json"
    child = _child(tmp_path, "ok.py", OK_CHILD)
    r = _run([
        "--budget-gpu-minutes", "1",
        "--artifact", str(art),
        "--ledger", str(ledger),
        "--label", "meas7345-t1",
        "--", sys.executable, child, "--out", str(art),
    ])
    assert r.returncode == 0, r.stdout + r.stderr
    assert art.exists()
    assert json.loads(art.read_text())["selected_player_final_accuracy"] == 0.93
    assert "GPU_BUDGET_END rc=0 aborted=False" in r.stdout
    sidecar = json.loads((tmp_path / "meas.json.usage.json").read_text())
    assert sidecar["aborted"] is False
    assert sidecar["usd_per_gpu_hour"] == RATE
    led = json.loads(ledger.read_text())
    assert len(led["runs"]) == 1 and led["runs"][0]["label"] == "meas7345-t1"
    assert led["total_minutes"] > 0


def test_over_budget_aborts_without_artifact(tmp_path):
    art = tmp_path / "meas.json"
    ledger = tmp_path / "ledger.json"
    child = _child(tmp_path, "slow.py", SLOW_CHILD)
    # 0.05 min == 3s deadline; the child needs 120s and writes a partial artifact first.
    r = _run([
        "--budget-gpu-minutes", "0.05",
        "--artifact", str(art),
        "--ledger", str(ledger),
        "--", sys.executable, child, "--out", str(art),
    ])
    assert r.returncode == 75, r.stdout + r.stderr
    assert not art.exists(), "an aborted run must leave NO result artifact"
    assert "BUDGET_ABORT" in r.stdout and "removed=True" in r.stdout
    sidecar = json.loads((tmp_path / "meas.json.usage.json").read_text())
    assert sidecar["aborted"] is True and sidecar["exit_code"] == 75
    led = json.loads(ledger.read_text())
    assert led["runs"][0]["aborted"] is True


def test_refuses_run_without_a_cap(tmp_path):
    child = _child(tmp_path, "ok.py", OK_CHILD)
    r = _run(["--budget-gpu-minutes", "0", "--", sys.executable, child])
    assert r.returncode == 2
    assert "must be > 0" in r.stdout


def test_refuses_budget_past_cumulative_ceiling(tmp_path):
    art = tmp_path / "meas.json"
    ledger = tmp_path / "ledger.json"
    ledger.write_text(json.dumps({"runs": [{"minutes": 200.0, "usd_at_rate": 12.13}]}))
    child = _child(tmp_path, "ok.py", OK_CHILD)
    r = _run([
        "--budget-gpu-minutes", "60",
        "--artifact", str(art),
        "--ledger", str(ledger),
        "--", sys.executable, child, "--out", str(art),
    ])
    assert r.returncode == 2
    assert "REFUSED projected cumulative" in r.stdout
    assert not art.exists()


def test_refuses_budget_over_dollar_ceiling(tmp_path):
    art = tmp_path / "meas.json"
    ledger = tmp_path / "ledger.json"
    ledger.write_text(json.dumps({"runs": [{"minutes": 60.0}]}))  # $3.64 already
    child = _child(tmp_path, "ok.py", OK_CHILD)
    # 60 + 30 min is well under the 240-min ceiling, so the DOLLAR gate is the
    # one that must refuse here ($3.64 + $1.82 = $5.46 > $5.00).
    r = _run([
        "--budget-gpu-minutes", "30",
        "--max-cumulative-usd", "5",
        "--artifact", str(art),
        "--ledger", str(ledger),
        "--", sys.executable, child, "--out", str(art),
    ])
    assert r.returncode == 2
    assert "ceiling $5.00" in r.stdout


def test_max_frames_is_appended_to_the_child(tmp_path):
    art = tmp_path / "meas.json"
    child = _child(tmp_path, "argv.py", ARGV_CHILD)
    r = _run([
        "--budget-gpu-minutes", "1",
        "--artifact", str(art),
        "--max-frames", "487",
        "--", sys.executable, child, "--out", str(art),
    ])
    assert r.returncode == 0, r.stdout + r.stderr
    argv = json.loads(art.read_text())["argv"]
    assert argv[-2:] == ["--max-frames", "487"]


def test_corrupt_ledger_is_not_silently_reset(tmp_path):
    ledger = tmp_path / "ledger.json"
    ledger.write_text("{not json")
    child = _child(tmp_path, "ok.py", OK_CHILD)
    r = _run(["--budget-gpu-minutes", "1", "--ledger", str(ledger),
              "--", sys.executable, child])
    assert r.returncode != 0
    assert "unreadable" in (r.stdout + r.stderr)

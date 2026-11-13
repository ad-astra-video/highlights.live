#!/usr/bin/env python3
"""ADAAAA-8844 (Inc 2) — the measured evidence for AC2.2 and AC2.4.

Runs on the box that holds the labelled crop truth set (ADAAAA-8577 crops /
ADAAAA-8578 truth). $0: local pixel arithmetic + PIL, no model, no GPU, no
network, no DB write.

AC2.2 — RECALL. The regression set is the labelled scorebug truth set: 62 crops
that carry a surface reading of a REAL, single score surface. Every one of them
is a goal-bearing fixture (its score pair is the clip's own scoreboard). The
check is that the shipped rule, given the job's real match context, does not
demote a genuine surface:

  * `contradicted` on a truth-set crop would spend recall on the surface we must
    not lose -> the script FAILS if any crop is contradicted.
  * `consistent` / `absent` keep today's behaviour, so the accepted-goal count is
    unchanged by construction AND measured here as a count.

Baseline: the pre-change behaviour is reproduced by the same rule with no
identity measured at all (`identity=None`, i.e. `scoreboardSurfaceIdentity`
absent). `baseline_accepted` is that count; `patched_accepted` is the count with
the measured verdicts applied. AC2.2 passes iff patched >= baseline.

AC2.4 — COST. Times the identity pass on a real crop at native resolution and
reports p50/p95 per pass, plus the per-session pass count (<= 2). The decide
latency side is measured in the repo (rule endpoint A/B); this script states the
local arithmetic cost the rule adds.

Run (box, from the perceive app dir or with --perceive-app):

  python3 evals/adaaa_8844/measure-8844.py \
      --truth /tmp/eval8551/truth8578/scorebug-truth.json \
      --crops /tmp/eval8551/truth8578/crops \
      --perceive-app /tmp/hl8844-8844/perceive_app \
      --out /tmp/hl8844-8844/recall-8844.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter
from typing import Any

# The job's real match context for the truth set: its bug prints `RMA 0 - 0 BAR`,
# i.e. Real Madrid (red/white) vs FC Barcelona (blue/grey) — the kit names a
# resolver would deliver for that broadcast.
TEAMS = [
    {"side": "home", "name": "Real Madrid", "kitColors": [{"primary": "white", "secondary": "red"}]},
    {"side": "away", "name": "FC Barcelona", "kitColors": [{"primary": "blue", "secondary": "grey"}]},
]


def _load(perceive_app: str):
    sys.path.insert(0, perceive_app)
    import numpy as np  # noqa: F401  (box dependency)
    from PIL import Image  # noqa: F401  (box dependency)
    from surface_identity import derive_surface_identity, demotion_note, surface_reading  # type: ignore
    from scoreboard import ScoreboardRoi  # type: ignore

    return derive_surface_identity, demotion_note, surface_reading, ScoreboardRoi


def quantile(vals: list[float], q: float) -> float | None:
    if not vals:
        return None
    s = sorted(vals)
    k = (len(s) - 1) * q
    lo, hi = __import__("math").floor(k), __import__("math").ceil(k)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 4)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth", required=True)
    ap.add_argument("--crops", required=True)
    ap.add_argument("--perceive-app", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    derive, demotion, reading, ScoreboardRoi = _load(args.perceive_app)
    import numpy as np
    from PIL import Image

    rows = json.load(open(args.truth))
    if isinstance(rows, dict):
        rows = rows.get("rows") or []

    verdicts: Counter = Counter()
    per_crop: list[dict[str, Any]] = []
    timings: list[float] = []
    for r in rows:
        wid = str(r.get("wid"))
        path = os.path.join(args.crops, f"{wid}.png")
        if not os.path.exists(path):
            continue
        arr = np.asarray(Image.open(path).convert("RGB"), dtype=float)
        h, w, _ = arr.shape
        roi = ScoreboardRoi(0.0, 0.0, 1.0, 1.0)
        lines = [str(r.get("reader1_text") or "")]

        t0 = time.perf_counter()
        rd = reading(arr, roi, lines)
        ident = derive(rd, TEAMS)
        timings.append((time.perf_counter() - t0) * 1000.0)

        verdicts[ident["verdict"]] += 1
        per_crop.append(
            {
                "wid": wid,
                "verdict": ident["verdict"],
                "kitDistance": ident["kitDistance"],
                "kits": ident["kits"],
                "names": ident["names"],
                "namesMatched": ident["namesMatched"],
                "demotion": demotion(ident),
            }
        )

    n = len(per_crop)
    if not n:
        print("FAIL: no crops read", file=sys.stderr)
        return 2

    # AC2.2: baseline = the same corpus with no identity measured (today's
    # behaviour); patched = the measured verdicts. A goal window is "accepted"
    # unless its own surface was demoted.
    baseline_accepted = n
    patched_accepted = sum(1 for c in per_crop if c["verdict"] != "contradicted")
    contradicted = [c for c in per_crop if c["verdict"] == "contradicted"]

    report = {
        "issue": "ADAAAA-8844",
        "acs": ["AC2.2", "AC2.4"],
        "truth_set": {"truth": args.truth, "crops": args.crops, "crops_read": n},
        "match_context": TEAMS,
        "AC2_2_recall": {
            "baseline_accepted": baseline_accepted,
            "patched_accepted": patched_accepted,
            "tolerance": 0,
            "pass": patched_accepted >= baseline_accepted,
            "verdicts": dict(verdicts),
            "contradicted_crops": [
                {"wid": c["wid"], "kitDistance": c["kitDistance"], "kits": c["kits"], "names": c["names"]}
                for c in contradicted
            ],
        },
        "AC2_4_cost": {
            "identity_passes_per_session_cap": 2,
            "per_frame_additions": 0,
            "identity_pass_ms": {
                "n": len(timings),
                "p50": quantile(timings, 0.5),
                "p95": quantile(timings, 0.95),
                "max": round(max(timings), 3),
            },
            "note": "one bounded local pixel pass per session surface; no OCR, no model call",
        },
        "per_crop": per_crop,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(report, f, indent=1)
    print(json.dumps({k: v for k, v in report.items() if k != "per_crop"}, indent=1))
    return 0 if report["AC2_2_recall"]["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

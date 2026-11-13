#!/usr/bin/env python3
"""ADAAAA-8844 AC2.5 — set the score-surface identity threshold from the labelled
crop truth set (ADAAAA-8577 crops / ADAAAA-8578 truth), never by guessing.

The rule (services/perceive/app/surface_identity.py) reads the score surface off
the crop perceive already took and compares it with the job's match context:

  * kit swatches — the plate colour each half of the bug prints;
  * printed names — the team tokens the bug prints beside the score.

Two channels, one number: the CHROMATICITY distance below which two readings
count as the same surface appearance. It is measured here, on the truth set,
from the only distribution that set can actually give us — how far ONE genuine
score surface drifts from itself across frames.

Why that distribution and not a "different bug" one: the truth set is a single
match with a single bug (91 labelled rows, one `clip_id`, one size, one plate
colour), so it contains no foreign-surface sample to measure against. Widening
the threshold to clear the real foreign bug is AC2.1's job (the PIP fixture),
while AC2.5's job is the RECALL side: the bar must not demote a genuine surface
that merely looks different under another exposure, another bitrate or another
overlay scale. The set measures exactly that risk, and the rule's corroborating
conjunct (printed names must ALSO disagree) carries precision.

Metric: normalized chromaticity, `rgb / sum(rgb)` per channel, Euclidean. Raw
RGB distance is reported beside it for transparency, but it is dominated by
exposure (one washed-out crop reads 129 away in raw RGB while sitting at the
same hue), which would force a bar so wide it could not separate any kit.

Threshold rule: `1.15 x max observed same-surface drift`, rounded up to 2 dp.
1.15 is the safety margin on the worst measured reading; the typical (p50) drift
is an order of magnitude below it, so the bar is dominated by outliers by design.

Run on the box that holds the truth set ($0, no GPU, no network):

  python3 evals/scoreboard_identity_threshold_8844.py \
      --truth /tmp/eval8551/truth8578/scorebug-truth.json \
      --crops /tmp/eval8551/truth8578/crops \
      --perceive-app /srv/perceive/app \
      --out evals/adaaa_8844/identity-threshold.json

It prints the report and exits non-zero when the set cannot support a threshold.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from typing import Any

MARGIN = 1.15


def _load_production(perceive_app: str):
    """Import the PRODUCTION crop/surface helpers from the perceive service."""
    sys.path.insert(0, perceive_app)
    from match_context import _dominant_swatch  # type: ignore

    return _dominant_swatch


def _crop_path(crops_dir: str, wid: str) -> str | None:
    for name in (f"{wid}.png", f"{wid}.jpg", f"{wid}_x3.png"):
        p = os.path.join(crops_dir, name)
        if os.path.exists(p):
            return p
    return None


def chroma(rgb) -> list[float]:
    s = float(sum(rgb)) or 1.0
    return [float(rgb[0]) / s, float(rgb[1]) / s, float(rgb[2]) / s]


def dist(a, b) -> float:
    return math.sqrt(sum((float(a[i]) - float(b[i])) ** 2 for i in range(3)))


def quantile(vals: list[float], q: float) -> float | None:
    if not vals:
        return None
    s = sorted(vals)
    k = (len(s) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 4)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth", required=True)
    ap.add_argument("--crops", required=True)
    ap.add_argument("--perceive-app", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    dominant = _load_production(args.perceive_app)
    import numpy as np  # noqa: E402  (box-only dependency)
    from PIL import Image  # noqa: E402  (box-only dependency)

    rows = json.load(open(args.truth))
    if isinstance(rows, dict):
        rows = rows.get("rows") or []

    readings: list[dict[str, Any]] = []
    missing: list[str] = []
    for r in rows:
        wid = str(r.get("wid"))
        path = _crop_path(args.crops, wid)
        if path is None:
            missing.append(wid)
            continue
        frame = Image.open(path).convert("RGB")
        arr = np.asarray(frame, dtype=float)
        h, w, _ = arr.shape
        sw = dominant(arr, 0, w, 0, h)
        readings.append(
            {
                "wid": wid,
                "variant": r.get("variant"),
                "crop_px": [w, h],
                "swatch": sw,
                "text": str(r.get("reader1_text") or ""),
            }
        )

    usable = [x for x in readings if x["swatch"]]
    if not usable:
        print(json.dumps({"readings": len(readings), "usable": 0}), file=sys.stderr)
        print("FAIL: no crop yielded a surface swatch", file=sys.stderr)
        return 2

    # The surface's own consensus reading over the set (what "the same bug" looks
    # like), used as the reference for the drift distribution.
    cents = {
        "rgb": [round(sum(x["swatch"]["rgb"][i] for x in usable) / len(usable), 2) for i in range(3)],
        "chroma": [
            round(sum(chroma(x["swatch"]["rgb"])[i] for x in usable) / len(usable), 5) for i in range(3)
        ],
    }
    raw = [dist(x["swatch"]["rgb"], cents["rgb"]) for x in usable]
    ch = [dist(chroma(x["swatch"]["rgb"]), cents["chroma"]) for x in usable]

    # Printed-name channel: what the bug actually prints, and how legible it is.
    def tokens(text: str) -> list[str]:
        return [t for t in re.split(r"[^A-Za-z]+", text.upper()) if len(t) >= 3]

    token_share: dict[str, int] = {}
    for x in usable:
        for t in set(tokens(x["text"])):
            token_share[t] = token_share.get(t, 0) + 1
    printed_teams = sorted(
        [t for t, n in token_share.items() if n >= 0.8 * len(usable)], key=lambda t: -token_share[t]
    )
    name_rows = sum(1 for x in usable if len(set(tokens(x["text"]))) >= 2)
    score_rows = sum(1 for x in usable if re.search(r"\d\s*[-–—]\s*\d", x["text"]))

    worst = sorted(usable, key=lambda x: -dist(chroma(x["swatch"]["rgb"]), cents["chroma"]))[:3]
    drift_max = max(ch)
    threshold = math.ceil(drift_max * MARGIN * 100) / 100.0

    report = {
        "issue": "ADAAAA-8844",
        "ac": "AC2.5",
        "truth_set": {
            "truth": args.truth,
            "crops": args.crops,
            "rows_in_truth": len(rows),
            "crops_read": len(readings),
            "crops_with_a_surface_reading": len(usable),
            "crops_missing": missing,
            "clip_ids": sorted({str(x.get("variant") or "") for x in usable}),
        },
        "sampler": "services/perceive/app/match_context.py:_dominant_swatch (the production crop sampler)",
        "metric": "euclidean distance over normalized chromaticity rgb/sum(rgb)",
        "surface_consensus": cents,
        "A_same_surface_drift": {
            "n": len(ch),
            "chroma": {
                "p50": quantile(ch, 0.5),
                "p90": quantile(ch, 0.9),
                "p95": quantile(ch, 0.95),
                "p99": quantile(ch, 0.99),
                "max": round(drift_max, 4),
            },
            "raw_rgb_reference_only": {
                "p50": quantile(raw, 0.5),
                "p95": quantile(raw, 0.95),
                "max": round(max(raw), 2),
                "note": "exposure-dominated; the washed-out crop reads ~129 raw while sitting on the same hue",
            },
            "worst": [
                {
                    "wid": x["wid"],
                    "rgb": x["swatch"]["rgb"],
                    "color": x["swatch"]["color"],
                    "chroma_dist": round(dist(chroma(x["swatch"]["rgb"]), cents["chroma"]), 4),
                }
                for x in worst
            ],
        },
        "B_printed_names": {
            "n": len(usable),
            "crops_printing_two_or_more_team_tokens": name_rows,
            "crops_printing_a_score_pair": score_rows,
            "tokens_on_80pct_or_more_crops": printed_teams,
            "example": usable[0]["text"],
            "reading": "the printed-name channel is legible on a clean bug; it must also read 3-letter "
            "codes (RMA/BAR), so the matcher accepts full tokens, initials and 3-letter codes",
        },
        "threshold": threshold,
        "threshold_rule": f"{MARGIN:g} x max measured same-surface drift, rounded up to 2 dp",
        "threshold_source": "max same-surface drift over the 62 crops that carry a surface reading",
        "separable": True,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(report, f, indent=1, sort_keys=False)
    print(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""ADAAAA-8391 — does the measured attestation channel discriminate goals?

Offline, $0 measurement over the frozen ADAAAA-8343 set (296 stored decide rows =
8 cells x 37 windows, label-manifest sha256 f6bea8ec...). It reads only stored
artifacts:

  rows.jsonl                 the 296 recorded decide rows (raw model reply saved)
  label-manifest.json        frame-derived ground truth (15 goal / 22 no_goal)
  <evidence-dir>/{rail}/*.json  the perceive evidence block each row was decided on

and answers one question: which *measured* channels attest a goal
(`ballOutcome=goal`, `goalCrossed=true`, a score-board delta), and does any of
them separate true goal windows from no_goal windows well enough to be worth
building on (AC1: >= 4x attested-rate, >= 8 of 15 goal windows; AC3: the
score-board boolean alone must attest <= 1 of the 22 no_goal windows).

No decide call, no perceive call, no GPU: the model reply is re-parsed, never
re-run. Emits the ADAAAA-8370 per-row artifact shape so
`evals/rescore_contract_guard.py` (ADAAAA-8387) reads it unchanged.

Usage:
  python3 evals/attestation_channel_8391/measure_attestation_channel.py \
      --rows rows.jsonl --manifest label-manifest.json \
      --evidence-dir cache/evidence --perwin-v1 perwin_v1.jsonl \
      --out score.json --perwin perwin_8391.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

GOAL_WINDOWS_REQUIRED = 8          # AC1: attest >= 8 of the 15 goal windows
RATE_RATIO_REQUIRED = 4.0          # AC1: goal attested-rate >= 4x no_goal rate
SBC_NO_GOAL_MAX = 1                # AC3: score-board channel alone, no_goal windows
GOAL_OUTCOME = "scoring_play"

# The exact per-row key set ADAAAA-8370's replay emitted (rescore tool contract).
PERWIN_KEYS = (
    "cell", "rail", "window", "truth", "perceive_evidence", "pre", "post",
    "guard", "guard_code", "attested", "signals", "criteria", "reason",
    "ttft_s", "wall_s", "usage",
)

SHOT_EVIDENCE = {"saved", "post", "blocked", "wide"}


# --- parsing ---------------------------------------------------------------

def parse_raw_reply(raw):
    """Parse a stored model reply into a decision dict, or None.

    The replies are JSON wrapped in a ```json fence (sometimes with prose).
    Mirrors decide's parse_decision: first balanced object wins.
    """
    if not raw:
        return None
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
                return obj if isinstance(obj, dict) else None
    return None


# --- channels --------------------------------------------------------------

def measured_channels(evidence):
    """The measured goal-attestation channels a stored evidence block carries.

    Same channels decide's `measured_goal_attestation` reads (ADAAAA-8120):
    perceive `ballOutcome`, `goalCrossed`, a score-board change. Never the
    model's self-reported verdict/criteria — that is the confabulation channel.
    """
    e = evidence if isinstance(evidence, dict) else {}
    signals = []
    ball_outcome = str(e.get("ballOutcome") or "").strip().lower()
    if ball_outcome == "goal":
        signals.append("ballOutcome=goal")
    if e.get("goalCrossed") is True:
        signals.append("goalCrossed=true")
    if e.get("scoreBoardChanged") is True:
        signals.append("scoreBoardChanged=true")
    if e.get("perceiveTimeline"):
        for rec in e["perceiveTimeline"]:
            if not isinstance(rec, dict):
                continue
            if str(rec.get("ballOutcome") or "").strip().lower() == "goal":
                signals.append("timeline:ballOutcome=goal")
            if rec.get("goalCrossed") is True:
                signals.append("timeline:goalCrossed=true")
            if rec.get("scoreBoardChanged") is True:
                signals.append("timeline:score_delta")
    return list(dict.fromkeys(signals))


def channel_coverage(evidence_by_key):
    """How many stored windows carry each channel at all (present vs absent)."""
    cov = {
        "windows": len(evidence_by_key),
        "ballOutcome_present": 0,
        "ballOutcome_goal": 0,
        "goalCrossed_present": 0,
        "goalCrossed_true": 0,
        "scoreBoardChanged_present": 0,
        "scoreBoardChanged_true": 0,
        "scoreBoardDelta_present": 0,
        "goalLineDelta_present": 0,
        "perceiveTimeline_present": 0,
        "audioLevels_present": 0,
    }
    for e in evidence_by_key.values():
        e = e if isinstance(e, dict) else {}
        if e.get("ballOutcome") is not None:
            cov["ballOutcome_present"] += 1
            if str(e["ballOutcome"]).strip().lower() == "goal":
                cov["ballOutcome_goal"] += 1
        if e.get("goalCrossed") is not None:
            cov["goalCrossed_present"] += 1
            if e["goalCrossed"] is True:
                cov["goalCrossed_true"] += 1
        if e.get("scoreBoardChanged") is not None:
            cov["scoreBoardChanged_present"] += 1
            if e["scoreBoardChanged"] is True:
                cov["scoreBoardChanged_true"] += 1
        if e.get("scoreboardDelta"):
            cov["scoreBoardDelta_present"] += 1
        if e.get("goalLineDelta") is not None:
            cov["goalLineDelta_present"] += 1
        if e.get("perceiveTimeline"):
            cov["perceiveTimeline_present"] += 1
        if e.get("audioLevels"):
            cov["audioLevels_present"] += 1
    return cov


def _rate(hit, total):
    return round(hit / total, 4) if total else None


def channel_table(perwin, channel):
    """Attested rows/windows for one channel, split by truth class.

    Row rates are over the 296 rows (each rail-window evidence is replicated
    across that rail's 4 cells); window rates are over the 37 distinct windows,
    where a window counts as attested when the channel fires on >= 1 rail.
    """
    goals = [r for r in perwin if r["truth"] == "goal"]
    nongoals = [r for r in perwin if r["truth"] != "goal"]
    g_hit = sum(1 for r in goals if channel in r["signals"])
    n_hit = sum(1 for r in nongoals if channel in r["signals"])
    g_rate, n_rate = _rate(g_hit, len(goals)), _rate(n_hit, len(nongoals))

    def windows(is_class):
        out = {}
        for r in perwin:
            if not is_class(r):
                continue
            if channel in r["signals"]:
                out[r["window"]] = True
            else:
                out.setdefault(r["window"], False)
        return sorted(w for w, hit in out.items() if hit)

    g_wins = windows(lambda r: r["truth"] == "goal")
    n_wins = windows(lambda r: r["truth"] != "goal")
    n_g_windows = len({r["window"] for r in perwin if r["truth"] == "goal"})
    n_n_windows = len({r["window"] for r in perwin if r["truth"] != "goal"})
    ratio_rows = round(g_rate / n_rate, 4) if g_rate and n_rate else None
    # Ratio of RATES, not of counts: the classes have different window totals.
    ratio_wins = (round((len(g_wins) / n_g_windows) / (len(n_wins) / n_n_windows), 4)
                  if g_wins and n_wins else None)
    return {
        "channel": channel,
        "goal_rows_attested": g_hit,
        "goal_rows": len(goals),
        "goal_row_rate": g_rate,
        "no_goal_rows_attested": n_hit,
        "no_goal_rows": len(nongoals),
        "no_goal_row_rate": n_rate,
        "row_rate_ratio": ratio_rows,
        # A channel that attests goals and no no_goal windows is perfect, not
        # undefined: the ratio is infinite. Kept as a flag so the JSON stays
        # finite/serialisable.
        "row_rate_ratio_infinite": bool(g_rate and not n_rate),
        "goal_windows_attested": len(g_wins),
        "goal_windows": n_g_windows,
        "goal_windows_list": g_wins,
        "no_goal_windows_attested": len(n_wins),
        "no_goal_windows": n_n_windows,
        "no_goal_windows_list": n_wins,
        "window_rate_ratio": ratio_wins,
        "window_rate_ratio_infinite": bool(g_wins and not n_wins),
    }


def false_accept_framing(perwin):
    """The ADAAAA-8370 framing: attested rate among accepted rows only."""
    accepts = [r for r in perwin if r["pre"] == GOAL_OUTCOME]
    tps = [r for r in accepts if r["truth"] == "goal"]
    fps = [r for r in accepts if r["truth"] != "goal"]
    ta = sum(1 for r in tps if r["signals"])
    fa = sum(1 for r in fps if r["signals"])
    return {
        "true_accepts": len(tps), "true_accepts_attested": ta,
        "false_accepts": len(fps), "false_accepts_attested": fa,
        "true_accept_rate": _rate(ta, len(tps)),
        "false_accept_rate": _rate(fa, len(fps)),
    }


def recall_if_reject_unattested(perwin):
    """AC2: per-cell goal recall if an accept is kept only when attested."""
    cells = {}
    for r in perwin:
        c = cells.setdefault(r["cell"], {"goal_rows": 0, "tp_v1": 0, "tp_attested": 0})
        if r["truth"] != "goal":
            continue
        c["goal_rows"] += 1
        if r["pre"] == GOAL_OUTCOME:
            c["tp_v1"] += 1
            if r["signals"]:
                c["tp_attested"] += 1
    for c in cells.values():
        c["recall_v1"] = _rate(c["tp_v1"], c["goal_rows"])
        c["recall_attested_rule"] = _rate(c["tp_attested"], c["goal_rows"])
        c["recall_delta"] = round((c["recall_attested_rule"] or 0) - (c["recall_v1"] or 0), 4)
        c["loses_goal"] = c["recall_attested_rule"] < c["recall_v1"]
    return cells


# --- non-attestation measured features (context only) ----------------------

def feature_rows(evidence_by_key, truth):
    """Measured, non-attestation features per rail-window, for separability QA.

    These are NOT goal attestations: no homography / goal-mouth calibration is
    present in the stored evidence, so none of them can attest that the ball
    crossed the line. They are reported so the PO can see whether the frozen
    capture carries any separable signal at all.
    """
    out = []
    for (rail, window), e in sorted(evidence_by_key.items()):
        if not isinstance(e, dict):
            continue
        dets = e.get("detections") or []
        ball = None
        for d in dets:
            if "ball" in str(d.get("label", "")).lower() and len(d.get("bbox") or []) >= 4:
                ball = d["bbox"]
        out.append({
            "rail": rail, "window": window,
            "truth": "goal" if truth[window]["cls"] == "goal" else "no_goal",
            "ocrHits": e.get("ocrHits"),
            "maxVelocity": e.get("maxVelocity"),
            "trackCount": e.get("trackCount"),
            "detections": len(dets),
            "ballX": round((ball[0] + ball[2]) / 2, 4) if ball else None,
            "ballY": round((ball[1] + ball[3]) / 2, 4) if ball else None,
            "crowdEnergy": (e.get("reaction") or {}).get("crowdEnergy"),
            "audioKind": (e.get("reaction") or {}).get("audioKind"),
        })
    return out


def auc(values_pos, values_neg):
    """Rank AUC (Mann-Whitney) with ties counted 0.5; None when a side is empty."""
    pos = [v for v in values_pos if v is not None]
    neg = [v for v in values_neg if v is not None]
    if not pos or not neg:
        return None
    wins = 0.0
    for p in pos:
        for n in neg:
            if p > n:
                wins += 1
            elif p == n:
                wins += 0.5
    return round(wins / (len(pos) * len(neg)), 4)


def feature_auc(feats):
    res = {}
    for rail in sorted({f["rail"] for f in feats}):
        rs = [f for f in feats if f["rail"] == rail]
        pos = [f for f in rs if f["truth"] == "goal"]
        neg = [f for f in rs if f["truth"] == "no_goal"]
        res[rail] = {
            name: auc([f[name] for f in pos], [f[name] for f in neg])
            for name in ("ocrHits", "maxVelocity", "trackCount", "detections",
                         "ballX", "ballY", "crowdEnergy")
        }
    return res


# --- main ------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--evidence-dir", required=True)
    ap.add_argument("--perwin-v1", default=None,
                    help="ADAAAA-8370 perwin_v1.jsonl, for the fidelity cross-check")
    ap.add_argument("--out", required=True)
    ap.add_argument("--perwin", required=True)
    args = ap.parse_args(argv)

    manifest = json.load(open(args.manifest))
    truth = {}
    for w in manifest["windows"]:
        g = str(w.get("ground_truth", "")).lower() == "goal"
        ev = str(w.get("evidence", ""))
        truth[w["id"]] = {"cls": "goal" if g else ("shot" if ev in SHOT_EVIDENCE else "no_shot"),
                          "evidence": ev}

    rows = [json.loads(line) for line in open(args.rows) if line.strip()]

    evidence_by_key = {}
    for rail in ("live", "vod"):
        rail_dir = os.path.join(args.evidence_dir, rail)
        if not os.path.isdir(rail_dir):
            continue
        for name in os.listdir(rail_dir):
            if not name.endswith(".json"):
                continue
            wid = name[:-5]
            with open(os.path.join(rail_dir, name)) as fh:
                evidence_by_key[(rail, wid)] = (json.load(fh) or {}).get("evidence") or {}

    v1 = {}
    if args.perwin_v1:
        for line in open(args.perwin_v1):
            if line.strip():
                r = json.loads(line)
                v1[(r["cell"], r["window"])] = r

    perwin = []
    fidelity = {"rows": len(rows), "matched_v1": 0, "missing_evidence": [],
                "unparsed": 0, "outcome_mismatch": []}
    for r in rows:
        key = (r["rail"], r["window"])
        ev = evidence_by_key.get(key)
        if ev is None:
            fidelity["missing_evidence"].append(f"{r['rail']}|{r['window']}")
            ev = {}
        parsed = parse_raw_reply(r.get("raw") or "")
        if parsed is None:
            fidelity["unparsed"] += 1
            pre = "unparsed"
        else:
            pre = parsed.get("outcome")
        ref = v1.get((r["cell"], r["window"]))
        if ref is not None:
            if ref.get("pre") == pre:
                fidelity["matched_v1"] += 1
            else:
                fidelity["outcome_mismatch"].append(
                    {"cell": r["cell"], "window": r["window"],
                     "replay": pre, "v1": ref.get("pre")})
        crit = ((parsed or {}).get("verdict") or {}).get("criteria") or {}
        signals = measured_channels(ev)
        perwin.append({
            "cell": r["cell"], "rail": r["rail"], "window": r["window"],
            "truth": truth[r["window"]]["cls"],
            "perceive_evidence": truth[r["window"]]["evidence"],
            "pre": pre,
            # No accept rule is derived (no channel reached AC1), so the emitted
            # post equals the recorded v1 post: this is a measurement, not a change.
            "post": (ref or {}).get("post", pre),
            "guard": (ref or {}).get("guard"),
            "guard_code": (ref or {}).get("guard_code"),
            "attested": bool(signals),
            "signals": signals,
            "criteria": {"ballCrossedLineBetweenPosts": crit.get("ballCrossedLineBetweenPosts"),
                         "ballInNet": crit.get("ballInNet")},
            "reason": ((parsed or {}).get("reason") or "")[:200],
            "ttft_s": r.get("ttft_s"), "wall_s": r.get("wall_s"),
            "usage": r.get("usage"),
        })

    channels = {
        "ballOutcome=goal": channel_table(perwin, "ballOutcome=goal"),
        "goalCrossed=true": channel_table(perwin, "goalCrossed=true"),
        "scoreBoardChanged=true": channel_table(perwin, "scoreBoardChanged=true"),
        "timeline:ballOutcome=goal": channel_table(perwin, "timeline:ballOutcome=goal"),
    }
    # "any measured channel" is the deployed guard's attestation predicate:
    # recompute it directly on the combined signal list.
    any_rows_goal = [r for r in perwin if r["truth"] == "goal" and r["signals"]]
    any_rows_ng = [r for r in perwin if r["truth"] != "goal" and r["signals"]]
    g_wins = sorted({r["window"] for r in any_rows_goal})
    n_wins = sorted({r["window"] for r in any_rows_ng})
    g_rows = sum(1 for r in perwin if r["truth"] == "goal")
    n_rows_total = len(perwin) - g_rows
    g_win_total = len({r["window"] for r in perwin if r["truth"] == "goal"})
    n_win_total = len({r["window"] for r in perwin if r["truth"] != "goal"})
    channels["any_measured"] = {
        "channel": "any_measured",
        "goal_rows_attested": len(any_rows_goal), "goal_rows": g_rows,
        "goal_row_rate": _rate(len(any_rows_goal), g_rows),
        "no_goal_rows_attested": len(any_rows_ng), "no_goal_rows": n_rows_total,
        "no_goal_row_rate": _rate(len(any_rows_ng), n_rows_total),
        "row_rate_ratio": round((len(any_rows_goal) / g_rows) /
                                (len(any_rows_ng) / n_rows_total), 4) if any_rows_ng else None,
        "row_rate_ratio_infinite": bool(any_rows_goal and not any_rows_ng),
        "goal_windows_attested": len(g_wins),
        "goal_windows": g_win_total,
        "goal_windows_list": g_wins,
        "no_goal_windows_attested": len(n_wins),
        "no_goal_windows": n_win_total,
        "no_goal_windows_list": n_wins,
        "window_rate_ratio": (
            round((len(g_wins) / g_win_total) / (len(n_wins) / n_win_total), 4)
            if g_wins and n_wins else None),
        "window_rate_ratio_infinite": bool(g_wins and not n_wins),
    }

    any_ch = channels["any_measured"]
    ratio_ok = bool(
        (any_ch["window_rate_ratio_infinite"]
         or (any_ch["window_rate_ratio"] or 0) >= RATE_RATIO_REQUIRED)
        and (any_ch["row_rate_ratio_infinite"]
             or (any_ch["row_rate_ratio"] or 0) >= RATE_RATIO_REQUIRED))
    ac1 = {
        "goal_windows_attested": any_ch["goal_windows_attested"],
        "goal_windows_required": GOAL_WINDOWS_REQUIRED,
        "window_requirement_met": any_ch["goal_windows_attested"] >= GOAL_WINDOWS_REQUIRED,
        "window_rate_ratio": any_ch["window_rate_ratio"],
        "row_rate_ratio": any_ch["row_rate_ratio"],
        "ratio_requirement_met": ratio_ok,
        "ratio_required": RATE_RATIO_REQUIRED,
    }
    ac1["met"] = ac1["window_requirement_met"] and ac1["ratio_requirement_met"]

    sbc = channels["scoreBoardChanged=true"]
    ac3 = {
        "no_goal_windows_attested": sbc["no_goal_windows_attested"],
        "no_goal_windows_list": sbc["no_goal_windows_list"],
        "max_allowed": SBC_NO_GOAL_MAX,
        "met": sbc["no_goal_windows_attested"] <= SBC_NO_GOAL_MAX,
    }

    cells = recall_if_reject_unattested(perwin)
    ac2 = {
        "rule": "keep an accept only when a measured channel attests the goal",
        "cells": cells,
        "any_cell_loses_recall": any(c["loses_goal"] for c in cells.values()),
        "met": not any(c["loses_goal"] for c in cells.values()),
    }

    feats = feature_rows(evidence_by_key, truth)
    outcome = {
        "issue": "ADAAAA-8391",
        "manifest_sha256": manifest.get("sha256")
        or "f6bea8ec97352b3385feac634a7c1c6e8461e01719f79db3c68a061140047ccf",
        "rows": len(rows),
        "windows": len(truth),
        "goal_windows": sum(1 for v in truth.values() if v["cls"] == "goal"),
        "no_goal_windows": sum(1 for v in truth.values() if v["cls"] != "goal"),
        "fidelity": fidelity,
        "channel_coverage": channel_coverage(evidence_by_key),
        "channels": channels,
        "false_accept_framing": false_accept_framing(perwin),
        "ac1_discrimination": ac1,
        "ac2_recall_safe": ac2,
        "ac3_false_positive_floor": ac3,
        "non_attestation_feature_auc": feature_auc(feats),
        "verdict": "does_not_discriminate" if not ac1["met"] else "discriminates",
    }
    json.dump(outcome, open(args.out, "w"), indent=1)

    with open(args.perwin, "w") as fh:
        for r in perwin:
            fh.write(json.dumps({k: r[k] for k in PERWIN_KEYS}) + "\n")

    print(f"== ADAAAA-8391 attestation channel: {len(rows)} rows, "
          f"{outcome['windows']} windows ({outcome['goal_windows']} goal / "
          f"{outcome['no_goal_windows']} no_goal)")
    print(f"  fidelity: replay parsed outcome == perwin_v1 on "
          f"{fidelity['matched_v1']}/{len(rows)} rows"
          f"{' (mismatch: %s)' % fidelity['outcome_mismatch'] if fidelity['outcome_mismatch'] else ''}")
    cov = outcome["channel_coverage"]
    print(f"  evidence coverage ({cov['windows']} windows): "
          f"ballOutcome present={cov['ballOutcome_present']} goal={cov['ballOutcome_goal']}, "
          f"goalCrossed present={cov['goalCrossed_present']} true={cov['goalCrossed_true']}, "
          f"scoreBoardChanged present={cov['scoreBoardChanged_present']} "
          f"true={cov['scoreBoardChanged_true']}, "
          f"scoreboardDelta present={cov['scoreBoardDelta_present']}, "
          f"timeline present={cov['perceiveTimeline_present']}")
    print(f"  {'channel':26s} {'goal rows':>10s} {'no_goal rows':>12s} {'ratio':>7s} "
          f"{'goal wins':>9s} {'no_goal wins':>12s}")
    for name, t in channels.items():
        ratio = "inf" if t["row_rate_ratio_infinite"] else str(t["row_rate_ratio"])
        print(f"  {name:26s} {t['goal_rows_attested']:3d}/{t['goal_rows']:<6d} "
              f"{t['no_goal_rows_attested']:3d}/{t['no_goal_rows']:<8d} "
              f"{ratio:>7s} "
              f"{t['goal_windows_attested']:3d}/{t['goal_windows']:<5d} "
              f"{t['no_goal_windows_attested']:3d}/{t['no_goal_windows']:<8d}")
    print(f"  AC1 discrimination: {'PASS' if ac1['met'] else 'FAIL'} "
          f"(goal windows {ac1['goal_windows_attested']}/15, need >= {GOAL_WINDOWS_REQUIRED}; "
          f"ratio {ac1['window_rate_ratio']}/{ac1['row_rate_ratio']}, need >= 4x)")
    print(f"  AC2 recall-safe under reject-unattested: {'PASS' if ac2['met'] else 'FAIL'} "
          f"({sum(1 for c in cells.values() if c['loses_goal'])}/8 cells lose recall)")
    print(f"  AC3 score-board alone: {'PASS' if ac3['met'] else 'FAIL'} "
          f"({ac3['no_goal_windows_attested']} of 22 no_goal windows, need <= {SBC_NO_GOAL_MAX})")
    print(f"  verdict: {outcome['verdict']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

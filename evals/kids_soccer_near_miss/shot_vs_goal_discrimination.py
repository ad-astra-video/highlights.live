#!/usr/bin/env python3
"""Measure which confirm-stage signals separate shot-class FPs from goals.

ADAAAA-7687 asks for a confirm-stage rule that rejects the four shot-window
false positives (`178.1, 203.2, 358.8, 401.7`) plus the `evidence:none` FP at
`252.6` without touching the fifteen labelled goals. Before writing such a rule
into `services/decide/app/confirm.py` this harness measures, **from the
persisted job detail alone**, how much each candidate confirm-stage rule would
actually buy — no GPU pass, no re-inference.

Every feature here is data the pipeline already had at decide/confirm time:

- the accepted card's provenance (`localizeSignal`, trigger kind, trigger ts),
- the persisted corroboration anchor (`corroborationSource`) and verdict
  (`goalConfirmed`, `stage1Disagreed`),
- the per-window Stage-1 criteria the decide read returned,
- the confirm-pass verdict of every 3 s window in the neighbourhood, read from
  the persisted decide-note reason annotation (`confirmation pass: goal
  confirmed / near miss / not a goal`),
- the cached ball trajectory around the accepted instant.

Rules are evaluated as *rejection* rules over the accepted set: precision and
recall are recomputed against the manifest with the same matching semantics as
`score_goal_precision.py`, so a rule's number is directly comparable to the
build's scored precision.

A rule is only usable when it keeps every labelled goal (recall 1.0) and lifts
precision past the AC-1 bar of 0.94. The `oracle` row rejects exactly the known
FPs and is reported only as the ceiling.

Usage
-----
  python3 evals/kids_soccer_near_miss/shot_vs_goal_discrimination.py \
      --manifest evals/kids_soccer_near_miss/label-manifest.json \
      --job-detail /tmp/job_detail_ac6bf37f-*.json \
      --commit da2d21a \
      --json evals/kids_soccer_near_miss/results/shot_vs_goal_discrimination.json
"""
import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from score_goal_precision import accepted_windows, goal_windows, overlap  # noqa: E402

# The five accepted FPs measured on build da2d21a (ADAAAA-7687).
KNOWN_FPS = (178.1, 203.2, 252.6, 358.8, 401.7)

# Confirm-pass verdict annotations persisted on each decide note's reason text
# (`confirm.py` builds them: "confirmation pass: goal confirmed ..." / "...near
# miss..." / "...not a goal...").
CONFIRM_GOAL = "confirmation pass: goal confirmed"
CONFIRM_NEAR = "confirmation pass: near miss"
CONFIRM_NOT = "confirmation pass: not a goal"

CLUSTER_WINDOW_S = 15.0
BALL_WINDOW_PRE_S = 1.5
BALL_WINDOW_POST_S = 8.0


def _confirm_verdict(note):
    """Confirm-pass verdict for one persisted decide note, or '-' when the dive
    never ran on that window."""
    reason = note.get("reason") or ""
    if CONFIRM_GOAL in reason:
        return "goal"
    if CONFIRM_NEAR in reason:
        return "near_miss"
    if CONFIRM_NOT in reason:
        return "not_goal"
    return "-"


def _stage1_criteria(note):
    """The Stage-1 verdict criteria the decide read returned for a note."""
    resp = ((note.get("analysis") or {}).get("response"))
    if isinstance(resp, str):
        try:
            resp = json.loads(resp)
        except ValueError:
            return {}
    if not isinstance(resp, dict):
        return {}
    verdict = resp.get("verdict")
    if not isinstance(verdict, dict):
        return {}
    crit = verdict.get("criteria")
    return crit if isinstance(crit, dict) else {}


def _stage1_outcome(note):
    resp = ((note.get("analysis") or {}).get("response"))
    if isinstance(resp, str):
        try:
            resp = json.loads(resp)
        except ValueError:
            return None
    if isinstance(resp, dict):
        return resp.get("outcome")
    return None


def _notes(detail):
    out = []
    for section in detail.get("sections") or []:
        for note in section.get("decideNotes") or []:
            out.append(note)
    out.sort(key=lambda n: float(n.get("timestamp") or 0.0))
    return out


def _frames(detail):
    out = []
    for section in detail.get("sections") or []:
        out.extend(section.get("frames") or [])
    out.sort(key=lambda f: float(f.get("timestamp") or 0.0))
    return out


def _ball_path(frames, t0, t1):
    """Cached ball-track centre path inside [t0, t1] (on-screen points only)."""
    pts = []
    for frame in frames:
        ts = float(frame.get("timestamp") or 0.0)
        if ts < t0 or ts > t1:
            continue
        for track in frame.get("tracks") or []:
            if track.get("kind") != "ball":
                continue
            bbox = track.get("bbox") or []
            if len(bbox) < 4:
                continue
            if track.get("onScreen") is False:
                break
            pts.append((ts, (bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0))
            break
    return pts


def _path_length(pts):
    return sum(
        math.hypot(pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2])
        for i in range(1, len(pts))
    )


def _label_for(card, goals):
    """Ground-truth label for an accepted card (same semantics as the scorer)."""
    for gw in goals:
        ov = overlap(card["start"], card["end"],
                     float(gw["t_start"]), float(gw["t_end"]))
        near = (gw.get("instant") is not None
                and abs(card["t"] - float(gw["instant"])) <= 10.0)
        if ov >= 1.0 or near:
            return gw["id"]
    return None


def card_features(detail, card, goals):
    """Every confirm-stage feature for one accepted card, from persisted data."""
    notes = detail["_notes"]
    frames = detail["_frames"]
    t = card["t"]
    trig_ts = None
    trig_kind = None
    localize = None
    source = None
    goal_confirmed = None
    for h in detail.get("highlights") or []:
        if h.get("id") == card["id"]:
            trig = h.get("trigger") or {}
            trig_ts = trig.get("timestamp")
            trig_kind = trig.get("kind")
            localize = h.get("localizeSignal")
            source = h.get("corroborationSource")
            goal_confirmed = h.get("goalConfirmed")
            break

    # The decide note for this card's trigger window carries the Stage-1 read.
    note = None
    if trig_ts is not None:
        for n in notes:
            if abs(float(n.get("timestamp") or 0.0) - float(trig_ts)) < 0.01:
                note = n
                break
    crit = _stage1_criteria(note) if note else {}
    outcome = _stage1_outcome(note) if note else None

    cluster = [n for n in notes if abs(float(n.get("timestamp") or 0.0) - t) <= CLUSTER_WINDOW_S]
    prior = [n for n in notes
             if trig_ts is not None
             and -CLUSTER_WINDOW_S <= float(n.get("timestamp") or 0.0) - float(trig_ts) < 0.0]
    verdicts = [_confirm_verdict(n) for n in cluster]
    goal_share = (verdicts.count("goal") / len(verdicts)) if verdicts else 0.0
    prior_goal_shaped = sum(1 for n in prior if _stage1_outcome(n) == "scoring_play")

    path = _ball_path(frames, t - BALL_WINDOW_PRE_S, t + BALL_WINDOW_POST_S)

    return {
        "t": round(t, 1),
        "window": [round(card["start"], 1), round(card["end"], 1)],
        "goal_label": _label_for(card, goals),
        "localizeSignal": localize,
        "triggerTs": trig_ts,
        "triggerKind": trig_kind,
        "corroborationSource": source,
        "goalConfirmed": goal_confirmed,
        "stage1Outcome": outcome,
        "stage1Criteria": {
            "ballInNet": crit.get("ballInNet"),
            "ballCrossedLineBetweenPosts": crit.get("ballCrossedLineBetweenPosts"),
            "scoreboardChanged": crit.get("scoreboardChanged"),
            "crowdErupted": crit.get("crowdErupted"),
        },
        "clusterWindows": len(cluster),
        "clusterConfirmVerdicts": {
            "goal": verdicts.count("goal"),
            "near_miss": verdicts.count("near_miss"),
            "not_goal": verdicts.count("not_goal"),
            "none": verdicts.count("-"),
        },
        "clusterGoalShare": round(goal_share, 3),
        "priorGoalShapedReads": prior_goal_shaped,
        "postEventBallPathLen": round(_path_length(path), 3),
        "postEventBallPoints": len(path),
    }


# --- candidate rejection rules ----------------------------------------------
#
# Each rule is `(name, description, fn)`; fn(card_features) -> True means the
# rule REJECTS that accepted card at the confirm stage.

RULES = [
    ("none", "baseline: accept everything the build accepts", lambda f: False),
    ("reject_frame_attestation",
     "blanket: a frame_attestation-only accept is not independent corroboration",
     lambda f: f["corroborationSource"] == "frame_attestation"),
    ("reject_scoreboard_trigger_no_confirm",
     "a score_change trigger accepted without a confirm dive",
     lambda f: f["corroborationSource"] is None and f["triggerKind"] == "score_change"),
    ("reject_cluster_non_goal_majority",
     "the action's own window cluster is majority not-a-goal",
     lambda f: f["clusterWindows"] >= 3 and f["clusterGoalShare"] < 0.5),
    ("reject_no_prior_goal_read",
     "no goal-shaped Stage-1 read in the 15 s before the accepted instant",
     lambda f: f["priorGoalShapedReads"] == 0),
    ("reject_ball_stays_in_play",
     "cached ball track keeps travelling after the instant (play continued)",
     lambda f: f["postEventBallPoints"] >= 8 and f["postEventBallPathLen"] > 1.5),
    ("reject_no_crowd_criteria",
     "Stage-1 criteria did not record a crowd eruption",
     lambda f: f["stage1Criteria"].get("crowdErupted") is False),
    ("oracle_reject_known_fps",
     "ceiling only: rejects exactly the five FPs named on ADAAAA-7687",
     lambda f: round(f["t"], 1) in KNOWN_FPS),
]


def evaluate(features, rule):
    kept = [f for f in features if not rule(f)]
    n = len(kept)
    tp = sum(1 for f in kept if f["goal_label"] is not None)
    goals_credited = {f["goal_label"] for f in kept if f["goal_label"] is not None}
    all_goals = {f["goal_label"] for f in features if f["goal_label"] is not None}
    return {
        "accepted": n,
        "true_positive_cards": tp,
        "precision": round(tp / n, 4) if n else None,
        "recall_vs_accepted_goals": round(len(goals_credited) / len(all_goals), 4) if all_goals else None,
        "rejected": [f["t"] for f in features if rule(f)],
        "rejected_goal_cards": [f["t"] for f in features
                                if rule(f) and f["goal_label"] is not None],
    }


def analyse(manifest, detail, commit=None):
    goals = goal_windows(manifest)
    accepted = accepted_windows(detail)
    ctx = dict(detail)
    ctx["_notes"] = _notes(detail)
    ctx["_frames"] = _frames(detail)
    features = [card_features(ctx, card, goals) for card in accepted]

    baseline = evaluate(features, RULES[0][2])
    results = []
    for name, desc, fn in RULES:
        res = evaluate(features, fn)
        res["rule"] = name
        res["description"] = desc
        res["meets_ac1"] = bool(
            res["precision"] is not None
            and res["precision"] >= 0.94
            and res["recall_vs_accepted_goals"] == 1.0
        )
        results.append(res)

    return {
        "commit": commit,
        "job_id": (detail.get("job") or {}).get("id"),
        "accepted_cards": len(features),
        "goal_cards": baseline["true_positive_cards"],
        "false_positive_cards": baseline["accepted"] - baseline["true_positive_cards"],
        "baseline": baseline,
        "cards": features,
        "rules": results,
        "usable_rules": [r["rule"] for r in results if r["meets_ac1"] and r["rule"] != "oracle_reject_known_fps"],
    }


def render(result):
    lines = [
        f"# shot-vs-goal discrimination at the confirm stage — {result['commit'] or 'unlabelled'}",
        f"job: {result['job_id']}",
        "",
        f"accepted cards: {result['accepted_cards']} "
        f"({result['goal_cards']} goal / {result['false_positive_cards']} FP)",
        "",
        "## per-card features",
        f"{'t':>7}  {'label':11}  {'source':17}  {'verdict':14}  "
        f"{'clustG':>6} {'share':>5} {'prior':>5} {'ball':>5}",
    ]
    for f in result["cards"]:
        lines.append(
            f"{f['t']:>7}  {str(f['goal_label'] or 'FP'):11}  "
            f"{str(f['corroborationSource']):17}  {str(f['goalConfirmed']):14}  "
            f"{f['clusterConfirmVerdicts']['goal']:>6} {f['clusterGoalShare']:>5} "
            f"{f['priorGoalShapedReads']:>5} {f['postEventBallPathLen']:>5}"
        )
    lines += ["", "## candidate rules",
              f"{'rule':38}  {'acc':>3} {'prec':>6} {'rec':>5}  rejects"]
    for r in result["rules"]:
        prec = f"{r['precision']:.2%}" if r["precision"] is not None else "n/a"
        rec = f"{r['recall_vs_accepted_goals']:.2%}" if r["recall_vs_accepted_goals"] is not None else "n/a"
        lines.append(f"{r['rule']:38}  {r['accepted']:>3} {prec:>6} {rec:>5}  {r['rejected']}")
    lines += ["", f"usable rules (precision >= 0.94 at recall 1.0): {result['usable_rules'] or 'none'}"]
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Measure confirm-stage shot-vs-goal discrimination on a job detail.")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--job-detail", required=True)
    ap.add_argument("--commit", default=None)
    ap.add_argument("--json", default=None)
    args = ap.parse_args(argv)

    manifest = json.load(open(args.manifest))
    detail = json.load(open(args.job_detail))
    result = analyse(manifest, detail, args.commit)
    print(render(result))
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(result, fh, indent=2)
            fh.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

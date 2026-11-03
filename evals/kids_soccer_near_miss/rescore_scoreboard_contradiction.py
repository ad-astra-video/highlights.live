#!/usr/bin/env python3
"""AC4 (ADAAAA-7844): re-score the fixture bank for scoreboard-contradicted GOALs.

The defect: a highlight could be accepted with ``corroborationSource:
"scoreboard"`` while the window's own frame attestation (its Stage-1 criteria)
read ``scoreboardChanged: false`` — job dee44c2f, window ts 117. The fix requires
a legible, time-tied MEASURED delta (both sides parsed, >= 2 OCR samples each)
that the window's own frames do not contradict; otherwise the scoreboard branch
cannot corroborate and the card is either re-labelled to the evidence that did
credit it (two-signal frame attestation) or downgraded to near_miss.

This harness re-scores the COMMITTED fixture bank, no GPU / network / box:

- ``tests/fixtures/job_detail_ac6bf37f_slim.json`` — the guarded build's job
  detail (decide notes with each window's Stage-1 criteria, and the accepted
  highlights);
- ``results/ac3_guard_ab.json`` — the recorded per-card ``corroborationSource``
  for the guarded (``da2d21a``) and reverted-guard control builds;
- ``label-manifest.json`` — frame-derived ground truth.

It reports, before and after the fix:

- ``contradicted_goal_cards`` — accepted GOALs whose corroboration source is
  "scoreboard" while the window's frames say the score did not change;
- the re-scored accepted set (cards that lose their only anchor are dropped) and
  the precision/recall of both sets under the manifest's matching rule.

Usage
-----
  python3 evals/kids_soccer_near_miss/rescore_scoreboard_contradiction.py \
      --json evals/kids_soccer_near_miss/results/rescore_7844.json
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from score_goal_precision import goal_windows, overlap  # noqa: E402

DEFAULT_FIXTURE = os.path.join(HERE, "tests/fixtures/job_detail_ac6bf37f_slim.json")
DEFAULT_GUARD_AB = os.path.join(HERE, "results/ac3_guard_ab.json")
DEFAULT_MANIFEST = os.path.join(HERE, "label-manifest.json")

NOTE_MATCH_TOLERANCE_S = 1.5


def _load(path):
    with open(path) as fh:
        return json.load(fh)


def notes_by_ts(detail):
    """Decide notes indexed by their window timestamp (rounded to 2 dp)."""
    out = {}
    for section in detail.get("sections") or []:
        for note in section.get("decideNotes") or []:
            ts = note.get("timestamp")
            if ts is None:
                continue
            out.setdefault(round(float(ts), 2), note)
    return out


def note_criteria(note):
    """The Stage-1 criteria the window's own frames produced."""
    resp = ((note or {}).get("analysis") or {}).get("response") or {}
    verdict = resp.get("verdict") or {}
    crit = verdict.get("criteria") or {}
    return crit if isinstance(crit, dict) else {}


def nearest_note(notes, t, tolerance=NOTE_MATCH_TOLERANCE_S):
    if t is None:
        return None
    best, best_d = None, None
    for ts, note in notes.items():
        d = abs(ts - float(t))
        if d <= tolerance and (best_d is None or d < best_d):
            best, best_d = note, d
    return best


def accepted_cards(detail):
    """Accepted GOAL cards as (t, start, end, id) — the scorer's normal form."""
    out = []
    for h in detail.get("highlights") or []:
        if (h.get("status") or "") != "accepted":
            continue
        if (h.get("eventType") or "").upper() != "GOAL":
            continue
        start, end = float(h["start"]), float(h["end"])
        t = float(h.get("localizedTs", (start + end) / 2))
        out.append({"t": t, "start": start, "end": end, "id": h.get("id")})
    out.sort(key=lambda c: c["t"])
    return out


def _score_card(card, goals, min_overlap=1.0, instant_tolerance=10.0):
    """True when the card credits a ground-truth goal (TP), else False (FP)."""
    for gw in goals:
        ov = overlap(card["start"], card["end"], float(gw["t_start"]), float(gw["t_end"]))
        near = (
            gw.get("instant") is not None
            and abs(card["t"] - float(gw["instant"])) <= instant_tolerance
        )
        if ov >= min_overlap or near:
            return True
    return False


def rescore(cards, notes, goals):
    """Apply the ADAAAA-7844 rule to one accepted set.

    ``cards`` carry ``corroborationSource`` (recorded build) + the frame
    attestation from the nearest note. Returns the before/after rows.
    """
    rows = []
    for card in cards:
        note = nearest_note(notes, card.get("trigger_ts", card["t"]))
        crit = note_criteria(note)
        frames_say_no_change = crit.get("scoreboardChanged") is False
        frames_say_changed = crit.get("scoreboardChanged") is True
        two_signal = crit.get("ballInNet") is True and crit.get("ballCrossedLineBetweenPosts") is True
        source = card.get("corroborationSource")
        tp = _score_card(card, goals)
        # The fixed rule: "scoreboard" needs a legible measured delta that the
        # window's own frames do not contradict. In the recorded fixture the
        # cards predate the delta field, so a card whose frames say the score did
        # not change cannot keep the label; it falls back to the evidence that
        # actually credited it.
        if source == "scoreboard" and frames_say_no_change:
            new_source = "frame_attestation" if two_signal else None
            dropped = new_source is None
        else:
            new_source = source
            dropped = False
        rows.append({
            "t": round(card["t"], 1),
            "window": [round(card["start"], 1), round(card["end"], 1)],
            "source": source,
            "frames_scoreboardChanged": crit.get("scoreboardChanged"),
            "frames_two_signal": two_signal,
            "contradicted_scoreboard": source == "scoreboard" and frames_say_no_change,
            "frames_say_changed": frames_say_changed,
            "new_source": new_source,
            "dropped": dropped,
            "true_positive": tp,
        })
    return rows


def _precision(rows, key_true="true_positive", keep=lambda r: True):
    kept = [r for r in rows if keep(r)]
    if not kept:
        return {"accepted": 0, "true_positive_cards": 0, "precision": None}
    tp = sum(1 for r in kept if r[key_true])
    return {
        "accepted": len(kept),
        "true_positive_cards": tp,
        "precision": round(tp / len(kept), 4),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fixture", default=DEFAULT_FIXTURE)
    ap.add_argument("--guard-ab", default=DEFAULT_GUARD_AB)
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    ap.add_argument("--build", default="guarded",
                    choices=["guarded", "reverted", "both"])
    ap.add_argument("--json", default=None)
    args = ap.parse_args(argv)

    detail = _load(args.fixture)
    notes = notes_by_ts(detail)
    goals = goal_windows(_load(args.manifest))
    ab = _load(args.guard_ab)

    builds = ["guarded", "reverted"] if args.build == "both" else [args.build]
    report = {
        "fixture": os.path.relpath(args.fixture, HERE),
        "manifest": os.path.relpath(args.manifest, HERE),
        "builds": {},
        "rule": (
            "ADAAAA-7844: corroborationSource == 'scoreboard' requires a legible, "
            "time-tied measured delta (both sides parsed, >=2 OCR samples per "
            "side) that the window's own frame attestation does not contradict; "
            "otherwise the card falls back to the evidence that credited it, or "
            "loses corroboration (downgraded to near_miss)."
        ),
    }

    for build in builds:
        recorded = ab.get(build) or {}
        cards = accepted_cards(detail) if build == "guarded" else [
            # The control build's accepted set, with the recorded per-card source.
            {
                "t": float(c["t"]),
                "start": float(c["start"]),
                "end": float(c["end"]),
                "id": None,
                "trigger_ts": float(c["t"]),
                "corroborationSource": c.get("corroborationSource"),
            }
            for c in (recorded.get("cards") or [])
            if (c.get("corroborationSource") is not None or c.get("t") is not None)
        ]
        if build == "guarded":
            # Attach the recorded source to the fixture's accepted cards.
            by_t = {round(float(c["t"]), 1): c for c in (recorded.get("cards") or [])}
            for card in cards:
                rec = by_t.get(round(card["t"], 1))
                card["corroborationSource"] = rec.get("corroborationSource") if rec else None
                card["trigger_ts"] = rec.get("t") if rec else card["t"]
        rows = rescore(cards, notes, goals)
        before = _precision(rows)
        after = _precision(rows, keep=lambda r: not r["dropped"])
        contradicted = [r for r in rows if r["contradicted_scoreboard"]]
        report["builds"][build] = {
            "job_id": recorded.get("job_id"),
            "before": {
                **before,
                "contradicted_scoreboard_goal_cards": len(contradicted),
                "contradicted_cards": contradicted,
            },
            "after": {
                **after,
                # The clause: no ACCEPTED GOAL may still be labelled "scoreboard"
                # while its own frames say the score did not change.
                "contradicted_scoreboard_goal_cards": sum(
                    1 for r in rows
                    if (not r["dropped"]) and r["new_source"] == "scoreboard"
                    and r["frames_scoreboardChanged"] is False
                ),
                "dropped_cards": [r for r in rows if r["dropped"]],
                "relabelled_cards": [
                    r for r in rows
                    if r["contradicted_scoreboard"] and not r["dropped"]
                ],
            },
        }

    print(json.dumps(report, indent=2))
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(report, fh, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""AC-3 evidence: the reverted-guard A/B on kids_soccer.mp4 (ADAAAA-7611).

AC-3 asks for the precision/recall of a build with
``services/decide/app/confirm.py::goal_corroborated`` reverted (the
``stage1_contradicts`` guard dropped) against the guarded build, on the same
upload, with both FP lists side by side.

The two real VOD jobs on that upload are exactly that A/B:

- ``ac6bf37f-6a03-4d14-a307-de5b9e200405`` — decide at ``da2d21a`` (guarded);
- ``cc06fb4a-ae9d-4eb9-8ffd-9a24129510e8`` — the pre-fix control, built before
  the guard existed (reverted-guard build).

``da2d21a`` touches only ``services/decide/app/confirm.py`` (the guard) plus
its tests, which is what makes the pair a controlled A/B rather than two
different builds — see ``--build-diff``. This module reads the two recorded job
details and reports:

1. the accepted-card sets, the cards only one build accepted;
2. the *class the guard bites*: cards whose window's own Stage-1 read said no
   goal (``stage1Disagreed: true``) and whose corroboration was NOT
   instant-anchored (no ``frame_attestation`` / goal-calling audio), i.e. a
   window-level scoreboard delta. The guarded build must have none;
3. the confirm-pass disagreement rates (how often the guard's input is even
   present), because a class that is present in one run and absent in the next
   is a run-level property, not a build property.

No model, no network, no GPU: both job details are committed copies.
"""
import argparse
import json
import sys

ANCHORED_SOURCES = ("frame_attestation", "audio")

# One confirmed-in-the-data instance of the class, from the control job.
KNOWN_CLASS_T = 690.0


def load_detail(path):
    with open(path) as fh:
        return json.load(fh)


def accepted_cards(detail):
    """Accepted GOAL cards, in trigger-timestamp order."""
    out = []
    for h in detail.get("highlights") or []:
        if (h.get("status") or "").lower() != "accepted":
            continue
        trig = h.get("trigger") or {}
        out.append({
            "t": trig.get("timestamp"),
            "localizedTs": h.get("localizedTs"),
            "start": h.get("start"),
            "end": h.get("end"),
            "corroborationSource": h.get("corroborationSource"),
            "stage1Disagreed": h.get("stage1Disagreed"),
            "corroborated": h.get("corroborated"),
            "goalConfirmed": h.get("goalConfirmed"),
        })
    return sorted(out, key=lambda c: (c["t"] is None, c["t"]))


def anchored(card):
    """Instant-anchored corroboration (what the guard lets through)."""
    src = (card.get("corroborationSource") or "").lower()
    return any(a in src for a in ANCHORED_SOURCES)


def guard_bites(card):
    """The class the guard rejects: window read says no goal + no anchor."""
    return card.get("stage1Disagreed") is True and not anchored(card)


def confirm_disagreement(detail):
    m = (detail.get("job") or {}).get("confirmMetrics") or {}
    runs = int(m.get("totalRuns") or 0)
    dis = int(m.get("disagreed") or 0)
    return {
        "confirm_runs": runs,
        "stage1_disagreed": dis,
        "disagree_rate": round(dis / runs, 4) if runs else None,
    }


def ab(guarded_path, reverted_path, guarded_label="da2d21a",
       reverted_label="pre-fix control (reverted guard)"):
    g = load_detail(guarded_path)
    r = load_detail(reverted_path)
    gc = accepted_cards(g)
    rc = accepted_cards(r)
    gt = {c["t"] for c in gc}
    rt = {c["t"] for c in rc}
    g_bite = [c for c in gc if guard_bites(c)]
    r_bite = [c for c in rc if guard_bites(c)]
    return {
        "guarded": {
            "label": guarded_label,
            "job_id": (g.get("job") or {}).get("id"),
            "accepted": len(gc),
            "cards": gc,
            "guard_bite_cards": g_bite,
            "confirm": confirm_disagreement(g),
        },
        "reverted": {
            "label": reverted_label,
            "job_id": (r.get("job") or {}).get("id"),
            "accepted": len(rc),
            "cards": rc,
            "guard_bite_cards": r_bite,
            "confirm": confirm_disagreement(r),
        },
        "only_guarded": sorted(gt - rt),
        "only_reverted": sorted(rt - gt),
        "both": sorted(gt & rt),
        "checks": {
            # The guarded build must never accept a card of the bite class.
            "guarded_has_no_bite_card": len(g_bite) == 0,
            # A reverted build can (one instance observed at t=690).
            "reverted_has_bite_card": len(r_bite) > 0,
        },
    }


BUILD_DIFF_NOTE = (
    "da2d21a touches only services/decide/app/confirm.py (the stage1_contradicts "
    "guard) plus services/decide/tests/test_confirm.py; `git show --stat da2d21a` "
    "is the proof that the guarded job and the pre-fix control differ by the guard."
)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--guarded", required=True, help="job detail of the guarded build")
    ap.add_argument("--reverted", required=True, help="job detail of the pre-fix control")
    ap.add_argument("--guarded-label", default="da2d21a")
    ap.add_argument("--reverted-label", default="pre-fix control (reverted guard)")
    ap.add_argument("--score-guarded", help="results/score_da2d21a.json")
    ap.add_argument("--score-reverted", help="results/score_cc06fb4a.json")
    ap.add_argument("--json", help="write the A/B report here")
    ap.add_argument("--assert-checks", action="store_true",
                    help="exit 1 when the guarded build accepted a bite-class card")
    args = ap.parse_args(argv)

    rep = ab(args.guarded, args.reverted, args.guarded_label, args.reverted_label)
    rep["build_diff"] = BUILD_DIFF_NOTE
    for key, path in (("guarded_score", args.score_guarded),
                      ("reverted_score", args.score_reverted)):
        if not path:
            continue
        with open(path) as fh:
            s = json.load(fh)
        fps = s.get("false_positives") or s.get("falsePositives") or []
        rep[key] = {
            "precision": s.get("precision"),
            "recall": s.get("recall"),
            "accepted": s.get("accepted"),
            "false_positives": [
                {"t": f.get("t"),
                 "window": f.get("window"),
                 "reason": (f.get("reason") or "")[:180]}
                for f in fps
            ],
            "false_negative_goals": [
                (f.get("goal") or f.get("id")) for f in (s.get("false_negatives") or [])
            ],
        }

    print(json.dumps(rep, indent=2))
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(rep, fh, indent=2)
            fh.write("\n")
    if args.assert_checks and not rep["checks"]["guarded_has_no_bite_card"]:
        print("FAIL: guarded build accepted a window-level-scoreboard card", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

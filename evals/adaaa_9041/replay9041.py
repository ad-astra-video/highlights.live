"""ADAAAA-9041 $0 replay: the equal-confidence tie-break on job 771f42de.

Read-only, offline, $0. Two stored inputs, both the job's own:

- `corpus_771f42de.json.gz` — every per-frame OCR read the job's decide windows
  carried (12 481 frames, 849 distinct strings), in frame order. This is the
  prompt-rendered text, truncated at ~40 chars, so it is LOSSY against the
  session's own reads.
- `served_frame_771f42de.json` — the 5 raw scorebug lines the job's SERVED
  record carries (`matchContextEvidence.channelOutcomes.scorebug_ocr.rawLines`),
  i.e. the full-length frame that published `Liverpool` home / `Chelsea` away.

Two lenses, run against both module trees so the change is a before/after:

- `stored_corpus` — the wide truncated corpus alone.
- `served_frame_plus_corpus` — the served frame PLUS the wide corpus. This is
  the closest offline model of the post-[ADAAAA-9038](/ADAAAA/issues/ADAAAA-9038)
  supply (the run's own frame folded together with up to 60 forwarded reads),
  and it is a MODEL, not a post-change measurement.

    # baseline (ADAAAA-9038 tip: the alphabetical tie-break)
    git show 4253ab6:services/perceive/app/match_context.py > /tmp/base9041/app/match_context.py
    git show 4253ab6:services/perceive/app/scoreboard.py    > /tmp/base9041/app/scoreboard.py
    touch /tmp/base9041/app/__init__.py
    PYTHONPATH=/tmp/base9041 python3 evals/adaaa_9041/replay9041.py --label baseline

    # patched (this change)
    PYTHONPATH=<repo>/services/perceive python3 evals/adaaa_9041/replay9041.py --label patched

Each run merges its two lens records into `replay9041.json` beside this script.
"""
import argparse
import gzip
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, "corpus_771f42de.json.gz")
SERVED_FRAME = os.path.join(HERE, "served_frame_771f42de.json")
OUT = os.path.join(HERE, "replay9041.json")
JOB = "771f42de-82eb-4357-8e0b-2121865f4608"

from app.match_context import (  # noqa: E402  (imported AFTER PYTHONPATH is set)
    SINGLE_SOURCE_CAP,
    USABLE_CONFIDENCE,
    fold_confidence,
    parse_ocr_teams,
    resolve_match_context,
)


def load_json(path):
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt") as fh:
        return json.load(fh)


def ranking(scorebug):
    """The fold's own published order, with the tie-break inputs on every row."""
    rows = []
    for cand in fold_confidence(scorebug, [], []):
        # The baseline module (pre-9041) has no observation counter; report it as
        # null rather than inventing a number for the before/after column.
        observations = getattr(cand, "observation_count", None)
        rows.append(
            {
                "name": cand.name,
                "side": cand.side,
                "confidence": cand.confidence,
                "observations": observations,
                "sourceWeight": getattr(cand, "source_weight_total", cand.confidence),
            }
        )
    return rows


def lens(name, frames):
    out = resolve_match_context(game_hint="soccer", sport_hint="soccer", ocr_frames=frames)
    status = out["evidenceStatus"]
    fold = (status.get("channelOutcomes") or {}).get("fold") or {}
    scorebug = []
    for frame in frames:
        scorebug.extend(parse_ocr_teams(frame["lines"], "soccer"))
    record = {
        "frames": len(frames),
        "published": [
            {"side": t["side"], "name": t["name"], "confidence": t["confidence"]}
            for t in out["matchContext"]["teams"]
        ],
        "fold": fold,
        "suppressedCandidates": status.get("suppressedCandidates") or [],
        "suppressedCandidateDetail": status.get("suppressedCandidateDetail") or [],
        "candidates": ranking(scorebug),
    }
    print(f"  [{name}] published {fmt(record['published'])}")
    print(
        f"          fold home={_side(fold.get('home'))} away={_side(fold.get('away'))}"
        f"  suppressed={record['suppressedCandidates']}"
    )
    for row in record["candidates"][:5]:
        obs = row["observations"]
        obs_text = "  n/a" if obs is None else f"{obs:5d}"
        print(f"          {row['confidence']:.2f} obs={obs_text} {row['name']:14s} {row['side']}")
    for detail in record["suppressedCandidateDetail"]:
        print(
            f"          dropped {detail['name']:12s} obs={detail['observations']:5d}"
            f" -> {detail['reason']} (beatenBy={detail.get('beatenBy')}"
            f" obs={detail.get('beatenByObservations')})"
        )
    return record


def _side(side):
    if not side:
        return None
    return f"{side['name']}@{side['confidence']} obs={side.get('observations')}"


def fmt(teams):
    return " ".join(f"{t['side']}={t['name']}@{t['confidence']}" for t in teams) or "none"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True, help="baseline | patched (recorded in the JSON)")
    args = ap.parse_args()

    reads = load_json(CORPUS)
    served = load_json(SERVED_FRAME)
    print(f"== {args.label}: job {JOB[:8]}, {len(reads)} stored reads ({len(set(reads))} distinct) ==")

    record = {
        "job": JOB,
        "label": args.label,
        "spend_usd": 0,
        "corpus": {
            "reads": len(reads),
            "distinct_reads": len(set(reads)),
            "ocr_per_observation": 1,
            "note": "prompt-rendered OCR truncated at ~40 chars: LOSSY vs the session's own reads",
        },
        "served_frame_lines": served["lines"],
        "lenses": {
            "stored_corpus": lens("stored_corpus", [{"lines": [line]} for line in reads]),
            "served_frame_plus_corpus": lens(
                "served_frame_plus_corpus",
                [{"lines": served["lines"]}] + [{"lines": [line]} for line in reads],
            ),
        },
        "policy": {"USABLE_CONFIDENCE": USABLE_CONFIDENCE, "SINGLE_SOURCE_CAP": SINGLE_SOURCE_CAP},
    }

    prior = {}
    if os.path.exists(OUT):
        with open(OUT) as fh:
            prior = json.load(fh)
    prior[args.label] = record
    prior.setdefault("ticket", "ADAAAA-9041")
    prior.setdefault("spend_usd", 0)
    with open(OUT, "w") as fh:
        json.dump(prior, fh, indent=2, sort_keys=True)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()

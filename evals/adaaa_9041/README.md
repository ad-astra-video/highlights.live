# ADAAAA-9041 — equal-confidence tie-break in the entity fold ($0 replay)

Grades the fix that ranks `teams` candidates by **agreeing evidence** when their
confidences tie, instead of by name. No leg, no stream, no model, no GPU, **$0**.

## The defect

`fold_confidence` (`services/perceive/app/match_context.py`) sorted candidates by
`(-confidence, name)`, and `resolve_match_context` publishes `concrete[:2]`. Every
scorebug-only name sits at `0.50` (the single-source weight), so when several of
them tie the two survivors were chosen **alphabetically**. Measured on job
`771f42de`: the published pair became `Italy + Japan` — names carried by one
ad-board OCR read each — while `Liverpool` (218 agreeing reads) was suppressed and
the job's served pair `Liverpool` home / `Chelsea` away disappeared.

## The fix (a tie-break, not a bar)

- `Candidate` counts agreeing observations per distinct snippet (`observations`);
  `fold_confidence` ranks by `confidence`, then observations, then source weight,
  then name. `USABLE_CONFIDENCE` (0.60) and `SINGLE_SOURCE_CAP` (0.55) are
  untouched, and a tie-break never lifts a candidate above them by itself.
- Same-name records are **merged** instead of one being discarded: a name plate
  (`unknown` side) and a score line (concrete side) for the same team used to
  collapse to one record and drop the other's reads (the 172 listing-row reads of
  `Liverpool` lost to a single name plate). Confidence still comes from the
  surviving record's own sources, so merging cannot promote a single-source name.
- `evidenceStatus.suppressedCandidateDetail` names the tie: `observations` against
  `beatenByObservations`, plus a `reason`
  (`tie_break_fewer_observations` / `tie_break_source_weight` / `tie_break_name` /
  `lower_confidence` / `no_concrete_side` / `below_usable_floor`). Bounded to 4.
  `suppressedCandidates` (names) is unchanged. `fold.tieBreak` states the order,
  and `fold.home/away` now carry `observations`.

## Inputs (both from the job's own stored record, read-only)

- `corpus_771f42de.json.gz` — the 12 481 per-frame OCR strings the job's decide
  windows carried (`observations[].ocr`), in frame order, 849 distinct. This is
  the prompt-rendered text, **truncated at ~40 chars**; the [ADAAAA-9038](/ADAAAA/issues/ADAAAA-9038)
  replay extracted 11 849 `ocr="…"` records from the same `decide_audit` rows
  with a regex, so the counts differ slightly by extraction, not by supply.
- `served_frame_771f42de.json` — the 5 raw scorebug lines the SERVED record
  folded (`matchContextEvidence.channelOutcomes.scorebug_ocr.rawLines`), i.e. the
  full-length frame that published `Liverpool` home / `Chelsea` away.

## Running it

```sh
# baseline = ADAAAA-9038 tip (the alphabetical tie-break)
git show 4253ab6:services/perceive/app/match_context.py > /tmp/base9041/app/match_context.py
git show 4253ab6:services/perceive/app/scoreboard.py    > /tmp/base9041/app/scoreboard.py
touch /tmp/base9041/app/__init__.py
PYTHONPATH=/tmp/base9041 python3 evals/adaaa_9041/replay9041.py --label baseline

# patched = this change
PYTHONPATH=$PWD/services/perceive python3 evals/adaaa_9041/replay9041.py --label patched
```

Unit coverage lives beside the resolver:
`services/perceive/tests/test_match_context.py` (`Tie-break on equal confidence`)
and `services/server/test/match-context-resume.test.ts` (the evidence merge).

## Recorded result (`replay9041.json`)

| lens | baseline | patched |
| --- | --- | --- |
| stored corpus (12 481 truncated reads) | `away=Italy@0.5 away=Japan@0.5`, `Liverpool` suppressed | `away=Liverpool@0.5` (218 obs) + `Japan@0.5` (22 obs), `Italy` suppressed with the tie named |
| served frame + corpus | `away=Chelsea@0.5 away=Italy@0.5`, `Liverpool` suppressed | `home=Liverpool@0.5` (219 obs) + `away=Japan@0.5` (22 obs), `Chelsea` (1 obs) suppressed with the tie named |

- **The alphabetical flip is gone.** The away claim is the name the corpus
  actually repeated (`Liverpool`, 218 agreeing frames), not the alphabetically
  first ad-board name (`Italy`, 15). No threshold moved: every published name is
  still `0.50` on one source, below the 0.60 usable floor, so nothing was
  promoted into a team the copy can name.
- **Honest limit.** The corpus is truncated and lossy: `Chelsea` appears **zero**
  times in the 12 481 reads (once, only in the served frame), while the ad-board
  `JAPAN` reads repeat 22 times. Under the stated rule — more agreeing
  observations wins — a repeatedly-printed noise name still outranks a once-read
  real name, so the second slot stays `Japan` in the model lens. This corpus
  therefore **cannot** measure post-change supply (the session's own, untruncated
  reads resolve both clubs); it measures the tie-break's ordering only.
- The residual ("raw read count beats read quality") is filed as a follow-up:
  ranking by plate co-occurrence would need a new signal, which this ticket
  explicitly scoped out (tie-break only, no new threshold).

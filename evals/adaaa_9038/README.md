# ADAAAA-9038 — paired-plate cross-frame corroboration ($0 replay)

What this directory holds: the read-only replay that grades the live entity-supply
lever (a scorebug plate that names both sides on >= 2 folded frames counts as two
agreeing observations) against the six stored natural live browser jobs. No leg,
no stream, no model, no GPU, **$0**.

## Inputs (box Postgres, read-only)

- `inputs/q_ocr.sql` — every per-frame OCR read the six jobs' decide windows
  carried (`decide_audit.prompt_text`, `ocr="..."` records). Written to
  `ocr_corpus.raw` (11 853 reads; only job `771f42de` still has decide audits).
- Each job's stored `matchContextEvidence.channelOutcomes.scorebug_ocr` and
  published `matchContext` from the `jobs` record (`jobs.json`).
- The 27 promoted rows of the same six jobs (`rows.json`, `highlights`).

The census that produced these extracts is on ADAAAA-9035 (`census.json`,
`rows.json`, `windows.json`).

## Running it

```sh
git show 328bb3b:services/perceive/app/match_context.py > /tmp/base9038/app/match_context.py
git show 328bb3b:services/perceive/app/scoreboard.py    > /tmp/base9038/app/scoreboard.py
touch /tmp/base9038/app/__init__.py

cd services/perceive && PYTHONPATH=. python3 ../../evals/adaaa_9038/replay9038.py          # patched
cd /tmp/base9038      && PYTHONPATH=. python3 <repo>/evals/adaaa_9038/replay9038_served.py # served bytes
npx tsx evals/adaaa_9038/eligibility.ts                                                    # AC1/AC12 arithmetic
```

## Recorded result (this directory)

`replay9038.out` / `replay9038.json` / `served9038.json` are the runs summarised
in the ticket comment:

- **1 frame (today's supply): the patched resolver is byte-identical to served
  328bb3b on all six jobs** (`served_1frame == patched_1frame`, every name and
  confidence) — so the change is inert wherever the rail folds one frame.
- **2 frames of the same stored frame text:** exactly the two jobs whose stored
  frame carries BOTH clubs lift `0.50 -> 0.70` (`Real Madrid` / `Barcelona`,
  `ambiguous: false`); the other four are unchanged, because their stored frame
  names one side only or names it through a title/listing row.
- **Real multi-frame supply (`771f42de`, 11 849 reads): the lift never fires** —
  the only club-naming reads are ad-board noise (`JAPAN AIRLINES`, `italian`,
  `Iran`) and a truncated listing row, none of which forms a both-sides plate.
  That corpus is prompt-rendered and truncated at ~40 chars, so it cannot
  measure the rail's post-change supply; it only proves the gate is closeable.
- **Eligibility does not move:** `0/27` rows on row bytes only, `27/27` with the
  served context, `27/27` with the patched context. The lift changes USABILITY,
  not the AC1/AC12 arithmetic.

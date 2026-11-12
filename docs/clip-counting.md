# Clip counting: one user-facing definition, two totals

Status: ratified by the Product Owner on ADAAAA-7850, implemented on ADAAAA-7854.

This document is the single place that defines what "how many clips?" means. Any
surface that shows a clip count must cite this definition, so a future dashboard
cannot drift back to counting database rows.

## The two totals

| Total | Definition | Source | Who sees it |
| --- | --- | --- | --- |
| **Postable moments** (canonical, user-facing) | Deduped postable clip count: the length of the list `buildPostableHighlights(rows).highlights` | `services/server/src/highlight-postable.ts` | Customer-facing surfaces (Highlights page job tile, job-detail header) and admin analytics as `clipsPostable` |
| **Raw rows** (audit) | Every persisted `highlights` row, including rejected clips, gate-dropped verdicts, and merged-away overlapping duplicates | `SELECT COUNT(*) FROM highlights` | Admin / diagnostics only, labelled raw |

The database keeps **every** clip row. Nothing is deleted, backfilled, or migrated:
merged-ness is derived at read time from `start`, `end`, `score`, `corroborated`,
`outcome` and (ADAAAA-8733) the row's `matchClock`, so the raw trail stays complete for audit and for the future
"detect the merge before the expensive deep dive" work (parked as ADAAAA-7853).

`raw rows - postable moments` is the number of rows that are not a separate clip
a customer can watch: overlapping duplicates folded into a moment, rejected clips,
and verdicts the precision gate dropped.

## Read-time derivation (no GPU cost)

`buildPostableHighlights` applies, in order:

1. drop `status: "rejected"`,
2. drop anything that is not `outcome: "scoring_play"` (`near_miss` / `big_play`
   ride the separate "notable, not a goal" lane),
3. drop a verdict that contradicts itself (structured Stage-2 `near_miss` /
   `not_goal`, or reason text that refutes the goal),
4. collapse overlapping clip windows into ONE moment — the best-scoring, then
   best-corroborated, then earliest clip wins; the rest are marked
   `duplicateOf` the winner and reported through `duplicateCount` / `mergedIds`.
5. ADAAAA-8733 (GT-2): collapse moments whose **scorebug match clock** proves
   they are the same GAME moment, even when their clip windows do not overlap —
   and never collapse two whose clocks prove they are distinct. Absorbed rows
   move to the duplicate lane exactly like step 4 (same `duplicateOf` /
   `duplicateCount` / `mergedIds` fields), nothing is re-cut, and a row with no
   legible clock is a no-op.

### The match-clock lane (ADAAAA-8733)

The clock is read on the SAME crop and the SAME OCR call as the score pair
(`LALIGA00:56`, `RMA 1/2 FCB36:54`), parsed by
`parseOcrMatchClockLine` (server) and `parse_match_clock_line` (perceive) — two
mirrors of one table, pinned by a parity fixture. It costs no OCR call and no
GPU-second, and it never feeds the score/delta lane: a clock can never attest,
confirm, demote or re-lane a GOAL (R3).

The tolerances are measured, not chosen (ADAAAA-8732 census): two re-reads of one
event agreed within 7 s (`CLOCK_SAME_MOMENT_S = 10`); the smallest measured gap
between genuinely distinct goals on one coherent segment was 309 s, so
`CLOCK_DISTINCT_S = 30` is a floor. Three gates keep the lane safe:

- **anchor** — a row carries the clock read AT its measured goal instant (within
  `CLOCK_ANCHOR_TOLERANCE_S = 4` s); a window-centred read advances with content
  and cannot identify a moment.
- **coherence** — the clock must advance with content time within
  `CLOCK_COHERENCE_TOLERANCE_S = 3` s. That is the segment gate: every incoherent
  pair in the census was a graphic/match cut (`+124 s` in `3 s`), so a bumper or
  studio cut-away can never merge two matches' goals. A rewound read is a replay
  inset and never combines.
- **frozen bug** — a job whose clock does not move while content advances
  (> 20 s) has NO clock lane, so a static/placeholder graphic cannot merge
  distinct goals. `matchClock` absent on every row also means no lane at all.

Tolerances apply per job at read time; nothing is written back to the rows.

### `status` is a publish state, not a verdict (ADAAAA-8678)

A `pending` row is postable. `status` records whether the clip is approved for
publishing: with auto-publish off (`config.autoPublishHighlights`) the write path
stores `pending` and the card carries the operator's `Approve` control
(`verdictAction`), so the row must ship. Dropping `pending` would strand that
approve flow and blank every auto-publish-off box. The record's enum is
`pending | accepted | rejected` (there is no `published`; an exported clip is
settled to `accepted`, which this gate keeps serving unchanged), and `rejected`
remains the only status-level drop.

Because a `pending` row is not settled, the served card discloses its evidence
rather than asserting a GOAL: its `confirmation` lane is derived from the row's
own measurement / dive exactly like an accepted row's, and a row with neither
carries `confirmation.lane: "unconfirmed"` worded as the approve queue
(`Awaiting approval — …`, badge UNCONFIRMED) — never the `Accepted …` sentence.
The MATCH SUMMARY counts the SAME population the page serves
(`buildSummaryLadder` receives `postable.highlights`), so `goalCount` equals the
GOAL cards rendered; a counted-but-unapproved goal is worded
`… goals (K corroborated, P awaiting approval)`, never `accepted goals`.

This is a pure function over stored rows. It adds no decide, confirm, or perceive
call, so the metrics below cannot change inference cost.

## Where the counts are produced

- `GET /jobs` and `GET /jobs/:id` → each job row carries `rawHighlights`,
  `postableHighlights` and `mergedHighlights` (the same projection the detail
  payload uses). The Highlights-page tile reads `postableHighlights` directly and
  renders `mergedHighlights` as a secondary "N merged" read; no client re-derives
  the dedupe.
- `GET /jobs/:id/detail` and `GET /jobs/:id/sections-delta` → the embedded `job`
  carries the same three counts, computed from the SAME `buildPostableHighlights`
  pass that builds the returned `highlights` list, so
  `job.postableHighlights === highlights.length` always holds.
- `GET /admin/analytics` → `clips.clipsTotal` (raw rows, `clipsTotalBasis:
  "raw_rows_includes_merged"`) next to `clips.clipsPostable` (deduped,
  `clipsPostableBasis: "deduped_postable_moments"`). Dedupe is per job: two
  different jobs never collapse into one moment.
- Admin job-detail "Candidates" header → still the persisted row basis, and its
  label states `Candidates (raw rows)`. It is admin-only; no customer-facing
  header shows a merged-inclusive clip count.

## Quota debit

The monthly clip quota is debited **once per postable moment**, not once per
persisted row (`clipQuotaDelta` in `highlight-postable.ts`). The decision is
order-independent: a clip that becomes a new moment debits one slot, a clip that
merges into an existing moment debits nothing (that moment already holds its
slot), and a clip that bridges two moments into one releases the absorbed slot.
The row is persisted either way.

## Worked example: job `d61e52f6`

Measured on the deployed box by the ADAAAA-7653 QA run:

- 24 persisted rows
- overlap-collapse alone (no precision gate): 18 unique windows, 6 merged
- precision gate applied first (1 rejected, 2 self-contradicting verdicts), then
  overlap collapse: **17 postable moments, 4 merged**

The canonical user-facing count is therefore **17**, and the tile reads
`17 accepted · 4 merged`. The `18 / 6` pair quoted in the ADAAAA-7854 acceptance
text is the overlap-only collapse of all 24 rows; it does not survive the
precision gate, so it is not a number any surface should print.

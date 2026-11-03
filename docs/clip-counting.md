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
merged-ness is derived at read time from `start`, `end`, `score`, `corroborated`
and `outcome`, so the raw trail stays complete for audit and for the future
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

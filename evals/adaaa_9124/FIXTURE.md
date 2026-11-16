# ADAAAA-9124 — the LIVE deck bar's distinct-content fixture

The deck bar (`>= 10` servable refurbished bodies on one live leg) is a **serve-yield**
question, and the yield it needs is *measured authority per row*, not row count per
minute. This file records the fixture that carries authority, the measurement that
picked it, and why a 300 s loop cannot carry the bar at any yield.

Every number below is read from rows a served build already wrote (`$0`: no model
call, no job, no billing). The tools that read them live in this directory:

| file | what it does |
| --- | --- |
| `export_corpus_9124.py` | exports a stored-row corpus for one `sourceUrl` from the box's `highlights` DB |
| `replay9124.ts` | grades that corpus through the SERVED evidence mapper + gate, prints the per-leg and per-fixture serve-yield census, `--min-yield` makes it a regression gate |
| `probe-drop-sentences-9124.ts` | measures the AC14 "drop the offending sentence, then re-judge" repair's headroom on stored rows |

## The fixture

**`kidssoccer_54537ffa` — `Real Madrid vs Barcelona Goal Highlights`**

| property | value | source |
| --- | --- | --- |
| file | `/data/uploads/54537ffa-b227-4cef-b461-35075d08f5cd/kids-soccer.mp4` | box, not in repo |
| duration | **777.939 s (12:58), non-looping** | `ffprobe` in the served container |
| leg | job `54537ffa-b227-4cef-b461-35075d08f5cd` (LIVE rail, `source: file`) | `jobs` table |
| stored rows | **20**, one per distinct window | `highlights` table |
| distinct moments | **20** distinct 5 s windows; **15** rows labelled `GOAL` | `start` + `eventType` |
| measured score transitions | **7**, monotonic: `0-0>0-1`, `0-1>1-1`, `1-2>2-2`, `2-2>2-3`, `2-3>3-3`, `3-3>3-4`, `3-4>4-4` | `attestationUsed.transitionKey` |
| rows with measured authority | **19/20 (95 %)** — `frame` or `scoreboard` | `attestationUsed.authority` |
| rows/min of content | **1.54** (20 rows / 12.98 min) | derived |
| served/row, as the leg ran | **8/20 = 40.0 %** | `record.summaryGate` ∈ {accepted, neutralised} |
| served/row, served gate replay | **11/20 = 55.0 %** | `replay9124.ts` |
| `$0` deck projection | 20 rows × 55 % = **11 bodies** (bar is 10) | derived |
| measured leg cost | **$1.0136** (job `record.costUsd`, 1364.2 s perceived) | `jobs` table |

A **live `file-sim` leg on this fixture is ~$0.55-0.60 projected** (same content read at
1× realtime instead of the VOD path's 1.75× perceived time). That is a projection, not a
quote: a cost card must quote a measured `costUsd`, which is why `$1.0136` above is the
number a card cites and the live figure is labelled.

## Why the loop cannot carry the bar

`kids300_7935.mp4` is 300.05 s and loops, so a leg buys *passes*, not *distinct moments*.
The measured census of every stored leg on it (143 legs, 1188 rows) is in
`live-deck-kids300_7935.census.json`:

| fixture | rows/min of content | rows with authority | served/row as run | served/row gate replay | legs reaching 10 bodies |
| --- | ---: | ---: | ---: | ---: | ---: |
| `kids300_7935.mp4` (loop) | 1.66 | **1.5 %** (18/1188) | 1.9 % | 0.6 % | **0** (max 2) |
| `kidssoccer_54537ffa` (distinct) | 1.54 | **95 %** (19/20) | 40.0 % | 55.0 % | 1 of 1 (11) |

Rows/min is the same on both. What separates them by ~60× is **whether the row measured
anything**: on a loop the scorebug rewinds every pass, so the scoring lane refuses the
later transitions (`a rewind cannot attest a new GOAL`) and almost every promoted row is
left with a clock and nothing else — a row the contract cannot legally serve
(`too-few-facts`, 77 of the 143 legs' refusals). The writer is not lazy on the loop; the
loop has nothing to write about.

## Rights / provenance

The video is a **customer upload** to the webapp (owner `eac7f07289501c8c`, job
`54537ffa`), stored on the box at the path above; it is third-party match footage and is
**not redistributed**. What this repo commits is the **stored-row corpus**
(`live-deck-54537ffa.json`): window times, the measured score transitions, the served
copy and the leg's meters — derived metadata, no video bytes. Constraints on its use:

- QA/eval only; do not republish the clip or the served copy as content.
- Re-ingesting the clip as a repeatable live fixture is a **use-rights question for the
  owner** (a customer upload is not ours to re-run indefinitely). Before the fixture is
  used for scheduled CI, replace it with owned or licensed footage that carries the same
  property: **>= 10 distinct scoring moments in one non-looping clip of ~13 min**.
- Replacements must be re-measured with `replay9124.ts` at `$0` before any leg is priced.

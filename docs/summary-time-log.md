# Append-only summary time log (ADAAAA-7237)

The decide/gemma brain holds a single **bounded** rolling `runningSummary`
(story-so-far) on the job record, compacted by dropping the OLDEST lines first
(`MAX_RUNNING_SUMMARY_CHARS = 2000`). This is the *model-input* story — it stays
bounded so per-token Livepeer cost never regresses.

ADAAAA-7237 adds a separate **append-only per-pass summary time log**
(`job.summaryLog`). (ADAAAA-7501: the end-of-video compiled overall summary —
`job.overallSummary` and the `/app/summary` decide call — was removed along with
the web app's "Overall Summary" section; it existed solely to fill that section.)

## Data model

Each cadence decide pass appends one entry to `job.summaryLog`:

```
{ "seq": 3, "ts": "2026-10-23T02:30:00.000Z", "windowTs": 120000, "text": "<incremental content for this window>" }
```

- `seq` — job-monotonic sequence, strictly increasing (1-based). Computed as
  `lastEntry.seq + 1`; never recomputed from array length so a truncation never
  re-numbers history.
- `ts` — wall-clock time the entry was appended.
- `windowTs` — the timestamp (ms) of the observe window / tick this entry
  summarizes (when the tick carried one).
- `text` — the incremental per-pass content the model concluded for THIS window
  (the delta vs the prior story-so-far), not a re-log of already-captured lines.

## Append-only invariant

The log is **append-only**: each `appendSummaryEntry` writes
`summaryLog: [...existingLog, newEntry]` and never mutates a past entry. No
existing entry is overwritten, dropped, or reordered. The bounded rolling
`runningSummary` is persisted alongside (the in-model story remains a bounded
string distinct from the durable log).

## Retention policy

The durable log is a per-job JSON array carried on the job record. Retention
rules:

1. **Never drop the most recent entries.** If the log is ever bounded in the
   future, only the OLDEST entries may be pruned (front-of-array), and the cap
   must be high enough that pruning never removes entries the web app's "Video
   Summary" section still needs. Today there is no cap: a full-length VOD's
   per-pass entries are small (bounded by the model-input cap), so the full log
   is retained for the job's lifetime.
2. **Sequences are stable.** Pruning removes entries from the front; the
   remaining entries keep their original `seq`, so ordering and identity are
   never rewritten.
3. **No silent loss of the newest passes.** If a cap is introduced, the bounded
   in-model running summary keeps the newest content regardless, and
   `appendSummaryEntry` always appends before any pruning decision is made.
4. **Log is distinct from the model-input summary.** `runningSummary` may
   compact (dropping the oldest lines); `summaryLog` never compacts a past entry
   — it is the durable record the web app's "Video Summary" section renders.

## Cost

The in-model story-so-far stays bounded to `MAX_RUNNING_SUMMARY_CHARS` at the
prompt-build layer (`services/decide/app/gemma.py`), so per-tick token cost does
not regress. The durable log is storage only (no per-completion inference is
generated from it).

// Append-only per-pass summary time log (ADAAAA-7237 / ADAAAA-7466). The
// decide/gemma brain maintains a single BOUNDED rolling `runningSummary`
// (story-so-far) that compacts by dropping the OLDEST lines first, so per-pass
// detail is lost. The web app surfaces that detail as the collapsible
// "Video Summary" section (the append-only `job.summaryLog` time log).
//
// (ADAAAA-7501: the end-of-video compiled "Overall Summary" — the
// `applyOverallSummary` / `requestOverallSummary` / `fallbackOverallSummary`
// path and its `/app/summary` decide call — was removed. It existed solely to
// fill the removed Overall Summary section, so we drop the inference-generating
// work with it. The append-only per-pass time log below is KEPT unchanged: it
// is what the Video Summary section renders.)
//
// Kept in its own module (like job-title.ts) so the append logic can be
// unit-tested without driving the full VOD/live pipeline.
import type { SummaryLogEntry } from "@highlights/events";
import type { Store } from "./store";

/**
 * ADAAAA-7237: derive the incremental summary content a cadence pass added —
 * the lines in `next` (the model's updated running summary) that were NOT
 * already present in `prior` (the previous story-so-far). This is the per-window
 * entry that goes into the append-only time log. Because the running summary
 * grows forward-only, the delta captures what this window's conclusion added;
 * reworded/compacted lines already present in the prior are not re-logged, so
 * an entry never duplicates a past one. Empty when nothing new (the caller
 * falls back to the whole `next` so an entry is always recorded for a pass).
 */
export function summaryDelta(prior: string | undefined, next: string): string {
  const priorLines = new Set(
    (prior ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const newLines = (next ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((l) => !priorLines.has(l));
  return newLines.join("\n").trim();
}

/** Next monotonic sequence for a job's summary log (1-based; strictly increasing). */
export function nextSummarySeq(log: SummaryLogEntry[] | undefined): number {
  return (log && log.length > 0 ? log[log.length - 1].seq : 0) + 1;
}

/** Optional window metadata threaded from the observe tick into the log. */
export interface SummaryAppendMeta {
  /** Video timestamp (seconds) of the observe window this entry summarizes. */
  windowTs?: number;
}

/**
 * ADAAAA-7710: normalise a window timestamp to the integer the persisted
 * `SummaryLogEntry.windowTs` contract requires (`z.number().int()`).
 *
 * The observe cadence reports `payload.centerTs`, which is a float whenever the
 * window centre is not a whole second (e.g. a 14 s clip whose last tap is at
 * `11.666666666666666`). Passing that straight through made `store.patchJob`'s
 * `JobSchema.parse` reject the ENTIRE patch, so both the summary-log entry and
 * the bounded `runningSummary` were dropped for that pass — a silent data-loss
 * path, not a cosmetic log line.
 *
 * Rounding at this single write choke point (both the live and VOD callers go
 * through `appendSummaryEntry`) keeps stored summaries integers without the
 * webapp having to format fractions. A non-finite timestamp degrades to "no
 * window metadata" rather than failing the entry, so a bad tick can never cost
 * the summary itself.
 */
export function normalizeWindowTs(windowTs: number | undefined | null): number | undefined {
  if (typeof windowTs !== "number" || !Number.isFinite(windowTs)) return undefined;
  return Math.round(windowTs);
}

/**
 * ADAAAA-7237: append one summary entry to the job's append-only time log and
 * persist the bounded rolling `runningSummary`. Appends, never replaces — the
 * existing log is carried forward unchanged (no past entry is overwritten,
 * dropped, or reordered). Returns the updated log, or `undefined` when the job
 * is missing. Pure given the store; callers keep it best-effort.
 */
export function appendSummaryEntry(
  store: Pick<Store, "getJob" | "patchJob">,
  jobId: string,
  summary: string,
  meta?: SummaryAppendMeta
): Promise<SummaryLogEntry[] | undefined> {
  const job = store.getJob(jobId);
  if (!job) return Promise.resolve(undefined);
  const log = job.summaryLog ?? [];
  const seq = nextSummarySeq(log);
  const delta = summaryDelta(job.runningSummary, summary);
  // ADAAAA-7710: windowTs is persisted as an integer — see normalizeWindowTs.
  const windowTs = normalizeWindowTs(meta?.windowTs);
  const entry: SummaryLogEntry = {
    seq,
    ts: new Date().toISOString(),
    ...(windowTs != null ? { windowTs } : {}),
    // The per-window content the model added this pass; fall back to the whole
    // bounded summary so a pass is never silently dropped from the log.
    text: delta || summary,
  };
  const nextLog = [...log, entry];
  return store.patchJob(jobId, { runningSummary: summary, summaryLog: nextLog }).then(() => nextLog);
}

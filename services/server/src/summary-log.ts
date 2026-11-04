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
import {
  groundSummaryText,
  captionLineKey,
  captionColour,
  dedupeStoredLines,
  dropColourClause,
  isQuietVerdict,
  MAX_LINE_OCCURRENCES,
  type CaptionGroundingContext,
} from "@highlights/events";
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

/**
 * ADAAAA-7956 (contract v3 rule 2): the comparison key for "already emitted".
 * Byte-identical after the only cosmetic differences a caption can carry —
 * surrounding whitespace, collapsed inner whitespace, a trailing full stop and
 * letter case — so `Player in blue moves ball in center circle.` and
 * `Player in blue moves ball in center circle` are the SAME line. The key is
 * used only for comparison; the emitted text is never rewritten here.
 */
export function summaryLineKey(text: string): string {
  // ADAAAA-7958: the key now lives in the shared caption gate, so the append
  // seam and the surface seam (chapter leads, Video Summary items) can never
  // disagree about what "the same line" is.
  return captionLineKey(text);
}

/**
 * ADAAAA-7956 (contract v3 rule 2): drop the lines of this pass that the job has
 * ALREADY emitted. The model re-narrates a scene it has covered (a replay, a
 * second look at the same passage) and the append-only log then accumulates the
 * same sentence over and over, so the story log stops reading as a story. Returns
 * the surviving lines joined by newline, or "" when every line was a repeat.
 */
export function unduplicatedSummaryLines(
  text: string,
  log: SummaryLogEntry[] | undefined
): string {
  const seen = new Set<string>();
  for (const entry of log ?? []) {
    for (const line of (entry.text ?? "").split("\n")) {
      const key = summaryLineKey(line);
      if (key) seen.add(key);
    }
  }
  const kept: string[] = [];
  for (const line of (text ?? "").split("\n")) {
    const trimmed = line.trim();
    const key = summaryLineKey(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(trimmed);
  }
  return kept.join("\n");
}

/**
 * ADAAAA-7962 (contract v4 §3.5): the share of QUIET delivered rows that may
 * carry a colour beat. The cap is enforced at the WRITE seam from the stored log
 * itself, so a quiet-heavy job cannot drift over the bar as the story grows.
 */
export const MAX_QUIET_COLOUR_SHARE = 0.4;

/** Optional window metadata threaded from the observe tick into the log. */
export interface SummaryAppendMeta {
  /** Video timestamp (seconds) of the observe window this entry summarizes. */
  windowTs?: number;
  /**
   * ADAAAA-7948 (Inc 3): the grounding context for the window this entry
   * covers — its stored verdict plus its decide `prompt_text`. Present ONLY on
   * the live/fast rail; the VOD summary path never supplies it, so VOD entries
   * stay byte-identical.
   */
  grounding?: CaptionGroundingContext;
}

/**
 * ADAAAA-7711 (superseding the ADAAAA-7710 rounding): sanitise the observe
 * cadence's window centre before it is persisted.
 *
 * `payload.centerTs` is a float whenever the window centre is not a whole
 * second (e.g. a 14 s clip whose last tap lands at `11.666666666666666`). The
 * persisted contract (`SummaryLogEntrySchema.windowTs`) accepts any FINITE
 * float — a fractional timestamp is the honest value and `summary-ladder.ts`
 * already consumes it — so this function deliberately does NOT round: rounding
 * here would silently move every entry's window by up to half a second and
 * disagree with the ladder's interpolation. The webapp rounds only for DISPLAY
 * (`summaryEntryTimestamp` -> `T+12s`).
 *
 * Only non-finite input (NaN / ±Infinity) is dropped, because `.finite()` in
 * the schema would otherwise reject the whole `patchJob` and cost the entry
 * (plus the bounded `runningSummary`) for that pass. A bad tick degrades to
 * "no window metadata" rather than failing the summary.
 */
export function normalizeWindowTs(windowTs: number | undefined | null): number | undefined {
  if (typeof windowTs !== "number" || !Number.isFinite(windowTs)) return undefined;
  return windowTs;
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
  // ADAAAA-7711: keep the fractional window centre (see normalizeWindowTs).
  const windowTs = normalizeWindowTs(meta?.windowTs);
  // ADAAAA-7948 (Inc 3): the grounding gate. Every FAST caption is filtered
  // before it becomes a user-visible Video Summary item: no goal claim without
  // the window's own verdict, no name the window's prompt cannot corroborate,
  // no internal token. The rolling `runningSummary` is deliberately NOT gated —
  // it is model input for the next window, not customer copy. VOD passes no
  // `grounding`, so its items stay byte-identical (AC8).
  const rawText = delta || summary;
  const grounding = meta?.grounding;
  let text = grounding ? groundSummaryText(rawText, grounding) : rawText;
  // ADAAAA-7956 (contract v3 rule 2): on the fast rail a line the job has
  // already emitted is not appended again — the story log cannot accumulate
  // duplicates (it reads as a story, not a loop). The bounded `runningSummary`
  // still advances (it is model input for the next window), and when every line
  // of the pass is a repeat the log simply gains no row. VOD supplies no
  // `grounding`, so its entries stay byte-identical (AC8).
  // ADAAAA-7962 (contract v4 §3.7): dedupe at the SAME seam, capped at the
  // contract's max (2 identical delivered lines per job) — not "drop every
  // repeat". The stored set is then exactly the set the page renders, so the
  // API cannot ship a row the page would never show (v3 stored 27, page 26).
  const deduped = grounding
    ? dedupeStoredLines(text, log.map((e) => e.text), MAX_LINE_OCCURRENCES)
    : text;
  if (!deduped) {
    return store.patchJob(jobId, { runningSummary: summary }).then(() => log);
  }
  // ADAAAA-7962 (contract v4 §3.5): quiet rows may carry colour on at most 40%
  // of quiet rows. The budget is computed from the STORED log, so it holds for
  // the delivered set without a second build at read time.
  const verdict = grounding ? ((grounding.verdict ?? null) as SummaryLogEntry["verdict"]) : undefined;
  let delivered = deduped;
  if (grounding && isQuietVerdict(verdict) && captionColour(delivered)) {
    const quiet = log.filter((e) => isQuietVerdict((e as { verdict?: string | null }).verdict));
    const quietColour = quiet.filter((e) => captionColour(e.text ?? "")).length;
    if (quietColour + 1 > Math.ceil(MAX_QUIET_COLOUR_SHARE * (quiet.length + 1))) {
      delivered = dedupeStoredLines(
        dropColourClause(delivered),
        log.map((e) => e.text),
        MAX_LINE_OCCURRENCES
      ) || deduped;
    }
  }
  const entry: SummaryLogEntry = {
    seq,
    ts: new Date().toISOString(),
    ...(windowTs != null ? { windowTs } : {}),
    ...(verdict ? { verdict } : {}),
    // The per-window content the model added this pass; fall back to the whole
    // bounded summary so a pass is never silently dropped from the log.
    text: delivered,
    // ADAAAA-7962 (contract v4 §3.1): exactly one AUDIT-ONLY raw field per row,
    // set only when the gate changed what is delivered. Never a narrative.
    ...(grounding && delivered !== rawText && rawText.trim() ? { text_raw: rawText } : {}),
  };
  const nextLog = [...log, entry];
  return store.patchJob(jobId, { runningSummary: summary, summaryLog: nextLog }).then(() => nextLog);
}

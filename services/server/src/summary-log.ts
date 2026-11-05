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
  captionLead,
  colourTraceFor,
  completeCaptionLine,
  groundSummaryText,
  captionLineKey,
  captionColour,
  dedupeStoredLines,
  dropColourClause,
  isQuietVerdict,
  MAX_LINE_OCCURRENCES,
  regateServedSentence,
  restoreTerminalPunctuation,
  suppressScoreClaims,
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
/**
 * ADAAAA-8043 (contract v7 §3.1) — the 40 % quiet-row colour cap, applied to the
 * WHOLE delivered set after the rows are built.
 *
 * The v4/v5 seam decided the cap incrementally, from the rows already SEEN. That
 * refuses a beat because of the row's POSITION in the stream (`floor(0.4 * 1) = 0`
 * blocks the very first quiet row), and QA v6 measured the consequence: 0 of 25
 * delivered lines carried a beat while 13 windows were eligible. The budget is a
 * property of the DELIVERED SET, so it is computed there: quiet rows on the stored
 * log plus this pass, at most `floor(0.4 * n)` of them may carry a beat. The LAST
 * rows lose their beat first (story order keeps the earliest), and a row whose
 * de-beated line collides with one already delivered is dropped rather than
 * stored twice.
 */
export function applyQuietColourCap(
  log: SummaryLogEntry[],
  keptRows: SummaryLogEntry[],
  storedTexts: string[]
): void {
  const isQuiet = (e: SummaryLogEntry) => isQuietVerdict((e as { verdict?: string | null }).verdict);
  const all = [...log, ...keptRows].filter(isQuiet);
  const allowed = Math.floor(MAX_QUIET_COLOUR_SHARE * all.length);
  let withBeat = all.filter((e) => captionColour(e.text ?? "")).length;
  if (withBeat <= allowed) return;
  const delivered = [...storedTexts];
  for (let i = keptRows.length - 1; i >= 0 && withBeat > allowed; i -= 1) {
    const row = keptRows[i];
    if (!isQuiet(row) || !captionColour(row.text ?? "")) continue;
    const stripped = restoreTerminalPunctuation(dropColourClause(row.text ?? ""));
    if (!stripped) continue;
    // Contract v8 §3b.3: the stored trace must say WHY the row carries no beat.
    // A beat the cap removed is `quiet-cap`, not a non-firing derivation.
    const trace = (row as { colourTrace?: { clause?: string; beat?: string } }).colourTrace;
    if (trace) {
      trace.clause = "quiet-cap";
      delete trace.beat;
    }
    delete (row as { colour?: unknown }).colour;
    // A de-beated line that another row already delivered is a duplicate: drop
    // the row instead of appending the same sentence twice.
    if (dedupeStoredLines(stripped, delivered, MAX_LINE_OCCURRENCES) !== stripped) {
      keptRows.splice(i, 1);
    } else {
      row.text = stripped;
      delivered.push(stripped);
    }
    withBeat -= 1;
  }
}

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
  const verdict = grounding ? ((grounding.verdict ?? null) as SummaryLogEntry["verdict"]) : undefined;
  // ADAAAA-7961: a 15 s summary row holds ONE line. A pass that adds several
  // lines used to store them as a single newline-joined row, so the page showed
  // two sentences in one row (`Player in possession in center circle.` /
  // `No. 10 strikes ball into net`). Each added line is its own row now. VOD
  // passes no `grounding`, so its entry stays byte-identical (AC8).
  const rawRows = grounding ? rawText.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const rows = rawRows.length > 0 ? rawRows : [rawText];
  const storedTexts = log.map((e) => e.text);
  const keptRows: SummaryLogEntry[] = [];
  for (const raw of rows) {
    // ADAAAA-7948 (Inc 3): the grounding gate. Every FAST caption is filtered
    // before it becomes a user-visible Video Summary item: no goal claim without
    // the window's own verdict, no name the window's prompt cannot corroborate,
    // no internal token. The rolling `runningSummary` is deliberately NOT gated —
    // it is model input for the next window, not customer copy.
    const grounded = grounding ? groundSummaryText(raw, grounding) : raw;
    // ADAAAA-8043 (contract v7 §3.1/§3.2): the derived colour beat rides at the
    // end; the COMPLETENESS gate grades and repairs the LEAD (actor + action +
    // place), and the beat is re-attached to the repaired lead. A lead that
    // cannot be made complete is suppressed rather than stored malformed.
    const quiet = !!grounding && isQuietVerdict(verdict);
    const beat = captionColour(grounded);
    const repaired = grounding
      ? completeCaptionLine({
          candidate: captionLead(grounded),
          raw,
          quiet,
          place: grounding.place ?? null,
          regate: (sentence) => regateServedSentence(sentence, grounding),
        })
      : grounded;
    if (!repaired) continue;
    // ADAAAA-8043 (§3.5): terminal punctuation is normalised at WRITE on the
    // FAST rail, so the page can render a stored row byte-identically (AC10 has
    // nothing to repair). VOD passes no grounding and stays byte-identical (AC8).
    const deliveredLine = grounding
      ? restoreTerminalPunctuation(
          beat ? `${repaired.replace(/[.!?…]+$/, "").trim()} — ${beat}` : repaired
        )
      : grounded;
    // ADAAAA-8059 (PO ruling, lever 3): the SCORELINE fact gate runs at WRITE, not
    // at read. An uncorroborated scoreline is a claim, and the string the seam
    // stores is the string the page renders — so the stored text must ALREADY be
    // the suppressed string. Then stored == served stays absolute (AC3b/AC10), the
    // ladder stays a pure read, and the fact gate keeps failing closed. The
    // model's own line survives in `text_raw` (audit only). Both rails run it: the
    // VOD path has no grounding context, so a read-time gate there would be the
    // same "page may differ from the store" hole.
    const scoredLine = suppressScoreClaims(deliveredLine);
    // ADAAAA-7956 (contract v3 rule 2) + ADAAAA-7962 (v4 §3.7): a line the job
    // has already emitted is not appended again, capped at the contract's max (2
    // identical delivered lines per job) — not "drop every repeat". De-dup reads
    // the STORED log plus the rows this same pass already kept, so a pass cannot
    // duplicate itself. ADAAAA-8059: it runs on the SUPPRESSED line, so the stored
    // set and the served set agree about what "the same line" is.
    const priorKept = keptRows.map((r) => r.text);
    const deduped = grounding
      ? dedupeStoredLines(scoredLine, [...storedTexts, ...priorKept], MAX_LINE_OCCURRENCES)
      : scoredLine;
    if (!deduped) continue;
    keptRows.push({
      seq: seq + keptRows.length,
      ts: new Date().toISOString(),
      ...(windowTs != null ? { windowTs } : {}),
      ...(verdict ? { verdict } : {}),
      // The per-window content the model added this pass; fall back to the whole
      // bounded summary so a pass is never silently dropped from the log.
      text: deduped,
      // ADAAAA-7965 (contract v5 §3.1, R18): when the delivered row carries a
      // colour beat, store the measurement it was derived from and the frame that
      // confirms it. A row without `colour` carries no beat.
      ...(grounding?.colourSignal && captionColour(deduped) ? { colour: grounding.colourSignal } : {}),
      // ADAAAA-7962 (contract v4 §3.1): exactly one AUDIT-ONLY raw field per row,
      // set only when the gate changed what is delivered. Never a narrative.
      ...(grounding && deduped !== raw && raw.trim() ? { text_raw: raw } : {}),
      // Contract v8 §3b.3 (ADAAAA-8053): the per-row colour decision — signal
      // present?, which gate clause decided, and the beat the row carries. This
      // is the trace QA reads instead of re-deriving why AC4 did or did not fire.
      ...(grounding ? { colourTrace: colourTraceFor(grounding, deduped, windowTs) } : {}),
    });
  }
  if (keptRows.length === 0) {
    return store.patchJob(jobId, { runningSummary: summary }).then(() => log);
  }
  applyQuietColourCap(log, keptRows, storedTexts);
  const nextLog = [...log, ...keptRows];
  return store.patchJob(jobId, { runningSummary: summary, summaryLog: nextLog }).then(() => nextLog);
}

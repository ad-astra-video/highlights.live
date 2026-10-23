// Append-only per-pass summary time log + end-of-video overall summary
// (ADAAAA-7237). The decide/gemma brain maintains a single BOUNDED rolling
// `runningSummary` (story-so-far) that compacts by dropping the OLDEST lines
// first, so per-pass detail is lost and there is no end-of-video overview.
//
// This module adds:
//   (a) `summaryDelta` — the incremental per-pass content (what the model
//       concluded for THIS window), derived from the running-summary delta.
//   (b) `appendSummaryEntry` — the server-side append-only write: each cadence
//       pass appends a `{ seq, ts, text }` entry to `job.summaryLog`, never
//       overwriting/reordering a past entry, and persists the bounded rolling
//       `runningSummary` alongside it (so the model-input story-so-far stays a
//       bounded string, distinct from the durable log).
//   (c) `applyOverallSummary` — at job completion, one text-only `/app/summary`
//       decide call compiles the full time log + confirmed highlights into a
//       single overall summary persisted as `job.overallSummary` (a distinct
//       field from `runningSummary`), with a deterministic fallback and a
//       run-once guard so it never double-charges or blocks the job.
//
// Kept in its own module (like job-title.ts) so the append + compile logic can
// be unit-tested without driving the full VOD/live pipeline.
import type { Job, HighlightRecord, SummaryLogEntry } from "@highlights/events";
import type { Store } from "./store";
import type { ServerConfig } from "./config";

/** p95 overall-summary budget (~2 s): how long to wait on the decide summary call. */
export const OVERALL_SUMMARY_TIMEOUT_MS = 2500;

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
  /** Timestamp (ms) of the observe window / tick this entry summarizes. */
  windowTs?: number;
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
  const entry: SummaryLogEntry = {
    seq,
    ts: new Date().toISOString(),
    ...(meta?.windowTs != null ? { windowTs: meta.windowTs } : {}),
    // The per-window content the model added this pass; fall back to the whole
    // bounded summary so a pass is never silently dropped from the log.
    text: delta || summary,
  };
  const nextLog = [...log, entry];
  return store.patchJob(jobId, { runningSummary: summary, summaryLog: nextLog }).then(() => nextLog);
}

/**
 * ADAAAA-7237: deterministic overall summary (fallback / rule mode). Names each
 * accepted highlight with its event type + timestamp and summarizes the time
 * log as an overview of the whole video (not just the tail). Used when the
 * decide service is unavailable or returns nothing useful — a completed job
 * always ends up with an overall summary.
 */
export function fallbackOverallSummary(
  job: Pick<Job, "gameHint">,
  highlights: HighlightRecord[],
  log: SummaryLogEntry[] | undefined
): string {
  const accepted = highlights.filter((h) => h.status === "accepted");
  const lines: string[] = [];
  const header = job.gameHint ? `Overview of ${job.gameHint} video` : "Video overview";
  lines.push(header);
  if (accepted.length > 0) {
    lines.push(`Points of interest (${accepted.length}):`);
    for (const h of accepted) {
      const ts = formatTimestamp(h.start);
      const label = h.eventType || "event";
      const at = ts ? ` at ${ts}` : "";
      lines.push(`- ${label}${at}${h.reason ? ` — ${h.reason}` : ""}`);
    }
  } else {
    lines.push("No confirmed highlights.");
  }
  if (log && log.length > 0) {
    lines.push("Timeline:");
    for (const e of log.slice(-12)) {
      const at = e.windowTs != null ? ` @${formatTimestamp(e.windowTs)}` : "";
      lines.push(`- [${e.seq}]${at} ${firstLine(e.text)}`);
    }
  }
  return lines.join("\n");
}

/** Format a second-based timestamp as `mm:ss` (or `h:mm:ss` when >= 1 h). */
function formatTimestamp(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function firstLine(text: string): string {
  const t = (text || "").trim();
  if (!t) return "";
  return t.split("\n")[0].slice(0, 160);
}

/**
 * ADAAAA-7237: one text-only `/app/summary` decide call. Sends the compact
 * gameHint + the summary time log + the accepted highlights (event type +
 * timestamp + reason) and returns the compiled overall summary string, or null
 * on any failure (decide down, non-2xx, unparseable) so the caller falls back.
 * Never throws.
 */
export async function requestOverallSummary(
  cfg: Pick<ServerConfig, "decideUrl">,
  job: Pick<Job, "id" | "gameHint">,
  highlights: HighlightRecord[],
  log: SummaryLogEntry[] | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  if (!cfg.decideUrl) return null;
  const accepted = highlights.filter((h) => h.status === "accepted");
  const poi = accepted.map((h) => ({
    eventType: h.eventType ?? "",
    timestamp: h.start,
    reason: h.reason ?? "",
  }));
  const entries = (log ?? []).map((e) => ({
    seq: e.seq,
    ts: e.ts,
    text: e.text,
  }));
  try {
    const r = await fetchImpl(`${cfg.decideUrl.replace(/\/+$/, "")}/app/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gameHint: job.gameHint ?? "",
        pointsOfInterest: poi,
        timeLog: entries,
      }),
      signal: AbortSignal.timeout(OVERALL_SUMMARY_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const data: any = await r.json();
    if (data && typeof data.overallSummary === "string" && data.overallSummary.trim()) {
      return data.overallSummary.trim();
    }
  } catch (e: any) {
    console.error(`[overall-summary:${job.id}] decide summary call failed:`, e?.message || e);
  }
  return null;
}

/**
 * ADAAAA-7237: fire-and-forget overall-summary application at job completion.
 * Exactly one summary call per completed job (guarded by an existing
 * `overallSummary`). Never rejects — the job always ends up with an overall
 * summary (LLM or fallback) and never blocks/fails the job.
 */
export async function applyOverallSummary(
  store: Pick<Store, "getJob" | "highlightsForJob" | "patchJob">,
  cfg: Pick<ServerConfig, "decideUrl">,
  jobId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  try {
    const job = store.getJob(jobId) as Job | undefined;
    if (!job || job.overallSummary) return; // already compiled — exactly one call
    const highlights = store.highlightsForJob(jobId);
    const llm = await requestOverallSummary(cfg, job, highlights, job.summaryLog, fetchImpl);
    await store.patchJob(jobId, { overallSummary: llm || fallbackOverallSummary(job, highlights, job.summaryLog) });
  } catch (e: any) {
    console.error(`[overall-summary:${jobId}] apply overall summary failed:`, e?.message || e);
  }
}

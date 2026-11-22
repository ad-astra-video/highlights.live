// ADAAAA-8143: durable per-frame scoreboard text on `job_observations`.
//
// Why this exists: until now `job_observations` stored `tracks` only (boxes), so
// the score line a frame's OCR actually read was thrown away. Every
// demoted-window re-attestation then had to re-OCR the stored JPEGs (the
// ADAAAA-8139 bounded pixel re-read: <= 8 OCR calls/leg), and grading a past demo
// window from stored text was impossible. Measured on leg
// `bca08173-1418-437e-9c22-24af6b748111`: 431 observation rows, none carried a
// score.
//
// This module owns the ONE definition of what lands in that column, so both
// write paths (`POST /jobs/:id/observe` -> LiveFrameWriter, and the analyze
// observation hook) agree and the reader can replay storage instead of pixels:
//
//  - a frame whose OCR produced a score line stores the OCR LINES it read
//    (`scoreText`), capped and normalized;
//  - a frame whose OCR read no score line stores NULL — never `[]`, never a
//    synthesized `0-0`, never a backfilled value;
//  - a row that never captured text (or whose stored text no longer parses under
//    the current parser) is reported as `not_captured` / `unparseable` by
//    {@link storedScoreCensus}, NEVER as a score of 0.
//
// AC3 (unchanged bound): nothing here reads pixels or calls perceive/decide. The
// column is durability, not a new inference path.
import { parseOcrScoreLine, type TimelineScoreReading } from "./analyzer.js";

/** Max OCR lines kept per frame row. A score-bug crop returns a handful of
 *  lines; the cap bounds the column so a pathological OCR burst cannot bloat
 *  `job_observations`. */
export const SCORE_TEXT_MAX_LINES = 8;
/** Max characters kept per stored line (a scorebug line is far shorter). */
export const SCORE_TEXT_MAX_LINE_CHARS = 200;

/** Normalize raw OCR output to the lines worth storing (trimmed, non-empty,
 *  capped). Never invents a line. */
export function normalizeOcrLines(ocr: unknown): string[] {
  if (!Array.isArray(ocr)) return [];
  const out: string[] = [];
  for (const raw of ocr) {
    if (out.length >= SCORE_TEXT_MAX_LINES) break;
    if (typeof raw !== "string") continue;
    const line = raw.trim().slice(0, SCORE_TEXT_MAX_LINE_CHARS);
    if (!line) continue;
    out.push(line);
  }
  return out;
}

/**
 * The value to persist in `job_observations.score_text` for one frame.
 *
 * Returns the normalized OCR lines ONLY when a score line was actually read
 * (the same `parseOcrScoreLine` the attestation path uses, so the stored text
 * re-parses identically). Returns `null` — stored as SQL NULL — when the frame's
 * OCR produced no score line, which is the AC1 "NULL when no line was read"
 * clause and the AC5 "never a score of 0" rule.
 *
 * The gate runs on the NORMALIZED lines, so what is stored parses to. `sport`
 * rides in because the parser is sport-aware (ADAAAA-8841: a clock is not a
 * score).
 */
export function scoreTextForObservation(ocr: unknown, sport?: string): string[] | null {
  const lines = normalizeOcrLines(ocr);
  if (!lines.length) return null;
  if (!parseOcrScoreLine(lines, sport)) return null;
  return lines;
}

/** Resolve the job's persisted sport (the parser's sport-aware arm). */
export function jobSport(job: { matchContext?: { sport?: unknown } } | undefined): string | undefined {
  const raw = job?.matchContext?.sport;
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  return s || undefined;
}

/** How one stored observation row reads. `not_captured` is the NULL column;
 *  `unparseable` is text that no longer yields a score under the current
 *  parser. Neither is a score reading. */
export type StoredScoreStatus = "captured" | "not_captured" | "unparseable";

/** One observation row as the replay/grader sees it. */
export interface StoredScoreRow {
  seq: number;
  timestamp: number;
  status: StoredScoreStatus;
  /** The stored OCR lines (absent unless `captured`). */
  ocr?: string[];
  /** The score parsed from the stored text (absent unless `captured`). */
  score?: [number, number];
}

export interface StoredScoreCensus {
  /** Rows inspected. */
  rows: number;
  /** Rows whose stored text parses to a score. */
  captured: number;
  /** Rows with a NULL `score_text` — reported as `not_captured`, never 0. */
  notCaptured: number;
  /** Rows that stored text no longer parses (parser moved / partial read). */
  unparseable: number;
  /** The replay timeline: exactly what `scoreReadingsFromTimeline` consumes, so
   *  stored text can be fed into the existing pooled attestation path with no
   *  pixel re-read. */
  readings: TimelineScoreReading[];
}

/** The minimal observation shape the reader needs (a `StoredObservation`). */
export interface PersistedScoreObservation {
  seq: number;
  timestamp: number;
  /** The stored lines; absent/null means the row never captured one. */
  scoreText?: string[] | null;
}

/**
 * Read the persisted score text back as a replay timeline plus an honest count
 * of what was NOT captured.
 *
 * AC5: a partially-read leg leaves NULLs; those rows are counted as
 * `notCaptured` and contribute NO reading, so a grader can never read a missing
 * line as `0-0`.
 */
export function storedScoreCensus(
  observations: ReadonlyArray<PersistedScoreObservation> | undefined,
  opts: { sport?: string } = {}
): StoredScoreCensus {
  const out: StoredScoreCensus = { rows: 0, captured: 0, notCaptured: 0, unparseable: 0, readings: [] };
  for (const obs of observations ?? []) {
    if (!obs || !Number.isFinite(obs.timestamp)) continue;
    out.rows++;
    const lines = normalizeOcrLines(obs.scoreText);
    if (!lines.length) {
      out.notCaptured++;
      continue;
    }
    const score = parseOcrScoreLine(lines, opts.sport);
    if (!score) {
      out.unparseable++;
      continue;
    }
    out.captured++;
    out.readings.push({ ts: obs.timestamp, score });
  }
  out.readings.sort((a, b) => a.ts - b.ts);
  return out;
}

/** One row resolved with its status, for a grader that needs per-frame detail.
 *  Rows are ordered by timestamp so a mixed captured/not-captured leg reads as a
 *  timeline. */
export function storedScoreRows(
  observations: ReadonlyArray<PersistedScoreObservation> | undefined,
  opts: { sport?: string } = {}
): StoredScoreRow[] {
  const rows: StoredScoreRow[] = [];
  for (const obs of observations ?? []) {
    if (!obs || !Number.isFinite(obs.timestamp)) continue;
    const lines = normalizeOcrLines(obs.scoreText);
    const base = { seq: obs.seq, timestamp: obs.timestamp };
    if (!lines.length) {
      rows.push({ ...base, status: "not_captured" });
      continue;
    }
    const score = parseOcrScoreLine(lines, opts.sport);
    if (!score) {
      rows.push({ ...base, status: "unparseable", ocr: lines });
      continue;
    }
    rows.push({ ...base, status: "captured", ocr: lines, score });
  }
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

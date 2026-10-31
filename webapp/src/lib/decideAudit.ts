// ADAAAA-7625: render helpers for the Decide LLM audit rows on the job page.
//
// Each row is one durable `decide_audit` record (`GET /jobs/:id/decide-audit`).
// Before this module the section printed the raw group key and turned missing
// counts into `0`, so a row that recorded nothing was indistinguishable from a
// genuine zero and carried no time at all. These helpers are pure and
// deterministic (UTC wall clock) so the SSR tests and the client render agree:
//
// - in-video time decoded from the group key (`g<floor(ts/3)>`, and the Stage-2
//   `g<NNN>:confirm` shape) rendered as `T+m:ss`;
// - wall clock from `createdAt`, which is stored either as an ISO string
//   (Stage-2 confirm descriptor) or as epoch seconds (the decide service's
//   descriptor, stringified on ingest);
// - `not recorded` / `time not recorded` instead of a fabricated number.
import { goalConfirmedLabel } from "./jobDetail";

/** Shown wherever a field the row never recorded would otherwise print a
 * number. A null count must never render as `0` (ADAAAA-7625 AC2). */
export const NOT_RECORDED = "not recorded";
/** Shown when the group key carries no decodable stream time, or `createdAt` is
 * unparseable (AC1). */
export const TIME_NOT_RECORDED = "time not recorded";

/** Frame-group window used to build the group key: `decideGroupKey`
 * (`services/server/src/analyzer.ts`) is `g${Math.floor(ts / 3)}`. */
export const DECIDE_GROUP_WINDOW_S = 3;

/** Confirmation verdict from the Stage-2 `/confirm` pass (closed set). */
export type GoalConfirmedVerdict = "confirmed_goal" | "near_miss" | "not_goal" | null;

/** The `verdicts` blob a decide_audit row may carry. Stage-2 confirm rows carry
 * the goal/corroboration/stage-1 shape; Stage-1 rows carry the parsed model
 * reply, which is why the remaining keys are optional. */
export interface DecideAuditVerdicts {
  runConfirmationPass?: boolean;
  goalConfirmed?: GoalConfirmedVerdict;
  corroborated?: boolean;
  corroborationSource?: string | null;
  stage1Disagreed?: boolean;
  outcome?: string | null;
  eventType?: string | null;
}

/** Per-call timings recorded by the decide service. */
export interface DecideAuditTimings {
  elapsedMs?: number | null;
  asrLatencyS?: number | null;
}

/** One `decide_audit` row as `GET /jobs/:id/decide-audit` serializes it. All
 * value fields are nullable on purpose: a Stage-2 confirm row records only its
 * verdict, so `frameCount` / `candidateCount` / `promptText` / `timings` are
 * null (never 0) and must render as `not recorded`. */
export interface DecideAuditRecord {
  id: string;
  jobId?: string | null;
  sessionId?: string | null;
  groupKey?: string | null;
  frameCount?: number | null;
  candidateCount?: number | null;
  systemPromptVersion?: string | null;
  promptText?: string | null;
  mediaHashes?: unknown;
  params?: unknown;
  rawReply?: string | null;
  verdicts?: DecideAuditVerdicts | null;
  timings?: DecideAuditTimings | null;
  fallback?: boolean;
  replayable?: boolean;
  createdAt?: string | number | null;
}

/** Decode the stream time (seconds) out of a frame-group key.
 *
 * Accepts the Stage-1 shape `g297` and the Stage-2 confirm shape `g297:confirm`;
 * anything else (absent key, a bare `g`, a suffix that is not ours) returns
 * null so the caller renders `time not recorded` instead of guessing. */
export function decideGroupKeySeconds(groupKey: unknown): number | null {
  if (typeof groupKey !== "string") return null;
  const m = /^g(\d+)(?::([a-z0-9_-]+))?$/i.exec(groupKey.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * DECIDE_GROUP_WINDOW_S;
}

/** Render a stream time as `T+m:ss` (e.g. 297 s -> `T+4:57`). */
export function formatInVideoTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return TIME_NOT_RECORDED;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `T+${m}:${String(s).padStart(2, "0")}`;
}

/** In-video label for a row: decoded group key time, or `time not recorded`. */
export function decideAuditInVideoLabel(groupKey: unknown): string {
  return formatInVideoTime(decideGroupKeySeconds(groupKey));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parse the stored `createdAt`. The field reaches the client in two shapes:
 * epoch seconds as a string (decide-service descriptor, `round(time.time(), 3)`
 * stringified on ingest) and an ISO 8601 string (Stage-2 confirm descriptor). */
export function parseDecideAuditDate(value: unknown): Date | null {
  if (typeof value === "number") return epochToDate(value);
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return null;
    const n = Number(t);
    if (Number.isFinite(n)) return epochToDate(n);
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function epochToDate(n: number): Date | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  // Epoch seconds (~1.7e9) vs epoch milliseconds (~1.7e12).
  const ms = n >= 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Wall-clock label in UTC so SSR and client render identically regardless of
 * the viewer's timezone: `2026-10-31 16:43:07 UTC`. */
export function decideAuditWallClock(createdAt: unknown): string {
  const d = parseDecideAuditDate(createdAt);
  if (!d) return TIME_NOT_RECORDED;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours()
  )}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`;
}

/** A recorded count, or null when the field was never recorded. Numeric strings
 * are accepted because an older serialization stringified the columns. */
export function decideAuditCount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `5 frames` / `1 candidate` / `frames not recorded` — never `0 frames` for a
 * null field (AC2). */
export function decideAuditCountLabel(value: unknown, noun: "frame" | "candidate"): string {
  const n = decideAuditCount(value);
  if (n === null) return `${noun}s ${NOT_RECORDED}`;
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** `timings.elapsedMs` when recorded, otherwise null (the row omits it). */
export function decideAuditElapsedLabel(timings: unknown): string | null {
  if (!timings || typeof timings !== "object" || Array.isArray(timings)) return null;
  const n = decideAuditCount((timings as DecideAuditTimings).elapsedMs);
  if (n === null || n < 0) return null;
  return `${Math.round(n)} ms`;
}

export type DecideAuditChipTone = "ok" | "warn" | "bad" | "muted";

/** One verdict chip: `key` is the stable SSR selector suffix, `tone` maps to a
 * theme token in the component. */
export interface DecideAuditChip {
  key: string;
  label: string;
  tone: DecideAuditChipTone;
}

/** Chips for a row's `verdicts` blob.
 *
 * Confirm rows carry `goalConfirmed` / `corroborated` + `corroborationSource` /
 * `stage1Disagreed`; Stage-1 rows carry the parsed reply, for which `outcome`
 * (or `eventType`) is the readable verdict. Every non-null `verdicts` blob
 * yields at least one chip (AC2), and a null blob yields none. */
export function decideAuditVerdictChips(verdicts: unknown): DecideAuditChip[] {
  if (!verdicts || typeof verdicts !== "object" || Array.isArray(verdicts)) return [];
  const v = verdicts as DecideAuditVerdicts;
  const chips: DecideAuditChip[] = [];

  if ("goalConfirmed" in v) {
    const g = v.goalConfirmed ?? null;
    chips.push({
      key: "goal",
      label: `goal: ${goalConfirmedLabel(g)}`,
      tone: g === "confirmed_goal" ? "ok" : g === "near_miss" ? "warn" : g === "not_goal" ? "bad" : "muted",
    });
  }

  if ("corroborated" in v) {
    const source =
      typeof v.corroborationSource === "string" && v.corroborationSource.trim() !== ""
        ? ` · ${v.corroborationSource.trim()}`
        : "";
    chips.push({
      key: "corroborated",
      label: `${v.corroborated ? "corroborated" : "not corroborated"}${source}`,
      tone: v.corroborated ? "ok" : "muted",
    });
  }

  if (v.stage1Disagreed === true) {
    chips.push({ key: "stage1-disagreed", label: "stage-1 disagreed", tone: "warn" });
  }

  if (chips.length === 0) {
    const outcome =
      typeof v.outcome === "string" && v.outcome.trim() !== ""
        ? v.outcome.trim()
        : typeof v.eventType === "string" && v.eventType.trim() !== ""
          ? v.eventType.trim()
          : null;
    if (outcome) chips.push({ key: "outcome", label: `verdict: ${outcome}`, tone: "muted" });
  }

  if (chips.length === 0) {
    // A non-null verdicts blob whose keys we do not know yet still renders a
    // chip, so "every row with verdicts shows its verdict" holds for future
    // descriptor shapes too.
    chips.push({ key: "recorded", label: "verdict recorded", tone: "muted" });
  }

  return chips;
}

/** Media content hashes as short `#shorthash` references (`#abcdef12`). */
export function decideAuditMediaRefs(mediaHashes: unknown): string[] {
  if (!Array.isArray(mediaHashes)) return [];
  return mediaHashes
    .map((m: any) => (m && typeof m === "object" && typeof m.sha256 === "string" ? `#${m.sha256.slice(0, 8)}` : null))
    .filter((x): x is string => x !== null);
}

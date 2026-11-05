// ADAAAA-7906 (VOD resume, Increments 1+2): the pure part of the resume
// checkpoint — merge rules, cursor maths, phase-skip predicates, retry backoff.
//
// Everything here is a pure function over plain data so it is unit-testable
// without a GPU, a media node or a durable worker:
//
//   - `mergeResumeCheckpoint(prev, patch)`   merge + forward-only cursor
//   - `resumeWarmupS(windowN, fps)`          bounded warm-up window (plan §2.2)
//   - `resumeStartTs(cursorTs, warmupS)`     first frame timestamp to re-perceive
//   - `extractionReusable(extraction, dir, source)`  the extract-phase skip rule
//   - `shouldArmResumeRetry(...)` / `resumeRetryDelayMs(...)`  retry policy
//
// The checkpoint itself is contract-defined in `@highlights/events`
// (`ResumeCheckpointSchema`, additive optional `job.resume`).

import type { ResumeAccumulators, ResumeCheckpoint, ResumePhase } from "@highlights/events";
import { PERCEIVE_PER_HOUR_USD, computeCostUsd } from "./job-settlement";

/** A merge patch for `Store.saveResumeCheckpoint`. Nested blocks merge field by
 * field; `null` on an optional scalar CLEARS it (e.g. `nextAttemptAt` after a
 * manual stop or a claim). */
export interface ResumeCheckpointPatch {
  phase?: ResumePhase;
  extraction?: NonNullable<ResumeCheckpoint["extraction"]>;
  analyze?: Partial<NonNullable<ResumeCheckpoint["analyze"]>>;
  accumulators?: Partial<NonNullable<ResumeCheckpoint["accumulators"]>>;
  attempts?: ResumeCheckpoint["attempts"];
  totalAttempts?: number;
  lastError?: ResumeCheckpoint["lastError"];
  nextAttemptAt?: string | null;
  resumedAt?: string | null;
  resumedFromTs?: number | null;
  maxAttempts?: number;
}

/** Hard cap on the warm-up window (plan §2.2: "capped at the 10 s observe
 * window"). Re-perceiving more than one full observe window before the cursor
 * would re-pay for content the pass already judged. */
export const RESUME_WARMUP_MAX_S = 10;

/** Default: checkpoint every N decided windows (~30 s of content at the 3 s
 * observe cadence). `VOD_RESUME_CHECKPOINT_WINDOWS`. */
export const RESUME_CHECKPOINT_WINDOWS_DEFAULT = 10;

/** Default auto-retry budget (number of RETRIES, so 2 => up to 3 claims).
 * `VOD_RESUME_MAX_ATTEMPTS`. */
export const RESUME_MAX_ATTEMPTS_DEFAULT = 2;

/** Default retry backoff base / cap. `VOD_RESUME_BACKOFF_MS`. */
export const RESUME_BACKOFF_BASE_MS_DEFAULT = 30_000;
export const RESUME_BACKOFF_CAP_MS = 10 * 60_000;

function defined<T>(v: T | null | undefined): v is T {
  return v !== undefined && v !== null;
}

/**
 * Merge a checkpoint patch into the previous checkpoint.
 *
 * Rules that matter:
 * - `analyze.cursorTs` is FORWARD-ONLY: a merge can never move the cursor back,
 *   so a late/duplicate checkpoint write cannot make the next attempt re-judge
 *   (and re-bill) content that was already decided.
 * - Nested blocks (`analyze`, `accumulators`) merge field by field; omitting a
 *   field never erases a previously persisted value.
 * - `null` explicitly clears `nextAttemptAt` / `resumedAt` / `resumedFromTs`.
 */
export function mergeResumeCheckpoint(
  prev: ResumeCheckpoint | undefined,
  patch: ResumeCheckpointPatch
): ResumeCheckpoint {
  const base: ResumeCheckpoint = prev ?? {
    version: 1,
    phase: "extract",
    attempts: [],
    totalAttempts: 0,
  };
  const next: ResumeCheckpoint = {
    version: 1,
    phase: patch.phase ?? base.phase,
    attempts: patch.attempts ? [...patch.attempts] : [...(base.attempts ?? [])],
    totalAttempts: patch.totalAttempts ?? base.totalAttempts ?? 0,
    ...(patch.extraction ? { extraction: patch.extraction } : base.extraction ? { extraction: base.extraction } : {}),
    ...(patch.lastError ? { lastError: patch.lastError } : base.lastError ? { lastError: base.lastError } : {}),
  };
  // analyze: forward-only cursor, field-wise merge.
  if (patch.analyze || base.analyze) {
    const a = base.analyze ?? { cursorTs: 0 };
    const p = patch.analyze ?? {};
    const cursorTs = Math.max(a.cursorTs ?? 0, p.cursorTs ?? 0);
    next.analyze = {
      ...a,
      ...p,
      cursorTs,
      ...(p.lastWindowAt ? { lastWindowAt: p.lastWindowAt } : a.lastWindowAt ? { lastWindowAt: a.lastWindowAt } : {}),
    };
  }
  if (patch.accumulators || base.accumulators) {
    const a = base.accumulators ?? { decideCalls: 0, perceiveSessionS: 0, costUsd: 0 };
    const p = patch.accumulators ?? {};
    next.accumulators = {
      decideCalls: p.decideCalls ?? a.decideCalls ?? 0,
      perceiveSessionS: p.perceiveSessionS ?? a.perceiveSessionS ?? 0,
      costUsd: p.costUsd ?? a.costUsd ?? 0,
      // ADAAAA-7907: wall clock is a running TOTAL across attempts; a patch
      // that omits it keeps the persisted value.
      ...(p.wallClockS !== undefined || a.wallClockS !== undefined
        ? { wallClockS: p.wallClockS ?? a.wallClockS }
        : {}),
      ...(p.stageAMetrics ?? a.stageAMetrics ? { stageAMetrics: p.stageAMetrics ?? a.stageAMetrics } : {}),
      ...(p.confirmMetrics ?? a.confirmMetrics ? { confirmMetrics: p.confirmMetrics ?? a.confirmMetrics } : {}),
      ...(p.vodObserveMetrics ?? a.vodObserveMetrics
        ? { vodObserveMetrics: p.vodObserveMetrics ?? a.vodObserveMetrics }
        : {}),
    };
  }
  // Optional scalars: patch wins, `null` clears, absent keeps the previous value.
  for (const key of ["nextAttemptAt", "resumedAt", "resumedFromTs", "maxAttempts"] as const) {
    const v = patch[key];
    if (v === null) continue; // cleared
    if (v !== undefined) (next as any)[key] = v;
    else if (defined((base as any)[key])) (next as any)[key] = (base as any)[key];
  }
  // A phase change that leaves analyze untouched still keeps the cursor.
  if (!next.analyze && base.analyze) next.analyze = base.analyze;
  return next;
}

/** Warm-up seconds before the cursor that ARE re-perceived, so the first decide
 * window after a resume has real tracks, OCR and goal attestation. Full decide
 * window (windowN / fps = 24/3 = 8 s at defaults), capped at the observe window. */
export function resumeWarmupS(decideWindowN: number | undefined, detailFps: number | undefined): number {
  const n = Number(decideWindowN ?? 0);
  const fps = Number(detailFps ?? 0);
  if (!Number.isFinite(n) || !Number.isFinite(fps) || n <= 0 || fps <= 0) return RESUME_WARMUP_MAX_S;
  return Math.min(n / fps, RESUME_WARMUP_MAX_S);
}

/** First frame timestamp (content seconds) a resumed pass may re-perceive.
 * Frames strictly before this are skipped entirely: never re-perceived, and
 * their windows are never re-issued. */
export function resumeStartTs(cursorTs: number | undefined, warmupS: number): number {
  const c = Number(cursorTs ?? 0);
  if (!Number.isFinite(c) || c <= 0) return 0;
  return Math.max(0, c - Math.max(0, Number(warmupS) || 0));
}

/** Warm-up frames count = ceil(warmupS * fps) — the AC3 budget headroom. */
export function resumeWarmupFrames(warmupS: number, detailFps: number | undefined): number {
  const fps = Number(detailFps ?? 0);
  if (!Number.isFinite(fps) || fps <= 0) return 0;
  return Math.max(0, Math.ceil(warmupS * fps));
}

export interface SourceIdentity {
  bytes: number;
  mtimeMs: number;
}

export interface ExtractionCheck {
  /** The frame directory exists and holds at least one frame file. */
  frameDirUsable: boolean;
  /** Current identity of the source file; `null` when it cannot be stat'ed. */
  source: SourceIdentity | null;
}

/**
 * The extract-phase skip rule (plan §2.2). Extraction is skipped ONLY when all
 * three hold: the checkpoint says extraction completed, the frame directory
 * still exists and is non-empty, and the source identity (bytes + mtime) still
 * matches what the previous attempt extracted. Anything else re-extracts.
 */
export function extractionReusable(
  checkpoint: ResumeCheckpoint | undefined,
  check: ExtractionCheck
): boolean {
  const ext = checkpoint?.extraction;
  if (!ext || ext.complete !== true) return false;
  if (!check.frameDirUsable || ext.frameCount <= 0) return false;
  if (!check.source) return false;
  return check.source.bytes === ext.sourceBytes && Math.abs(check.source.mtimeMs - ext.sourceMtimeMs) < 1;
}

/** Number of failed (ended) attempts recorded in the checkpoint. */
export function failedAttemptCount(checkpoint: ResumeCheckpoint | undefined): number {
  return (checkpoint?.attempts ?? []).filter((a) => !!a.endedAt).length;
}

/**
 * ADAAAA-7907 scope guard: ONLY a VOD `file` job can be resumed. A live or
 * browser share cannot be replayed from a cursor — its ingest is gone — so the
 * retry policy must never convert a live failure into a `queued` VOD row. (A
 * live job re-armed as `queued` would never be claimed by the VOD drain — it has
 * no local source path — and would sit non-terminal forever.) Its honest outcome
 * stays the attributed terminal failure.
 */
export function resumeEligibleSource(source: "file" | "rtmp" | "webrtc" | "screenshare" | "browser" | "file-sim" | undefined): boolean {
  return source === "file";
}

/**
 * Retry policy (plan §2.3): arm a retry when the failure is classified
 * resumable AND the retry budget (default 2 retries) is not spent. `maxRetries`
 * is the number of RETRIES, not total claims.
 */
export function shouldArmResumeRetry(
  resumable: boolean,
  checkpoint: ResumeCheckpoint | undefined,
  maxRetries = RESUME_MAX_ATTEMPTS_DEFAULT
): boolean {
  if (!resumable) return false;
  const max = Number.isFinite(maxRetries) ? Math.max(0, Math.floor(maxRetries)) : RESUME_MAX_ATTEMPTS_DEFAULT;
  return failedAttemptCount(checkpoint) < max;
}

/** Exponential backoff on the retry number: base 30 s, doubling, capped at
 * 10 min. `retriesUsed` is the count of retries already armed (0 for the first). */
export function resumeRetryDelayMs(
  retriesUsed: number,
  baseMs = RESUME_BACKOFF_BASE_MS_DEFAULT,
  capMs = RESUME_BACKOFF_CAP_MS
): number {
  const n = Math.max(0, Math.floor(Number(retriesUsed) || 0));
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : RESUME_BACKOFF_BASE_MS_DEFAULT;
  const cap = Number.isFinite(capMs) && capMs > 0 ? capMs : RESUME_BACKOFF_CAP_MS;
  return Math.min(base * 2 ** n, cap);
}

/** Whether a `queued` job's armed retry is due. Jobs without an armed retry
 * (`nextAttemptAt` absent) are always due — the pre-resume behaviour. */
export function resumeRetryDue(nextAttemptAt: string | undefined, nowMs = Date.now()): boolean {
  if (!nextAttemptAt) return true;
  const at = Date.parse(nextAttemptAt);
  if (!Number.isFinite(at)) return true;
  return at <= nowMs;
}

// ---------------------------------------------------------------------------
// ADAAAA-7907 (VOD resume, Increments 3+4): attempt accounting + the one
// resume entry point's pure parts.
//
// A resumed job's cost/attempt numbers are assembled from TWO sources: the
// cross-attempt `resume.accumulators` (every attempt that ENDED, including the
// ones that failed) plus the deltas of the attempt that is finishing now. These
// helpers are pure so the arithmetic is unit-tested without a GPU.
// ---------------------------------------------------------------------------

/** One attempt's spend deltas. */
export interface AttemptDelta {
  decideCalls?: number;
  perceiveSessionS?: number;
  costUsd?: number;
  wallClockS?: number;
}

/** The number fields of `resume.accumulators` that are summed. */
export interface AttemptTotals {
  decideCalls: number;
  perceiveSessionS: number;
  costUsd: number;
  wallClockS: number;
}

/** The money rates a settle path prices a counter block with. Only the decide
 * fee is configurable; the perceive rate is the shared list price
 * (`job-settlement.PERCEIVE_PER_HOUR_USD`), so a completed record and a
 * checkpoint can never disagree about what a second of perceive costs. */
export interface AttemptPricing {
  decideFee: number;
}

/** USD a counter block already OWES: every decided window costs its fee and
 * every billed perceive second costs its share of the hourly rate.
 *
 * ADAAAA-8089: this is the floor a folded cost may never fall below. The calls
 * were made and billed, so a total that reports less than this is under-reported
 * by construction — which is exactly what a checkpoint that carried
 * `decideCalls` without the fees used to produce. */
export function impliedCostUsd(
  totals: { decideCalls?: number; perceiveSessionS?: number },
  pricing: AttemptPricing
): number {
  return computeCostUsd(nonNeg(totals.decideCalls), nonNeg(totals.perceiveSessionS), nonNeg(pricing.decideFee));
}

function nonNeg(v: number | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Sum a finished attempt's deltas onto the cross-attempt accumulators.
 *
 * `prev` is the checkpoint's accumulator block READ AT CLAIM, i.e. the total of
 * every attempt that already ended. That is what makes AC9 hold: the completed
 * record carries both attempts, not only the last one.
 *
 * ADAAAA-8089: when `pricing` is supplied the folded cost is floored at the cost
 * its counters imply (`impliedCostUsd`). Without the floor, a base written by a
 * build that persisted `decideCalls` but not the fees (every mid-attempt
 * checkpoint before this fix) makes a resumed job close at the LAST attempt's
 * spend only — the record then reports 31 decides at the price of 10. With it, a
 * resumed job always closes `costUsd >= decideFee * decideCalls`, including a
 * job whose attempt 1 ran the old image and attempt 2 ran this one. */
export function accumulateAttemptTotals(
  prev: ResumeAccumulators | undefined,
  delta: AttemptDelta,
  pricing?: AttemptPricing
): AttemptTotals {
  const decideCalls = Math.round(nonNeg(prev?.decideCalls) + nonNeg(delta.decideCalls));
  const perceiveSessionS = Number((nonNeg(prev?.perceiveSessionS) + nonNeg(delta.perceiveSessionS)).toFixed(1));
  const summedCostUsd = nonNeg(prev?.costUsd) + nonNeg(delta.costUsd);
  const floorCostUsd = pricing ? impliedCostUsd({ decideCalls, perceiveSessionS }, pricing) : 0;
  return {
    decideCalls,
    perceiveSessionS,
    costUsd: Number(Math.max(summedCostUsd, floorCostUsd).toFixed(4)),
    wallClockS: Number((nonNeg(prev?.wallClockS) + nonNeg(delta.wallClockS)).toFixed(1)),
  };
}

/**
 * ADAAAA-8089 (root cause): the accumulator block for an attempt that is STILL
 * RUNNING.
 *
 * A mid-attempt checkpoint used to persist only `decideCalls`, so a process that
 * was then killed (deploy recreate, OOM, SIGKILL) left `costUsd: 0` behind for
 * every window attempt 1 had already billed; the resumed attempt started a fresh
 * meter on top of a zero base. This folds the running attempt's decide count and
 * billed perceive seconds onto the claim-time base exactly as the exit hooks do,
 * so the values boot recovery finds on disk are the spend that actually happened.
 *
 * `attempt` carries THIS attempt's counters so far (never the cross-attempt
 * totals): the base is `prev`, read at claim, so repeated checkpoint writes
 * overwrite with a running total instead of accumulating.
 */
export function runningAttemptAccumulators(
  prev: ResumeAccumulators | undefined,
  attempt: { decideCalls?: number; perceiveSessionS?: number; wallClockS?: number },
  pricing: AttemptPricing
): AttemptTotals {
  const decideCalls = nonNeg(attempt.decideCalls);
  const perceiveSessionS = nonNeg(attempt.perceiveSessionS);
  return accumulateAttemptTotals(
    prev,
    {
      decideCalls,
      perceiveSessionS,
      // The fees these counters have already incurred: the same quantity the
      // completion/failure paths compute from their own attempt deltas.
      costUsd: impliedCostUsd({ decideCalls, perceiveSessionS }, pricing),
      wallClockS: nonNeg(attempt.wallClockS),
    },
    pricing
  );
}

/**
 * Close the OPEN attempt entry (the one the claim appended) with an
 * attribution. Idempotent: when every entry is already closed the list is
 * returned unchanged, so a boot sweep over an already-attributed attempt cannot
 * rewrite it.
 *
 * Boot recovery relies on this: the interrupted attempt is recorded as
 * `server-restart` at the phase it was running, so the resumed claim appends
 * attempt N+1 to a clean trail.
 */
export function closeOpenAttempt(
  attempts: ResumeCheckpoint["attempts"] | undefined,
  patch: { now: string; phase: ResumePhase; reason: NonNullable<AttemptEntry["failureReason"]>; error?: string }
): ResumeCheckpoint["attempts"] {
  const list = [...(attempts ?? [])];
  const openIdx = list.map((a) => !a.endedAt).lastIndexOf(true);
  if (openIdx < 0) return list;
  list[openIdx] = {
    ...list[openIdx],
    endedAt: patch.now,
    failedAtPhase: patch.phase,
    failureReason: patch.reason,
    ...(patch.error ? { error: patch.error } : {}),
  };
  return list;
}

type AttemptEntry = NonNullable<ResumeCheckpoint["attempts"]>[number];

/** Running counters the OPEN attempt persists on its own trail entry (AC10). */
export interface AttemptProgress {
  resumedFromTs?: number;
  skippedFrames?: number;
  warmupFrames?: number;
  decideCalls?: number;
  perceiveCalls?: number;
}

const nonNegInt = (v: unknown): number | undefined => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n);
};

const nonNegNumber = (v: unknown): number | undefined => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
};

/**
 * ADAAAA-7907 (AC10, crash half): record the OPEN attempt's running counters on
 * its own trail entry, so an attempt that dies without running its exit hook
 * still has evidence on disk.
 *
 * Returns `undefined` when no attempt is open (every entry already closed), so
 * the caller can skip a pointless write. Values that are missing or garbage keep
 * the entry's previous value — nothing is ever cleared, and the persisted
 * counters never go backwards within an attempt.
 */
export function recordAttemptProgress(
  attempts: ResumeCheckpoint["attempts"] | undefined,
  progress: AttemptProgress
): ResumeCheckpoint["attempts"] | undefined {
  const list = [...(attempts ?? [])];
  const openIdx = list.map((a) => !a.endedAt).lastIndexOf(true);
  if (openIdx < 0) return undefined;
  const cur = list[openIdx];
  const skippedFrames = nonNegInt(progress.skippedFrames);
  const warmupFrames = nonNegInt(progress.warmupFrames);
  const decideCalls = nonNegInt(progress.decideCalls);
  const perceiveCalls = nonNegInt(progress.perceiveCalls);
  const resumedFromTs = nonNegNumber(progress.resumedFromTs);
  list[openIdx] = {
    ...cur,
    ...(resumedFromTs !== undefined ? { resumedFromTs } : {}),
    ...(skippedFrames !== undefined ? { skippedFrames } : {}),
    ...(warmupFrames !== undefined ? { warmupFrames } : {}),
    ...(decideCalls !== undefined ? { decideCalls } : {}),
    ...(perceiveCalls !== undefined ? { perceiveCalls } : {}),
  };
  return list;
}

/**
 * ADAAAA-7907 (AC10, crash half): the evidence line for an attempt that is
 * still OPEN, i.e. one that was killed instead of exiting through the worker.
 * Read BEFORE `closeOpenAttempt` rewrites the entry (the close keeps the fields).
 *
 * Honest limits, stated rather than papered over: the counts are the values the
 * attempt persisted at its LAST checkpoint write (every
 * `VOD_RESUME_CHECKPOINT_WINDOWS` decided windows, default 10 ≈ 30 s of
 * content), so a kill inside the first interval reports the zeros it had
 * persisted. Nothing can recover counters that were never written to disk.
 */
export function interruptedAttemptEvidence(
  jobId: string,
  checkpoint: ResumeCheckpoint | undefined
): ResumeAttemptEvidence | null {
  const list = [...(checkpoint?.attempts ?? [])];
  const openIdx = list.map((a) => !a.endedAt).lastIndexOf(true);
  if (openIdx < 0) return null;
  const e = list[openIdx];
  return {
    jobId,
    attempt: e.attempt,
    phase: e.failedAtPhase ?? checkpoint?.phase ?? "analyze",
    // The cursor the killed attempt had PERSISTED — the same quantity a
    // worker-exit line reports (how far analysis got), never the start point.
    cursorTs: checkpoint?.analyze?.cursorTs ?? e.resumedFromTs ?? 0,
    skippedFrames: e.skippedFrames,
    warmupFrames: e.warmupFrames,
    decideCalls: e.decideCalls,
    perceiveCalls: e.perceiveCalls,
    exitKind: "boot-recovered",
  };
}

/**
 * The attempt number the NEXT claim will carry. `totalAttempts` on the record
 * must equal the number of CLAIMS (AC9), so the resume entry point reserves the
 * next claim's number here and the claim itself writes the same value — never
 * `+1` twice for one attempt.
 */
export function nextAttemptNumber(checkpoint: ResumeCheckpoint | undefined): number {
  return Math.max(nonNeg(checkpoint?.totalAttempts), checkpoint?.attempts?.length ?? 0) + 1;
}

/** Human-facing resume point: `T+12:30` for a content timestamp in seconds. */
export function resumePointLabel(resumedFromTs: number | undefined): string | null {
  const ts = Number(resumedFromTs ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const total = Math.floor(ts);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `T+${h > 0 ? `${h}:${mmss}` : mmss}`;
}

/**
 * How the attempt ENDED, as reported by its one evidence line:
 *
 * - `worker-exit`    the attempt left through `processVodJob` (success, failure
 *                    or operator stop), so the line is written in its `finally`.
 * - `boot-recovered` the attempt was ended by a hard kill (SIGKILL / OOM / a
 *                    deploy recreate) and closed by `recoverStaleVodJobs` on the
 *                    next boot. A killed process never reaches a `finally`, so
 *                    this line is synthesized from the PERSISTED checkpoint —
 *                    that is what makes attempt counting work after a crash.
 */
export type ResumeExitKind = "worker-exit" | "boot-recovered";

/** Inputs of the ONE per-attempt evidence line (AC10). */
export interface ResumeAttemptEvidence {
  /** The job the line belongs to, so one grep can count one job's attempts. */
  jobId: string;
  attempt: number;
  phase: ResumePhase;
  /** Content seconds this attempt REACHED (its last applied decide window, as
   * persisted). The point it resumed FROM lives on the record
   * (`resume.resumedFromTs` / the attempt entry), never in this field. */
  cursorTs?: number;
  skippedFrames?: number;
  warmupFrames?: number;
  decideCalls?: number;
  perceiveCalls?: number;
  exitKind: ResumeExitKind;
}

/**
 * The single greppable evidence line, one per attempt:
 *
 *   [vod-resume] job=2445a379… attempt=2 phase=analyze cursor=48.0
 *                skippedFrames=120 warmupFrames=24 decideCalls=8 perceiveCalls=90
 *                exitKind=worker-exit
 *
 * Fixed prefix + fixed key order, so `docker logs highlights-server | grep
 * '\[vod-resume\]' | grep <jobId>` yields exactly one row per attempt — and
 * `exitKind` says whether the attempt left through the worker or was cut off by
 * a kill and recovered at boot.
 */
export function formatResumeAttemptLine(e: ResumeAttemptEvidence): string {
  return (
    `[vod-resume] job=${e.jobId} attempt=${e.attempt} phase=${e.phase} ` +
    `cursor=${Number(e.cursorTs ?? 0).toFixed(1)} ` +
    `skippedFrames=${Math.round(nonNeg(e.skippedFrames))} ` +
    `warmupFrames=${Math.round(nonNeg(e.warmupFrames))} ` +
    `decideCalls=${Math.round(nonNeg(e.decideCalls))} ` +
    `perceiveCalls=${Math.round(nonNeg(e.perceiveCalls))} ` +
    `exitKind=${e.exitKind}`
  );
}

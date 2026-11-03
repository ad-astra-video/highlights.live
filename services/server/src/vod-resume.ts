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

import type { ResumeCheckpoint, ResumePhase } from "@highlights/events";

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
      ...(p.stageAMetrics ?? a.stageAMetrics ? { stageAMetrics: p.stageAMetrics ?? a.stageAMetrics } : {}),
      ...(p.confirmMetrics ?? a.confirmMetrics ? { confirmMetrics: p.confirmMetrics ?? a.confirmMetrics } : {}),
      ...(p.vodObserveMetrics ?? a.vodObserveMetrics
        ? { vodObserveMetrics: p.vodObserveMetrics ?? a.vodObserveMetrics }
        : {}),
    };
  }
  // Optional scalars: patch wins, `null` clears, absent keeps the previous value.
  for (const key of ["nextAttemptAt", "resumedAt", "resumedFromTs"] as const) {
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

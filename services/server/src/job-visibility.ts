// ADAAAA-7727 (Inc 1 of ADAAAA-7726): role-based visibility for internal
// pipeline / media-server / cost diagnostics.
//
// Both layers have always carried `user.role` (services/server/src/auth.ts seeds
// `admin` and `user`), but nothing gated on it, so a customer session could read
// the per-job cost, decide/perceive counters, the audio Stage-A snapshot and the
// media-session handles straight off the job payloads (and the webapp rendered
// them). The CEO saw exactly that while screen sharing.
//
// This module is the single, pure source of truth for "which job fields are
// internal". It is IO-free so the rule is unit-testable, and every API response
// that carries a job goes through it: the job list, job detail, composite job
// detail, create/upload responses and the SSE job-event stream.
//
// Deliberate exceptions (never filtered):
// - `liveProgress` (ADAAAA-7741) on GET /jobs/:id and GET /jobs/:id/detail.
//   This is the customer's OWN "how live is this" reading: the live edge, the
//   content ts of the newest decided window, the delta between them and how many
//   windows the lag budget swallowed. It is a read-time PROJECTION of the lag
//   diagnostics, not the diagnostics themselves — it never carries
//   `observeMetrics`, `costUsd`, `decideCalls`, `stageAMetrics` or any per-call
//   spend/pipeline detail (derivation: services/server/src/live-progress.ts). The
//   CEO reported that live analysis "does not stream as it is done" with no way
//   to see how far behind it is; suppressing this object would leave the customer
//   with no honest answer. It rides TOP-LEVEL on the payload (not inside `job`),
//   so the projections below carry it through untouched.
// - `wsUrl` / `mediaOrigin` / `mediaSessionId` on the POST /jobs/:id/media
//   HANDSHAKE response. Those are transport credentials the capture client needs
//   to stream (WebRTC signaling uses origin + session id; the WS fallback uses
//   wsUrl). The scope keeps `wsUrl` for that reason, and stripping the RTC pair
//   would silently downgrade every customer screen share to the WS rail. The
//   gate for those is the CLIENT: nothing renders them for a non-admin.
// - `framesAnalyzed` / `highlightsFound` / progress. Customer-facing work
//   counters, not spend or pipeline internals.

/** Roles allowed to see internal diagnostics. Exact match: `admin_readonly`
 * (the standalone measurement token) only grants the read-only `/admin/*`
 * routes, so it is filtered like any other non-admin principal here. */
export function isAdminRole(role?: string | null): boolean {
  return role === "admin";
}

/**
 * Job fields that describe the internal pipeline and its cost. A response to a
 * non-admin request omits every one of them.
 *
 * `observeMaxFramesPerCall` / `observeSubsampledCalls` are the flat names the
 * spec uses for the decide-observer input-size caps; the persisted record keeps
 * them inside `observeMetrics` / `vodObserveMetrics` (`maxFrames`,
 * `subsampledCalls`), so both spellings are filtered defensively.
 */
export const INTERNAL_JOB_KEYS = [
  "costUsd",
  // ADAAAA-8061: the partial (perceive-leg-only) cost written when the decide
  // count could not be measured. Same spend class as `costUsd`, so it is gated
  // the same way; `costUnavailable` (the named REASON, no money) stays visible
  // so an owner can still tell "not measured" from a genuine zero.
  "partialCostUsd",
  "decideCalls",
  "perceiveSessionS",
  "observeCalls",
  "observeSubsampledCalls",
  "observeMaxFramesPerCall",
  "stageAMetrics",
  "stageAMetricsStatus",
  "observeMetrics",
  "vodObserveMetrics",
  "confirmMetrics",
  // ADAAAA-8544: the frozen decide-knob stamp carries the per-job PREDICTED
  // spend (`predictedUsdPerHour` + its band) — the same spend class as `costUsd`
  // above — so a customer payload omits it. The customer states their posture at
  // start (cadence + cap) and that control is theirs; the stamped dollar figure
  // on the record stays an operator/audit read (the window audit echoes it).
  "decideKnob",
  // ADAAAA-7907 (VOD resume Inc 4): the per-job cost meter. `vodMeter` carries
  // `costUsd`, `decideCalls` and the $/video-hour price row — the same spend
  // diagnostics the keys above hide — and it landed (ADAAAA-7821) after this
  // gate was written, so it is filtered here rather than left as a bleed path.
  // The customer-facing resume point/attempt number is unaffected: it rides the
  // `resume` PROJECTION below, which drops the accumulator block instead.
  "vodMeter",
  // ADAAAA-7928 (Inc 1 of ADAAAA-7925): the per-stage timing block carries
  // `perceiveSessionMs` — billable GPU session seconds, the same spend class as
  // `vodMeter` above — and it exists for the admin-only cost/time panel (spec
  // D1). Filtered for a non-admin owner like the rest of the internal pipeline.
  "stageTimings",
  // ADAAAA-7889 (AC2, PO scope split on ADAAAA-7890): `matchContextEvidence` is
  // deliberately NOT an internal key any more. AC2 says an `unknown` match-context
  // result must be diagnosable from `GET /jobs/:id` alone, and the graded route is
  // the owning user's — filtering the whole object left it `null` there, so the
  // per-channel breakdown AC2 requires was invisible on the very route it names.
  // The object is now PROJECTED for a non-admin by `publicMatchContextEvidence`:
  // the explanation (per-channel outcomes, the fold, the kit clusters, the reason)
  // stays, and the one genuine transport handle inside it (`sessionId`, the live
  // perceive session id) is dropped, which is what the ADAAAA-7727 rule protects.
  "perceiveSessionId",
  "mediaSessionId",
  "mediaOrigin",
  // ADAAAA-7723 landed the audio-trigger coverage ledger + per-family onset
  // latency on the job record (after this gate was written). Same class of
  // internal pipeline diagnostic (per-trigger accounting and latency), so it is
  // filtered here too rather than left as a new bleed path.
  "triggerWindows",
  "triggerReconciled",
  "triggerLatencyByFamily",
] as const;

export type InternalJobKey = (typeof INTERNAL_JOB_KEYS)[number];

type AnyRecord = Record<string, any>;

/** The one genuinely internal sub-field of the match-context evidence: the live
 * perceive session id that produced it. The rest of the object is explanation
 * (which OCR lines were read, what commentary named, the fold) — the AC2
 * diagnosis surface. */
const INTERNAL_EVIDENCE_KEYS = ["sessionId"] as const;

/**
 * ADAAAA-7907 (VOD resume, Increments 3+4): project `job.resume` for a
 * non-admin caller.
 *
 * The customer-facing half of the checkpoint is the operability trail — the
 * phase the pass stopped in, the content timestamp it resumed from, the attempt
 * number and the per-attempt attribution. That is what makes "resumed from
 * T+12:30, attempt 2 of 3" renderable on the owner's page (AC8).
 *
 * The other half is spend and pipeline accounting (`accumulators.costUsd` /
 * `decideCalls` / `perceiveSessionS`, plus `usdSpent` per attempt) and stays
 * behind the ADAAAA-7727 role gate exactly like `job.costUsd`. So a non-admin
 * gets the same block with those keys removed; the stored record is untouched.
 */
const INTERNAL_RESUME_KEYS = ["accumulators"] as const;

/** {@link INTERNAL_RESUME_KEYS} as a projection over the resume checkpoint. */
export function publicResumeCheckpoint<T>(resume: T): T | undefined {
  if (!resume || typeof resume !== "object") return undefined;
  const copy: AnyRecord = { ...(resume as AnyRecord) };
  for (const key of INTERNAL_RESUME_KEYS) delete copy[key];
  if (Array.isArray(copy.attempts)) {
    copy.attempts = copy.attempts.map((a: AnyRecord) => {
      if (!a || typeof a !== "object") return a;
      const attempt = { ...a };
      delete attempt.usdSpent;
      return attempt;
    });
  }
  return copy as T;
}

/**
 * Project `matchContextEvidence` for a non-admin caller (ADAAAA-7889 AC2).
 *
 * Returns a shallow copy with the transport-handle keys removed, or `undefined`
 * when the record carries no evidence. Admin callers never reach this (every
 * projection short-circuits on `isAdminRole`), so the operator surface keeps the
 * stored object untouched.
 */
export function publicMatchContextEvidence<T>(evidence: T): T | undefined {
  if (!evidence || typeof evidence !== "object") return undefined;
  const copy: AnyRecord = { ...(evidence as AnyRecord) };
  for (const key of INTERNAL_EVIDENCE_KEYS) delete copy[key];
  return copy as T;
}

/**
 * Project a job record for one caller's role. Admins get the record untouched
 * (same object identity, so no copy cost on the operator path); anyone else gets
 * a shallow copy with the internal keys removed. The stored record is never
 * mutated and the input object is never mutated.
 */
export function jobForRole<T>(job: T, role?: string | null): T {
  if (!job || isAdminRole(role)) return job;
  const copy: AnyRecord = { ...(job as AnyRecord) };
  for (const key of INTERNAL_JOB_KEYS) delete copy[key];
  // ADAAAA-7889 (AC2): the evidence explanation survives for the owning user;
  // only its perceive-session handle is stripped (see INTERNAL_EVIDENCE_KEYS).
  if ("matchContextEvidence" in copy) {
    const projected = publicMatchContextEvidence(copy.matchContextEvidence);
    if (projected === undefined) delete copy.matchContextEvidence;
    else copy.matchContextEvidence = projected;
  }
  // ADAAAA-7907 (AC8): the resume point + attempt number survive for the owning
  // user; the spend accumulators inside them do not (see publicResumeCheckpoint).
  if ("resume" in copy) {
    const projected = publicResumeCheckpoint(copy.resume);
    if (projected === undefined) delete copy.resume;
    else copy.resume = projected;
  }
  return copy as T;
}

/** {@link jobForRole} over a job list. */
export function jobsForRole<T>(jobs: T[], role?: string | null): T[] {
  if (isAdminRole(role)) return jobs;
  return (jobs ?? []).map((job) => jobForRole(job, role));
}

/**
 * Project the composite `GET /jobs/:id/detail` payload: the embedded `job`
 * record is filtered, the frame/section/highlight surfaces are untouched (those
 * are the customer's own explainability view of their clips).
 */
export function jobDetailForRole<T>(payload: T, role?: string | null): T {
  if (!payload || isAdminRole(role)) return payload;
  const copy = payload as AnyRecord;
  return { ...copy, job: jobForRole(copy.job ?? {}, role) } as T;
}

/**
 * Project one SSE job event for a caller's role. Today's analyze events carry no
 * cost fields, but they are fanned from the same job record family and a future
 * event could embed one, so the stream is filtered defensively at the send
 * boundary (top-level keys plus any embedded `job`).
 */
export function jobEventForRole<T>(ev: T, role?: string | null): T {
  if (!ev || isAdminRole(role)) return ev;
  const copy: AnyRecord = { ...(ev as AnyRecord) };
  for (const key of INTERNAL_JOB_KEYS) delete copy[key];
  if (copy.job && typeof copy.job === "object") copy.job = jobForRole(copy.job, role);
  return copy as T;
}

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
  // ADAAAA-7868 landed the match-context evidence status (scorebug OCR frame
  // counts, kit sample/cluster counts, per-source capture status, the perceive
  // session id that produced them). Same class of internal pipeline diagnostic
  // as the trigger ledger above: it is an OPERATOR explainability surface, not
  // customer-facing, so it is filtered here rather than left as a new bleed
  // path. `matchContext` itself stays visible — the inferred teams/colours are
  // the customer's explainability view; only the evidence accounting is internal.
  "matchContextEvidence",
] as const;

export type InternalJobKey = (typeof INTERNAL_JOB_KEYS)[number];

type AnyRecord = Record<string, any>;

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

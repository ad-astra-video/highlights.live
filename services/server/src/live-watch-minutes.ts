// ADAAAA-7722: live WATCH-MINUTES — the measured basis for the ADAAAA-7713
// spend envelope's monthly ceiling.
//
// The envelope was priced against a continuous-attachment basis
// (1,440 min/day x 30.44 days = 43,833.6 min/month) because nothing on the box
// reported how much live footage the rails actually observed. Without a
// measured number the ceiling is a named assumption, not a measurement, and the
// per-minute whistle rates the envelope turns on cannot be normalised.
//
// Two surfaces:
//
//   - PER SESSION: `job.liveWatchMinutes` — persisted at live completion from
//     the measurement each rail already has (`perceiveSessionS` on the live
//     RTMP/file-sim rail, the media node's `sessionSeconds` on the browser/RTC
//     rail). No new clock, no new inference: the same seconds the cost record is
//     billed on.
//   - MONTH TO DATE: {@link aggregateLiveWatchMinutes} over the persisted jobs,
//     exposed by `GET /admin/live-watch-minutes`.
//
// Only LIVE sessions count. A VOD `file`/`upload`/`url` job is not a watch
// window: it decodes a file as fast as the box allows, so counting its wall
// minutes would inflate the ceiling with compute time instead of watch time.
//
// Pure (no IO) so the aggregation is unit-testable in isolation.

/** Server `Job.source` values that describe a LIVE watch session. Mirrors the
 *  `JobSchema.source` enum in `@highlights/events`. */
const LIVE_SOURCES = new Set(["rtmp", "webrtc", "screenshare", "browser", "file-sim"]);

/** The `YYYY-MM` UTC month key for a date (defaults to now). UTC, not local, so
 *  a month is the same month on the box (CST) and in a report. */
export function monthKeyUtc(at: Date | number = new Date()): string {
  const d = typeof at === "number" ? new Date(at) : at;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Whether a job record describes a live watch session. */
export function isLiveWatchSession(job: { source?: string }): boolean {
  return typeof job.source === "string" && LIVE_SOURCES.has(job.source);
}

/** The measured watch-minutes for one job record.
 *
 *  Prefers the persisted `liveWatchMinutes` (written at completion from the
 *  rail's own session clock). Falls back to deriving it from the legacy
 *  `perceiveSessionS` field so pre-ADAAAA-7722 records on the live rail still
 *  contribute instead of reading as an unmeasured zero. Returns null when the
 *  record carries no measurement at all — never a fabricated 0. */
export function liveWatchMinutesForJob(job: {
  source?: string;
  liveWatchMinutes?: number;
  perceiveSessionS?: number;
}): number | null {
  if (!isLiveWatchSession(job)) return null;
  const stored = job.liveWatchMinutes;
  if (typeof stored === "number" && Number.isFinite(stored) && stored >= 0) return stored;
  const secs = job.perceiveSessionS;
  if (typeof secs === "number" && Number.isFinite(secs) && secs >= 0) return Number((secs / 60).toFixed(3));
  return null;
}

/** The UTC month a live session belongs to: the moment it started, else when
 *  the record was created (a job row with no `startedAt` never ran, but it still
 *  has a creation month). Null when neither timestamp parses. */
export function sessionMonthUtc(job: { startedAt?: string; createdAt?: string }): string | null {
  const raw = job.startedAt ?? job.createdAt;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return monthKeyUtc(ms);
}

export interface LiveWatchMinutesSession {
  jobId: string;
  minutes: number;
  startedAt: string | null;
}

export interface LiveWatchMinutesReport {
  /** The UTC month key this report covers (`YYYY-MM`). */
  month: string;
  /** Month-to-date live watch-minutes — the measured ceiling basis. */
  liveWatchMinutes: number;
  /** Live sessions counted in the total. */
  sessions: number;
  /** Live sessions in the month with no measurement (pre-ADAAAA-7722 records
   *  and sessions that never completed). Reported, never counted as 0. */
  unmeasuredSessions: number;
  /** Per-session breakdown, oldest first. */
  perSession: LiveWatchMinutesSession[];
}

/** Aggregate the month-to-date live watch-minutes from job records. Pure: the
 *  caller supplies the records (store or DB list), so the same function backs the
 *  admin route and the tests. */
export function aggregateLiveWatchMinutes(
  jobs: {
    id: string;
    source?: string;
    liveWatchMinutes?: number;
    perceiveSessionS?: number;
    startedAt?: string;
    createdAt?: string;
  }[],
  month: string = monthKeyUtc()
): LiveWatchMinutesReport {
  const perSession: LiveWatchMinutesSession[] = [];
  let unmeasured = 0;
  let total = 0;
  for (const job of jobs) {
    if (!isLiveWatchSession(job)) continue;
    if (sessionMonthUtc(job) !== month) continue;
    const minutes = liveWatchMinutesForJob(job);
    if (minutes === null) {
      unmeasured += 1;
      continue;
    }
    total += minutes;
    perSession.push({ jobId: job.id, minutes, startedAt: job.startedAt ?? job.createdAt ?? null });
  }
  perSession.sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
  return {
    month,
    liveWatchMinutes: Number(total.toFixed(3)),
    sessions: perSession.length,
    unmeasuredSessions: unmeasured,
    perSession,
  };
}

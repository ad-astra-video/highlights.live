// ADAAAA-7907 (VOD resume, Increments 3+4): the operator-facing reading of
// `job.resume` — the resume point and the attempt number, kept pure so the
// rendering and the wording are pinned by a unit test (AC8) without driving
// the whole job page.
//
// The contract lives in `@highlights/events` (`ResumeCheckpointSchema`); this
// module only mirrors the fields the page reads. A non-admin caller receives the
// block with `accumulators` / `usdSpent` removed server-side (job-visibility.ts),
// so nothing here ever renders spend.

/** The subset of `job.resume` the page renders. */
export interface ResumeView {
  /** Contract version (`ResumeCheckpointSchema.version`); carried through as-is. */
  version?: number;
  phase?: string;
  /** Content seconds the pass resumed from ("T+12:30"). */
  resumedFromTs?: number;
  resumedAt?: string;
  totalAttempts?: number;
  /** Total claims the retry policy allows (1 + retries); absent on old records. */
  maxAttempts?: number;
  /** Set only while an automatic retry is armed (`status: queued`). */
  nextAttemptAt?: string;
  attempts?: Array<{
    attempt: number;
    startedAt: string;
    endedAt?: string;
    failedAtPhase?: string;
    failureReason?: string;
  }>;
  analyze?: { cursorTs?: number };
}

/** What one row/header shows about the resume. */
export interface ResumeReading {
  /** "T+12:30" — null when the pass never resumed (or resumed from the start). */
  point: string | null;
  /** "attempt 2 of 3" */
  attempt: string | null;
  /** "retry scheduled" while an automatic retry is armed. */
  retryArmed: boolean;
  /** True when this record shows evidence of a retry/resume having happened. */
  resumed: boolean;
}

/** `T+12:30` for a content timestamp in seconds (mirrors the server label). */
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
 * Read `job.resume` for the surface.
 *
 * Returns null when the job carries no checkpoint at all, and a reading with
 * `resumed: false` for a first attempt that has a checkpoint but never resumed
 * (a live-progress checkpoint is written from the first claim). That distinction
 * matters: every VOD job has a checkpoint, only a retried one has a resume
 * point, and a first pass must not claim to be a resume.
 */
export function readResume(resume: ResumeView | undefined | null): ResumeReading | null {
  if (!resume) return null;
  // `resumedFromTs` is the cursor the CURRENT attempt picked up from; the live
  // `analyze.cursorTs` is where the pass has got TO, so it must never be read as
  // a resume point (a first pass advances it past zero within seconds).
  const point = resumePointLabel(resume.resumedFromTs);
  const claims = Math.max(0, Math.floor(Number(resume.totalAttempts ?? 0)));
  const max = Math.max(0, Math.floor(Number(resume.maxAttempts ?? 0)));
  const endedAttempts = (resume.attempts ?? []).filter((a) => !!a.endedAt).length;
  // A resume happened when a second claim is recorded or a prior attempt ended:
  // every VOD job has a checkpoint, only a retried one has a resume point.
  const resumed = claims > 1 || endedAttempts > 0;
  const attempt =
    claims > 0 ? (max >= claims ? `attempt ${claims} of ${max}` : `attempt ${claims}`) : null;
  return { point, attempt, retryArmed: !!resume.nextAttemptAt, resumed };
}

/** The one-line "resumed from" text: `Resumed from T+12:30 · attempt 2 of 3`. */
export function resumeTrailText(resume: ResumeView | undefined | null): string | null {
  const reading = readResume(resume);
  if (!reading || !reading.resumed) return null;
  const parts: string[] = [];
  if (reading.point) parts.push(`Resumed from ${reading.point}`);
  if (reading.attempt) parts.push(reading.attempt);
  if (reading.retryArmed) parts.push("retry scheduled");
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Whether the FAILED state of the job page offers a Resume action (AC8).
 * Mirrors the route's preconditions so the button is not offered where the
 * server would answer 409: a VOD `file` job that failed and still carries a
 * checkpoint.
 */
export function canResume(job: {
  source?: string;
  status?: string;
  resume?: ResumeView | null;
}): boolean {
  return job.source === "file" && job.status === "failed" && !!job.resume;
}

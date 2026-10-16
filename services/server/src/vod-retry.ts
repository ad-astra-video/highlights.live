// Durable, server-driven retry for session-404'd VOD jobs (ADAAAA-6763).
//
// A VOD pass that dies on a perceive-runner/session 404 (SessionLostError) is
// no longer permanently `failed`; it is parked into a RETRYABLE state on the
// job row (retryAttempts / maxRetryAttempts / nextRetryAt / lastError) and a
// periodic server worker re-claims it once `nextRetryAt` passes, with lenient
// exponential backoff, until it either reaches `done` or exhausts maxAttempts
// (then it fails cleanly and the error is surfaced on GET /jobs/:id).
//
// Re-runs are idempotent: frames are extracted once and reused, and highlights
// carry a deterministic id so a re-played pass never double-persists or
// double-bills (see analyzer.highlightId + persistLiveHighlight dedupe).
import type { Db, User } from "./db";
import type { Store } from "./store";
import type { ServerConfig } from "./config";
import type { Job } from "@highlights/events";
import { SessionLostError } from "./analyzer";

export interface VodRetryDeps {
  store: Store;
  cfg: ServerConfig;
  db: Db;
  /** The VOD pipeline runner (runVodJob from buildApp). Expected to set the
   * job `done` on success and throw on failure. */
  runVod: (job: { id: string; gameHint?: string; preferLabels?: string[]; sourceUrl?: string }, videoPath: string, user: User, sub: any) => Promise<unknown>;
  /** Inject a clock for deterministic tests; defaults to Date.now(). */
  now?: () => number;
  log?: (msg: string) => void;
}

/** Whether an error is a transient, worth-retrying VOD failure. The primary
 * case is a perceive runner/session 404 (SessionLostError, or a 404/503 with a
 * runner/session-not-found message), which go-livepeer produces when a static
 * runner's health flaps and it releases the in-flight session. Any other error
 * (bad source, ffmpeg decode failure) is permanent and fails the job now. */
export function isRetryableVodError(e: unknown): boolean {
  if (e instanceof SessionLostError) return true;
  const msg = String((e as any)?.message || e || "");
  return /404|runner not found|runner session not found|503|temporarily unavailable|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|EPIPE/i.test(msg);
}

/** Lenient exponential backoff for retry scheduling (15s -> 30s -> 60s -> cap).
 * `attempt` is 1-based. Returns the delay BEFORE the given attempt may run. */
export function retryBackoffMs(attempt: number, baseMs: number, capMs: number): number {
  if (attempt <= 1) return Math.min(baseMs, capMs);
  return Math.min(baseMs * 2 ** (attempt - 1), capMs);
}

export interface FailureRecord {
  retryable: boolean;
  attempts: number;
  maxAttempts: number;
  delayMs?: number;
  nextRetryAt?: string;
}

/** Record a VOD failure on the job row: park it into a retryable state (with a
 * backoff `nextRetryAt`) when the error is transient and attempts remain, or
 * fail it permanently when the error is non-retryable or maxAttempts is spent.
 * Returns what was recorded so the caller can surface it (e.g. HTTP 202 vs 500). */
export async function recordVodFailure(
  deps: { store: Store; cfg: ServerConfig; now?: () => number },
  jobId: string,
  error: unknown
): Promise<FailureRecord> {
  const { store, cfg } = deps;
  const maxAttempts = cfg.vodRetryMaxAttempts;
  const job = store.getJob(jobId);
  const prior = job?.retryAttempts ?? 0;
  const nextAttempt = prior + 1;
  const lastError = String((error as any)?.message || error);
  const retryable = isRetryableVodError(error);
  if (!retryable || nextAttempt >= maxAttempts) {
    // Permanent: no retry window, surface lastError on GET /jobs/:id.
    await store.patchJob(jobId, {
      status: "failed",
      lastError,
      nextRetryAt: undefined,
      retryAttempts: nextAttempt,
      maxRetryAttempts: maxAttempts,
    });
    return { retryable: false, attempts: nextAttempt, maxAttempts };
  }
  const delayMs = retryBackoffMs(nextAttempt, cfg.vodRetryBaseDelayMs, cfg.vodRetryMaxDelayMs);
  const nextRetryAt = new Date((deps.now ? deps.now() : Date.now()) + delayMs).toISOString();
  await store.patchJob(jobId, {
    status: "failed",
    lastError,
    nextRetryAt,
    retryAttempts: nextAttempt,
    maxRetryAttempts: maxAttempts,
  });
  return { retryable: true, attempts: nextAttempt, maxAttempts, delayMs, nextRetryAt };
}

/** VOD jobs currently due for a retry attempt: failed (retryable) with attempts
 * remaining and a `nextRetryAt` that has passed. Source `file` only (the only
 * source served from a local path that can be re-run from existing frames). */
export function listDueVodRetries(store: Store, nowMs: number): Job[] {
  return store.listJobs().filter((j) => {
    if (j.status !== "failed") return false;
    if (j.source !== "file") return false;
    if (typeof j.retryAttempts !== "number" || typeof j.maxRetryAttempts !== "number") return false;
    if (j.retryAttempts >= j.maxRetryAttempts) return false;
    if (!j.nextRetryAt) return false;
    return new Date(j.nextRetryAt).getTime() <= nowMs;
  });
}

/** Run ONE retry attempt for a due job. Claims it (status -> active) so a
 * concurrent tick can't re-claim, then re-runs the pass; on success the pass
 * marks the job `done`, on failure recordVodFailure re-parks it (or fails it
 * permanently). Errors are swallowed into the job's retry state — the sweep
 * never throws out of a single job. */
export async function runVodRetryAttempt(deps: VodRetryDeps, job: Job): Promise<void> {
  const { store, db, runVod, log } = deps;
  await store.patchJob(job.id, { status: "active" });
  try {
    const videoPath = job.sourceUrl;
    if (!videoPath) throw new Error("job has no sourceUrl to retry");
    const owner = job.ownerId ? await db.getUserById(job.ownerId) : undefined;
    if (!owner) throw new Error(`job ${job.id} owner (${job.ownerId}) not found`);
    const sub = await db.getSubscription(owner.id);
    await runVod(job, videoPath, owner, sub);
    // runVodJob already set status done; clear the retry watermark so a later
    // health flap on the same job doesn't inherit a stale backoff.
    await store.patchJob(job.id, { retryAttempts: 0, nextRetryAt: undefined, lastError: undefined });
  } catch (e) {
    log?.(`[vod:${job.id}] retry attempt failed: ${String((e as any)?.message || e)}`);
    await recordVodFailure(deps, job.id, e);
  }
}

/** Banner sweep: run every due retryable VOD job once, in nextRetryAt order.
 * Returns how many attempts it performed (for tests + the tick log). */
export async function runVodRetrySweep(deps: VodRetryDeps): Promise<number> {
  const nowMs = deps.now ? deps.now() : Date.now();
  const due = listDueVodRetries(deps.store, nowMs).sort(
    (a, b) => new Date(a.nextRetryAt!).getTime() - new Date(b.nextRetryAt!).getTime()
  );
  let ran = 0;
  for (const job of due) {
    await runVodRetryAttempt(deps, job);
    ran++;
  }
  return ran;
}

/** A periodic worker that drives the retry sweep on an interval. Returns a
 * handle the caller can start/stop and drive on demand from tests. */
export interface VodRetryWorker {
  /** Run one sweep now (testable / on demand). Returns attempts performed. */
  tick(): Promise<number>;
  start(): void;
  stop(): void;
}

export function createVodRetryWorker(deps: VodRetryDeps): VodRetryWorker {
  let timer: ReturnType<typeof setInterval> | null = null;
  const log = deps.log ?? ((m: string) => console.log(m));
  const worker: VodRetryWorker = {
    async tick() {
      return runVodRetrySweep(deps);
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        worker
          .tick()
          .then((ran) => {
            if (ran > 0) log(`[vod-retry] swept ${ran} retry attempt(s)`);
          })
          .catch((e) => log(`[vod-retry] sweep error: ${String(e?.message || e)}`));
      }, deps.cfg.vodRetrySweepIntervalMs);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
  return worker;
}

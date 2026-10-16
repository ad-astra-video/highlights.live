// Async-VOD job queue helpers + the `useProcessingJobs` React hook
// (ADAAAA-6760). The server now accepts a VOD upload with HTTP 202
// { job, accepted: true } immediately and runs the analyze pipeline in the
// background; this module is the webapp's client for the resulting job queue:
// it fetches GET /jobs, polls while any job is queued/active, streams each
// in-flight job's /jobs/:id/events SSE channel for near-instant progress
// (polling stays as the backstop), and merges refreshes into the queue.
//
// Pure helpers (isInFlight, mergeJobLists) are exported separately so they are
// unit-testable without a DOM or React (see vodJobs.test.ts).
import { useEffect, useRef, useState, useCallback } from "react";
import { api, getToken, type Job } from "./api";
import { readSSE } from "./sse";

/** Poll cadence for GET /jobs while any job is queued/active (ms). The SSE
 * channel gives sub-second progress; this interval is the backstop that picks
 * up status transitions (queued->active, ->done/failed) that are not emitted
 * as dedicated SSE events. */
export const VOD_POLL_MS = 15_000;

/** True while a job still has background work outstanding (not yet terminal). */
export function isInFlight(status: string | undefined): boolean {
  return status === "queued" || status === "active";
}

/** Clamp a job's progress into 0..100 for a progress bar; defaults to 0 when
 * absent or non-finite (e.g. a done job that never reported progress). */
export function jobProgressPct(job: Pick<Job, "progress"> | undefined): number {
  const p = job?.progress ?? 0;
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, p));
}

/** Merge a polling/SSE refresh `next` into `prev`, deduped by id (the freshest
 * record wins) and sorted newest-first by createdAt. Newest-first mirrors the
 * server's GET /jobs ordering so the queue keeps a stable, human-sensible
 * order across refreshes. */
export function mergeJobLists(prev: Job[], next: Job[]): Job[] {
  const byId = new Map<string, Job>();
  for (const j of prev) byId.set(j.id, j);
  for (const j of next) byId.set(j.id, j); // `next` wins on a duplicate id
  return [...byId.values()].sort((a, b) => {
    if (a.createdAt === b.createdAt) return 0;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
}

export interface ProcessingJobsState {
  jobs: Job[];
  /** Force a GET /jobs refresh (e.g. right after submitting a new upload so the
   * new job appears immediately rather than at the next poll tick). */
  refresh: () => Promise<Job[]>;
}

/**
 * Fetch the caller's job queue on mount, poll GET /jobs every VOD_POLL_MS while
 * ANY job is queued/active, stop the interval once none are in flight (and
 * resume on the next in-flight job), and subscribe each in-flight job to its
 * own /jobs/:id/events SSE channel so progress/status stream in near-instantly.
 * The returned `jobs` list is merged (deduped, newest-first) and live-updated
 * from both the poll backstop and the SSE progress events.
 */
export function useProcessingJobs(): ProcessingJobsState {
  const [jobs, setJobs] = useState<Job[]>([]);
  const jobsRef = useRef<Job[]>([]);
  const subsRef = useRef<Map<string, AbortController>>(new Map());

  const refresh = useCallback(async (): Promise<Job[]> => {
    try {
      const r = await api<{ jobs: Job[] }>("/jobs");
      const next = mergeJobLists(jobsRef.current, r.jobs ?? []);
      jobsRef.current = next;
      setJobs(next);
      return next;
    } catch {
      // transient network/API error — keep the current queue and let the next
      // poll retry; never surface a raw error here.
      return jobsRef.current;
    }
  }, []);

  // Apply an in-place patch (e.g. an SSE progress update) to one job without a
  // full queue refresh, so progress stays smooth between poll ticks.
  const patchJob = useCallback((id: string, patch: Partial<Job>) => {
    setJobs((prev) => {
      const next = prev.map((j) => (j.id === id ? { ...j, ...patch } : j));
      jobsRef.current = next;
      return next;
    });
  }, []);

  const anyInFlight = jobs.some((j) => isInFlight(j.status));

  // Poll backstop. Runs once on mount and every VOD_POLL_MS while any job is in
  // flight; the effect tears the interval down when the last in-flight job
  // reaches a terminal state and re-arms it when a new one appears.
  useEffect(() => {
    refresh();
    if (!anyInFlight) return;
    const iv = setInterval(() => {
      refresh().catch(() => {});
    }, VOD_POLL_MS);
    return () => clearInterval(iv);
  }, [anyInFlight, refresh]);

  // Subscribe each in-flight job to its own /jobs/:id/events SSE channel so
  // progress updates stream in near-instantly. `progress` events carry
  // { progress, progressLabel }; status transitions and `highlight` events are
  // picked up by the poll backstop / the page's own highlight feed.
  useEffect(() => {
    for (const j of jobs) {
      if (!isInFlight(j.status)) continue;
      if (subsRef.current.has(j.id)) continue; // already subscribed
      const ac = new AbortController();
      subsRef.current.set(j.id, ac);
      readSSE(
        `/jobs/${j.id}/events`,
        getToken(),
        (name, data) => {
          if (name === "progress" && data && typeof data.progress === "number") {
            patchJob(j.id, { progress: data.progress, progressLabel: data.progressLabel });
          }
        },
        ac.signal
      ).catch(() => {
        // stream ended or failed (job finished, or the socket dropped). Drop the
        // subscription so a later in-flight re-poll can re-open it.
        const cur = subsRef.current.get(j.id);
        if (cur) {
          cur.abort();
          subsRef.current.delete(j.id);
        }
      });
    }
    // Tear down subscriptions whose job is no longer in flight (or left the
    // queue) so the SSE fan-in does not leak across a long-lived session.
    for (const [id, ac] of subsRef.current) {
      const j = jobs.find((x) => x.id === id);
      if (!j || !isInFlight(j.status)) {
        ac.abort();
        subsRef.current.delete(id);
      }
    }
  }, [jobs, patchJob]);

  // Abort every open SSE subscription on unmount.
  useEffect(() => {
    const subs = subsRef.current;
    return () => {
      for (const ac of subs.values()) ac.abort();
      subs.clear();
    };
  }, []);

  return { jobs, refresh };
}

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
import { api, getToken, type Job, type Highlight } from "./api";
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

/** Monotonic progress for an in-flight job (ADAAAA-6875 Phase 3 AC: "progress
 * never regresses"). The server emits monotonic progress, but the webapp can
 * receive out-of-order updates (an SSE `progress` event racing a GET /jobs
 * poll merge for the same job), which would visually tick the bar backwards.
 * Returns the larger of the last-seen and incoming value, so the displayed
 * progress for a job that is still running never decreases. */
export function monotonicProgress(prev: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined || !Number.isFinite(next)) return prev;
  if (prev === undefined || !Number.isFinite(prev)) return next;
  return Math.max(prev, next);
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

// --- Increment 2 (ADAAAA-6837): three-surface partition + attribution helpers ---

/** Human label for a job's `source` enum (e.g. "file" -> "File"). */
const SOURCE_LABELS: Record<string, string> = {
  file: "File",
  rtmp: "RTMP",
  webrtc: "WebRTC",
  screenshare: "Screen share",
  browser: "Browser",
  "file-sim": "File (sim)",
};

export function sourceLabel(source: string | undefined): string {
  return (source && SOURCE_LABELS[source]) || source || "Unknown";
}

/**
 * Job display title (ADAAAA-6798 Inc 4), LLM-first with a deterministic
 * fallback: `job.title` when present; else `<gameHint/source> · <n> highlights ·
 * <date>` mirroring the server's fallbackJobTitle; else the 8-char id for a
 * legacy job with no metadata. `nonRejectedCount` is the accepted-plus-pending
 * highlight count (rejected clips are excluded from the count, matching the
 * server's title fallback). `dateIso` is injectable so the fallback string is
 * deterministic under test; defaults to today.
 */
export function jobTitle(
  job: { id: string; title?: string; gameHint?: string; source?: string },
  nonRejectedCount: number,
  dateIso?: string
): string {
  const t = job.title?.trim();
  if (t) return t;
  const who = job.gameHint || job.source;
  if (who) {
    const date = dateIso ?? new Date().toISOString().slice(0, 10);
    return `${who} · ${nonRejectedCount} highlight${nonRejectedCount === 1 ? "" : "s"} · ${date}`;
  }
  return job.id.slice(0, 8);
}

export interface JobPartition {
  /** Still processing (queued/active) — rendered as plain rows. */
  inFlight: Job[];
  /** Terminal success (done) — rendered as completed result cards. */
  completed: Job[];
  /** Terminal failure (failed) — rendered in the collapsed Failed section. */
  failed: Job[];
}

/** Split the GET /jobs queue into the three Increment-2 surfaces. Order is
 * preserved from the (newest-first) queue. */
export function partitionJobs(jobs: Job[]): JobPartition {
  return {
    inFlight: jobs.filter((j) => isInFlight(j.status)),
    completed: jobs.filter((j) => j.status === "done"),
    failed: jobs.filter((j) => j.status === "failed"),
  };
}

export interface HighlightGroup {
  /** Job id this bucket came from, or "none" for un-attributed highlights. */
  key: string;
  jobId?: string;
  /** Sub-header label, resolved from the job's source when known. */
  label: string;
  highlights: Highlight[];
}

function newestHighlightAt(hs: Highlight[]): string {
  return hs.reduce((acc, h) => (h.createdAt > acc ? h.createdAt : acc), "");
}

/** Group non-rejected highlights by their source job (`h.jobId`). This is the
 * default "grouped" view of "Your highlights" — every VOD highlight is
 * attributed to the job that produced it. Buckets are ordered newest-first by
 * the job's createdAt (falling back to the newest highlight), and highlights
 * with no jobId (legacy / job-less records) pool under an "Other" group so no
 * clip is dropped. */
export function groupHighlightsByJob(highlights: Highlight[], jobs: Job[]): HighlightGroup[] {
  const buckets = new Map<string, Highlight[]>();
  for (const h of highlights) {
    if (h.status === "rejected") continue;
    const key = h.jobId || "none";
    const list = buckets.get(key) ?? [];
    list.push(h);
    buckets.set(key, list);
  }
  const byId = new Map(jobs.map((j) => [j.id, j]));
  return [...buckets.entries()]
    .map(([key, hs]) => {
      const job = key !== "none" ? byId.get(key) : undefined;
      const label = job
        ? `${sourceLabel(job.source)} · ${job.id.slice(0, 8)}`
        : key === "none"
        ? "Other"
        : `Job ${key.slice(0, 8)}`;
      return { key, jobId: key !== "none" ? key : undefined, label, highlights: hs };
    })
    .sort((a, b) => {
      const aJob = a.jobId ? byId.get(a.jobId) : undefined;
      const bJob = b.jobId ? byId.get(b.jobId) : undefined;
      const aAt = aJob?.createdAt ?? newestHighlightAt(a.highlights);
      const bAt = bJob?.createdAt ?? newestHighlightAt(b.highlights);
      return bAt < aAt ? -1 : bAt > aAt ? 1 : 0;
    });
}

/** Human duration (e.g. "1m 30s") from a millisecond span; "" for non-finite
 * or negative spans so a card can omit a missing/zero duration cleanly. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** The completed-job card's "span/duration" label (completedAt - scheduledAt),
 * or null when either timestamp is absent/unparseable. */
export function jobSpanLabel(job: Job): string | null {
  const start = job.scheduledAt ? Date.parse(job.scheduledAt) : NaN;
  const end = job.completedAt ? Date.parse(job.completedAt) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0) return null;
  return formatDuration(end - start);
}

/** Localized timestamp label for a completed-job card (scheduled/completed),
 * or null when the ISO string is absent/unparseable. */
export function formatJobTime(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

/** Delete a VOD job (and, server-side, its highlights + on-disk artifacts)
 * via the new `DELETE /jobs/:id` endpoint (ADAAAA-6838). Returns once the
 * server has removed it, so the webapp can drop it from the queue + feed. */
export async function deleteJob(id: string): Promise<void> {
  await api(`/jobs/${id}`, { method: "DELETE" });
}

export interface ProcessingJobsState {
  jobs: Job[];
  /** Force a GET /jobs refresh (e.g. right after submitting a new upload so the
   * new job appears immediately rather than at the next poll tick). */
  refresh: () => Promise<Job[]>;
  /** Remove a job from the queue client-side right after a successful
   * `DELETE /jobs/:id` (ADAAAA-6837), so the row/card disappears immediately
   * rather than waiting for the next poll (which merges, never removes). */
  removeJob: (id: string) => void;
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
      const next = mergeJobLists(jobsRef.current, r.jobs ?? []).map((j) => {
        // Phase 3 monotonic guard: for a job that is still in flight, a polling
        // refresh (which can race/lag an SSE progress patch, or return a
        // persisted progress lower than the live value) must never tick the
        // bar backwards. Done/failed jobs keep their persisted progress.
        const old = jobsRef.current.find((o) => o.id === j.id);
        if (isInFlight(j.status) && old && Number.isFinite(j.progress)) {
          return { ...j, progress: monotonicProgress(old.progress, j.progress) };
        }
        return j;
      });
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
  // full queue refresh, so progress stays smooth between poll ticks. Phase 3:
  // an in-flight job's `progress` is never allowed to regress (an SSE update
  // arriving after a higher poll merge, or vice versa).
  const patchJob = useCallback((id: string, patch: Partial<Job>) => {
    setJobs((prev) => {
      const next = prev.map((j) => {
        if (j.id !== id) return j;
        const merged = { ...j, ...patch };
        if (isInFlight(merged.status) && Number.isFinite(patch.progress)) {
          return { ...merged, progress: monotonicProgress(j.progress, patch.progress) };
        }
        return merged;
      });
      jobsRef.current = next;
      return next;
    });
  }, []);

  // Client-side removal of a deleted job (ADAAAA-6837). The poll backstop
  // merges (never removes) jobs, so a `DELETE /jobs/:id` must drop the job from
  // the list here to hide its row/card immediately.
  const removeJob = useCallback((id: string) => {
    setJobs((prev) => {
      const next = prev.filter((j) => j.id !== id);
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

  return { jobs, refresh, removeJob };
}

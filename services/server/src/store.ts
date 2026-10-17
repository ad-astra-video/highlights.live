import { createHash, randomUUID } from "node:crypto";
import {
  HighlightRecordSchema,
  JobSchema,
  JobCandidateSchema,
  type HighlightRecord,
  type Job,
  type JobCandidate,
  type TrackObservation,
} from "@highlights/events";
import type { Db, DatasetRecord } from "./db";

export interface StoredObservation {
  seq: number;
  timestamp: number;
  tracks: TrackObservation[];
}

/**
 * Durable store for jobs + highlights.
 *
 * The store holds the working set (jobs, highlights) in memory for fast reads,
 * and write-throughs every mutation to the persistent `Db` (SQLite in dev,
 * Postgres in prod) so stateful data survives restarts. Call `load()` once at
 * startup (before serving requests) to hydrate the in-memory working set from
 * the backing store.
 *
 * Reads are synchronous (served from memory, which is always in sync because
 * every mutation updates memory first, then the Db). Mutations are async and
 * await the durable write before resolving. Pass `null`/no Db to keep the
 * purely in-memory behaviour used by some unit tests.
 */
export class Store {
  private jobs = new Map<string, Job>();
  private highlights = new Map<string, HighlightRecord>();
  private byJob = new Map<string, string[]>();
  private observations = new Map<string, StoredObservation[]>();
  private candidates = new Map<string, JobCandidate[]>();
  private datasets = new Map<string, DatasetRecord>();
  private readonly db: Db | null;

  constructor(db: Db | null = null) {
    this.db = db;
  }

  /** Hydrate the in-memory working set from the persistent store. Idempotent:
   * re-loading (e.g. after a restart) restores full prior state. */
  async load(): Promise<void> {
    if (!this.db) return;
    const [jobs, highlights, datasets, observations, candidates] = await Promise.all([
      this.db.listJobs(),
      this.db.listHighlights(),
      this.db.listDatasets(),
      this.db.listObservations(),
      this.db.listJobCandidates(),
    ]);
    this.jobs.clear();
    this.highlights.clear();
    this.byJob.clear();
    this.observations.clear();
    this.candidates.clear();
    this.datasets.clear();
    for (const j of jobs) this.jobs.set(j.id, j);
    for (const h of highlights) {
      this.highlights.set(h.id, h);
      const list = this.byJob.get(h.jobId) ?? [];
      list.push(h.id);
      this.byJob.set(h.jobId, list);
    }
    for (const { jobId, observation } of observations) {
      const list = this.observations.get(jobId) ?? [];
      list.push(observation);
      this.observations.set(jobId, list);
    }
    for (const c of candidates) {
      const list = this.candidates.get(c.jobId) ?? [];
      list.push(c);
      this.candidates.set(c.jobId, list);
    }
    for (const d of datasets) this.datasets.set(d.id, d);
  }

  async createJob(input: { id?: string; ownerId?: string; source: "file" | "rtmp" | "webrtc" | "screenshare" | "browser"; sourceUrl?: string; gameHint?: string; preferLabels?: string[]; sampleFps?: number }): Promise<Job> {
    const id = input.id ?? randomUUID();
    const job: Job = JobSchema.parse({
      id,
      ownerId: input.ownerId,
      source: input.source,
      sourceUrl: input.sourceUrl,
      gameHint: input.gameHint,
      preferLabels: input.preferLabels ?? [],
      sampleFps: input.sampleFps,
      status: "queued",
      createdAt: new Date().toISOString(),
    });
    this.jobs.set(id, job);
    if (this.db) await this.db.saveJob(job);
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** All jobs currently held in memory. */
  listAllJobs(): Job[] {
    return [...this.jobs.values()];
  }

  /** Jobs belonging to `ownerId` (or every job when `ownerId` is omitted/undefined
   * — the admin case), newest first, capped at `limit`. This is the data path for
   * the new GET /jobs surface so the webapp can render processing/done/failed
   * rows without ever leaking another user's jobs. */
  listJobsForOwner(ownerId?: string, limit = 50): Job[] {
    let arr = [...this.jobs.values()];
    if (ownerId) arr = arr.filter((j) => j.ownerId === ownerId);
    arr.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return arr.slice(0, limit);
  }

  /** Reap jobs stranded in `active` (no `completedAt`) to `failed` at boot. No
   * in-flight run survives a server restart, so an active row at startup is dead
   * (ADAAAA-6760 boot-time sweep). Returns the number reaped. */
  async sweepStrandedJobs(): Promise<number> {
    let reaped = 0;
    for (const j of [...this.jobs.values()]) {
      if (j.status === "active" && !j.completedAt) {
        await this.patchJob(j.id, { status: "failed" });
        reaped++;
      }
    }
    return reaped;
  }

  async patchJob(id: string, patch: Partial<Omit<Job, "id">>): Promise<Job> {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`no job ${id}`);
    const next = JobSchema.parse({ ...j, ...patch });
    this.jobs.set(id, next);
    if (this.db) await this.db.saveJob(next);
    return next;
  }

  async addHighlight(rec: HighlightRecord): Promise<HighlightRecord> {
    const parsed = HighlightRecordSchema.parse(rec);
    this.highlights.set(parsed.id, parsed);
    const list = this.byJob.get(parsed.jobId) ?? [];
    list.push(parsed.id);
    this.byJob.set(parsed.jobId, list);
    if (this.db) await this.db.saveHighlight(parsed);
    return parsed;
  }

  getHighlight(id: string): HighlightRecord | undefined {
    return this.highlights.get(id);
  }

  async reviewHighlight(id: string, status: "accepted" | "rejected"): Promise<HighlightRecord> {
    const h = this.highlights.get(id);
    if (!h) throw new Error(`no highlight ${id}`);
    const now = new Date().toISOString();
    // Reject -> record the soft-delete grace start (rejectedAt). Undo
    // (reject -> accept) clears it so the clip is never a TTL purge candidate.
    const rejectedAt =
      status === "rejected" ? (h.status === "rejected" ? h.rejectedAt : now) : undefined;
    const next = HighlightRecordSchema.parse({ ...h, status, rejectedAt });
    this.highlights.set(id, next);
    if (this.db) await this.db.saveHighlight(next);
    return next;
  }

  /** Hard-remove a highlight (DB row + in-memory working set). Used by the TTL
   * purge sweep for `rejected` clips aged >= rejectTtlMs. Idempotent: deleting
   * an already-purged id is a no-op. */
  async deleteHighlight(id: string): Promise<boolean> {
    const h = this.highlights.get(id);
    if (!h) return false;
    this.highlights.delete(id);
    const list = this.byJob.get(h.jobId);
    if (list) {
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1);
    }
    if (this.db) await this.db.deleteHighlight(id);
    return true;
  }

  /** Hard-remove a job (DB row + in-memory working set) and cascade to every
   * highlight + `media_sessions` row that belongs to it (ADAAAA-6838). Used by
   * DELETE /jobs/:id so deleting a completed/failed VOD job also removes its
   * highlights and frees the perceive slot. Idempotent: deleting an already-
   * removed job is a no-op. */
  async deleteJob(id: string): Promise<boolean> {
    if (!this.jobs.has(id)) return false;
    this.jobs.delete(id);
    const hids = this.byJob.get(id) ?? [];
    for (const hid of hids) this.highlights.delete(hid);
    this.byJob.delete(id);
    this.observations.delete(id);
    this.candidates.delete(id);
    if (this.db) await this.db.deleteJob(id);
    return true;
  }

  async patchHighlight(id: string, patch: Partial<Pick<HighlightRecord, "clipUri" | "start" | "end" | "clipError">>): Promise<HighlightRecord> {
    const h = this.highlights.get(id);
    if (!h) throw new Error(`no highlight ${id}`);
    const next = HighlightRecordSchema.parse({ ...h, ...patch });
    this.highlights.set(id, next);
    if (this.db) await this.db.saveHighlight(next);
    return next;
  }

  highlightsForJob(jobId: string): HighlightRecord[] {
    return (this.byJob.get(jobId) ?? []).map((id) => this.highlights.get(id)!).filter(Boolean);
  }

  allHighlights(): HighlightRecord[] {
    return [...this.highlights.values()];
  }

  acceptedHighlights(): HighlightRecord[] {
    return [...this.highlights.values()]
      .filter((h) => h.status === "accepted")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Record a per-frame perceive observation and write it through to the durable
   * sink (ADAAAA-6851 Inc 1) so the job detail survives a server restart. The
   * in-memory working set is updated synchronously; the DB write is awaited. */
  async recordObservation(jobId: string, obs: StoredObservation): Promise<void> {
    const list = this.observations.get(jobId) ?? [];
    list.push(obs);
    this.observations.set(jobId, list);
    if (this.db) await this.db.saveObservation(jobId, obs);
  }

  observationsForJob(jobId: string): StoredObservation[] {
    return this.observations.get(jobId) ?? [];
  }

  /** Persist one decide evaluation (accepted highlight, burst-suppressed,
   * near-miss, not-highlight) with its trigger timestamp + reason/score/outcome
   * (ADAAAA-6851 Inc 2). Write-through like jobs/highlights. */
  async recordJobCandidate(cand: JobCandidate): Promise<JobCandidate> {
    const parsed = JobCandidateSchema.parse(cand);
    const list = this.candidates.get(parsed.jobId) ?? [];
    list.push(parsed);
    this.candidates.set(parsed.jobId, list);
    if (this.db) await this.db.saveJobCandidate(parsed);
    return parsed;
  }

  candidatesForJob(jobId: string): JobCandidate[] {
    return this.candidates.get(jobId) ?? [];
  }

  // --- datasets (ADAAAA-5391 C3/C4/C5): plan-gated persistence + 30-day purge
  /** Persist a sent dataset (memory + DB). Write-through like jobs/highlights. */
  async saveDataset(d: DatasetRecord): Promise<DatasetRecord> {
    this.datasets.set(d.id, d);
    if (this.db) await this.db.saveDataset(d);
    return d;
  }

  getDataset(id: string): DatasetRecord | undefined {
    return this.datasets.get(id);
  }

  /** All datasets, optionally scoped to one owner (newest first). */
  allDatasets(ownerId?: string): DatasetRecord[] {
    const all = [...this.datasets.values()];
    const scoped = ownerId ? all.filter((d) => d.ownerId === ownerId) : all;
    return scoped.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Schedule a dataset for purge (set `purgingAt`). Used by the 30-day
   * retention lifecycle on plan deactivation. Idempotent. */
  async scheduleDatasetPurge(id: string, purgingAt: string | null): Promise<DatasetRecord | undefined> {
    const cur = this.datasets.get(id);
    if (!cur) return undefined;
    const next: DatasetRecord = { ...cur, purgingAt };
    this.datasets.set(id, next);
    if (this.db) await this.db.saveDataset(next);
    return next;
  }

  /** Hard-remove a dataset (DB row + in-memory). Used by the 30-day retention
   * purge sweep. Idempotent: deleting an already-purged id is a no-op. */
  async deleteDataset(id: string): Promise<boolean> {
    if (!this.datasets.has(id)) return false;
    this.datasets.delete(id);
    if (this.db) await this.db.deleteDataset(id);
    return true;
  }
}

export function stableId(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 16);
}

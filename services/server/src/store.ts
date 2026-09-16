import { createHash, randomUUID } from "node:crypto";
import { HighlightRecordSchema, JobSchema, type HighlightRecord, type Job } from "@highlights/events";
import type { Db } from "./db";

export interface StoredObservation {
  seq: number;
  timestamp: number;
  tracks: { trackId: string; slot: number; bbox: number[]; kind: string; lostFrames: number }[];
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
  private readonly db: Db | null;

  constructor(db: Db | null = null) {
    this.db = db;
  }

  /** Hydrate the in-memory working set from the persistent store. Idempotent:
   * re-loading (e.g. after a restart) restores full prior state. */
  async load(): Promise<void> {
    if (!this.db) return;
    const [jobs, highlights] = await Promise.all([this.db.listJobs(), this.db.listHighlights()]);
    this.jobs.clear();
    this.highlights.clear();
    this.byJob.clear();
    for (const j of jobs) this.jobs.set(j.id, j);
    for (const h of highlights) {
      this.highlights.set(h.id, h);
      const list = this.byJob.get(h.jobId) ?? [];
      list.push(h.id);
      this.byJob.set(h.jobId, list);
    }
  }

  async createJob(input: { ownerId?: string; source: "file" | "rtmp" | "webrtc" | "screenshare" | "browser"; sourceUrl?: string; gameHint?: string; preferLabels?: string[] }): Promise<Job> {
    const id = randomUUID();
    const job: Job = JobSchema.parse({
      id,
      ownerId: input.ownerId,
      source: input.source,
      sourceUrl: input.sourceUrl,
      gameHint: input.gameHint,
      preferLabels: input.preferLabels ?? [],
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

  async patchJob(id: string, patch: Partial<Pick<Job, "status" | "perceiveSessionId">>): Promise<Job> {
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
    const next = HighlightRecordSchema.parse({ ...h, status });
    this.highlights.set(id, next);
    if (this.db) await this.db.saveHighlight(next);
    return next;
  }

  async patchHighlight(id: string, patch: Partial<Pick<HighlightRecord, "clipUri" | "start" | "end">>): Promise<HighlightRecord> {
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

  recordObservation(jobId: string, obs: StoredObservation): void {
    const list = this.observations.get(jobId) ?? [];
    list.push(obs);
    this.observations.set(jobId, list);
  }

  observationsForJob(jobId: string): StoredObservation[] {
    return this.observations.get(jobId) ?? [];
  }
}

export function stableId(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 16);
}

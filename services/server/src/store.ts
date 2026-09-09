// Minimal in-memory store for jobs + highlights (MVP). Swap for Postgres in the
// on-chain/railway profile — the shape matches the HighlightRecord/Job schemas.
import { createHash, randomUUID } from "node:crypto";
import { HighlightRecordSchema, JobSchema, type HighlightRecord, type Job } from "@highlights/events";

export interface StoredObservation {
  seq: number;
  timestamp: number;
  tracks: { trackId: string; slot: number; bbox: number[]; kind: string; lostFrames: number }[];
}

export class Store {
  private jobs = new Map<string, Job>();
  private highlights = new Map<string, HighlightRecord>();
  private byJob = new Map<string, string[]>();
  private observations = new Map<string, StoredObservation[]>();

  createJob(input: { ownerId?: string; source: "file" | "rtmp" | "webrtc" | "screenshare" | "browser"; sourceUrl?: string; gameHint?: string; preferLabels?: string[] }): Job {
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
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  patchJob(id: string, patch: Partial<Pick<Job, "status" | "perceiveSessionId">>): Job {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`no job ${id}`);
    const next = JobSchema.parse({ ...j, ...patch });
    this.jobs.set(id, next);
    return next;
  }

  addHighlight(rec: HighlightRecord): HighlightRecord {
    this.highlights.set(rec.id, rec);
    const list = this.byJob.get(rec.jobId) ?? [];
    list.push(rec.id);
    this.byJob.set(rec.jobId, list);
    return rec;
  }

  getHighlight(id: string): HighlightRecord | undefined {
    return this.highlights.get(id);
  }

  reviewHighlight(id: string, status: "accepted" | "rejected"): HighlightRecord {
    const h = this.highlights.get(id);
    if (!h) throw new Error(`no highlight ${id}`);
    const next = HighlightRecordSchema.parse({ ...h, status });
    this.highlights.set(id, next);
    return next;
  }

  patchHighlight(id: string, patch: Partial<Pick<HighlightRecord, "clipUri" | "start" | "end">>): HighlightRecord {
    const h = this.highlights.get(id);
    if (!h) throw new Error(`no highlight ${id}`);
    const next = HighlightRecordSchema.parse({ ...h, ...patch });
    this.highlights.set(id, next);
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

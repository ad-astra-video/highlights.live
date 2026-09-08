// Minimal in-memory store for jobs + highlights (MVP). Swap for Postgres in the
// on-chain/railway profile — the shape matches the HighlightRecord/Job schemas.
import { createHash, randomUUID } from "node:crypto";
import { HighlightRecordSchema, JobSchema, type HighlightRecord, type Job } from "@highlights/events";

export class Store {
  private jobs = new Map<string, Job>();
  private highlights = new Map<string, HighlightRecord>();
  private byJob = new Map<string, string[]>();

  createJob(input: { source: "file" | "rtmp" | "webrtc" | "screenshare"; sourceUrl?: string; gameHint?: string; preferLabels?: string[] }): Job {
    const id = randomUUID();
    const job: Job = JobSchema.parse({
      id,
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

  highlightsForJob(jobId: string): HighlightRecord[] {
    return (this.byJob.get(jobId) ?? []).map((id) => this.highlights.get(id)!).filter(Boolean);
  }

  allHighlights(): HighlightRecord[] {
    return [...this.highlights.values()];
  }
}

export function stableId(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 16);
}

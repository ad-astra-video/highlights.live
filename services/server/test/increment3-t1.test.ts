import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobSchema, type JobDecision } from "@highlights/events";
import { SqliteDb } from "../src/db";
import { Store, MAX_OBSERVATIONS_PER_JOB, type StoredObservation } from "../src/store";

// ADAAAA-6870 (Increment 3 T1 / server): durable `job_observations` write-through
// + per-job cap/trim, the additive `candidates[]` decision trail on the job
// record, and `DELETE /jobs/:id` cascade of the observation rows.

function obs(seq: number, timestamp: number, tracks: StoredObservation["tracks"] = []): StoredObservation {
  return { seq, timestamp, tracks };
}

function trail(...entries: Array<Partial<JobDecision> & { seq: number; ts: number; eventType: string; decision: string }>): JobDecision[] {
  return entries.map((e) => ({ ...e }));
}

describe("per-job observation cap/trim (ADAAAA-6870 I3-F)", () => {
  it("keeps only the newest MAX_OBSERVATIONS_PER_JOB rows (oldest trimmed) in memory AND in the DB", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hl-obs-cap-"));
    const file = path.join(dir, "highlights.db");
    try {
      const db = new SqliteDb(file);
      await db.migrate();
      const store = new Store(db);
      await store.load();
      const job = await store.createJob({ source: "file", sourceUrl: "/tmp/v.mp4" });

      // Write exactly MAX + 5 observations (seq 0..MAX+4).
      const total = MAX_OBSERVATIONS_PER_JOB + 5;
      for (let seq = 0; seq < total; seq++) {
        await store.recordObservation(job.id, obs(seq, seq / 10));
      }

      // In-memory window is capped to the NEWEST MAX entries (oldest 5 dropped).
      const mem = store.observationsForJob(job.id);
      expect(mem).toHaveLength(MAX_OBSERVATIONS_PER_JOB);
      expect(mem[0].seq).toBe(5);
      expect(mem[mem.length - 1].seq).toBe(total - 1);

      // The DB table is equally capped (the write-through trims on overflow).
      const dbRows = await db.observationsForJob(job.id);
      expect(dbRows).toHaveLength(MAX_OBSERVATIONS_PER_JOB);
      expect(dbRows[0].seq).toBe(5);
      expect(dbRows[dbRows.length - 1].seq).toBe(total - 1);

      // The older job's own rows are gone (older-first trim), not just hidden.
      const all = await db.listObservations();
      const forJob = all.filter((r) => r.jobId === job.id);
      expect(forJob).toHaveLength(MAX_OBSERVATIONS_PER_JOB);

      // A second job with few observations is untouched by another job's cap.
      const other = await store.createJob({ source: "file", sourceUrl: "/tmp/w.mp4" });
      await store.recordObservation(other.id, obs(0, 0.1));
      expect(store.observationsForJob(other.id)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boot-hydrates the capped set after a restart (no unbounded reload)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hl-obs-hyd-"));
    const file = path.join(dir, "highlights.db");
    try {
      let db: SqliteDb = new SqliteDb(file);
      await db.migrate();
      let store = new Store(db);
      await store.load();
      const job = await store.createJob({ source: "file", sourceUrl: "/tmp/v.mp4" });
      for (let seq = 0; seq < MAX_OBSERVATIONS_PER_JOB + 10; seq++) {
        await store.recordObservation(job.id, obs(seq, seq / 10));
      }
      await db.close();

      // Simulated restart: load() hydrates from the (already capped) DB.
      db = new SqliteDb(file);
      await db.migrate();
      store = new Store(db);
      await store.load();
      expect(store.observationsForJob(job.id)).toHaveLength(MAX_OBSERVATIONS_PER_JOB);
      expect(store.observationsForJob(job.id)[0].seq).toBe(10);
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("additive candidates[] decision trail on the job record (ADAAAA-6870 I3-B/C)", () => {
  it("persists candidates[] on the job and survives a restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hl-trail-"));
    const file = path.join(dir, "highlights.db");
    try {
      let db: SqliteDb = new SqliteDb(file);
      await db.migrate();
      let store = new Store(db);
      await store.load();
      const job = await store.createJob({ source: "file", sourceUrl: "/tmp/v.mp4" });
      const trailEntries = trail(
        { seq: 12, ts: 3.1, eventType: "GOAL", decision: "candidate" },
        { seq: 40, ts: 9.4, eventType: "GOAL", decision: "scoring_play", highlightId: "h-1" },
        { seq: 61, ts: 15.0, eventType: "KILL", decision: "near_miss", highlightId: "h-2" }
      );
      // runVodJob persists the trail via patchJob({ candidates }).
      await store.patchJob(job.id, { status: "done", candidates: trailEntries });

      // The in-memory job record carries the trail.
      expect(store.getJob(job.id)!.candidates).toHaveLength(3);
      expect(store.getJob(job.id)!.candidates![1].highlightId).toBe("h-1");

      await db.close();

      // Simulated restart: the additive field round-trips the job record.
      db = new SqliteDb(file);
      await db.migrate();
      store = new Store(db);
      await store.load();
      const restored = store.getJob(job.id)!;
      expect(restored.status).toBe("done");
      expect(restored.candidates).toHaveLength(3);
      expect(restored.candidates![0]).toEqual(trailEntries[0]);
      expect(restored.candidates![2].decision).toBe("near_miss");
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a purely additive optional field: a record without candidates still parses (no version bump)", () => {
    const job = JobSchema.parse({
      id: "j-old",
      source: "file",
      status: "done",
      framesAnalyzed: 5,
      createdAt: new Date().toISOString(),
    });
    expect(job.candidates).toBeUndefined();
    // Putting candidates on the same record validates the new field shape.
    const withCand = JobSchema.parse({ ...job, candidates: [{ seq: 1, ts: 2, eventType: "GOAL", decision: "accepted" }] });
    expect(withCand.candidates).toHaveLength(1);
  });
});

describe("DELETE /jobs/:id cascades job_observations (ADAAAA-6870 I3-F)", () => {
  it("removes the observation rows for the deleted job but leaves other jobs' rows", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hl-delobs-"));
    const file = path.join(dir, "highlights.db");
    try {
      const db = new SqliteDb(file);
      await db.migrate();
      const store = new Store(db);
      await store.load();
      const job = await store.createJob({ source: "file", sourceUrl: "/tmp/v.mp4" });
      const other = await store.createJob({ source: "file", sourceUrl: "/tmp/w.mp4" });
      for (let seq = 0; seq < 10; seq++) await store.recordObservation(job.id, obs(seq, seq / 10));
      for (let seq = 0; seq < 3; seq++) await store.recordObservation(other.id, obs(seq, seq / 10));

      // Preconditions: both jobs have durable observation rows.
      expect(await db.observationsForJob(job.id)).toHaveLength(10);
      expect(await db.observationsForJob(other.id)).toHaveLength(3);

      await store.deleteJob(job.id);

      // The deleted job's observation rows are gone (memory + DB); the other survives.
      expect(store.observationsForJob(job.id)).toHaveLength(0);
      expect(await db.observationsForJob(job.id)).toHaveLength(0);
      expect(await db.observationsForJob(other.id)).toHaveLength(3);
      const all = await db.listObservations();
      expect(all.filter((r) => r.jobId === job.id)).toHaveLength(0);
      expect(all.filter((r) => r.jobId === other.id)).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

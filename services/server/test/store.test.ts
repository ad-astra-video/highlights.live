import { describe, it, expect } from "vitest";
import { JobCandidateSchema } from "@highlights/events";
import { Store } from "../src/store";

describe("Store (in-memory)", () => {
  it("creates a queued job and patches status", async () => {
    const s = new Store();
    const j = await s.createJob({ source: "file", sourceUrl: "/tmp/v.mp4", gameHint: "valorant" });
    expect(j.status).toBe("queued");
    await s.patchJob(j.id, { status: "active" });
    expect(s.getJob(j.id)!.status).toBe("active");
  });

  it("adds + reviews highlights tied to a job", async () => {
    const s = new Store();
    const j = await s.createJob({ source: "file", sourceUrl: "/v.mp4" });
    const h: any = {
      id: "h1",
      jobId: j.id,
      clipUri: "/clips/h1.mp4",
      start: 1,
      end: 5,
      status: "pending",
      score: 90,
      createdAt: new Date().toISOString(),
    };
    await s.addHighlight(h);
    expect(s.highlightsForJob(j.id)).toHaveLength(1);
    await s.reviewHighlight("h1", "accepted");
    expect(s.getHighlight("h1")!.status).toBe("accepted");
    expect(s.allHighlights()).toHaveLength(1);
  });

  it("listJobsForOwner returns only that owner's jobs, newest first, capped at limit (ADAAAA-6760)", async () => {
    const s = new Store();
    // Interleave owners so filtering is unambiguous; craft distinct createdAt so
    // the newest-first order is deterministic regardless of the creation clock.
    const a = await s.createJob({ ownerId: "userA", source: "file" });
    const b = await s.createJob({ ownerId: "userB", source: "file" });
    const c = await s.createJob({ ownerId: "userA", source: "file" });
    await s.patchJob(a.id, { createdAt: "2026-01-01T00:00:00Z" });
    await s.patchJob(b.id, { createdAt: "2026-01-03T00:00:00Z" });
    await s.patchJob(c.id, { createdAt: "2026-01-02T00:00:00Z" });

    const onlyA = s.listJobsForOwner("userA");
    expect(onlyA.map((j) => j.id)).toEqual([c.id, a.id]); // newest (c) first
    const all = s.listJobsForOwner(undefined);
    expect(all.map((j) => j.id)).toEqual([b.id, c.id, a.id]); // b(01-03) newest first
    const limited = s.listJobsForOwner(undefined, 2);
    expect(limited.map((j) => j.id)).toEqual([b.id, c.id]); // limit respected, order holds
    // Admin (no owner) sees every job.
    expect(s.listAllJobs()).toHaveLength(3);
  });

  it("sweepStrandedJobs reaps active (no completedAt) rows to failed and leaves others intact (ADAAAA-6760)", async () => {
    const s = new Store();
    const stranded = await s.createJob({ ownerId: "u", source: "file" });
    await s.patchJob(stranded.id, { status: "active" }); // active, no completedAt
    const doneJob = await s.createJob({ ownerId: "u", source: "file" });
    await s.patchJob(doneJob.id, { status: "done", completedAt: new Date().toISOString() });
    const queuedJob = await s.createJob({ ownerId: "u", source: "file" });
    const activeDone = await s.createJob({ ownerId: "u", source: "file" });
    await s.patchJob(activeDone.id, { status: "active", completedAt: new Date().toISOString() }); // active but completed

    const reaped = await s.sweepStrandedJobs();
    expect(reaped).toBe(1);
    expect(s.getJob(stranded.id)!.status).toBe("failed");
    expect(s.getJob(doneJob.id)!.status).toBe("done");
    expect(s.getJob(queuedJob.id)!.status).toBe("queued");
    expect(s.getJob(activeDone.id)!.status).toBe("active"); // completedAt present -> not stranded
  });

  it("patchJob persists optional async progress + progressLabel (ADAAAA-6760)", async () => {
    const s = new Store();
    const j = await s.createJob({ ownerId: "u", source: "file" });
    await s.patchJob(j.id, { progress: 42, progressLabel: "analyzing (frame 1/10)" });
    const got = s.getJob(j.id)!;
    expect(got.progress).toBe(42);
    expect(got.progressLabel).toBe("analyzing (frame 1/10)");
  });

  it("addHighlight is idempotent on idempotencyKey: first insert wins, no duplicate row / no double-count (ADAAAA-6874)", async () => {
    const s = new Store();
    const j = await s.createJob({ ownerId: "u", source: "file" });
    const mk = (id: string) => ({
      id,
      jobId: j.id,
      idempotencyKey: `hl:${j.id}:12:goal`,
      clipUri: `/clips/${id}.mp4`,
      start: 10,
      end: 14,
      eventType: "goal",
      score: 90,
      reason: "a goal",
      status: "accepted" as const,
      createdAt: new Date().toISOString(),
    });
    const first = await s.addHighlight(mk("h-a"));
    expect(first.created).toBe(true);
    expect(first.record.id).toBe("h-a");

    // A resumed job re-decides the SAME candidate: new random id, SAME key.
    const second = await s.addHighlight(mk("h-b"));
    expect(second.created).toBe(false);
    // The original record wins (no duplicate row, no double-count).
    expect(second.record.id).toBe("h-a");
    expect(s.highlightsForJob(j.id)).toHaveLength(1);
    expect(s.allHighlights()).toHaveLength(1);
    expect(s.getHighlight("h-b")).toBeUndefined();
  });

  it("highlightsFound bumps on the job via patchJob and is surfaced on GET (ADAAAA-6874)", async () => {
    const s = new Store();
    const j = await s.createJob({ ownerId: "u", source: "file" });
    expect(s.getJob(j.id)!.highlightsFound).toBe(0);
    await s.patchJob(j.id, { highlightsFound: (s.getJob(j.id)!.highlightsFound ?? 0) + 1 });
    expect(s.getJob(j.id)!.highlightsFound).toBe(1);
  });

  it("highlightIdempotencyKey is deterministic per (jobId, seq, eventType) (ADAAAA-6874)", async () => {
    const { highlightIdempotencyKey } = await import("../src/analyzer");
    const a = highlightIdempotencyKey("job1", 12, "goal");
    const b = highlightIdempotencyKey("job1", 12, "goal");
    const c = highlightIdempotencyKey("job1", 13, "goal");
    const d = highlightIdempotencyKey("job1", 12, "save");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it("recordJobCandidate dedupes a re-persisted decide call by timestamp|eventType|status (ADAAAA-7505)", async () => {
    const s = new Store();
    const j = await s.createJob({ ownerId: "u", source: "file" });
    const mk = (id: string, timestamp: number, eventType = "goal", status = "rejected" as const) =>
      JobCandidateSchema.parse({
        id,
        jobId: j.id,
        seq: 12,
        timestamp,
        eventType,
        score: 80,
        isHighlight: false,
        status,
        reason: "no goal",
        createdAt: new Date().toISOString(),
      });

    // First persist wins.
    await s.recordJobCandidate(mk("c-a", 42.0));
    expect(s.candidatesForJob(j.id)).toHaveLength(1);

    // A resumed job re-decides the SAME window: new random id, SAME
    // timestamp/eventType/status -> deduped, no duplicate listing row.
    await s.recordJobCandidate(mk("c-b", 42.0));
    expect(s.candidatesForJob(j.id)).toHaveLength(1);
    expect(s.candidatesForJob(j.id)[0].id).toBe("c-a");
    expect(s.candidatesForJob(j.id).find((c) => c.id === "c-b")).toBeUndefined();

    // A distinct decide call (different timestamp) is still persisted.
    await s.recordJobCandidate(mk("c-c", 45.0));
    expect(s.candidatesForJob(j.id)).toHaveLength(2);

    // A different status at the same timestamp is a distinct decide call, kept.
    await s.recordJobCandidate(mk("c-d", 42.0, "goal", "accepted"));
    expect(s.candidatesForJob(j.id)).toHaveLength(3);
  });
});

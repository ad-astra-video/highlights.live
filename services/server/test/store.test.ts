import { describe, it, expect } from "vitest";
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
});

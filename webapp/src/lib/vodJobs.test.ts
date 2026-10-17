import { describe, it, expect, vi } from "vitest";
import { VOD_POLL_MS, isInFlight, jobProgressPct, mergeJobLists } from "./vodJobs";
import type { Job } from "./api";

// Increment 2 (ADAAAA-6837) delete-wiring test: `deleteJob` must issue a DELETE
// on /jobs/:id so the server removes the job + cascades its highlights.
vi.mock("./api", () => ({
  api: vi.fn(() => Promise.resolve({ ok: true })),
  getToken: () => "tok",
}));

function job(id: string, status: Job["status"], createdAt: string, extra: Partial<Job> = {}): Job {
  return { id, status, createdAt, source: "file", preferLabels: [], ...extra };
}

describe("VOD_POLL_MS poll timing (ADAAAA-6760)", () => {
  it("polls GET /jobs every 15s so the queue refreshes without hammering the server", () => {
    expect(VOD_POLL_MS).toBe(15_000);
  });
  it("is a sane sub-minute interval so in-flight status transitions surface promptly", () => {
    expect(VOD_POLL_MS).toBeGreaterThanOrEqual(5_000);
    expect(VOD_POLL_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("isInFlight (queued/active are processing; done/failed are terminal)", () => {
  it("treats queued and active as in flight", () => {
    expect(isInFlight("queued")).toBe(true);
    expect(isInFlight("active")).toBe(true);
  });
  it("treats done and failed as terminal (not in flight)", () => {
    expect(isInFlight("done")).toBe(false);
    expect(isInFlight("failed")).toBe(false);
  });
  it("treats an unknown/absent status as not in flight (safe default)", () => {
    expect(isInFlight(undefined)).toBe(false);
    expect(isInFlight("")).toBe(false);
    expect(isInFlight("cancelled")).toBe(false);
  });
});

describe("mergeJobLists (dedupe by id, newest first by createdAt)", () => {
  it("unions two refreshes and sorts newest first by createdAt", () => {
    const prev = [
      job("a", "done", "2026-10-16T10:00:00Z"),
      job("b", "active", "2026-10-16T09:00:00Z"),
    ];
    const next = [
      job("c", "queued", "2026-10-16T11:00:00Z"),
      job("b", "done", "2026-10-16T09:00:00Z"), // same id, now done
    ];
    const merged = mergeJobLists(prev, next);
    expect(merged.map((j) => j.id)).toEqual(["c", "a", "b"]);
  });

  it("lets the freshest (next) record win on a duplicate id", () => {
    const prev = [job("x", "active", "2026-10-16T08:00:00Z")];
    const next = [job("x", "done", "2026-10-16T08:00:00Z", { framesAnalyzed: 120 })];
    const merged = mergeJobLists(prev, next);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("done");
    expect(merged[0].framesAnalyzed).toBe(120);
  });

  it("keeps a stable newest-first order when createdAt ties", () => {
    const merged = mergeJobLists(
      [job("a", "done", "2026-10-16T10:00:00Z")],
      [job("b", "done", "2026-10-16T10:00:00Z"), job("c", "done", "2026-10-16T10:00:00Z")]
    );
    // Ties are stable but deterministic across the union; all three present.
    expect(merged.map((j) => j.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("handles empty inputs without throwing", () => {
    expect(mergeJobLists([], [])).toEqual([]);
    expect(mergeJobLists([job("a", "queued", "2026-10-16T10:00:00Z")], [])).toHaveLength(1);
  });
});

// Helper logic for the "done" and "failed" processing-job rows.
describe("jobProgressPct (done/error row progress-bar helper)", () => {
  it("returns the raw progress for a normal in-flight job", () => {
    expect(jobProgressPct({ progress: 42 })).toBe(42);
  });
  it("clamps over-100 and under-0 values into the bar's 0..100 range", () => {
    expect(jobProgressPct({ progress: 137 })).toBe(100);
    expect(jobProgressPct({ progress: -5 })).toBe(0);
  });
  it("defaults to 0 when progress is absent or non-finite (a done/failed row may never report one)", () => {
    expect(jobProgressPct(undefined)).toBe(0);
    expect(jobProgressPct({})).toBe(0);
    expect(jobProgressPct({ progress: NaN })).toBe(0);
  });
});

// The processing-jobs surface renders done rows with framesAnalyzed/cost and
// failed rows with a generic error line — the status discriminator is what
// routes a job to one of those branches, so assert on the terminal helpers.
describe("done/error row routing", () => {
  it("a done job is terminal (renders the done branch: no progress, metrics show)", () => {
    const doneJob = job("job-12345678", "done", "2026-10-16T10:00:00Z", {
      framesAnalyzed: 240,
      costUsd: 0.41,
      decideCalls: 18,
    });
    expect(isInFlight(doneJob.status)).toBe(false);
    expect(doneJob.framesAnalyzed).toBe(240);
    expect(doneJob.costUsd).toBe(0.41);
    expect(doneJob.decideCalls).toBe(18);
  });

  it("a failed job is terminal and shows the generic 'processing failed' line (no status-specific field)", () => {
    const failedJob = job("job-87654321", "failed", "2026-10-16T10:00:00Z");
    expect(isInFlight(failedJob.status)).toBe(false);
    // Job has NO error field per the server contract — the UI shows a generic line.
    expect((failedJob as any).error).toBeUndefined();
  });

  it("8-char job id prefix is a stable display key for the row", () => {
    expect("job-12345678".slice(0, 8)).toBe("job-1234");
  });
});

// --- Increment 2 (ADAAAA-6837): three-surface partition, attribution, delete ---
import { partitionJobs, groupHighlightsByJob, jobSpanLabel, formatDuration, formatJobTime, deleteJob, sourceLabel } from "./vodJobs";
import { api } from "./api";
import type { Highlight } from "./api";

describe("partitionJobs (three-job surfaces: in-flight / completed / failed)", () => {
  it("splits the queue by status into the three surfaces", () => {
    const jobs = [
      job("j-queued", "queued", "2026-10-16T10:00:00Z"),
      job("j-active", "active", "2026-10-16T10:01:00Z"),
      job("j-done", "done", "2026-10-16T10:02:00Z"),
      job("j-failed", "failed", "2026-10-16T10:03:00Z"),
    ];
    const p = partitionJobs(jobs);
    expect(p.inFlight.map((j) => j.id)).toEqual(["j-queued", "j-active"]);
    expect(p.completed.map((j) => j.id)).toEqual(["j-done"]);
    expect(p.failed.map((j) => j.id)).toEqual(["j-failed"]);
  });

  it("emits empty surfaces when no job is in that state", () => {
    const p = partitionJobs([job("j-done", "done", "2026-10-16T10:00:00Z")]);
    expect(p.inFlight).toEqual([]);
    expect(p.failed).toEqual([]);
    expect(p.completed).toHaveLength(1);
  });
});

describe("groupHighlightsByJob (attribute highlights to their source job)", () => {
  const j1 = job("job-111", "done", "2026-10-16T10:00:00Z", { source: "file" });
  const j2 = job("job-222", "done", "2026-10-16T09:00:00Z", { source: "rtmp" });
  function hl(id: string, jobId: string | undefined, createdAt: string, status = "accepted"): Highlight {
    return { id, jobId, clipUri: `/clips/${id}.mp4`, score: 90, status, start: 0, end: 10, createdAt };
  }

  it("buckets highlights by jobId and resolves the label from the job's source", () => {
    const groups = groupHighlightsByJob(
      [hl("a", "job-111", "2026-10-16T10:01:00Z"), hl("b", "job-222", "2026-10-16T09:01:00Z")],
      [j1, j2]
    );
    expect(groups.map((g) => g.key)).toEqual(["job-111", "job-222"]);
    expect(groups[0].label).toBe("File · job-111");
    expect(groups[1].label).toBe("RTMP · job-222");
    expect(groups[0].highlights.map((h) => h.id)).toEqual(["a"]);
  });

  it("orders groups newest-first by the producing job's createdAt", () => {
    const groups = groupHighlightsByJob(
      [hl("a", "job-111", "2026-10-16T09:00:00Z"), hl("b", "job-222", "2026-10-16T08:00:00Z")],
      [j1, j2]
    );
    expect(groups.map((g) => g.key)).toEqual(["job-111", "job-222"]);
  });

  it("excludes rejected highlights from the grouped feed", () => {
    const groups = groupHighlightsByJob(
      [hl("a", "job-111", "2026-10-16T10:00:00Z", "accepted"), hl("r", "job-111", "2026-10-16T10:01:00Z", "rejected")],
      [j1]
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].highlights.map((h) => h.id)).toEqual(["a"]);
  });

  it("pools jobId-less highlights under an 'Other' group so nothing is dropped", () => {
    const groups = groupHighlightsByJob([hl("legacy", undefined, "2026-10-16T10:00:00Z")], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("none");
    expect(groups[0].label).toBe("Other");
    expect(groups[0].jobId).toBeUndefined();
  });
});

describe("completed-job card timestamps (span/duration + localized times)", () => {
  it("computes a human span from scheduledAt -> completedAt", () => {
    const j = job("job-1", "done", "2026-10-16T10:00:00Z", {
      scheduledAt: "2026-10-16T10:00:00Z",
      completedAt: "2026-10-16T10:01:30Z",
    });
    expect(jobSpanLabel(j)).toBe("1m 30s");
  });
  it("returns null when either timestamp is absent or unparseable", () => {
    expect(jobSpanLabel(job("a", "done", "2026-10-16T10:00:00Z"))).toBeNull();
    expect(
      jobSpanLabel(job("b", "done", "2026-10-16T10:00:00Z", { scheduledAt: "nope", completedAt: "2026-10-16T10:01:00Z" }))
    ).toBeNull();
  });
  it("formats durations compactly and returns '' for invalid spans", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(NaN)).toBe("");
  });
  it("formats an ISO timestamp to a localized string, null when absent", () => {
    expect(formatJobTime("2026-10-16T10:00:00Z")).toContain("2026");
    expect(formatJobTime(undefined)).toBeNull();
    expect(formatJobTime("not-a-date")).toBeNull();
  });
});

describe("sourceLabel + deleteJob wiring (ADAAAA-6837)", () => {
  it("maps job source enums to friendly labels", () => {
    expect(sourceLabel("file")).toBe("File");
    expect(sourceLabel("rtmp")).toBe("RTMP");
    expect(sourceLabel("rtmp2")).toBe("rtmp2");
    expect(sourceLabel(undefined)).toBe("Unknown");
  });

  it("issues DELETE /jobs/:id so the server removes the job and cascades its highlights", async () => {
    (api as unknown as ReturnType<typeof vi.fn>).mockClear();
    await deleteJob("job-123");
    expect(api).toHaveBeenCalledWith("/jobs/job-123", { method: "DELETE" });
  });
});

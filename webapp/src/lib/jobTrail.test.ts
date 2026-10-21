import { describe, it, expect, vi } from "vitest";
import {
  trailFromJob,
  trailFromEvent,
  decisionToTrail,
  mergeTrail,
  reconcileTrail,
  hasCandidateTrigger,
  type TrailEntry,
} from "./jobTrail";
import type { Job, JobDecision } from "./api";

// Increment 3 T2 (ADAAAA-6871): the Job detail panel's decision-trail model.
// The trail is DOM-free pure logic (see jobTrail.ts), so it is unit-tested here
// in the node environment with the repo's existing vitest helper-test pattern.
// The job surfaces + delete wiring (I2 no-regression) are exercised via the
// vodJobs helpers below.

vi.mock("./api", () => ({
  api: vi.fn(() => Promise.resolve({ ok: true })),
  getToken: () => "tok",
}));

function decision(seq: number, eventType: string, decision: string, ts = 1000, highlightId?: string): JobDecision {
  return { seq, ts, eventType, decision, highlightId };
}

function jobWith(candidates: JobDecision[]): Job {
  return { id: "job-1", status: "done", createdAt: "2026-10-16T10:00:00Z", source: "file", preferLabels: [], candidates };
}

describe("decisionToTrail (persisted job.candidates -> trail entry)", () => {
  it("marks decision === 'candidate' as a candidate trigger", () => {
    const e = decisionToTrail(decision(3, "GOAL", "candidate"));
    expect(e.kind).toBe("candidate");
    expect(e.eventType).toBe("GOAL");
    expect(e.decision).toBe("candidate");
  });
  it("marks any other decision as a highlight verdict", () => {
    const e = decisionToTrail(decision(5, "GOAL", "accepted", 2000, "hl-1"));
    expect(e.kind).toBe("highlight");
    expect(e.highlightId).toBe("hl-1");
    expect(e.decision).toBe("accepted");
  });
});

describe("trailFromJob (panel seeds its trail from persisted candidates)", () => {
  it("builds an ordered trail from the job's additive candidates array", () => {
    const trail = trailFromJob(
      jobWith([decision(1, "DUNK", "candidate", 1000), decision(2, "DUNK", "accepted", 2000, "hl-9")])
    );
    expect(trail).toHaveLength(2);
    expect(trail[0].kind).toBe("candidate");
    expect(trail[1].kind).toBe("highlight");
  });
  it("returns an empty trail when the additive field is absent (older/live record)", () => {
    expect(trailFromJob(jobWith([]))).toEqual([]);
    expect(trailFromJob(undefined)).toEqual([]);
    expect(trailFromJob(null)).toEqual([]);
  });
});

describe("trailFromEvent (live SSE frame -> trail entry)", () => {
  it("maps a candidate SSE frame to a candidate trigger (mirrors server recordTrailDecision)", () => {
    const e = trailFromEvent("candidate", { seq: 7, timestamp: 1234, type: "candidate", candidate: { eventType: "GOAL" } });
    expect(e).not.toBeNull();
    expect(e!.kind).toBe("candidate");
    expect(e!.seq).toBe(7);
    expect(e!.eventType).toBe("GOAL");
  });
  it("maps a highlight SSE frame to a highlight verdict with its id", () => {
    const e = trailFromEvent("highlight", {
      seq: 8,
      timestamp: 2000,
      type: "highlight",
      highlight: { id: "hl-5", eventType: "GOAL", outcome: "accepted" },
    });
    expect(e).not.toBeNull();
    expect(e!.kind).toBe("highlight");
    expect(e!.decision).toBe("accepted");
    expect(e!.highlightId).toBe("hl-5");
  });
  it("falls back to highlight.status when outcome is absent", () => {
    const e = trailFromEvent("highlight", { seq: 1, timestamp: 1, type: "highlight", highlight: { id: "h", status: "published" } });
    expect(e!.decision).toBe("published");
  });
  it("returns null for unrelated SSE frames (progress/observation/ready)", () => {
    expect(trailFromEvent("progress", { progress: 50 })).toBeNull();
    expect(trailFromEvent("observation", { observation: { tracks: [] } })).toBeNull();
    expect(trailFromEvent("ready", { status: "active" })).toBeNull();
    expect(trailFromEvent("candidate", {})).toBeNull(); // no candidate payload
  });
});

describe("mergeTrail (SSE live-append dedupes and keeps the server order)", () => {
  const persisted: TrailEntry[] = [
    { seq: 1, ts: 1000, eventType: "GOAL", decision: "candidate", kind: "candidate" },
  ];
  it("appends an incoming candidate frame after the persisted snapshot", () => {
    const incoming = trailFromEvent("candidate", { seq: 2, timestamp: 2000, type: "candidate", candidate: { eventType: "DUNK" } })!;
    const merged = mergeTrail(persisted, [incoming]);
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.seq)).toEqual([1, 2]); // ascending, server order
  });
  it("dedupes a re-emitted frame so it never double-appends (same kind+seq+eventType)", () => {
    const incoming = trailFromEvent("candidate", { seq: 1, timestamp: 1000, type: "candidate", candidate: { eventType: "GOAL" } })!;
    const merged = mergeTrail(persisted, [incoming]);
    expect(merged).toHaveLength(1);
  });
  it("keeps BOTH a candidate and its highlight even when they share a frame seq (kind differs)", () => {
    const cand = trailFromEvent("candidate", { seq: 9, timestamp: 3000, type: "candidate", candidate: { eventType: "GOAL" } })!;
    const hl = trailFromEvent("highlight", { seq: 9, timestamp: 3100, type: "highlight", highlight: { id: "h1", eventType: "GOAL", outcome: "accepted" } })!;
    const merged = mergeTrail([], [cand, hl]);
    expect(merged).toHaveLength(2);
  });
  it("sorts by seq then ts (order the server appends)", () => {
    const merged = mergeTrail([], [
      { seq: 3, ts: 100, eventType: "A", decision: "accepted", kind: "highlight" },
      { seq: 1, ts: 50, eventType: "B", decision: "candidate", kind: "candidate" },
    ]);
    expect(merged.map((e) => e.seq)).toEqual([1, 3]);
  });
});

describe("hasCandidateTrigger (empty in-flight trail messaging)", () => {
  it("is true only when a candidate trigger is present", () => {
    expect(hasCandidateTrigger([{ seq: 1, ts: 1, eventType: "GOAL", decision: "candidate", kind: "candidate" }])).toBe(true);
    expect(hasCandidateTrigger([{ seq: 1, ts: 1, eventType: "GOAL", decision: "accepted", kind: "highlight" }])).toBe(false);
    expect(hasCandidateTrigger([])).toBe(false);
  });
});

// --- ADAAAA-6893 (I3-B live-path decision-trail wipe on the 15s poll) ---
// The Job detail panel's 15s poll re-seeds the trail from `job.candidates`. A
// live in-flight job carries an EMPTY `job.candidates` (persistDecision writes
// to the job_candidates table but does not populate job.candidates), so the old
// `setTrail(trailFromJob(r.job))` wiped the SSE-appended trail back to
// "No decisions yet". `reconcileTrail` must keep live SSE frames across the poll.
describe("reconcileTrail (ADAAAA-6893 live decision-trail stability)", () => {
  const liveSSE: TrailEntry[] = [
    { seq: 1, ts: 1000, eventType: "GOAL", decision: "candidate", kind: "candidate" },
    { seq: 2, ts: 2000, eventType: "GOAL", decision: "accepted", kind: "highlight", highlightId: "hl-1" },
  ];

  it("keeps the SSE-appended live trail when the poll snapshot is empty (live job)", () => {
    const reconciled = reconcileTrail(liveSSE, []);
    expect(reconciled).toEqual(liveSSE);
  });

  it("keeps the live trail even when it is the only source and the job is in flight", () => {
    // The regression: trailFromJob on an in-flight live job returns [], which the
    // poll applied via setTrail and dropped the SSE frames. After the fix the
    // empty snapshot is a no-op.
    const persisted = trailFromJob({ id: "j", status: "active", source: "webrtc", preferLabels: [], createdAt: "2026-10-16T10:00:00Z" });
    expect(reconcileTrail(liveSSE, persisted)).toEqual(liveSSE);
  });

  it("merges a non-empty persisted snapshot over the SSE trail (VOD file path) without dropping either", () => {
    const persisted: TrailEntry[] = [
      { seq: 1, ts: 1000, eventType: "GOAL", decision: "candidate", kind: "candidate" },
      { seq: 3, ts: 3000, eventType: "DUNK", decision: "accepted", kind: "highlight", highlightId: "hl-2" },
    ];
    const reconciled = reconcileTrail(liveSSE, persisted);
    // seq 1 deduped (same kind+seq+eventType), seq 2 (SSE) kept, seq 3 (persisted) added.
    expect(reconciled.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(reconciled.find((e) => e.seq === 2)?.kind).toBe("highlight"); // SSE frame survived
  });

  it("still seeds the trail from the persisted snapshot when there is no SSE trail yet", () => {
    const persisted: TrailEntry[] = [
      { seq: 1, ts: 1000, eventType: "GOAL", decision: "candidate", kind: "candidate" },
    ];
    expect(reconcileTrail([], persisted)).toEqual(persisted);
  });
});

// --- I2 no-regression (ADAAAA-6837): the three-surface partition and the Delete
// wiring must be unaffected by the Increment 3 T2 openable-row change.
describe("Increment 2 no-regression (partition + delete), ADAAAA-6871", () => {
  it("partitionJobs still splits the queue into the three surfaces", async () => {
    const { partitionJobs } = await import("./vodJobs");
    const p = partitionJobs([
      { id: "a", status: "queued", source: "file", preferLabels: [], createdAt: "2026-10-16T10:00:00Z" },
      { id: "b", status: "done", source: "file", preferLabels: [], createdAt: "2026-10-16T10:01:00Z" },
      { id: "c", status: "failed", source: "file", preferLabels: [], createdAt: "2026-10-16T10:02:00Z" },
    ]);
    expect(p.inFlight.map((j) => j.id)).toEqual(["a"]);
    expect(p.completed.map((j) => j.id)).toEqual(["b"]);
    expect(p.failed.map((j) => j.id)).toEqual(["c"]);
  });

  it("deleteJob still issues DELETE /jobs/:id", async () => {
    const { deleteJob } = await import("./vodJobs");
    const { api } = await import("./api");
    vi.mocked(api).mockClear();
    await deleteJob("job-123");
    expect(api).toHaveBeenCalledWith("/jobs/job-123", { method: "DELETE" });
  });
});

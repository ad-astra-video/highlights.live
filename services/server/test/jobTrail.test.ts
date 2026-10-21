import { describe, it, expect } from "vitest";
import { trailDecisionFromEvent } from "../src/jobTrail";
import type { AnalyzeEvent } from "../src/analyzer";
import type { HighlightRecord } from "@highlights/events";

// ADAAAA-7135 (two-tier): the durable `job.candidates` trail records ONLY
// confirmed highlights. A raw `candidate` trigger must never be persisted as a
// decision — that is exactly the flood that produced the box's 168-candidate /
// all-GOAL trail.

function highlight(overrides: Partial<HighlightRecord> = {}): HighlightRecord {
  return {
    id: "hl-1",
    jobId: "job-1",
    clipUri: "/clips/x.mp4",
    start: 0,
    end: 10,
    eventType: "GOAL",
    score: 0.95,
    reason: "ball in net",
    status: "pending",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function candidateEvent(seq = 1): AnalyzeEvent {
  return { seq, timestamp: 1000, type: "candidate", candidate: { eventType: "GOAL", timestamp: 1000 } };
}

describe("trailDecisionFromEvent (confirmed-only trail rule, ADAAAA-7135)", () => {
  it("records a confirmed highlight as a trail entry", () => {
    const ev: AnalyzeEvent = { seq: 5, timestamp: 2000, type: "highlight", highlight: highlight() };
    const entry = trailDecisionFromEvent(ev);
    expect(entry).not.toBeNull();
    expect(entry!.seq).toBe(5);
    expect(entry!.ts).toBe(2000);
    expect(entry!.eventType).toBe("GOAL");
    expect(entry!.decision).toBe("pending"); // outcome ?? status
    expect(entry!.highlightId).toBe("hl-1");
  });

  it("uses outcome when present, else falls back to status", () => {
    const acc = trailDecisionFromEvent({ seq: 1, timestamp: 1, type: "highlight", highlight: highlight({ outcome: "scoring_play" }) });
    expect(acc!.decision).toBe("scoring_play");
    const nm = trailDecisionFromEvent({ seq: 2, timestamp: 2, type: "highlight", highlight: highlight({ outcome: "near_miss", status: "pending" }) });
    expect(nm!.decision).toBe("near_miss");
  });

  it("does NOT record a raw candidate trigger (the flood fix)", () => {
    expect(trailDecisionFromEvent(candidateEvent())).toBeNull();
  });

  it("does NOT record observations or blocked events", () => {
    expect(trailDecisionFromEvent({ seq: 1, timestamp: 1, type: "observation", observation: { tracks: [] } })).toBeNull();
    expect(
      trailDecisionFromEvent({ seq: 1, timestamp: 1, type: "candidateBlocked", candidate: { eventType: "GOAL", timestamp: 1 }, reason: "burst" })
    ).toBeNull();
  });

  it("matches end-to-end: N confirmations in, N confirmed entries out (no per-hypothesis leak)", () => {
    const events: AnalyzeEvent[] = [
      candidateEvent(1),
      { seq: 2, timestamp: 100, type: "highlight", highlight: highlight({ id: "a", outcome: "scoring_play" }) },
      candidateEvent(3),
      candidateEvent(4),
      { seq: 5, timestamp: 200, type: "highlight", highlight: highlight({ id: "b", outcome: "scoring_play" }) },
    ];
    const trail = events.map(trailDecisionFromEvent).filter((e): e is NonNullable<typeof e> => e !== null);
    expect(trail).toHaveLength(2); // only the two confirmed highlights
    expect(trail.map((e) => e.highlightId)).toEqual(["a", "b"]);
  });
});

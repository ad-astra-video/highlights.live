// Partition-invariant + detail-client tests (ADAAAA-6852 Inc 4/5). The plan's
// acceptance metric is "each frame in exactly one 3 s section" — assert it here
// so a rendering or backend overlap can never ship as a silent duplication.
import { describe, it, expect } from "vitest";
import { assertFramePartition, sectionFrameCount, triggerLabel, isJobInFlight, type FrameSection } from "./jobDetail";

function frame(seq: number, timestamp: number) {
  return { seq, timestamp, uri: `/jobs/j1/frames/${seq}`, tracks: [] };
}
function section(index: number, frames: { seq: number; timestamp: number }[], decideNotes: any[] = []): FrameSection {
  return { index, startS: index * 3, endS: (index + 1) * 3, frames: frames.map((f) => frame(f.seq, f.timestamp)), decideNotes };
}

describe("assertFramePartition (each frame in exactly one 3s section)", () => {
  it("accepts a clean non-overlapping partition", () => {
    const sections = [
      section(0, [frame(0, 0.2), frame(1, 1.5)]),
      section(1, [frame(2, 3.2), frame(3, 5.0)]),
      section(3, [frame(4, 9.1)]),
    ];
    const r = assertFramePartition(sections);
    expect(r.ok).toBe(true);
    expect(r.duplicates).toEqual([]);
    expect(sectionFrameCount(sections)).toBe(5);
  });

  it("flags a frame duplicated across sections (never shown twice)", () => {
    const sections = [
      section(0, [frame(0, 0.2), frame(1, 1.5)]),
      section(1, [frame(1, 3.2)]), // seq 1 duplicated
    ];
    const r = assertFramePartition(sections);
    expect(r.ok).toBe(false);
    expect(r.duplicates).toContain(1);
  });

  it("flags a frame placed in a section inconsistent with its timestamp", () => {
    // seq 5 at t=1.2 belongs in section 0, but is placed in section 2.
    const sections = [section(0, [frame(0, 0.2)]), section(2, [frame(5, 1.2)])];
    const r = assertFramePartition(sections);
    expect(r.ok).toBe(false);
    expect(r.duplicates).toContain(5);
  });

  it("accepts a single-frame-per-section at the exact 3s boundary", () => {
    // t=3.0 exactly belongs to section 1.
    const sections = [section(0, [frame(0, 0.1)]), section(1, [frame(1, 3.0)])];
    const r = assertFramePartition(sections);
    expect(r.ok).toBe(true);
    expect(r.duplicates).toEqual([]);
  });

  it("reports total frame count so the visibility metric is checkable", () => {
    const sections = [section(0, [frame(0, 0.2), frame(1, 1.0), frame(2, 2.9)])];
    const r = assertFramePartition(sections);
    expect(r.total).toBe(3);
    expect(sectionFrameCount(sections)).toBe(3);
  });
});

// ADAAAA-6989: the JobDetail view keeps its SSE subscription + 5s reconciling
// poll alive only while the job is in flight. The VOD pipeline persists four
// non-terminal statuses (`queued`, `active`, `extracting`, `analyzing`,
// `finalizing`) — a job in ANY of them must be treated as in flight, or the
// detail view stops polling/streaming mid-processing.
describe("isJobInFlight (poll + SSE lifecycle)", () => {
  it("treats queued and active as in flight", () => {
    expect(isJobInFlight("queued")).toBe(true);
    expect(isJobInFlight("active")).toBe(true);
  });

  it("treats the VOD processing stages as in flight (ADAAAA-6989)", () => {
    expect(isJobInFlight("extracting")).toBe(true);
    expect(isJobInFlight("analyzing")).toBe(true);
    expect(isJobInFlight("finalizing")).toBe(true);
  });

  it("treats terminal states as NOT in flight", () => {
    expect(isJobInFlight("done")).toBe(false);
    expect(isJobInFlight("failed")).toBe(false);
    expect(isJobInFlight("cancelled")).toBe(false);
  });

  it("treats a missing status as not in flight", () => {
    expect(isJobInFlight(undefined)).toBe(false);
    expect(isJobInFlight("")).toBe(false);
  });
});

// ADAAAA-6798 Inc 2: per-highlight trigger provenance label. New highlights carry
// a persisted `trigger` (kind + timestamp + eventType); legacy rows without one
// degrade to "trigger unknown".
describe("triggerLabel (per-highlight trigger provenance)", () => {
  it("renders the trigger kind + timestamp + eventType", () => {
    expect(triggerLabel({ kind: "audio_burst", timestamp: 12.4, eventType: "KILL" })).toBe("audio burst @ T+12.4s · KILL");
  });

  it("renders a computed label for a ball-signal trigger", () => {
    expect(triggerLabel({ kind: "motion", timestamp: 33, eventType: "DUNK" })).toBe("motion @ T+33.0s · DUNK");
  });

  it("omits the eventType when it is absent", () => {
    expect(triggerLabel({ kind: "score_change", timestamp: 5, eventType: "" })).toBe("score change @ T+5.0s");
  });

  it("degrades to 'trigger unknown' when the trigger is absent (legacy row)", () => {
    expect(triggerLabel(undefined)).toBe("trigger unknown");
    expect(triggerLabel(null as any)).toBe("trigger unknown");
  });
});

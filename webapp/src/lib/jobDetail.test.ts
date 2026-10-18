// Partition-invariant + detail-client tests (ADAAAA-6852 Inc 4/5). The plan's
// acceptance metric is "each frame in exactly one 3 s section" — assert it here
// so a rendering or backend overlap can never ship as a silent duplication.
import { describe, it, expect } from "vitest";
import { assertFramePartition, sectionFrameCount, type FrameSection } from "./jobDetail";

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

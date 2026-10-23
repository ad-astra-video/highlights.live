// Partition-invariant + detail-client tests (ADAAAA-6852 Inc 4/5). The plan's
// acceptance metric is "each frame in exactly one 3 s section" — assert it here
// so a rendering or backend overlap can never ship as a silent duplication.
import { describe, it, expect } from "vitest";
import {
  assertFramePartition,
  sectionFrameCount,
  triggerLabel,
  isJobInFlight,
  type FrameSection,
  type DecideNote,
  noteKind,
  sectionKinds,
  noteSummaryText,
  sectionSummaryText,
  sectionMatchesFilter,
  sectionMatchesSearch,
  sectionMatches,
} from "./jobDetail";

function frame(seq: number, timestamp: number) {
  return { seq, timestamp, uri: `/jobs/j1/frames/${seq}`, tracks: [] };
}
function section(index: number, frames: { seq: number; timestamp: number }[], decideNotes: any[] = []): FrameSection {
  return { index, startS: index * 3, endS: (index + 1) * 3, frames: frames.map((f) => frame(f.seq, f.timestamp)), decideNotes };
}
function note(over: Partial<DecideNote> & { status: DecideNote["status"] }): DecideNote {
  return {
    seq: 0,
    timestamp: 0,
    eventType: "goal",
    score: 90,
    isHighlight: true,
    ...over,
  };
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

// ADAAAA-7274: the Analysis section window classification, collapsed summary
// text, type filter, and text search. These are the pure building blocks behind
// the collapsible Analysis list — filter + search + type marks stay in lockstep.
describe("noteKind / sectionKinds (window type classification)", () => {
  it("classifies an accepted highlight as a `highlight`", () => {
    expect(noteKind(note({ status: "accepted", outcome: "scoring_play", isHighlight: true }))).toBe("highlight");
  });

  it("classifies a gated-off note (status suppressed) as `suppressed`", () => {
    expect(noteKind(note({ status: "suppressed", isHighlight: true }))).toBe("suppressed");
  });

  it("classifies a note whose outcome is not_highlight as `not_highlight`", () => {
    expect(noteKind(note({ status: "accepted", outcome: "not_highlight", isHighlight: true }))).toBe("not_highlight");
    expect(noteKind(note({ status: "accepted", isHighlight: false }))).toBe("not_highlight");
  });

  it("returns the distinct kinds in a window in canonical order", () => {
    const s = section(0, [frame(0, 0.2)], [
      note({ seq: 1, status: "accepted", isHighlight: true }),
      note({ seq: 2, status: "suppressed", isHighlight: true }),
    ]);
    expect(sectionKinds(s)).toEqual(["highlight", "suppressed"]);
    expect(sectionKinds(section(1, [frame(1, 3.1)], []))).toEqual([]);
  });
});

describe("sectionSummaryText / noteSummaryText (collapsed summary)", () => {
  it("summarizes a window with a decide note (type · score · status · outcome)", () => {
    const s = section(0, [frame(0, 0.2)], [note({ seq: 1, timestamp: 1.2, status: "accepted", outcome: "scoring_play", score: 92 })]);
    const text = sectionSummaryText(s);
    expect(text).toContain("T+0s – T+3s");
    expect(text).toContain("goal");
    expect(text).toContain("92");
    expect(text).toContain("accepted");
    expect(text).toContain("scoring_play");
  });

  it("reads as having no analysis for a window with no decide notes", () => {
    expect(sectionSummaryText(section(0, [frame(0, 0.2)], []))).toContain("no analysis");
  });
});

describe("sectionMatchesFilter / sectionMatchesSearch / sectionMatches (filter + search)", () => {
  const hl = section(0, [frame(0, 0.2)], [note({ seq: 1, status: "accepted", isHighlight: true, reason: "goal in zone" })]);
  const sup = section(1, [frame(1, 3.2)], [note({ seq: 2, status: "suppressed", isHighlight: true, reason: "crowd noise" })]);
  const nh = section(2, [frame(2, 6.1)], [note({ seq: 3, status: "accepted", outcome: "not_highlight", isHighlight: true })]);

  it("an empty filter matches every window", () => {
    expect(sectionMatchesFilter(hl, [])).toBe(true);
    expect(sectionMatchesFilter(sup, [])).toBe(true);
  });

  it("narrows to the selected type(s)", () => {
    expect(sectionMatchesFilter(hl, ["highlight"])).toBe(true);
    expect(sectionMatchesFilter(sup, ["highlight"])).toBe(false);
    expect(sectionMatchesFilter(sup, ["suppressed"])).toBe(true);
    expect(sectionMatchesFilter(nh, ["not_highlight"])).toBe(true);
  });

  it("a window with no decide notes matches nothing once a filter is applied", () => {
    expect(sectionMatchesFilter(section(3, [frame(3, 9.1)], []), ["highlight"])).toBe(false);
  });

  it("an empty query matches every window", () => {
    expect(sectionMatchesSearch(hl, "")).toBe(true);
    expect(sectionMatchesSearch(hl, "   ")).toBe(true);
  });

  it("matches summary text case-insensitively", () => {
    expect(sectionMatchesSearch(hl, "goal")).toBe(true);
    expect(sectionMatchesSearch(hl, "GOAL")).toBe(true);
    expect(sectionMatchesSearch(hl, "nonexistent")).toBe(false);
  });

  it("combines both controls (intersection)", () => {
    expect(sectionMatches(hl, ["highlight"], "goal")).toBe(true);
    expect(sectionMatches(hl, ["suppressed"], "goal")).toBe(false);
    expect(sectionMatches(hl, ["highlight"], "crowd")).toBe(false);
  });
});

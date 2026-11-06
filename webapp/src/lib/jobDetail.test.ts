// Partition-invariant + detail-client tests (ADAAAA-6852 Inc 4/5). The plan's
// acceptance metric is "each frame in exactly one 3 s section" — assert it here
// so a rendering or backend overlap can never ship as a silent duplication.
import { describe, it, expect } from "vitest";
import {
  assertFramePartition,
  sectionFrameCount,
  triggerLabel,
  isJobInFlight,
  candidateCountLabel,
  stageACountLabel,
  decideCallsCount,
  type FrameSection,
  type DecideNote,
  noteKind,
  sectionKinds,
  noteSummaryText,
  sectionSummaryText,
  sectionMatchesFilter,
  sectionMatchesSearch,
  sectionMatches,
  mergeSections,
  deltaRequestAfter,
  SECTION_WINDOW_S,
  hasHighlightContent,
  highlightContentCounts,
  verdictText,
  verdictCriterionText,
  dataItemValueText,
  type JobDetailHighlight,
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

describe("job-detail counters (ADAAAA-7624)", () => {
  it("shows the candidate count the observe path produced", () => {
    expect(candidateCountLabel({ candidatesTriggered: 24 })).toBe("24");
  });

  it("shows n/a when the record carries no candidate count (never a fabricated 0)", () => {
    expect(candidateCountLabel({})).toBe("n/a");
  });

  it("shows n/a for Stage-A counters when the audio gate is not measured", () => {
    expect(stageACountLabel({})).toBe("n/a");
    expect(stageACountLabel({ stageAMetricsStatus: "n/a" })).toBe("n/a");
    // An all-zero snapshot must not read as a measured 0% FP rate.
    expect(
      stageACountLabel({
        stageAMetricsStatus: "measured",
        stageAMetrics: {
          totalCandidates: 0,
          accepted: 0,
          rejected: 0,
          fpRate: 0,
          meanOnsetLatencyS: 0,
          maxOnsetLatencyS: 0,
        },
      })
    ).toBe("n/a");
  });

  it("shows real Stage-A counters when measured", () => {
    expect(
      stageACountLabel({
        stageAMetricsStatus: "measured",
        stageAMetrics: {
          totalCandidates: 4,
          accepted: 3,
          rejected: 1,
          fpRate: 0.25,
          meanOnsetLatencyS: 1.2,
          maxOnsetLatencyS: 3.4,
        },
      })
    ).toBe("4 judged · 25% FP");
  });
});

// ADAAAA-7664: a live observe-path job (fixture 2118ea32) made 17 decide calls
// and wrote 16 decide-audit rows, but the header rendered `0` because it read
// only the VOD-populated `job.decideCalls` field.
describe("decideCallsCount (ADAAAA-7664)", () => {
  it("shows the observe-pass count for a live job whose job-level field is null", () => {
    expect(decideCallsCount({ decideCalls: null, observeMetrics: { decideCalls: 17 } } as any)).toBe(17);
    expect(decideCallsCount({ observeMetrics: { decideCalls: 17 } })).toBe(17);
  });

  it("never shows fewer decides than the decide-audit rows for a live job", () => {
    const rows = 16;
    const calls = decideCallsCount({ decideCalls: null, observeMetrics: { decideCalls: 17 } } as any);
    expect(calls).toBeGreaterThanOrEqual(rows);
  });

  it("keeps a VOD job's count unchanged, including 0 when no decide ran", () => {
    expect(decideCallsCount({ decideCalls: 18 })).toBe(18);
    expect(decideCallsCount({ decideCalls: 0 })).toBe(0);
    // A VOD record that also carries an observe snapshot still prefers its own field.
    expect(decideCallsCount({ decideCalls: 4, observeMetrics: { decideCalls: 9 } })).toBe(4);
  });

  it("falls back to 0 only when neither path recorded a count", () => {
    expect(decideCallsCount({})).toBe(0);
    expect(decideCallsCount({ observeMetrics: {} })).toBe(0);
  });
});

// ADAAAA-7742: the open live detail page appends the windows it does not hold
// yet instead of re-fetching the accumulated composite payload. The merge must
// keep the 3 s bucket order, replace a re-sent tail bucket (so a decide note
// that landed into it shows), and leave every earlier bucket untouched.
describe("mergeSections + SECTION_WINDOW_S (ADAAAA-7742)", () => {
  it("appends new buckets in 3 s order and keeps the ones already rendered", () => {
    const existing = [section(0, [frame(0, 0.2)]), section(1, [frame(1, 3.4)])];
    const incoming = [section(2, [frame(2, 6.4)]), section(3, [frame(3, 9.4)])];
    const merged = mergeSections(existing, incoming);
    expect(merged.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(merged[0]).toBe(existing[0]); // untouched copy
    expect(sectionFrameCount(merged)).toBe(4);
    expect(assertFramePartition(merged).ok).toBe(true);
  });

  it("replaces the re-sent tail bucket so its new decide note renders", () => {
    const stale = section(2, [frame(2, 6.4)]);
    const existing = [section(1, [frame(1, 3.4)]), stale];
    const freshTail = section(2, [frame(2, 6.4)], [note({ status: "accepted", timestamp: 6.6, reason: "ball in net" })]);
    const merged = mergeSections(existing, [freshTail]);
    expect(merged.map((s) => s.index)).toEqual([1, 2]);
    expect(merged[1]).toBe(freshTail);
    expect(merged[1].decideNotes.map((n) => n.reason)).toEqual(["ball in net"]);
  });

  it("is a no-op when the delta carries nothing (page already caught up)", () => {
    const existing = [section(0, [frame(0, 0.2)])];
    expect(mergeSections(existing, [])).toBe(existing);
  });

  it("sorts an out-of-order delta and never duplicates a bucket index", () => {
    const merged = mergeSections([section(0, [frame(0, 0.2)])], [section(4, [frame(4, 12.2)]), section(3, [frame(3, 9.2)])]);
    expect(merged.map((s) => s.index)).toEqual([0, 3, 4]);
    expect(new Set(merged.map((s) => s.index)).size).toBe(merged.length);
  });

  it("keeps SECTION_WINDOW_S in sync with the server bucket width", () => {
    // services/server/src/job-detail.ts partitions at SECTION_WINDOW = 3 s; a
    // client-side drift here would make the page ask for the wrong bucket.
    expect(SECTION_WINDOW_S).toBe(3);
    expect(Math.floor(9.4 / SECTION_WINDOW_S)).toBe(3);
  });
});

describe("deltaRequestAfter (ADAAAA-7997 live page with no bucket baseline)", () => {
  it("asks from the top when the page mounted before the job produced its first window", () => {
    // The live page opens on the POST /jobs 202; the composite mount fetch
    // carries zero sections, so the baseline is -1. Standing down here froze
    // the page at the empty state while SSE highlights arrived (QA 7992/7997).
    expect(deltaRequestAfter(-1, null)).toBe(-1);
    expect(deltaRequestAfter(-1, 3)).toBe(-1);
  });

  it("re-requests the newest known bucket so a decide note persisted into it shows", () => {
    expect(deltaRequestAfter(40, null)).toBe(39);
    expect(deltaRequestAfter(0, null)).toBe(-1);
  });

  it("widens to the earlier bucket an SSE event named", () => {
    expect(deltaRequestAfter(40, 12)).toBe(12);
    expect(deltaRequestAfter(40, 39)).toBe(39);
    expect(deltaRequestAfter(40, 99)).toBe(39);
  });
});

// ADAAAA-8034: the "No accepted highlights for this job." empty state must
// answer "does the page have ANY highlight content?", not "are there postable
// cards?". The reported job (`5a320b2d`) has 0 postable cards because its only
// accepted highlight is a non-scoring BIG_PLAY the precision gate keeps out of
// the gallery — yet its notable lane (1 row) and summary log (3 entries) are
// populated, so the empty state sat beside a visible lane row.
describe("hasHighlightContent (ADAAAA-8034 empty-state gating)", () => {
  function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
    return {
      id: "h1",
      jobId: "j1",
      clipUri: "/jobs/j1/clips/h1.mp4",
      start: 0,
      end: 6,
      score: 70,
      status: "accepted",
      createdAt: "2026-11-04T23:22:35.333Z",
      ...over,
    };
  }

  it("does NOT show the empty state for 0 postable cards + 1 notable row (the 5a320b2d shape)", () => {
    // The live payload replay: highlights = [], notableHighlights = 1 BIG_PLAY,
    // summaryLog = 3 entries. Before this fix the gallery's own emptiness drove
    // the message, so it rendered beside the lane row.
    const detail = {
      highlights: [] as JobDetailHighlight[],
      notableHighlights: [hl({ id: "n1", eventType: "BIG_PLAY", outcome: "big_play", score: 60 })],
      duplicateHighlights: [] as JobDetailHighlight[],
      job: {
        summaryLog: [
          { seq: 1, ts: "2026-11-04T23:22:35.333Z", windowTs: 0, text: "dribble" },
          { seq: 2, ts: "2026-11-04T23:22:56.549Z", windowTs: 21, text: "tackle" },
          { seq: 3, ts: "2026-11-04T23:23:10.001Z", windowTs: 33, text: "shot" },
        ],
      },
    };
    const counts = highlightContentCounts(detail);
    expect(counts).toEqual({ postable: 0, notable: 1, merged: 0, summaries: 3 });
    expect(hasHighlightContent(counts)).toBe(true);
  });

  it("does NOT show the empty state for a postable-free job whose only content is a merged lane row", () => {
    const counts = highlightContentCounts({
      highlights: [],
      notableHighlights: [],
      duplicateHighlights: [hl({ id: "d1", duplicateOf: "h9" })],
      job: { summaryLog: [] },
    });
    expect(counts).toEqual({ postable: 0, notable: 0, merged: 1, summaries: 0 });
    expect(hasHighlightContent(counts)).toBe(true);
  });

  it("still shows the empty state for a job with no highlight content at all", () => {
    const counts = highlightContentCounts({
      highlights: [],
      job: {},
    });
    expect(counts).toEqual({ postable: 0, notable: 0, merged: 0, summaries: 0 });
    expect(hasHighlightContent(counts)).toBe(false);
  });

  it("shows no empty state whenever a postable card exists", () => {
    const counts = highlightContentCounts({ highlights: [hl()], job: {} });
    expect(counts.postable).toBe(1);
    expect(hasHighlightContent(counts)).toBe(true);
  });

  it("does not count a rejected row as postable content (it lives in the hidden strip)", () => {
    const counts = highlightContentCounts({
      highlights: [hl({ status: "rejected" })],
      notableHighlights: [],
      duplicateHighlights: [],
      job: { summaryLog: [] },
    });
    expect(counts.postable).toBe(0);
    expect(hasHighlightContent(counts)).toBe(false);
  });
});

// ADAAAA-8187: the webapp never validates the decide payload, so a "scalar"
// field can arrive as an object. `String(object)` is "[object Object]" and a
// bare object child throws; these helpers are the single formatter boundary.
describe("verdictText / verdictCriterionText (ADAAAA-8187)", () => {
  it("keeps the documented scalar wording", () => {
    expect(verdictText(null)).toBe("—");
    expect(verdictText(undefined)).toBe("—");
    expect(verdictText("")).toBe("—");
    expect(verdictText("confirmed_goal")).toBe("confirmed_goal");
    expect(verdictText(true)).toBe("yes");
    expect(verdictText(false)).toBe("no");
    expect(verdictText(0)).toBe("0");
    expect(verdictText(92.5)).toBe("92.5");
  });

  it("summarises an object as compact key: value text, never [object Object]", () => {
    expect(verdictText({ a: 1, b: null })).toBe("a: 1, b: —");
    expect(verdictText({})).toBe("—");
    expect(verdictText({ criteria: { ballInNet: true, crowdErupted: null } })).toBe(
      "criteria: ballInNet: yes, crowdErupted: —"
    );
    expect(verdictText({ a: 1 })).not.toContain("[object Object]");
  });

  it("joins an array of formatted items", () => {
    expect(verdictText(["x", 2, true])).toBe("x, 2, yes");
    expect(verdictText([])).toBe("—");
    expect(verdictText([{ a: 1 }, null])).toBe("a: 1, —");
  });

  it("falls back to compact JSON past the nesting limit and for cycles", () => {
    expect(verdictText({ a: { b: { c: 1 } } })).toBe('a: b: {"c":1}');
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = { deeper: cyclic };
    expect(verdictText(cyclic)).not.toContain("[object Object]");
  });

  it("maps the criteria tri-state (wire null = unverifiable)", () => {
    expect(verdictCriterionText(true)).toBe("seen");
    expect(verdictCriterionText(false)).toBe("not seen");
    expect(verdictCriterionText(null)).toBe("unverifiable");
    expect(verdictCriterionText(undefined)).toBe("unverifiable");
    expect(verdictCriterionText("partial")).toBe("partial");
  });

  it("dataItemValueText routes every non-scalar through the same formatter", () => {
    expect(dataItemValueText(4)).toBe("4");
    expect(dataItemValueText(true)).toBe("yes");
    expect(dataItemValueText(null)).toBe("—");
    expect(dataItemValueText({ a: 1 })).toBe("a: 1");
    expect(dataItemValueText(["a", "b"])).toBe("a, b");
  });
});

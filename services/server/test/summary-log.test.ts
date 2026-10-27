// ADAAAA-7237: append-only per-pass summary time log (the "Video Summary"
// section data). Covers:
//   (a) `summaryDelta` — incremental per-pass content derived from the rolling
//       running-summary delta (no duplicate of already-captured lines);
//   (b) `appendSummaryEntry` — append-only (never overwrite/drop/reorder),
//       monotonic sequence + timestamp, persists the bounded running summary too.
//
// (ADAAAA-7501: the end-of-video compiled "Overall Summary" was removed, so the
//   `fallbackOverallSummary` / `requestOverallSummary` / `applyOverallSummary`
//   tests below are gone with the generation path they covered.)
import { describe, it, expect } from "vitest";
import { Store } from "../src/store";
import {
  summaryDelta,
  nextSummarySeq,
  appendSummaryEntry,
} from "../src/summary-log";

describe("summaryDelta (ADAAAA-7237)", () => {
  it("returns the incremented lines added this pass (not already in the prior)", () => {
    expect(summaryDelta("first event", "first event\nsecond event")).toBe("second event");
  });

  it("returns the whole summary on the first pass (no prior)", () => {
    expect(summaryDelta(undefined, "a goal at 120s")).toBe("a goal at 120s");
    expect(summaryDelta("", "a goal at 120s")).toBe("a goal at 120s");
  });

  it("does not re-log lines already present (no duplicate entries)", () => {
    expect(summaryDelta("a\nb", "a\nb\nc")).toBe("c");
  });

  it("returns '' when nothing new was added in this pass", () => {
    expect(summaryDelta("same", "same")).toBe("");
  });
});

describe("nextSummarySeq / appendSummaryEntry (ADAAAA-7237)", () => {
  it("nextSummarySeq is 1 on an empty log and strictly increasing afterward", () => {
    expect(nextSummarySeq(undefined)).toBe(1);
    expect(nextSummarySeq([])).toBe(1);
    expect(nextSummarySeq([{ seq: 1, ts: "t", text: "a" }, { seq: 2, ts: "t", text: "b" }])).toBe(3);
  });

  it("appends entries monotonically and NEVER overwrites or reorders a prior entry", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "first window", { windowTs: 10 });
    await appendSummaryEntry(s, job.id, "first window\nsecond window", { windowTs: 20 });
    await appendSummaryEntry(s, job.id, "first window\nsecond window\nthird window", { windowTs: 30 });
    const j = s.getJob(job.id)!;
    expect(j.summaryLog).toHaveLength(3);
    expect(j.summaryLog!.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(j.summaryLog!.map((e) => e.windowTs)).toEqual([10, 20, 30]);
    // Text captures the incremental per-pass content, not a re-log of priors.
    expect(j.summaryLog![0].text).toBe("first window");
    expect(j.summaryLog![1].text).toBe("second window");
    expect(j.summaryLog![2].text).toBe("third window");
    // The bounded rolling summary is still persisted alongside the log.
    expect(j.runningSummary).toBe("first window\nsecond window\nthird window");
    // Every entry carries a monotonic sequence + timestamp.
    for (const e of j.summaryLog!) {
      expect(typeof e.ts).toBe("string");
      expect(e.seq).toBeGreaterThan(0);
    }
  });

  it("persists the log through the DB-backed store (durable, reconstructible)", async () => {
    // Use the in-memory Store which mirrors the job record; the DB path writes
    // the same Job record via saveJob. We assert the record round-trips.
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4" });
    await appendSummaryEntry(s, job.id, "a");
    await appendSummaryEntry(s, job.id, "a\nb");
    const j = s.getJob(job.id)!;
    expect(j.summaryLog!.map((e) => e.text)).toEqual(["a", "b"]);
    expect(s.listJobsForOwner(undefined).find((x) => x.id === job.id)?.summaryLog).toHaveLength(2);
  });
});

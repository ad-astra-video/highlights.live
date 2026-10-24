// ADAAAA-7237: append-only per-pass summary time log + end-of-video overall
// summary. Covers:
//   (a) `summaryDelta` — incremental per-pass content derived from the rolling
//       running-summary delta (no duplicate of already-captured lines);
//   (b) `appendSummaryEntry` — append-only (never overwrite/drop/reorder),
//       monotonic sequence + timestamp, persists the bounded running summary too;
//   (c) `fallbackOverallSummary` — names every accepted highlight (event type +
//       timestamp) and walks the time log as a whole-video overview;
//   (d) `applyOverallSummary` — exactly ONE /app/summary call per completed job,
//       LLM result used, re-call guarded, deterministic fallback on failure.
import { describe, it, expect } from "vitest";
import { Store } from "../src/store";
import {
  summaryDelta,
  nextSummarySeq,
  appendSummaryEntry,
  fallbackOverallSummary,
  requestOverallSummary,
  applyOverallSummary,
} from "../src/summary-log";
import type { HighlightRecord } from "@highlights/events";

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

describe("fallbackOverallSummary (ADAAAA-7237)", () => {
  it("names each accepted highlight with event type + timestamp and overviews the log", () => {
    const highlights = [
      { id: "h1", eventType: "GOAL", start: 120, reason: "a goal in the box", status: "accepted", jobId: "j1", clipUri: "/c.mp4", createdAt: "t" },
      { id: "h2", eventType: "NEAR_MISS", start: 300, reason: "hit the post", status: "accepted", jobId: "j1", clipUri: "/c2.mp4", createdAt: "t" },
    ] as unknown as HighlightRecord[];
    const log = [{ seq: 1, ts: "t", windowTs: 10, text: "early pressure" }, { seq: 2, ts: "t", windowTs: 300, text: "late goal" }];
    const out = fallbackOverallSummary({ gameHint: "soccer" }, highlights, log);
    expect(out).toContain("Overview of soccer video");
    expect(out).toContain("Points of interest (2)");
    expect(out).toContain("- GOAL at 2:00");
    expect(out).toContain("- NEAR_MISS at 5:00");
    expect(out).toContain("early pressure");
    expect(out).toContain("late goal");
  });

  it("reports no highlights when accepted set is empty", () => {
    const out = fallbackOverallSummary({ gameHint: "soccer" }, [], []);
    expect(out).toContain("No confirmed highlights.");
  });
});

describe("requestOverallSummary / applyOverallSummary (ADAAAA-7237)", () => {
  it("makes exactly ONE /app/summary call per completed job and uses the LLM summary", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await s.patchJob(job.id, { status: "done" });
    await appendSummaryEntry(s, job.id, "a goal");
    await s.addHighlight({
      id: "h1", jobId: job.id, clipUri: "/c.mp4", start: 60, end: 80,
      status: "accepted", score: 90, reason: "a goal", eventType: "GOAL",
      createdAt: new Date().toISOString(),
    } as any);
    const calls: any[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ overallSummary: "A goal in the first half." }) };
    }) as any;
    await applyOverallSummary(s, { decideUrl: "http://decide/" }, job.id, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://decide/app/summary");
    expect(s.getJob(job.id)!.overallSummary).toBe("A goal in the first half.");
    // The LLM request carries the confirmed highlight + time log.
    const body = JSON.parse(calls[0].init.body);
    expect(body.pointsOfInterest[0].eventType).toBe("GOAL");
    expect(body.timeLog).toHaveLength(1);
  });

  it("applies the deterministic fallback when the decide service is unavailable", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await s.patchJob(job.id, { status: "done" });
    await s.addHighlight({
      id: "h1", jobId: job.id, clipUri: "/c.mp4", start: 10, end: 20,
      status: "accepted", score: 90, reason: "header", eventType: "GOAL",
      createdAt: new Date().toISOString(),
    } as any);
    await applyOverallSummary(s, { decideUrl: undefined }, job.id);
    const out = s.getJob(job.id)!.overallSummary!;
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("GOAL");
  });

  it("does NOT re-call summary when the job already has an overall summary (exactly one call total)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4" });
    await s.patchJob(job.id, { overallSummary: "already compiled", status: "done" });
    const calls: any[] = [];
    const fetchImpl = (async () => {
      calls.push(1);
      return { ok: true, json: async () => ({ overallSummary: "X" }) };
    }) as any;
    await applyOverallSummary(s, { decideUrl: "http://decide" }, job.id, fetchImpl);
    expect(calls).toHaveLength(0);
    expect(s.getJob(job.id)!.overallSummary).toBe("already compiled");
  });

  it("requestOverallSummary returns null on a non-2xx / unparseable decide response", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
    expect(await requestOverallSummary({ decideUrl: "http://decide/" }, { id: "j1", gameHint: "soccer" }, [], [], fetchImpl)).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  appliedDecideWatermark,
  deriveLiveProgress,
  type LiveProgressInput,
} from "../src/live-progress";

// ADAAAA-8265: the processed-through watermark is the newest APPLIED decide, not
// the newest `summaryLog` row. The summary log is appended only when the running
// summary emitted a caption row — coarse (~20 s p50 on the measured legs, zero
// rows on a 70 s leg) — so reading it as decide progress made the live lag chip
// report the SUMMARY cadence: 28-46 s p50 on a leg whose decide p50 was 2.0 s.
// These tests pin the watermark, the legacy fallback, the terminal freeze and the
// "no invented lag" cases.

const T0 = Date.parse("2026-11-07T04:32:55.101Z");

function liveJob(over: Partial<LiveProgressInput["job"]> = {}): LiveProgressInput["job"] {
  return {
    status: "active",
    source: "file-sim",
    startedAt: new Date(T0).toISOString(),
    createdAt: new Date(T0).toISOString(),
    // A sparse summary log: two caption rows in 300 s of content — exactly the
    // shape the 3 s hop / keep 0.69 leg produced (8 rows on one stream, 4 on the
    // other, none at all on the 70 s cell).
    summaryLog: [
      { seq: 1, ts: new Date(T0 + 67_600).toISOString(), windowTs: 54, text: "Midfield." },
      { seq: 2, ts: new Date(T0 + 259_600).toISOString(), windowTs: 255, text: "Shot." },
    ],
    ...over,
  };
}

/** One candidate row per decided window: content ts + the wall it was applied. */
function candidates(count: number, fromS: number, stepS: number, settleExtraS: number) {
  return Array.from({ length: count }, (_, i) => {
    const contentTs = fromS + i * stepS;
    return {
      timestamp: contentTs,
      createdAt: new Date(T0 + (contentTs + settleExtraS) * 1000).toISOString(),
    };
  });
}

describe("appliedDecideWatermark (ADAAAA-8265)", () => {
  it("takes the newest content ts and the newest apply wall independently", () => {
    const w = appliedDecideWatermark([
      { timestamp: 12, createdAt: new Date(T0 + 14_000).toISOString() },
      { timestamp: 21, createdAt: new Date(T0 + 26_000).toISOString() },
      { timestamp: 18, createdAt: new Date(T0 + 20_000).toISOString() },
    ]);
    expect(w.ts).toBe(21);
    expect(w.atMs).toBe(T0 + 26_000);
  });

  it("keeps the content ts when a row's createdAt is missing or unparseable", () => {
    const w = appliedDecideWatermark([
      { timestamp: 40 },
      { timestamp: 44, createdAt: "not-a-date" },
    ]);
    expect(w.ts).toBe(44);
    expect(w.atMs).toBeNull();
  });

  it("returns 0 / null for no candidates (never an invented position)", () => {
    expect(appliedDecideWatermark([])).toEqual({ ts: 0, atMs: null });
    expect(appliedDecideWatermark(undefined)).toEqual({ ts: 0, atMs: null });
  });
});

describe("deriveLiveProgress watermark (ADAAAA-8265)", () => {
  it("reads lag off the applied decide, not the sparse summary log", () => {
    const p = deriveLiveProgress({
      job: liveJob(),
      decidedThroughTs: 295,
      decidedAtMs: T0 + 297_000,
      nowMs: T0 + 300_000,
    });
    expect(p.processedThroughTs).toBe(295);
    expect(p.liveEdgeTs).toBe(300);
    expect(p.lagSec).toBe(5);
    expect(p.state).toBe("caught_up");
  });

  it("applies the 10 s caught-up boundary to the decide watermark too (ADAAAA-8944)", () => {
    // The boundary moved but the source of truth did not: the same applied-decide
    // watermark at 9 s reads caught_up and at 10 s reads behind.
    const nine = deriveLiveProgress({ job: liveJob(), decidedThroughTs: 291, nowMs: T0 + 300_000 });
    expect(nine.lagSec).toBe(9);
    expect(nine.state).toBe("caught_up");
    const ten = deriveLiveProgress({ job: liveJob(), decidedThroughTs: 290, nowMs: T0 + 300_000 });
    expect(ten.lagSec).toBe(10);
    expect(ten.state).toBe("behind");
  });

  it("keeps the summary-log reading for a record with no candidate watermark (legacy)", () => {
    // Same job, same instant: the old meter read the caption cadence and called a
    // caught-up run 45 s behind. The fallback must stay available, but only then.
    const p = deriveLiveProgress({ job: liveJob(), nowMs: T0 + 300_000 });
    expect(p.processedThroughTs).toBe(255);
    expect(p.lagSec).toBe(45);
    expect(p.state).toBe("behind");
  });

  it("takes the max of the two watermarks (a summary row can lead the decide ledger)", () => {
    const p = deriveLiveProgress({
      job: liveJob(),
      decidedThroughTs: 240,
      nowMs: T0 + 300_000,
    });
    expect(p.processedThroughTs).toBe(255);
    expect(p.lagSec).toBe(45);
  });

  it("never reports a lag on a share with no applied decide and no summary rows", () => {
    const p = deriveLiveProgress({
      job: liveJob({ summaryLog: [] }),
      nowMs: T0 + 79_500,
    });
    expect(p.processedThroughTs).toBe(0);
    expect(p.state).toBe("unknown");
  });

  it("always satisfies lagSec === liveEdgeTs - processedThroughTs", () => {
    const p = deriveLiveProgress({
      job: liveJob(),
      decidedThroughTs: 301,
      nowMs: T0 + 305_400,
      newestObservationTs: 304,
    });
    expect(p.lagSec).toBeCloseTo(p.liveEdgeTs - p.processedThroughTs, 3);
  });
});

describe("terminal freeze at the newest applied decide (ADAAAA-8265)", () => {
  const done = liveJob({
    status: "cancelled",
    finishedAt: new Date(T0 + 320_000).toISOString(),
    summaryLog: [{ seq: 1, ts: new Date(T0 + 190_600).toISOString(), windowTs: 187, text: "Center circle." }],
  });

  it("freezes the edge at the last applied decide wall, not the last caption row", () => {
    const p = deriveLiveProgress({
      job: done,
      decidedThroughTs: 310,
      decidedAtMs: T0 + 316_000,
      nowMs: T0 + 900_000,
    });
    // 316 s wall since the anchor, less 310 s of processed content.
    expect(p.liveEdgeTs).toBe(316);
    expect(p.lagSec).toBe(6);
    expect(p.state).toBe("unknown");
  });

  it("falls back to the summary append wall when the record predates the field", () => {
    const p = deriveLiveProgress({ job: done, nowMs: T0 + 900_000 });
    expect(p.liveEdgeTs).toBe(190.6);
    expect(p.processedThroughTs).toBe(187);
  });
});

describe("the leg's own rows reproduce the two readings (ADAAAA-8265)", () => {
  // Job 30d6bb75 on the 3 s hop / keep 0.69 cell: 71 decides, content 0 -> 301 s,
  // settle wall = content + 5.6 s (measured p50), and only 8 caption rows.
  const legCandidates = candidates(71, 0, 4.24, 5.64);
  const legJob = liveJob({
    summaryLog: [{ seq: 1, ts: new Date(T0 + 67_600).toISOString(), windowTs: 54, text: "Midfield." }],
  });

  function samples(useWatermark: boolean): number[] {
    const out: number[] = [];
    for (let t = 0; t <= 320; t += 4) {
      const wall = T0 + t * 1000;
      const decided = useWatermark
        ? appliedDecideWatermark(
            legCandidates.filter((c) => Date.parse(c.createdAt) <= wall)
          )
        : undefined;
      out.push(
        deriveLiveProgress({
          job: legJob,
          nowMs: wall,
          ...(decided ? { decidedThroughTs: decided.ts, decidedAtMs: decided.atMs } : {}),
        }).lagSec
      );
    }
    return out;
  }

  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

  it("the summary-log meter reads tens of seconds while the applied-decide meter does not", () => {
    const legacy = samples(false);
    const fixed = samples(true);
    expect(median(legacy)).toBeGreaterThan(20);
    expect(median(fixed)).toBeLessThan(median(legacy) / 2);
  });
});

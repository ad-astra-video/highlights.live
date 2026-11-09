// ADAAAA-8495 (AC3): the delivered-latency row must ROUND-TRIP through
// `JobSchema.parse`.
//
// ADAAAA-8487 AC-A found that `deliveredLatency.rows` declared 7 of the 9 keys
// `deliveredLatencyRow` emits, so zod stripped `localizeOffsetMs` and
// `highlightId` on every write: the stored row could not reconstruct its own
// total (the localization term is part of the stage sum) and the metric's dedupe
// key was lost, which is the same trap `confirmCalls` hit before it was declared
// (ADAAAA-7691). Both fields are ADDITIVE OPTIONAL: a row written before them
// still parses.
import { describe, it, expect } from "vitest";
import { JobSchema } from "../src/index";

const ROW = {
  triggerTs: 101.667,
  deliveredLatencyMs: 3_799,
  fireLagMs: 2_780,
  decideE2eMs: 3_839,
  acceptWaitMs: 20,
  acceptMs: 160,
  persistAckMs: 0,
  localizeOffsetMs: -3_000,
  highlightId: "hl-8495-1",
};

function job(deliveredLatency?: unknown) {
  return JobSchema.parse({
    id: "job-8495",
    source: "file-sim",
    status: "done",
    createdAt: "2026-11-09T12:54:53.957Z",
    ...(deliveredLatency
      ? {
          observeMetrics: {
            decideCalls: 1,
            accepted: 1,
            maxFrames: 4,
            meanE2eMs: 3_839,
            maxE2eMs: 3_839,
            meanCadenceMs: 3_000,
            maxCadenceMs: 3_000,
            deliveredLatency,
          },
        }
      : {}),
  });
}

describe("deliveredLatency.rows round-trips localizeOffsetMs + highlightId (ADAAAA-8495 AC3)", () => {
  it("keeps both keys through JobSchema.parse instead of stripping them", () => {
    const j = job({
      samples: 1,
      p50Ms: ROW.deliveredLatencyMs,
      p95Ms: ROW.deliveredLatencyMs,
      maxMs: ROW.deliveredLatencyMs,
      rows: [ROW],
    });
    const row = j.observeMetrics?.deliveredLatency?.rows[0];
    expect(row).toBeDefined();
    expect(row?.localizeOffsetMs).toBe(-3_000);
    expect(row?.highlightId).toBe("hl-8495-1");
    // The stored row reconstructs its own total: stages + localize term.
    const sum =
      (row?.fireLagMs ?? 0) +
      (row?.decideE2eMs ?? 0) +
      (row?.acceptWaitMs ?? 0) +
      (row?.acceptMs ?? 0) +
      (row?.persistAckMs ?? 0) +
      (row?.localizeOffsetMs ?? 0);
    expect(sum).toBe(row?.deliveredLatencyMs);
    // All 9 keys the row builder emits survive the write.
    expect(Object.keys(row ?? {}).sort()).toEqual(Object.keys(ROW).sort());
  });

  it("still parses a row written BEFORE the fields existed (additive optional)", () => {
    const legacy = {
      triggerTs: 101.667,
      deliveredLatencyMs: 3_799,
      fireLagMs: 2_780,
      decideE2eMs: 3_839,
      acceptWaitMs: 20,
      acceptMs: 160,
      persistAckMs: 12,
    };
    const j = job({ samples: 1, p50Ms: 3_799, p95Ms: 3_799, maxMs: 3_799, rows: [legacy] });
    const row = j.observeMetrics?.deliveredLatency?.rows[0];
    expect(row?.persistAckMs).toBe(12);
    expect(row?.localizeOffsetMs).toBeUndefined();
    expect(row?.highlightId).toBeUndefined();
  });

  it("rejects a non-numeric localize offset", () => {
    expect(() =>
      JobSchema.parse({
        id: "j",
        source: "file",
        createdAt: "2026-09-24T00:00:00Z",
        observeMetrics: {
          deliveredLatency: { samples: 1, p50Ms: 1, p95Ms: 1, maxMs: 1, rows: [{ ...ROW, localizeOffsetMs: "x" }] },
        },
      })
    ).toThrow();
  });
});

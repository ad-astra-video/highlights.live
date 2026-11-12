// ADAAAA-8668 (spec ADAAAA-8665 §3): the post-promotion `summary` lane and its
// meter/cost terms.
//
// These tests exercise the lane against a stub decide service: exactly one call
// per promoted row (plus at most one retry), drop-and-serve on every failure, a
// refusal that writes the meter but never copy, and a fee that is its own term
// in `costUsd` and clamped to 1.5x DECIDE_FEE.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_LANE_PENDING_RING,
  SummaryLane,
  runSummaryForRow,
  summaryEvidenceForRow,
  summaryFeeFor,
  summaryP95,
  type SummaryLaneStore,
} from "../src/summary-lane.js";
import { SUMMARY_RAW_MAX_CHARS } from "@highlights/events";
import {
  billableSummaryCalls,
  computeCostUsd,
  summaryCallsForRows,
} from "../src/job-settlement.js";

const GOOD_SUMMARY =
  "The equaliser levels it at 2-2 in the second half. A low drive from the edge of the box finds the far corner.";

const evidence = () => ({
  rail: "live" as const,
  verdict: "scoring_play",
  eventType: "goal",
  reason: "Scoreboard changes to 2-2 and the ball enters the net.",
  caption: "Ball enters the net at the near post.",
  postTitle: "GOAL · 2:38",
  windowTs: 158,
  windowDurationS: 12,
  scoreTransition: { from: "1-2", to: "2-2" },
  matchContext: { teams: [{ name: "Northbridge" }, { name: "Riverside" }] },
  transcript: "the equaliser, and it is level again",
});

function stubStore() {
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  const store: SummaryLaneStore = {
    async patchHighlightSummary(id, patch) {
      patches.push({ id, patch });
      return {};
    },
  };
  return { store, patches };
}

/** A fetch stub that answers each call from a queue. */
function stubFetch(answers: (Response | Error)[]) {
  let i = 0;
  const seen: any[] = [];
  const fn = (async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    const next = answers[Math.min(i, answers.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    // A Response body can be read once: hand each call its own copy so a retry
    // sees the same reply instead of a "body used" failure.
    return next.clone();
  }) as unknown as typeof fetch;
  return { fn, seen, calls: () => i };
}

const ok = (summary: string) =>
  new Response(JSON.stringify({ summary }), { status: 200, headers: { "content-type": "application/json" } });

const cfg = (over: Partial<Parameters<typeof runSummaryForRow>[1]> = {}) => ({
  decideUrl: "http://decide.test",
  decideFee: 0.01,
  ...over,
});

describe("runSummaryForRow — the promoted row's copy", () => {
  it("stores gated copy and its meter on ONE call", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok(GOOD_SUMMARY)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "j1",
      highlightId: "h1",
      evidence: evidence(),
    });
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].id).toBe("h1");
    expect(patches[0].patch).toMatchObject({ summary: GOOD_SUMMARY, summaryCalls: 1, summaryDropped: 0 });
    expect(patches[0].patch.summaryGate).toBe("accepted");
    // The prompt is composed server-side from the row's own evidence.
    expect(f.seen[0].prompt).toContain("Score transition: 1-2 -> 2-2");
    expect(f.seen[0].rail).toBe("live");
    expect(f.seen[0].maxWords).toBe(70);
  });

  it("retries ONE time on a transport failure, then stores", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([new Error("ECONNREFUSED"), ok(GOOD_SUMMARY)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "j1",
      highlightId: "h1",
      evidence: evidence(),
    });
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(2);
    expect(f.calls()).toBe(2);
    expect(patches[0].patch).toMatchObject({ summaryCalls: 2, summaryDropped: 0 });
  });

  it("drops after the second transport failure and never writes copy", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([new Error("ECONNREFUSED"), new Error("ECONNREFUSED")]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "j1",
      highlightId: "h1",
      evidence: evidence(),
    });
    expect(result.outcome).toBe("dropped");
    expect(result.reason).toBe("transport_failure");
    expect(result.calls).toBe(2);
    expect(patches[0].patch.summary).toBeUndefined();
    expect(patches[0].patch).toMatchObject({
      summaryCalls: 2,
      summaryDropped: 1,
      summaryDroppedByReason: { transport_failure: 1 },
    });
  });

  it("drops a TIMEOUT with its own cause and respects the single-retry bound", async () => {
    const { store, patches } = stubStore();
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const f = stubFetch([timeout, timeout]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "j1",
      highlightId: "h1",
      evidence: evidence(),
    });
    expect(result.reason).toBe("timeout");
    expect(result.calls).toBe(2);
    expect(result.calls).toBeLessThanOrEqual(2);
    expect(patches[0].patch.summaryDroppedByReason).toEqual({ timeout: 1 });
  });

  it("does not retry a PARSE failure (an empty reply is deterministic)", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([new Response(JSON.stringify({ summary: "" }), { status: 200 })]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "j1",
      highlightId: "h1",
      evidence: evidence(),
    });
    expect(result.reason).toBe("parse");
    expect(result.calls).toBe(1);
    expect(patches[0].patch.summaryDroppedByReason).toEqual({ parse: 1 });
  });

  it("drops a GATE refusal (too thin) with no copy and no placeholder", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok("It is 2-2.")]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "j1",
      highlightId: "h1",
      evidence: evidence(),
    });
    expect(result.outcome).toBe("dropped");
    expect(result.reason).toBe("gate");
    expect(patches[0].patch.summary).toBeUndefined();
    expect(patches[0].patch.summaryGate).toBe("dropped:gate");
    expect(patches[0].patch.summaryDroppedByReason).toEqual({ gate: 1 });
  });

  it("keeps the refused reply as `summaryRaw` on a gate drop (ADAAAA-8687)", async () => {
    const { store, patches } = stubStore();
    const reply = "It is 2-2.";
    const f = stubFetch([ok(reply)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "j1",
      highlightId: "h1",
      evidence: evidence(),
    });
    expect(result.reason).toBe("gate");
    // The model's own words are persisted (never served), so a QA can quote what
    // was refused instead of only the violation token.
    expect(patches[0].patch.summaryRaw).toBe(reply);
    expect(patches[0].patch.summary).toBeUndefined();
  });

  it("clips a runaway refused reply instead of storing it unbounded (ADAAAA-8687)", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok("It is 2-2. ".repeat(400))]);
    await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), { jobId: "j1", highlightId: "h1", evidence: evidence() });
    expect(typeof patches[0].patch.summaryRaw).toBe("string");
    expect((patches[0].patch.summaryRaw as string).length).toBeLessThanOrEqual(SUMMARY_RAW_MAX_CHARS);
  });

  it("stores copy for a shipped one-line caption shape instead of refusing it (ADAAAA-8687)", async () => {
    // The QA-B live-leg shapes: a 3-token announcer line, and a 2-token one.
    const cases: { caption: string; body: string }[] = [
      {
        caption: "Ball shoots in midfield",
        body:
          "The crowd erupts as the ball shoots through midfield in the opening exchanges. " +
          "A burst of noise near 2:38 marks the move that breaks forward again.",
      },
      {
        caption: "Scoreboard changes to 2-2.",
        body:
          "The scoreboard flips from 2-1 to 2-2 at 2:40 off a strike from the edge of the box. " +
          "The near post is beaten low and the crowd behind the net is up before the restart.",
      },
    ];
    for (const c of cases) {
      const stub = stubStore();
      const f = stubFetch([ok(c.body)]);
      const result = await runSummaryForRow(
        stub.store,
        cfg({ fetchImpl: f.fn }),
        {
          jobId: "j1",
          highlightId: "h1",
          evidence: { ...evidence(), caption: c.caption, reason: c.caption },
        }
      );
      expect({ caption: c.caption, outcome: result.outcome }).toEqual({ caption: c.caption, outcome: "stored" });
      expect(stub.patches[0].patch.summary).toBe(c.body);
      expect(stub.patches[0].patch.summaryDropped).toBe(0);
    }
  });

  it("retries a GATE refusal once and stores the second reply (ADAAAA-8687)", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok("It is 2-2."), ok(GOOD_SUMMARY)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "j1",
      highlightId: "h1",
      evidence: evidence(),
    });
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(2);
    expect(f.calls()).toBe(2);
    expect(patches[0].patch.summary).toBe(GOOD_SUMMARY);
    // R4 (spec rev 2) is metered on the stored row and never gates.
    expect(typeof patches[0].patch.summaryCaptionOverlap).toBe("number");
    expect(patches[0].patch.summaryCalls).toBe(2);
    expect(patches[0].patch.summaryDropped).toBe(0);
  });

  it("drops after TWO gate refusals and keeps the LAST refused reply as `summaryRaw` (ADAAAA-8687)", async () => {
    const { store, patches } = stubStore();
    const second = "The keeper claims the ball under pressure in midfield.";
    const f = stubFetch([ok("It is 2-2."), ok(second)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "j1",
      highlightId: "h1",
      evidence: evidence(),
    });
    expect(result.outcome).toBe("dropped");
    expect(result.reason).toBe("gate");
    expect(result.calls).toBe(2);
    expect(patches.length).toBe(1);
    expect(patches[0].patch.summary).toBeUndefined();
    expect(patches[0].patch.summaryRaw).toBe(second);
    expect(patches[0].patch.summaryDroppedByReason).toEqual({ gate: 1 });
  });

  it("drops `pool_busy` when no decide service is configured (never fabricates)", async () => {
    const { store, patches } = stubStore();
    const result = await runSummaryForRow(store, cfg({ decideUrl: undefined }), {
      jobId: "j1",
      highlightId: "h1",
      evidence: evidence(),
    });
    expect(result.reason).toBe("pool_busy");
    expect(result.calls).toBe(1);
    expect(patches[0].patch.summary).toBeUndefined();
    expect(patches[0].patch.summaryDroppedByReason).toEqual({ pool_busy: 1 });
  });

  it("uses the VOD depth band for the VOD rail", async () => {
    const { store } = stubStore();
    const f = stubFetch([ok(GOOD_SUMMARY)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "j1",
      highlightId: "h1",
      evidence: { ...evidence(), rail: "vod" },
    });
    // Two sentences clear the live band (2-3) and fail the VOD band (3-5).
    expect(result.reason).toBe("gate");
    expect(f.seen[0].maxWords).toBe(120);
  });
});

describe("Store.patchHighlightSummary — the `summaryRaw` contract (ADAAAA-8687)", () => {
  it("round-trips the refused reply through the row schema without touching `summary`", async () => {
    const { Store } = await import("../src/store.js");
    const { HighlightRecordSchema } = await import("@highlights/events");
    const row = HighlightRecordSchema.parse({
      id: "h-8687",
      jobId: "j-8687",
      clipUri: "/clips/shot.mp4",
      start: 8,
      end: 23,
      localizedTs: 15,
      localizeSignal: "peak_frame",
      clipWindowBeforeS: 7,
      clipWindowAfterS: 8,
      clipWindowSec: 15,
      eventType: "BIG_PLAY",
      score: 85,
      outcome: "big_play",
      corroborated: false,
      status: "accepted",
      caption: "Ball shoots in midfield",
      createdAt: "2026-11-11T15:04:26.000Z",
    });
    const store = new Store(null);
    await store.addHighlight(row);
    const next = await store.patchHighlightSummary("h-8687", {
      summaryGate: "dropped:gate",
      summaryCaptionOverlap: 0.67,
      summaryRaw: "Ball shoots in midfield and the crowd reacts around 0:12 at the ground.",
      summaryCalls: 1,
      summaryDropped: 1,
      summaryDroppedByReason: { gate: 1 },
      summaryP95Ms: 309,
    });
    expect(next.summaryRaw).toBe("Ball shoots in midfield and the crowd reacts around 0:12 at the ground.");
    expect(next.summary).toBeUndefined();
    expect(next.summaryGate).toBe("dropped:gate");
    expect(next.summaryCaptionOverlap).toBe(0.67);
    // The row is still a valid record after the write (schema parse is the seam's guard).
    expect(HighlightRecordSchema.parse(next).summaryRaw).toBe(next.summaryRaw);
  });
});

describe("SummaryLane — post-promotion, bounded, never blocking", () => {
  it("enqueue returns immediately and the drain stores the row", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok(GOOD_SUMMARY)]);
    const lane = new SummaryLane("j1", store, cfg({ fetchImpl: f.fn }));
    const accepted = lane.enqueue({ jobId: "j1", highlightId: "h1", evidence: evidence() });
    expect(accepted).toBe(true);
    await lane.idle();
    expect(patches[0].patch.summary).toBe(GOOD_SUMMARY);
    expect(lane.snapshot()).toMatchObject({ summaryCalls: 1, summaryDropped: 0 });
    expect(lane.snapshot().summaryP95Ms).toBeGreaterThanOrEqual(0);
  });

  it("is inert (and meters the drop) when the lane is not configured", async () => {
    const { store, patches } = stubStore();
    const lane = new SummaryLane("j1", store, cfg({ decideUrl: undefined }));
    expect(lane.enqueue({ jobId: "j1", highlightId: "h1", evidence: evidence() })).toBe(false);
    await lane.idle();
    // No row write is spent on a kill-switched lane: the card just keeps today's shape.
    expect(patches).toHaveLength(0);
    expect(lane.snapshot()).toMatchObject({ summaryCalls: 0, summaryDropped: 1 });
    expect(lane.snapshot().summaryDroppedByReason).toEqual({ pool_busy: 1 });
  });

  it("bounds the pending ring and drops the overflow as pool_busy", async () => {
    const { store, patches } = stubStore();
    // A fetch that never resolves: the lane stays busy while we enqueue.
    const f = (() => new Promise(() => {})) as unknown as typeof fetch;
    const lane = new SummaryLane("j1", store, cfg({ fetchImpl: f }));
    const results: boolean[] = [];
    // One row holds the single in-flight slot; the ring holds the rest.
    for (let i = 0; i < SUMMARY_LANE_PENDING_RING + 2; i++) {
      results.push(lane.enqueue({ jobId: "j1", highlightId: `h${i}`, evidence: evidence() }));
    }
    expect(results.filter(Boolean)).toHaveLength(SUMMARY_LANE_PENDING_RING + 1);
    expect(results[results.length - 1]).toBe(false);
    expect(lane.enqueueDrops).toBe(1);
    // The overflowed row is metered, not silently forgotten.
    await new Promise((r) => setTimeout(r, 10));
    expect(patches.some((p) => p.id === `h${SUMMARY_LANE_PENDING_RING + 1}`)).toBe(true);
  });

  it("reports p95 of the measured generation latencies", () => {
    expect(summaryP95([])).toBe(0);
    expect(summaryP95([100])).toBe(100);
    expect(summaryP95([100, 200, 300, 400])).toBe(400);
  });
});

describe("fee and meter identity", () => {
  it("bills the summary as its own term inside the 1.5x ceiling", () => {
    expect(summaryFeeFor({ decideFee: 0.01 })).toBeCloseTo(0.015, 6);
    // decide 10 + confirm 0 + 4 summary calls @ 0.01
    expect(computeCostUsd(10, 0, 0.01, 0, 4)).toBeCloseTo(0.1 + 0.06, 6);
    // An operator override above the ceiling is clamped, never billed.
    expect(computeCostUsd(0, 0, 0.01, 0, 4, 1)).toBeCloseTo(0.06, 6);
    // A pre-8668 caller (4 positional args) keeps its exact price.
    expect(computeCostUsd(10, 3600, 0.01, 2)).toBeCloseTo(0.12 + 0.01, 6);
  });

  it("reads the billed count from the rows the lane wrote", () => {
    expect(summaryCallsForRows([{ summaryCalls: 2 }, { summaryCalls: 0 }, {}])).toBe(2);
    expect(summaryCallsForRows([])).toBe(0);
    expect(billableSummaryCalls(undefined, 3)).toBe(3);
    expect(billableSummaryCalls({ summaryCalls: 1 } as any, 5)).toBe(1);
    expect(billableSummaryCalls(undefined)).toBe(0);
  });
});

describe("summaryEvidenceForRow", () => {
  it("maps a stored row to the contract's evidence without inventing anything", () => {
    const ev = summaryEvidenceForRow(
      {
        verdict: "scoring_play",
        eventType: "goal",
        reason: "ball enters the net",
        caption: "Ball enters the net.",
        postTitle: "GOAL · 2:38",
        trigger: { timestamp: 158, durationS: 12 },
        deferredAttestation: { scoreboardDelta: { from: "1-2", to: "2-2" } },
        asrTranscript: "il gol",
        matchContext: { teams: ["A", "B"] },
      },
      "live",
      "A had scored the opener on 12:04."
    );
    expect(ev).toMatchObject({
      rail: "live",
      verdict: "scoring_play",
      windowTs: 158,
      windowDurationS: 12,
      scoreTransition: { from: "1-2", to: "2-2" },
      transcript: "il gol",
      adjacentScoreCue: "A had scored the opener on 12:04.",
    });
  });

  it("leaves an unmeasured transition absent instead of guessing", () => {
    const ev = summaryEvidenceForRow({ start: 40, end: 52 }, "vod");
    expect(ev.scoreTransition).toBeNull();
    expect(ev.windowTs).toBe(40);
    expect(ev.windowDurationS).toBe(12);
  });
});

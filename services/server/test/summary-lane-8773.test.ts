// ADAAAA-8773: a `too-few-facts` refusal is DETERMINISTIC, so the lane must not
// spend its retry slot on it. Measured on job `70400b1d`: both promoted rows ran
// 2 summary calls, were refused `too-few-facts` on both samples, and the row fee
// came out at 0.0099 = 2.0x DECIDE_FEE — over the AC5 envelope of the CEO ruling
// on ADAAAA-8737 ("<= 1.5x DECIDE_FEE per row / <= 1 extra inference per promoted
// row"). The prompt-side fix (the clip offset is the only clock the model is
// handed) removes the cause; this test pins the cost bound that must hold even if
// a future reply still misses the fact bar.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_FEE_RATIO,
  type SummaryEvidence,
} from "@highlights/events";
import { runSummaryForRow, summaryFeeFor, type SummaryLaneStore } from "../src/summary-lane.js";

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

function stubFetch(answers: Response[]) {
  let i = 0;
  const fn = (async () => {
    const next = answers[Math.min(i, answers.length - 1)];
    i++;
    return next.clone();
  }) as unknown as typeof fetch;
  return { fn, calls: () => i };
}

const ok = (summary: string) =>
  new Response(JSON.stringify({ summary }), { status: 200, headers: { "content-type": "application/json" } });

/** Row `5f32f6f4`'s evidence at generation time, and the body the served build's
 *  prompt actually produced: a match clock that earns no `clock` kind. */
const EVIDENCE: SummaryEvidence = {
  rail: "vod",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason: "The visual evidence shows the ball entering the net at t=18:02.",
  caption: null,
  postTitle: null,
  windowTs: 24,
  windowDurationS: 15,
  scoreTransition: null,
  matchContext: { teams: [{ name: "Barcelona" }] },
  transcript:
    "Es Carlos Javier quien la pisa, Carlos Javier quien intenta progresar por la banda izquierda, el centro para Ordoñez, el remate gol. Acaba de marcar el Real Madrid, acaba de marcar Manuel Ordoñez, Manu, en el minuto.",
};

const CLOCK_ANCHORED_MATCH_CLOCK =
  "Manuel Ordoñez finds the back of the net for Real Madrid to secure the scoring play. The goal occurs at the 18:02 mark following a cross into the box. After the ball enters the net, the player in the blue kit celebrates the successful strike.";

const cfg = (over: Record<string, unknown> = {}) => ({
  decideUrl: "http://decide.test",
  decideFee: 0.0033,
  ...over,
});

describe("ADAAAA-8773 — deterministic refusal ends the row on ONE call", () => {
  it("bills one call on `too-few-facts` and keeps the row fee inside the AC5 ceiling", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok(CLOCK_ANCHORED_MATCH_CLOCK)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }) as any, {
      jobId: "70400b1d",
      highlightId: "5f32f6f4",
      evidence: EVIDENCE,
    });

    expect(result.outcome).toBe("dropped");
    expect(result.reason).toBe("gate");
    expect(result.calls).toBe(1);
    expect(f.calls()).toBe(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].patch).toMatchObject({ summaryCalls: 1, summaryDropped: 1 });
    expect(patches[0].patch.summaryDroppedByReason).toEqual({ gate: 1 });
    // No copy, and the refused reply stays replayable.
    expect(patches[0].patch.summary).toBeUndefined();
    expect(patches[0].patch.summaryRaw).toBe(CLOCK_ANCHORED_MATCH_CLOCK);
    // The fee is per ROW: one call at the 1.5x ceiling, not 2.0x DECIDE_FEE.
    const rowFee = summaryFeeFor({ decideFee: 0.0033, summaryFee: null }) * result.calls;
    expect(rowFee).toBeCloseTo(0.0033 * SUMMARY_FEE_RATIO, 6);
    expect(rowFee).toBeLessThan(0.0033 * 2);
  });

  it("keeps the retry slot for a NON-deterministic refusal", async () => {
    // A shape refusal (`too-few-sentences`) is a property of ONE sampled reply —
    // the ADAAAA-8687 rationale — so the row may spend its second call there.
    // The fixture carries two credited kinds so `too-few-facts` is NOT the cause.
    const { store, patches } = stubStore();
    const f = stubFetch([
      ok("At 0:24 Manuel Ordoñez scores for Real Madrid."),
      ok(CLOCK_ANCHORED_MATCH_CLOCK),
    ]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }) as any, {
      jobId: "j1",
      highlightId: "h1",
      evidence: EVIDENCE,
    });
    expect(result.calls).toBe(2);
    expect(f.calls()).toBe(2);
    // The second reply is still refused (`too-few-facts` on the match clock), so
    // the row drops — but the retry it was allowed was spent.
    expect(patches[0].patch.summaryDropped).toBe(1);
  });

  it("still accepts a body written on the clip offset (one call, copy stored)", async () => {
    const { store, patches } = stubStore();
    const body = CLOCK_ANCHORED_MATCH_CLOCK.replace("at the 18:02 mark", "at the 0:24 mark");
    const f = stubFetch([ok(body)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }) as any, {
      jobId: "70400b1d",
      highlightId: "5f32f6f4",
      evidence: EVIDENCE,
    });
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(1);
    expect(patches[0].patch.summary).toBe(body);
    expect(patches[0].patch.summaryGate).toBe("accepted");
  });
});

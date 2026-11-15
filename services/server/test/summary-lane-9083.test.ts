// ADAAAA-9083 — AC15 at the LANE: a frame-narration lead is stripped before the
// depth floor is re-checked, and the repair order (AC14/AC5) is unchanged.
//
// The row is the rev-8 VOD fixture the 8984 suite uses (no attestation at all, so
// no claim refusal can fire and the drop name is unambiguous): a `2-1 -> 2-2`
// scoreboard delta, a 1:24 clip offset, Barcelona + Real Madrid in the context.
import { describe, expect, it } from "vitest";
import { gateSummaryDetail, hasFrameOpener, SUMMARY_VOD_BAND } from "@highlights/events";
import {
  runSummaryForRow,
  summaryDropReasonName,
  summaryEvidenceForRow,
  type SummaryLaneConfig,
  type SummaryLaneStore,
} from "../src/summary-lane.js";

const ROW = {
  id: "532204a9",
  eventType: "GOAL",
  outcome: "scoring_play",
  start: 84,
  end: 99,
  caption: "Goal at 1:24.",
  postTitle: "GOAL · 1:24",
  trigger: { timestamp: 84, durationS: 15 },
  matchClock: undefined,
  attestationUsed: null,
  reason: "The scoreboard changes from 2-1 to 2-2 at 22:13, confirmed by the commentary eruption.",
  deferredAttestation: { scoreboardDelta: { from: "2-1", to: "2-2" } },
  matchContext: {
    sport: "soccer",
    teams: [
      { name: "Barcelona", side: "away", kitColors: [], confidence: 0.5 },
      { name: "Real Madrid", side: "home", kitColors: [], confidence: 0.5 },
    ],
    ambiguous: false,
  },
};

const evidence = () => summaryEvidenceForRow(ROW as any, "vod");

/** The served-shape draft: 43 words, every sentence carries the score line or the
 *  clip offset, and it opens on the frame. */
const FRAMED_SERVING =
  "The scene opens with the scoreboard move from 2-1 to 2-2 at 1:24 into the clip. Barcelona carry the 2-2 scoreboard at 1:24. Real Madrid answer inside the same 1:24 window with the 2-2 scoreboard. Barcelona 2-2 Real Madrid is the scoreboard the window records at 1:24.";

/** The same lead on a draft that lands under the 40-word floor once the lead goes. */
const FRAMED_SHORT =
  "The clip shows the scoreboard move from 2-1 to 2-2 at 1:24 into the clip. Barcelona carry the 2-2 scoreboard at 1:24.";

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

/** Answers every sample with the next body (the last one repeats) and keeps the
 *  prompts the lane actually sent. */
function stubFetch(summaries: string[]) {
  const prompts: string[] = [];
  let i = 0;
  const fn = (async (_url: string, init: any) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
    if (body.prompt) prompts.push(body.prompt);
    const summary = summaries[Math.min(i, summaries.length - 1)];
    i += 1;
    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, prompts, calls: () => i };
}

const cfg = (over: Record<string, unknown> = {}) =>
  ({ decideUrl: "http://decide.test", decideFee: 0.0033, ...over }) as SummaryLaneConfig;

describe("ADAAAA-9083 (AC3) — the lane stores the STRIPPED body", () => {
  it("serves a frame-lead draft with its lead deleted, on ONE call", async () => {
    const f = stubFetch([FRAMED_SERVING]);
    const { store, patches } = stubStore();
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "90830001",
      highlightId: ROW.id,
      evidence: evidence(),
    });

    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(1);
    const served = patches[0].patch.summary as string;
    // AC15's served bar: 0 bodies open on the frame.
    expect(hasFrameOpener(served)).toBe(false);
    expect(served.startsWith("The scoreboard move from 2-1 to 2-2")).toBe(true);
    // The strip is visible in the audit trail, not silently applied.
    expect(patches[0].patch.summaryGate).toBe("neutralised");
    // Prompt-first: the rule rode the first pass.
    expect(f.prompts[0]).toContain("Never open on the frame");
  });
});

describe("ADAAAA-9083 (AC4) — the repair order is unchanged", () => {
  it("regenerates ONCE for a stripped body under the floor, then drops as `filler`", async () => {
    const decision = gateSummaryDetail(FRAMED_SHORT, evidence());
    // The premise: the lead is gone, the remainder is under the floor, and the
    // strip is what took it there.
    expect(decision.summary).toBeNull();
    expect(decision.frameOpeners).toEqual(["The clip shows"]);
    expect(decision.repairedWords).toBeLessThan(SUMMARY_VOD_BAND.floorWords);
    expect(summaryDropReasonName(decision, evidence())).toBe("filler");

    const f = stubFetch([FRAMED_SHORT, FRAMED_SHORT]);
    const { store, patches } = stubStore();
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "90830002",
      highlightId: ROW.id,
      evidence: evidence(),
    });

    // ONE regeneration — the existing AC5 slot, no new retry class.
    expect(result.outcome).toBe("dropped");
    expect(result.reason).toBe("filler");
    expect(result.calls).toBe(2);
    expect(f.calls()).toBe(2);
    // The second sample is TOLD the deleted lead and the rule, so it is not the
    // same prompt re-sampled.
    expect(f.prompts[1]).toContain("RETRY:");
    expect(f.prompts[1]).toContain("Never open on the frame");
    // The row keeps the named reason (AC4), never a new drop class.
    expect(patches[0].patch.summaryGate).toBe("dropped:filler");
    expect(patches[0].patch.summaryDroppedByReason).toEqual({ filler: 1 });
    expect(patches[0].patch.summary).toBeUndefined();
  });

  it("does not spend a second call when the stripped body still serves", async () => {
    const f = stubFetch([FRAMED_SERVING]);
    const { store } = stubStore();
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "90830003",
      highlightId: ROW.id,
      evidence: evidence(),
    });
    expect(result.calls).toBe(1);
    expect(f.calls()).toBe(1);
    expect(result.outcome).toBe("stored");
  });
});

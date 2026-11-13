// ADAAAA-8968 (AC5) — the retry LANE: the second sample is told the shortfall,
// and a row that cannot clear the floor in two samples drops ONCE, at two calls.
//
// The rev-8 grade measured 25 calls / 13 rows = 1.92 and 9 of 9 retried rows
// still dropped. Two rules are pinned here:
//
//   * the directive handed to sample 2 carries the MEASURED shortfall, the
//     deleted-clause list and the row's fact menu, so the second sample can
//     satisfy the floor instead of re-generating the refused prose;
//   * `SUMMARY_MAX_CALLS_PER_ROW` is the hard bound: a row that fails both
//     samples writes `summaryCalls` 2 and ONE `summaryDroppedByReason` entry and
//     is never billed a third call.
import { describe, expect, it } from "vitest";
import { SUMMARY_MAX_CALLS_PER_ROW, SUMMARY_VOD_BAND } from "@highlights/events";
import {
  runSummaryForRow,
  summaryEvidenceForRow,
  type SummaryLaneConfig,
  type SummaryLaneStore,
} from "../src/summary-lane.js";

const MATCH_CONTEXT = {
  sport: "soccer",
  teams: [
    { name: "Barcelona", side: "away", kitColors: [], confidence: 0.5 },
    { name: "Real Madrid", side: "home", kitColors: [], confidence: 0.5 },
  ],
  ambiguous: false,
};

/** VOD row `532204a9`: GOAL 2-1 -> 2-2, clip offset 1:24, no persisted reading. */
const ROW_5322 = {
  id: "532204a9",
  eventType: "GOAL",
  outcome: "scoring_play",
  start: 84,
  end: 99,
  caption: "Goal at 1:24.",
  postTitle: "GOAL · 1:24",
  trigger: { timestamp: 84, durationS: 15 },
  matchClock: undefined,
  attestationUsed: { scoreBoardChanged: true, goalCrossed: false, ballOutcome: null },
  reason: "The scoreboard changes from 2-1 to 2-2 at 22:13, confirmed by the commentary eruption.",
  deferredAttestation: { scoreboardDelta: { from: "2-1", to: "2-2" } },
};

const evidenceFor = (row: Record<string, unknown>, rail: "live" | "vod") =>
  summaryEvidenceForRow({ ...(row as any), matchContext: MATCH_CONTEXT }, rail, null);

/** The rev-8 filler draft: possession/pressure prose and atmosphere claims, all
 *  of which the clause repair deletes, which takes it under the 40-word floor. */
const FILLER_VOD =
  "Barcelona finds the equalizer to level the score at 2-2. The crowd erupts in celebration as the team secures a vital point in this intense match. This scoring play shifts the momentum during the game. The atmosphere in the stadium is electric following this dramatic turn of events.";

/** A second sample that satisfies the floor with attested facts only. */
const FACT_BODY_VOD =
  "Barcelona is in the sequence as the scoreboard moves from 2-1 to 2-2 at 1:24. The scoreboard moves to 2-2 during this sequence. This play occurs at 1:24 into the clip. The scoreboard moves from 2-1 to 2-2 at 1:24 into the clip.";

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

/** Records each reply WITH the prompt it answered. */
function stubFetch(summaries: string[]) {
  const prompts: string[] = [];
  let i = 0;
  const fn = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    prompts.push(body.prompt);
    const summary = summaries[Math.min(i, summaries.length - 1)];
    i++;
    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, prompts, calls: () => i };
}

const cfg = (over: Record<string, unknown> = {}) =>
  ({ decideUrl: "http://decide.test", decideFee: 0.0033, ...over }) as SummaryLaneConfig;

describe("ADAAAA-8968 AC5 — the retry lane carries the measured shortfall", () => {
  it("hands sample 2 the shortfall, the deleted clauses and the fact menu", async () => {
    const f = stubFetch([FILLER_VOD, FACT_BODY_VOD]);
    const { store, patches } = stubStore();
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "8f0d1c56",
      highlightId: ROW_5322.id,
      evidence: evidenceFor(ROW_5322, "vod"),
    });

    expect(f.calls()).toBe(2);
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(2);
    // Sample 2 was told the MEASURED shortfall as a number of words.
    expect(f.prompts[1]).toContain("RETRY: the previous draft measured");
    expect(f.prompts[1]).toMatch(/that draft measured \d+ words short of the 40-word floor/);
    // ...and what the repair deleted, and what may replace it.
    expect(f.prompts[1]).toContain("were DELETED from that draft because they carry no attested fact");
    expect(f.prompts[1]).toContain("Expand with facts, not filler");
    // The acceptance bar did not move: the retry still asks 45 words (40 + 5).
    expect(f.prompts[1]).toContain("this copy must reach at least 45 words");
    expect(SUMMARY_VOD_BAND.floorWords).toBe(40);
    // One write, the meter on both calls.
    expect(patches).toHaveLength(1);
    expect(patches[0].patch).toMatchObject({ summaryCalls: 2, summaryDropped: 0 });
    expect(patches[0].patch.summary).toBeTruthy();
  });

  it("drops ONCE at two calls when neither sample clears the floor — never a third call", async () => {
    const f = stubFetch([FILLER_VOD, FILLER_VOD, FACT_BODY_VOD]);
    const { store, patches } = stubStore();
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "8f0d1c56",
      highlightId: ROW_5322.id,
      evidence: evidenceFor(ROW_5322, "vod"),
    });

    expect(SUMMARY_MAX_CALLS_PER_ROW).toBe(2);
    expect(f.calls()).toBe(2);
    expect(result.outcome).toBe("dropped");
    expect(result.calls).toBe(2);
    expect(patches).toHaveLength(1);
    expect(patches[0].patch).toMatchObject({ summaryCalls: 2, summaryDropped: 1 });
    // The drop names its cause ONCE, and no body is stored.
    const byReason = patches[0].patch.summaryDroppedByReason as Record<string, number>;
    expect(Object.values(byReason)).toEqual([1]);
    expect(["filler", "gate"]).toContain(Object.keys(byReason)[0]);
    expect(patches[0].patch.summary).toBeUndefined();
    // The §15.4 instruments ride the drop so a grade can attribute the miss.
    expect(patches[0].patch.summaryViolations).toBeTruthy();
    expect(patches[0].patch.summaryRepairedWords).toBeLessThan(SUMMARY_VOD_BAND.floorWords);
    expect(patches[0].patch.summaryDroppedClauses).toBeGreaterThan(0);
  });
});

// ADAAAA-8984 — the drop TAXONOMY order: a CLAIM refusal that no repair can
// clear outranks the word shortfall.
//
// The rev-9 $0 gate ([ADAAAA-8938]) missed requirement (b) by one row: stored row
// `3cdf3fdd` was recorded `dropped:filler` with `summaryRepairedWords` 38 against
// the 40-word floor, although its real blocker is `unattested-action` on a row
// whose own attestation records NO ball outcome (`summaryBallActionAttested ===
// false`). `summary-lane.ts` tested the word shortfall before the claim
// violations, so every evidence-limited refusal on a short row read as a DEPTH
// failure and pointed the next census round at the wrong defect.
//
// The three pins here:
//   1. the taxonomy puts the claim violation before the shortfall — the row is
//      unrepairable whatever its word count;
//   2. the lane names that drop `gate` (never `filler`) and bills ONE call, the
//      deterministic-refusal contract;
//   3. `filler` is still reachable for the class the definition names: a clause
//      repair that leaves the body short with NO unrepairable claim in it.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_VOD_BAND,
  gateSummaryDetail,
  summaryBallActionAttested,
  summaryRefusalIsRepairable,
} from "@highlights/events";
import {
  runSummaryForRow,
  summaryEvidenceForRow,
  type SummaryLaneConfig,
  type SummaryLaneStore,
} from "../src/summary-lane.js";

/** Stored rev-8 VOD row `3cdf3fdd`: GOAL, `ballOutcome: null`, `goalCrossed:
 *  false`, `scoreBoardChanged: false`, no persisted match clock, ASR names
 *  Carlos Javier / Manuel Ordoñez. Copied field-for-field from the replay dump
 *  (`evals/adaaa_8934/rows-rev8.json`) so the fixture and the $0 gate measure the
 *  same row. */
const ROW_3CDF = {
  id: "3cdf3fdd",
  eventType: "GOAL",
  outcome: "scoring_play",
  reason:
    "The ASR confirms a goal ('el remate gol') and the visual evidence shows the ball entering the net at t=18:02, followed by a celebration and a referee's signal.; rejected by contract guard: the accept's support is commentary text only (reason_cites_commentary) and no measured channel attests the goal (absent: ballOutcome, goalCrossed, scoreBoardChanged, perceiveTimeline); the text claims a score line but no scoreboard read / score_delta record carries it; confirmation pass: goal confirmed (deep frame dive); The visual evidence shows the ball entering the net at t=21.00, followed by a referee's signal and a celebration. The ASR also confirms the goal ('el remate gol').",
  caption: null,
  postTitle: null,
  trigger: { timestamp: 24 },
  start: 17,
  end: 32,
  matchClock: null,
  deferredAttestation: null,
  attestationUsed: {
    authority: "frame",
    ballOutcome: null,
    goalCrossed: false,
    scoreBoardChanged: false,
    goalConfirmed: "confirmed_goal",
  },
  asrTranscript:
    "Es Carlos Javier quien la pisa.  Carlos Javier quien intenta progresar por la banda izquierda.  Sigue Carlos Javier.  El centro para Ordoñez, el remate gol.  Acaba de marcar el Real Madrid.  Acaba de marcar Manuel Ordoñez.  Manú, en el minuto.",
  matchContext: {
    sport: "soccer",
    teams: [
      {
        name: "Barcelona",
        side: "away",
        evidence: [{ source: "scorebug_ocr", snippet: "22:17 |RMA 2-2 BAR" }],
        kitColors: [],
        confidence: 0.85,
      },
    ],
    ambiguous: false,
  },
};

/** The stored draft the gate refused on rev-8 AND rev-9 (41 words -> 38 after the
 *  clause repair, floor 40). */
const DRAFT_3CDF =
  "Manuel Ordoñez scores for Real Madrid as the ball enters the net at 0:24 into the clip. The ASR confirms the goal after a play involving Carlos Javier. Real Madrid continues to work the ball forward to create this scoring opportunity.";

/** A row with NO attestation at all (legacy VOD): `summaryBallActionAttested` is
 *  null, so no claim refusal can fire and `filler` stays reachable. */
const ROW_NO_ATTEST = {
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

/** The rev-8 filler draft: possession/pressure prose and atmosphere claims, all
 *  deleted by the clause repair, which takes it under the 40-word floor. */
const FILLER_VOD =
  "Barcelona finds the equalizer to level the score at 2-2. The crowd erupts in celebration as the team secures a vital point in this intense match. This scoring play shifts the momentum during the game. The atmosphere in the stadium is electric following this dramatic turn of events.";

const evidenceFor = (row: Record<string, unknown>) => summaryEvidenceForRow(row as any, "vod");

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

/** Answers every sample with the next body (the last one repeats). */
function stubFetch(summaries: string[]) {
  let i = 0;
  const fn = (async (_url: string, _init: any) => {
    const summary = summaries[Math.min(i, summaries.length - 1)];
    i += 1;
    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls: () => i };
}

const cfg = (over: Record<string, unknown> = {}) =>
  ({ decideUrl: "http://decide.test", decideFee: 0.0033, ...over }) as SummaryLaneConfig;

describe("ADAAAA-8984 — the claim refusal outranks the word shortfall", () => {
  it("classifies the stored 3cdf3fdd refusal as a CLAIM defect, not a depth one", () => {
    const evidence = evidenceFor(ROW_3CDF);
    const decision = gateSummaryDetail(DRAFT_3CDF, evidence);

    // The premise the fix rests on: the row measures NO ball outcome, so every
    // ball-outcome assertion in a body is unattested for good.
    expect(summaryBallActionAttested(evidence)).toBe(false);
    expect(decision.violations).toContain("unattested-action");
    // ...and the naive depth reading IS available: the repair deleted clauses and
    // landed under the floor. That is exactly why the order matters.
    expect(decision.droppedClauses.length).toBeGreaterThan(0);
    expect(decision.repairedWords).toBeLessThan(SUMMARY_VOD_BAND.floorWords); // 38 < 40
    expect(decision.violations).toContain("too-few-words");

    // The taxonomy: depth is repairable, the claim is not. Claim first.
    expect(summaryRefusalIsRepairable("too-few-words", evidence)).toBe(true);
    expect(summaryRefusalIsRepairable("unattested-action", evidence)).toBe(false);
  });

  it("names the lane's drop `gate` — never `filler` — and bills ONE call", async () => {
    const f = stubFetch([DRAFT_3CDF, DRAFT_3CDF]);
    const { store, patches } = stubStore();
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "98717871",
      highlightId: ROW_3CDF.id,
      evidence: evidenceFor(ROW_3CDF),
    });

    expect(result.outcome).toBe("dropped");
    // A deterministic refusal ends the row on ONE call: the same prompt cannot
    // change the row's attestation.
    expect(result.calls).toBe(1);
    expect(f.calls()).toBe(1);
    expect(patches).toHaveLength(1);
    const patch = patches[0].patch;
    expect(patch.summaryGate).toBe("dropped:gate");
    expect(patch.summaryDroppedByReason).toEqual({ gate: 1 });
    expect(Object.keys(patch.summaryDroppedByReason as Record<string, number>)).not.toContain("filler");
    // The violation list rides the row so the census can attribute the miss.
    expect(patch.summaryViolations).toContain("unattested-action");
    expect(patch.summaryRepairedWords).toBeLessThan(SUMMARY_VOD_BAND.floorWords);
    expect(patch.summary).toBeUndefined();
  });

  it("keeps `filler` reachable for a short clause-repaired body with no unrepairable claim", async () => {
    const evidence = evidenceFor(ROW_NO_ATTEST);
    const decision = gateSummaryDetail(FILLER_VOD, evidence);
    // No claim refusal: the row carries no attestation, so nothing is "unattested".
    expect(decision.violations).not.toContain("unattested-action");
    expect(decision.violations.every((v) => summaryRefusalIsRepairable(v, evidence))).toBe(true);
    expect(decision.droppedClauses.length).toBeGreaterThan(0);
    expect(decision.repairedWords).toBeLessThan(SUMMARY_VOD_BAND.floorWords);

    const f = stubFetch([FILLER_VOD, FILLER_VOD, FILLER_VOD]);
    const { store, patches } = stubStore();
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "8f0d1c56",
      highlightId: ROW_NO_ATTEST.id,
      evidence,
    });

    // A genuine filler refusal still earns the retry slot (2 calls) and still
    // carries the depth name, which is what makes the label diagnostic.
    expect(result.outcome).toBe("dropped");
    expect(result.calls).toBe(2);
    expect(patches[0].patch.summaryGate).toBe("dropped:filler");
    expect(patches[0].patch.summaryDroppedByReason).toEqual({ filler: 1 });
  });
});

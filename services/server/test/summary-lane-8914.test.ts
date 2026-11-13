// ADAAAA-8914 (AC14) — the `summary` LANE's side of the filler-depth bar.
//
// The gate owns the sentence-level rules (`packages/events/test/filler-depth-8914
// .test.ts`); the lane owns the two things only it can see:
//
//   * AC14.3 — the job's OTHER bodies. The rev-7 live leg served the same sentence
//     template on all three cards at 0.965-0.982 similarity because the lane's
//     only anti-repeat bar compared the first four words. The lane now carries the
//     job's served sentences, asks the prompt for a different sentence, regenerates
//     ONCE and drops `repeat` if the second sample repeats too;
//   * AC14.5 — the DROP REASON. A reply the clause repair empties under the floor
//     is dropped as `filler` (not the aggregate `gate`), with the deleted clauses,
//     the vocabulary that caused them and the surviving word count on the row
//     (§15.4 fields), and the row still bills at most two calls.
import { describe, expect, it } from "vitest";
import { SUMMARY_FEE_RATIO, SUMMARY_VOD_BAND } from "@highlights/events";
import {
  newSummaryJobState,
  runSummaryForRow,
  summaryEvidenceForRow,
  summaryFeeFor,
  type SummaryLaneConfig,
  type SummaryLaneStore,
} from "../src/summary-lane.js";

/** The live job's persisted `matchContext` (keys: sport/teams/trail/ambiguous). */
const MATCH_CONTEXT = {
  sport: "soccer",
  teams: [{ name: "Barcelona", side: "away", kitColors: [], confidence: 0.5 }],
  ambiguous: true,
  inferredAt: "2026-11-13T06:12:29.808402Z",
  resolverVersion: 1,
  trail: [
    { at: "2026-11-13T06:08:30.057Z", names: [{ name: "Barcelona", side: "away", confidence: 0.5 }] },
    { at: "2026-11-13T06:09:32.884Z", names: [{ name: "Real Madrid", side: "home", confidence: 0.5 }] },
  ],
};

/** Live row `aed6c4a4`: GOAL 1-1 -> 2-1, window 95.67 s, match clock 18:13. */
const ROW_AED6 = {
  id: "aed6c4a4",
  eventType: "GOAL",
  outcome: "scoring_play",
  start: 95.67,
  end: 110.67,
  caption: "Scoreboard changes to 2-1.",
  postTitle: null,
  trigger: { timestamp: 95.67, durationS: 15 },
  matchClock: { token: "18:13", seconds: 1093, shape: "mm:ss", period: null, legible: true, ts: 102.67 },
  attestationUsed: { scoreBoardChanged: true, goalCrossed: false, ballOutcome: null },
  reason: "Scoreboard changes from 1-1 to 2-1 at t=0.0s; scoreboard score change confirmed",
};

/** Live row `dc96ed06`: GOAL 2-1 -> 2-2, window 155.003 s, match clock 22:19. */
const ROW_DC96 = {
  ...ROW_AED6,
  id: "dc96ed06",
  start: 155.003,
  end: 170.003,
  trigger: { timestamp: 155.003, durationS: 15 },
  caption: "Scoreboard changes to 2-2.",
  matchClock: { token: "22:19", seconds: 1339, shape: "mm:ss", period: null, legible: true, ts: 162.003 },
  reason: "Scoreboard changes from 2-1 to 2-2 at t=-4.9s; scoreboard score change confirmed",
  deferredAttestation: { scoreboardDelta: { from: "2-1", to: "2-2" } },
};

/** VOD row `532204a9`: GOAL 2-1 -> 2-2, clip offset 1:24, NO persisted reading. */
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

// ADAAAA-8934: the second fact is a BOUNDED act by a named attested actor. The
// rev-8 shape ("keeps possession … works the ball forward") is a sustained STATE
// that no channel on this row measures, so the gate now deletes it instead of
// crediting it as an action fact.
const FACT_BODY_AED6 =
  "The scoreboard moves to 2-1 at the 1:35 mark of this clip. Real Madrid intercepts the ball near the box at the 1:35 mark of this clip.";

const FILLER_VOD =
  "Barcelona finds the equalizer to level the score at 2-2. The crowd erupts in celebration as the team secures a vital point in this intense match. This scoring play shifts the momentum during the game. The atmosphere in the stadium is electric following this dramatic turn of events.";

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

/** Every reply is recorded WITH the prompt it answered, so the prompt-first rules
 *  are asserted on what the lane actually sent. */
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

// ---------------------------------------------------------------------------
// AC14.4 — the row's attested match clock reaches the prompt.
// ---------------------------------------------------------------------------
describe("ADAAAA-8914 AC14.4 — the attested match clock is offered, and only it", () => {
  it("carries the row's matchClock token into the evidence and the prompt", () => {
    const evidence = evidenceFor(ROW_AED6, "live");
    expect(evidence.matchClock).toMatchObject({ token: "18:13", seconds: 1093, legible: true });
    const f = stubFetch([FACT_BODY_AED6]);
    return runSummaryForRow(stubStore().store, cfg({ fetchImpl: f.fn }), {
      jobId: "9bed3bd7",
      highlightId: ROW_AED6.id,
      evidence,
    }).then(() => {
      expect(f.prompts[0]).toContain("The row's attested MATCH clock is 18:13.");
    });
  });

  it("offers no match clock on a row that persists none", () => {
    const evidence = evidenceFor(ROW_5322, "vod");
    expect(evidence.matchClock).toBeNull();
    const f = stubFetch([FILLER_VOD]);
    return runSummaryForRow(stubStore().store, cfg({ fetchImpl: f.fn }), {
      jobId: "796e202d",
      highlightId: ROW_5322.id,
      evidence,
    }).then(() => {
      expect(f.prompts[0]).not.toContain("attested MATCH clock");
    });
  });
});

// ---------------------------------------------------------------------------
// AC14.3 — the job's served sentences are prompt-first, then a job-scoped bar.
// ---------------------------------------------------------------------------
describe("ADAAAA-8914 AC14.3 — one job may not serve the same sentence twice", () => {
  it("shows the job's served sentences on the next row's prompt", async () => {
    const state = newSummaryJobState();
    const first = stubFetch([FACT_BODY_AED6]);
    const stored = await runSummaryForRow(
      stubStore().store,
      cfg({ fetchImpl: first.fn }),
      { jobId: "9bed3bd7", highlightId: ROW_AED6.id, evidence: evidenceFor(ROW_AED6, "live") },
      state
    );
    expect(stored.outcome).toBe("stored");
    expect(state.servedSentences.length).toBe(2);

    const second = stubFetch([FACT_BODY_AED6]);
    await runSummaryForRow(
      stubStore().store,
      cfg({ fetchImpl: second.fn }),
      { jobId: "9bed3bd7", highlightId: ROW_DC96.id, evidence: evidenceFor(ROW_DC96, "live") },
      state
    );
    // The prompt NAMES the sentence the previous card already served.
    expect(second.prompts[0]).toContain("Do not reuse a sentence already served on another card in this job");
    expect(second.prompts[0]).toContain("The scoreboard moves to 2-1 at the 1:35 mark of this clip.");
  });

  it("regenerates once with the repeat named, then drops `repeat`", async () => {
    const state = newSummaryJobState();
    // The previous card served this (factual) sentence; the next row's reply
    // reuses it, which is the AC14.3 defect one level below the template.
    // ADAAAA-8934: a bounded act — a sustained-play clause would be DELETED by the
    // clause repair, so it could never be the sentence the next card repeats.
    const servedSentence = "Real Madrid intercepts the ball near the box at the 1:35 mark of this clip.";
    state.servedSentences.push(servedSentence);
    const repeated = `The scoreboard moves to 2-2 at the 2:35 mark of this clip. ${servedSentence}`;
    const { store, patches } = stubStore();
    const f = stubFetch([repeated, repeated]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      { jobId: "9bed3bd7", highlightId: ROW_DC96.id, evidence: evidenceFor(ROW_DC96, "live") },
      state
    );
    expect(result.outcome).toBe("dropped");
    expect(result.reason).toBe("repeat");
    expect(result.calls).toBe(2); // one regeneration, never a third call
    expect(f.prompts[1]).toContain("The previous draft repeated a sentence another card in this job already carries.");
    const last = patches.at(-1)!.patch as Record<string, unknown>;
    expect(last.summaryGate).toBe("dropped:repeat");
    expect(last.summaryDroppedByReason).toEqual({ repeat: 1 });
    // The repeated sentence never joins the job's served set.
    expect(state.servedSentences).toEqual([servedSentence]);
  });

  it("serves a body that repeats nothing", async () => {
    const state = newSummaryJobState();
    state.servedSentences.push(...["Barcelona recovers the ball near the wing and counters at the 1:35 mark of this clip."]);
    const f = stubFetch([FACT_BODY_AED6]);
    const result = await runSummaryForRow(
      stubStore().store,
      cfg({ fetchImpl: f.fn }),
      { jobId: "9bed3bd7", highlightId: ROW_AED6.id, evidence: evidenceFor(ROW_AED6, "live") },
      state
    );
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC14.5 — the filler drop keeps its name, its evidence and its price.
// ---------------------------------------------------------------------------
describe("ADAAAA-8914 AC14.5 — a filler reply drops as `filler`, cheaply", () => {
  it("drops with the named reason after ONE regeneration, and persists the clause evidence", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([FILLER_VOD, FILLER_VOD]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      { jobId: "796e202d", highlightId: ROW_5322.id, evidence: evidenceFor(ROW_5322, "vod") },
      newSummaryJobState()
    );
    expect(result.outcome).toBe("dropped");
    expect(result.calls).toBe(2);
    const last = patches.at(-1)!.patch as Record<string, unknown>;
    // ADAAAA-8934: this draft grounds ONE sentence and the other three are CLAIM
    // deletions (atmosphere/momentum/crowd), which leave no slot for the repair —
    // a true fact must not replace a false claim. The repair may contribute at
    // most as many sentences as the draft itself kept (it may fill holes, never
    // become the body), so the substitution stops at one fact sentence and the
    // card still lands under the 40-word floor. That is the `filler` name this
    // rule exists for: the writer had nothing to say, and the clause repair took
    // the body under the floor. Lifting the cap would serve 40 words that are
    // three restatements of one score transition.
    expect(result.reason).toBe("filler");
    expect(last.summaryGate).toBe("dropped:filler");
    expect(last.summaryDroppedByReason).toEqual({ filler: 1 });
    // §15.4: what the repair deleted, and the word count that survived it.
    expect(last.summaryDroppedClauses).toBe(3);
    expect(last.summaryRepairedWords).toBeLessThan(SUMMARY_VOD_BAND.floorWords);
    expect(last.summaryClauseClaims).toEqual(expect.arrayContaining(["momentum", "atmosphere"]));
    expect(last.summaryFloorWords).toBe(SUMMARY_VOD_BAND.floorWords);
    expect(last.summaryViolations).toEqual(expect.arrayContaining(["unattested-atmosphere", "too-few-words"]));
    // Never a served value on a drop.
    expect(last.summary).toBeUndefined();
    expect(last.summaryRaw).toContain("The crowd erupts in celebration");
  });

  it("serves the second sample when the retry repairs the clause", async () => {
    // ADAAAA-8934: the retry now draws on the fact menu (score line, clip clock,
    // a bounded act by a named attested actor) instead of the possession prose the
    // rev-8 prompt asked for.
    const repaired =
      "Barcelona is in the sequence as the scoreboard moves from 2-1 to 2-2 at the 1:24 mark of the clip. " +
      "Real Madrid intercepts the ball near the byline and counters at 1:24 into the clip. " +
      "Barcelona recovers the ball near the wing and threads a pass to the left flank at 1:24 of the clip. " +
      "The scoreboard holds at 2-2 as the clip runs past 1:24.";
    const { store, patches } = stubStore();
    const f = stubFetch([FILLER_VOD, repaired]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      { jobId: "796e202d", highlightId: ROW_5322.id, evidence: evidenceFor(ROW_5322, "vod") },
      newSummaryJobState()
    );
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(2);
    expect(f.prompts[1]).toContain("The previous draft spent sentences on atmosphere, a crowd, a reaction");
    expect((patches.at(-1)!.patch as Record<string, unknown>).summary).toBe(repaired);
  });

  it("keeps the fee class: one retry, still <= 1.5x DECIDE_FEE", () => {
    const fee = summaryFeeFor({ decideFee: 0.0033 });
    expect(SUMMARY_FEE_RATIO).toBe(1.5);
    expect(fee).toBeCloseTo(0.00495, 6);
  });
});

// ADAAAA-9120 — the rev-17 SERVED envelope (AC5) on the one `file-sim` leg, job
// `1e0d7187-d573-4f7a-8271-4540890d3a7e` (7 stored rows, all post-pin):
//
//   row meter `sum(summaryCalls)`     13 / 7 rows = 1.857   bar <= 1.5  -> FAIL
//   job meter `record.summaryCalls`   15 / 7 rows = 2.143   bar <= 1.5  -> FAIL
//   rows billing a 2nd summary call   6 / 7
//   `too-few-facts` as a retry trigger 0
//
// Every second call was bought by the AC8 repeat gate: the clip runs ~2.2
// competitive passes, so 6 of 7 rows re-landed a served opening / sentence and the
// lane spent the AC14 regeneration slot on a refusal that a second sample of the
// SAME fixed corpus cannot repair (`summaryRepairRefused: prune:gate` on all five
// dropped rows). ADAAAA-9120 clamps that class to ONE call: the deterministic
// clause drop (AC14.3) runs on the row's own call and the paid regeneration is
// reserved for the AC14 filler-clause path. The bar does not move — `summaryCalls`
// per row is simply 1 by construction on the repeat class.
//
// These pin: (1) a repeat row that the repair SERVES bills one call, (2) a repeat
// row the repair refuses bills one call and keeps its own named refusal, (3) a job
// made mostly of repeats lands `summaryCalls / rows <= 1.5` on the lane meter, and
// (4) the AC14 filler regeneration is still the one permitted second call.
import { describe, expect, it } from "vitest";
import {
  closestSentencePair,
  gateSummaryDetail,
  summaryFactCandidates,
  summaryOpeningRun,
  summarySentencesOf,
  summaryWordCount,
  SUMMARY_VOD_BAND,
  type SummaryEvidence,
} from "@highlights/events";
import {
  SummaryLane,
  newSummaryJobState,
  runSummaryForRow,
  type SummaryJobState,
  type SummaryLaneConfig,
  type SummaryLaneStore,
} from "../src/summary-lane.js";

/** AC5's envelope bar, as the grade writes it. */
const AC5_CALLS_PER_ROW = 1.5;

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

/** One answer per call, in order, so the prompt list IS the call list. */
function stubFetch(answers: string[]) {
  let i = 0;
  const prompts: string[] = [];
  const fn = (async (_url: string, init: any) => {
    prompts.push(JSON.parse(init.body).prompt);
    const summary = answers[Math.min(i, answers.length - 1)];
    i++;
    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, prompts, calls: () => i };
}

const cfg = (over: Record<string, unknown> = {}) =>
  ({ decideUrl: "http://decide.test", decideFee: 0.0033, log: () => {}, ...over }) as SummaryLaneConfig;

/** The rev-17 fixture's shape: a VOD row whose own transcript names an attested
 *  actor (the second fact kind a VOD body needs) and whose clip offset is its clock. */
const rowEvidence = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "vod",
  verdict: null,
  eventType: "GOAL",
  reason: "The frame dive confirmed the goal.",
  caption: null,
  postTitle: "GOAL · 11:48",
  windowTs: 708,
  windowDurationS: 9,
  scoreTransition: null,
  matchContext: {
    sport: "soccer",
    teams: [
      { name: "Real Madrid", side: "home" },
      { name: "Barcelona", side: "away" },
    ],
  },
  transcript: "David Saez drives forward on the left, el remate de David Saez, sigue David Saez en la banda.",
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false, goalConfirmed: "confirmed_goal" },
  ...over,
});

const stateWith = (body: string, extraSentences: string[] = []): SummaryJobState => {
  const state = newSummaryJobState();
  state.servedBodies.push({
    highlightId: "served-row",
    windowTs: 700,
    windowDurationS: 9,
    clockToken: "11:40",
    body,
    opening: summaryOpeningRun(body),
  });
  for (const sentence of summarySentencesOf(body)) state.servedSentences.push(sentence);
  for (const sentence of extraSentences) state.servedSentences.push(sentence);
  state.servedOpenings.add(summaryOpeningRun(body));
  return state;
};

/** A card the job already served: the opening run this fixture's draft repeats. */
const SERVED_9120 =
  "Real Madrid drives forward at 11:40 into the clip and takes a shot on goal. Barcelona forces a save at 11:41 into the clip. Yojo is in the passage at 11:42 into the clip.";

/** The draft: the same four normalized opening words, and its other three
 *  sentences are fact-bearing, so the clause drop leaves a body in band. */
const REPEAT_SERVABLE_9120 =
  "Real Madrid drives forward and takes a shot at 11:48 into the clip. David Saez completes a short pass to set up the next attacking sequence at 11:49 into the clip. Barcelona maintains control of the play at 11:50 into the clip. The sequence closes with a clearance from David Saez at 11:52 into the clip.";

/** The same repeat — 47 words over 3 fact-bearing sentences — but the row's
 *  substitution pool is already on other cards, so the pruned remainder falls under
 *  the band floor: AC14.3's order ends in a named refusal. */
const REPEAT_REFUSED_9120 =
  "Real Madrid drives forward at 11:48 into the clip and takes a shot on goal from the edge of the area. David Saez completes a short pass to set up the next sequence at 11:49 into the clip. David Saez then completes another pass at 11:50 into the clip.";
/** The card this draft repeats: the same template one clock token over (AC8 and
 *  AC14.3 in one hit), and the only served body. */
const SERVED_REFUSED_9120 =
  "Real Madrid drives forward at 11:40 into the clip and takes a shot on goal from the edge of the area.";

describe("ADAAAA-9120 — a deterministic repeat refusal is clamped to ONE call", () => {
  it("serves the pruned body on the row's own call (no paid regeneration)", async () => {
    const evidence = rowEvidence();
    const { store, patches } = stubStore();
    // Instrument: the opening run really does repeat the served card, and the
    // clause drop leaves a servable body.
    expect(summaryOpeningRun(REPEAT_SERVABLE_9120)).toBe(summaryOpeningRun(SERVED_9120));
    const draftSentences = summarySentencesOf(REPEAT_SERVABLE_9120);
    expect(summaryWordCount(draftSentences.slice(1).join(" "))).toBeGreaterThanOrEqual(
      SUMMARY_VOD_BAND.floorWords
    );

    const f = stubFetch([REPEAT_SERVABLE_9120]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      { jobId: "job-9120", highlightId: "row-5f1ca385", evidence },
      stateWith(SERVED_9120)
    );

    expect(result.outcome).toBe("stored");
    // AC5: one call, and the call list proves it.
    expect(result.calls).toBe(1);
    expect(f.calls()).toBe(1);
    expect(f.prompts).toHaveLength(1);
    const patch = patches.at(-1)!.patch;
    expect(patch.summaryCalls).toBe(1);
    // The repeat is still named, and the repair is the deterministic clause drop.
    expect(patch.summaryRetryReason).toBe("repeat-opening");
    expect((patch.summaryDroppedSentences as number) ?? 0).toBeGreaterThanOrEqual(1);
    expect(String(patch.summary)).not.toContain(draftSentences[0]);
    expect(closestSentencePair([String(patch.summary), SERVED_9120])!.similarity).toBeLessThan(0.8);
  });

  it("refuses on the row's own call and keeps the repair's named refusal", async () => {
    const evidence = rowEvidence();
    const { store, patches } = stubStore();
    // The row's whole substitution pool is already on other cards.
    const pool = summaryFactCandidates(evidence).map((candidate) => candidate.sentence);
    expect(pool.length).toBeGreaterThan(0);

    const f = stubFetch([REPEAT_REFUSED_9120]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      { jobId: "job-9120", highlightId: "row-b018185a", evidence },
      stateWith(SERVED_REFUSED_9120, pool)
    );

    expect(result.outcome).toBe("dropped");
    // AC5: the refusal costs ONE call, not two.
    expect(result.calls).toBe(1);
    expect(f.calls()).toBe(1);
    const patch = patches.at(-1)!.patch;
    expect(patch.summaryCalls).toBe(1);
    expect(patch.summary).toBeUndefined();
    // The drop is still named by the repair's own post-prune measurement.
    expect(patch.summaryRepairRefused).toBe("prune:filler");
    expect((patch.summaryRepairDroppedSentences as number) ?? 0).toBeGreaterThanOrEqual(1);
    expect(patch.summaryRetryReason).toBe("repeat-opening");
    // The refusal keeps the text the repair JUDGED as `summaryRaw` evidence for the
    // next census (the post-prune remainder here — the writer's whole reply survives
    // only when the clause drop emptied the body).
    expect(String(patch.summaryRaw)).toContain("David Saez completes a short pass");
  });

  it("a job made mostly of repeats lands `summaryCalls / rows <= 1.5` on the meter", async () => {
    const { store, patches } = stubStore();
    // 4 rows: the first serves, the next three repeat its opening and are refused.
    const f = stubFetch([SERVED_9120, REPEAT_SERVABLE_9120]);
    const lane = new SummaryLane("job-9120-envelope", store, cfg({ fetchImpl: f.fn }));
    const ids = ["row-1", "row-2", "row-3", "row-4"];
    for (const id of ids) {
      expect(lane.enqueue({ jobId: "job-9120-envelope", highlightId: id, evidence: rowEvidence() })).toBe(true);
    }
    await lane.idle();

    const meter = lane.snapshot();
    const rows = patches.length;
    expect(rows).toBe(ids.length);
    // The bar itself: the rev-17 leg measured 1.857 / 2.143 here.
    expect(meter.summaryCalls / rows).toBeLessThanOrEqual(AC5_CALLS_PER_ROW);
    // And the mechanism: no row bought a second call.
    for (const { patch } of patches) {
      expect(patch.summaryCalls).toBe(1);
    }
  });
});

describe("ADAAAA-9120 — the AC14 filler regeneration is still the one permitted second call", () => {
  it("bills two calls and records `filler-repair` on a filler/claim refusal", async () => {
    const evidence = rowEvidence();
    const { store, patches } = stubStore();
    // An invented-vocabulary clause the AC14.5 repair deletes and cannot replace
    // from the row's own facts: the ONE regeneration is the filler path, not a
    // repeat. (`summaryDroppedByReason` names the refusal, the meter names 2 calls.)
    const fillerBody =
      "Real Madrid faces a pivotal moment of momentum at 11:48 into the clip as the crowd lifts the competition. David Saez drives forward at 11:49 into the clip.";
    const decision = gateSummaryDetail(fillerBody, evidence);
    expect(decision.summary).toBeNull();
    expect(decision.droppedClauses.length).toBeGreaterThan(0);

    const f = stubFetch([fillerBody, fillerBody]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      { jobId: "job-9120-filler", highlightId: "row-73cca424", evidence }
    );

    // The filler path keeps its second call (AC14's regeneration)...
    expect(result.calls).toBe(2);
    expect(f.calls()).toBe(2);
    const patch = patches.at(-1)!.patch;
    expect(patch.summaryRetryReason).toBe("filler-repair");
    expect(patch.summaryCalls).toBe(2);
  });
});

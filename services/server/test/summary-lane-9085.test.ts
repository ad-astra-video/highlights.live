// ADAAAA-9085 — the lane's repeat repair, measured on the rev-13 SERVED VOD job
// `54537ffa` (rev-13 tree `5421ed9f`, 20 `highlights` rows):
//
//  1. an `opening` repeat never reached the ADAAAA-9052 clause drop, because the
//     prune was gated on `repeat.key === "sentence"`. Row `369ff147`
//     (`repeat-opening`) dropped with the PRE-prune decision on it.
//  2. the clause drop ran on the three `repeat-sentence` rows and its own re-gate
//     is what refused them — but the lane stored `lastGate = decision` (the
//     pre-prune body), so all three rows read `summaryViolations: []` with a word
//     count that measured nothing (`c1a78055`, `3b8ff4f5`, `b45fc105`).
//  3. the AC14.5 filler repair substituted from a deterministic pool and re-served
//     a sentence another card in the same job already carried — the repeat key then
//     flagged the gate's own repair and the prune undid it.
//
// These pin the three repairs: the clause drop is reachable on every repeat key, a
// repair that refuses persists ITS OWN refusal (`summaryRepairRefused`, post-prune
// violations / words / dropped-sentence count), and the gate's repair is told what
// the job already serves.
import { describe, expect, it } from "vitest";
import {
  closestSentencePair,
  summaryFactCandidates,
  summaryOpeningRun,
  summarySentencesOf,
  summaryWordCount,
  SUMMARY_VOD_BAND,
  type SummaryEvidence,
} from "@highlights/events";
import {
  newSummaryJobState,
  runSummaryForRow,
  type SummaryJobState,
  type SummaryLaneConfig,
  type SummaryLaneStore,
} from "../src/summary-lane.js";

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

function stubFetch(summary: string) {
  const prompts: string[] = [];
  const fn = (async (_url: string, init: any) => {
    prompts.push(JSON.parse(init.body).prompt);
    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, prompts };
}

const cfg = (over: Record<string, unknown> = {}) =>
  ({ decideUrl: "http://decide.test", decideFee: 0.0033, log: () => {}, ...over }) as SummaryLaneConfig;

/** A rev-13 VOD row: the clip offset is its clock, and the window's own transcript
 *  names the attested actor (the second fact kind a VOD body needs). */
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

/** The served card whose OPENING this row repeats: the same four normalized words,
 *  the same sentence template one clock token over — AC8 and AC14.3 in one hit. The
 *  rest of that card is distinct so only the opening sentence repeats. */
const SERVED_OPENING_9085 =
  "Real Madrid drives forward at 11:40 into the clip and takes a shot on goal. Barcelona forces a save at 11:41 into the clip. Yojo is in the passage at 11:42 into the clip.";

/** The draft: opens with the same four normalized words, and its other three
 *  sentences are fact-bearing, so the clause drop leaves a body in band. */
const DRAFT_OPENING_9085 =
  "Real Madrid drives forward and takes a shot at 11:48 into the clip. David Saez completes a short pass to set up the next attacking sequence at 11:49 into the clip. Barcelona maintains control of the play at 11:50 into the clip. The sequence closes with a clearance from David Saez at 11:52 into the clip.";

describe("ADAAAA-9085 — an opening repeat reaches the clause drop", () => {
  it("serves the pruned body instead of dropping the row as `repeat`", async () => {
    const evidence = rowEvidence();
    const { store, patches } = stubStore();
    // Instrument: the opening run really does repeat, and dropping the offending
    // sentence leaves a body in band.
    expect(summaryOpeningRun(DRAFT_OPENING_9085)).toBe(summaryOpeningRun(SERVED_OPENING_9085));
    const draftSentences = summarySentencesOf(DRAFT_OPENING_9085);
    expect(summaryWordCount(draftSentences.slice(1).join(" "))).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);

    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: stubFetch(DRAFT_OPENING_9085).fn }),
      { jobId: "job-9085", highlightId: "row-369ff147", evidence },
      stateWith(SERVED_OPENING_9085)
    );

    expect(result.outcome).toBe("stored");
    const patch = patches.at(-1)!.patch;
    expect(patch.summaryGate).not.toBe("dropped:repeat");
    const stored = String(patch.summary);
    expect(summaryWordCount(stored)).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
    // The repeated opening sentence is gone, so AC8 cannot re-fire on this card.
    expect(summarySentencesOf(stored)).not.toContain(draftSentences[0]);
    expect(patch.summaryRetryReason).toBe("repeat-opening");
    expect((patch.summaryDroppedSentences as number) ?? 0).toBeGreaterThanOrEqual(1);
    expect(patch.summaryRepairRefused).toBeUndefined();
    expect(closestSentencePair([stored, SERVED_OPENING_9085])!.similarity).toBeLessThan(0.8);
  });
});

describe("ADAAAA-9085 — a failed repair persists its OWN post-prune refusal", () => {
  it("names the repair, stores the post-prune violations and words", async () => {
    const evidence = rowEvidence();
    const { store, patches } = stubStore();
    // The row's whole substitution pool is already on other cards, so the pruned
    // remainder cannot be re-grown: AC14.3's order ends in a named refusal.
    const pool = summaryFactCandidates(evidence).map((candidate) => candidate.sentence);
    expect(pool.length).toBeGreaterThan(0);
    // 47 words over 3 fact-bearing sentences: the gate accepts it, and the clause
    // drop leaves 27 words — the AC14.3 shape (a repair whose remainder is under the
    // band floor because the row's evidence offers no other sentence to add).
    const shortDraft =
      "Real Madrid drives forward at 11:48 into the clip and takes a shot on goal from the edge of the area. David Saez completes a short pass to set up the next sequence at 11:49 into the clip. David Saez then completes another pass at 11:50 into the clip.";
    const served = "Real Madrid drives forward at 11:40 into the clip and takes a shot on goal from the edge of the area.";
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: stubFetch(shortDraft).fn }),
      { jobId: "job-9085", highlightId: "row-c1a78055", evidence },
      stateWith(served, pool)
    );

    expect(result.outcome).toBe("dropped");
    const patch = patches.at(-1)!.patch;
    // AC14.3's order ends at the clause drop: the row is named by the repair's own
    // refusal (a remainder under the band floor), never by the repeat that started it.
    expect(patch.summaryGate).toBe("dropped:filler");
    expect(patch.summaryRepairRefused).toBe("prune:filler");
    expect((patch.summaryRepairDroppedSentences as number) ?? 0).toBeGreaterThanOrEqual(1);
    expect(patch.summaryRepairSubstitutedSentences).toBe(0);
    // The pre-prune body measured nothing: its violations were [] and its words were
    // above the floor. These are the POST-prune numbers.
    expect(patch.summaryViolations as string[]).toContain("too-few-words");
    expect(patch.summaryWordCount as number).toBeLessThan(SUMMARY_VOD_BAND.floorWords);
    expect(patch.summaryRetryReason).toBe("repeat-opening");
    expect(patch.summaryDroppedByReason).toEqual({ filler: 1 });
  });
});

describe("ADAAAA-9085 — the gate's repair may not re-serve a sentence the job carries", () => {
  it("stores a body with no AC14.3 pair against the card already served", async () => {
    const evidence = rowEvidence();
    const { store, patches } = stubStore();
    // Two factless clauses the gate deletes, and only ~24 words of fact left: the
    // repair MUST reach the substitution pool, which is where the served build's
    // repair re-served a template.
    const draft =
      "Real Madrid faces a high-pressure situation during the Antutu Penalty. David Saez drives forward and takes a shot at 11:48 into the clip. David Saez completes a pass to set up the next sequence. The match features a tense standoff between Real Madrid and Barcelona. The sequence closes with a clearance at 11:52 into the clip.";
    const served =
      "Real Madrid is in the passage at 11:40 into the clip. The clip carries this sequence at 11:40 into the clip. Yojo is in the passage at 11:42 into the clip.";
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: stubFetch(draft).fn }),
      { jobId: "job-9085", highlightId: "row-3b8ff4f5", evidence },
      stateWith(served)
    );

    expect(result.outcome).toBe("stored");
    const stored = String(patches.at(-1)!.patch.summary);
    expect(summaryWordCount(stored)).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
    expect(closestSentencePair([stored, served])!.similarity).toBeLessThan(0.8);
  });
});

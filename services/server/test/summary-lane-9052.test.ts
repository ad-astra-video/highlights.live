// ADAAAA-9052 — the lane's repeat prune REPAIRS instead of dropping the row.
//
// Measured `$0` on the rev-11 VOD census: AC14's clause drop left five promoted
// rows at 33-39 words and the lane discarded each ROW rather than re-growing it
// (row `54388ada`, job `4ad12127`: 45 words → 36, dropped `repeat`). This pins the
// lane behaviour the ticket asks for: the pruned body is re-grown to the band with
// a different attested fact and SERVED, and a row whose evidence offers no other
// fact still drops with its named reason instead of being padded.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_VOD_BAND,
  closestSentencePair,
  gateSummaryDetail,
  summaryOpeningRun,
  summarySentencesOf,
  summaryWordCount,
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

const GOAL_ASR =
  "Es Carlos Javier quien la pisa, Carlos Javier quien intenta progresar por la banda izquierda, sigue Carlos Javier, el centro para Ordoñez, el remate gol. Acaba de marcar el Real Madrid, acaba de marcar Manuel Ordoñez, Manu, en el minuto.";

/** Row `54388ada` (job `4ad12127`) — a promoted VOD GOAL with a measured score
 *  transition and a named actor. */
const goalEvidence = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "vod",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason: "Goal confirmed by the frame dive.",
  caption: "GOAL · 0:27",
  postTitle: "GOAL · 0:27",
  windowTs: 27,
  windowDurationS: 8,
  scoreTransition: { from: "1-1", to: "2-1" },
  matchContext: { sport: "soccer", teams: [{ name: "Real Madrid", side: "home" }] },
  transcript: GOAL_ASR,
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false, goalConfirmed: "confirmed_goal" },
  ...over,
});

/** The stored draft of row `54388ada`, verbatim from the census. */
const DRAFT_9052 =
  "Real Madrid scores to move the scoreboard to 2-1. Manuel Ordoñez finds the back of the net for his team. This scoring play occurs at 0:27 into the clip. Carlos Javier is in the sequence as the scoreboard moves from 1-1 to 2-1 at 0:27.";
const REPEATED_9052 = "This scoring play occurs at 0:27 into the clip.";
/** Row `7ef92cbe`, already served in the same job: the same template, one clock
 *  token over — the AC14.3 defect the repeat key exists to catch. */
const SERVED_9052 =
  "Manuel Ordoñez finds the back of the net for Real Madrid. This scoring play occurs at 0:24 into the clip. Carlos Javier is in the passage at 0:24 into the clip. The clip carries this sequence at 0:24 into the clip.";

const stateWith = (body: string, clockToken = "0:24"): SummaryJobState => {
  const state = newSummaryJobState();
  state.servedBodies.push({
    highlightId: "served-row",
    windowTs: 24,
    windowDurationS: 8,
    clockToken,
    body,
    opening: summaryOpeningRun(body),
  });
  for (const sentence of summarySentencesOf(body)) state.servedSentences.push(sentence);
  state.servedOpenings.add(summaryOpeningRun(body));
  return state;
};

describe("ADAAAA-9052 — a pruned row is repaired back to the floor and served", () => {
  it("serves the re-grown body instead of dropping the row as `repeat`", async () => {
    const evidence = goalEvidence();
    // The instrument: the plain clause drop leaves the row under the VOD floor,
    // which is exactly what dropped five rev-11 rows.
    const gated = gateSummaryDetail(DRAFT_9052, evidence);
    expect(gated.summary).toBeTruthy();
    const prunedWords = summaryWordCount(DRAFT_9052.replace(REPEATED_9052, "").trim());
    expect(prunedWords).toBeLessThan(SUMMARY_VOD_BAND.floorWords);

    const { store, patches } = stubStore();
    const f = stubFetch(DRAFT_9052);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      { jobId: "job-9052", highlightId: "row-54388ada", evidence },
      stateWith(SERVED_9052)
    );

    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(2);
    const patch = patches.at(-1)!.patch;
    expect(patch.summaryGate).toBe(gated.gate);
    expect(patch.summaryDropped).toBe(0);
    const stored = String(patch.summary);
    expect(storedWordCount(stored)).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
    expect(stored).not.toContain(REPEATED_9052);
    expect(patch.summaryRetryReason).toBe("repeat-sentence");
    expect((patch.summaryRepairedWords as number) ?? 0).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
    expect((patch.summaryDroppedSentences as number) ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("leaves no AC14.3 pair against the body the job already serves", async () => {
    const evidence = goalEvidence();
    const { store, patches } = stubStore();
    const f = stubFetch(DRAFT_9052);
    const state = stateWith(SERVED_9052);
    await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      { jobId: "job-9052", highlightId: "row-54388ada", evidence },
      state
    );
    const stored = String(patches.at(-1)!.patch.summary);
    const pair = closestSentencePair([SERVED_9052, stored]);
    expect(pair).not.toBeNull();
    expect(pair!.similarity).toBeLessThan(0.8);
  });

  it("names the repeated sentence in the regeneration prompt", async () => {
    const evidence = goalEvidence();
    const { store } = stubStore();
    const f = stubFetch(DRAFT_9052);
    await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), { jobId: "job-9052", highlightId: "row-1", evidence }, stateWith(SERVED_9052));
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[0]).not.toContain("already carries");
    expect(f.prompts[1]).toContain("REPEAT a sentence a card in this job already carries");
    expect(f.prompts[1]).toContain(REPEATED_9052);
  });
});

describe("ADAAAA-9052 — a row with no other attested fact still drops `repeat`", () => {
  it("never pads the body to reach the floor", async () => {
    // Row `8d78c11f` (job `c5dac977`): the window attests the clip clock alone.
    const evidence = goalEvidence({
      verdict: "big_play",
      eventType: "BIG_PLAY",
      caption: "BIG PLAY · 1:21",
      postTitle: "BIG PLAY · 1:21",
      windowTs: 81,
      scoreTransition: null,
      matchContext: { sport: "soccer", teams: [{ name: "Real Madrid", side: "home" }] },
      // The row's own ASR names the side and its dive recorded the goal, so the
      // gate serves the draft: what refuses it is the repeat key, not the gate.
      transcript: "aleador del Real Madrid y el balance para el Barça. La intenta por banda derecha.",
      attestation: {
        ballOutcome: null,
        goalCrossed: false,
        scoreBoardChanged: false,
        goalConfirmed: "confirmed_goal",
      },
    });
    const body =
      "Real Madrid is in the passage at 1:21 into the clip. At 1:21 into the clip, the ball crosses the goal line. The clip carries this sequence at 1:21 into the clip. The window runs at 1:21 into the clip.";
    const { store, patches } = stubStore();
    const f = stubFetch(body);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      { jobId: "job-9052", highlightId: "row-8d78c11f", evidence },
      stateWith(SERVED_9052, "0:24")
    );
    expect(result.outcome).toBe("dropped");
    // ADAAAA-9085: the row still drops on its own evidence (the repair substitutes one
    // admissible sentence and the remainder stays under the floor) — but it is named by
    // what the repair measured (`filler`: a remainder under the band floor) and carries
    // the repair's own post-prune numbers, instead of the pre-prune `repeat`.
    expect(result.reason).toBe("filler");
    expect(result.calls).toBe(2);
    const patch = patches.at(-1)!.patch;
    expect(String(patch.summaryGate)).toBe("dropped:filler");
    expect(patch.summary).toBeUndefined();
    expect(patch.summaryRepairRefused).toBe("prune:filler");
    expect(patch.summaryViolations as string[]).toContain("too-few-words");
    // The body was never padded to the floor: the post-prune count is under it.
    expect(patch.summaryWordCount as number).toBeLessThan(SUMMARY_VOD_BAND.floorWords);
  });
});

function storedWordCount(body: string): number {
  return body.split(/\s+/).filter(Boolean).length;
}

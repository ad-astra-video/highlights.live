// ADAAAA-9121 (writer round 3) — the lane hands the writer the job's SPENT
// actor-and-act pairs, and the AC8 opening retry now names the sentence it
// repeated.
//
// Measured `$0` on the rev-17 served block `80ac7b3` (job `1e0d7187`, 7 stored
// rows): every card's substance sentence was the same legal act-plus-purpose
// clause (`… completes a pass to maintain their offensive movement during the
// sequence.` x3, `… to move the ball toward the opposing side of the pitch.` x2,
// similarity 1.000), the AC14 prune deleted it, and all 5 `repeat-*` rows served
// nothing. The lane fix is prompt STATE, not a bar: `SummaryJobState.servedActs`
// accumulates what each served body spent, `avoidActs` renders it on the next
// card's first pass, and the opening retry carries the flagged sentence.
import { describe, expect, it } from "vitest";
import { gateSummaryDetail, summaryOpeningRun, type SummaryEvidence } from "@highlights/events";
import {
  newSummaryJobState,
  runSummaryForRow,
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

function stubFetch(replies: string[]) {
  const prompts: string[] = [];
  let index = 0;
  const fn = (async (_url: string, init: any) => {
    prompts.push(JSON.parse(init.body).prompt);
    const summary = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, prompts };
}

const cfg = (over: Record<string, unknown> = {}) =>
  ({ decideUrl: "http://decide.test", decideFee: 0.0033, log: () => {}, ...over }) as SummaryLaneConfig;

/** A live `big_play` row whose only attested kinds are `clock` + `action`: the
 *  exact shape of all 7 rows of job `1e0d7187`. */
const liveEvidence = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "live",
  verdict: "big_play",
  eventType: "BIG_PLAY",
  reason: "The ball enters the net at t=-1.3s, confirmed by ASR and crowd surge.",
  caption: null,
  postTitle: "BIG PLAY · 0:12",
  windowTs: 12,
  windowDurationS: 15,
  matchContext: {
    sport: "soccer",
    teams: [
      { name: "Real Madrid", side: "home" },
      { name: "Barcelona", side: "away" },
      // Job `1e0d7187`'s own matchContext attests a third name, which is what makes
      // the rotation deep enough to keep 7 cards distinct (3 actors x 11 verbs).
      { name: "Portugal", side: "away" },
    ],
  },
  matchClock: { token: "11:31", seconds: 691, legible: true },
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
  ...over,
});

// ADAAAA-9464: the live serve bar is the 25-word TARGET, so both cards carry a few
// more words around the SAME acts (the pairs the assertions read are unchanged).
const ROW_A = "Real Madrid wins the ball back at 11:31 of the match after a long spell of play in midfield. Barcelona recovers and threads a pass through midfield inside a 15-second window in the closing stages of the move.";
const ROW_B = "Barcelona dispossesses at 22:13 of the match and turns the passage into a counter in the closing stages of the move. Portugal crosses at 22:13 of the match and recovers the loose ball after a long spell of play.";

describe("ADAAAA-9121 — the lane rotates the job's spent actor-and-act pairs", () => {
  it("accumulates what a served body spent and renders it on the next card's first pass", async () => {
    const { store, patches } = stubStore();
    const state = newSummaryJobState();
    const first = stubFetch([ROW_A]);
    const firstResult = await runSummaryForRow(
      store,
      cfg({ fetchImpl: first.fn }),
      { jobId: "job-9121", highlightId: "row-a", evidence: liveEvidence() },
      state
    );
    expect(firstResult.outcome).toBe("stored");
    expect(first.prompts).toHaveLength(1);
    expect(first.prompts[0]).not.toContain("already spend these actor-and-act pairs");
    expect(state.servedActs).toEqual(["Real Madrid + wins the ball back", "Barcelona + recovers"]);
    expect(String(patches.at(-1)!.patch.summary)).toBe(ROW_A);

    const second = stubFetch([ROW_B]);
    await runSummaryForRow(
      store,
      cfg({ fetchImpl: second.fn }),
      {
        jobId: "job-9121",
        highlightId: "row-b",
        evidence: liveEvidence({ windowTs: 160, postTitle: "BIG PLAY · 2:40", matchClock: { token: "22:13", seconds: 1333, legible: true } }),
      },
      state
    );
    // The second card's FIRST prompt carries the spent pairs and the rotation
    // rule — prompt-first, so the repeat never needs a paid second call.
    expect(second.prompts).toHaveLength(1);
    expect(second.prompts[0]).toContain("This job's served cards already spend these actor-and-act pairs: Real Madrid + wins the ball back; Barcelona + recovers.");
    expect(second.prompts[0]).toContain("Vary each sentence's OPENING as well");
    expect(second.prompts[0]).not.toContain("RETRY:");
    expect(state.servedActs).toEqual([
      "Real Madrid + wins the ball back",
      "Barcelona + recovers",
      "Barcelona + dispossesses",
      "Portugal + crosses",
    ]);
  });

  it("keeps the spent-pair line off the first card of a job", async () => {
    const { store } = stubStore();
    const f = stubFetch([ROW_A]);
    await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), { jobId: "job-9121-fresh", highlightId: "row-a", evidence: liveEvidence() }, newSummaryJobState());
    expect(f.prompts[0]).not.toContain("already spend these actor-and-act pairs");
    // The rotation recipe itself still ships, so the first card is written for
    // rotation rather than banned into it later.
    expect(f.prompts[0]).toContain("Vary each sentence's OPENING as well");
  });
});

describe("ADAAAA-9121 — a repeat refusal spends no pairs and buys no second call", () => {
  it("repairs on the row's own call and leaves the rotation state untouched", async () => {
    const { store, patches } = stubStore();
    const state = newSummaryJobState();
    const evidence = liveEvidence();
    // The job already served a body that opens on the same four words.
    state.servedOpenings.add(summaryOpeningRun(ROW_A));
    state.servedSentences.push(...ROW_A.split(/(?<=\.)\s+/).filter(Boolean));
    state.servedBodies.push({
      highlightId: "row-served",
      windowTs: evidence.windowTs ?? null,
      windowDurationS: evidence.windowDurationS ?? null,
      clockToken: "11:31",
      body: ROW_A,
      opening: summaryOpeningRun(ROW_A),
    });
    const repeated =
      "Real Madrid wins the ball back at 11:31 of the match and sets the move going early. Barcelona dispossesses and counters toward the other end of the pitch.";
    const f = stubFetch([repeated, ROW_B]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      { jobId: "job-9121-repeat", highlightId: "row-c", evidence },
      state
    );

    // ADAAAA-9120 (AC5): the repeat refusal is deterministic, so it ends on ONE
    // call — the rotation lever must not reintroduce a second sample.
    expect(result.calls).toBe(1);
    expect(f.prompts).toHaveLength(1);
    expect(patches.at(-1)?.patch.summaryRetryReason).toBe("repeat-opening");
    // Nothing served, so nothing was spent: card 2 of this job still sees an empty
    // rotation list and is free to use any pair.
    expect(state.servedActs).toEqual([]);
  });
});

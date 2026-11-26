// ADAAAA-9177 (rev-20) — the lane's half of the spent-OPENING rotation.
//
// The rev-19 served block (job `798f21c2`, `file-sim`) measured two failures that
// ADAAAA-9121's `avoidActs` could not reach:
//
//   * `f7f62ed8` / `d9dc73b6` re-emitted the spent opening `portugal dispossesses
//     the ball` with `closestSentence=none`. AC8's key is `opening`, but the
//     deterministic clause repair only ran when a WHOLE sentence repeated, so
//     `repeatedSentences` was empty, the repair never ran, and both rows dropped
//     with the pre-prune decision — `summaryViolations: []`.
//   * `03cdc053` served: its collision was sentence 2, the prune dropped sentence
//     2, and the SERVED body still opened on `portugal dispossesses the ball` — a
//     served AC8 violation the sentence-similarity grade could not see.
//
// These pin the rev-20 behaviour on the same stored bytes: an opening repeat puts
// sentence 1 in the drop list, the pruned body is re-measured with the repeat key
// before it serves, and the row persists the avoid block its prompt carried.
import { describe, expect, it } from "vitest";
import {
  attestedActorNames,
  gateSummaryDetail,
  summaryOpeningRun,
  summarySentencesOf,
  summarySpentActPairs,
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
  const patches: { id: string; patch: Record<string, any> }[] = [];
  const store: SummaryLaneStore = {
    async patchHighlightSummary(id, patch) {
      patches.push({ id, patch: patch as Record<string, any> });
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

/** The rev-19 `file-sim` row shape: `clock` + `action` + the match's three names. */
const rowEvidence = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "live",
  verdict: "big_play",
  eventType: "BIG_PLAY",
  reason: "Ball shoots in midfield",
  caption: null,
  postTitle: null,
  windowTs: 1333,
  windowDurationS: 15,
  matchContext: {
    sport: "soccer",
    teams: [
      { name: "Portugal", side: "away" },
      { name: "Barcelona", side: "away" },
      { name: "Real Madrid", side: "home" },
    ],
  },
  matchClock: { token: "22:13", seconds: 1333, legible: true },
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
  ...over,
});

/** The stored served body of `0901bd41` (job `798f21c2`), verbatim. */
const SERVED_0901BD41 =
  "Portugal dispossesses the ball at 22:13 of the match. Barcelona then crosses the ball to initiate a transition.";
/** The stored writer reply of `f7f62ed8`, verbatim: same opening, no whole-sentence
 *  repeat (`closestSentence=none` on the grade), so the pre-9177 lane dropped it. */
// ADAAAA-9464: the stored reply is 22 words, under the live 25-word serve TARGET,
// so it now takes the AC5 retry before the repeat path is reachable. The fixture
// keeps both stored sentences verbatim and carries one more fact sentence (the
// row's attested actors), so the gate serves on the FIRST call and this file's
// subject — the opening repeat repaired on one call — is unchanged.
const RAW_F7F62ED8 =
  "Portugal dispossesses the ball at 10:57 into the clip. The scoreboard moves from 1-2 to 2-2 as Barcelona passes. Real Madrid intercepts the ball near the box and counters down the wing at 10:57 into the clip.";
/** The stored writer reply of `d9dc73b6`, verbatim: the same opening AND a score
 *  sentence that lands at 0.818 (>= AC14's 0.80) on `f7f62ed8`'s served score line. */
// ADAAAA-9464: 29 words in the SAME two sentences, so the gate serves on the first
// call and the drop below can still empty the body (both sentences repeat).
const RAW_D9DC73B6 =
  "Portugal dispossesses the ball at 11:10 into the clip. The scoreboard moves from 2-2 to 2-3 as Barcelona passes through the middle of the pitch.";

const stateWith = (body: string, over: { windowTs?: number; clockToken?: string | null } = {}): SummaryJobState => {
  const state = newSummaryJobState();
  state.servedOpenings.add(summaryOpeningRun(body));
  state.servedActs.push(...summarySpentActPairs([body], attestedActorNames(rowEvidence())));
  for (const sentence of summarySentencesOf(body)) state.servedSentences.push(sentence);
  state.servedBodies.push({
    highlightId: "served-row",
    windowTs: over.windowTs ?? 1333,
    windowDurationS: 15,
    clockToken: over.clockToken ?? "22:13",
    body,
    opening: summaryOpeningRun(body),
  });
  return state;
};

describe("ADAAAA-9177 (AC1) — the row persists the avoid block its prompt carried", () => {
  it("lists the served openings and pairs on card 2, and nothing on card 1", async () => {
    const { store, patches } = stubStore();
    const state = newSummaryJobState();
    // ADAAAA-9464: card 1 must clear the live 25-word serve TARGET for its body to
    // reach the job state this test reads the avoid block from. Same opening, same
    // two spend pairs (Portugal + dispossesses, Barcelona + crosses), 34 words.
    const SERVED_CARD1 =
      "Portugal dispossesses the ball at 22:13 of the match after a long spell of play in midfield. Barcelona then crosses the ball from the left flank at 22:13 of the match towards the far post.";
    const first = stubFetch([SERVED_CARD1]);
    await runSummaryForRow(
      store,
      cfg({ fetchImpl: first.fn }),
      { jobId: "job-9177-ac1", highlightId: "0901bd41", evidence: rowEvidence() },
      state
    );
    // First card of the job: nothing is spent, so the row carries no block and the
    // prompt carries no avoid line.
    expect(patches.at(-1)!.patch.summaryPromptAvoid).toBeUndefined();
    expect(first.prompts[0]).not.toContain("already-served runs");

    // ADAAAA-9464: card 2's reply clears the 25-word serve bar so the gate serves it
    // on the FIRST call (the assert below is about the prompt, which only exists on
    // a first pass); its opening is card 1's spent run, so the repeat repair then
    // drops it on that same call.
    const second = stubFetch([
      "Portugal dispossesses the ball at 06:16 of the match and starts the counter down the left. Real Madrid intercepts the ball near the box at 06:16 of the match and clears it towards the wing.",
    ]);
    await runSummaryForRow(
      store,
      cfg({ fetchImpl: second.fn }),
      {
        jobId: "job-9177-ac1",
        highlightId: "dd30bde1",
        evidence: rowEvidence({ windowTs: 376, matchClock: { token: "06:16", seconds: 376, legible: true } }),
      },
      state
    );

    // AC1: the block on the row IS what the prompt rendered — the served opening
    // run, and the pair the served body spent.
    expect(patches.at(-1)!.patch.summaryPromptAvoid).toEqual({
      openings: ["portugal dispossesses the ball"],
      acts: ["Portugal + dispossesses", "Barcelona + crosses"],
    });
    expect(second.prompts).toHaveLength(1);
    expect(second.prompts[0]).toContain("Do not open with any of these already-served runs: 'portugal dispossesses the ball'");
    expect(second.prompts[0]).toContain("These are the OPENINGS of sentence 1 on cards this job already serves");
    expect(second.prompts[0]).toContain(
      "This job's served cards already spend these actor-and-act pairs: Portugal + dispossesses; Barcelona + crosses."
    );
  });

  it("persists the same block on a DROPPED row", async () => {
    const { store, patches } = stubStore();
    const state = stateWith(SERVED_0901BD41);
    const f = stubFetch([RAW_F7F62ED8]);
    await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      {
        jobId: "job-9177-ac1-drop",
        highlightId: "f7f62ed8",
        evidence: rowEvidence({ windowTs: 657, matchClock: null, scoreTransition: { from: "1-2", to: "2-2" } }),
      },
      stateWith(SERVED_0901BD41)
    );
    const patch = patches.at(-1)!.patch;
    expect(f.prompts[0]).toContain("already-served runs");
    expect(patch.summaryPromptAvoid).toEqual({
      openings: ["portugal dispossesses the ball"],
      acts: ["Portugal + dispossesses", "Barcelona + crosses"],
    });
  });
});

describe("ADAAAA-9177 (AC2/AC4) — an opening-only collision is repaired into a serve, on ONE call", () => {
  it("drops sentence 1, re-grows from the row's facts, and serves a DIFFERENT opening", async () => {
    const { store, patches } = stubStore();
    const state = stateWith(SERVED_0901BD41);
    const f = stubFetch([RAW_F7F62ED8]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      {
        jobId: "job-9177-ac2",
        highlightId: "f7f62ed8",
        evidence: rowEvidence({ windowTs: 657, matchClock: null, scoreTransition: { from: "1-2", to: "2-2" } }),
      },
      state
    );

    // AC4: the repeat class still bills exactly ONE call (no regeneration added).
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(1);
    expect(f.prompts).toHaveLength(1);

    const patch = patches.at(-1)!.patch;
    const served = String(patch.summary);
    // AC2: the served body does NOT open on the spent run …
    expect(summaryOpeningRun(served)).not.toBe("portugal dispossesses the ball");
    expect(served).not.toContain("Portugal dispossesses the ball at 10:57");
    // … it re-grew to the band from the row's own score fact …
    expect(served).toContain("The scoreboard moves from 1-2 to 2-2 as Barcelona passes.");
    expect(gateSummaryDetail(served, rowEvidence()).words).toBeGreaterThanOrEqual(18);
    // … and the row names the mechanism.
    expect(patch.summaryRetryReason).toBe("repeat-opening");
    expect(patch.summaryDroppedSentences).toBe(1);
    // The lane's own AC8 state only carries the NEW opening.
    expect([...state.servedOpenings]).toEqual(["portugal dispossesses the ball", summaryOpeningRun(served)]);
  });

  it("refuses with a persisted summaryViolations entry when the repair cannot serve", async () => {
    // Both sentences of the draft repeat: sentence 1 is the spent OPENING, sentence 2
    // lands at 0.818 on the served score line, so the drop empties the body and the
    // repair has nothing left to re-grow.
    const { store, patches } = stubStore();
    // ADAAAA-9464: the served score sentence and the draft's score sentence are
    // deepened in the same words, so the AC14 similarity that this test needs
    // (>= 0.80) survives the 25-word serve bar.
    const servedScore = stateWith(
      "Portugal dispossesses the ball at 22:13 of the match. The scoreboard moves from 1-2 to 2-2 as Barcelona passes through the middle of the pitch.",
      { windowTs: 657 }
    );
    const f = stubFetch([RAW_D9DC73B6]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      {
        jobId: "job-9177-ac2-drop",
        highlightId: "d9dc73b6",
        evidence: rowEvidence({ windowTs: 670, matchClock: null, scoreTransition: { from: "2-2", to: "2-3" } }),
      },
      servedScore
    );

    expect(result.outcome).toBe("dropped");
    expect(result.calls).toBe(1);
    const patch = patches.at(-1)!.patch;
    expect(patch.summary).toBeUndefined();
    // AC2: the refusal is attributable from the row — the repair's token, the
    // repeat cause, and a NON-EMPTY violation list (rev-19 wrote `[]` here).
    expect(patch.summaryRepairRefused).toBe("prune:gate");
    expect(patch.summaryRetryReason).toBe("repeat-opening");
    expect((patch.summaryViolations ?? []).length).toBeGreaterThan(0);
    expect(patch.summaryRepairDroppedSentences).toBe(2);
    // The repair really did drop both sentences. A drop that empties the body keeps
    // the WRITER's reply as `summaryRaw` (ADAAAA-9085) — the post-prune text is empty,
    // so the row stays replayable as the draft that died.
    expect(String(patch.summaryRaw ?? "")).toContain("Portugal dispossesses the ball at 11:10");
    expect(patch.summaryWordCount).toBe(0);
  });

  it("drops a remainder that still repeats instead of serving a spent opening", async () => {
    // The `03cdc053` class, made deterministic: the drop removes sentence 1 (the
    // spent opening) and the remainder clears the gate — but it opens on ANOTHER
    // card's spent opening, so the re-gate's ACCEPT is not enough. Rev-19 served
    // exactly this shape (`03cdc053` opened on `0901bd41`'s run). The repeat key is
    // re-measured on the pruned body and refuses it as `prune:repeat`.
    const { store, patches } = stubStore();
    const state = newSummaryJobState();
    for (const [hid, body, clock, ts] of [
      ["0901bd41", SERVED_0901BD41, "22:13", 1333],
      [
        "8abf948e",
        "Barcelona wins the ball back at 04:38 of the match. Real Madrid then attempts a counter as the match clock reaches 04:38.",
        "04:38",
        278,
      ],
    ] as const) {
      state.servedOpenings.add(summaryOpeningRun(body));
      for (const sentence of summarySentencesOf(body)) state.servedSentences.push(sentence);
      state.servedBodies.push({ highlightId: hid, windowTs: ts, windowDurationS: 15, clockToken: clock, body, opening: summaryOpeningRun(body) });
    }
    const draft =
      "Portugal dispossesses the ball at 11:55 into the clip. Barcelona wins the ball back at 12:02 into the clip and moves it wide. Real Madrid threads a pass at 12:05 into the clip to set up the counter.";
    const f = stubFetch([draft]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      {
        jobId: "job-9177-ac2-still",
        highlightId: "03cdc053",
        evidence: rowEvidence({ windowTs: 715, matchClock: { token: "11:55", seconds: 715, legible: true } }),
      },
      state
    );

    expect(result.outcome).toBe("dropped");
    expect(result.calls).toBe(1);
    const patch = patches.at(-1)!.patch;
    expect(patch.summary).toBeUndefined();
    expect(patch.summaryRepairRefused).toBe("prune:repeat");
    expect(patch.summaryDroppedByReason).toEqual({ repeat: 1 });
    // The job keeps exactly the two openings it already served.
    expect([...state.servedOpenings]).toEqual(["portugal dispossesses the ball", "barcelona wins the ball"]);
  });
});

describe("ADAAAA-9177 (AC3) — a row that does not repeat keeps the pre-9177 path", () => {
  it("serves untouched: no clause drop, no repair token", async () => {
    const { store, patches } = stubStore();
    // ADAAAA-9464: 29 words with no purpose tail, so the clean body serves at the
    // live 25-word target and the pre-9177 path is what the test measures.
    const body =
      "Real Madrid threads a pass at 06:16 of the match. Barcelona then counters down the right and crosses into the box at 06:16 of the match and recovers the loose ball.";
    const f = stubFetch([body]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      {
        jobId: "job-9177-clean",
        highlightId: "dd30bde1",
        evidence: rowEvidence({ windowTs: 376, matchClock: { token: "06:16", seconds: 376, legible: true } }),
      },
      newSummaryJobState()
    );
    expect(result.outcome).toBe("stored");
    expect(patches.at(-1)!.patch.summary).toBe(body);
    expect(patches.at(-1)!.patch.summaryRetryReason).toBeUndefined();
    expect(patches.at(-1)!.patch.summaryDroppedSentences).toBeUndefined();
  });
});

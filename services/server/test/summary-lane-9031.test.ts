// ADAAAA-9031 — the rev-10 VOD lane's retry rule (AC5 / spec §13.2) and the
// AC14.3 clause-drop repair, pinned on the lane's own instrument.
//
// Measured on the served build `328bb3b`: 11 of 22 promoted VOD rows billed TWO
// summary calls. Only 4 were the AC8 repeat path; 3 were `too-few-facts` rows that
// were re-sampled, 1 was an AC14 filler repair, and 3 SERVED rows billed a second
// call with no reason recorded on the row at all. §13.2 permits the second call
// only on the AC8 repeat path (AC14 adds the filler-clause regeneration), so:
//
//   - a depth/claim refusal that the clause repair did not produce ends the row
//     on ONE call;
//   - the AC14 filler repair still regenerates once (the contract names it);
//   - a row that does bill two calls records WHY on the row (`summaryRetryReason`),
//     so the next census can audit the meter instead of replaying replies.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_VOD_BAND,
  gateSummaryDetail,
  summaryOpeningRun,
  summarySentencesOf,
  type SummaryEvidence,
} from "@highlights/events";
import {
  newSummaryJobState,
  runSummaryForRow,
  summaryEvidenceForRow,
  type SummaryLaneConfig,
  type SummaryJobState,
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
  let i = 0;
  const fn = (async (_url: string, init: any) => {
    prompts.push(JSON.parse(init.body).prompt);
    i += 1;
    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, prompts, calls: () => i };
}

const cfg = (over: Record<string, unknown> = {}) =>
  ({ decideUrl: "http://decide.test", decideFee: 0.0033, log: () => {}, ...over }) as SummaryLaneConfig;

const GOAL_ASR =
  "Es Carlos Javier quien la pisa, Carlos Javier quien intenta progresar por la banda izquierda, sigue Carlos Javier, el centro para Ordoñez, el remate gol. Acaba de marcar el Real Madrid, acaba de marcar Manuel Ordoñez, Manu, en el minuto.";

/** A promoted VOD GOAL row whose dive recorded the goal (row `7ef92cbe`). */
const goalEvidence = (): SummaryEvidence => ({
  rail: "vod",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason: "Goal confirmed by the frame dive.",
  caption: "GOAL · 0:24",
  postTitle: "GOAL · 0:24",
  windowTs: 24,
  windowDurationS: 8,
  scoreTransition: { from: "1-1", to: "2-1" },
  matchContext: { sport: "soccer", teams: [{ name: "Real Madrid", side: "home" }] },
  transcript: GOAL_ASR,
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false, goalConfirmed: "confirmed_goal" },
});

/** A promoted VOD BIG PLAY row (row `26a58961`): clock + a named actor, no
 *  measured score change and no ball outcome — the filler class. */
const bigPlayEvidence = (): SummaryEvidence => ({
  rail: "vod",
  verdict: "big_play",
  eventType: "BIG_PLAY",
  reason: "Extended passage of play in the Barcelona half.",
  caption: "BIG PLAY · 1:21",
  postTitle: "BIG PLAY · 1:21",
  windowTs: 81,
  windowDurationS: 8,
  scoreTransition: null,
  matchContext: { sport: "soccer", teams: [{ name: "Barcelona", side: "away" }] },
  transcript: "Sigue Barcelona, la jugada continúa por la banda derecha.",
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
});

const EMDASH_BODY =
  "Real Madrid moves the scoreboard from 1-1 to 2-1 at 0:24 into the clip — Manuel Ordoñez finds the back of the net as the ball enters the net. Carlos Javier threads the pass through the middle of the pitch and the strike beats the keeper low to his right.";

// A body whose possession clauses the AC14 repair deletes, leaving a fact-bearing
// remnant under the VOD floor. Its refusal is `too-few-words` (a depth repair),
// NOT `too-few-facts`, which is what keeps the AC14 filler regeneration legal.
const FILLER_BODY =
  "Real Madrid moves the scoreboard from 1-1 to 2-1 at 0:24 into the clip. The team keeps the ball moving toward the right side of the pitch for a long spell.";

const TEMPLATE_BODY =
  "Real Madrid moves the scoreboard from 1-1 to 2-1 at 0:24 into the clip. Manuel Ordoñez finds the back of the net as the ball enters the net. The clip carries this sequence at 1:21 into the clip. The strike beats the keeper low to his right after Carlos Javier threads the pass through the middle of the pitch.";

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
  return state;
};

describe("ADAAAA-9031 (AC5 / §13.2) — a second call only on a permitted path", () => {
  it("ends a repairable but non-filler refusal on ONE call, with no retry reason", async () => {
    const evidence = goalEvidence();
    const decision = gateSummaryDetail(EMDASH_BODY, evidence);
    // The instrument: this refusal is repairable and produced NO clause drop, so
    // §13.2's repeat path does not apply to it.
    expect(decision.summary).toBeNull();
    expect(decision.droppedClauses).toHaveLength(0);
    expect(decision.violations).toContain("em-dash-chain");

    const { store, patches } = stubStore();
    const f = stubFetch(EMDASH_BODY);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "job-9031",
      highlightId: "row-emdash",
      evidence,
    });
    expect(f.calls()).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.outcome).toBe("dropped");
    const patch = patches.at(-1)!.patch;
    expect(String(patch.summaryGate)).toMatch(/^dropped:/);
    expect(patch.summaryCalls).toBe(1);
    expect(patch.summaryRetryReason).toBeUndefined();
  });

  it("never re-samples `too-few-facts`, even when the row's menu offers two kinds", async () => {
    // ADAAAA-9031 supersedes ADAAAA-8806's `too-few-facts` retry. §13.2 names it a
    // deterministic refusal; the rev-10 VOD leg re-sampled rows `26a58961`,
    // `8f093fad` and `4c65a303` to the identical refusal at $0.0049986 each.
    const evidence = bigPlayEvidence();
    const clockOnly =
      "At 1:21 into the clip, the sequence continues for Barcelona as the passage develops toward the right side of the pitch and the move is worked forward again.";
    const decision = gateSummaryDetail(clockOnly, evidence);
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("too-few-facts");

    const { store, patches } = stubStore();
    const f = stubFetch(clockOnly);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "job-9031",
      highlightId: "row-fact-poor",
      evidence,
    });
    expect(f.calls()).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.outcome).toBe("dropped");
    const patch = patches.at(-1)!.patch;
    expect(patch.summaryCalls).toBe(1);
    expect(patch.summaryRetryReason).toBeUndefined();
  });

  it("keeps AC14's one filler regeneration and records `filler-repair`", async () => {
    const evidence = goalEvidence();
    const first = gateSummaryDetail(FILLER_BODY, evidence);
    expect(first.summary).toBeNull();
    expect(first.droppedClauses.length).toBeGreaterThan(0);
    expect(first.repairedWords).toBeLessThan(SUMMARY_VOD_BAND.floorWords);

    const { store, patches } = stubStore();
    const f = stubFetch(FILLER_BODY);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "job-9031",
      highlightId: "row-filler",
      evidence,
    });
    expect(f.calls()).toBe(2);
    expect(result.outcome).toBe("dropped");
    expect(result.reason).toBe("filler");
    const patch = patches.at(-1)!.patch;
    expect(patch.summaryCalls).toBe(2);
    expect(patch.summaryRetryReason).toBe("filler-repair");
    expect(patch.summary).toBeUndefined();
  });

  it("records `repeat-opening` when the AC8 path regenerates", async () => {
    const evidence = goalEvidence();
    const { store, patches } = stubStore();
    const f = stubFetch(TEMPLATE_BODY.replace("moves the scoreboard from", "moves the scoreboard from"));
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      { jobId: "job-9031", highlightId: "row-opening", evidence },
      stateWith(TEMPLATE_BODY)
    );
    expect(f.calls()).toBe(2);
    expect(result.outcome).toBe("dropped");
    const patch = patches.at(-1)!.patch;
    expect(patch.summaryRetryReason).toBe("repeat-opening");
  });
});

describe("ADAAAA-9031 (AC14.3) — regenerate once, then drop the repeated CLAUSE", () => {
  it("serves the pruned body instead of dropping the row", async () => {
    const evidence = goalEvidence();
    const served = "The clip carries this sequence at 0:24 into the clip. Real Madrid moves the scoreboard from 1-1 to 2-1.";
    const state = stateWith(served);
    // The instrument: the candidate repeats exactly one served sentence.
    const decision = gateSummaryDetail(TEMPLATE_BODY, evidence);
    expect(decision.summary).toBeTruthy();
    expect(summarySentencesOf(decision.summary!).some((s) => s.includes("The clip carries this sequence"))).toBe(true);

    const { store, patches } = stubStore();
    const f = stubFetch(TEMPLATE_BODY);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }),
      { jobId: "job-9031", highlightId: "row-repeat", evidence },
      state
    );

    expect(f.calls()).toBe(2);
    expect(result.outcome).toBe("stored");
    const patch = patches.at(-1)!.patch;
    expect(patch.summaryCalls).toBe(2);
    expect(patch.summaryRetryReason).toBe("repeat-sentence");
    expect(String(patch.summary)).not.toContain("The clip carries this sequence");
    expect((patch.summaryDroppedSentences as number) ?? 0).toBeGreaterThanOrEqual(1);
    // The served body still clears the VOD floor after the clause drop.
    const stored = String(patch.summary);
    expect(stored.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
  });
});

describe("ADAAAA-9031 — the row's own goal confirmation reaches the evidence", () => {
  it("maps `goalConfirmed` onto the gate's attestation", () => {
    const evidence = summaryEvidenceForRow(
      {
        verdict: "scoring_play",
        outcome: "scoring_play",
        eventType: "GOAL",
        trigger: { timestamp: 24, durationS: 8 },
        attestationUsed: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
        goalConfirmed: "confirmed_goal",
      } as any,
      "vod"
    );
    expect(evidence.attestation?.goalConfirmed).toBe("confirmed_goal");
  });

  it("falls back to the confirmation dive's own verdict", () => {
    const evidence = summaryEvidenceForRow(
      {
        verdict: "scoring_play",
        outcome: "scoring_play",
        eventType: "GOAL",
        trigger: { timestamp: 24, durationS: 8 },
        attestationUsed: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
        confirmAttestation: { goalConfirmed: "confirmed_goal" },
      } as any,
      "vod"
    );
    expect(evidence.attestation?.goalConfirmed).toBe("confirmed_goal");
  });
});

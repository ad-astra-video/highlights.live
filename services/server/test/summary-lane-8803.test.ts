// ADAAAA-8803: the summary lane hands the RETRY the gate's own measurement.
//
// Measured on the funded VOD leg of job `4e5ddf8d-d7ab-4a2a-8489-9c2ba14ae734`
// (served build `cdf6445`): row `2f5a5796` was refused `too-few-words` at 28 words,
// retried, re-landed at 34 words and dropped — both calls spent, no body served.
// The retry re-read the same "at least 40 words" line, so it was a second sample of
// the same distribution. The lane now passes the refused draft's measured word and
// sentence counts (and the violation tokens) into the second call.
import { describe, expect, it } from "vitest";
import { summaryOpeningRun, type SummaryEvidence } from "@highlights/events";
import { newSummaryJobState, runSummaryForRow, type SummaryLaneStore } from "../src/summary-lane.js";

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

function stubFetch(answers: (Response | Error)[]) {
  const bodies: string[] = [];
  let i = 0;
  const fn = (async (_url: string, init?: RequestInit) => {
    bodies.push(String((JSON.parse(String(init?.body ?? "{}")) as any).prompt ?? ""));
    const next = answers[Math.min(i, answers.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
  return { fn, calls: () => i, bodies };
}

const ok = (summary: string) =>
  new Response(JSON.stringify({ summary }), { status: 200, headers: { "content-type": "application/json" } });

/** Row `2f5a5796`'s evidence: the job's persisted match context (Barcelona,
 *  away), the stored reason, `trigger.timestamp` 87 and the attested
 *  2-1 -> 2-2 transition. */
const EVIDENCE: SummaryEvidence = {
  rail: "vod",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason:
    "The scoreboard updates from 2-1 to 2-2 at 22:13, and the ASR confirms the goal with 'Salina, y el gol!' at the peak of the audio energy curve.; scoreboard score change confirmed",
  caption: null,
  postTitle: null,
  windowTs: 87,
  windowDurationS: 15,
  scoreTransition: { from: "2-1", to: "2-2" },
  matchContext: { sport: "soccer", teams: [{ name: "Barcelona", side: "away", confidence: 0.85 }] },
  transcript: null,
};

/** The draft the served build stored as `summaryRaw` (34 words, 3 sentences):
 *  one sentence on the clock, one on generic "converts the opportunity" filler. */
const STORED_DRAFT_34 =
  "Barcelona finds the equalizer to level the score at 2-2. This pivotal moment occurs at the 1:27 mark of the clip. The team successfully converts the opportunity to secure a draw in the match.";

/** A repair that clears the new 45-word target with facts, not filler. */
const REPAIRED =
  "Barcelona pulls level at 2-2 as the scoreboard moves on from 2-1 late in this clip. The equaliser lands at the 1:27 mark of the clip. Barcelona works the ball into the box and finishes the move from close range. The scoreline stays at 2-2 as Barcelona keeps possession through the restart.";

const cfg = (over: Record<string, unknown> = {}) => ({
  decideUrl: "http://decide.test",
  decideFee: 0.0033,
  ...over,
});

describe("ADAAAA-8803 — the retry is told the measured shortfall", () => {
  it("passes the refused draft's measurement to the second call and stores the repair", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok(STORED_DRAFT_34), ok(REPAIRED)]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }) as any,
      { jobId: "4e5ddf8d", highlightId: "2f5a5796", evidence: EVIDENCE }
    );
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(2);
    expect(f.bodies).toHaveLength(2);

    // First pass: the band, no RETRY block.
    expect(f.bodies[0]).toContain("aim for 45-55 words");
    expect(f.bodies[0]).not.toContain("RETRY:");

    // Retry: the gate's own numbers, the floor-plus-margin ask, and the fact rule.
    expect(f.bodies[1]).toContain("RETRY: the previous draft measured 34 words across 3 sentences");
    expect(f.bodies[1]).toContain("refused for: too-few-words");
    expect(f.bodies[1]).toContain("this copy must reach at least 45 words");
    expect(f.bodies[1]).toContain("45 is 5 words above the 40-word floor");
    expect(f.bodies[1]).toContain("Expand with facts, not filler");
    expect(f.bodies[1]).toContain("Do NOT spend a whole sentence on the clip clock");

    const stored = patches.find((p) => typeof p.patch.summary === "string");
    expect(stored?.patch.summary).toBe(REPAIRED);
    expect(stored?.patch.summaryCalls).toBe(2);
    expect(stored?.patch.summaryDropped).toBe(0);
    expect(stored?.patch.summaryGate).toBe("accepted");
  });

  it("still drops a retry that stays short, keeping the refused reply as evidence", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok(STORED_DRAFT_34), ok(STORED_DRAFT_34)]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }) as any,
      { jobId: "4e5ddf8d", highlightId: "2f5a5796", evidence: EVIDENCE }
    );
    expect(result.outcome).toBe("dropped");
    expect(result.calls).toBe(2);
    const final = patches[patches.length - 1].patch;
    expect(final.summary).toBeUndefined();
    // ADAAAA-8914 (AC14.5): the stored 34-word draft is filler — its template and
    // its "secure a draw" clause are deleted by the repair, which takes the body
    // under the VOD floor, so the drop is named `filler`.
    expect(final.summaryGate).toBe("dropped:filler");
    expect(final.summaryRaw).toBe(STORED_DRAFT_34);
    expect(final.summaryCalls).toBe(2);
    // The second call carried the escalated instruction, so this drop is the
    // retry's own measured failure, not a repeat of the first pass.
    expect(f.bodies[1]).toContain("this copy must reach at least 45 words");
  });

  it("does not invent a shortfall when the first call was a transport failure", async () => {
    const { store } = stubStore();
    const f = stubFetch([new Error("socket hang up"), ok(REPAIRED)]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }) as any,
      { jobId: "4e5ddf8d", highlightId: "2f5a5796", evidence: EVIDENCE }
    );
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(2);
    // Nothing was measured, so there is no measurement to report.
    expect(f.bodies[1]).not.toContain("RETRY:");
    expect(f.bodies[1]).toContain("aim for 45-55 words");
  });

  it("leaves the AC8 repeat-opening retry without a depth directive", async () => {
    const { store } = stubStore();
    const state = newSummaryJobState();
    // The job already served this body's opening run ON THE SAME WINDOW, so the
    // scoped repeat key (ADAAAA-8969) regenerates once for a body that is a
    // different moment or different copy — the retry carries no depth directive.
    state.servedOpenings.add(summaryOpeningRun(REPAIRED));
    state.servedBodies.push({
      highlightId: "served-before",
      windowTs: EVIDENCE.windowTs ?? null,
      windowDurationS: EVIDENCE.windowDurationS ?? null,
      clockToken: null,
      body: REPAIRED,
      opening: summaryOpeningRun(REPAIRED),
    });
    const f = stubFetch([ok(REPAIRED), ok(REPAIRED.replace("Barcelona pulls level at 2-2", "The away side pulls level at 2-2"))]);
    const result = await runSummaryForRow(
      store,
      cfg({ fetchImpl: f.fn }) as any,
      { jobId: "4e5ddf8d", highlightId: "other", evidence: EVIDENCE },
      state
    );
    // ADAAAA-8969: one instant is one card, so the regeneration cannot save this
    // row and the retry ends in the `repeat` drop — the assertion under test is
    // that the repeat retry carries no depth directive.
    expect(result.outcome).toBe("dropped");
    expect(result.reason).toBe("repeat");
    expect(result.calls).toBe(2);
    expect(f.bodies[1]).toContain("Do not open with any of these already-served runs");
    // The repeat retry names the repeated sentence, and carries no DEPTH directive
    // (nothing measured a shortfall on this row).
    expect(f.bodies[1]).toContain("repeated a sentence another card in this job already carries");
    expect(f.bodies[1]).not.toContain("fell under the depth floor");
  });
});

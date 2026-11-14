// ADAAAA-8971 (AC2 of the increment) — the stored LIVE-rail row that pins the
// ADAAAA-8914 filler shape, on an instrument the lane actually runs.
//
// The VOD lane already had a filler fixture (`packages/events/test/filler-depth-8914
// .test.ts`). The LIVE rail had none, and that is exactly where the rev-8 grade
// (ADAAAA-8924, job `e4c2fe29`) measured the defect: three bodies were SERVED with
// `summaryGate: "accepted"` while each one asserted unattested atmosphere —
// "Barcelona maintains possession and works the ball forward during this
// sequence. At 1:42 into the clip, the team continues their sustained play." — and
// the clock clause named the clip offset as if it were match time (`1:42` vs
// `matchClock.token` 18:12). The row below is that stored row's own bytes
// (`services/server/test/fixtures/8971-live-row-8914.json`, from `deck8924.jsonl`
// and the job's persisted `matchContext`); nothing here is generated.
//
// Two assertions, and they are different layers:
//
//   1. GATE (packages/events): the rev-8 body is refused or neutralised on the
//      LIVE band — it may never be served as filler again.
//   2. LANE (this file): the §15.4 drop fields are still written on the LIVE rail.
//      `summaryDroppedByReason`, `summaryDroppedClauses`, `summaryRepairedWords`
//      and `summaryViolations` are what a live census reads; a live drop that
//      wrote only `summaryGate` would be invisible to the next grade.
//
// This test FAILS on the pre-8914 gate (baseline `c555421`): there the same body
// passes `gateSummaryDetail` and the lane stores it, exactly as the served leg did.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  SUMMARY_LIVE_BAND,
  SUMMARY_MAX_CALLS_PER_ROW,
  gateSummaryDetail,
  summarySentencesOf,
  unattestedSentences,
} from "@highlights/events";
import {
  runSummaryForRow,
  summaryEvidenceForRow,
  type SummaryLaneConfig,
  type SummaryLaneStore,
} from "../src/summary-lane.js";

const ROW = JSON.parse(
  readFileSync(new URL("./fixtures/8971-live-row-8914.json", import.meta.url), "utf8")
) as {
  rail: "live" | "vod";
  jobId: string;
  rowId: string;
  eventType: string;
  verdict: string;
  caption: string | null;
  postTitle: string | null;
  trigger: { timestamp: number; durationS: number };
  matchClock: { token: string; seconds: number; period: string | null; legible: boolean };
  attestationUsed: { scoreBoardChanged: boolean; goalCrossed: boolean; ballOutcome: string | null };
  reason: string;
  matchContext: unknown;
  rev8Summary: string;
  rev8SummaryGate: string;
  rev8WordCount: number;
};

const evidence = () =>
  summaryEvidenceForRow(
    {
      verdict: ROW.verdict,
      eventType: ROW.eventType,
      outcome: ROW.verdict,
      reason: ROW.reason,
      caption: ROW.caption,
      postTitle: ROW.postTitle,
      trigger: ROW.trigger,
      matchClock: ROW.matchClock,
      attestationUsed: ROW.attestationUsed,
      matchContext: ROW.matchContext,
    },
    "live",
    null
  );

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

/** Every reply is the rev-8 body — the retry re-samples the SAME bytes, so a
 *  refused row cannot be served by the stub (the worst case a `$0` replay holds). */
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

// ---------------------------------------------------------------------------
// 1. GATE — the live rail refuses the rev-8 filler body.
// ---------------------------------------------------------------------------
describe("ADAAAA-8971 — the live rail refuses the rev-8 filler body", () => {
  it("is the stored row that was SERVED in rev-8", () => {
    // Guard against the fixture drifting into a row the rev-8 lane dropped: the
    // whole point is that this body was served (`accepted`) with filler in it.
    expect(ROW.rowId).toBe("23f9b28e-7ddc-4694-909f-4fa51d937ee2");
    expect(ROW.rev8SummaryGate).toBe("accepted");
    expect(ROW.rev8Summary).toContain("maintains possession");
    expect(ROW.rev8WordCount).toBe(summarySentencesOf(ROW.rev8Summary).reduce((n, s) => n + s.split(/\s+/).filter(Boolean).length, 0));
  });

  it("refuses it on the LIVE band, and names the possession clause as deleted", () => {
    const decision = gateSummaryDetail(ROW.rev8Summary, evidence());
    expect(SUMMARY_LIVE_BAND.floorWords).toBe(18);
    // Refused (or neutralised) — never served with the atmosphere sentence intact.
    if (decision.summary) {
      expect(unattestedSentences(decision.summary, evidence())).toEqual([]);
      expect(decision.summary).not.toContain("maintains possession");
    } else {
      expect(decision.violations.length).toBeGreaterThan(0);
    }
    expect(decision.droppedClauses.join(" ")).toContain("maintains possession");
    // The substituted sentence carries an attested fact and no atmosphere claim.
    for (const sentence of decision.substitutedClauses) {
      expect(unattestedSentences(sentence, evidence())).toEqual([]);
    }
  });

  it("does not offer the retry a score line this row cannot attest", () => {
    const f = stubFetch(ROW.rev8Summary);
    const { store } = stubStore();
    return runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: ROW.jobId,
      highlightId: ROW.rowId,
      evidence: evidence(),
    }).then((result) => {
      // The row's evidence attests clock + a named actor, never 1-1 -> 2-1.
      expect(result.calls).toBeLessThanOrEqual(SUMMARY_MAX_CALLS_PER_ROW);
      expect(f.prompts.length).toBeGreaterThan(0);
      const retryPrompt = f.prompts[1];
      if (retryPrompt) {
        expect(retryPrompt).not.toContain("the score line carry the most words");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. LANE — the §15.4 drop fields are written on the LIVE rail.
// ---------------------------------------------------------------------------
describe("ADAAAA-8971 — a live drop still carries its census fields", () => {
  it("writes droppedByReason, droppedClauses, repairedWords and violations on the live rail", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch(ROW.rev8Summary);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: ROW.jobId,
      highlightId: ROW.rowId,
      evidence: evidence(),
    });

    expect(result.outcome).toBe("dropped");
    expect(result.calls).toBeLessThanOrEqual(SUMMARY_MAX_CALLS_PER_ROW);
    // The drop keeps the model's own reply for the next census, and never a served body.
    const patch = patches.at(-1)!.patch;
    expect(patch.summary).toBeUndefined();
    expect(String(patch.summaryGate)).toMatch(/^dropped:/);
    expect(patch.summaryDropped).toBe(1);
    // AC5/§15.4: the ordered counter, the deleted-clause count, the honest depth
    // measure and the refusal tokens must all land on the row. `summaryDroppedClauses`
    // is the COUNT the lane persists (the clause TEXT rides `summaryClauseClaims`
    // when the gate reports claims); the count is what the census sums.
    expect(patch.summaryDroppedByReason).toEqual({ [result.reason!]: 1 });
    expect(typeof patch.summaryDroppedClauses).toBe("number");
    expect(patch.summaryDroppedClauses as number).toBeGreaterThanOrEqual(1);
    expect(typeof patch.summaryRepairedWords).toBe("number");
    expect(patch.summaryRepairedWords as number).toBeLessThan(ROW.rev8WordCount);
    expect(patch.summaryFloorWords).toBe(SUMMARY_LIVE_BAND.floorWords);
    expect(Array.isArray(patch.summaryViolations)).toBe(true);
    expect(patch.summaryViolations as string[]).toContain("unattested-sentence");
    expect(patch.summaryCalls).toBe(result.calls);
  });
});

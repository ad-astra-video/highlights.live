// ADAAAA-8735: the LIVE promotion seam must hand the summary lane the JOB's
// matchContext. The row record itself carries none (it lives on the job), so
// without this wiring the rev-4 AC9 action fact could never be credited on the
// live rail: every body would attest the clock only and refuse `too-few-facts`.
//
// This is the integration falsifier, not a unit of the mapper: it calls the real
// `requestHighlightSummary` → `summaryLaneFor` → `runSummaryForRow` path and
// reads the prompt the lane actually sent.
import { afterEach, describe, expect, it } from "vitest";
import { dropSummaryLane, requestHighlightSummary, summaryLaneFor } from "../src/api.js";
import {
  SUMMARY_LIVE_BAND,
  frameOpenerOf,
  summarySentencesOf,
  summaryWordCount,
} from "@highlights/events";
import type { HighlightRecord } from "@highlights/events";

const JOB_ID = "job-8735-match-context";

const record = (id: string): HighlightRecord =>
  ({
    id,
    jobId: JOB_ID,
    status: "accepted",
    verdict: "big_play",
    outcome: "big_play",
    eventType: "BIG_PLAY",
    reason: "Ball shoots on the right.",
    caption: "Ball shoots on the right.",
    postTitle: null,
    start: 203,
    end: 211,
    trigger: { timestamp: 203, durationS: 8 },
  }) as unknown as HighlightRecord;

function deps(jobMatchContext: unknown) {
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  const store: any = {
    getJob: () => ({ id: JOB_ID, matchContext: jobMatchContext }),
    patchHighlightSummary: async (id: string, patch: Record<string, unknown>) => {
      patches.push({ id, patch });
      return {};
    },
  };
  const cfg: any = {
    summaryLaneEnabled: true,
    decideUrl: "http://decide.test",
    decideFee: 0.01,
    summaryFee: null,
  };
  return { deps: { store, cfg } as any, patches };
}

const ok = (summary: string) =>
  new Response(JSON.stringify({ summary }), { status: 200, headers: { "content-type": "application/json" } });

// ADAAAA-8914 (AC14.1): both sentences carry a fact — the old second sentence
// ("This action occurs during the match as the play develops toward the wing.")
// asserts nothing and is deleted by the clause repair.
const NAMED_BODY =
  "At 3:23, Northbridge shoot on the right side of the field. Northbridge keeps possession as the play develops toward the wing.";
const BARE_BODY =
  "At 3:23, the ball shoots on the right side of the field. This action occurs during the match as the play develops toward the wing.";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  dropSummaryLane(JOB_ID);
});

function stubFetch(summary: string): { prompts: string[] } {
  const prompts: string[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    prompts.push(JSON.parse(init.body).prompt);
    return ok(summary);
  }) as unknown as typeof fetch;
  return { prompts };
}

describe("the live promotion seam passes the job's matchContext to the summary lane", () => {
  it("renders the job's teams into the prompt and stores a body that names one", async () => {
    const { deps: d, patches } = deps({ teams: [{ name: "Northbridge" }, { name: "Riverside" }] });
    const { prompts } = stubFetch(NAMED_BODY);
    requestHighlightSummary(d, record("h1"), "live");
    const lane = summaryLaneFor(d, JOB_ID);
    expect(lane).toBeDefined();
    await lane!.idle();

    expect(prompts[0]).toContain("Match context:\nTeams: Northbridge vs Riverside");
    // ADAAAA-9052 rewrites the SECOND sentence (the possession clause is filler,
    // so the repair deletes it and fills the slot from the row's own evidence),
    // so the served body is the repair's. Pin the structural contract instead of
    // a byte-equal NAMED_BODY: the writer's lead survives, the body names an
    // attested team, stays in the AC1 live band, keeps the row's clock, and never
    // opens on the frame (ADAAAA-9083's AC15).
    const served = patches[0].patch.summary as string;
    expect(typeof served).toBe("string");
    expect(patches[0].patch.summaryGate).toBe("neutralised");
    expect(patches[0].patch.summaryDropped).toBe(0);
    const sentences = summarySentencesOf(served);
    expect(sentences[0]).toBe(summarySentencesOf(NAMED_BODY)[0]);
    expect(sentences.length).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.minSentences);
    expect(sentences.length).toBeLessThanOrEqual(SUMMARY_LIVE_BAND.maxSentences);
    expect(summaryWordCount(served)).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.floorWords);
    expect(frameOpenerOf(served)).toBeNull();
    expect(served).toContain("Northbridge");
    expect(served).toContain("3:23");
  });

  it("refuses a bare-verb body when the job carries no matchContext (the pre-8736 shape)", async () => {
    const { deps: d, patches } = deps(null);
    const { prompts } = stubFetch(BARE_BODY);
    requestHighlightSummary(d, record("h2"), "live");
    await summaryLaneFor(d, JOB_ID)!.idle();

    expect(prompts[0]).toContain("Match context:\n(none)");
    // Rev 3 credited `clock + action` off the word `Ball` here; rev 4 refuses.
    expect(patches[0].patch.summary).toBeUndefined();
    expect(patches[0].patch.summaryGate).toBe("dropped:gate");
    expect(patches[0].patch.summaryRaw).toBe(BARE_BODY);
  });

  it("refuses a bare-verb body even with the teams present", async () => {
    const { deps: d, patches } = deps({ teams: [{ name: "Northbridge" }] });
    stubFetch(BARE_BODY);
    requestHighlightSummary(d, record("h3"), "live");
    await summaryLaneFor(d, JOB_ID)!.idle();
    expect(patches[0].patch.summary).toBeUndefined();
    // The clause repair DOES run here — the row attests two fact kinds — and its
    // remainder clears the 18-word serve floor (`summaryRepairedWords` 22), so the
    // refusal is a FACT refusal, not a depth one: ADAAAA-8914's `filler` name no
    // longer applies and the drop is named `gate`. The AC9 signal is still on the
    // row: §15.4's `summaryViolations` carries `too-few-facts`.
    expect(patches[0].patch.summaryGate).toBe("dropped:gate");
    expect(patches[0].patch.summaryViolations).toEqual(
      expect.arrayContaining(["too-few-facts"])
    );
    expect(patches[0].patch.summaryDroppedByReason).toEqual({ gate: 1 });
    // The repair's own depth measure, so "this is a fact refusal" is asserted and
    // not just narrated: the remainder is at or above the live serve floor.
    expect(patches[0].patch.summaryRepairedWords).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.floorWords);
    expect(patches[0].patch.summaryRaw).toBe(BARE_BODY);
  });
});

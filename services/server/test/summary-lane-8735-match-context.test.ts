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

const NAMED_BODY =
  "At 3:23, Northbridge shoot on the right side of the field. This action occurs during the match as the play develops toward the wing.";
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
    expect(patches[0].patch.summary).toBe(NAMED_BODY);
    expect(patches[0].patch.summaryGate).toBe("accepted");
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
    expect(patches[0].patch.summaryGate).toBe("dropped:gate");
    expect(patches[0].patch.summaryRaw).toBe(BARE_BODY);
  });
});

// ADAAAA-9464 (writer round 4) — the LANE's half: the target refusal takes the ONE
// AC5 retry, and nothing in the decide loop moves.
//
// ADAAAA-9031 pinned a depth refusal to ONE call. ADAAAA-9464 supersedes that for
// the DEPTH class only, because the measured defect is the served distribution
// itself (job `798f21c2`: p50 19 against AC1's 25): a 19-word body must not serve
// unless the writer has had one chance to answer at the target. The ceiling is
// unchanged — `SUMMARY_MAX_CALLS_PER_ROW` stays 2, no third inference — and a row
// whose evidence cannot fill the target keeps the one-call drop.
import { describe, expect, it } from "vitest";
import { SUMMARY_MAX_CALLS_PER_ROW, type SummaryEvidence } from "@highlights/events";
import { runSummaryForRow, type SummaryLaneConfig, type SummaryLaneStore } from "../src/summary-lane.js";

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
  const fn = (async (_url: string, init?: RequestInit) => {
    prompts.push(String((JSON.parse(String(init?.body ?? "{}")) as { prompt?: string }).prompt ?? ""));
    const summary = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, prompts, calls: () => index };
}

const cfg = (over: Record<string, unknown> = {}) =>
  ({ decideUrl: "http://decide.test", decideFee: 0.0033, log: () => {}, ...over }) as SummaryLaneConfig;

/** A live row with `clock` + `action` (two fact kinds): the smallest proportional
 *  row, exactly the rev-19 shape. */
const liveRow = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "live",
  verdict: "big_play",
  eventType: "BIG_PLAY",
  reason: null,
  caption: null,
  postTitle: "BIG PLAY · 0:12",
  windowTs: 12,
  windowDurationS: 15,
  scoreTransition: null,
  matchContext: { sport: "soccer", teams: [{ name: "Barcelona", side: "away" }] },
  transcript: null,
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
  matchClock: { token: "11:31", seconds: 691, period: null, legible: true },
  ...over,
});

/** 19 words, two facts — the served rev-19 shape (`03cdc053` on job `798f21c2`). */
const NINETEEN =
  "Barcelona dispossesses the ball at 11:31 of the match. The clip carries this sequence at 11:31 into the clip.";
/** 29 words, two facts: clears the target on the second sample. */
const TWENTY_NINE =
  "Barcelona dispossesses the ball at 11:31 of the match and turns the passage into a counter. Barcelona recovers the ball near the box and clears it upfield at 11:31 into the clip.";

describe("ADAAAA-9464 — the depth refusal takes the ONE AC5 retry", () => {
  it("re-samples a 19-word reply once with a 25-word directive, then serves the repair", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([NINETEEN, TWENTY_NINE]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "job-9464",
      highlightId: "row-9464",
      evidence: liveRow(),
    });
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(2);
    expect(f.calls()).toBe(2);
    // The second sample is TOLD the measured shortfall and the target.
    expect(f.prompts[1]).toContain("RETRY: the previous draft measured 19 words");
    expect(f.prompts[1]).toContain("refused for: too-few-words");
    expect(f.prompts[1]).toContain("this copy must reach at least 25 words");
    const patch = patches.at(-1)!.patch;
    expect(patch.summaryCalls).toBe(2);
    expect(patch.summaryRetryReason).toBe("depth-repair");
    expect(patch.summaryDropped).toBe(0);
    expect(patch.summary).toBe(TWENTY_NINE);
  });

  it("serves the writer's body at the FLOOR when the second sample is still short", async () => {
    // 19 words is above the 18-word floor, so the AC5 slot is spent and the row
    // serves its own copy rather than losing the card. The row reads
    // `summaryCalls: 2` + `depth-repair` + a word count under the target, which is
    // how a census finds a below-target serve.
    const { store, patches } = stubStore();
    const f = stubFetch([NINETEEN, NINETEEN]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "job-9464",
      highlightId: "row-9464-floor",
      evidence: liveRow(),
    });
    expect(result.calls).toBe(2);
    expect(f.calls()).toBe(2);
    const patch = patches.at(-1)!.patch;
    expect(patch.summary).toBe(NINETEEN);
    expect(patch.summaryWordCount).toBeUndefined();
    expect(patch.summaryCalls).toBe(2);
    expect(patch.summaryRetryReason).toBe("depth-repair");
    expect(patch.summaryDropped).toBe(0);
  });

  it("serves a body at the target on ONE call, with no retry reason", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([TWENTY_NINE]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "job-9464",
      highlightId: "row-9464-clean",
      evidence: liveRow(),
    });
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(1);
    expect(patches.at(-1)!.patch.summary).toBe(TWENTY_NINE);
    expect(patches.at(-1)!.patch.summaryRetryReason).toBeUndefined();
  });

  it("never bills a third call, even when the writer keeps answering short", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([NINETEEN, NINETEEN, TWENTY_NINE]);
    await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "job-9464",
      highlightId: "row-9464-ceiling",
      evidence: liveRow(),
    });
    expect(SUMMARY_MAX_CALLS_PER_ROW).toBe(2);
    expect(f.calls()).toBe(2);
    expect(patches.at(-1)!.patch.summaryCalls).toBe(2);
  });

  it("keeps the one-call drop on a row whose evidence cannot fill the target (< 2 kinds)", async () => {
    const { store } = stubStore();
    const f = stubFetch([NINETEEN, TWENTY_NINE]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }), {
      jobId: "job-9464",
      highlightId: "row-9464-clock-only",
      evidence: liveRow({ matchContext: null, matchClock: null, attestation: null, verdict: "celebration", eventType: "CELEBRATION" }),
    });
    // Not a depth retry: the row's fact menu is the bar, and the AC5 slot is not
    // spent on a prompt it cannot satisfy (ADAAAA-8971 / AC2's exemption).
    expect(f.calls()).toBe(1);
    expect(result.outcome).toBe("dropped");
  });
});

// ADAAAA-8791: a VOD draft under the 40-word target is refused `too-few-words`
// (non-deterministic), so the lane's existing ONE retry slot re-samples it and
// only a target-length body is ever stored; a row that stays short drops rather
// than serving thin copy. Measured defect: job `a200d2bd` promoted row
// `0526c296` served 36 words as `accepted` because the old floor was 30.
import { describe, expect, it } from "vitest";
import type { SummaryEvidence } from "@highlights/events";
import { runSummaryForRow, type SummaryLaneStore } from "../src/summary-lane.js";

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

function stubFetch(answers: Response[]) {
  const bodies: string[] = [];
  let i = 0;
  const fn = (async (_url: string, init?: RequestInit) => {
    bodies.push(String((JSON.parse(String(init?.body ?? "{}")) as any).prompt ?? ""));
    const next = answers[Math.min(i, answers.length - 1)];
    i++;
    return next.clone();
  }) as unknown as typeof fetch;
  return { fn, calls: () => i, bodies };
}

const ok = (summary: string) =>
  new Response(JSON.stringify({ summary }), { status: 200, headers: { "content-type": "application/json" } });

const EVIDENCE: SummaryEvidence = {
  rail: "vod",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason:
    "The scoreboard changes from 1-1 to 2-1 at 18:06, and the ASR confirms 'Acaba de marcar el Real Madrid' while the frames show a player in a white kit (Real Madrid) celebrating.; scoreboard score change confirmed",
  caption: null,
  postTitle: null,
  windowTs: 87,
  windowDurationS: 15,
  scoreTransition: { from: "2-1", to: "2-2" },
  matchContext: { teams: [{ name: "Barcelona", side: "away" }] },
  transcript: null,
};

const SHORT =
  "Barcelona finds the back of the net to level the score at 2-2. The crowd erupts in celebration as the scoreboard updates during this scoring play. This goal occurs at the 1:27 mark of the clip.";

const LONG =
  "Barcelona levels the scoring play at 2-2 with a strike that the scoreboard confirms at the 1:27 mark of the clip. The away side's players wheel away toward the near touchline as the crowd answers the goal. The restart comes quickly, with Barcelona still pressing high in the closing minutes. The bench is on its feet and the celebration carries through the next passage of play.";

const cfg = (over: Record<string, unknown> = {}) => ({
  decideUrl: "http://decide.test",
  decideFee: 0.0033,
  ...over,
});

describe("ADAAAA-8791 — the retry slot repairs a sub-target VOD draft", () => {
  it("retries the 36-word draft once and serves a target-length body", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok(SHORT), ok(LONG)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }) as any, {
      jobId: "a200d2bd",
      highlightId: "0526c296",
      evidence: EVIDENCE,
    });
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(2);
    // ADAAAA-8803: the retry no longer re-reads the first-pass line. It is told
    // the measured shape of the refused draft and asks for the floor plus a
    // margin, so a boundary draft cannot re-land under it.
    expect(f.bodies[0]).toContain("aim for 45-55 words");
    expect(f.bodies[1]).toContain("RETRY: the previous draft measured");
    expect(f.bodies[1]).toContain("this copy must reach at least 45 words");
    expect(f.bodies[1]).toContain("too-few-words");
    const stored = patches.find((p) => typeof p.patch.summary === "string");
    expect(stored?.patch.summary).toBe(LONG);
    expect(String(stored?.patch.summary).split(/\s+/).length).toBeGreaterThanOrEqual(40);
    expect(stored?.patch.summaryCalls).toBe(2);
    expect(stored?.patch.summaryDropped).toBe(0);
  });

  it("drops rather than serving a body that stays under the target", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok(SHORT), ok(SHORT)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }) as any, {
      jobId: "a200d2bd",
      highlightId: "0526c296",
      evidence: EVIDENCE,
    });
    expect(result.outcome).toBe("dropped");
    expect(result.calls).toBe(2);
    const final = patches[patches.length - 1].patch;
    expect(final.summary).toBeUndefined();
    expect(final.summaryGate).toBe("dropped:gate");
    expect(final.summaryDropped).toBe(1);
    // The refused reply is kept as evidence, never served.
    expect(final.summaryRaw).toBe(SHORT);
  });

  it("keeps a deterministic refusal on ONE call when the ROW cannot nourish a second fact", async () => {
    // ADAAAA-8806 refined the rule this test pins: `too-few-facts` is
    // deterministic only when the row's own evidence attests fewer than two fact
    // types. Here the evidence carries no score transition and no attested actor,
    // so the menu is ONE kind (the clock) and a second sample cannot repair it.
    const { store } = stubStore();
    const factPoor: SummaryEvidence = {
      ...EVIDENCE,
      scoreTransition: null,
      matchContext: null,
      transcript: null,
    };
    const clockOnly = "The clip lands at the 1:27 mark of the sequence and nothing else is attested here at all.";
    const f = stubFetch([ok(clockOnly)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }) as any, {
      jobId: "a200d2bd",
      highlightId: "x",
      evidence: factPoor,
    });
    expect(result.calls).toBe(1);
    expect(result.outcome).toBe("dropped");
  });

  it("spends the retry slot when the row DOES attest two facts (ADAAAA-8806)", async () => {
    // The measured case: a clock-only draft on a row whose `matchContext` attests
    // Barcelona is a sampling miss, not a property of the row.
    const { store } = stubStore();
    const clockOnly = "The clip lands at the 1:27 mark of the sequence and nothing else is attested here at all.";
    const f = stubFetch([ok(clockOnly), ok(LONG)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }) as any, {
      jobId: "a200d2bd",
      highlightId: "y",
      evidence: EVIDENCE,
    });
    expect(result.calls).toBe(2);
    expect(result.outcome).toBe("stored");
    expect(f.bodies[1]).toContain("fact-poor");
  });
});

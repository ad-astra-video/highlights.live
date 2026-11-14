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

// ADAAAA-8914 (AC14.1/AC14.2): the served 36-word body's crowd clause is deleted
// by the clause repair, so the SHORT fixture is the fact-only remnant of it — still
// under the VOD band, which is what this ticket pins.
const SHORT =
  "Barcelona finds the back of the net to level the score at 2-2. This goal occurs at the 1:27 mark of the clip.";

// ADAAAA-8914 (AC14.1): the retry's target-length body names Barcelona and relays
// a fact in every sentence (the old fixture spent three sentences on the crowd, the
// bench and the celebration, which the repair deletes).
// ADAAAA-8934: the retry body carries BOUNDED acts (interception / recovery) as its
// second fact type; possession/pressure prose is deleted by the clause repair.
const LONG =
  "Barcelona levels the scoring play at 2-2 with a strike that the scoreboard confirms at the 1:27 mark of the clip. Real Madrid intercepts the ball near the touchline at 1:27 into the clip. Barcelona recovers the ball and threads a pass into the box at 1:31 of the clip. The scoreboard stays level at 2-2 as the clip runs past 1:27.";

const cfg = (over: Record<string, unknown> = {}) => ({
  decideUrl: "http://decide.test",
  decideFee: 0.0033,
  ...over,
});

// ADAAAA-9031 (AC5 / spec §13.2) supersedes the retry expectations this file was
// written against. §13.2 permits a second summary call ONLY on the AC8 repeat path
// (AC14 adds the filler-clause regeneration); a depth refusal is neither, so a
// sub-target draft now ends the row on ONE call and the card keeps its headline.
// The rev-10 VOD grade measured exactly the old shape: 11 of 22 rows billed two
// calls, only 4 of them on the repeat path, and 3 served rows recorded no reason
// at all. The prompt-side shaping the old tests asserted (`RETRY: …`) is still
// exercised on the repeat/filler paths in `summary-lane-9031.test.ts`.
describe("ADAAAA-9031 (AC5 §13.2) — a sub-target draft ends the row on ONE call", () => {
  it("does not re-sample the 36-word draft, and keeps its bytes as evidence", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok(SHORT), ok(LONG)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }) as any, {
      jobId: "a200d2bd",
      highlightId: "0526c296",
      evidence: EVIDENCE,
    });
    expect(result.outcome).toBe("dropped");
    expect(result.calls).toBe(1);
    expect(f.calls()).toBe(1);
    const final = patches[patches.length - 1].patch;
    expect(final.summary).toBeUndefined();
    expect(final.summaryGate).toMatch(/^dropped:/);
    expect(final.summaryDropped).toBe(1);
    expect(final.summaryCalls).toBe(1);
    expect(final.summaryRetryReason).toBeUndefined();
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

  it("also ends a clock-only draft on ONE call when the row DOES attest two facts", async () => {
    // ADAAAA-9031 reverses ADAAAA-8806's `too-few-facts` retry: §13.2 names the
    // AC8 repeat path as the only permitted second call, and the grade measured
    // the live/VOD cost of re-sampling a deterministic refusal. The row still
    // drops; the reason on the row is now the gate's, with no retry billed.
    const { store, patches } = stubStore();
    const clockOnly = "The clip lands at the 1:27 mark of the sequence and nothing else is attested here at all.";
    const f = stubFetch([ok(clockOnly), ok(LONG)]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }) as any, {
      jobId: "a200d2bd",
      highlightId: "y",
      evidence: EVIDENCE,
    });
    expect(result.calls).toBe(1);
    expect(result.outcome).toBe("dropped");
    const final = patches[patches.length - 1].patch;
    expect(final.summaryRetryReason).toBeUndefined();
  });
});

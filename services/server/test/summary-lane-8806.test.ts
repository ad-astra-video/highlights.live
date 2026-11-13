// ADAAAA-8806: the `too-few-facts` retry policy and the attested-action bars on
// the summary lane.
//
// Measured cause on live job `3740585f` (served build `cdf6445`):
//   - row `2d8e9521` dropped after ONE call with `too-few-facts`, although its
//     own `matchContext` attested Barcelona and the clock was legible — the
//     block's evidence offered two fact types, so the thin reply was a sampling
//     miss, not a deterministic refusal.
//   - row `6ff00ac9` dropped `too-few-facts`/`restates-caption` while its body
//     was the only surface naming the entity.
import { describe, expect, it } from "vitest";
import { runSummaryForRow, type SummaryLaneStore } from "../src/summary-lane.js";
import { buildSummaryPrompt, summaryRefusalIsRepairable } from "@highlights/events";

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

function stubFetch(summaries: string[]) {
  let i = 0;
  const seen: any[] = [];
  const fn = (async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    const summary = summaries[Math.min(i, summaries.length - 1)];
    i++;
    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, seen, calls: () => i };
}

const cfg = (over: Record<string, unknown> = {}) => ({
  decideUrl: "http://decide.test",
  decideFee: 0.01,
  ...over,
});

/** Row `2d8e9521`'s evidence: a celebration row, clock anchor, Barcelona attested,
 *  no measured score transition. */
const celebrationEvidence = () => ({
  rail: "live" as const,
  verdict: "big_play",
  reason: "Scoreboard changes to 2-1.",
  caption: "Scoreboard changes to 2-1.",
  postTitle: null,
  windowTs: 15.306,
  windowDurationS: 5,
  scoreTransition: null,
  matchContext: {
    sport: "soccer",
    teams: [{ name: "Barcelona", side: "away", confidence: 0.5 }],
  },
  transcript: null,
  adjacentScoreCue: null,
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
});

/** Clock-only filler — exactly the reply that dropped both rows. */
const CLOCK_ONLY =
  "At 0:25, the action intensifies as the players compete for possession. This sequence captures a significant moment of play as both teams fight for control.";

// ADAAAA-8914 (AC14.1): the second sentence now carries the attested actor's
// play; "The crowd stays loud through the whole sequence." is an atmosphere
// clause the repair deletes (and it took the body under the live floor).
// ADAAAA-8934: the second fact is a BOUNDED act. "keeps possession through the
// next passage" is a sustained state no channel measures, so the repair deletes it.
const NAMED =
  "At 0:25, Barcelona drives forward as the team pushes toward the opponent's side of the pitch. Barcelona intercepts the ball near the wing at 0:25 of the clip.";

describe("ADAAAA-8806 — a repairable refusal earns the retry slot", () => {
  it("retries a clock-only reply when the row attests a second fact type", async () => {
    const { store, patches } = stubStore();
    const { fn, seen, calls } = stubFetch([CLOCK_ONLY, NAMED]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: fn }) as any, {
      jobId: "3740585f",
      highlightId: "2d8e9521",
      evidence: celebrationEvidence(),
    });
    expect(result.outcome).toBe("stored");
    expect(calls()).toBe(2);
    expect(patches.at(-1)?.patch.summary).toContain("Barcelona");
    // The retry is a REPAIR instruction: it carries the refused violation and the
    // attested actor to name.
    expect(seen[1].prompt).toContain("fact-poor");
    expect(seen[1].prompt).toContain("NAME Barcelona");
  });

  it("still ends on ONE call when the row cannot nourish two fact types", async () => {
    const { store, patches } = stubStore();
    const { fn, calls } = stubFetch([CLOCK_ONLY, NAMED]);
    const evidence = { ...celebrationEvidence(), matchContext: null };
    const result = await runSummaryForRow(store, cfg({ fetchImpl: fn }) as any, {
      jobId: "3740585f",
      highlightId: "no-menu",
      evidence,
    });
    expect(result.outcome).toBe("dropped");
    expect(calls()).toBe(1);
    // A gate refusal is metered under the lane's `gate` reason (the violation
    // token stays in the log/`summaryGate`).
    expect(patches.at(-1)?.patch.summaryDroppedByReason).toEqual({ gate: 1 });
  });

  it("classifies the refusal by the row's own fact menu", () => {
    const withEntity = celebrationEvidence() as any;
    const without = { ...celebrationEvidence(), matchContext: null } as any;
    expect(summaryRefusalIsRepairable("too-few-facts", withEntity)).toBe(true);
    expect(summaryRefusalIsRepairable("too-few-facts", without)).toBe(false);
    // The two hard refusals stay deterministic on every row.
    expect(summaryRefusalIsRepairable("ungrounded-name", withEntity)).toBe(false);
    expect(summaryRefusalIsRepairable("internal-token", withEntity)).toBe(false);
  });
});

describe("ADAAAA-8806 — the prompt carries the row's attestation", () => {
  it("tells the model nothing measured happened to the ball", () => {
    const prompt = buildSummaryPrompt(celebrationEvidence() as any);
    expect(prompt).toContain("No ball outcome was measured in this window");
    expect(prompt).toContain("Barcelona");
    expect(prompt).not.toContain("The ball shoots");
  });
});

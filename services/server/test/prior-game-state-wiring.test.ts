import { describe, it, expect } from "vitest";
import { observeDecideOnly, LiveRunShared } from "../src/analyzer";
import type { AnalyzerConfig, DecisionResult } from "../src/analyzer";
import type { ObserveDecidePayload } from "../src/observe-loop";

// ADAAAA-7938 (Spec A): the block must reach the SECOND window's decide REQUEST
// through the real decide path (`observeDecideOnly`), not just when the state is
// noted by hand. This is the wiring the VOD observe pass actually uses.

function payload(centerTs: number): ObserveDecidePayload {
  return {
    centerTs,
    frames: [{ ts: centerTs, imageB64: "f", seq: Math.round(centerTs) }],
    seeds: [],
    biasHints: [],
    capped: false,
    droppedCount: 0,
  };
}

const cfg = {
  jobId: "job-1",
  gameHint: "soccer",
  decideWindowN: 24,
  audioContext: false,
  preferLabels: [],
  confirmEnabled: false,
} as unknown as AnalyzerConfig;

describe("ADAAAA-7938 prior state through observeDecideOnly", () => {
  it("puts the block on window 2 and not on window 1", async () => {
    const seen: any[] = [];
    const client = {
      decide: async (_evidence: any, opts: any) => {
        seen.push(opts);
        return {
          isHighlight: false,
          score: 0,
          outcome: "not_highlight",
          eventType: "SPORTING_EVENT",
          runningSummary: "Goal at 42s: Ronaldo makes it 1-0 Portugal.",
          analysis: { prompt: "p", dataItems: [], frames: [], images: [], asr: { transcript: "it's 1-0 Portugal" } },
        } as DecisionResult;
      },
      confirm: async () => ({}),
    } as any;
    const run = new LiveRunShared({ decideWindowN: 24 });
    await observeDecideOnly(client, run, cfg, "sess", payload(0));
    await observeDecideOnly(client, run, cfg, "sess", payload(3));
    expect(seen.length).toBe(2);
    expect(seen[0].priorGameState).toBeUndefined();
    expect(seen[1].priorGameState).toBeDefined();
    expect(seen[1].priorGameState.story).toContain("1-0 Portugal");
    expect(seen[1].priorGameState.priorAsr).toContain("1-0 Portugal");
  });
});

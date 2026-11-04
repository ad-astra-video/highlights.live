import { describe, it, expect } from "vitest";
import { OrchestratorAdapter } from "../src/livepeer-adapter";
import type { ServerConfig } from "../src/config";

// ADAAAA-7938 (Spec A) + the ADAAAA-7111 carriage bug it exposed: the VOD pass
// decides through the go-livepeer ORCHESTRATOR client, not the plain HTTP one.
// That payload builder never carried `storySoFar` (so every VOD window was
// decided with no story — 0 of 30 prompts on job fe0e3efc) and, before this
// change, would have dropped `priorGameState` too. Pin the payload here so the
// rail that actually runs cannot silently lose the block.

function capture() {
  const seen: any[] = [];
  const adapter = new OrchestratorAdapter({ orchestratorUrl: "http://127.0.0.1:1" } as unknown as ServerConfig);
  (adapter as any).client = {
    decide: async (_route: string, payload: any) => {
      seen.push(payload);
      return { status: 200, data: { isHighlight: false, score: 0 } };
    },
  };
  return { adapter, seen };
}

const EVIDENCE = { eventType: "SPORTING_EVENT", trackCount: 3, maxVelocity: 0.5, ocrHits: 16 };
const PRIOR = {
  story: "Goal at 42s: Ronaldo makes it 1-0 Portugal.",
  priorAsr: "it's 1-0 Portugal",
  score: "1-0",
  lastScoreTs: 42.4,
  needsNewScore: true,
  sinceLastScoreS: 5.6,
};

describe("orchestrator decide payload carries prior game state (ADAAAA-7938)", () => {
  it("forwards priorGameState and storySoFar when set", async () => {
    const { adapter, seen } = capture();
    await adapter.decide(EVIDENCE as any, { jobId: "j", gameHint: "soccer", priorGameState: PRIOR as any, storySoFar: "story" });
    expect(seen.length).toBe(1);
    expect(seen[0].priorGameState).toEqual(PRIOR);
    expect(seen[0].storySoFar).toBe("story");
  });

  it("adds NO key when the pass has no measured state (byte-identical payload)", async () => {
    const { adapter, seen } = capture();
    await adapter.decide(EVIDENCE as any, { jobId: "j", gameHint: "soccer" });
    expect(seen.length).toBe(1);
    expect("priorGameState" in seen[0]).toBe(false);
    expect("storySoFar" in seen[0]).toBe(false);
  });
});

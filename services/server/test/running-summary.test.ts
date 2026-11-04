// ADAAAA-7111 (Increment D): server wiring for the running video summary
// (story-so-far) carried across cadence decide ticks. Covers:
//   (a) `buildObserveDecideRequest` forwards the job's current running summary
//       as `opts.storySoFar` so the decide brain EXTENDS it;
//   (b) `nextRunningSummary` decides when to persist (only on change, bounded).
import { describe, it, expect } from "vitest";
import { buildObserveDecideRequest, captionGroundingForDecision, nextRunningSummary, type DecisionResult } from "../src/analyzer";
import { groundCaption } from "@highlights/events";
import { assembleObserveWindow, buildObservePayload, type ObserveDecidePayload } from "../src/observe-loop";

function basePayload(): ObserveDecidePayload {
  const win = assembleObserveWindow(
    [{ ts: 0, imageB64: "a" }, { ts: 1, imageB64: "b" }, { ts: 2, imageB64: "c" }],
    1,
    { windowS: 10, maxFrames: 30, fps: 2 }
  );
  return buildObservePayload(win, new Map(), []);
}

describe("buildObserveDecideRequest running summary (ADAAAA-7111)", () => {
  it("forwards the job's current running summary as storySoFar when available", () => {
    const cfg: any = { gameHint: "soccer", jobId: "j1", getRunningSummary: () => "prior story" };
    const run: any = { evidence: { maxVelocity: 0.5 } };
    const req = buildObserveDecideRequest(cfg, run, basePayload());
    expect(req.opts?.storySoFar).toBe("prior story");
  });

  it("defaults storySoFar to '' when no prior summary exists", () => {
    const cfg: any = { gameHint: "soccer", jobId: "j1" };
    const run: any = { evidence: { maxVelocity: 0.5 } };
    const req = buildObserveDecideRequest(cfg, run, basePayload());
    expect(req.opts?.storySoFar).toBe("");
  });
});

describe("nextRunningSummary (ADAAAA-7111)", () => {
  it("returns the updated summary when it changed vs the prior", () => {
    const dec: DecisionResult = { isHighlight: false, score: 0, runningSummary: "story grew" };
    expect(nextRunningSummary("story", dec)).toBe("story grew");
  });

  it("returns null when the summary is unchanged (no redundant write)", () => {
    const dec: DecisionResult = { isHighlight: false, score: 0, runningSummary: "same" };
    expect(nextRunningSummary("same", dec)).toBeNull();
  });

  it("returns null when the decision carries no running summary", () => {
    const dec: DecisionResult = { isHighlight: false, score: 0 };
    expect(nextRunningSummary(undefined, dec)).toBeNull();
    expect(nextRunningSummary("story", { isHighlight: false, score: 0, runningSummary: "" })).toBeNull();
  });
});

// ADAAAA-7957 (Inc 5, contract v3 §3.2): the summary seam's grounding context is
// the NAME gate's only evidence source on the live rail. The v2 build passed
// `promptText: null` whenever the decide analysis was absent, which the gate
// reads as "already certified upstream" — so the gate never ran and two invented
// names reached a caption (level 9fecca77, g37/g56). An absent prompt is `""`
// (no evidence => fail closed), never `null`.
describe("captionGroundingForDecision (ADAAAA-7957)", () => {
  it("carries the window's own prompt when the decide analysis captured one", () => {
    const ctx = captionGroundingForDecision({
      outcome: "not_highlight",
      eventType: "SPORTING_EVENT",
      analysis: { prompt: "Match context: RMA 1-1 BAR | ASR: (empty)" } as any,
    });
    expect(ctx.promptText).toBe("Match context: RMA 1-1 BAR | ASR: (empty)");
    expect(ctx.verdict).toBe("not_highlight");
  });

  it("fails closed with an EMPTY prompt (not null) when the analysis is absent", () => {
    const ctx = captionGroundingForDecision({ outcome: "not_highlight", eventType: "AUDIO_BURST" });
    expect(ctx.promptText).toBe("");
    expect(ctx.promptText).not.toBeNull();
  });

  it("a name on an analysis-less window is replaced by a role end to end", () => {
    const ctx = captionGroundingForDecision({ outcome: "not_highlight" });
    const out = groundCaption("Manuel Ordoñez moves in the center circle.", ctx);
    expect(out).not.toMatch(/Manuel|Ordoñez/);
  });
});

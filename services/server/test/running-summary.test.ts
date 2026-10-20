// ADAAAA-7111 (Increment D): server wiring for the running video summary
// (story-so-far) carried across cadence decide ticks. Covers:
//   (a) `buildObserveDecideRequest` forwards the job's current running summary
//       as `opts.storySoFar` so the decide brain EXTENDS it;
//   (b) `nextRunningSummary` decides when to persist (only on change, bounded).
import { describe, it, expect } from "vitest";
import { buildObserveDecideRequest, nextRunningSummary, type DecisionResult } from "../src/analyzer";
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

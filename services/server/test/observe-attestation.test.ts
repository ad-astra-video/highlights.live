import { describe, it, expect } from "vitest";
import {
  buildObserveDecideRequest,
  foldWindowAttestation,
  observeEmitSeq,
  LiveRunShared,
} from "../src/analyzer";
import type { ObserveDecidePayload, PerFrameSeed } from "../src/observe-loop";

/** Build a synthetic observe-window payload with the given bias hints. */
function payload(biasHints: ObserveDecidePayload["biasHints"]): ObserveDecidePayload {
  const seeds: PerFrameSeed[] = [{ ts: 0, objects: [{ label: "ball", confidence: 0.9, bbox: [0.5, 0.5, 0.6, 0.6] }] }];
  return {
    centerTs: 10,
    frames: [{ ts: 0, imageB64: "f0" }],
    seeds,
    biasHints,
    capped: false,
    droppedCount: 0,
  };
}

describe("observe goal-attestation forwarding (ADAAAA-7021 adverse-finding fix)", () => {
  const cfg = { gameHint: "soccer" } as Parameters<typeof buildObserveDecideRequest>[0];

  it("forwards a perceive candidate's goal-attestation signals into the decide evidence", () => {
    const { evidence } = buildObserveDecideRequest(
      cfg,
      new LiveRunShared(),
      payload([{ eventType: "GOAL", ts: 9.5, goalCrossed: true, ballOutcome: "goal", scoreBoardChanged: true }])
    );
    expect(evidence.goalCrossed).toBe(true);
    expect(evidence.ballOutcome).toBe("goal");
    expect(evidence.scoreBoardChanged).toBe(true);
  });

  it("treats an absent attestation as no-signal (never fabricated)", () => {
    const { evidence } = buildObserveDecideRequest(
      cfg,
      new LiveRunShared(),
      payload([{ eventType: "BIG_PLAY", ts: 9.5 }])
    );
    expect(evidence.goalCrossed).toBeUndefined();
    expect(evidence.ballOutcome).toBeUndefined();
    expect(evidence.scoreBoardChanged).toBeUndefined();
  });

  it("folds a TRUE attestation across multiple in-window hints (any wins)", () => {
    const att = foldWindowAttestation([
      { eventType: "BIG_PLAY", ts: 9.0, goalCrossed: false },
      { eventType: "GOAL", ts: 9.5, scoreBoardChanged: true },
    ]);
    expect(att.goalCrossed).toBeUndefined(); // only true counts
    expect(att.scoreBoardChanged).toBe(true);
    expect(att.ballOutcome).toBeUndefined();
  });

  it("matches the /^goal$/i ballOutcome exactly (not near-miss variants)", () => {
    const att = foldWindowAttestation([{ eventType: "NEAR_MISS", ts: 9.5, ballOutcome: "off_target" }]);
    expect(att.ballOutcome).toBeUndefined();
    const att2 = foldWindowAttestation([{ eventType: "GOAL", ts: 9.5, ballOutcome: "Goal" }]);
    expect(att2.ballOutcome).toBe("Goal");
  });

  it("returns {} when no hint carries an attestation (provenance-only window)", () => {
    expect(foldWindowAttestation([{ eventType: "SPORTING_EVENT", ts: 5 }])).toEqual({});
  });
});

describe("window scoreboard delta folding (ADAAAA-7844)", () => {
  const delta = {
    pre: [0, 0] as [number, number],
    post: [1, 0] as [number, number],
    preTs: 100,
    postTs: 103,
    deltaTs: 103,
    preSamples: 3,
    postSamples: 2,
  };
  const cfg = { gameHint: "soccer" } as Parameters<typeof buildObserveDecideRequest>[0];

  it("carries a legible measured delta alongside the boolean", () => {
    const att = foldWindowAttestation([
      { eventType: "GOAL", ts: 9.5, scoreBoardChanged: true, scoreBoardDelta: delta },
    ]);
    expect(att.scoreBoardChanged).toBe(true);
    expect(att.scoreBoardDelta).toEqual(delta);
  });

  it("keeps the FIRST legible delta in the window", () => {
    const later = { ...delta, pre: [1, 0] as [number, number], post: [2, 0] as [number, number], deltaTs: 108 };
    const att = foldWindowAttestation([
      { eventType: "GOAL", ts: 9.0, scoreBoardChanged: true, scoreBoardDelta: delta },
      { eventType: "GOAL", ts: 9.5, scoreBoardChanged: true, scoreBoardDelta: later },
    ]);
    expect(att.scoreBoardDelta).toEqual(delta);
  });

  it("drops an illegible delta (single OCR sample) but keeps the boolean", () => {
    const att = foldWindowAttestation([
      { eventType: "GOAL", ts: 9.5, scoreBoardChanged: true, scoreBoardDelta: { ...delta, postSamples: 1 } },
    ]);
    // The bare flag still attests (legacy provenance) but carries no measured
    // delta, so the decide pass refuses to label it "scoreboard".
    expect(att.scoreBoardChanged).toBe(true);
    expect(att.scoreBoardDelta).toBeUndefined();
  });

  it("forwards the attestation boolean into the stage-1 decide evidence", () => {
    const { evidence } = buildObserveDecideRequest(
      cfg,
      new LiveRunShared(),
      payload([{ eventType: "GOAL", ts: 9.5, scoreBoardChanged: true, scoreBoardDelta: delta }])
    );
    // Stage-1 evidence keeps the boolean; the structured delta rides the window
    // attestation into the confirm request (see foldWindowAttestation above).
    expect(evidence.scoreBoardChanged).toBe(true);
  });
});

describe("observeEmitSeq (ADAAAA-7007 seq schema fix)", () => {
  it("derives a monotonic non-negative frame seq from centerTs at the window fps", () => {
    expect(observeEmitSeq(15, 2)).toBe(30);
    expect(observeEmitSeq(7.25, 2)).toBe(15); // round to frame index
    expect(observeEmitSeq(3, 5)).toBe(15);
  });

  it("never returns a negative seq, even for a zero/negative anchored moment", () => {
    expect(observeEmitSeq(0, 2)).toBe(0);
    expect(observeEmitSeq(-1, 2)).toBe(0); // clamped
  });

  it("falls back to the default content fps when fps is invalid/zero", () => {
    expect(observeEmitSeq(15, 0)).toBe(30); // OBSERVE_CONTENT_FPS=2
    expect(observeEmitSeq(15, NaN)).toBe(30);
  });
});

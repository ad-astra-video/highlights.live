import { describe, it, expect } from "vitest";
import {
  buildObserveDecideRequest,
  foldWindowAttestation,
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

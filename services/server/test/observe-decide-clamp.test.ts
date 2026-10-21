import { describe, it, expect } from "vitest";
import {
  buildObserveDecideRequest,
  LiveRunShared,
  DECIDE_MAX_TRACK_COUNT,
  DECIDE_MAX_DETECTIONS,
  DECIDE_MAX_DETECTION_BBOX,
} from "../src/analyzer";
import type { ObserveDecidePayload, PerFrameSeed } from "../src/observe-loop";

/** Build a synthetic observe-window payload with the given per-seed context. */
function payload(seeds: PerFrameSeed[], frameCount: number): ObserveDecidePayload {
  return {
    centerTs: 10,
    frames: Array.from({ length: frameCount }, (_, i) => ({ ts: i, imageB64: `f${i}` })),
    seeds,
    biasHints: [],
    capped: false,
    droppedCount: 0,
  };
}

describe("buildObserveDecideRequest clamps evidence to the decide schema caps (ADAAAA-7022)", () => {
  const cfg = { gameHint: "soccer" } as Parameters<typeof buildObserveDecideRequest>[0];

  it("clamps a 40-object / 10-track window to trackCount<=8 and detections<=16", () => {
    // 5 seeds, each carrying 8 objects => 40 detections; one seed carries 10 tracks.
    const seeds: PerFrameSeed[] = [];
    for (let i = 0; i < 5; i++) {
      const objects = Array.from({ length: 8 }, (_, j) => ({
        label: `obj-${i}-${j}`,
        confidence: 0.9,
        bbox: [0.1, 0.2, 0.3, 0.4],
      }));
      const tracks = Array.from({ length: i === 0 ? 10 : 2 }, (_, t) => ({ trackId: `t${t}`, label: "player" }));
      seeds.push({ ts: i, objects, tracks });
    }
    const { evidence } = buildObserveDecideRequest(cfg, new LiveRunShared(), payload(seeds, 5));
    const detections = evidence.detections ?? [];
    expect(evidence.trackCount).toBeLessThanOrEqual(DECIDE_MAX_TRACK_COUNT);
    expect(evidence.trackCount).toBe(DECIDE_MAX_TRACK_COUNT); // clamped from 10
    expect(detections.length).toBeLessThanOrEqual(DECIDE_MAX_DETECTIONS);
    expect(detections.length).toBe(DECIDE_MAX_DETECTIONS); // clamped from 40
    // The FIRST 16 (oldest frames / earliest seeds) are kept, in order.
    expect(detections[0].label).toBe("obj-0-0");
    expect(detections[8].label).toBe("obj-1-0"); // 8th object of the 2nd seed
    expect(detections.every((d) => d.bbox.length <= DECIDE_MAX_DETECTION_BBOX)).toBe(true);
  });

  it("leaves an in-cap window unchanged (no regression on small broadcasts)", () => {
    const seeds: PerFrameSeed[] = [
      {
        ts: 0,
        tracks: [{ trackId: "t0" }, { trackId: "t1" }],
        objects: [{ label: "ball", confidence: 0.8, bbox: [0.5, 0.5, 0.6, 0.6] }],
      },
      {
        ts: 1,
        tracks: [{ trackId: "t0" }],
        objects: [
          { label: "player", confidence: 0.7, bbox: [0.1, 0.1, 0.2, 0.2] },
          { label: "player", confidence: 0.7, bbox: [0.3, 0.1, 0.4, 0.2] },
        ],
      },
    ];
    const { evidence } = buildObserveDecideRequest(cfg, new LiveRunShared(), payload(seeds, 2));
    const detections = evidence.detections ?? [];
    expect(evidence.trackCount).toBe(2);
    expect(detections.length).toBe(3);
    expect(evidence.trackCount).toBeLessThanOrEqual(DECIDE_MAX_TRACK_COUNT);
    expect(detections.length).toBeLessThanOrEqual(DECIDE_MAX_DETECTIONS);
  });

  it("clamps each detection's bbox to the decide max_length=4 (and confidence to 0..1)", () => {
    const seeds: PerFrameSeed[] = [
      {
        ts: 0,
        objects: [
          // Adversarial: 6 bbox coords + confidence outside [0,1]. The decide
          // schema caps bbox at 4 and confidence at ge=0 le=1, so a valid
          // payload must never carry these raw.
          { label: "player", confidence: 0.9, bbox: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] },
        ],
      },
    ];
    const { evidence } = buildObserveDecideRequest(cfg, new LiveRunShared(), payload(seeds, 1));
    const detections = evidence.detections ?? [];
    expect(detections[0].bbox.length).toBe(DECIDE_MAX_DETECTION_BBOX);
    expect(detections[0].bbox).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});

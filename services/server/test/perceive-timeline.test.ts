import { describe, it, expect } from "vitest";
import {
  buildObserveDecideRequest,
  buildPerceiveTimeline,
  selectDecideDetections,
  seedCarriesFindings,
  LiveRunShared,
  DECIDE_MAX_PERCEIVE_RECORDS,
  DECIDE_MAX_DETECTIONS,
  DECIDE_MAX_TRACK_COUNT,
  DECIDE_MAX_DETECTION_BBOX,
} from "../src/analyzer";
import type { ObserveDecidePayload, PerFrameSeed } from "../src/observe-loop";

/**
 * ADAAAA-8056 (lever B+e) — the per-window perceive timeline and the
 * trigger-nearest detection selection. These are the schema-safety and coverage
 * guards for the enrichment: the timeline must be dense (one record per 3 fps
 * seed), bounded (AC-E3/AC-E4), and the VOD payload must stay byte-identical
 * (AC-E5).
 */

function payload(seeds: PerFrameSeed[], frameCount: number, centerTs = 10): ObserveDecidePayload {
  return {
    centerTs,
    frames: Array.from({ length: frameCount }, (_, i) => ({ ts: i, imageB64: `f${i}` })),
    seeds,
    biasHints: [],
    capped: false,
    droppedCount: 0,
  };
}

/** A realistic ~10 s / 3 fps live window: 29 seeds, one every ~0.34 s. */
function liveSeeds(n = 29, center = 10): PerFrameSeed[] {
  return Array.from({ length: n }, (_, i) => {
    const ts = Number((center - n / 2 / 3 + i / 3).toFixed(2));
    return {
      ts,
      tracks: [
        { trackId: `t${i % 3}`, label: "player" },
        { trackId: "ball", label: "ball" },
      ],
      objects: [
        { label: "player", confidence: 0.8, bbox: [0.1, 0.2, 0.3, 0.4] },
        { label: "ball", confidence: 0.9, bbox: [0.5, 0.5, 0.6, 0.6] },
      ],
      ocr: i === 14 ? ["1-0"] : [],
      signal: {
        ballVelocity: { speedMps: Number((0.1 + i / 100).toFixed(2)) },
        ...(i === 14 ? { goalCrossed: true, ballOutcome: "goal", ballInNet: true } : {}),
      },
    } as PerFrameSeed;
  });
}

describe("buildPerceiveTimeline (ADAAAA-8056 AC-E1)", () => {
  it("emits one ordered record per seed, mapping every perceive field", () => {
    const seeds = liveSeeds(29);
    const tl = buildPerceiveTimeline(seeds, { centerTs: 10 });
    expect(tl.length).toBe(29);
    // Chronological, and dense enough for ">= 1 record per ~1 s of window span".
    const tss = tl.map((r) => r.ts);
    expect([...tss].sort((a, b) => a - b)).toEqual(tss);
    const span = tss[tss.length - 1] - tss[0];
    expect(tl.length).toBeGreaterThanOrEqual(Math.floor(span) + 1);
    const goal = tl.find((r) => r.goalCrossed);
    expect(goal?.ballOutcome).toBe("goal");
    expect(goal?.ballInNet).toBe(true);
    expect(goal?.ocr).toEqual(["1-0"]);
    expect(goal?.tracks).toBe(2);
    expect(goal?.objects).toEqual(["player", "ball"]);
    expect(goal?.trackIds).toEqual(["t2", "ball"]);
    expect(goal?.maxVelocity).toBeGreaterThan(0);
  });

  it("keeps a bare seed as a zero-record (never fabricates findings)", () => {
    const tl = buildPerceiveTimeline([{ ts: 5 }], { centerTs: 5 });
    expect(tl).toEqual([{ ts: 5, tracks: 0, maxVelocity: 0, objects: [] }]);
    expect(seedCarriesFindings({ ts: 5 })).toBe(false);
    expect(seedCarriesFindings(liveSeeds(1)[0])).toBe(true);
  });

  it("bounds a long window to the record cap, keeping the trigger-nearest tail", () => {
    const seeds = liveSeeds(60, 30);
    const tl = buildPerceiveTimeline(seeds, { centerTs: 30 });
    expect(tl.length).toBe(DECIDE_MAX_PERCEIVE_RECORDS);
    // Chronological after the cap...
    const tss = tl.map((r) => r.ts);
    expect([...tss].sort((a, b) => a - b)).toEqual(tss);
    // ...and the retained set hugs the anchor: the farthest record is <= half the span.
    const span = seeds[seeds.length - 1].ts - seeds[0].ts;
    expect(Math.max(...tss.map((t) => Math.abs(t - 30)))).toBeLessThanOrEqual(span / 2 + 0.01);
  });

  it("returns [] for a seedless window", () => {
    expect(buildPerceiveTimeline([], { centerTs: 10 })).toEqual([]);
  });
});

describe("selectDecideDetections (ADAAAA-8056, oldest-detections-bias fix)", () => {
  it("selects the trigger-nearest frames, not the first N", () => {
    const seeds = liveSeeds(29);
    const anchor = seeds[seeds.length - 1].ts; // the newest frame
    const dets = selectDecideDetections(seeds, anchor);
    expect(dets.length).toBe(DECIDE_MAX_DETECTIONS);
    // The newest frames (2 objects each) fill the 16 slots: the 8 most recent
    // seeds; the oldest seeds must NOT be represented.
    const newestEight = seeds.slice(-8);
    const labels = newestEight.flatMap(() => ["player", "ball"]);
    expect(dets.map((d) => d.label)).toEqual(labels);
  });

  it("still clamps bbox length and stays within the schema caps (AC-E4)", () => {
    const seeds: PerFrameSeed[] = [
      {
        ts: 1,
        objects: [{ label: "player", confidence: 0.9, bbox: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] }],
      },
    ];
    const dets = selectDecideDetections(seeds, 1);
    expect(dets.length).toBe(1);
    expect(dets[0].bbox.length).toBe(DECIDE_MAX_DETECTION_BBOX);
  });

  it("returns [] when the cap is zero", () => {
    expect(selectDecideDetections(liveSeeds(3), 10, 0)).toEqual([]);
  });
});

describe("buildObserveDecideRequest enrichment envelope (ADAAAA-8056 AC-E1/E4/E5)", () => {
  it("carries the timeline + coverage ledger on the live rail", () => {
    const cfg = { gameHint: "soccer" } as Parameters<typeof buildObserveDecideRequest>[0];
    const seeds = liveSeeds(29);
    const { evidence, opts } = buildObserveDecideRequest(cfg, new LiveRunShared(), payload(seeds, 29));
    expect(evidence.perceiveTimeline?.length).toBe(29);
    expect((opts as any).perceiveWindow).toEqual({ seeds: 29, records: 29, withFindings: 29 });
    expect((opts as any).audioPresence).toBeDefined();
    // Schema clamps held on a 29-seed / 58-object window (ADAAAA-7022 + AC-E4).
    expect(evidence.trackCount).toBeLessThanOrEqual(DECIDE_MAX_TRACK_COUNT);
    expect((evidence.detections ?? []).length).toBeLessThanOrEqual(DECIDE_MAX_DETECTIONS);
    expect((evidence.perceiveTimeline ?? []).length).toBeLessThanOrEqual(DECIDE_MAX_PERCEIVE_RECORDS);
    for (const r of evidence.perceiveTimeline ?? []) {
      expect(r.tracks).toBeLessThanOrEqual(DECIDE_MAX_TRACK_COUNT);
      expect(r.maxVelocity).toBeGreaterThanOrEqual(0);
      expect(r.objects.length).toBeLessThanOrEqual(4);
    }
  });

  it("counts a span perceive never observed as 0 records-with-findings", () => {
    const cfg = { gameHint: "soccer" } as Parameters<typeof buildObserveDecideRequest>[0];
    const seeds: PerFrameSeed[] = [{ ts: 9, tracks: [{ trackId: "t0" }] }, { ts: 10 }];
    const { opts } = buildObserveDecideRequest(cfg, new LiveRunShared(), payload(seeds, 2));
    expect((opts as any).perceiveWindow).toEqual({ seeds: 2, records: 2, withFindings: 1 });
  });

  it("leaves the VOD payload byte-identical (AC-E5)", () => {
    const vodCfg = {
      gameHint: "soccer",
      decideWindowN: 5,
      jobId: "job-1",
    } as Parameters<typeof buildObserveDecideRequest>[0];
    const { evidence, opts } = buildObserveDecideRequest(
      vodCfg,
      new LiveRunShared(),
      payload(liveSeeds(5), 5)
    );
    expect(evidence.perceiveTimeline).toBeUndefined();
    expect("perceiveWindow" in (opts as any)).toBe(false);
    expect("audioPresence" in (opts as any)).toBe(false);
    // Detection selection is shared (a real fix), but the schema caps still hold.
    expect((evidence.detections ?? []).length).toBeLessThanOrEqual(DECIDE_MAX_DETECTIONS);
  });
});

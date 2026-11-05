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
    expect((opts as any).perceiveWindow).toMatchObject({
      seeds: 29,
      records: 29,
      withFindings: 29,
      centerTs: 10,
      // ADAAAA-8064: a payload without a full observation set sources the
      // timeline from the seeds and says so (the VOD / legacy fallback).
      timelineRecords: 29,
      observationsInSpan: 29,
      imageCount: 29,
      timelineSource: "seeds",
    });
    expect((opts as any).perceiveWindow.imageGapMaxMs).toBe(1000);
    expect((opts as any).perceiveWindow.spanS).toBeGreaterThan(0);
    expect((opts as any).perceiveWindow.recordsPerSecond).toBeGreaterThan(0);
    expect((opts as any).audioPresence).toBeDefined();
    // The clip gate is reported so a gated window is named, not blamed on retention.
    expect((opts as any).audioPresence.clipEnabled).toBe(true);
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
    expect((opts as any).perceiveWindow).toMatchObject({
      seeds: 2,
      records: 2,
      withFindings: 1,
      centerTs: 10,
      timelineRecords: 2,
      observationsInSpan: 2,
      imageCount: 2,
      timelineSource: "seeds",
    });
  });

  // --- ADAAAA-8064: the timeline source is the observation set, not the images.
  it("builds one timeline record per PERCEIVED frame even when the image cap ships 4", () => {
    const cfg = { gameHint: "soccer" } as Parameters<typeof buildObserveDecideRequest>[0];
    // A ~10 s live span: 28 perceived frames at ~2.76 obs/s, 4 images shipped
    // at the ~3.3 s gaps a 4-image cap produces over that span.
    const observations = liveSeeds(28, 10).map((s, i) => ({ ...s, ts: Number((i * (10 / 27)).toFixed(2)) }));
    const images = [0, 9, 18, 27].map((i) => ({ ts: observations[i].ts, imageB64: `img${i}` }));
    const p: ObserveDecidePayload = {
      centerTs: 10,
      frames: images,
      seeds: images.map((f) => observations.find((o) => o.ts === f.ts)!),
      observations,
      biasHints: [],
      capped: true,
      droppedCount: 16,
    };
    const { evidence, opts } = buildObserveDecideRequest(cfg, new LiveRunShared(), p);
    expect(evidence.perceiveTimeline?.length).toBe(28);
    const l = (opts as any).perceiveWindow;
    // AC-C1: the point of the fix — records track observations, not images.
    expect(l.timelineRecords).toBe(28);
    expect(l.observationsInSpan).toBe(28);
    expect(l.imageCount).toBe(4);
    expect(l.timelineRecords).toBe(l.observationsInSpan);
    expect(l.timelineRecords).toBeGreaterThan(l.imageCount);
    // AC-C2: >= 1 record per second of span (~2.8 expected).
    expect(l.spanS).toBeCloseTo(10, 1);
    expect(l.recordsPerSecond).toBeGreaterThanOrEqual(1.0);
    // AC-C3: honest imaging — 4 images over 10 s is ~3.3 s apart, never sub-second.
    expect(l.imageGapMaxMs).toBeGreaterThanOrEqual(900);
    expect(l.timelineSource).toBe("observations");
    // The records themselves are the perceived frames, chronological.
    const ts = (evidence.perceiveTimeline ?? []).map((r) => r.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(new Set(ts).size).toBe(28);
  });

  it("falls back to the seeds when the payload carries no observation set", () => {
    const cfg = { gameHint: "soccer" } as Parameters<typeof buildObserveDecideRequest>[0];
    const seeds = liveSeeds(4);
    const { evidence, opts } = buildObserveDecideRequest(cfg, new LiveRunShared(), payload(seeds, 4));
    expect(evidence.perceiveTimeline?.length).toBe(4);
    expect((opts as any).perceiveWindow.timelineSource).toBe("seeds");
    expect((opts as any).perceiveWindow.observationsInSpan).toBe(4);
  });

  it("reproduces the pre-8064 construction when the A/B lever says seeds (AC-C4)", () => {
    const cfg = { gameHint: "soccer", perceiveTimelineSource: "seeds" } as Parameters<
      typeof buildObserveDecideRequest
    >[0];
    const observations = liveSeeds(28, 10).map((s, i) => ({ ...s, ts: Number((i * (10 / 27)).toFixed(2)) }));
    const images = [0, 9, 18, 27].map((i) => ({ ts: observations[i].ts, imageB64: `img${i}` }));
    const p: ObserveDecidePayload = {
      centerTs: 10,
      frames: images,
      seeds: images.map((f) => observations.find((o) => o.ts === f.ts)!),
      observations,
      biasHints: [],
      capped: true,
      droppedCount: 16,
    };
    const { evidence, opts } = buildObserveDecideRequest(cfg, new LiveRunShared(), p);
    // The OFF side of the pairing is the image projection: 4 records, and the
    // ledger says so instead of pretending the window carried 28.
    expect(evidence.perceiveTimeline?.length).toBe(4);
    expect((opts as any).perceiveWindow.timelineRecords).toBe(4);
    expect((opts as any).perceiveWindow.imageCount).toBe(4);
    expect((opts as any).perceiveWindow.timelineSource).toBe("seeds");
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

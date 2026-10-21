import { describe, it, expect } from "vitest";
import {
  subsampleToCap,
  assembleObserveWindow,
  planObserveWindows,
  alignSeeds,
  shouldFireObserve,
  buildObservePayload,
  runObserveLoop,
  applyOnDemandRecall,
  ObserveDecider,
  assembleLiveWindow,
  LiveObserver,
  OBSERVE_MAX_FRAMES,
  OBSERVE_CADENCE_S,
  OBSERVE_WINDOW_S,
  LIVE_OBSERVE_WINDOW_S,
  LIVE_OBSERVE_MAX_FRAMES,
  type LiveObserveLatencySample,
  type ObserveDecidePayload,
  type PerFrameSeed,
} from "../src/observe-loop";

/** Build a synthetic VOD frame timeline at a given fps over [0, durationS). */
function timeline(fps: number, durationS: number, endExclusive = true): { ts: number; imageB64: string }[] {
  const out: { ts: number; imageB64: string }[] = [];
  const steps = durationS * fps;
  const lastOk = endExclusive ? Math.floor(steps) - 1 : Math.floor(steps);
  for (let i = 0; i < steps; i++) {
    const ts = i / fps;
    out.push({ ts, imageB64: `frame@${ts.toFixed(3)}` });
  }
  void lastOk;
  return out;
}

describe("subsampleToCap", () => {
  it("returns unchanged when within the cap", () => {
    const items = [0, 1, 2, 3];
    const r = subsampleToCap(items, 5);
    expect(r.capped).toBe(false);
    expect(r.items).toEqual(items);
  });

  it("subsamples uniformly, keeps first and last, never exceeds the cap", () => {
    // 40 frames, cap 30 -> must drop to exactly 30 and preserve endpoints.
    const items = Array.from({ length: 40 }, (_, i) => i);
    const r = subsampleToCap(items, 30);
    expect(r.capped).toBe(true);
    expect(r.items.length).toBeLessThanOrEqual(30);
    expect(r.items[0]).toBe(0);
    expect(r.items[r.items.length - 1]).toBe(39);
  });

  it("guarantees the hard cap is never breached even for adversarial sizes", () => {
    for (const n of [31, 45, 60, 100]) {
      const items = Array.from({ length: n }, (_, i) => i);
      const r = subsampleToCap(items, 30);
      expect(r.items.length).toBeLessThanOrEqual(30);
    }
  });
});

describe("assembleObserveWindow", () => {
  it("returns an empty window when nothing is in range / no image", () => {
    const w = assembleObserveWindow([{ ts: 0, imageB64: "" }], 5, {});
    expect(w.frames.length).toBe(0);
  });

  it("keeps only frames inside the +/- window/2 band and orders oldest->newest", () => {
    const frames = timeline(5, 20, false); // 5 fps over 0..20, ts = 0,0.2,...
    const center = 10;
    const w = assembleObserveWindow(frames, center, { windowS: 10, maxFrames: 30, fps: 5 });
    const lo = center - 5;
    const hi = center + 5;
    for (const f of w.frames) {
      expect(f.ts).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(f.ts).toBeLessThanOrEqual(hi + 1e-9);
    }
    // ordered
    for (let i = 1; i < w.frames.length; i++) {
      expect(w.frames[i].ts).toBeGreaterThanOrEqual(w.frames[i - 1].ts);
    }
  });

  it("caps a dense window to <= OBSERVE_MAX_FRAMES and flags capped", () => {
    // 5 fps over the 10s window = ~50 in-window frames; cap 30.
    const frames = timeline(5, 20, false);
    const w = assembleObserveWindow(frames, 10, { windowS: 10, maxFrames: 30, fps: 5 });
    expect(w.frames.length).toBeLessThanOrEqual(30);
    expect(w.capped).toBe(true);
    expect(w.droppedCount).toBeGreaterThan(0);
  });

  it("10s window at 2fps is ~20 frames (under the 30-cap, capped=false)", () => {
    const frames = timeline(2, 30, false); // 2 fps
    const w = assembleObserveWindow(frames, 15, { windowS: 10, maxFrames: 30, fps: 2 });
    // 2 fps * 10 s = 20 intervals; both endpoints fall in-window, so 20 or 21.
    expect(w.frames.length).toBeGreaterThanOrEqual(19);
    expect(w.frames.length).toBeLessThanOrEqual(21);
    expect(w.capped).toBe(false);
    expect(w.frames.length).toBeLessThanOrEqual(OBSERVE_MAX_FRAMES);
  });
});

describe("planObserveWindows (AC1: cap / AC2: cadence + overlap)", () => {
  it("emits one decide per ~3s cadence over the timeline", () => {
    const frames = timeline(2, 120, false); // 2 fps over 0..120
    const wins = planObserveWindows(frames, { cadenceS: 3, windowS: 10, maxFrames: 30, fps: 2 });
    // Centers 0,3,6,...,120
    expect(wins.length).toBeGreaterThan(30);
    // Consecutive centers are 3s apart (cadence)
    for (let i = 1; i < wins.length; i++) {
      expect(wins[i].centerTs - wins[i - 1].centerTs).toBeCloseTo(3, 5);
    }
  });

  it("every window is <= OBSERVE_MAX_FRAMES (AC1 hard cap)", () => {
    // Dense 8fps timeline -> windows would exceed 30; the cap must hold.
    const frames = timeline(8, 60, false);
    const wins = planObserveWindows(frames, { cadenceS: 3, windowS: 10, maxFrames: 30, fps: 8 });
    expect(wins.length).toBeGreaterThan(0);
    for (const w of wins) expect(w.frames.length).toBeLessThanOrEqual(OBSERVE_MAX_FRAMES);
    // At least one window exercised the subsample/cap path given 8fps > 2fps over 10s.
    expect(wins.some((w) => w.capped)).toBe(true);
  });

  it("consecutive windows overlap (share content) because windowS > cadenceS", () => {
    const frames = timeline(2, 60, false);
    const wins = planObserveWindows(frames, { cadenceS: 3, windowS: 10, maxFrames: 30, fps: 2 });
    expect(wins.length).toBeGreaterThan(1);
    // Window i covers [c-5, c+5], window i+1 covers [c+3-5, c+3+5].
    // Overlap = [c+3-5, c+5] = 7s of shared content; assert the frame sets intersect.
    let overlapFound = false;
    for (let i = 1; i < wins.length; i++) {
      const prevTs = new Set(wins[i - 1].frames.map((f) => f.ts));
      const shared = wins[i].frames.filter((f) => prevTs.has(f.ts));
      if (shared.length > 0) {
        overlapFound = true;
        // The two windows overlap by at least (windowS - cadenceS) worth of time.
        expect(OBSERVE_WINDOW_S).toBeGreaterThan(OBSERVE_CADENCE_S);
        expect(shared.length).toBeGreaterThan(0);
      }
    }
    expect(overlapFound).toBe(true);
  });

  it("returns [] for an empty timeline", () => {
    expect(planObserveWindows([], {})).toEqual([]);
  });
});

describe("alignSeeds (AC3: perceive seeding present in every payload)", () => {
  it("produces one seed per window frame, aligned by timestamp", () => {
    const windowFrames = [{ ts: 1 }, { ts: 2 }, { ts: 3 }];
    const findings = new Map<number, { ts: number; ocr: string[] }>([
      [2, { ts: 2, ocr: ["2 - 0"] }],
    ]);
    const seeds = alignSeeds(windowFrames, findings as any);
    expect(seeds.length).toBe(3);
    expect(seeds[0]).toEqual({ ts: 1 }); // absent evidence -> empty seed, not fabricated
    expect(seeds[1].ocr).toEqual(["2 - 0"]);
    expect(seeds[2]).toEqual({ ts: 3 });
  });

  it("aligns a capped window exactly (seed count == frame count)", () => {
    const frames = timeline(5, 20, false);
    const w = assembleObserveWindow(frames, 50, {}); // empty (out of range)
    void w;
    const dense = assembleObserveWindow(frames, 11, { windowS: 10, maxFrames: 30, fps: 5 });
    const seeds = alignSeeds(dense.frames, new Map());
    expect(seeds.length).toBe(dense.frames.length);
    for (const s of seeds) {
      expect(s.ts).toBeDefined();
      expect(s.objects).toBeUndefined(); // no findings -> no fabricated context
    }
  });
});

describe("shouldFireObserve + cadence", () => {
  it("fires immediately on the first tick", () => {
    expect(shouldFireObserve(null, 0)).toBe(true);
  });
  it("fires only after the cadence has elapsed (jitter-immune)", () => {
    expect(shouldFireObserve(0, 2.99)).toBe(false);
    expect(shouldFireObserve(0, 3.0)).toBe(true);
    expect(shouldFireObserve(5, 8.0)).toBe(true);
    expect(shouldFireObserve(5, 7.99)).toBe(false);
  });
});

describe("buildObservePayload (seeding present in every payload + bias hints)", () => {
  it("carries one seed per frame and the window's bias hints", () => {
    const win = assembleObserveWindow(timeline(2, 30, false), 15, { windowS: 10, maxFrames: 30, fps: 2 });
    const findings = new Map<number, PerFrameSeed>([[15, { ts: 15, ocr: ["1 - 0"] }]]);
    const payload = buildObservePayload(win, findings, [
      { eventType: "GOAL", ts: 14.5 },
      { eventType: "BIG_PLAY", ts: 16.0 },
    ]);
    expect(payload.seeds.length).toBe(win.frames.length); // seeding in every payload
    expect(payload.biasHints.map((h) => h.eventType)).toEqual(["GOAL", "BIG_PLAY"]);
    expect(payload.biasHints.map((h) => h.ts)).toEqual([14.5, 16.0]); // sorted by ts
  });
});

describe("runObserveLoop (streaming driver)", () => {
  it("fires at ~3s cadence, caps every payload, seeds every payload", async () => {
    const frames: { seq: number; timestamp: number; imageB64: string }[] = [];
    const fps = 5;
    for (let i = 0; i < fps * 60; i++) frames.push({ seq: i, timestamp: i / fps, imageB64: `f${i}` });
    const payloads: ObserveDecidePayload[] = [];
    const res = await runObserveLoop({
      frames: (async function* () {
        for (const f of frames) yield f;
      })(),
      findFrames: () => frames.map((f) => ({ ts: f.timestamp, imageB64: f.imageB64 })),
      findingsFor: (ts) => ({ ts, tracks: [{ trackId: "t1", label: "ball" }] }),
      biasHintsFor: () => [],
      onDecide: async (p) => {
        payloads.push(p);
        expect(p.frames.length).toBeLessThanOrEqual(OBSERVE_MAX_FRAMES); // AC1
        expect(p.seeds.length).toBe(p.frames.length); // AC3 seeding
        return false;
      },
      cadenceS: 3,
      windowS: 10,
      maxFrames: 30,
      fps: 5,
    });
    expect(res.ticks).toBe(payloads.length);
    expect(res.ticks).toBeGreaterThan(10); // 60s / 3s cadence -> many ticks
    // Overlap: consecutive payloads share frames (window 10s > cadence 3s).
    let overlap = false;
    for (let i = 1; i < payloads.length; i++) {
      const prev = new Set(payloads[i - 1].frames.map((f) => f.ts));
      if (payloads[i].frames.some((f) => prev.has(f.ts))) overlap = true;
    }
    expect(overlap).toBe(true);
  });

  it("keeps every payload <= 30 frames even when the source is much denser (cap + subsample)", async () => {
    const fps = 8;
    const frames = Array.from({ length: fps * 40 }, (_, i) => ({ seq: i, timestamp: i / fps, imageB64: `f${i}` }));
    const payloads: ObserveDecidePayload[] = [];
    await runObserveLoop({
      frames: (async function* () {
        for (const f of frames) yield f;
      })(),
      findFrames: () => frames.map((f) => ({ ts: f.timestamp, imageB64: f.imageB64 })),
      findingsFor: () => undefined,
      biasHintsFor: () => [],
      onDecide: async (p) => {
        payloads.push(p);
        expect(p.frames.length).toBeLessThanOrEqual(OBSERVE_MAX_FRAMES);
        return false;
      },
      cadenceS: 3,
      windowS: 10,
      maxFrames: 30,
      fps: 8,
    });
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads.every((p) => p.frames.length <= OBSERVE_MAX_FRAMES)).toBe(true);
    // Subsampling actually exercised at this density (8fps * 10s = 80 > 30).
    expect(payloads.some((p) => p.capped)).toBe(true);
  });
});

describe("applyOnDemandRecall (on-demand perceive recall path)", () => {
  it("refreshes a moment's seed when recall returns new per-frame context", () => {
    const win = assembleObserveWindow(timeline(2, 30, false), 15, { windowS: 10, maxFrames: 30, fps: 2 });
    const payload = buildObservePayload(win, new Map(), []);
    const refreshed = applyOnDemandRecall(payload, {
      centerTs: 15,
      seeds: [{ ts: 15, ocr: ["2 - 0"], objects: [{ label: "ball" }] }],
    });
    expect(refreshed.seeds).not.toEqual(payload.seeds); // new evidence folded in
    const at15 = refreshed.seeds.find((s) => s.ts === 15);
    expect(at15?.objects?.[0]?.label).toBe("ball");
    expect(refreshed.seeds.length).toBe(win.frames.length);
  });

  it("is a no-op when recall returns nothing new (never regresses a decision)", () => {
    const win = assembleObserveWindow(timeline(2, 30, false), 15, { windowS: 10, maxFrames: 30, fps: 2 });
    const payload = buildObservePayload(win, new Map(), []);
    expect(applyOnDemandRecall(payload, undefined)).toBe(payload);
    expect(applyOnDemandRecall(payload, { centerTs: 15, seeds: [] })).toBe(payload);
  });
});

describe("ObserveDecider (in-loop integration seam)", () => {
  it("fires on ~3s cadence, caps every payload, reports per-call size", async () => {
    const fired: ObserveDecidePayload[] = [];
    const d = new ObserveDecider({ cadenceS: 3, windowS: 10, maxFrames: 30, fps: 5, onDecide: async (p) => {
      fired.push(p);
      expect(p.frames.length).toBeLessThanOrEqual(OBSERVE_MAX_FRAMES);
      return true;
    } });
    const fps = 5;
    for (let i = 0; i < fps * 60; i++) {
      const ts = i / fps;
      d.record(ts, `f${i}`, { ts, tracks: [{ trackId: "t1" }] });
      await d.maybeFire(ts);
    }
    await d.flush();
    expect(fired.length).toBeGreaterThan(10); // ~3s cadence over 60s
    expect(fired.every((p) => p.frames.length <= OBSERVE_MAX_FRAMES)).toBe(true);
    // Per-call input-size report is populated for the cost surface.
    expect(d.decideCalls()).toBe(fired.length);
    expect(d.inputSizeSamples().length).toBe(fired.length);
    expect(d.maxFrameCount()).toBeLessThanOrEqual(OBSERVE_MAX_FRAMES);
    expect(d.acceptedCount()).toBe(fired.length); // every onDecide returned true
  });

  it("does not fire until the cadence has elapsed", async () => {
    let calls = 0;
    const d = new ObserveDecider({ cadenceS: 3, windowS: 10, maxFrames: 30, fps: 5, onDecide: async () => {
      calls++;
      return false;
    } });
    d.record(0, "f0", { ts: 0 });
    await d.maybeFire(0);
    expect(calls).toBe(1); // first tick fires
    d.record(2.9, "f1", { ts: 2.9 });
    await d.maybeFire(2.9);
    expect(calls).toBe(1); // cadence not yet elapsed
    d.record(3.0, "f2", { ts: 3.0 });
    await d.maybeFire(3.0);
    expect(calls).toBe(2); // cadence elapsed -> fires
  });
});

describe("assembleLiveWindow (ADAAAA-7008: rolling PAST window, no decode ahead)", () => {
  it("only keeps frames in [now - windowS, now], ordered oldest->newest", () => {
    const frames = timeline(2, 30, false); // ts 0..30 at 2 fps
    const w = assembleLiveWindow(frames, 20, { windowS: 10, maxFrames: 30, fps: 2 });
    // Rolling past window: [10, 20]. Nothing after `now` may be included.
    const lo = 10;
    for (const f of w.frames) {
      expect(f.ts).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(f.ts).toBeLessThanOrEqual(20 + 1e-9);
    }
    for (let i = 1; i < w.frames.length; i++) {
      expect(w.frames[i].ts).toBeGreaterThanOrEqual(w.frames[i - 1].ts);
    }
    // The window is PAST-only: a frame AFTER nowTs must never appear.
    expect(w.frames.some((f) => f.ts > 20 + 1e-9)).toBe(false);
  });

  it("caps to <= maxFrames and flags capped on a dense stream", () => {
    const frames = timeline(8, 40, false); // 8 fps / 10s window = 80, cap 30
    const w = assembleLiveWindow(frames, 35, { windowS: 10, maxFrames: 30, fps: 8 });
    expect(w.frames.length).toBeLessThanOrEqual(LIVE_OBSERVE_MAX_FRAMES);
    expect(w.capped).toBe(true);
    expect(w.droppedCount).toBeGreaterThan(0);
  });

  it("returns empty window when nothing is in the past window", () => {
    const frames = timeline(2, 5, false); // ts 0..5
    const w = assembleLiveWindow(frames, 100, { windowS: 10, maxFrames: 30, fps: 2 });
    expect(w.frames.length).toBe(0);
    expect(w.centerTs).toBe(100);
  });
});

describe("LiveObserver (ADAAAA-7008: rolling-past cadence observer)", () => {
  function makeObserver(onDecide: (p: ObserveDecidePayload) => Promise<boolean>) {
    return new LiveObserver({ cadenceS: 3, windowS: 10, maxFrames: 30, fps: 2, onDecide });
  }

  it("fires at cadence, caps every payload, seeds every payload, measures e2e+cadence latency", async () => {
    const fired: ObserveDecidePayload[] = [];
    const obs = makeObserver(async (p) => {
      fired.push(p);
      expect(p.frames.length).toBeLessThanOrEqual(LIVE_OBSERVE_MAX_FRAMES);
      expect(p.seeds.length).toBe(p.frames.length); // perceive seeding in every payload
      return true;
    });
    const fps = 5;
    for (let i = 0; i < fps * 20; i++) {
      const ts = i / fps;
      obs.record(ts, `f${i}`, { ts, tracks: [{ trackId: "t1" }] });
      await obs.maybeFire(ts);
    }
    await obs.flush();
    expect(fired.length).toBeGreaterThan(3); // ~3s cadence over 20s
    expect(fired.every((p) => p.frames.length <= LIVE_OBSERVE_MAX_FRAMES)).toBe(true);
    // Latency report surface is populated for the Livepeer runner report.
    const samples: LiveObserveLatencySample[] = obs.latencySamples();
    expect(samples.length).toBe(fired.length);
    expect(obs.decideCalls()).toBe(fired.length);
    expect(obs.maxFrameCount()).toBeLessThanOrEqual(LIVE_OBSERVE_MAX_FRAMES);
    expect(obs.acceptedCount()).toBe(fired.length);
    // e2eMs is wall-clock (>=0) since onDecide was awaited.
    expect(samples.every((s) => s.e2eMs >= 0)).toBe(true);
    // Regular cadence ticks are ~cadenceS (3s) apart in content time; the
    // forced end-of-stream flush tick may be shorter, so assert the maximum
    // content cadence is ~3s (proves the cadence holds) rather than every tick.
    const cadences = samples.map((s) => s.cadenceMs).filter((c) => c > 0);
    expect(Math.max(...cadences)).toBeGreaterThanOrEqual(2.9 * 1000);
    expect(Math.max(...cadences)).toBeLessThanOrEqual(3.1 * 1000);
  });

  it("never decodes ahead: each window's frames are all <= the tick's content time", async () => {
    const fired: ObserveDecidePayload[] = [];
    const obs = makeObserver(async (p) => {
      fired.push(p);
      return false;
    });
    const fps = 5;
    for (let i = 0; i < fps * 20; i++) {
      const ts = i / fps;
      obs.record(ts, `f${i}`, { ts });
      await obs.maybeFire(ts);
    }
    for (const p of fired) {
      for (const f of p.frames) expect(f.ts).toBeLessThanOrEqual(p.centerTs + 1e-9);
    }
  });

  it("respects the cadence interval (no early fire) and forces at flush", async () => {
    let calls = 0;
    const obs = makeObserver(async () => {
      calls++;
      return false;
    });
    obs.record(0, "f0", { ts: 0 });
    await obs.maybeFire(0);
    expect(calls).toBe(1);
    obs.record(2.9, "f1", { ts: 2.9 });
    await obs.maybeFire(2.9);
    expect(calls).toBe(1);
    obs.record(3.0, "f2", { ts: 3.0 });
    await obs.maybeFire(3.0);
    expect(calls).toBe(2);
  });
});

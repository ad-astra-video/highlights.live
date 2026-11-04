import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveLiveSampleFps, resolveSampleFps } from "../src/api";
import { testCfg } from "./helpers";

// ADAAAA-3726: VOD sampling must honor the perceive runner's sustainable
// cadence (GPU toward the "3 live / 8 VOD" charter) instead of a blanket 1 fps
// cap, while CPU safely stays at 1 fps (perceive reports interval >= 1.0) and
// the configured fallback applies when perceive is unreachable.
//
// ADAAAA-5342 (C3): live mirrors the VOD mechanism with a live-specific cap
// (liveSampleMaxFps, default 10) and a headroom (liveSampleHeadroom, default
// 0.9) so a capable GPU accelerates toward the chartered cadence while the
// runner never sits at its sustained max — and a base-cadence FLOOR so a ~1
// fps CPU runner never regresses below its incumbent live rate.

function stubHealth(intervalS: number | undefined) {
  const json = vi.fn().mockResolvedValue({ sample_interval_s: intervalS });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json }));
}

afterEach(() => vi.unstubAllGlobals());

describe("resolveSampleFps (VOD source sampling)", () => {
  it("falls back to the configured interval when perceive is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const cfg = testCfg({ SAMPLE_INTERVAL_SEC: "1.0" });
    expect(await resolveSampleFps(cfg)).toBeCloseTo(1.0);
  });

  it("honors a GPU capability above 1 fps (no 1 fps clamp)", async () => {
    const cfg = testCfg({ PERCEIVE_URL: "http://perceive", VOD_SAMPLE_MAX_FPS: "8" });
    // runner sustains ~3 fps -> sample_interval_s = 0.333
    stubHealth(0.333);
    const fps = await resolveSampleFps(cfg);
    expect(fps).toBeGreaterThan(1.0);
    expect(fps).toBeCloseTo(3.0, 0);
  });

  it("caps at vodSampleMaxFps even for a very fast device", async () => {
    const cfg = testCfg({ PERCEIVE_URL: "http://perceive", VOD_SAMPLE_MAX_FPS: "8" });
    stubHealth(0.126); // ~7.9 fps reported
    expect(await resolveSampleFps(cfg)).toBeCloseTo(8.0, 0);
  });

  it("keeps CPU at 1 fps (perceive reports interval >= 1.0)", async () => {
    const cfg = testCfg({ PERCEIVE_URL: "http://perceive" });
    stubHealth(1.0); // CPU runner reports a 1s interval
    expect(await resolveSampleFps(cfg)).toBeCloseTo(1.0);
  });

  // ADAAAA-5059: VOD now defaults to 5 fps (from the previous 1 fps fallback)
  // so a brief moment is sampled densely enough to fire a candidate, while the
  // live path (no explicit default) keeps its sampleIntervalSec-derived cadence.
  it("defaults VOD to the configured vodSampleFpsDefault (5) when perceive is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const cfg = testCfg({}); // vodSampleFpsDefault default = 5
    expect(cfg.vodSampleFpsDefault).toBe(5);
    expect(await resolveSampleFps(cfg, { defaultFps: cfg.vodSampleFpsDefault })).toBeCloseTo(5.0);
  });

  it("raises the live primary-pass baseline to the 3 fps default (ADAAAA-6796)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const cfg = testCfg({}); // liveSampleBaseFps default = 3
    expect(cfg.liveSampleBaseFps).toBe(3);
    expect(await resolveSampleFps(cfg, { defaultFps: cfg.liveSampleBaseFps })).toBeCloseTo(3.0);
  });

  it("honors a per-job sampleFps override for VOD, still capped by vodSampleMaxFps", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const cfg = testCfg({ VOD_SAMPLE_FPS_DEFAULT: "5", VOD_SAMPLE_MAX_FPS: "8" });
    // Per-job override to 3 wins over the 5 fps default.
    expect(await resolveSampleFps(cfg, { defaultFps: 3 })).toBeCloseTo(3.0);
    // An override above the max is still clamped.
    expect(await resolveSampleFps(cfg, { defaultFps: 20 })).toBe(8);
  });
});

describe("resolveSampleFps (live sampling, ADAAAA-5342 / ADAAAA-6796)", () => {
  const liveOpts = (cfg: ReturnType<typeof testCfg>) => ({
    defaultFps: cfg.liveSampleBaseFps, // ADAAAA-6796: 3 fps primary-pass baseline
    maxFps: cfg.liveSampleMaxFps,
    headroom: cfg.liveSampleHeadroom,
  });
  const liveCfg = (extra: Record<string, string> = {}) =>
    testCfg({ PERCEIVE_URL: "http://perceive", SAMPLE_INTERVAL_SEC: "1.0", ...extra });

  it("defaults the live cap to 10, headroom to 0.9, and baseline to 3", () => {
    const cfg = testCfg({});
    expect(cfg.liveSampleMaxFps).toBe(10);
    expect(cfg.liveSampleHeadroom).toBeCloseTo(0.9);
    expect(cfg.liveSampleBaseFps).toBe(3);
  });

  it("resolves a capable GPU to min(10, runnerMaxFps * 0.9) for live", async () => {
    const cfg = liveCfg({ LIVE_SAMPLE_MAX_FPS: "10", LIVE_SAMPLE_HEADROOM: "0.9" });
    stubHealth(0.077); // runner sustains ~13 fps
    const fps = await resolveSampleFps(cfg, liveOpts(cfg));
    // 13 * 0.9 = 11.7 -> capped at 10
    expect(fps).toBeCloseTo(10.0);
    // A 5 fps-capable GPU: 5 * 0.9 = 4.5, above the 3 fps baseline
    stubHealth(0.2); // 5 fps
    expect(await resolveSampleFps(cfg, liveOpts(cfg))).toBeCloseTo(4.5);
  });

  it("floors a slow/CPU runner at the 3 fps primary-pass baseline (not the old 1 fps)", async () => {
    const cfg = liveCfg({ LIVE_SAMPLE_HEADROOM: "0.9" });
    stubHealth(1.0); // CPU runner: 1 fps
    // 1 * 0.9 = 0.9, but the ADAAAA-6796 baseline floor raises it to 3 fps
    expect(await resolveSampleFps(cfg, liveOpts(cfg))).toBeCloseTo(3.0);
  });

  it("stays at the 3 fps baseline when perceive is unreachable even with headroom", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const cfg = liveCfg({ LIVE_SAMPLE_HEADROOM: "0.9" });
    expect(await resolveSampleFps(cfg, liveOpts(cfg))).toBeCloseTo(3.0);
  });

  it("floors a low-but-reported runner up to the 3 fps baseline", async () => {
    const cfg = liveCfg({ SAMPLE_INTERVAL_SEC: "1.0", LIVE_SAMPLE_HEADROOM: "0.9" });
    stubHealth(1.2); // runner slower than 1 fps (interval 1.2s)
    // (1 / 1.2) * 0.9 = 0.75 -> floored back up to the 3 fps baseline
    expect(await resolveSampleFps(cfg, liveOpts(cfg))).toBeCloseTo(3.0);
  });
});

describe("resolveLiveSampleFps — ONE resolution source for both live rails (ADAAAA-7990)", () => {
  // The media (browser/RTMP) rail used to sample at a hard-coded 1 fps
  // (`sampleFps ?? 1` in services/media/src/rtc.ts) while ADAAAA-6796 had
  // already funded 3 fps on the analyzer path. Both rails now resolve here.
  it("defaults to the funded 3 fps baseline when perceive is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const cfg = testCfg({});
    expect(cfg.liveSampleBaseFps).toBe(3);
    await expect(resolveLiveSampleFps(cfg)).resolves.toBeCloseTo(3.0);
  });

  it("honours LIVE_SAMPLE_BASE_FPS and the LIVE_SAMPLE_MAX_FPS cap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    // A deployment that raises the base gets it (5), and a lower cap wins over
    // a higher base so the funded ceiling can never be exceeded.
    await expect(resolveLiveSampleFps(testCfg({ LIVE_SAMPLE_BASE_FPS: "5" }))).resolves.toBeCloseTo(5.0);
    await expect(
      resolveLiveSampleFps(testCfg({ LIVE_SAMPLE_BASE_FPS: "5", LIVE_SAMPLE_MAX_FPS: "4" }))
    ).resolves.toBeCloseTo(4.0);
  });

  it("applies the live headroom to a capable GPU and still floors at the baseline", async () => {
    const cfg = testCfg({ PERCEIVE_URL: "http://perceive", LIVE_SAMPLE_MAX_FPS: "10", LIVE_SAMPLE_HEADROOM: "0.9" });
    stubHealth(0.2); // runner sustains 5 fps -> 5 * 0.9 = 4.5
    await expect(resolveLiveSampleFps(cfg)).resolves.toBeCloseTo(4.5);
    stubHealth(1.0); // CPU runner: 1 * 0.9 = 0.9 -> floored to 3
    await expect(resolveLiveSampleFps(cfg)).resolves.toBeCloseTo(3.0);
  });

  it("leaves the VOD resolution untouched (AC5)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const cfg = testCfg({});
    // VOD keeps its own default (5) and its own cap (8): sharing the live
    // resolver never re-points the VOD path at the live baseline.
    expect(cfg.vodSampleFpsDefault).toBe(5);
    expect(cfg.vodSampleMaxFps).toBe(8);
    await expect(
      resolveSampleFps(cfg, { defaultFps: cfg.vodSampleFpsDefault, maxFps: cfg.vodSampleMaxFps })
    ).resolves.toBeCloseTo(5.0);
    await expect(
      resolveSampleFps(cfg, { defaultFps: 20, maxFps: cfg.vodSampleMaxFps })
    ).resolves.toBe(8);
    // ... and the live resolver is the live baseline, not the VOD default.
    await expect(resolveLiveSampleFps(cfg)).resolves.toBeCloseTo(3.0);
  });
});


import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveSampleFps } from "../src/api";
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

  it("keeps the live path at the sampleIntervalSec-derived cadence (no VOD default)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const cfg = testCfg({ SAMPLE_INTERVAL_SEC: "1.0" }); // live default
    expect(await resolveSampleFps(cfg)).toBeCloseTo(1.0);
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

describe("resolveSampleFps (live sampling, ADAAAA-5342)", () => {
  const liveOpts = (cfg: ReturnType<typeof testCfg>) => ({
    maxFps: cfg.liveSampleMaxFps,
    headroom: cfg.liveSampleHeadroom,
  });
  const liveCfg = (extra: Record<string, string> = {}) =>
    testCfg({ PERCEIVE_URL: "http://perceive", SAMPLE_INTERVAL_SEC: "1.0", ...extra });

  it("defaults the live cap to 10 and headroom to 0.9", () => {
    const cfg = testCfg({});
    expect(cfg.liveSampleMaxFps).toBe(10);
    expect(cfg.liveSampleHeadroom).toBeCloseTo(0.9);
  });

  it("resolves a capable GPU to min(10, runnerMaxFps * 0.9) for live", async () => {
    const cfg = liveCfg({ LIVE_SAMPLE_MAX_FPS: "10", LIVE_SAMPLE_HEADROOM: "0.9" });
    stubHealth(0.077); // runner sustains ~13 fps
    const fps = await resolveSampleFps(cfg, liveOpts(cfg));
    // 13 * 0.9 = 11.7 -> capped at 10
    expect(fps).toBeCloseTo(10.0);
    // A 5 fps-capable GPU: 5 * 0.9 = 4.5, above the 1 fps floor
    stubHealth(0.2); // 5 fps
    expect(await resolveSampleFps(cfg, liveOpts(cfg))).toBeCloseTo(4.5);
  });

  it("keeps a ~1 fps CPU runner at ~1 fps (base-cadence floor beats headroom)", async () => {
    const cfg = liveCfg({ LIVE_SAMPLE_HEADROOM: "0.9" });
    stubHealth(1.0); // CPU runner: 1 fps
    // 1 * 0.9 = 0.9, but the base cadence floor (SAMPLE_INTERVAL_SEC=1.0) holds it at ~1
    expect(await resolveSampleFps(cfg, liveOpts(cfg))).toBeCloseTo(1.0);
  });

  it("stays at the base cadence when perceive is unreachable even with headroom", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const cfg = liveCfg({ LIVE_SAMPLE_HEADROOM: "0.9" });
    expect(await resolveSampleFps(cfg, liveOpts(cfg))).toBeCloseTo(1.0);
  });

  it("does not regress below the incumbent live cadence for a low-but-reported runner", async () => {
    const cfg = liveCfg({ SAMPLE_INTERVAL_SEC: "1.0", LIVE_SAMPLE_HEADROOM: "0.9" });
    stubHealth(1.2); // runner slower than 1 fps (interval 1.2s)
    // (1 / 1.2) * 0.9 = 0.75 -> floored back up to the 1 fps base cadence
    expect(await resolveSampleFps(cfg, liveOpts(cfg))).toBeCloseTo(1.0);
  });
});

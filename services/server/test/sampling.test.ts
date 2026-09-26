import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveSampleFps } from "../src/api";
import { testCfg } from "./helpers";

// ADAAAA-3726: VOD sampling must honor the perceive runner's sustainable
// cadence (GPU toward the "3 live / 8 VOD" charter) instead of a blanket 1 fps
// cap, while CPU safely stays at 1 fps (perceive reports interval >= 1.0) and
// the configured fallback applies when perceive is unreachable.

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
    expect(await resolveSampleFps(cfg, cfg.vodSampleFpsDefault)).toBeCloseTo(5.0);
  });

  it("keeps the live path at the sampleIntervalSec-derived cadence (no VOD default)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const cfg = testCfg({ SAMPLE_INTERVAL_SEC: "1.0" }); // live default
    expect(await resolveSampleFps(cfg)).toBeCloseTo(1.0);
  });

  it("honors a per-job sampleFps override for VOD, still capped by vodSampleMaxFps", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const cfg = testCfg({ VOD_SAMPLE_FPS_DEFAULT: "5", VOD_SAMPLE_MAX_FPS: "8" });
    // Per-job override to 3 fps wins over the 5 fps default.
    expect(await resolveSampleFps(cfg, 3)).toBeCloseTo(3.0);
    // An override above the max is still clamped.
    expect(await resolveSampleFps(cfg, 20)).toBe(8);
  });
});

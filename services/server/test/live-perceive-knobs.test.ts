// ADAAAA-7791: the four documented LIVE perceive knobs were parsed by
// `config.ts` but `buildLiveAnalyzerConfig()` never forwarded them, so the live
// rail always ran the analyzer's built-in fallbacks (OBSERVE_CONTENT_FPS = 2,
// cadence auto-on, quiet stride 2, utilisation 0.6). An operator could verify
// `LIVE_OBSERVE_CONTENT_FPS=0` in `printenv` and the pass still strided/decided
// at 2.0 analysis fps — measured three times in ADAAAA-7782.
//
// The falsy values are the whole point: `0` (content fps, cadence off) is what
// the stride-off arm needs, and both used to be swallowed by `?? default`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";
import type { ServerConfig } from "../src/config";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");

function liveAnalyzer(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    PERCEIVE_URL: "http://p",
    DECIDE_URL: "http://d",
    LIVE_OBSERVE_LOOP: "1",
    ...env,
  });
  return {
    cfg,
    analyzer: buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-perceive-knobs", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    }),
  };
}

describe("live perceive knobs reach the live AnalyzerConfig (ADAAAA-7791)", () => {
  it("forwards 0 / false / 3 / 0.9 verbatim (the falsy cases used to fall back)", () => {
    const { cfg, analyzer } = liveAnalyzer({
      LIVE_OBSERVE_CONTENT_FPS: "0",
      PERCEIVE_CADENCE: "0",
      PERCEIVE_QUIET_STRIDE: "3",
      LIVE_PERCEIVE_UTILIZATION: "0.9",
    });
    // Parsed correctly by config.ts …
    expect(cfg.liveObserveContentFps).toBe(0);
    expect(cfg.perceiveCadence).toBe(false);
    expect(cfg.perceiveQuietStride).toBe(3);
    expect(cfg.livePerceiveUtilization).toBe(0.9);
    // … and carried onto the live pass, including the falsy values.
    expect(analyzer).toMatchObject({
      liveObserveContentFps: 0,
      perceiveCadence: false,
      perceiveQuietStride: 3,
      livePerceiveUtilization: 0.9,
    });
  });

  it("forwards the stride-on defaults (2 / true / 2 / 0.6) when the env is set", () => {
    const { analyzer } = liveAnalyzer({
      LIVE_OBSERVE_CONTENT_FPS: "2",
      PERCEIVE_CADENCE: "1",
      PERCEIVE_QUIET_STRIDE: "2",
      LIVE_PERCEIVE_UTILIZATION: "0.6",
    });
    expect(analyzer).toMatchObject({
      liveObserveContentFps: 2,
      perceiveCadence: true,
      perceiveQuietStride: 2,
      livePerceiveUtilization: 0.6,
    });
  });

  it("forwards perceiveHotAfterS when set", () => {
    const { analyzer } = liveAnalyzer({ PERCEIVE_HOT_AFTER_S: "5" });
    expect(analyzer.perceiveHotAfterS).toBe(5);
  });

  it("an unset env leaves all four undefined so the analyzer defaults hold", () => {
    const { cfg, analyzer } = liveAnalyzer();
    expect(cfg.liveObserveContentFps).toBeUndefined();
    expect(cfg.perceiveCadence).toBeUndefined();
    expect(cfg.perceiveQuietStride).toBeUndefined();
    expect(cfg.livePerceiveUtilization).toBeUndefined();
    expect(analyzer.liveObserveContentFps).toBeUndefined();
    expect(analyzer.perceiveCadence).toBeUndefined();
    expect(analyzer.perceiveQuietStride).toBeUndefined();
    expect(analyzer.livePerceiveUtilization).toBeUndefined();
  });

  it("an empty PERCEIVE_CADENCE (what the compose empty default yields) stays undefined", () => {
    // `PERCEIVE_CADENCE=${PERCEIVE_CADENCE:-}` in compose passes an empty
    // string, not an absent var, so config.ts must keep the tri-state auto rule
    // instead of forcing the shared cadence flag on for the VOD pass.
    const { cfg, analyzer } = liveAnalyzer({ PERCEIVE_CADENCE: "" });
    expect(cfg.perceiveCadence).toBeUndefined();
    expect(analyzer.perceiveCadence).toBeUndefined();
  });

  it("an empty ServerConfig yields undefined for all four (no fabricated values)", () => {
    const analyzer = buildLiveAnalyzerConfig({
      cfg: {} as ServerConfig,
      job: { id: "job-empty-config" },
      clipWindow: { clipBeforeS: 1, clipAfterS: 1 },
    });
    expect(analyzer.liveObserveContentFps).toBeUndefined();
    expect(analyzer.perceiveCadence).toBeUndefined();
    expect(analyzer.perceiveQuietStride).toBeUndefined();
    expect(analyzer.livePerceiveUtilization).toBeUndefined();
  });

  it("compose passes all four knobs into the server service with today's defaults", () => {
    const lines = compose.split("\n");
    const start = lines.findIndex((l) => l === "  server:");
    expect(start).toBeGreaterThanOrEqual(0);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^  [a-zA-Z0-9_.-]+:\s*$/.test(lines[i])) {
        end = i;
        break;
      }
    }
    const server = lines.slice(start, end).join("\n");
    for (const decl of [
      "LIVE_OBSERVE_CONTENT_FPS=${LIVE_OBSERVE_CONTENT_FPS:-2}",
      "PERCEIVE_CADENCE=${PERCEIVE_CADENCE:-}",
      "PERCEIVE_QUIET_STRIDE=${PERCEIVE_QUIET_STRIDE:-2}",
      "LIVE_PERCEIVE_UTILIZATION=${LIVE_PERCEIVE_UTILIZATION:-0.6}",
    ]) {
      expect(server).toContain(decl);
    }
  });
});

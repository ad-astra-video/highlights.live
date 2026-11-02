// ADAAAA-7781: the live decide call is DECODE-bound, so the live pass's decide
// throughput is `decide output tokens/s ÷ tokens per call`. Measured on the box
// (trimmed config: LIVE_OBSERVE_MAX_FRAMES=8, clip off, confirm off) a decide is
// p50 9.4 s for a ~1340-char verdict (~420 output tokens) at low concurrency, and
// the two gemma cards together decode ~150 output tok/s — i.e. ~0.36 decides/s at
// any residency, which is exactly the 2-stream ceiling ADAAAA-7774 measured
// (0.34-0.36/s against a 0.66/s cadence demand).
//
// The lever is therefore tokens per call, not concurrency: `LIVE_DECIDE_COMPACT=1`
// asks the decide service for a compact contract (~150 tokens) on the LIVE rail
// only, and the VOD rail keeps the full long-form contract.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildObserveDecideRequest, LiveRunShared } from "../src/analyzer";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";
import type { ObserveDecidePayload } from "../src/observe-loop";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");

function liveConfig(env: Record<string, string> = {}) {
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
      job: { id: "job-compact", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    }),
  };
}

function payload(): ObserveDecidePayload {
  return {
    centerTs: 1.0,
    frames: [
      { ts: 0.5, imageB64: "f05" },
      { ts: 1.0, imageB64: "f10" },
      { ts: 1.5, imageB64: "f15" },
    ],
    seeds: [],
    biasHints: [],
    capped: false,
    droppedCount: 0,
  };
}

describe("live decide compact contract (ADAAAA-7781)", () => {
  it("defaults to the full contract (unset env is byte-identical)", () => {
    const { cfg, analyzer } = liveConfig();
    expect(cfg.liveDecideCompact).toBe(false);
    expect(analyzer.liveDecideCompact).toBe(false);
    const { opts } = buildObserveDecideRequest(analyzer, new LiveRunShared(), payload());
    expect(opts!.compact).toBe(false);
  });

  it("LIVE_DECIDE_COMPACT=1 projects onto the live analyzer config and the request", () => {
    const { cfg, analyzer } = liveConfig({ LIVE_DECIDE_COMPACT: "1" });
    expect(cfg.liveDecideCompact).toBe(true);
    expect(analyzer.liveDecideCompact).toBe(true);
    const { opts } = buildObserveDecideRequest(analyzer, new LiveRunShared(), payload());
    expect(opts!.compact).toBe(true);
  });

  it("only \"1\" enables it (an explicit 0 or garbage stays off)", () => {
    expect(liveConfig({ LIVE_DECIDE_COMPACT: "0" }).cfg.liveDecideCompact).toBe(false);
    expect(liveConfig({ LIVE_DECIDE_COMPACT: "yes" }).cfg.liveDecideCompact).toBe(false);
  });

  it("does not touch the VOD decide path", () => {
    // The VOD analyzer config never carries the live compact flag, so its decide
    // request has no compact opt-in at all (the decide service defaults to the
    // full contract).
    const { cfg } = liveConfig({ LIVE_DECIDE_COMPACT: "1" });
    expect(cfg.liveDecideCompact).toBe(true);
    const vod = buildObserveDecideRequest(
      { gameHint: "soccer", observeLoop: true, decideWindowN: 3 } as Parameters<
        typeof buildObserveDecideRequest
      >[0],
      new LiveRunShared(),
      payload()
    );
    expect(vod.opts!.compact).toBe(false);
  });

  it("compose passes the knob through with a byte-identical default", () => {
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
    expect(server).toContain("LIVE_DECIDE_COMPACT=${LIVE_DECIDE_COMPACT:-0}");
  });
});

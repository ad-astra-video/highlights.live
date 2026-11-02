// ADAAAA-7777 (lever B): the live decide call's per-call cost is what sets how
// many windows a live stream can decide per second, and the measured box ladder
// (ADAAAA-7773) showed the pass is throughput-bound: 2 streams lag p50 33.7-34.3 s
// with 68-72 windows dropped by the lag budget, decides 36-39 of ~104 windows.
//
// Each trim is a separate env knob so the ladder can measure ONE variable at a
// time and the shipped defaults stay byte-identical to the pre-trim behaviour:
//
//   trim 1  LIVE_OBSERVE_MAX_FRAMES  live window frame budget (default 30)
//   trim 2  LIVE_DECIDE_AUDIO_CLIP   1 = window audio clip + ASR rides the payload
//   trim 3  LIVE_DECIDE_CONFIRM      1 = Stage-2 /confirm dive runs on live
//
// The trim-2 guard is the point of the split: the audio-ENERGY level curve is the
// shared noise-change detection contract, so it must survive dropping the clip.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildObserveDecideRequest, LiveRunShared } from "../src/analyzer";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";
import { LIVE_OBSERVE_MAX_FRAMES } from "../src/observe-loop";
import type { ObserveDecidePayload } from "../src/observe-loop";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");

function liveConfig(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    PERCEIVE_URL: "http://p",
    DECIDE_URL: "http://d",
    LIVE_OBSERVE_LOOP: "1",
    DECIDE_CONFIRM_ENABLED: "1",
    ...env,
  });
  return {
    cfg,
    analyzer: buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-trims", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    }),
  };
}

/** Synthetic observe-window payload (mirrors observe-audio-context.test.ts). */
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

/** ~10 ms of mono 16 kHz int16 PCM as base64 (a decodeable WAV chunk). */
function pcmChunkB64(): string {
  const buf = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) buf.writeInt16LE(Math.round(3000 * Math.sin(i / 8)), i * 2);
  return buf.toString("base64");
}

describe("live decide trim knobs (ADAAAA-7777)", () => {
  it("defaults are the pre-trim behaviour (30 frames, clip on, confirm on)", () => {
    const { cfg, analyzer } = liveConfig();
    expect(cfg.liveObserveMaxFrames).toBe(LIVE_OBSERVE_MAX_FRAMES);
    expect(cfg.liveDecideAudioClip).toBe(true);
    expect(cfg.liveDecideConfirm).toBe(true);
    expect(analyzer.observeMaxFrames).toBe(LIVE_OBSERVE_MAX_FRAMES);
    expect(analyzer.decideAudioClip).toBe(true);
    expect(analyzer.confirmEnabled).toBe(true);
  });

  it("projects each env trim onto the live analyzer config", () => {
    const { cfg, analyzer } = liveConfig({
      LIVE_OBSERVE_MAX_FRAMES: "6",
      LIVE_DECIDE_AUDIO_CLIP: "0",
      LIVE_DECIDE_CONFIRM: "0",
    });
    expect(cfg.liveObserveMaxFrames).toBe(6);
    expect(analyzer.observeMaxFrames).toBe(6);
    expect(analyzer.decideAudioClip).toBe(false);
    expect(analyzer.confirmEnabled).toBe(false);
  });

  it("trim 3 cannot re-enable confirm when the master gate is off", () => {
    const { analyzer } = liveConfig({ DECIDE_CONFIRM_ENABLED: "0", LIVE_DECIDE_CONFIRM: "1" });
    expect(analyzer.confirmEnabled).toBe(false);
  });

  it("trim 2 drops the audio CLIP but keeps the noise-level curve", () => {
    const run = new LiveRunShared();
    for (let i = 0; i < 20; i++) run.addAudioChunk(i * 0.1, pcmChunkB64());
    const cfg = { gameHint: "soccer", audioContext: true, decideAudioClip: false } as Parameters<
      typeof buildObserveDecideRequest
    >[0];
    const { evidence, opts } = buildObserveDecideRequest(cfg, run, payload());
    // No clip -> decide has nothing to ASR.
    expect(opts!.audioB64).toBeUndefined();
    // …but the level curve (the shared noise-change trigger signal) survives.
    expect((evidence.audioLevels as number[]).length).toBeGreaterThan(0);
    expect(evidence.reaction?.crowdEnergy).toBeGreaterThan(0);
  });

  it("trim 2 unset keeps the clip (byte-identical default)", () => {
    const run = new LiveRunShared();
    for (let i = 0; i < 20; i++) run.addAudioChunk(i * 0.1, pcmChunkB64());
    const cfg = { gameHint: "soccer", audioContext: true } as Parameters<typeof buildObserveDecideRequest>[0];
    const { opts } = buildObserveDecideRequest(cfg, run, payload());
    expect((opts!.audioB64 as string).length).toBeGreaterThan(0);
  });

  it("compose passes all three knobs through with pre-trim defaults", () => {
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
      "LIVE_OBSERVE_MAX_FRAMES=${LIVE_OBSERVE_MAX_FRAMES:-30}",
      "LIVE_DECIDE_AUDIO_CLIP=${LIVE_DECIDE_AUDIO_CLIP:-1}",
      "LIVE_DECIDE_CONFIRM=${LIVE_DECIDE_CONFIRM:-1}",
    ]) {
      expect(server).toContain(decl);
    }
  });
});

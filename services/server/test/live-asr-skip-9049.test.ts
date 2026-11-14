// ADAAAA-9049: "browser live rail pays ASR inline on every decide".
//
// Measured on stored rows only (no model call, no GPU, no leg): natural browser
// job `771f42de` reported `asrLane: "inline"` / `asrPrefetchMs: 0` on 14/14
// promoted cards and `timings.asrSource: "inline"` on 819/819 `decide_audit`
// rows (521 s of transcription inside the decide calls), while the box had
// `ASR_URL` set and `LIVE_DECIDE_ASR_PREFETCH=1`. The file-sim rail
// (`d46c3788`) reported `prefetched` on 16/16. So the lane engages on one rail
// and not the other.
//
// The ticket listed two candidates (`ASR_URL` unset, empty audio slice). Both
// are rejected by the census: a 100 %-uniform `inline` census is the shape of a
// lane that NEVER STARTS, not of an intermittently-empty slice — and the decide
// call still receives audio (`audioClipBytes` p50 512 KB), so the ring is
// populated by decide time. The real cause is a third one the ticket did not
// list, of the ADAAAA-8065/8074/8102/8431 class (a knob fed one rail while the
// shipped rail kept the default): `api.ts` built `MediaRailObserver` WITHOUT
// `prefetchAsr`, so the browser rail's `LiveObserver` had no hook and every
// window took the inline road.
//
// These tests pin both halves of the delivery:
//   1. The instrument: one `[live-asr-skip:<job>] @<centre>s reason=<why>` line
//      per skipped window, distinguishing `no-asr-url` from `empty-slice`, plus
//      `lane-unwired` (the defect this ticket found) and `lane-disabled` (the
//      deliberate `LIVE_DECIDE_ASR_PREFETCH=0` posture).
//   2. The fix: the browser/media rail is handed the lane, so a window fired on
//      it carries `[ASR_PREFETCH]` like the analyzer live pass.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  AsrPrefetcher,
  asrPrefetchSkipReason,
  formatAsrSkipLine,
} from "../src/asr-prefetch";
import {
  buildLiveAsrPrefetchLane,
  LiveRunShared,
  windowAudioSlice,
  type AnalyzerConfig,
} from "../src/analyzer";
import { LiveObserver, ASR_PREFETCH, type ObserveDecidePayload } from "../src/observe-loop";
import { MediaRailObserver } from "../src/media-rail";

/** 100 ms of mono 16 kHz int16 silence — enough for the audio ring to slice. */
function pcmChunkB64(): string {
  return Buffer.alloc(3200).toString("base64");
}

function cfgFor(overrides: Partial<AnalyzerConfig> = {}): AnalyzerConfig {
  return {
    gameHint: "soccer",
    jobId: "job-9049",
    audioContext: true,
    ...overrides,
  } as unknown as AnalyzerConfig;
}

function payloadAt(centerTs: number): ObserveDecidePayload {
  return {
    centerTs,
    frames: [
      { ts: centerTs - 1, imageB64: "f0" },
      { ts: centerTs, imageB64: "f1" },
      { ts: centerTs + 1, imageB64: "f2" },
    ],
    seeds: [],
    biasHints: [],
    capped: false,
    droppedCount: 0,
  };
}

/** Capture the skip lines a block emits. */
function captureSkipLines(): { lines: () => string[] } {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    lines: () => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[live-asr-skip:")),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("skip vocabulary (ADAAAA-9049 AC1)", () => {
  it("names no-asr-url when the lane has no endpoint", () => {
    expect(asrPrefetchSkipReason({ enabled: false, clipB64: "clip" })).toBe("no-asr-url");
    // An unset ASR_URL is a skip for EVERY window, whatever the clip holds.
    expect(asrPrefetchSkipReason({ enabled: false, clipB64: "" })).toBe("no-asr-url");
  });

  it("names empty-slice when the endpoint is set but the window has no audio", () => {
    expect(asrPrefetchSkipReason({ enabled: true, clipB64: "" })).toBe("empty-slice");
    // The lane starts on a non-empty clip: no skip reason at all.
    expect(asrPrefetchSkipReason({ enabled: true, clipB64: "clip" })).toBeNull();
  });

  it("emits ONE line per skip in a single greppable shape", () => {
    const line = formatAsrSkipLine("771f42de", 12.345, "no-asr-url");
    expect(line).toBe("[live-asr-skip:771f42de] @12.35s reason=no-asr-url");
    expect(line).not.toContain("\n");
    // Every source shares the shape, so `grep -c '\[live-asr-skip:'` counts
    // skipped windows and the reason field says which condition fired.
    for (const reason of ["no-asr-url", "empty-slice", "lane-unwired", "lane-disabled"] as const) {
      expect(formatAsrSkipLine("j", 1, reason)).toBe(`[live-asr-skip:j] @1.00s reason=${reason}`);
    }
  });
});

describe("the shared lane factory (ADAAAA-9049)", () => {
  it("returns null when the lane is configured OFF — pre-8081 request intact", () => {
    expect(buildLiveAsrPrefetchLane(cfgFor({ decideAsrPrefetch: false }), new LiveRunShared())).toBeNull();
  });

  it("skips with reason=no-asr-url when ASR_URL is unset, one line per window", () => {
    const cap = captureSkipLines();
    const run = new LiveRunShared();
    for (let i = 0; i < 20; i++) run.addAudioChunk(i * 0.1, pcmChunkB64());
    const lane = buildLiveAsrPrefetchLane(cfgFor({ asrUrl: undefined }), run)!;
    expect(lane.prefetcher.enabled).toBe(false);
    expect(lane.prefetchAsr(payloadAt(1))).toBeNull();
    expect(lane.prefetchAsr(payloadAt(2))).toBeNull();
    expect(cap.lines()).toEqual([
      "[live-asr-skip:job-9049] @1.00s reason=no-asr-url",
      "[live-asr-skip:job-9049] @2.00s reason=no-asr-url",
    ]);
  });

  it("skips with reason=empty-slice when the window's audio ring holds nothing", () => {
    const cap = captureSkipLines();
    const run = new LiveRunShared(); // no audio chunks: the ring is empty
    const lane = buildLiveAsrPrefetchLane(cfgFor({ asrUrl: "http://127.0.0.1:1/asr" }), run)!;
    expect(lane.prefetcher.enabled).toBe(true);
    // This is the shape a browser window with a late audio relay produces.
    expect(windowAudioSlice(cfgFor({ asrUrl: "http://127.0.0.1:1/asr" }), run, payloadAt(1)).audioB64).toBe("");
    expect(lane.prefetchAsr(payloadAt(1))).toBeNull();
    expect(cap.lines()).toEqual(["[live-asr-skip:job-9049] @1.00s reason=empty-slice"]);
  });

  it("STARTS (and logs nothing) once the window's audio is in the ring", () => {
    const cap = captureSkipLines();
    const run = new LiveRunShared();
    for (let i = 0; i < 40; i++) run.addAudioChunk(i * 0.1, pcmChunkB64());
    const lane = buildLiveAsrPrefetchLane(cfgFor({ asrUrl: "http://127.0.0.1:1/asr" }), run)!;
    const started = lane.prefetchAsr(payloadAt(2.0));
    expect(started).not.toBeNull();
    // A started prefetch is never a skip line, whatever it later returns.
    expect(cap.lines()).toEqual([]);
    started!.then(() => {}, () => {});
  });
});

describe("LiveObserver names the skip it cannot make (ADAAAA-9049 AC1)", () => {
  it("logs reason=lane-unwired per fired window when the rail has no lane", async () => {
    const cap = captureSkipLines();
    const obs = new LiveObserver({
      jobId: "771f42de",
      cadenceS: 3,
      windowS: 10,
      maxFrames: 30,
      fps: 2,
      onDecide: async () => false,
    });
    for (let t = 0; t <= 12; t += 3) {
      obs.record(t, `f${t}`, { ts: t });
      await obs.maybeFire(t);
    }
    const fired = obs.decideCalls();
    expect(fired).toBeGreaterThan(0);
    const lines = cap.lines();
    // One line per skipped window — never two formats, never a silent skip.
    expect(lines).toHaveLength(fired);
    for (const line of lines) expect(line).toMatch(/^\[live-asr-skip:771f42de\] @\d+\.\d\ds reason=lane-unwired$/);
  });

  it("distinguishes a deliberately disabled lane from an unwired rail", async () => {
    const cap = captureSkipLines();
    const obs = new LiveObserver({
      jobId: "job-9049-off",
      cadenceS: 3,
      windowS: 10,
      maxFrames: 30,
      fps: 2,
      asrLaneOff: true,
      onDecide: async () => false,
    });
    for (let t = 0; t <= 6; t += 3) {
      obs.record(t, `f${t}`, { ts: t });
      await obs.maybeFire(t);
    }
    const lines = cap.lines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toContain("reason=lane-disabled");
  });

  it("says nothing when the lane IS wired and starts", async () => {
    const cap = captureSkipLines();
    const obs = new LiveObserver({
      jobId: "job-9049-wired",
      cadenceS: 3,
      windowS: 10,
      maxFrames: 30,
      fps: 2,
      prefetchAsr: () => Promise.resolve({ transcript: "go", latencyS: 0.4, ran: true }),
      onDecide: async () => false,
    });
    for (let t = 0; t <= 6; t += 3) {
      obs.record(t, `f${t}`, { ts: t });
      await obs.maybeFire(t);
    }
    expect(obs.decideCalls()).toBeGreaterThan(0);
    expect(cap.lines()).toEqual([]);
  });
});

describe("the browser/media rail is handed the lane (ADAAAA-9049 fix)", () => {
  it("forwards prefetchAsr to its LiveObserver: a fired window carries ASR_PREFETCH", async () => {
    const seen: ObserveDecidePayload[] = [];
    // The media node stamps epoch-second content clocks; a small integer clock is
    // treated as evidence-only (no decide), so drive it like a real relay.
    const T0 = Date.now() / 1000;
    const rail = new MediaRailObserver({
      jobId: "job-9049-browser",
      fps: 2,
      cadenceS: 3,
      windowS: 10,
      maxFrames: 4,
      wallClock: () => (T0 + 12) * 1000,
      prefetchAsr: () => Promise.resolve({ transcript: "go", latencyS: 0.4, ran: true }),
      onDecideStaged: (payload) => {
        seen.push(payload);
        return { decide: async () => {}, accept: async () => false };
      },
    });
    for (let i = 0; i <= 12; i += 3) {
      rail.onObservation({ timestamp: T0 + i, tracks: [] } as any, Buffer.from(`jpeg-${i}`).toString("base64"));
      await new Promise((r) => setTimeout(r, 0));
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.length).toBeGreaterThan(0);
    // THE regression: before the fix the rail dropped the hook, every payload
    // was `inline`, and the record could only ever say `asrLane: "inline"`.
    for (const payload of seen) expect(payload[ASR_PREFETCH]).toBeDefined();
  });

  it("api.ts hands the browser rail the shared lane", () => {
    // A unit test of the observer cannot catch an unwired rail — that was the
    // defect — so the construction site itself is guarded (ADAAAA-8431 shape).
    const src = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    const at = src.indexOf("new MediaRailObserver(");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 9000);
    expect(block).toMatch(/prefetchAsr:\s*asrLane\.prefetchAsr/);
    expect(src).toMatch(/const asrLane = buildLiveAsrPrefetchLane\(anaCfg, shared\)/);
  });

  it("the analyzer live pass keeps the same lane (no rail regressed)", () => {
    const src = readFileSync(new URL("../src/analyzer.ts", import.meta.url), "utf8");
    expect(src).toMatch(/const asrLane = buildLiveAsrPrefetchLane\(cfg, run\)/);
    expect(src).toMatch(/prefetchAsr:\s*asrLane\.prefetchAsr/);
  });
});

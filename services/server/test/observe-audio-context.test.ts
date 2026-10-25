import { describe, it, expect } from "vitest";
import { buildObserveDecideRequest, LiveRunShared } from "../src/analyzer";
import type { ObserveDecidePayload } from "../src/observe-loop";

/** Synthetic observe-window payload (mirrors observe-decide-clamp.test.ts). */
function payload(): ObserveDecidePayload {
  return {
    centerTs: 10,
    frames: [{ ts: 9, imageB64: "f9" }, { ts: 10, imageB64: "f10" }],
    seeds: [],
    biasHints: [],
    capped: false,
    droppedCount: 0,
  };
}

/** A short mono 16 kHz int16 PCM chunk (~10 ms) as base64, so audioClipB64()
 * produces a decodeable WAV. */
function pcmChunkB64(ts: number): string {
  const buf = Buffer.alloc(320); // 160 samples
  for (let i = 0; i < 160; i++) buf.writeInt16LE(Math.round(3000 * Math.sin(i / 8)), i * 2);
  return buf.toString("base64");
}

describe("buildObserveDecideRequest carries per-window audio context (ADAAAA-7299)", () => {
  it("forwards the buffered audio clip as opts.audioB64 when audioContext is on", () => {
    const run = new LiveRunShared();
    run.addAudioChunk(9.0, pcmChunkB64(9.0));
    run.addAudioChunk(9.1, pcmChunkB64(9.1));
    const cfg = { gameHint: "soccer", audioContext: true } as Parameters<typeof buildObserveDecideRequest>[0];
    const { opts } = buildObserveDecideRequest(cfg, run, payload());
    expect(opts).toBeDefined();
    expect(opts!.audioB64).toBeTypeOf("string");
    expect((opts!.audioB64 as string).length).toBeGreaterThan(0);
  });

  it("omits audioB64 when no audio was buffered (silent / no-tap window)", () => {
    const run = new LiveRunShared();
    const cfg = { gameHint: "soccer", audioContext: true } as Parameters<typeof buildObserveDecideRequest>[0];
    const { opts } = buildObserveDecideRequest(cfg, run, payload());
    expect(opts).toBeDefined();
    expect(opts!.audioB64).toBeUndefined();
  });

  it("omits audioB64 when audioContext is off (LIVE_AUDIO_CONTEXT=0)", () => {
    const run = new LiveRunShared();
    run.addAudioChunk(9.0, pcmChunkB64(9.0));
    const cfg = { gameHint: "soccer", audioContext: false } as Parameters<typeof buildObserveDecideRequest>[0];
    const { opts } = buildObserveDecideRequest(cfg, run, payload());
    expect(opts).toBeDefined();
    expect(opts!.audioB64).toBeUndefined();
  });
});

/** ADAAAA-7399: a decide payload centred anywhere (to test window-ALIGNED audio
 * rather than the fixed payload() helper's center). */
function payloadAt(center: number, frameTs: number[]): ObserveDecidePayload {
  return {
    centerTs: center,
    frames: frameTs.map((ts) => ({ ts, imageB64: `f${ts}` })),
    seeds: [],
    biasHints: [],
    capped: false,
    droppedCount: 0,
  };
}

describe("VOD window-aligned audio (ADAAAA-7399) — the tap decodes the whole file ahead of the video pass", () => {
  // Simulates the confirmed VOD race: audio at the window (~0-2 s) AND audio at
  // the file END (~20-30 s) both buffered, with the rolling clip previously
  // landing on the file end (so `audioClipB64()` returned FILE-END audio).
  function racedRun(): LiveRunShared {
    const run = new LiveRunShared({ audioRetainS: 3600 });
    for (let i = 0; i < 20; i++) run.addAudioChunk(i * 0.1, pcmChunkB64(i * 0.1)); // 0.0-1.9 s (window)
    for (let i = 200; i < 300; i++) run.addAudioChunk(i * 0.1, pcmChunkB64(i * 0.1)); // 20.0-29.9 s (file end)
    return run;
  }

  it("slices audio around the window CENTER, not the file end", () => {
    const run = racedRun();
    const windowClip = run.audioWindowB64(1.0, 1.0, 1.0); // chunks in [0, 2]
    expect(windowClip.length).toBeGreaterThan(0);
    // A silent gap (no buffered audio around t=10 s) yields "" — no regression.
    expect(run.audioWindowB64(10.0, 1.0, 1.0)).toBe("");
    // The retained timeline keeps the file-end audio too (present, but NOT
    // forwarded as the window clip) — proves the rolling buffer no longer
    // masks the window with file-end audio.
    expect(run.audioWindowB64(25.0, 1.0, 1.0).length).toBeGreaterThan(0);
  });

  it("forwards the CENTER-aligned audio + levels, not file-end audio, for the window", () => {
    const run = racedRun();
    const cfg = { gameHint: "soccer", audioContext: true } as Parameters<typeof buildObserveDecideRequest>[0];
    const { evidence, opts } = buildObserveDecideRequest(cfg, run, payloadAt(1.0, [0.5, 1.0, 1.5]));
    // Window has audio near center -> audioB64 present + audioLevels + reaction
    expect((opts!.audioB64 as string).length).toBeGreaterThan(0);
    expect((evidence.audioLevels as number[]).length).toBeGreaterThan(0);
    expect(evidence.reaction?.crowdEnergy).toBeGreaterThan(0);
  });

  it("keeps a silent window text-only (no audio, no levels, no audio reaction)", () => {
    const run = racedRun();
    const cfg = { gameHint: "soccer", audioContext: true } as Parameters<typeof buildObserveDecideRequest>[0];
    const { evidence, opts } = buildObserveDecideRequest(cfg, run, payloadAt(10.0, [9.5, 10.0, 10.5]));
    expect(opts!.audioB64).toBeUndefined();
    expect(evidence.audioLevels).toEqual([]);
    expect(evidence.reaction?.crowdEnergy).toBe(0);
  });
});

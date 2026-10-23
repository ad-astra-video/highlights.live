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

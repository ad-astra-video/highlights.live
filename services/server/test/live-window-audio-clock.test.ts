// ADAAAA-7671: live analysis windows must carry the audio of the moment they
// analyze. On live, the decide loop lags the real-time audio tap (one ~10 s
// gemma call per ~3 s of content), so pruning the tap buffer relative to the
// NEWEST chunk (real time) discarded exactly the audio the current window
// needed. Measured on the deployed image: 1/9, 1/7 and 1/17 windows carried a
// window audio slice + transcript (`T+0-3s` only), with `audioSeries` empty for
// every later window too (perceive's series snapshot was kept as "latest only",
// and the tap had raced far past the window's content time).
//
// These tests pin the two invariants the fix establishes:
//   1. audio retention is anchored on the video rail's ANALYSIS POSITION, not on
//      the newest tap chunk;
//   2. the audio-gate inspection series ACCUMULATES over content time, so a
//      window far behind the tap still finds its energy series.
import { describe, it, expect } from "vitest";
import {
  AUDIO_BUFFER_MAX_S,
  AUDIO_CLIP_KEEP_S,
  buildObserveDecideRequest,
  LIVE_AUDIO_RETAIN_S,
  LiveRunShared,
} from "../src/analyzer";
import type { ObserveDecidePayload } from "../src/observe-loop";

/** ~100 ms mono 16 kHz int16 PCM chunk (3200 bytes) — the tap's real chunk. */
function pcmChunk(seed: number): string {
  const buf = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) buf.writeInt16LE(Math.round(4000 * Math.sin((i + seed) / 6)), i * 2);
  return buf.toString("base64");
}

/** Read the RIFF `data` chunk back out of a base64 WAV. */
function wavData(b64: string): Buffer {
  const wav = Buffer.from(b64, "base64");
  const dataSize = wav.readUInt32LE(40);
  return wav.subarray(44, 44 + dataSize);
}

/** The tap's chunk end-timestamps: one every 100 ms, starting at 0.1 s. */
function tapTimestamps(tapTs: number): number[] {
  return Array.from({ length: Math.round(tapTs / 0.1) }, (_v, i) => (i + 1) * 0.1);
}

/** How many of those chunks the window slice must contain. */
function countInRange(ts: number[], lo: number, hi: number): number {
  return ts.filter((t) => t >= lo && t <= hi).length;
}

/** A live run whose decide loop has only processed content up to `posTs` while
 * the audio tap (real time) has already buffered through `tapTs`. */
function laggingLiveRun(posTs: number, tapTs: number): { run: LiveRunShared; ts: number[] } {
  const run = new LiveRunShared({ audioRetainS: LIVE_AUDIO_RETAIN_S });
  // Video rail: 1 fps frames, the pipeline has decided up to `posTs`.
  for (let t = 0; t <= posTs; t++) run.addFrame(t, t, `frame-${t}`);
  // Audio tap: ~10 Hz chunks in real time, already ahead of the pipeline.
  const ts = tapTimestamps(tapTs);
  ts.forEach((t, i) => run.addAudioChunk(t, pcmChunk(i)));
  return { run, ts };
}

describe("live window audio retention follows the analysis position (ADAAAA-7671)", () => {
  it("slices the audio of a window whose content time the tap has long passed", () => {
    // Pipeline at content 9 s; the tap already buffered 60 s of real time.
    const { run, ts } = laggingLiveRun(9, 60);
    // Live observe window: rolling 10 s ending at the center, +2 s margins.
    const b64 = run.audioWindowB64(9, 12, 2);
    // Pre-fix (retention measured from the newest chunk at 60 s) the whole
    // window had been pruned away and this was "".
    expect(b64.length).toBeGreaterThan(0);
    const expected = countInRange(ts, -3, 11);
    expect(expected).toBeGreaterThan(90);
    expect(wavData(b64).length).toBe(expected * 3200);
  });

  it("keeps the retention window anchored on the analysis position", () => {
    const { run } = laggingLiveRun(9, 60);
    const span = run.audioSpan();
    expect(span.pos).toBe(9);
    // Retention reaches back 20 s from the pipeline position, and the hard
    // memory cap never lets the buffer run away.
    expect(span.from).not.toBeNull();
    expect(span.from as number).toBeGreaterThanOrEqual(-LIVE_AUDIO_RETAIN_S);
    expect(span.to).toBeCloseTo(60, 5);
  });

  it("hard-caps the buffer when the tap races far ahead of a stalled pipeline", () => {
    const { run } = laggingLiveRun(0, 400);
    const span = run.audioSpan();
    expect(span.pos).toBe(0);
    expect(span.to).toBeCloseTo(400, 5);
    // Nothing older than AUDIO_BUFFER_MAX_S behind the newest chunk survives.
    expect(span.from as number).toBeGreaterThanOrEqual(400 - AUDIO_BUFFER_MAX_S);
  });

  it("still prunes relative to the newest chunk when no frames have landed", () => {
    // Pure audio-tap run (no video rail): legacy behaviour is preserved.
    const run = new LiveRunShared({ audioRetainS: LIVE_AUDIO_RETAIN_S });
    tapTimestamps(40).forEach((t, i) => run.addAudioChunk(t, pcmChunk(i)));
    const span = run.audioSpan();
    expect(span.pos).toBeNull();
    expect(span.from as number).toBeGreaterThanOrEqual(40 - LIVE_AUDIO_RETAIN_S);
    expect(run.audioWindowB64(40, 1, 1).length).toBeGreaterThan(0);
  });

  it("keeps audioClipB64 bounded to AUDIO_CLIP_KEEP_S even with a longer retention", () => {
    const { run } = laggingLiveRun(9, 60);
    const data = wavData(run.audioClipB64());
    // Clip semantics are unchanged: the last AUDIO_CLIP_KEEP_S seconds only, so
    // a lagging pipeline can never inflate the confirm clip into a 20 s WAV.
    expect(data.length / 2 / 16000).toBeCloseTo(AUDIO_CLIP_KEEP_S, 1);
  });

  it("accumulates the audio-gate series so a lagging window still renders energy", () => {
    const run = new LiveRunShared({ audioRetainS: LIVE_AUDIO_RETAIN_S });
    for (let t = 0; t <= 9; t++) run.addFrame(t, t, `frame-${t}`);
    // The tap posts ~10 Hz; perceive answers each POST with its ~1.7 s lookback
    // snapshot. Only accumulating them covers the whole timeline.
    for (let i = 0; i < 600; i++) {
      const t = Number(((i + 1) * 0.1).toFixed(3));
      const points: { t: number; energy: number; baseline: number }[] = [];
      for (let k = 16; k >= 0; k--) {
        const pt = Number((t - k * 0.1).toFixed(3));
        if (pt > 0) points.push({ t: pt, energy: 0.2 + (pt % 1) / 10, baseline: 0.1 });
      }
      run.setAudioSeries(points);
    }
    const series = run.seriesWindow(9, 2, 3);
    expect(series.length).toBeGreaterThan(40); // ~5 s of 10 Hz points
    expect(series[0].t).toBeGreaterThanOrEqual(7);
    expect(series[series.length - 1].t).toBeLessThanOrEqual(12);
  });

  it("carries the lagging window's audio into the live decide request", () => {
    const { run } = laggingLiveRun(9, 60);
    const payload: ObserveDecidePayload = {
      centerTs: 9,
      frames: [
        { ts: 0, imageB64: "f0" },
        { ts: 5, imageB64: "f5" },
        { ts: 9, imageB64: "f9" },
      ],
      seeds: [],
      biasHints: [],
      capped: false,
      droppedCount: 0,
    };
    const cfg = {
      gameHint: "soccer",
      audioContext: true,
      liveObserveLoop: true,
      jobId: "job-7671",
    } as Parameters<typeof buildObserveDecideRequest>[0];
    const { evidence, opts } = buildObserveDecideRequest(cfg, run, payload);
    expect((opts?.audioB64 as string | undefined)?.length ?? 0).toBeGreaterThan(0);
    expect(evidence.audioLevels?.length ?? 0).toBeGreaterThan(0);
    expect(evidence.reaction?.crowdEnergy ?? 0).toBeGreaterThan(0);
  });
});

describe("VOD window audio slicing is unchanged (ADAAAA-7399 regression guard)", () => {
  it("slices a mid-file window out of the fully decoded VOD timeline", () => {
    const run = new LiveRunShared({ decideWindowN: 16, audioRetainS: 1800 });
    for (let t = 0; t <= 600; t++) run.addFrame(t, t, `frame-${t}`);
    // The VOD tap decodes the whole file ahead of the video pass.
    const ts = tapTimestamps(600);
    ts.forEach((t, i) => run.addAudioChunk(t, pcmChunk(i)));
    const b64 = run.audioWindowB64(300, 5, 5);
    expect(b64.length).toBeGreaterThan(0);
    expect(wavData(b64).length).toBe(countInRange(ts, 295, 305) * 3200);
    expect(run.audioWindowB64(1600, 5, 5)).toBe(""); // outside the retained timeline
  });
});

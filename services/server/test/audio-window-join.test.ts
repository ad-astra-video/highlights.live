import { describe, it, expect } from "vitest";
import { buildConfirmContext, joinPcmB64Parts, LiveRunShared } from "../src/analyzer";

/** ~100 ms mono 16 kHz int16 PCM chunk (3200 bytes — the tap's real chunk size,
 * deliberately NOT a multiple of 3 so its base64 string carries `=` padding). */
function pcmChunk(seed: number): Buffer {
  const buf = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) {
    buf.writeInt16LE(Math.round(4000 * Math.sin((i + seed) / 6)), i * 2);
  }
  return buf;
}

/** Read the RIFF `data` chunk back out of a base64 WAV. */
function wavData(b64: string): Buffer {
  const wav = Buffer.from(b64, "base64");
  const dataSize = wav.readUInt32LE(40);
  return wav.subarray(44, 44 + dataSize);
}

describe("joinPcmB64Parts / window audio assembly (ADAAAA-7665)", () => {
  it("joins independently-padded base64 PCM parts byte-exactly", () => {
    const a = pcmChunk(0);
    const b = pcmChunk(500);
    // Guard the premise: each part's base64 carries `=` padding, which is why a
    // plain string join truncates at the first `=`.
    expect(a.toString("base64").endsWith("=")).toBe(true);

    const joined = Buffer.from(joinPcmB64Parts([a.toString("base64"), b.toString("base64")]), "base64");
    expect(joined.equals(Buffer.concat([a, b]))).toBe(true);
    expect(joined.length).toBe(6400);
  });

  it("returns the single part unchanged and '' for no parts", () => {
    const a = pcmChunk(0).toString("base64");
    expect(joinPcmB64Parts([a])).toBe(a);
    expect(joinPcmB64Parts([])).toBe("");
  });

  it("audioWindowB64 ships the WHOLE window, not just its first 100 ms chunk", () => {
    const run = new LiveRunShared();
    const ts: number[] = [];
    // A 6 s window at the tap's 100 ms cadence: 60 chunks.
    for (let i = 0; i < 60; i++) {
      const t = 9 + (i + 1) * 0.1;
      ts.push(t);
      run.addAudioChunk(t, pcmChunk(i).toString("base64"));
    }
    const b64 = run.audioWindowB64(9.3, 1.0, 1.0);
    expect(b64.length).toBeGreaterThan(0);
    const inWindow = ts.filter((t) => t >= 8.3 && t <= 10.3).length;
    expect(inWindow).toBeGreaterThan(5);
    const data = wavData(b64);
    expect(data.length).toBe(inWindow * 3200);
    // 16 kHz mono int16 -> 2 bytes per sample. Pre-fix this read 0.1 s (one
    // chunk) instead of the full ~1.3 s window.
    expect(data.length / 2 / 16000).toBeCloseTo((inWindow * 0.1), 5);
    expect(data.length / 2 / 16000).toBeGreaterThan(1);
  });

  it("audioClipB64 also ships every buffered chunk", () => {
    const run = new LiveRunShared();
    for (let i = 0; i < 10; i++) run.addAudioChunk((i + 1) * 0.1, pcmChunk(i).toString("base64"));
    expect(wavData(run.audioClipB64()).length).toBe(10 * 3200);
  });

  it("Stage-2 confirm audio is bounded to the confirm window, not the whole VOD", async () => {
    // VOD wires vodAudioRetainS (default 1800 s), so the rolling clip is the
    // WHOLE file: an unbounded confirm payload is the entire clip.
    const run = new LiveRunShared({ audioRetainS: 1800 });
    for (let i = 0; i < 600; i++) run.addAudioChunk((i + 1) * 0.1, pcmChunk(i).toString("base64"));
    const cfg = {
      gameHint: "soccer",
      preWindowS: 3,
      postWindowS: 3,
      confirmWindowExtraS: 4,
      audioContext: true,
    } as Parameters<typeof buildConfirmContext>[1];
    const ctx = await buildConfirmContext(
      run,
      cfg,
      { timestamp: 20 },
      { isHighlight: true } as Parameters<typeof buildConfirmContext>[3],
      20
    );
    const secs = wavData(ctx.audioB64).length / 2 / 16000;
    expect(secs).toBeGreaterThan(5); // still a real window
    // 2 x AUDIO_CLIP_KEEP_S plus the inclusive-boundary chunk — never the 60 s
    // clip (let alone the whole multi-minute VOD file).
    expect(secs).toBeLessThanOrEqual(21);
  });
});

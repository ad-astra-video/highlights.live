import { describe, it, expect } from "vitest";
import { LiveRunShared, wavFromPcm16 } from "../src/analyzer";

describe("LiveRunShared (ADAAAA-4785: gemma frame + audio analysis around a noise trigger)", () => {
  it("assembles a temporal frame SEQUENCE (not a single still) around the trigger", () => {
    const s = new LiveRunShared();
    // Feed a 1-fps sampled stream: frames at t=0..5.
    for (let i = 0; i <= 5; i++) s.addFrame(i, i, `img-${i}`);
    // Candidate fired at t=3.5 (between video samples) — the window must be the
    // frames AT/BEFORE the trigger in chronological order, not future frames.
    const win = s.framesWindow(3.5, 16);
    expect(win.length).toBe(4); // t=0,1,2,3
    expect(win.map((f) => f.timestamp)).toEqual([0, 1, 2, 3]);
    expect(win.map((f) => f.base64)).toEqual(["img-0", "img-1", "img-2", "img-3"]);
    expect(win[0].role).toBe("frame");
    // The anchored still still resolves correctly (regression check).
    expect(s.anchor(3.5)).toBe("img-3");
  });

  it("caps the window at n frames and never includes frames after the trigger", () => {
    const s = new LiveRunShared();
    for (let i = 0; i <= 10; i++) s.addFrame(i, i, `img-${i}`);
    const win = s.framesWindow(4.0, 3);
    expect(win.length).toBe(3);
    expect(win.map((f) => f.timestamp)).toEqual([2, 3, 4]);
  });

  it("buffers mono PCM chunks and assembles a valid WAV clip around the trigger", () => {
    const s = new LiveRunShared();
    // Each chunk is ~100ms worth of int16 mono: 16000*0.1*2 = 3200 bytes.
    const chunkBytes = 3200;
    for (let i = 0; i < 60; i++) {
      const pcm = Buffer.alloc(chunkBytes, i & 0xff); // deterministic filler
      s.addAudioChunk(0.1 * (i + 1), pcm.toString("base64"));
    }
    const clip = s.audioClipB64(3.0, 0.5, 0.5); // window [2.5, 3.5]
    expect(clip).not.toBe("");
    const wav = Buffer.from(clip, "base64");
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // 16-bit
    // data = ~2.0s of audio (20 chunks * 0.1s) minus framing -> amount in window
    expect(wav.length).toBeGreaterThan(44);
  });

  it("returns empty audio when no chunks are buffered in range", () => {
    const s = new LiveRunShared();
    s.addAudioChunk(10.0, Buffer.alloc(3200).toString("base64"));
    expect(s.audioClipB64(3.0)).toBe("");
  });

  it("builds a canonical PCM WAV header from raw int16 bytes", () => {
    const wav = wavFromPcm16(Buffer.from([0, 0, 1, 0]), 16000);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + 4);
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(36, 40).toString()).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(4);
    expect(wav.length).toBe(48);
  });
});

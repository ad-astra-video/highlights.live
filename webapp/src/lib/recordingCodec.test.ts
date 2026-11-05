import { describe, it, expect } from "vitest";
import {
  RECORDING_MIME_LADDER,
  MIN_RECORDED_BYTES,
  RECORDING_STALL_MS,
  recordingStalled,
  supportedRecordingMimes,
} from "./recordingCodec";

// ADAAAA-8055: a browser can claim `video/mp4;codecs=avc1` and then record only
// a container header, which left every screen-share highlight with no clip.
// These pin the two decisions that keep the rail on a container it can produce.

describe("recording codec ladder (ADAAAA-8055)", () => {
  it("prefers WebM and keeps mp4 only as a last resort", () => {
    expect(RECORDING_MIME_LADDER[0]).toBe("video/webm;codecs=vp9");
    expect(RECORDING_MIME_LADDER.indexOf("video/mp4;codecs=avc1")).toBe(RECORDING_MIME_LADDER.length - 1);
  });

  it("keeps the supported mimes in ladder order", () => {
    const all = supportedRecordingMimes(() => true);
    expect(all).toEqual([...RECORDING_MIME_LADDER]);
  });

  it("drops containers the browser cannot record", () => {
    // Safari-like: WebM unsupported, mp4 supported -> mp4 is chosen.
    expect(supportedRecordingMimes((m) => !m.includes("webm"))).toEqual(["video/mp4;codecs=avc1"]);
    // Chrome-like: only the plain webm fallback is offered.
    expect(supportedRecordingMimes((m) => m === "video/webm")).toEqual(["video/webm"]);
  });

  it("survives an isTypeSupported that throws", () => {
    expect(
      supportedRecordingMimes((m) => {
        if (m.includes("vp9")) throw new Error("boom");
        return true;
      })
    ).toEqual(["video/webm", "video/mp4;codecs=avc1"]);
  });

  it("returns no mime when nothing is supported (recorder default is used)", () => {
    expect(supportedRecordingMimes(() => false)).toEqual([]);
  });
});

describe("recordingStalled (ADAAAA-8055)", () => {
  it("flags a header-only recorder after the stall window", () => {
    expect(recordingStalled({ bytes: 752, ms: RECORDING_STALL_MS, state: "recording" })).toBe(true);
    expect(recordingStalled({ bytes: 0, ms: RECORDING_STALL_MS + 5000, state: "recording" })).toBe(true);
  });

  it("does not flag a healthy recording", () => {
    expect(recordingStalled({ bytes: 3_000_000, ms: RECORDING_STALL_MS, state: "recording" })).toBe(false);
    expect(recordingStalled({ bytes: MIN_RECORDED_BYTES, ms: RECORDING_STALL_MS, state: "recording" })).toBe(false);
  });

  it("does not flag before the stall window", () => {
    expect(recordingStalled({ bytes: 0, ms: RECORDING_STALL_MS - 1, state: "recording" })).toBe(false);
  });

  it("does not flag a recorder that is not running", () => {
    expect(recordingStalled({ bytes: 0, ms: RECORDING_STALL_MS * 3, state: "inactive" })).toBe(false);
    expect(recordingStalled({ bytes: 0, ms: RECORDING_STALL_MS * 3, state: "paused" })).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  DISPLAY_CAPTURE_CONSTRAINTS,
  MAX_CAPTURE_FPS,
  MAX_CAPTURE_HEIGHT,
  MAX_CAPTURE_WIDTH,
  MAX_SEND_BITRATE,
  applySenderBounds,
  boundedSenderParameters,
  captureSettingsAreBounded,
} from "./captureBounds";

// ADAAAA-8848 (F1): a screen share used to ask `getDisplayMedia({video:true})`,
// i.e. native pixels. A 4K share then encoded 3840x2160 (31.6 MB decoded per
// frame) with no bitrate cap on the RTC sender — the largest single cause of the
// tab OOM the CEO reported, and nothing downstream reads those pixels.
describe("capture bounds (ADAAAA-8848 F1)", () => {
  it("requests 1080p30 as the MAXIMUM capture", () => {
    expect(MAX_CAPTURE_WIDTH).toBe(1920);
    expect(MAX_CAPTURE_HEIGHT).toBe(1080);
    expect(MAX_CAPTURE_FPS).toBe(30);
    expect(DISPLAY_CAPTURE_CONSTRAINTS).toEqual({
      video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } },
      // The share still carries tab sound for clips + audio analysis.
      audio: true,
    });
  });

  it("grades a 4K track's getSettings() as unbounded and a 1080p track as bounded", () => {
    expect(captureSettingsAreBounded({ width: 3840, height: 2160, frameRate: 30 })).toBe(false);
    expect(captureSettingsAreBounded({ width: 2560, height: 1440, frameRate: 60 })).toBe(false);
    expect(captureSettingsAreBounded({ width: 1920, height: 1080, frameRate: 30 })).toBe(true);
    // A browser may give less than requested (and a smaller display) — fine.
    expect(captureSettingsAreBounded({ width: 1280, height: 720, frameRate: 15 })).toBe(true);
  });

  it("caps every sender encoding at 2.5 Mbps and degrades by frame rate, not resolution", () => {
    const params = boundedSenderParameters({
      transactionId: "t1",
      degradationPreference: "balanced",
      encodings: [{ rid: "a", maxBitrate: 9_000_000 }, { rid: "b" }],
    } as RTCRtpSendParameters);
    expect(params.encodings.map((e) => e.maxBitrate)).toEqual([MAX_SEND_BITRATE, MAX_SEND_BITRATE]);
    // SSRC/RTX fields survive the cap.
    expect(params.encodings.map((e) => e.rid)).toEqual(["a", "b"]);
    expect(params.degradationPreference).toBe("maintain-resolution");
    expect(params.transactionId).toBe("t1");
  });

  it("bounds a pre-negotiation sender that has no encodings yet", () => {
    const params = boundedSenderParameters({
      transactionId: "t0",
      encodings: [],
    } as unknown as RTCRtpSendParameters);
    expect(params.encodings).toHaveLength(1);
    expect(params.encodings[0].maxBitrate).toBe(MAX_SEND_BITRATE);
    expect(params.degradationPreference).toBe("maintain-resolution");
  });

  it("never raises a cap that is already below the ceiling", () => {
    const params = boundedSenderParameters({
      transactionId: "t2",
      encodings: [{ maxBitrate: 1_200_000 }],
    } as RTCRtpSendParameters);
    expect(params.encodings[0].maxBitrate).toBe(1_200_000);
  });

  it("applies the cap to a real sender and swallows a pre-negotiation rejection", async () => {
    const setParameters = vi.fn(async () => {});
    const sender = {
      getParameters: () => ({ transactionId: "x", encodings: [{ maxBitrate: 8_000_000 }] }),
      setParameters,
    } as unknown as RTCRtpSender;
    expect(await applySenderBounds(sender)).toBe(true);
    expect(setParameters).toHaveBeenCalledTimes(1);
    const applied = (setParameters.mock.calls[0] as unknown as [RTCRtpSendParameters])[0];
    expect(applied.encodings[0].maxBitrate).toBe(MAX_SEND_BITRATE);
    expect(applied.degradationPreference).toBe("maintain-resolution");

    const rejecting = {
      getParameters: () => ({ transactionId: "y", encodings: [] }),
      setParameters: async () => {
        throw new Error("InvalidStateError");
      },
    } as unknown as RTCRtpSender;
    // A failed cap must never abort the share.
    expect(await applySenderBounds(rejecting)).toBe(false);
    expect(await applySenderBounds(null)).toBe(false);
  });
});

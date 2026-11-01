// ADAAAA-7700 — what the live screen-share panel says when its job ends underneath.
//
// The 22:16Z defect surfaced NOTHING: the media node restarted, the RTC session
// died and the job flipped to `failed` with 0 frames while the panel still read
// "Capturing live". These tests pin the panel's decision function.
import { describe, expect, it } from "vitest";
import { captureEndedNotice } from "./captureLoss";
import { failureReasonLabel, isInfrastructureFailure } from "./failureReason";

describe("captureEndedNotice (ADAAAA-7700)", () => {
  it("keeps capturing while the job is live", () => {
    for (const status of ["active", "queued", "analyzing", "extracting", "finalizing"]) {
      expect(captureEndedNotice({ status })).toEqual({ stop: false, message: null });
    }
  });

  it("tells the operator the media node restarted and to reshare", () => {
    const n = captureEndedNotice({ status: "failed", failureReason: "media-session-lost" });
    expect(n.stop).toBe(true);
    expect(n.message).toMatch(/media node restarted/i);
    expect(n.message).toMatch(/click start to share again/i);
  });

  it("distinguishes an analyzer restart from a media-node restart", () => {
    const n = captureEndedNotice({ status: "failed", failureReason: "server-restart" });
    expect(n.stop).toBe(true);
    expect(n.message).toMatch(/analyzer restarted/i);
    expect(n.message).not.toMatch(/media node restarted/i);
  });

  it("falls back to the server's error text, then a generic line", () => {
    const withError = captureEndedNotice({ status: "failed", error: "reserve perceive failed: HTTP 503" });
    expect(withError.stop).toBe(true);
    expect(withError.message).toMatch(/HTTP 503/);
    const bare = captureEndedNotice({ status: "failed" });
    expect(bare.stop).toBe(true);
    expect(bare.message).toMatch(/click start to share again/i);
  });

  it("stops quietly when the share ended normally", () => {
    expect(captureEndedNotice({ status: "done" })).toEqual({ stop: true, message: null });
    expect(captureEndedNotice({ status: "cancelled" })).toEqual({ stop: true, message: null });
  });

  it("does not stop on a missing snapshot", () => {
    expect(captureEndedNotice(null)).toEqual({ stop: false, message: null });
  });
});

describe("failureReason labels (ADAAAA-7700)", () => {
  it("labels the attributed reasons and never renders a bare enum", () => {
    expect(failureReasonLabel("media-session-lost")).toBe("media session lost");
    expect(failureReasonLabel("server-restart")).toBe("analyzer restart");
    expect(failureReasonLabel("user-stop")).toBe("stopped by user");
    expect(failureReasonLabel(null)).toBeNull();
    expect(failureReasonLabel(undefined)).toBeNull();
  });

  it("classifies infrastructure failures separately from a user stop", () => {
    expect(isInfrastructureFailure("media-session-lost")).toBe(true);
    expect(isInfrastructureFailure("server-restart")).toBe(true);
    expect(isInfrastructureFailure("user-stop")).toBe(false);
    expect(isInfrastructureFailure(null)).toBe(false);
  });
});

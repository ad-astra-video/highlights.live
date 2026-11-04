import { describe, expect, it } from "vitest";
import {
  elapsedSeconds,
  formatElapsed,
  isLiveJobStatus,
  isLiveStageSource,
  liveStageView,
  noPreviewText,
} from "./liveStage";

// ADAAAA-7976: the live-stage state machine is pure so every branch the detail
// page renders (video / no preview / stopped) is pinned without a DOM.
describe("live stage state (ADAAAA-7976)", () => {
  const now = Date.parse("2026-11-04T12:01:02Z");

  it("classifies live-stage sources and leaves VOD out", () => {
    for (const s of ["browser", "screenshare", "screen", "rtmp", "webrtc", "file-sim"]) {
      expect(isLiveStageSource(s)).toBe(true);
    }
    expect(isLiveStageSource("file")).toBe(false);
    expect(isLiveStageSource(null)).toBe(false);
  });

  it("knows terminal vs in-flight statuses", () => {
    for (const s of ["queued", "active", "extracting", "analyzing", "finalizing"]) {
      expect(isLiveJobStatus(s)).toBe(true);
    }
    for (const s of ["done", "failed", "cancelled", null]) {
      expect(isLiveJobStatus(s)).toBe(false);
    }
  });

  it("formats elapsed as m:ss and h:mm:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7)).toBe("0:07");
    expect(formatElapsed(62)).toBe("1:02");
    expect(formatElapsed(3725)).toBe("1:02:05");
    expect(formatElapsed(null)).toBe("—");
    expect(elapsedSeconds("2026-11-04T12:00:00Z", now)).toBe(62);
    expect(elapsedSeconds(null, now)).toBeNull();
    expect(elapsedSeconds("not-a-date", now)).toBeNull();
  });

  it("renders the video mode only when this page's capture owns the job", () => {
    const view = liveStageView({
      jobStatus: "active",
      jobSource: "browser",
      createdAt: "2026-11-04T12:00:00Z",
      ownsCapture: true,
      hasCaptureStream: true,
      now,
    });
    expect(view.mode).toBe("video");
    expect(view.showVideo).toBe(true);
    expect(view.showNoPreview).toBe(false);
    expect(view.canStop).toBe(true);
    expect(view.statusLabel).toBe("ACTIVE");
    expect(view.elapsedLabel).toBe("1:02");
  });

  it("does not fake a video when the stream is missing", () => {
    const view = liveStageView({
      jobStatus: "active",
      jobSource: "browser",
      createdAt: "2026-11-04T12:00:00Z",
      ownsCapture: true,
      hasCaptureStream: false,
      now,
    });
    expect(view.mode).toBe("nopreview");
    expect(view.showVideo).toBe(false);
    expect(view.showNoPreview).toBe(true);
    expect(view.noPreviewReason).toBe("local-capture-absent");
  });

  it("labels RTMP/WebRTC as external ingest (no playback route exists)", () => {
    for (const source of ["rtmp", "webrtc"]) {
      const view = liveStageView({ jobStatus: "active", jobSource: source, createdAt: "2026-11-04T12:00:00Z", now });
      expect(view.mode).toBe("nopreview");
      expect(view.noPreviewReason).toBe("external");
      expect(view.showVideo).toBe(false);
      expect(view.canStop).toBe(true);
    }
    expect(noPreviewText("external", "webrtc")).toContain("WebRTC");
    expect(noPreviewText("external", "rtmp")).toContain("RTMP");
    expect(noPreviewText("local-capture-absent")).toContain("reload");
  });

  it("switches to the stopped state on a terminal job or a user stop", () => {
    const terminal = liveStageView({ jobStatus: "done", jobSource: "browser", createdAt: "2026-11-04T12:00:00Z", completedAt: "2026-11-04T12:05:00Z", now });
    expect(terminal.mode).toBe("stopped");
    expect(terminal.canStop).toBe(false);
    expect(terminal.showVideo).toBe(false);
    expect(terminal.showNoPreview).toBe(false);
    expect(terminal.elapsedLabel).toBe("5:00");

    const userStopped = liveStageView({
      jobStatus: "active",
      jobSource: "browser",
      createdAt: "2026-11-04T12:00:00Z",
      ownsCapture: true,
      hasCaptureStream: true,
      stopped: true,
      now,
    });
    expect(userStopped.mode).toBe("stopped");
    expect(userStopped.canStop).toBe(false);
    expect(userStopped.showVideo).toBe(false);
  });
});

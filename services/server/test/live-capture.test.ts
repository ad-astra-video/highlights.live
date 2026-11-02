import { describe, expect, it } from "vitest";
import {
  deriveLiveCapture,
  LIVE_CAPTURE_FIRST_WINDOW_BUDGET_S,
  LIVE_CAPTURE_STALE_S,
  type LiveCaptureInput,
} from "../src/live-capture";

// ADAAAA-7750 AC3: the capture projection that replaces the bare
// `No analysis windows for this job.` The board's job (386 frames, 63 decided
// windows, 0 confirmed highlights, status `done`) and a share whose browser
// never reached the media node used to render identically. Each situation is
// pinned here on the pure function, so the copy the customer reads cannot
// silently regress to an empty list.

const NOW = Date.parse("2026-11-02T06:04:24.000Z");

const browserJob = (over: Record<string, unknown> = {}) =>
  ({
    status: "active",
    source: "browser",
    createdAt: "2026-11-02T06:00:00.000Z",
    startedAt: "2026-11-02T06:00:00.000Z",
    summaryLog: [],
    ...over,
  }) as LiveCaptureInput["job"];

const windows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ ts: "2026-11-02T06:01:00.000Z", windowTs: i * 3, text: "x" }));

describe("deriveLiveCapture (ADAAAA-7750 AC3)", () => {
  it("reads a healthy pre-first-window share as a bounded wait, not an empty list", () => {
    const cap = deriveLiveCapture({
      job: browserJob({ startedAt: "2026-11-02T06:04:00.000Z" }),
      observationCount: 12,
      highlightCount: 0,
      hasLiveMediaSession: true,
      nowMs: NOW,
    });
    expect(cap.state).toBe("waiting_first_window");
    expect(cap.cause).toBe("Frames are arriving; the first analysis window is about 6 s behind.");
    expect(cap.firstWindowInS).toBe(6);
    expect(cap.action).toBeNull();
    expect(cap.cause).not.toMatch(/no analysis windows/i);
  });

  it("never claims a negative wait once the budget is spent", () => {
    const cap = deriveLiveCapture({
      job: browserJob({ startedAt: "2026-11-02T06:03:00.000Z" }),
      observationCount: 5,
      highlightCount: 0,
      hasLiveMediaSession: true,
      nowMs: NOW,
    });
    expect(cap.firstWindowInS).toBe(0);
    expect(cap.cause).toBe("Frames are arriving; the first analysis window is due now.");
  });

  it("names an interrupted capture with a retry action when there is no media session", () => {
    const cap = deriveLiveCapture({
      job: browserJob({ startedAt: "2026-11-02T05:59:00.000Z" }),
      observationCount: 0,
      highlightCount: 0,
      hasLiveMediaSession: false,
      nowMs: NOW,
    });
    expect(cap.state).toBe("interrupted");
    expect(cap.cause).toBe("Capture interrupted - no frames are arriving from this share.");
    expect(cap.action).toBe("Stop the share and start it again.");
  });

  it("keeps the connecting grace window for a cold share with no session row yet", () => {
    const cap = deriveLiveCapture({
      job: browserJob({ startedAt: "2026-11-02T06:04:20.000Z" }),
      observationCount: 0,
      highlightCount: 0,
      hasLiveMediaSession: false,
      nowMs: NOW,
    });
    expect(cap.state).toBe("connecting");
    expect(cap.cause).toBe("Connecting this share to the analysis node.");
  });

  it("distinguishes a live share whose windows were all judged not a highlight", () => {
    const cap = deriveLiveCapture({
      job: browserJob({ summaryLog: windows(3) }),
      observationCount: 40,
      highlightCount: 0,
      hasLiveMediaSession: true,
      nowMs: NOW,
    });
    expect(cap.state).toBe("capturing");
    expect(cap.cause).toContain("40 analysed");
    expect(cap.cause).toContain("3 windows decided");
    expect(cap.cause).toContain("no highlight is confirmed yet");
  });

  it("attributes the board's job: frames + windows analysed, nothing confirmed", () => {
    const cap = deriveLiveCapture({
      job: browserJob({
        status: "done",
        startedAt: "2026-11-02T05:52:07.516Z",
        finishedAt: "2026-11-02T05:59:29.964Z",
        framesAnalyzed: 386,
        summaryLog: windows(63),
      }),
      observationCount: 386,
      highlightCount: 0,
      hasLiveMediaSession: false,
      nowMs: NOW,
    });
    expect(cap.state).toBe("no_highlights");
    expect(cap.frames).toBe(386);
    expect(cap.windows).toBe(63);
    expect(cap.cause).toBe("The run analysed 386 frames across 63 windows and no highlight was confirmed.");
    expect(cap.action).toBe("Share again if you expected a highlight in that stretch.");
  });

  it("names a terminal job that never captured a frame", () => {
    const cap = deriveLiveCapture({
      job: browserJob({ status: "done", framesAnalyzed: 0 }),
      observationCount: 0,
      highlightCount: 0,
      hasLiveMediaSession: false,
      nowMs: NOW,
    });
    expect(cap.state).toBe("no_capture");
    expect(cap.cause).toBe("No frames were captured for this job, so there was nothing to analyse.");
    expect(cap.action).toBe("Start the share again to record a new run.");
  });

  it("stays silent when a highlight is already confirmed", () => {
    const cap = deriveLiveCapture({
      job: browserJob({ summaryLog: windows(4) }),
      observationCount: 50,
      highlightCount: 2,
      hasLiveMediaSession: true,
      nowMs: NOW,
    });
    expect(cap.state).toBe("unknown");
    expect(cap.cause).toBeNull();
  });

  it("stays silent for a non-live source (VOD keeps its own empty copy)", () => {
    const cap = deriveLiveCapture({
      job: browserJob({ source: "file" }),
      observationCount: 0,
      highlightCount: 0,
      hasLiveMediaSession: false,
      nowMs: NOW,
    });
    expect(cap.state).toBe("unknown");
  });

  it("pins the thresholds the copy cites", () => {
    expect(LIVE_CAPTURE_FIRST_WINDOW_BUDGET_S).toBe(30);
    expect(LIVE_CAPTURE_STALE_S).toBe(15);
  });
});

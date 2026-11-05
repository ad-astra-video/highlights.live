import { describe, expect, it } from "vitest";
import {
  deriveLiveCapture,
  LIVE_CAPTURE_FIRST_WINDOW_BUDGET_S,
  LIVE_CAPTURE_STALE_S,
  LIVE_RECORDING_GRACE_S,
  LIVE_RECORDING_MIN_BYTES,
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

  it("stops calling a share 'connecting' once the grace window passes with a live session row", () => {
    // The `media_sessions` row is written at provision and only cleared when the
    // job ends, so a stale `active` row must not keep a dead share in
    // "connecting" forever - and must not be reported as a hard interruption
    // either; the copy names what is actually true.
    const cap = deriveLiveCapture({
      job: browserJob({ startedAt: "2026-11-02T05:59:00.000Z" }),
      observationCount: 0,
      highlightCount: 0,
      hasLiveMediaSession: true,
      nowMs: NOW,
    });
    expect(cap.state).toBe("interrupted");
    expect(cap.cause).toBe("Capture is connected but no frames are arriving from this share.");
    expect(cap.action).toBe("Stop the share and start it again.");
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

// ADAAAA-8105: the recording rail is independent of the analysis rail. Job
// `ccc9f1aa` delivered frames, decided windows and 2 accepted highlights while
// the browser stored ZERO recording bytes — the page said nothing until stop,
// then shipped `2 highlight(s) produced no clip (recording=missing)`. The
// projection must name it WHILE the share is live, including on a share that
// already has accepted highlights (those are the clips that will be missing).
describe("deriveLiveCapture recording health (ADAAAA-8105)", () => {
  const flow = (over: Record<string, unknown> = {}) => ({
    job: browserJob({ startedAt: "2026-11-02T06:00:00.000Z", ...over }),
    observationCount: 40,
    highlightCount: 0,
    hasLiveMediaSession: true,
    nowMs: NOW,
  });

  it("names a live share that is storing no video bytes", () => {
    const cap = deriveLiveCapture({ ...flow(), recordingBytes: 0 });
    expect(cap.state).toBe("recording_missing");
    expect(cap.cause).toBe("This share is not saving video, so its highlight clips will be missing.");
    expect(cap.action).toBe("Stop the share and start it again; if it repeats, use another browser.");
    // The counters stay honest: frames are still arriving.
    expect(cap.frames).toBe(40);
  });

  it("treats the measured container headers as no recording at all", () => {
    // 752 B mp4 header and job 202d0dad's 1,194 B webm header: both were above
    // the old 1024 B floor / indistinguishable from footage to the old guard.
    for (const bytes of [752, 1194, LIVE_RECORDING_MIN_BYTES - 1]) {
      const cap = deriveLiveCapture({ ...flow(), recordingBytes: bytes });
      expect(cap.state).toBe("recording_missing");
    }
  });

  it("warns even when highlights are already accepted (the measured job)", () => {
    const cap = deriveLiveCapture({ ...flow({ summaryLog: windows(2) }), highlightCount: 2, recordingBytes: 0 });
    expect(cap.state).toBe("recording_missing");
    expect(cap.highlights).toBe(2);
  });

  it("stays silent inside the grace window", () => {
    const cap = deriveLiveCapture({
      ...flow(),
      job: browserJob({ startedAt: "2026-11-02T06:04:10.000Z" }), // 14 s in
      recordingBytes: 0,
    });
    expect(cap.state).toBe("waiting_first_window");
    expect(cap.state).not.toBe("recording_missing");
  });

  it("stays silent while a healthy recording is being stored", () => {
    // ~3 MB is an 8 s capture of a 3 Mbps share.
    const cap = deriveLiveCapture({ ...flow({ summaryLog: windows(3) }), recordingBytes: 3_000_000 });
    expect(cap.state).toBe("capturing");
  });

  it("stays silent when the server cannot see a recording file", () => {
    // Non-browser sources record server-side; `undefined` must never warn.
    const cap = deriveLiveCapture({ ...flow(), recordingBytes: undefined });
    expect(cap.state).toBe("waiting_first_window");
    const rtmp = deriveLiveCapture({
      ...flow({ source: "rtmp" }),
      recordingBytes: 0,
    });
    expect(rtmp.state).not.toBe("recording_missing");
  });

  it("leaves the terminal copy to the stop path", () => {
    // At stop each highlight already carries its own clipError; the live notice
    // must not displace the terminal explanation.
    const cap = deriveLiveCapture({
      ...flow({ status: "done", framesAnalyzed: 386, summaryLog: windows(63) }),
      observationCount: 386,
      recordingBytes: 0,
    });
    expect(cap.state).toBe("no_highlights");
  });

  it("pins the recording thresholds", () => {
    expect(LIVE_RECORDING_MIN_BYTES).toBe(4096);
    expect(LIVE_RECORDING_GRACE_S).toBeGreaterThan(LIVE_CAPTURE_STALE_S);
  });
});

import { renderToString } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import { LiveStageViewBlock } from "./LiveStage";
import { liveStageView, type LiveStageView } from "../lib/liveStage";
import type { ScoreboardSurface } from "../lib/scoreboardSurface";

// ADAAAA-7976: marker + document-order contract for the live stage. This package
// deliberately has no jsdom, so the markup is pinned with react-dom/server.
describe("LiveStage markup (ADAAAA-7976)", () => {
  function view(over: Partial<Parameters<typeof liveStageView>[0]> = {}): LiveStageView {
    return liveStageView({
      jobStatus: "active",
      jobSource: "browser",
      createdAt: "2026-11-04T12:00:00Z",
      now: Date.parse("2026-11-04T12:00:30Z"),
      ...over,
    });
  }

  function render(v: LiveStageView, liveProgress?: any) {
    return renderToString(
      React.createElement(LiveStageViewBlock, {
        view: v,
        jobId: "job-1",
        source: v.noPreviewReason === "external" ? "rtmp" : "browser",
        stream: null,
        liveProgress,
        onStop: () => {},
      }),
    );
  }

  it("renders the video stage above the match summary with status, elapsed and Stop", () => {
    const html = render(view({ ownsCapture: true, hasCaptureStream: true }));
    expect(html).toContain("data-live-stage");
    expect(html).toContain('data-live-stage-mode="video"');
    expect(html).toContain("data-live-stage-video");
    expect(html).toContain("muted");
    expect(html).toContain("autoplay");
    expect(html).toContain("playsinline");
    expect(html).toContain("data-live-stage-status");
    expect(html).toContain("data-live-stage-elapsed");
    expect(html).toContain("0:30");
    expect(html).toContain("data-live-stage-stop");
    expect(html).toContain("Stop &amp; finalize");
    expect(html).not.toContain("data-live-stage-nopreview");
  });

  it("renders the no-preview stage for external ingest with no <video> element", () => {
    const html = render(view({ jobSource: "rtmp" }));
    expect(html).toContain('data-live-stage-mode="nopreview"');
    expect(html).toContain("data-live-stage-nopreview");
    expect(html).toContain('data-live-stage-nopreview-reason="external"');
    expect(html).not.toContain("data-live-stage-video");
    expect(html).not.toContain("<video");
    expect(html).toContain("data-live-stage-stop");
    expect(html).toContain("No local preview for RTMP ingest");
  });

  it("renders the stopped state with no video and no Stop", () => {
    const html = render(view({ jobStatus: "done" }));
    expect(html).toContain('data-live-stage-mode="stopped"');
    expect(html).toContain("data-live-stage-finalized");
    expect(html).not.toContain("data-live-stage-video");
    expect(html).not.toContain("data-live-stage-nopreview");
    expect(html).not.toContain("data-live-stage-stop");
  });

  it("precedes data-detail-ladder in document order", () => {
    const html = renderToString(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(LiveStageViewBlock, {
          view: view({ ownsCapture: true, hasCaptureStream: true }),
          jobId: "job-1",
          source: "browser",
          stream: null,
          onStop: () => {},
        }),
        React.createElement("div", { "data-detail-ladder": "" }, "match summary"),
      ),
    );
    const stageAt = html.indexOf("data-live-stage");
    const ladderAt = html.indexOf("data-detail-ladder");
    expect(stageAt).toBeGreaterThan(-1);
    expect(ladderAt).toBeGreaterThan(-1);
    expect(stageAt).toBeLessThan(ladderAt);
  });

  // ADAAAA-8105: the user is routed to this page ~1 s after Start, so this is
  // where a share that is storing no video must say so — DURING the share, not
  // only at stop. Before this the stage rendered no capture health at all.
  it("renders the live 'recording not captured' notice with the stream", () => {
    const html = renderToString(
      React.createElement(LiveStageViewBlock, {
        view: view({ ownsCapture: true, hasCaptureStream: true }),
        jobId: "job-1",
        source: "browser",
        stream: null,
        captureNotice: "No screen video is being recorded for this share, so highlight clips will be missing.",
        onStop: () => {},
      }),
    );
    expect(html).toContain("data-live-stage-capture-notice");
    expect(html).toContain("No screen video is being recorded for this share");
    expect(html).toContain('role="alert"');
  });

  it("renders no capture notice on a healthy share", () => {
    const html = render(view({ ownsCapture: true, hasCaptureStream: true }));
    expect(html).not.toContain("data-live-stage-capture-notice");
  });
});

// ADAAAA-8121: the live stage carries the analyse-position readout while the job
// is live, and nothing at all once it is not (AC-1 / AC-4).
describe("LiveStage analyse position (ADAAAA-8121)", () => {
  const progress = {
    liveEdgeTs: 222,
    processedThroughTs: 205,
    lagSec: 17,
    skippedWindows: 0,
    state: "behind" as const,
    updatedAt: "2026-11-06T18:30:00.000Z",
    analysedPositionTs: 214.5,
    analysedLagSec: 7.5,
    strideData: true,
    strideFramesSeen: 1063,
    strideFramesSkipped: 708,
    strideAnalysisFps: 1,
  };

  function view(over: Partial<Parameters<typeof liveStageView>[0]> = {}): LiveStageView {
    return liveStageView({
      jobStatus: "active",
      jobSource: "browser",
      createdAt: "2026-11-04T12:00:00Z",
      now: Date.parse("2026-11-04T12:00:30Z"),
      ...over,
    });
  }

  function render(v: LiveStageView, liveProgress?: any) {
    return renderToString(
      React.createElement(LiveStageViewBlock, {
        view: v,
        jobId: "job-1",
        source: "browser",
        stream: null,
        liveProgress,
        onStop: () => {},
      }),
    );
  }

  it("renders the analysed position + content-clock delay for a live job", () => {
    const html = render(view(), progress);
    expect(html).toContain("data-analyze-position");
    expect(html).toContain("Analysing T+3:35 · 8 s behind live");
    // ADAAAA-8419: the stride count is no longer printed on the live chip.
    expect(html).not.toMatch(/frames? skipped|stride \d+ fps|no stride data/);
    expect(html).toContain('data-analyze-position-skipped="708"');
    // order: the position chip follows the lag chip inside the status row
    expect(html.indexOf("data-live-progress")).toBeLessThan(html.indexOf("data-analyze-position"));
  });

  it("renders no position marker for a terminal job (no stale value)", () => {
    const html = render(view({ jobStatus: "done" }), progress);
    expect(html).not.toContain("data-analyze-position");
  });
});

// ADAAAA-8886 (Inc 3): the score-bug box over the Live Stage video.
//
// Visibility only. The block is served (Inc 1) and identity-annotated (Inc 2);
// this pins that it is DRAWN when the stage shows this tab's stream, that it is
// absent (no node at all) when there is no block or no video stage, and that the
// provenance/identity it shows is honest — a prior never reads as a pin and an
// unreadable surface never claims the match. Geometry is unit-tested in
// `lib/scoreboardOverlay.test.ts`; SSR has no intrinsic video size, so the
// markup here must contain the wrapper markers and NO box node.
describe("LiveStage score-bug overlay (ADAAAA-8886)", () => {
  function view(over: Partial<Parameters<typeof liveStageView>[0]> = {}): LiveStageView {
    return liveStageView({
      jobStatus: "active",
      jobSource: "browser",
      createdAt: "2026-11-04T12:00:00Z",
      now: Date.parse("2026-11-04T12:00:30Z"),
      ...over,
    });
  }

  const SURFACE: ScoreboardSurface = {
    roi: [0.1, 0.05, 0.6, 0.2],
    source: "explicit",
    seqFirstSeen: 41,
    verified: true,
  };

  function render(v: LiveStageView, surface?: ScoreboardSurface, source = "browser") {
    return renderToString(
      React.createElement(LiveStageViewBlock, {
        view: v,
        jobId: "job-1",
        source,
        stream: null,
        scoreboardSurface: surface,
        onStop: () => {},
      }),
    );
  }

  it("AC3.1: renders NO overlay node when the job has no scoreboardSurface", () => {
    const html = render(view({ ownsCapture: true, hasCaptureStream: true }));
    expect(html).toContain("data-live-stage-video");
    expect(html).not.toContain("data-scoreboard-overlay");
  });

  it("AC3.1/AC3.4: draws the served box and its markers in video mode", () => {
    const html = render(view({ ownsCapture: true, hasCaptureStream: true }), SURFACE);
    expect(html).toContain('data-scoreboard-overlay="stage"');
    expect(html).toContain('data-scoreboard-overlay-source="explicit"');
    expect(html).toContain('data-scoreboard-overlay-roi="0.1,0.05,0.6,0.2"');
    expect(html).toContain('data-scoreboard-overlay-verified="true"');
    expect(html).toContain('data-scoreboard-overlay-identity="none"');
    expect(html).toContain('data-scoreboard-overlay-prior="false"');
    // the honest provenance text is in the markup (title), and a pin is a pin
    expect(html).toContain("score bug: pinned");
    expect(html).not.toContain("auto-detected");
    // SSR has no intrinsic size: the wrapper ships, the box does NOT (no guess)
    expect(html).not.toContain("data-scoreboard-overlay-box");
    expect(html).toContain('data-scoreboard-overlay-content-rect=""');
  });

  it("AC3.4: a default_top_band prior is flagged and labelled as a prior", () => {
    const html = render(view({ ownsCapture: true, hasCaptureStream: true }), {
      ...SURFACE,
      source: "default_top_band",
      seqFirstSeen: -1,
      verified: false,
    });
    expect(html).toContain('data-scoreboard-overlay-source="default_top_band"');
    expect(html).toContain('data-scoreboard-overlay-prior="true"');
    expect(html).toContain('data-scoreboard-overlay-verified="false"');
    expect(html).toContain("prior — not measured");
    expect(html).not.toContain("score bug: pinned");
  });

  it("AC3.4: contradicted reads `different match`, absent never claims a match", () => {
    const contradicted = render(view({ ownsCapture: true, hasCaptureStream: true }), {
      ...SURFACE,
      identity: { verdict: "contradicted", kitDistance: 0.51, threshold: 0.35 },
    });
    expect(contradicted).toContain('data-scoreboard-overlay-identity="contradicted"');
    expect(contradicted).toContain("different match");

    const absent = render(view({ ownsCapture: true, hasCaptureStream: true }), {
      ...SURFACE,
      identity: { verdict: "absent" },
    });
    expect(absent).toContain('data-scoreboard-overlay-identity="absent"');
    expect(absent).toContain("unreadable surface");
    expect(absent).not.toContain("this match");
  });

  it("AC3.7: no box in nopreview (external ingest) mode", () => {
    const html = render(view({ jobSource: "rtmp" }), SURFACE, "rtmp");
    expect(html).toContain('data-live-stage-mode="nopreview"');
    expect(html).not.toContain("data-scoreboard-overlay");
  });

  it("AC3.7: no box in stopped mode, and no implied pin", () => {
    const html = render(view({ jobStatus: "done" }), SURFACE);
    expect(html).toContain('data-live-stage-mode="stopped"');
    expect(html).not.toContain("data-scoreboard-overlay");
  });

  it("AC3.5: the overlay is inert and covers no status line, chip or Stop", () => {
    const html = render(view({ ownsCapture: true, hasCaptureStream: true }), SURFACE);
    const start = html.indexOf('data-scoreboard-overlay="stage"');
    expect(start).toBeGreaterThan(-1);
    const tag = html.slice(html.lastIndexOf("<div", start), html.indexOf(">", start) + 1);
    expect(tag).toContain("pointer-events-none");
    expect(tag).toContain('aria-hidden="true"');
    // the existing stage contract is untouched
    expect(html).toContain("data-live-stage-status");
    expect(html).toContain("data-live-stage-elapsed");
    expect(html).toContain("data-live-stage-stop");
    expect(html).toContain("data-live-stage-video");
    // the overlay only covers the video: it opens after the video and the stage
    // status row, and it is a sibling of the video inside the video wrapper.
    // NOTE: `data-live-stage-video-wrap` is a PREFIX of `data-live-stage-video`,
    // so the video is located by its `<video` tag, not by the marker substring.
    const wrapStart = html.indexOf("data-live-stage-video-wrap");
    const videoStart = html.indexOf("<video");
    expect(wrapStart).toBeGreaterThan(-1);
    expect(videoStart).toBeGreaterThan(-1);
    expect(wrapStart).toBeLessThan(videoStart);
    expect(videoStart).toBeLessThan(start);
  });
});

import { renderToString } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import { LiveStageViewBlock } from "./LiveStage";
import { liveStageView, type LiveStageView } from "../lib/liveStage";

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

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

  function render(v: LiveStageView) {
    return renderToString(
      React.createElement(LiveStageViewBlock, {
        view: v,
        jobId: "job-1",
        source: v.noPreviewReason === "external" ? "rtmp" : "browser",
        stream: null,
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
});

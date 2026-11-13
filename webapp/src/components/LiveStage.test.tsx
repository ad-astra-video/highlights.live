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

// ADAAAA-8949 (Inc 4): the analyze-frame still on the no-preview stage.
//
// Inc 3 draws the box only on the tab that holds the capture; RTMP/WebRTC ingest
// has no playback route, so the box had no picture there. The still is the newest
// JPEG perceive already cropped — one `<img>` + the same box mapped through the
// IMAGE content rect. SSR has no intrinsic image size, so the markup here pins the
// markers, the 1-image contract and the inert states; the box px arithmetic is
// pinned in `LiveFrameStill.test.tsx` (with explicit geometry) and in
// `lib/liveFrameStill.test.ts`.
describe("LiveStage no-preview still (ADAAAA-8949)", () => {
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
  const ANCHOR = Date.parse("2026-11-04T12:00:00Z");
  const STILL = {
    stillFrame: { seq: 412, uri: "/jobs/job-1/frames/412", timestamp: 112.3 },
    stillImgSrc: "blob:frame-412",
    stillAnchorMs: ANCHOR,
    nowMs: ANCHOR + 120_300,
  };

  // ADAAAA-8970: the still props, taken from the block's own signature so a
  // degrade-state override cannot silently widen past what the component takes.
  type StillProps = Pick<
    Parameters<typeof LiveStageViewBlock>[0],
    "stillFrame" | "stillImgSrc" | "stillError" | "stillState" | "stillRefusal" | "stillAnchorMs" | "nowMs"
  >;

  function render(
    v: LiveStageView,
    opts: { surface?: ScoreboardSurface; source?: string; still?: StillProps } = {},
  ) {
    return renderToString(
      React.createElement(LiveStageViewBlock, {
        view: v,
        jobId: "job-1",
        source: opts.source ?? "browser",
        stream: null,
        scoreboardSurface: opts.surface,
        onStop: () => {},
        ...(opts.still ?? {}),
      }),
    );
  }

  it("AC4.1: renders NOTHING for the still on nopreview without a scoreboardSurface", () => {
    const html = render(view({ jobSource: "rtmp" }), { source: "rtmp", still: STILL });
    expect(html).toContain('data-live-stage-mode="nopreview"');
    expect(html).not.toContain("data-live-stage-frame-still");
    expect(html).not.toContain("data-live-stage-frame-wrap");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data-scoreboard-overlay");
  });

  it("AC4.1: renders exactly one still image on nopreview with a surface", () => {
    const html = render(view({ jobSource: "rtmp" }), { source: "rtmp", surface: SURFACE, still: STILL });
    expect(html.match(/data-live-stage-frame-still-img/g)).toHaveLength(1);
    expect(html).toContain('src="blob:frame-412"');
    expect(html).toContain("data-live-stage-frame-wrap");
    expect(html).toContain('data-live-stage-frame-still-seq="412"');
    expect(html).toContain("newest analyzed frame #412");
    expect(html).toContain("8s ago");
    // SSR has no intrinsic size: the box does not ship (Inc 3's no-guess rule).
    expect(html).not.toContain("data-live-stage-frame-still-box=");
    // the honest no-preview note is still there, AFTER the picture
    expect(html.indexOf("data-live-stage-frame-wrap")).toBeLessThan(html.indexOf("data-live-stage-nopreview"));
    expect(html).toContain("No local preview for RTMP ingest");
  });

  it("AC4.6: video mode is unchanged — no still, Inc 3's box on the video", () => {
    const html = render(view({ ownsCapture: true, hasCaptureStream: true }), { surface: SURFACE, still: STILL });
    expect(html).toContain('data-live-stage-mode="video"');
    expect(html).toContain("<video");
    expect(html).toContain('data-scoreboard-overlay="stage"');
    expect(html).not.toContain("data-live-stage-frame-still");
    expect(html).not.toContain("<img");
  });

  it("AC4.6: stopped mode renders neither the still nor the box", () => {
    const html = render(view({ jobStatus: "done" }), { surface: SURFACE, still: STILL });
    expect(html).toContain('data-live-stage-mode="stopped"');
    expect(html).not.toContain("data-live-stage-frame-still");
    expect(html).not.toContain("data-scoreboard-overlay");
    expect(html).not.toContain("<img");
  });

  it("AC4.6: every pre-existing data-live-stage marker is still present", () => {
    const html = render(view({ jobSource: "rtmp" }), { source: "rtmp", surface: SURFACE, still: STILL });
    for (const marker of [
      "data-live-stage=",
      "data-live-stage-mode=",
      "data-live-stage-job=",
      "data-live-stage-source=",
      "data-live-stage-status",
      "data-live-stage-state=",
      "data-live-stage-job-status",
      "data-live-stage-elapsed",
      "data-live-stage-stop",
      "data-live-stage-nopreview",
      "data-live-stage-nopreview-reason=",
      // Inc 4 additions
      "data-live-stage-frame-wrap",
      "data-live-stage-frame-still-layer",
      "data-live-stage-frame-still-img",
      "data-live-stage-frame-still-caption",
    ]) {
      expect(html, marker).toContain(marker);
    }
    // the video-mode markers keep shipping on the video stage
    const videoHtml = render(view({ ownsCapture: true, hasCaptureStream: true }), { surface: SURFACE, still: STILL });
    for (const marker of ["data-live-stage-video-wrap", "data-live-stage-video", "<video"]) {
      expect(videoHtml, marker).toContain(marker);
    }
    const stoppedHtml = render(view({ jobStatus: "done" }));
    expect(stoppedHtml).toContain("data-live-stage-finalized");
  });

  // ADAAAA-8970 (Inc 2): the ticket's state matrix, at the STAGE level (the slot
  // `LiveStageViewBlock` owns), so the counts hold for the element the page
  // actually mounts. Frame-request counts live in `lib/liveFrameStill.test.ts`.
  it("ADAAAA-8970 matrix: no surface — 0 img, 0 box, no label", () => {
    const html = render(view({ jobSource: "rtmp" }), { source: "rtmp", still: STILL });
    expect(html.match(/<img/g) ?? []).toHaveLength(0);
    expect(html).not.toContain("data-live-stage-frame-still-box=");
    expect(html).not.toContain("data-live-stage-frame-still-state=");
    expect(html).not.toContain("No analyzed frame yet");
    expect(html).not.toContain("token was refused");
  });

  it("ADAAAA-8970 matrix: frames empty — 0 img, 0 box, the named waiting label", () => {
    const html = render(view({ jobSource: "rtmp" }), {
      source: "rtmp",
      surface: SURFACE,
      still: { stillFrame: null, stillImgSrc: null, stillState: "waiting", stillAnchorMs: ANCHOR, nowMs: ANCHOR + 1_000 },
    });
    expect(html.match(/<img/g) ?? []).toHaveLength(0);
    expect(html).not.toContain("data-live-stage-frame-still-box=");
    expect(html).toContain('data-live-stage-frame-still-state="waiting"');
    expect(html).toContain('data-live-stage-frame-still-waiting="true"');
    expect(html).toContain("No analyzed frame yet");
  });

  it("ADAAAA-8970 matrix: frame 401/403 — 0 img, 0 box, the named refusal label", () => {
    const html = render(view({ jobSource: "rtmp" }), {
      source: "rtmp",
      surface: SURFACE,
      still: {
        stillFrame: null,
        stillImgSrc: null,
        stillError: "frame fetch failed: HTTP 403",
        stillState: "refused",
        stillRefusal: "auth",
        stillAnchorMs: ANCHOR,
        nowMs: ANCHOR + 1_000,
      },
    });
    expect(html.match(/<img/g) ?? []).toHaveLength(0);
    expect(html).not.toContain("data-live-stage-frame-still-box=");
    expect(html).toContain('data-live-stage-frame-still-state="refused"');
    expect(html).toContain('data-live-stage-frame-still-refusal="auth"');
    expect(html).toContain("token was refused");
    expect(html).not.toContain("No analyzed frame yet");
  });

  it("ADAAAA-8970 matrix: frame seq 4 min old — 1 img, box once measured, stale with age", () => {
    const html = render(view({ jobSource: "rtmp" }), {
      source: "rtmp",
      surface: SURFACE,
      still: { ...STILL, stillState: "ready", nowMs: ANCHOR + 112_300 + 240_000 },
    });
    expect(html.match(/<img/g) ?? []).toHaveLength(1);
    // SSR has no intrinsic image size, so the box ships only once measured: the
    // 1-box half of this row is pinned with explicit geometry in
    // `LiveFrameStill.test.tsx`, and Inc 3's no-guess rule is asserted here.
    expect(html).not.toContain("data-live-stage-frame-still-box=");
    expect(html).toContain('data-live-stage-frame-still-state="ready"');
    expect(html).toContain('data-live-stage-frame-still-age="240s ago"');
    expect(html).toContain('data-live-stage-frame-still-stale="true"');
    expect(html).toContain("240s ago");
  });
});

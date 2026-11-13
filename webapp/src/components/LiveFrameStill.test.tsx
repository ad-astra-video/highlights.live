// ADAAAA-8949 (Inc 4): markup contract for the no-preview analyze-frame still.
//
// This package deliberately has no jsdom, so the DOM-measured half (ResizeObserver
// + `<img>` load) cannot run here. `LiveFrameStillView` takes the geometry as a
// VALUE, which is what lets react-dom/server pin the exact contract the page
// ships: exactly one `<img>`, exactly one box, and the box's px string at the
// three stage aspects AC4.2 names. The container (`LiveFrameStill`) is the thin
// adapter that measures and hands those numbers over.
import { renderToString } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import { LiveFrameStillView } from "./LiveFrameStill";
import type { LiveFrameRef } from "../lib/liveFrameStill";
import type { ScoreboardSurface } from "../lib/scoreboardSurface";
import type { ContentGeometry } from "../lib/useContentGeometry";

const SURFACE: ScoreboardSurface = {
  roi: [0.1, 0.05, 0.6, 0.2],
  source: "explicit",
  seqFirstSeen: 41,
  verified: true,
};

const FRAME: LiveFrameRef = { seq: 412, uri: "/jobs/job-1/frames/412", timestamp: 112.3 };

const ANCHOR = Date.parse("2026-11-13T12:00:00Z");

function ssr(over: Partial<Parameters<typeof LiveFrameStillView>[0]> = {}) {
  return renderToString(
    React.createElement(LiveFrameStillView, {
      surface: SURFACE,
      frame: FRAME,
      imgSrc: "blob:frame-412",
      anchorMs: ANCHOR,
      // 42.3 s of content clock => the frame is 8 s behind the wall clock.
      nowMs: ANCHOR + 120_300,
      geometry: { stageW: 768, stageH: 432, elW: 640, elH: 360 } as ContentGeometry,
      ...over,
    }),
  );
}

describe("AC4.1 — one <img> and one box", () => {
  it("renders exactly one still image and exactly one overlay box", () => {
    const html = ssr();
    expect(html.match(/data-live-stage-frame-still-img/g)).toHaveLength(1);
    expect(html.match(/data-live-stage-frame-still-box=/g)).toHaveLength(1);
    expect(html).toContain('src="blob:frame-412"');
    expect(html).toContain("data-live-stage-frame-still-layer");
  });

  it("ships the image but NO box before the picture size is known", () => {
    const html = ssr({ geometry: null });
    expect(html).toContain("data-live-stage-frame-still-img");
    expect(html).not.toContain("data-live-stage-frame-still-box=");
    expect(html).toContain('data-live-stage-frame-still-content-rect=""');
  });

  it("renders the honest empty state when no frame has been extracted yet", () => {
    const html = ssr({ frame: null, imgSrc: null });
    expect(html).toContain("data-live-stage-frame-still-empty");
    expect(html).toContain("data-live-stage-frame-still-waiting");
    expect(html).toContain("No analyzed frame yet");
    expect(html).not.toContain("data-live-stage-frame-still-box=");
  });

  it("states a failed frame read instead of drawing an empty box", () => {
    const html = ssr({ frame: null, imgSrc: null, error: "HTTP 502" });
    expect(html).toContain("could not be read (HTTP 502)");
  });
});

// ADAAAA-8970 (Inc 2): the degrade matrix in the SERVED markup. Counts are the
// ticket's own columns — frame requests are measured in
// `lib/liveFrameStill.test.ts`, and these are the `<img>` / box / label columns.
describe("ADAAAA-8970 — the no-preview state matrix (markup)", () => {
  const count = (html: string, marker: RegExp | string) => (html.match(marker as RegExp) ?? []).length;
  const imgs = (html: string) => count(html, /<img/g);
  const boxes = (html: string) => count(html, /data-live-stage-frame-still-box=/g);

  it("frames empty: 0 `<img>`, 0 box, a NAMED waiting label that is not aria-hidden", () => {
    const html = ssr({ frame: null, imgSrc: null, state: "waiting" });
    expect(imgs(html)).toBe(0);
    expect(boxes(html)).toBe(0);
    expect(html).toContain('data-live-stage-frame-still-state="waiting"');
    expect(html).toContain('data-live-stage-frame-still-waiting="true"');
    expect(html).toContain('aria-hidden="false"');
    expect(html).toContain("No analyzed frame yet");
    // text only: no caption claiming a frame that is not there
    expect(html).not.toContain("data-live-stage-frame-still-caption");
  });

  it("frame 401/403: 0 `<img>`, 0 box, a NAMED refusal label distinct from waiting", () => {
    const html = ssr({
      frame: null,
      imgSrc: null,
      error: "frame fetch failed: HTTP 401",
      state: "refused",
      refusal: "auth",
    });
    expect(imgs(html)).toBe(0);
    expect(boxes(html)).toBe(0);
    expect(html).toContain('data-live-stage-frame-still-state="refused"');
    expect(html).toContain('data-live-stage-frame-still-refused="true"');
    expect(html).toContain('data-live-stage-frame-still-refusal="auth"');
    expect(html).toContain('aria-hidden="false"');
    expect(html).toContain("token was refused (frame fetch failed: HTTP 401)");
    expect(html).toContain("Sign in again");
    // distinct from the waiting state, in marker AND copy
    expect(html).not.toContain("data-live-stage-frame-still-waiting");
    expect(html).not.toContain("No analyzed frame yet");
  });

  it("a 403 is classified as an auth refusal even when only the message carries it", () => {
    const html = ssr({ frame: null, imgSrc: null, error: "frame fetch failed: HTTP 403" });
    expect(html).toContain('data-live-stage-frame-still-refusal="auth"');
    expect(html).toContain("token was refused");
  });

  it("a transport failure is a refusal, but says the read failed, not the token", () => {
    const html = ssr({ frame: null, imgSrc: null, error: "HTTP 502" });
    expect(html).toContain('data-live-stage-frame-still-refusal="transport"');
    expect(html).toContain("could not be read (HTTP 502)");
    expect(html).not.toContain("token was refused");
  });

  it("frame seq 4 min old: 1 `<img>`, 1 box, stale, with the served age", () => {
    const html = ssr({ nowMs: ANCHOR + 112_300 + 240_000 });
    expect(imgs(html)).toBe(1);
    expect(boxes(html)).toBe(1);
    expect(html).toContain('data-live-stage-frame-still-state="ready"');
    expect(html).toContain('data-live-stage-frame-still-age="240s ago"');
    expect(html).toContain('data-live-stage-frame-still-stale="true"');
    expect(html).toContain("240s ago");
    expect(html).toContain("· stale");
    // the still carries its OWN seq and stamp
    expect(html).toContain('data-live-stage-frame-still-seq="412"');
    expect(html).toContain('data-live-stage-frame-still-stamp="T+01:52.3"');
    // and the box is still mapped through the real geometry mapper
    expect(html).toContain('data-live-stage-frame-still-box-px="76.8,21.6,384,64.8"');
  });

  it("a stale frame with a default_top_band source is never labelled pinned", () => {
    const html = ssr({
      surface: { ...SURFACE, source: "default_top_band", verified: false },
      nowMs: ANCHOR + 112_300 + 240_000,
    });
    expect(html).toContain("prior — not measured");
    expect(html).not.toContain("score bug: pinned");
  });
});

describe("AC4.2 — the box is mapped through the image content rect", () => {
  it("16:9 image at a 768x432 stage: box px is 76.8,21.6,384,64.8", () => {
    const html = ssr();
    expect(html).toContain('data-live-stage-frame-still-box-px="76.8,21.6,384,64.8"');
    expect(html).toContain('data-live-stage-frame-still-content-rect="0,0,768,432"');
    // the rendered inline geometry is the same box (floats are UA noise)
    expect(html).toMatch(/style="left:76\.8\d*px;top:21\.6px;width:384px;height:64\.8\d*px"/);
  });

  it("4:3 image at a 768x432 stage: letterboxed 96 px, box px is 153.6,21.6,288,64.8", () => {
    const html = ssr({ geometry: { stageW: 768, stageH: 432, elW: 640, elH: 480 } });
    expect(html).toContain('data-live-stage-frame-still-box-px="153.6,21.6,288,64.8"');
    expect(html).toContain('data-live-stage-frame-still-content-rect="96,0,576,432"');
  });

  it("2.4:1 image at a 768x432 stage: pillarboxed 55.8 px, box px is 76.8,71.82,384,48.06", () => {
    const html = ssr({ geometry: { stageW: 768, stageH: 432, elW: 640, elH: 267 } });
    expect(html).toContain('data-live-stage-frame-still-box-px="76.8,71.82,384,48.06"');
    expect(html).toContain('data-live-stage-frame-still-content-rect="0,55.8,768,320.4"');
  });

  it("narrow 480x270 stage keeps the 4:3 picture centred: box px is 96,13.5,180,40.5", () => {
    const html = ssr({ geometry: { stageW: 480, stageH: 270, elW: 640, elH: 480 } });
    expect(html).toContain('data-live-stage-frame-still-box-px="96,13.5,180,40.5"');
  });
});

describe("AC4.3 — freshness is labelled, never implied", () => {
  it("carries the frame's own seq, content stamp and age", () => {
    const html = ssr();
    expect(html).toContain('data-live-stage-frame-still-seq="412"');
    expect(html).toContain('data-live-stage-frame-still-stamp="T+01:52.3"');
    expect(html).toContain('data-live-stage-frame-still-age="8s ago"');
    expect(html).toContain("newest analyzed frame #412 · T+01:52.3 · 8s ago");
    expect(html).toContain('data-live-stage-frame-still-stale="false"');
    expect(html).not.toContain("data-live-stage-frame-still-stale-label");
  });

  it("renders an age over 60 s as stale", () => {
    // Frame content ts 112.3 s on the anchor, read 300 s later -> 188 s ago.
    const html = ssr({ nowMs: ANCHOR + 300_000 });
    expect(html).toContain('data-live-stage-frame-still-age="187s ago"');
    expect(html).toContain('data-live-stage-frame-still-stale="true"');
    expect(html).toContain("data-live-stage-frame-still-stale-label");
    expect(html).toContain("· stale");
  });

  it("an underivable age is stale and says `age unknown`", () => {
    const html = ssr({ anchorMs: null });
    expect(html).toContain('data-live-stage-frame-still-age="age unknown"');
    expect(html).toContain('data-live-stage-frame-still-stale="true"');
  });

  it("carries no animation or spinner framing", () => {
    const html = ssr();
    expect(html).not.toContain("animate-");
    expect(html).not.toContain("animate-spin");
    expect(html.toLowerCase()).not.toContain("live tracking");
  });
});

describe("AC4.4 — honest provenance on the still", () => {
  it("a pin reads `pinned`, and carries the actual source value", () => {
    const html = ssr();
    expect(html).toContain('data-scoreboard-overlay-source="explicit"');
    expect(html).toContain("data-scoreboard-overlay-prior=\"false\"");
    expect(html).toContain("score bug: pinned");
  });

  it("default_top_band reads `prior — not measured`, NEVER pinned", () => {
    const html = ssr({ surface: { ...SURFACE, source: "default_top_band", verified: false } });
    expect(html).toContain("prior — not measured");
    expect(html).not.toContain("score bug: pinned");
    expect(html).toContain('data-scoreboard-overlay-prior="true"');
    expect(html).toContain('data-scoreboard-overlay-source="default_top_band"');
  });

  it("discovery reads `auto-detected`", () => {
    const html = ssr({ surface: { ...SURFACE, source: "discovery" } });
    expect(html).toContain("score bug: auto-detected");
  });

  it("an identity verdict reads `different match` / `unreadable surface`", () => {
    const contradicted = ssr({
      surface: {
        ...SURFACE,
        identity: { verdict: "contradicted", kitDistance: 0.51, threshold: 0.44 },
      },
    });
    expect(contradicted).toContain("different match");
    expect(contradicted).toContain("kits Δ=0.51 &gt; 0.44");
    const absent = ssr({ surface: { ...SURFACE, identity: { verdict: "absent" } } });
    expect(absent).toContain("unreadable surface");
  });
});

describe("AC4.5 — invisible to input", () => {
  it("is pointer-events-none + aria-hidden, with no interactive affordance", () => {
    const html = ssr();
    expect(html).toContain("pointer-events-none");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("onClick");
    expect(html).not.toContain("cursor-");
    expect(html).not.toContain("draggable");
  });
});

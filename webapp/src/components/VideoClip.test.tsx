import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import React from "react";
import { VideoClip } from "./VideoClip";

// ADAAAA-8032 AC2: a live (screen-share) highlight's clip is cut mid-session, so
// a card waiting for one must NAME its progress instead of sitting on an
// indefinite "clip processing…" placeholder for the whole share.

describe("VideoClip wait state (ADAAAA-8032)", () => {
  it("shows elapsed seconds while the clip is being cut", () => {
    const html = renderToStaticMarkup(
      React.createElement(VideoClip, { src: "", waitingSinceMs: Date.now() - 12_000 })
    );
    expect(html).toMatch(/cutting clip… \d+s/);
    expect(html).not.toContain("clip processing…");
  });

  it("does not keep a bare placeholder past 30 s — it says it is still cutting", () => {
    const html = renderToStaticMarkup(
      React.createElement(VideoClip, { src: "", waitingSinceMs: Date.now() - 45_000 })
    );
    expect(html).toMatch(/still cutting… \d+s/);
    expect(html).toContain("finishes when the share stops");
    expect(html).not.toContain("clip processing…");
  });

  it("keeps the old placeholder when the row carries no wait anchor (legacy)", () => {
    const html = renderToStaticMarkup(React.createElement(VideoClip, { src: "" }));
    expect(html).toContain("clip processing…");
  });

  it("renders the player once the clip lands", () => {
    const html = renderToStaticMarkup(React.createElement(VideoClip, { src: "/clips/x.mp4", lazy: false }));
    expect(html).toContain("<video");
    expect(html).not.toContain("cutting clip");
    expect(html).not.toContain("clip processing…");
  });
});

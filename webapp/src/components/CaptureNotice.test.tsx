import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import { CaptureNotice } from "./CaptureNotice";
import type { LiveCapture } from "../lib/jobDetail";

// ADAAAA-7750 AC3: the rendered empty-state notice. The board's screen share
// rendered `No analysis windows for this job.` with no cause and no action; a
// share that started ten seconds ago rendered the identical string. Both are
// asserted on the real rendered markup here.

const base: LiveCapture = {
  state: "waiting_first_window",
  frames: 12,
  windows: 0,
  highlights: 0,
  firstWindowInS: 26,
  cause: "Frames are arriving; the first analysis window is about 26 s behind.",
  action: null,
  updatedAt: "2026-11-02T06:04:24.000Z",
};

const render = (c: LiveCapture | null | undefined) =>
  renderToStaticMarkup(React.createElement(CaptureNotice, { capture: c }));

describe("CaptureNotice (ADAAAA-7750 AC3)", () => {
  it("reads a healthy pre-first-window share as a bounded wait", () => {
    const html = render(base);
    expect(html).toContain("first analysis window is about 26 s behind");
    expect(html).toContain('data-capture-state="waiting_first_window"');
    expect(html).not.toContain("data-capture-action");
  });

  it("names an interrupted capture and offers the retry action", () => {
    const html = render({
      ...base,
      state: "interrupted",
      frames: 0,
      firstWindowInS: null,
      cause: "Capture interrupted - no frames are arriving from this share.",
      action: "Stop the share and start it again.",
    });
    expect(html).toContain("Capture interrupted");
    expect(html).toContain("Stop the share and start it again.");
    expect(html).toContain('data-capture-state="interrupted"');
    expect(html).toContain('role="alert"');
  });

  it("states the analysed-but-unconfirmed outcome for a terminal job", () => {
    const html = render({
      ...base,
      state: "no_highlights",
      frames: 386,
      windows: 63,
      firstWindowInS: null,
      cause: "The run analysed 386 frames across 63 windows and no highlight was confirmed.",
      action: "Share again if you expected a highlight in that stretch.",
    });
    expect(html).toContain("386 frames across 63 windows");
    expect(html).toContain('data-capture-state="no_highlights"');
  });

  it("renders nothing when the server sends no projection", () => {
    expect(render(undefined)).toBe("");
    expect(render(null)).toBe("");
    expect(render({ ...base, state: "unknown", cause: null })).toBe("");
  });
});

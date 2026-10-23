// ADAAAA-7274: the collapsible Analysis time-window row in the job-detail view.
// Contract: each window is collapsible; when collapsed it shows ONLY the summary
// text plus the color-coded window-type chips (highlight / suppressed / not
// highlight) and hides the expanded body (decide-note banners + frame filmstrip);
// when expanded it shows the full body. SSR asserts the static contract (the
// toggle + collapse are client-side).
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { AnalysisWindow } from "./JobDetail";
import type { FrameSection, DecideNote } from "../lib/jobDetail";

function frame(seq: number, timestamp: number) {
  return { seq, timestamp, uri: `/jobs/j1/frames/${seq}`, tracks: [] };
}
function note(over: Partial<DecideNote> & { status: DecideNote["status"] }): DecideNote {
  return { seq: 0, timestamp: 0, eventType: "goal", score: 90, isHighlight: true, ...over };
}
function section(index: number, decideNotes: DecideNote[] = []): FrameSection {
  return { index, startS: index * 3, endS: (index + 1) * 3, frames: [frame(index * 3, index * 3 + 0.2)], decideNotes };
}

const renderWindow = (s: FrameSection, defaultOpen = true) =>
  renderToString(
    React.createElement(AnalysisWindow, {
      section: s,
      token: null,
      jobId: "j1",
      selectMode: false,
      selectedSeqs: new Set<number>(),
      onFrameClick: () => {},
      defaultOpen,
    })
  );

describe("AnalysisWindow (ADAAAA-7274 collapsible time window)", () => {
  it("expanded shows the full body (decide-note banner + frame filmstrip)", () => {
    const html = renderWindow(section(0, [note({ seq: 1, timestamp: 1.2, status: "accepted" })]), true);
    expect(html).toContain("data-analysis-window");
    expect(html).toContain("data-analysis-window-body");
    expect(html).toContain("data-decide-note");
    expect(html).toContain("data-detail-frame");
    // type chip still rendered on the toggle row
    expect(html).toContain('data-analysis-kind="highlight"');
  });

  it("collapsed shows only the summary text + type chips, and hides the body", () => {
    const html = renderWindow(
      section(0, [
        note({ seq: 1, timestamp: 1.2, status: "accepted", reason: "goal in zone" }),
      ]),
      false
    );
    // no expanded body / no decide note / no frames when collapsed
    expect(html).not.toContain("data-analysis-window-body");
    expect(html).not.toContain("data-decide-note");
    expect(html).not.toContain("data-detail-frame");
    // summary text + type highlight stay visible at a glance
    expect(html).toContain("data-analysis-summary");
    expect(html).toContain("T+0s – T+3s");
    expect(html).toContain("goal in zone");
    expect(html).toContain('data-analysis-kind="highlight"');
    expect(html).toContain("aria-expanded");
  });

  it("renders the suppressed + not_highlight type marks when present", () => {
    const html = renderWindow(
      section(0, [
        note({ seq: 1, timestamp: 1.2, status: "suppressed", isHighlight: true }),
      ]),
      false
    );
    expect(html).toContain('data-analysis-kind="suppressed"');
    expect(html).toContain("suppressed");
  });

  it("renders no type chip for a window without any decide notes", () => {
    const html = renderWindow(section(0, []), false);
    expect(html).toContain("data-analysis-summary");
    expect(html).toContain("no analysis");
    expect(html).not.toContain("data-analysis-kind");
  });
});

import { renderToString } from "react-dom/server";
import React from "react";
import { describe, it, expect } from "vitest";
import { AnalysisWindow, CustomerAnalysisWindow } from "./JobDetail";
import type { FrameSection, JobDetailFrame } from "../lib/jobDetail";

// ADAAAA-8419: the admin window audit renders the frames the consume stride
// REFUSED as greyed `skipped` tiles inside the filmstrip, beside the frames that
// were actually used (and, for the customer role, nowhere at all).
//
// The node test env has no jsdom, so this pins the RENDERED DOM via SSR. The
// "no image fetch" property is structural here: a skipped tile renders no
// canvas/img and is not a FrameTile, and FrameTile is the only component that
// fetches a frame image (`frameFetchWindow.run(authFetchFrame(...))`).

function frame(seq: number, timestamp: number): JobDetailFrame {
  return { seq, timestamp, uri: `/jobs/j1/frames/${seq}`, tracks: [] };
}

function section(over: Partial<FrameSection> = {}): FrameSection {
  return { index: 0, startS: 0, endS: 3, frames: [], decideNotes: [], ...over };
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

function admin(s: FrameSection): string {
  return renderToString(
    React.createElement(AnalysisWindow, {
      section: s,
      token: null,
      jobId: "j1",
      selectMode: true,
      selectedSeqs: new Set<number>(),
      onFrameClick: () => {},
      defaultOpen: true,
      admin: true,
    })
  );
}

describe("admin AnalysisWindow skipped tiles (ADAAAA-8419 AC-3/AC-4)", () => {
  const s = section({
    frames: [frame(0, 0.2), frame(1, 2.5)],
    skipped: [
      { timestamp: 1.2, reason: "stride" },
      { timestamp: 2.9, reason: "stride" },
    ],
    skippedTotal: 2,
  });

  it("renders one greyed skipped tile per refused frame, beside the used frames", () => {
    const html = admin(s);
    expect(count(html, "data-detail-frame-skipped")).toBe(2);
    expect(html).toContain('data-skipped-ts="1.200"');
    expect(html).toContain('data-skipped-ts="2.900"');
    expect(html).toContain('data-skipped-reason="stride"');
    // Grey tile body: no frame image, so no canvas/uri machinery.
    expect(count(html, "<canvas")).toBe(2); // one per USED frame only
    // Two used frames => two frame buttons; the grey tiles add no button.
    expect(count(html, "<button")).toBe(3); // window toggle + two FrameTiles
    // Not clickable / not selectable: a div, never a button.
    expect(html).not.toMatch(/<button[^>]*data-detail-frame-skipped/);
    expect(html).toMatch(/<div[^>]*data-detail-frame-skipped/);
    expect(html).not.toMatch(/data-detail-frame-skipped[^>]*data-selected/);
    // Audit copy carries the content timestamp and the word `skipped`.
    expect(html).toContain("T+1.2s");
    expect(html).toContain("skipped");
  });

  it("interleaves the tiles by content timestamp (dropped frames sit beside neighbours)", () => {
    const html = admin(s);
    const frameAt = (n: number): number => {
      let from = 0;
      for (let i = 0; i <= n; i++) {
        from = html.indexOf('data-detail-frame="true"', from) + 1;
      }
      return from - 1;
    };
    const iSkip12 = html.indexOf('data-skipped-ts="1.200"');
    const iSkip29 = html.indexOf('data-skipped-ts="2.900"');
    expect(frameAt(0)).toBeGreaterThanOrEqual(0);
    expect(frameAt(0)).toBeLessThan(iSkip12);
    expect(iSkip12).toBeLessThan(frameAt(1));
    expect(frameAt(1)).toBeLessThan(iSkip29);
  });

  it("renders a skipped-only window instead of 'No frames in this section.'", () => {
    const html = admin(section({ frames: [], skipped: [{ timestamp: 6.4, reason: "stride" }], skippedTotal: 1 }));
    expect(count(html, "data-detail-frame-skipped")).toBe(1);
    expect(html).not.toContain("No frames in this section.");
  });

  it("renders zero grey tiles for a window with no skip evidence (no fabrication)", () => {
    const html = admin(section({ frames: [frame(0, 0.2)] }));
    expect(count(html, "data-detail-frame-skipped")).toBe(0);
    expect(html).not.toContain("skipped");
  });
});

describe("customer AnalysisWindow is unchanged (ADAAAA-8419 constraints)", () => {
  const s = section({
    frames: [frame(0, 0.2)],
    skipped: [{ timestamp: 1.2, reason: "stride" }],
    skippedTotal: 1,
  });

  it("AnalysisWindow(admin=false) and CustomerAnalysisWindow expose no skipped tile", () => {
    const viaAnalysisWindow = renderToString(
      React.createElement(AnalysisWindow, {
        section: s,
        token: null,
        jobId: "j1",
        selectMode: false,
        selectedSeqs: new Set<number>(),
        onFrameClick: () => {},
        defaultOpen: true,
        admin: false,
      })
    );
    const direct = renderToString(React.createElement(CustomerAnalysisWindow, { section: s }));
    for (const html of [viaAnalysisWindow, direct]) {
      expect(count(html, "data-detail-frame-skipped")).toBe(0);
      expect(count(html, "data-detail-frame")).toBe(0);
      expect(html).not.toContain("skipped");
    }
  });
});

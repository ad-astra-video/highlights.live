import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import { AnalyzePositionChip } from "./AnalyzePositionChip";
import type { LiveProgress } from "../lib/jobDetail";

// ADAAAA-8121: the live analyse-position readout on the rendered markup.
//
// The numbers here are the shape the server projection publishes: an analysed
// CONTENT position and the delay against the live edge measured on the same
// content clock, plus the stride counts. The chip must never present a strided
// window as a position (AC-3) and must render nothing at all when there is no
// live reading to give (AC-4).

const base: LiveProgress = {
  liveEdgeTs: 222,
  processedThroughTs: 205,
  lagSec: 17,
  skippedWindows: 0,
  state: "behind",
  updatedAt: "2026-11-06T18:30:00.000Z",
  analysedPositionTs: 214.5,
  analysedLagSec: 7.5,
  strideData: true,
  strideFramesSeen: 1063,
  strideFramesSkipped: 708,
  strideAnalysisFps: 1,
};

function render(p: LiveProgress | null | undefined): string {
  return renderToStaticMarkup(React.createElement(AnalyzePositionChip, { progress: p }));
}

describe("AnalyzePositionChip (ADAAAA-8121 AC-1/AC-3/AC-4/AC-6)", () => {
  it("renders the analysed content position and its delay vs live (AC-1, AC-2)", () => {
    const html = render(base);
    expect(html).toContain("Analysing T+3:35 · 8 s behind live");
    expect(html).toContain('data-analyze-position-ts="214.500"');
    expect(html).toContain('data-analyze-position-lag="7.500"');
  });

  it("renders the strided frames as a COUNT only, never as a position (AC-3)", () => {
    const html = render(base);
    expect(html).toContain("708 frames skipped (stride 1 fps)");
    expect(html).toContain('data-analyze-position-stride="skipped"');
    // The only T+ value on the chip is the ANALYSED position — no strided marker.
    const positions = html.match(/T\+\d+(:\d\d)?/g) ?? [];
    expect(positions).toEqual(["T+3:35"]);
  });

  it("degrades to 'no stride data' when the record carries no stride evidence (AC-6)", () => {
    const html = render({ ...base, strideData: false, strideFramesSeen: undefined, strideFramesSkipped: undefined });
    expect(html).toContain("no stride data");
    expect(html).toContain('data-analyze-position-stride="no-data"');
    expect(html).not.toContain("frames skipped");
  });

  it("says nothing was skipped when the consume ran at the ingest rate", () => {
    const html = render({ ...base, strideFramesSkipped: 0 });
    expect(html).toContain("no frames skipped");
    expect(html).toContain('data-analyze-position-stride="none"');
  });

  it("renders nothing with no active live reading (AC-4)", () => {
    expect(render(undefined)).toBe("");
    expect(render(null)).toBe("");
    // terminal / no decided window yet
    expect(render({ ...base, state: "unknown" })).toBe("");
    // no analysed position known — never a fabricated 0
    expect(render({ ...base, analysedPositionTs: undefined, analysedLagSec: undefined })).toBe("");
    expect(render({ ...base, analysedPositionTs: 0, analysedLagSec: 0 })).toBe("");
  });
});

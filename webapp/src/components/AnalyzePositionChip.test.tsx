import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import { AnalyzePositionChip } from "./AnalyzePositionChip";
import type { LiveProgress } from "../lib/jobDetail";

// ADAAAA-8121 / ADAAAA-8419: the live analyse-position readout on the rendered
// markup.
//
// The numbers here are the shape the server projection publishes: an analysed
// CONTENT position and the delay against the live edge measured on the same
// content clock, plus the stride counts. The chip must never present a strided
// window as a position (AC-3) and must render nothing at all when there is no
// live reading to give (AC-4).
//
// ADAAAA-8419 removes the user-facing stride clause family from the chip: the
// label is exactly `Analysing T+<pos> · <lag> s behind live` for every stride
// state, while the machine attributes keep the counter readable for QA.

/** The served copy must never contain a stride/skip clause again (AC-1). */
const STRIDE_CLAUSE = /frames? skipped|stride \d+ fps|no stride data/;

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

const LABEL = "Analysing T+3:35 · 8 s behind live";

function render(p: LiveProgress | null | undefined): string {
  return renderToStaticMarkup(React.createElement(AnalyzePositionChip, { progress: p }));
}

describe("AnalyzePositionChip (ADAAAA-8121 AC-1/AC-3/AC-4; ADAAAA-8419 AC-1/AC-2)", () => {
  it("renders the analysed content position and its delay vs live (AC-1, AC-2)", () => {
    const html = render(base);
    expect(html).toContain(LABEL);
    expect(html).toContain('data-analyze-position-ts="214.500"');
    expect(html).toContain('data-analyze-position-lag="7.500"');
  });

  it("renders NO stride copy when frames were skipped, but keeps the machine counter (8419 AC-1/AC-2)", () => {
    const html = render(base);
    // ADAAAA-8419: the count moved to the window audit — never printed on the chip.
    expect(html).not.toMatch(STRIDE_CLAUSE);
    // The RENDERED text is exactly the latency label — the count survives only in
    // the machine attributes / title, never as visible copy.
    expect(html.replace(/<[^>]*>/g, "")).toBe(LABEL);
    // QA still reads the evidence from the DOM attributes / title.
    expect(html).toContain('data-analyze-position-stride="skipped"');
    expect(html).toContain('data-analyze-position-skipped="708"');
    expect(html).toContain("strideFramesSkipped=708");
    // The only T+ value on the chip is the ANALYSED position — no strided marker.
    const positions = html.match(/T\+\d+(:\d\d)?/g) ?? [];
    expect(positions).toEqual(["T+3:35"]);
  });

  it("renders no 'no stride data' clause when the record carries no stride evidence (8419 AC-1, 8121 AC-6)", () => {
    const html = render({ ...base, strideData: false, strideFramesSeen: undefined, strideFramesSkipped: undefined });
    expect(html).not.toMatch(STRIDE_CLAUSE);
    expect(html).toContain(LABEL);
    // Machine evidence still distinguishes 'no data' from 'nothing skipped'.
    expect(html).toContain('data-analyze-position-stride="no-data"');
    expect(html).toContain('data-analyze-position-skipped="0"');
  });

  it("renders no 'no frames skipped' clause when the consume ran at the ingest rate (8419 AC-1)", () => {
    const html = render({ ...base, strideFramesSkipped: 0 });
    expect(html).not.toMatch(STRIDE_CLAUSE);
    expect(html).toContain(LABEL);
    expect(html).toContain('data-analyze-position-stride="none"');
    expect(html).toContain('data-analyze-position-skipped="0"');
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

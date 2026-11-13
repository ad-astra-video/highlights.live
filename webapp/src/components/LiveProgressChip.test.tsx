import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import { LiveProgressChip } from "./LiveProgressChip";
import type { LiveProgress } from "../lib/jobDetail";

// ADAAAA-7741: the rendered chip. The deployed box cannot produce the
// `caught_up` state from a real run (one gemma decide costs ~8-13 s wall per
// ~3 s of content, so the newest decided window always trails the live edge by
// more than the 5 s threshold — the run's lag table shows 8.2 s on the fastest
// window and 21-29 s afterwards), so the caught-up branch is pinned here instead
// of by a screenshot. Both states are asserted on the real rendered markup.
//
// ADAAAA-7759: the stale branch. The chip keeps the last honest lag number when
// the light read fails, but past the stale threshold it must say so in the
// markup (`data-live-progress-stale`) rather than look live forever.

const base: LiveProgress = {
  liveEdgeTs: 60,
  processedThroughTs: 34,
  lagSec: 26,
  skippedWindows: 0,
  state: "behind",
  updatedAt: "2026-11-02T04:01:00.000Z",
};

function render(p: LiveProgress | null | undefined, staleSec = 0): string {
  return renderToStaticMarkup(React.createElement(LiveProgressChip, { progress: p, staleSec }));
}

describe("LiveProgressChip (ADAAAA-7741 AC3/AC4/AC6)", () => {
  it("renders the behind state with the lag seconds", () => {
    const html = render(base);
    expect(html).toContain("Processing - 26 s behind live");
    expect(html).toContain('data-live-progress-state="behind"');
    expect(html).toContain('data-live-progress-stale="false"');
  });

  it("renders the caught-up state with the lag seconds", () => {
    const html = render({ ...base, processedThroughTs: 57, lagSec: 3, state: "caught_up" });
    expect(html).toContain("Live - caught up (3 s)");
    expect(html).toContain('data-live-progress-state="caught_up"');
  });

  it("renders green for the 5-10 s band that used to read yellow (ADAAAA-8944 AC1)", () => {
    // ADAAAA-8944 AC1: lagSec = 7 now reads `caught_up` server-side and must
    // render green — the yellow classes must be absent from the markup entirely.
    const html = render({ ...base, processedThroughTs: 53, lagSec: 7, state: "caught_up" });
    expect(html).toContain("Live - caught up (7 s)");
    expect(html).toContain('data-live-progress-state="caught_up"');
    expect(html).toContain("border-green/40 bg-green/10 text-green");
    expect(html).not.toContain("text-yellow");
    expect(html).not.toContain("bg-yellow/10");
    expect(html).not.toContain("border-yellow/40");
  });

  it("renders green up to the boundary and yellow at exactly 10 s (ADAAAA-8944 AC2)", () => {
    const under = render({ ...base, processedThroughTs: 50.001, lagSec: 9.999, state: "caught_up" });
    expect(under).toContain('data-live-progress-state="caught_up"');
    expect(under).toContain("border-green/40 bg-green/10 text-green");
    expect(under).not.toContain("text-yellow");
    // The exact lag survives in the chip title even though the label rounds.
    expect(under).toContain("lagSec=9.999");

    const at = render({ ...base, processedThroughTs: 50, lagSec: 10, state: "behind" });
    expect(at).toContain("Processing - 10 s behind live");
    expect(at).toContain('data-live-progress-state="behind"');
    expect(at).toContain("border-yellow/40 bg-yellow/10 text-yellow");
    expect(at).not.toContain("text-green");
  });

  it("keeps the behind copy and colour far past the boundary (ADAAAA-8944 AC3)", () => {
    const html = render(base);
    expect(html).toContain("Processing - 26 s behind live");
    expect(html).toContain("border-yellow/40 bg-yellow/10 text-yellow");
    expect(html).not.toContain("text-green");
  });

  it("explains skipped windows as a bounded budget", () => {
    const html = render({ ...base, skippedWindows: 2 });
    expect(html).toContain("2 windows skipped past the 30 s budget");
  });

  it("renders nothing for a terminal / undecided job", () => {
    expect(render(undefined)).toBe("");
    expect(render(null)).toBe("");
    expect(render({ ...base, state: "unknown" })).toBe("");
  });

  it("lets staleness win over caught_up — yellow with the stale clause (ADAAAA-8944 AC4)", () => {
    // ADAAAA-8944 AC4: a projected `caught_up` at 7 s whose light read has been
    // failing for 10 s+ must still be yellow and say so; the boundary move must
    // not turn a frozen reading green.
    const atThreshold = render({ ...base, processedThroughTs: 53, lagSec: 7, state: "caught_up" }, 10);
    expect(atThreshold).toContain("Live - caught up (7 s)");
    expect(atThreshold).toContain("stale: last read 10 s ago");
    expect(atThreshold).toContain('data-live-progress-state="caught_up"');
    expect(atThreshold).toContain('data-live-progress-stale="true"');
    expect(atThreshold).toContain("border-yellow/40 bg-yellow/10 text-yellow");
    expect(atThreshold).not.toContain("text-green");
  });

  it("states staleness in the markup when the light read keeps failing (ADAAAA-7759)", () => {
    const html = render(base, 21);
    expect(html).toContain("Processing - 26 s behind live");
    expect(html).toContain("stale: last read 21 s ago");
    expect(html).toContain('data-live-progress-stale="true"');
    expect(html).toContain("staleSec=21");
  });

  it("renders an explicit unavailable chip when no projection arrived and reads fail", () => {
    const html = render({ ...base, state: "unknown" }, 21);
    expect(html).toContain("Processing - live lag unavailable");
    expect(html).toContain('data-live-progress-state="unavailable"');
  });
});

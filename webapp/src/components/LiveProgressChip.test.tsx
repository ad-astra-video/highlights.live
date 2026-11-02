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

const base: LiveProgress = {
  liveEdgeTs: 60,
  processedThroughTs: 34,
  lagSec: 26,
  skippedWindows: 0,
  state: "behind",
  updatedAt: "2026-11-02T04:01:00.000Z",
};

function render(p: LiveProgress | null | undefined): string {
  return renderToStaticMarkup(React.createElement(LiveProgressChip, { progress: p }));
}

describe("LiveProgressChip (ADAAAA-7741 AC3/AC4/AC6)", () => {
  it("renders the behind state with the lag seconds", () => {
    const html = render(base);
    expect(html).toContain("Processing - 26 s behind live");
    expect(html).toContain('data-live-progress-state="behind"');
  });

  it("renders the caught-up state with the lag seconds", () => {
    const html = render({ ...base, processedThroughTs: 57, lagSec: 3, state: "caught_up" });
    expect(html).toContain("Live - caught up (3 s)");
    expect(html).toContain('data-live-progress-state="caught_up"');
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
});

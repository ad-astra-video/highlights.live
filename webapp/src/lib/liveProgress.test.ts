import { describe, it, expect } from "vitest";
import { LIVE_PROGRESS_BUDGET_S, liveProgressChipLabel } from "./liveProgress";
import type { LiveProgress } from "./jobDetail";

// ADAAAA-7741: the lag chip copy. Pinned by a test so the board-facing wording
// (and the "skipped" clause that turns a missing window into a bounded budget)
// cannot drift.

const base: LiveProgress = {
  liveEdgeTs: 60,
  processedThroughTs: 34,
  lagSec: 26,
  skippedWindows: 0,
  state: "behind",
  updatedAt: "2026-11-02T04:01:00.000Z",
};

describe("liveProgressChipLabel", () => {
  it("says how far behind live a processing job is", () => {
    expect(liveProgressChipLabel(base)).toBe("Processing - 26 s behind live");
  });

  it("says caught up when the newest decided window is within the edge", () => {
    expect(liveProgressChipLabel({ ...base, lagSec: 3, state: "caught_up" })).toBe("Live - caught up (3 s)");
  });

  it("explains skipped windows as a bounded budget, singular and plural", () => {
    expect(liveProgressChipLabel({ ...base, skippedWindows: 2 })).toBe(
      `Processing - 26 s behind live · 2 windows skipped past the ${LIVE_PROGRESS_BUDGET_S} s budget`
    );
    expect(liveProgressChipLabel({ ...base, skippedWindows: 1 })).toContain("1 window skipped past the 30 s budget");
  });

  it("renders nothing without a decided window / on a terminal job (state unknown)", () => {
    expect(liveProgressChipLabel(undefined)).toBeNull();
    expect(liveProgressChipLabel(null)).toBeNull();
    expect(liveProgressChipLabel({ ...base, state: "unknown" })).toBeNull();
  });

  it("rounds a fractional lag for display and never shows a negative number", () => {
    expect(liveProgressChipLabel({ ...base, lagSec: 26.6 })).toBe("Processing - 27 s behind live");
    expect(liveProgressChipLabel({ ...base, lagSec: -3 })).toBe("Processing - 0 s behind live");
  });
});

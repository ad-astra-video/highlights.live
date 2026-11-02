import { describe, it, expect } from "vitest";
import {
  LIVE_PROGRESS_BUDGET_S,
  LIVE_PROGRESS_STALE_MIN_SEC,
  LIVE_READ_HEALTH_FRESH,
  liveProgressChipLabel,
  nextLiveReadHealth,
} from "./liveProgress";
import type { LiveProgress } from "./jobDetail";

// ADAAAA-7741: the lag chip copy. Pinned by a test so the board-facing wording
// (and the "skipped" clause that turns a missing window into a bounded budget)
// cannot drift.
//
// ADAAAA-7759: the stale clause. A failed light read keeps the last honest
// number (by design), but the chip must state when that number has gone stale
// so a persistent read failure can never freeze it silently.

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

  it("does not mark a reading stale before the stale threshold", () => {
    expect(liveProgressChipLabel(base, 0)).toBe("Processing - 26 s behind live");
    expect(liveProgressChipLabel(base, LIVE_PROGRESS_STALE_MIN_SEC - 1)).toBe("Processing - 26 s behind live");
  });

  it("states how old the last honest reading is once the light read keeps failing (ADAAAA-7759)", () => {
    expect(liveProgressChipLabel(base, 21)).toBe("Processing - 26 s behind live (stale: last read 21 s ago)");
    // The skipped-budget clause stays visible under staleness — both facts are true.
    expect(liveProgressChipLabel({ ...base, skippedWindows: 2 }, 21)).toBe(
      "Processing - 26 s behind live · 2 windows skipped past the 30 s budget (stale: last read 21 s ago)"
    );
  });

  it("says the lag is unavailable rather than rendering nothing when there is no projection yet", () => {
    expect(liveProgressChipLabel({ ...base, state: "unknown" }, 21)).toBe(
      "Processing - live lag unavailable (stale: last read 21 s ago)"
    );
  });
});

describe("nextLiveReadHealth (ADAAAA-7759)", () => {
  const t0 = 1_700_000_000_000;

  it("starts fresh and resets on a successful read", () => {
    const ok = nextLiveReadHealth(LIVE_READ_HEALTH_FRESH, { ok: true, at: t0 });
    expect(ok).toEqual({ consecutiveFailures: 0, lastOkAt: t0, failingSince: 0, staleSec: 0, lastError: null });
  });

  it("ages the reading from the last success across a failing streak", () => {
    const ok = nextLiveReadHealth(LIVE_READ_HEALTH_FRESH, { ok: true, at: t0 });
    const f1 = nextLiveReadHealth(ok, { ok: false, at: t0 + 5_000, error: "HTTP 400" });
    expect(f1.consecutiveFailures).toBe(1);
    expect(f1.staleSec).toBe(5);
    expect(f1.lastError).toBe("HTTP 400");
    const f2 = nextLiveReadHealth(f1, { ok: false, at: t0 + 21_000, error: "HTTP 400" });
    expect(f2.consecutiveFailures).toBe(2);
    expect(f2.staleSec).toBe(21);
    expect(f2.lastOkAt).toBe(t0);
  });

  it("ages from the first failure when no light read has ever succeeded", () => {
    const f1 = nextLiveReadHealth(LIVE_READ_HEALTH_FRESH, { ok: false, at: t0, error: "network error" });
    expect(f1.staleSec).toBe(0);
    const f2 = nextLiveReadHealth(f1, { ok: false, at: t0 + 12_000, error: "network error" });
    expect(f2.staleSec).toBe(12);
  });

  it("clears the failure state on the next successful read", () => {
    const f1 = nextLiveReadHealth(LIVE_READ_HEALTH_FRESH, { ok: false, at: t0, error: "HTTP 500" });
    const rec = nextLiveReadHealth(f1, { ok: true, at: t0 + 30_000 });
    expect(rec.consecutiveFailures).toBe(0);
    expect(rec.staleSec).toBe(0);
    expect(rec.lastError).toBeNull();
    expect(rec.lastOkAt).toBe(t0 + 30_000);
  });
});

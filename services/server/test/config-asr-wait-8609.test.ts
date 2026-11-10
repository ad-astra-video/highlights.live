// ADAAAA-8609: the decide-side ASR wait budget must stay STRICTLY under the
// side lane's own per-call timeout.
//
// Measured shape this pins (leg `0cade089`, job `0cade089-038a-42c9-952a-14a383745991`,
// row `076de635`, window @385.00 s): the server's fire-time ASR prefetch lane
// (`asr-prefetch.ts`) POSTed the window clip to the CPU ASR, which answered that
// clip in 25.684 s; `AsrPrefetcher.transcribe()` aborts its POST at
// `LIVE_DECIDE_ASR_PREFETCH_TIMEOUT_MS` (6 000 ms) and `observeDecideOnly`
// (`analyzer.ts`) waited out `LIVE_DECIDE_ASR_WAIT_MS` (also 6 000 ms) before
// re-transcribing the same clip inline. The row paid 6 002 ms of dead wait plus
// 2 826 ms of inline ASR on top of a normal 2 561 ms decode → 11 460 ms
// `decideE2eMs`, the only row that failed the AC-B p95 bar (ADAAAA-8487/8606).
//
// A wait at/after the lane deadline can never receive a transcript, so the only
// correct resolutions are: 0 (documented inert default) or < lane timeout.
import { describe, it, expect } from "vitest";
import { clampDecideAsrWaitMs, loadConfig } from "../src/config";

describe("clampDecideAsrWaitMs (ADAAAA-8609)", () => {
  it("keeps the documented inert default at 0", () => {
    expect(clampDecideAsrWaitMs(0, 6_000)).toBe(0);
  });

  it("does not touch a wait that already sits under the lane deadline", () => {
    expect(clampDecideAsrWaitMs(1_500, 6_000)).toBe(1_500);
    expect(clampDecideAsrWaitMs(5_000, 6_000)).toBe(5_000);
  });

  it("caps a wait equal to the lane deadline 250 ms below it (the 0cade089 shape)", () => {
    expect(clampDecideAsrWaitMs(6_000, 6_000)).toBe(5_750);
  });

  it("caps a wait above the lane deadline too", () => {
    expect(clampDecideAsrWaitMs(9_000, 6_000)).toBe(5_750);
    expect(clampDecideAsrWaitMs(6_000, 2_500)).toBe(2_250);
  });

  it("never returns a non-positive ceiling for a tiny lane timeout", () => {
    expect(clampDecideAsrWaitMs(6_000, 200)).toBe(1);
    expect(clampDecideAsrWaitMs(6_000, 0)).toBe(5_750); // falls back to the 6000 default
  });

  it("treats an unparseable wait as inert", () => {
    expect(clampDecideAsrWaitMs(Number.NaN, 6_000)).toBe(0);
  });
});

describe("loadConfig — ASR wait budget vs lane timeout (ADAAAA-8609)", () => {
  it("clamps the leg's 6000/6000 pair instead of paying the lane's whole deadline", () => {
    const cfg = loadConfig({
      LIVE_DECIDE_ASR_WAIT_MS: "6000",
      LIVE_DECIDE_ASR_PREFETCH_TIMEOUT_MS: "6000",
    });
    expect(cfg.liveDecideAsrPrefetchTimeoutMs).toBe(6_000);
    expect(cfg.liveDecideAsrWaitMs).toBe(5_750);
    expect(cfg.liveDecideAsrWaitMs).toBeLessThan(cfg.liveDecideAsrPrefetchTimeoutMs);
  });

  it("keeps the inert default when the knob is unset or empty", () => {
    expect(loadConfig({}).liveDecideAsrWaitMs).toBe(0);
    expect(loadConfig({ LIVE_DECIDE_ASR_WAIT_MS: "" }).liveDecideAsrWaitMs).toBe(0);
  });

  it("honours a deliberately short wait and the lane's own timeout", () => {
    const cfg = loadConfig({
      LIVE_DECIDE_ASR_WAIT_MS: "1500",
      LIVE_DECIDE_ASR_PREFETCH_TIMEOUT_MS: "3000",
    });
    expect(cfg.liveDecideAsrWaitMs).toBe(1_500);
    expect(cfg.liveDecideAsrPrefetchTimeoutMs).toBe(3_000);
  });
});

// ADAAAA-8431 (origin ADAAAA-8427 PO ruling): the browser/media rail ignored
// `LIVE_DECIDE_KEEP_RATIO` AND the lever itself could only express a fraction
// of whatever opportunities a rail happened to offer.
//
// Two defects, one ticket:
//
// 1. PARITY. `api.ts` built `MediaRailObserver` with contentFps / maxFrames /
//    cadenceS / windowS / enrichment / stageA / signalGate and never passed
//    `decideKeepRatio` (`grep -c decideKeepRatio services/server/src/api.ts`
//    was 0), while the analyzer live pass did (`analyzer.ts`). The shipped
//    browser rail therefore decided EVERY cadence window: the first natural job
//    (b55c5781) charged 701 decides / 2 890.2 s = 72.76 per 300 s =
//    $2.89-2.90/h/stream against the $2.75 cap. This is the ADAAAA-8065/8074/8102
//    class — a knob fed one rail while the shipped rail kept the default.
//
// 2. UNITS. A keep RATIO caps a fraction of opportunities, and the two rails
//    offer different opportunity counts: ~104 / 300 s on the analyzer/file-sim
//    leg, 72.76 / 300 s on the natural browser leg. Wiring keep 0.64 alone
//    charges 46.6 / 300 s there — inside the spend cap but 44.8 % of the
//    104-window convention, BELOW the 63-decide coverage floor. Both gates
//    (AC-N2 spend <= 69/300 s, AC-N3 coverage >= 63/300 s) are only meetable
//    when the cap binds in absolute rate units, so `LiveObserver` resolves the
//    fraction once into charged-decides-per-300-s of SERVED clock (§1 of
//    `decision-ac6`: the clock `costUsd * 3600 / (stop - start)` is written on —
//    see the b8837d4a regression below for why the content tap is not it).
//
// These tests are the regression class: they fail for the unbounded rail (73
// charged / 73 opportunities) and for a ratio-only wire (46.6), and pass only
// for the absolute-rate mechanism (66).
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { buildLiveAnalyzerConfig } from "../src/api";
import { MediaRailObserver } from "../src/media-rail";
import { LiveObserver, type ObserveDecidePayload } from "../src/observe-loop";
import { loadConfig } from "../src/config";

const BASE_ENV = { PERCEIVE_URL: "http://p", DECIDE_URL: "http://d", LIVE_OBSERVE_LOOP: "1" };
const cfgFor = (overrides: Record<string, string> = {}) => loadConfig({ ...BASE_ENV, ...overrides });

/** The ratified target (ADAAAA-8427) and the funded band. */
const TARGET_PER_300S = 66;
const FLOOR_PER_300S = 63;
const CAP_PER_300S = 69;
/** The natural browser job's measured opportunity density: 72.76 per 300 s. */
const NATURAL_OPPORTUNITY_SPACING_S = 4.12;
const NATURAL_SECONDS = 300;

let T0 = 0;
beforeEach(() => {
  // Wall-clock epoch seconds, as the media node's relay reports: the rail drops
  // frames whose content time trails the wall clock by more than the lag budget.
  T0 = Date.now() / 1000;
  relayedS = 0;
});

// ADAAAA-8431 (wake grading `b8837d4a`): the rate budget accrues on the SERVED
// clock, so a test drives a simulated served clock alongside the content ts
// instead of waiting 300 s of wall time. `servedClock()` mirrors the last relayed
// content position; `skewClock()` lets a test make the served clock run AHEAD of
// the content tap (the warmup/relay-lag shape measured on the natural share).
let relayedS = 0;
const servedClock = () => (T0 + relayedS) * 1000;
function skewClock(offsetS: number) {
  let content = 0;
  return {
    at(contentS: number) {
      content = contentS;
    },
    now: () => (T0 + content + offsetS) * 1000,
  };
}

function jpeg(n: number): string {
  return Buffer.from(`jpeg-frame-${n}`).toString("base64");
}

async function settle(rail: MediaRailObserver): Promise<void> {
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const now = rail.stats().decideCalls;
    if (now === prev) {
      if (++stable >= 2) return;
    } else {
      stable = 0;
      prev = now;
    }
  }
}

/** Relay one observation and let the rail's decide chain settle on it before the
 *  next one. The rail writes each frame into the observer synchronously and the
 *  window assembles from the observer's trailing cache, so a burst feed followed
 *  by a late drain would decide against the newest frames only — the real relay
 *  is paced, and so is this. */
async function relay(rail: MediaRailObserver, ts: number, i: number): Promise<void> {
  relayedS = ts - T0;
  rail.onObservation({ timestamp: ts, tracks: [] } as any, jpeg(i));
  await new Promise((r) => setTimeout(r, 0));
}

describe("LIVE_DECIDE_KEEP_RATIO reaches BOTH live rails (AC-N1)", () => {
  it("api.ts passes cfg.liveDecideKeepRatio into the MediaRailObserver construction", () => {
    // The wiring line itself, guarded: the defect was a knob the media rail was
    // simply never handed, so a unit test of the observer cannot catch it.
    const src = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    const at = src.indexOf("new MediaRailObserver(");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 6000);
    expect(block).toMatch(/decideKeepRatio:\s*cfg\.liveDecideKeepRatio/);
  });

  it("resolves the same value into the analyzer live pass", () => {
    const cfg = cfgFor({ LIVE_DECIDE_KEEP_RATIO: "0.64" });
    expect(cfg.liveDecideKeepRatio).toBe(0.64);
    const anaCfg = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-8431", gameHint: "soccer" } as any,
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 } as any,
    });
    expect(anaCfg.liveDecideKeepRatio).toBe(0.64);
  });

  it("the media rail built from cfg actually throttles at keep < 1", async () => {
    const cfg = cfgFor({ LIVE_DECIDE_KEEP_RATIO: "0.64" });
    const rail = new MediaRailObserver({
      jobId: "job-8431-media-keep",
      fps: 2,
      cadenceS: 3,
      windowS: 10,
      maxFrames: 4,
      decideKeepRatio: cfg.liveDecideKeepRatio,
      wallClock: servedClock,
      onDecide: async () => false,
    });
    // 300 s of a 3 s-cadence share = 101 opportunities (the ~104 convention).
    for (let i = 0; i <= NATURAL_SECONDS; i += 3) await relay(rail, T0 + i, i);
    await settle(rail);

    const charged = rail.stats().decideCalls;
    expect(rail.observeMetrics().throttleSkippedWindows ?? 0).toBeGreaterThan(0);
    expect(charged).toBeGreaterThanOrEqual(FLOOR_PER_300S);
    expect(charged).toBeLessThanOrEqual(CAP_PER_300S);
  });
});

describe("the rate cap binds in ABSOLUTE units, not as a fraction of opportunities (AC-N2/AC-N3)", () => {
  /** Drive the media rail over a natural-shaped 300 s share and report the
   *  charged decides + throttle drops. */
  async function driveNatural(opts: { keepRatio?: number } = {}) {
    const rail = new MediaRailObserver({
      jobId: `job-8431-natural-${opts.keepRatio ?? "off"}`,
      fps: 2,
      cadenceS: 3,
      windowS: 10,
      maxFrames: 4,
      ...(opts.keepRatio !== undefined ? { decideKeepRatio: opts.keepRatio } : {}),
      wallClock: servedClock,
      onDecide: async () => false,
    });
    const n = Math.floor(NATURAL_SECONDS / NATURAL_OPPORTUNITY_SPACING_S) + 1;
    for (let i = 0; i < n; i++) {
      await relay(rail, T0 + i * NATURAL_OPPORTUNITY_SPACING_S, i);
    }
    await settle(rail);
    const metrics = rail.observeMetrics();
    return {
      opportunities: n,
      charged: rail.stats().decideCalls,
      throttled: metrics.throttleSkippedWindows ?? 0,
    };
  }

  it("73 opportunities / 300 s charges 66 (<= 69) and >= 63 at keep 0.64", async () => {
    const r = await driveNatural({ keepRatio: 0.64 });
    expect(r.opportunities).toBe(73);
    // Today's defect charged all 73 (unbounded rail) and a ratio-only wire would
    // charge floor(0.64 x 73) = 46 — both outside the band. This is the test
    // that fails for BOTH of those mechanisms.
    expect(r.charged).toBe(TARGET_PER_300S);
    expect(r.charged).toBeLessThanOrEqual(CAP_PER_300S);
    expect(r.charged).toBeGreaterThanOrEqual(FLOOR_PER_300S);
    // The paid share of the stream's opportunities (AC-N3's charged/opportunities).
    expect(r.charged / r.opportunities).toBeCloseTo(66 / 73, 4);
    expect(r.throttled).toBe(r.opportunities - r.charged);
    // Falsifier: a ratio-of-opportunities wire cannot reach the floor here.
    expect(r.charged).toBeGreaterThan(Math.floor(0.64 * r.opportunities));
  });

  it("served-clock accrual holds the band where the tap lags the served clock (b8837d4a shape)", async () => {
    // The first natural browser share after the 17:52Z deploy (b8837d4a): the
    // media session was SERVED 455.93 s while the content tap only advanced
    // 420.0 s (warmup ~30 s + relay lag), offering 124 opportunities
    // (93 kept + 31 rate-dropped). Crediting the CONTENT clock charges
    // 93 x 300 / 455.93 = 61.2 per SERVED 300 s — $2.432/h, inside the spend cap
    // but 1.8 decides under the 63 coverage floor on the only denominator §1
    // defines. Crediting the SERVED clock charges ~66 per served 300 s, so both
    // gates hold. This test fails for the content-clock mechanism and passes for
    // the served-clock one.
    const CONTENT_S = 420;
    const SERVED_S = 455.93;
    const SPACING_S = 3.4;
    const servedAhead = skewClock(SERVED_S - CONTENT_S);
    const contentOnly = skewClock(0);
    const mk = (clock: { now: () => number }, jobId: string) =>
      new MediaRailObserver({
        jobId,
        fps: 2,
        cadenceS: 3,
        windowS: 10,
        maxFrames: 4,
        decideKeepRatio: 0.64,
        wallClock: clock.now,
        onDecide: async () => false,
      });
    const fixed = mk(servedAhead, "job-8431-served-clock");
    const preFix = mk(contentOnly, "job-8431-content-clock");
    // The served window opens with the media session, 35.93 s before the
    // publisher's first frame: the head banks and is spent once content arrives.
    // The pre-fix rail has no served anchor — it credits the content tap only.
    fixed.noteServedClockStart(T0 * 1000);
    const n = Math.floor(CONTENT_S / SPACING_S);
    for (let i = 0; i < n; i++) {
      const ts = T0 + i * SPACING_S;
      const at = ts - T0;
      servedAhead.at(at);
      contentOnly.at(at);
      preFix.onObservation({ timestamp: ts, tracks: [] } as any, jpeg(i));
      fixed.onObservation({ timestamp: ts, tracks: [] } as any, jpeg(i));
      await new Promise((r) => setTimeout(r, 0));
    }
    await settle(fixed);
    await settle(preFix);

    const fixedCharged = fixed.stats().decideCalls;
    const preFixCharged = preFix.stats().decideCalls;
    const fixedRate = (fixedCharged * 300) / SERVED_S;
    const preFixRate = (preFixCharged * 300) / SERVED_S;
    // Served-clock accrual: 63..69 charged per SERVED 300 s.
    expect(fixedCharged).toBeGreaterThan(preFixCharged + 4);
    expect(fixedRate).toBeGreaterThanOrEqual(FLOOR_PER_300S);
    expect(fixedRate).toBeLessThanOrEqual(CAP_PER_300S);
    expect(fixed.observeMetrics().throttleSkippedWindows ?? 0).toBeGreaterThan(0);
    // Falsifier: the content-clock mechanism reads under the floor on the same
    // stream and the same denominator.
    expect(preFixRate).toBeLessThan(FLOOR_PER_300S);
  });

  it("an unset keep leaves the rail unbounded — byte-identical shipped behaviour", async () => {
    const r = await driveNatural();
    expect(r.charged).toBe(r.opportunities);
    expect(r.throttled).toBe(0);
  });

  it("the cap does not invent coverage on a thin stream (< 66 opportunities)", async () => {
    // A 5 s-cadence share offers 61 opportunities: the rate budget is not the
    // binding constraint and the rail decides every one. The ticket's AC-N3 says
    // this is stream density, not a reason to raise keep.
    const rail = new MediaRailObserver({
      jobId: "job-8431-thin",
      fps: 2,
      cadenceS: 3,
      windowS: 10,
      maxFrames: 4,
      decideKeepRatio: 0.64,
      wallClock: servedClock,
      onDecide: async () => false,
    });
    for (let i = 0; i <= NATURAL_SECONDS; i += 5) await relay(rail, T0 + i, i);
    await settle(rail);
    expect(rail.stats().decideCalls).toBeGreaterThan(55);
    expect(rail.stats().decideCalls).toBeLessThanOrEqual(CAP_PER_300S);
  });
});

describe("latency-critical fires bypass the rate cap and repay as debt (AC-N4)", () => {
  it("an anchored window decides at its cadence with the rate credit exhausted", async () => {
    const fired: ObserveDecidePayload[] = [];
    const clock = skewClock(0);
    const obs = new LiveObserver({
      cadenceS: 3,
      windowS: 10,
      maxFrames: 30,
      fps: 2,
      decideKeepRatio: 0.64,
      wallClock: clock.now,
      onDecide: async (p) => {
        fired.push(p);
        return true;
      },
    });
    expect(obs.decideRatePer300s()).toBe(TARGET_PER_300S);

    // Burn the rate budget: 300 s at 3 s cadence leaves the credit ≤ 0 and the
    // cadence windows throttled.
    for (let t = 0; t <= NATURAL_SECONDS; t += 3) {
      obs.record(t, `f${t}`, { ts: t });
      clock.at(t);
      await obs.maybeFire(t);
    }
    const chargedBefore = obs.decideCalls();
    expect(obs.throttleSkipCount()).toBeGreaterThan(0);

    // A fired audio trigger comes due 1 s after its onset. With credit exhausted
    // it must still decide immediately — never wait for a token (~4.5 s).
    const onset = NATURAL_SECONDS + 1;
    obs.record(onset, `onset`, { ts: onset });
    obs.recordTrigger({
      kind: "burst",
      onsetTs: onset,
      firedAt: onset,
      onsetLatencyS: 0.2,
      peakEnergy: 0.9,
      baselineEnergy: 0.2,
      thresholdId: "stageA/roar",
    });
    // Next frame after the trigger's 1 s lead.
    obs.record(onset + 1.5, "after", { ts: onset + 1.5 });
    clock.at(onset + 1.5);
    await obs.maybeFire(onset + 1.5);

    expect(obs.decideCalls()).toBe(chargedBefore + 1);
    expect(obs.triggerFireCount()).toBeGreaterThanOrEqual(1);
    // Worst-case anchored wait stays inside one cadence (AC-N4).
    const stats = obs.anchoredLatencyByFamilyStats();
    const maxMs = Math.max(0, ...stats.map((s) => s.maxMs));
    expect(maxMs).toBeLessThanOrEqual(3 * 1000);
    // The bypass charged the window, so the budget carries the debt.
    expect(fired.some((p) => p.trigger?.onsetTs === onset)).toBe(true);
  });

  it("a force (end-of-stream) fire always decides", async () => {
    const clock = skewClock(0);
    const obs = new LiveObserver({
      cadenceS: 3,
      windowS: 10,
      maxFrames: 30,
      fps: 2,
      decideKeepRatio: 0.64,
      wallClock: clock.now,
      onDecide: async () => true,
    });
    for (let t = 0; t <= NATURAL_SECONDS; t += 3) {
      obs.record(t, `f${t}`, { ts: t });
      clock.at(t);
      await obs.maybeFire(t);
    }
    const before = obs.decideCalls();
    obs.record(NATURAL_SECONDS + 3, "tail", { ts: NATURAL_SECONDS + 3 });
    await obs.flush();
    expect(obs.decideCalls()).toBe(before + 1);
  });
});

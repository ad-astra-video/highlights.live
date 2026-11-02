// ADAAAA-7758: one live decide slot per box. A second concurrent live job must
// not interleave decides with the first: a 4-slot box at ~10.5 s/decide has no
// steady state for two streams, so both fall behind and the 30 s budget drops
// ~85% of EVERY stream's windows (QA: 145 of ~170 skipped at 2 streams). The
// admission gate refuses the later stream's decide instead, so the first stream
// keeps its solo decided latency and its budget. This suite pins:
//   (a) the gate is inert when disabled (the shipped default),
//   (b) the first asking job holds the slot and is always re-admitted,
//   (c) another job is refused (counted per job) and admitted after a release,
//   (d) a holder that stops deciding for the TTL forfeits the slot (no wedge),
//   (e) LiveObserver: a refused tick makes NO decide, records NO latency sample
//       (a refused decide must never look like a fast one and shrink the lag
//       reserve) and counts an admission skip instead of a stale skip.
import { describe, it, expect } from "vitest";
import { LiveDecideAdmission, LIVE_DECIDE_ADMISSION_TTL_MS } from "../src/live-decide-admission";
import { LiveObserver } from "../src/observe-loop";

const seed = (ts: number) => ({ ts, tracks: [], objects: [], ocr: [] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LiveDecideAdmission (ADAAAA-7758)", () => {
  it("(a) disabled: every live job is admitted, no arbitration", () => {
    const gate = new LiveDecideAdmission({ enabled: false });
    expect(gate.admit("job-a", 0)).toBe(true);
    expect(gate.admit("job-b", 0)).toBe(true);
    expect(gate.admit("job-c", 0)).toBe(true);
    expect(gate.snapshot().refusals).toBe(0);
  });

  it("(b)+(c) enabled: the first job holds the slot, a second is refused and queued until release", () => {
    const gate = new LiveDecideAdmission({ enabled: true });
    expect(gate.admit("job-a", 1_000)).toBe(true);
    // the holder is always re-admitted (its own rail is already serial)
    expect(gate.admit("job-a", 5_000)).toBe(true);
    // a second live job may not decide while job-a holds the slot
    expect(gate.admit("job-b", 5_000)).toBe(false);
    expect(gate.admit("job-b", 6_000)).toBe(false);
    const snap = gate.snapshot();
    expect(snap.holderJobId).toBe("job-a");
    expect(snap.refusals).toBe(2);
    expect(snap.refusalsByJob).toEqual({ "job-b": 2 });

    // job-a ends -> the waiting job takes the slot on its next tick
    gate.release("job-a");
    expect(gate.snapshot().holderJobId).toBe(null);
    expect(gate.admit("job-b", 7_000)).toBe(true);
    expect(gate.snapshot().holderJobId).toBe("job-b");
  });

  it("(c) release is idempotent and only the holder can free the slot", () => {
    const gate = new LiveDecideAdmission({ enabled: true });
    expect(gate.admit("job-a", 0)).toBe(true);
    gate.release("job-b"); // not the holder
    expect(gate.snapshot().holderJobId).toBe("job-a");
    gate.release("job-a");
    gate.release("job-a");
    expect(gate.snapshot().holderJobId).toBe(null);
  });

  it("(d) a holder idle past the TTL forfeits the slot so a dead job cannot wedge the box", () => {
    const gate = new LiveDecideAdmission({ enabled: true });
    expect(gate.admit("job-a", 0)).toBe(true);
    const stale = LIVE_DECIDE_ADMISSION_TTL_MS + 1;
    expect(gate.admit("job-b", stale)).toBe(true);
    expect(gate.snapshot().holderJobId).toBe("job-b");
    expect(gate.snapshot().refusals).toBe(0);
  });

  it("disabling at runtime releases the slot", () => {
    const gate = new LiveDecideAdmission({ enabled: true });
    gate.admit("job-a", 0);
    gate.configure(false);
    expect(gate.snapshot().holderJobId).toBe(null);
    expect(gate.admit("job-b", 0)).toBe(true);
  });
});

describe("LiveObserver admission skip (ADAAAA-7758)", () => {
  it("(e) a refused tick decides nothing, records no latency sample, and counts an admission skip", async () => {
    const payloads: number[] = [];
    let admitted = false;
    const observer = new LiveObserver({
      cadenceS: 3,
      windowS: 10,
      fps: 2,
      canDecide: () => admitted,
      onDecide: async (p) => {
        payloads.push(p.centerTs);
        return false;
      },
    });
    observer.record(0, "f0", seed(0));
    await observer.maybeFire(0, false, 1000);
    expect(payloads).toEqual([]);
    expect(observer.admissionSkipCount()).toBe(1);
    expect(observer.decideCalls()).toBe(0);
    expect(observer.latencySamples()).toEqual([]);
    // not a lag-driven skip: the budget did not swallow a window here
    expect(observer.skippedStaleWindowCount()).toBe(0);

    // the cadence clock was NOT advanced, so the moment the slot frees the next
    // frame decides immediately instead of waiting out a cadence.
    admitted = true;
    observer.record(1.5, "f1.5", seed(1.5));
    await observer.maybeFire(1.5, false, 1000);
    expect(payloads).toEqual([1.5]);
    expect(observer.decideCalls()).toBe(1);
    expect(observer.admissionSkipCount()).toBe(1);
  });

  it("(e) a refusal is counted once per cadence window, not once per retried frame", async () => {
    const observer = new LiveObserver({
      cadenceS: 3,
      windowS: 10,
      fps: 2,
      canDecide: () => false,
      onDecide: async () => false,
    });
    observer.record(0, "f0", seed(0));
    // the slot is held elsewhere: every frame re-asks, one window is queued
    for (const ts of [0, 0.3, 0.7, 1.2, 2.0, 2.9]) {
      observer.record(ts, `f${ts}`, seed(ts));
      await observer.maybeFire(ts, false, 500);
    }
    expect(observer.admissionSkipCount()).toBe(1);
    // the next cadence window that cannot be decided is a second queued window
    observer.record(3.2, "f3.2", seed(3.2));
    await observer.maybeFire(3.2, false, 500);
    expect(observer.admissionSkipCount()).toBe(2);
    expect(observer.decideCalls()).toBe(0);
  });

  it("(e) a refused forced tail (flush) is also skipped and counted", async () => {
    const payloads: number[] = [];
    const observer = new LiveObserver({
      cadenceS: 3,
      windowS: 10,
      fps: 2,
      canDecide: () => false,
      onDecide: async (p) => {
        payloads.push(p.centerTs);
        return false;
      },
    });
    observer.record(0, "f0", seed(0));
    await observer.flush(500);
    expect(payloads).toEqual([]);
    expect(observer.admissionSkipCount()).toBe(1);
    expect(observer.decideCalls()).toBe(0);
  });
});

describe("LiveDecideAdmission in-flight depth sharing (ADAAAA-7771)", () => {
  it("shares the decide admission across live streams: a lone stream gets the full depth, two get half, three degrade to serial", () => {
    const gate = new LiveDecideAdmission({ enabled: false });
    // maxPerStream = 4, admission = 2 (the shipped DECIDE_CONCURRENCY default)
    gate.registerLiveJob("job-a");
    expect(gate.activeLiveJobCount()).toBe(1);
    // a LONE stream keeps the full per-stream depth (queueing above the 2-wide
    // gate is harmless for one stream and buys coverage)
    expect(gate.depthFor("job-a", 4, 2)).toBe(4);
    gate.registerLiveJob("job-b");
    // two streams share a 2-wide gate: one each (serial), NOT two each
    expect(gate.depthFor("job-a", 4, 2)).toBe(1);
    expect(gate.depthFor("job-b", 4, 2)).toBe(1);
    gate.registerLiveJob("job-c");
    expect(gate.depthFor("job-a", 4, 2)).toBe(1);
    // a 8-wide admission (both decide cards) gives a lone stream its full depth
    gate.releaseLiveJob("job-b");
    gate.releaseLiveJob("job-c");
    expect(gate.depthFor("job-a", 4, 8)).toBe(4);
    // two streams over an 8-wide admission: 4 each
    gate.registerLiveJob("job-b");
    expect(gate.depthFor("job-a", 4, 8)).toBe(4);
    expect(gate.depthFor("job-b", 4, 8)).toBe(4);
    // ...and three streams: floor(8/3) = 2 each
    gate.registerLiveJob("job-c");
    expect(gate.depthFor("job-a", 4, 8)).toBe(2);
    // a stream leaving restores the others' share
    gate.releaseLiveJob("job-b");
    gate.releaseLiveJob("job-c");
    expect(gate.depthFor("job-a", 4, 8)).toBe(4);
    // never below 1 even when the admission is crowded, and never above the cap
    gate.registerLiveJob("job-b");
    gate.registerLiveJob("job-c");
    gate.registerLiveJob("job-d");
    gate.registerLiveJob("job-e");
    expect(gate.depthFor("job-a", 4, 2)).toBe(1);
    expect(gate.depthFor("job-a", 1, 8)).toBe(1);
    // release is idempotent
    gate.releaseLiveJob("job-e");
    gate.releaseLiveJob("job-e");
    expect(gate.activeLiveJobCount()).toBe(4);
  });

  it("(f) LiveObserver: a shrinking depth budget is honoured as backpressure, not as oversubscription", async () => {
    let active = 0;
    let maxActive = 0;
    let budget = 2;
    const observer = new LiveObserver({
      cadenceS: 0.2,
      windowS: 1,
      fps: 10,
      maxInFlight: 4,
      depthBudget: () => budget,
      onDecideStaged: () => ({
        decide: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await sleep(40);
          active--;
        },
        accept: async () => false,
      }),
    });
    const seedAt = (ts: number) => ({ ts, tracks: [], objects: [], ocr: [] });
    for (let i = 0; i <= 10; i++) {
      const ts = Number((i * 0.2).toFixed(6));
      observer.record(ts, `f${ts}`, seedAt(ts) as any);
      if (i === 5) budget = 1; // a second live stream arrives mid-pass
      await observer.maybeFire(ts, false, 0);
    }
    await observer.flush();
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(observer.maxInFlightDepth()).toBe(2);
    expect(observer.backpressureSkipCount()).toBeGreaterThan(0);
    expect(observer.currentDepthBudget()).toBe(1);
  });
});

// ADAAAA-7723: every accepted audio trigger must be JUDGED or accounted for.
//
// Measured on the deployed box (job 627e63a8, 110 s RTC share, `0e3fe50`): the
// scheduler accepted 4 triggers and only 1 anchored a decide window, with no
// counter saying where the other 3 went — a celebration roar could be accepted
// and silently never reach gemma while the rail still logged a healthy
// `triggers=4`.
//
// Three defects made an accepted trigger vanish, and these tests pin them:
//
//   1. HEAD-OF-LINE BLOCKING — `peekDue` only inspected the oldest QUEUED
//      trigger. The audio tap runs ahead of the (lagging) video frame clock, so
//      a trigger whose onset was still in the future blocked every due trigger
//      behind it until they expired.
//   2. CONSUME-BEFORE-WINDOW — `fire()` consumed the trigger and spent a budget
//      token, then returned when the window could not be assembled. The trigger
//      was counted `fired` and no decide was ever issued.
//   3. NO LEDGER — coalesced/covered/expired/dropped triggers were invisible, so
//      the discrepancy could not be reconciled from a share's evidence line.
import { describe, expect, it } from "vitest";
import {
  AUDIO_TRIGGER_MAX_ANCHOR_LATENCY_S,
  AUDIO_TRIGGER_MAX_STALE_S,
  TriggerWindowScheduler,
  WHISTLE_THRESHOLD_ID,
  type AudioTriggerRecord,
} from "../src/audio-trigger";
import { LiveObserver, OBSERVE_CADENCE_S } from "../src/observe-loop";

function trig(onsetTs: number, overrides: Partial<AudioTriggerRecord> = {}): AudioTriggerRecord {
  return {
    kind: "burst",
    onsetTs,
    firedAt: onsetTs + 1,
    onsetLatencyS: 1,
    peakEnergy: 0.4,
    baselineEnergy: 0.05,
    thresholdId: "stageA/burst/1.3x/0.3s",
    ...overrides,
  };
}

function whistle(onsetTs: number): AudioTriggerRecord {
  return trig(onsetTs, { thresholdId: WHISTLE_THRESHOLD_ID });
}

/** Reconcile: every accepted trigger is fired, covered, expired, or pending. */
function expectReconciled(s: TriggerWindowScheduler): void {
  const st = s.stats();
  expect(st.accepted).toBe((st.fired ?? 0) + (st.covered ?? 0) + (st.expired ?? 0) + (st.pending ?? 0));
  expect(s.reconciled().ok).toBe(true);
}

async function runStream(obs: LiveObserver, seconds: number, onFrame?: (ts: number) => void): Promise<void> {
  const fps = 10;
  const dt = 1 / fps;
  for (let i = 0; i * dt <= seconds + 1e-9; i++) {
    const ts = Number((i * dt).toFixed(4));
    obs.record(ts, `frame-${ts}`, { ts });
    onFrame?.(ts);
    await obs.maybeFire(ts);
  }
}

describe("TriggerWindowScheduler coverage ledger (ADAAAA-7723)", () => {
  it("does not let a future-onset trigger block a due one (head-of-line)", () => {
    const s = new TriggerWindowScheduler();
    // The audio tap runs ahead of the video frame clock, so the whistle's onset
    // is 10 s in the FUTURE when it is queued; the roar behind it is already due.
    expect(s.record(whistle(20))).toBe(true);
    expect(s.record(trig(10))).toBe(true);
    expect(s.pendingCount()).toBe(2);

    // Before the fix `peekDue(12)` returned null (head = onset 20, not due yet)
    // and the due roar starved until it expired with no anchored window.
    expect(s.peekDue(12)?.onsetTs).toBe(10);
    expect(s.due(12)?.onsetTs).toBe(10);
    expect(s.stats().fired).toBe(1);
    expect(s.pendingCount()).toBe(1);
    // The future whistle still anchors once the clock reaches it.
    expect(s.due(21)?.onsetTs).toBe(20);
    expect(s.stats().fired).toBe(2);
    expectReconciled(s);
  });

  it("anchors the EARLIEST due trigger when several are pending", () => {
    const s = new TriggerWindowScheduler();
    // >2.5 s apart so the same-family coalesce keeps them all (distinct events).
    s.record(trig(16));
    s.record(trig(10));
    s.record(trig(13));
    // Out of queue order on purpose: a burst of drains must not decide the
    // newest evidence first and let the oldest expire.
    expect(s.peekDue(15)?.onsetTs).toBe(10);
    expect(s.due(15)?.onsetTs).toBe(10);
    expect(s.due(17)?.onsetTs).toBe(13);
    expect(s.due(17)?.onsetTs).toBe(16);
    expectReconciled(s);
  });

  it("never anchors a window past the 1-5 s contract latency", () => {
    const s = new TriggerWindowScheduler();
    s.record(trig(10));
    // 5.5 s of content after onset: an anchored window here would report a
    // latency the contract does not allow, so it is NOT fired late.
    expect(s.peekDue(10 + AUDIO_TRIGGER_MAX_ANCHOR_LATENCY_S + 0.5)).toBeNull();
    expect(s.stats().fired).toBe(0);
    expect(s.stats().pending).toBe(1);
    // Once its frames leave the retained window it is accounted as EXPIRED.
    expect(s.due(10 + AUDIO_TRIGGER_MAX_STALE_S + 1)).toBeNull();
    expect(s.stats().expired).toBe(1);
    expectReconciled(s);
  });

  it("accounts for a trigger still pending at end of share", () => {
    const s = new TriggerWindowScheduler();
    s.record(trig(100)); // audio ahead of the tail: can never anchor
    expect(s.stats().pending).toBe(1);
    expect(s.expirePending()).toBe(1);
    expect(s.stats().pending).toBe(0);
    expect(s.stats().expired).toBe(1);
    expectReconciled(s);
  });

  it("ledger: coalesced re-fires never inflate the accepted total", () => {
    const s = new TriggerWindowScheduler();
    expect(s.record(trig(10))).toBe(true);
    expect(s.record(trig(10.4))).toBe(false); // same family, inside coalesce
    expect(s.due(11.5)?.onsetTs).toBe(10);
    expect(s.stats().coalesced).toBe(1);
    expect(s.stats().accepted).toBe(1);
    expectReconciled(s);
  });
});

describe("LiveObserver trigger coverage (ADAAAA-7723)", () => {
  function isolated() {
    // signalGate on + no perceive signal = cadence windows are gated off, so a
    // trigger is ONLY judged by an anchored window or an explicit accounting.
    const seen: any[] = [];
    const obs = new LiveObserver({
      cadenceS: OBSERVE_CADENCE_S,
      windowS: 10,
      maxFrames: 30,
      fps: 10,
      signalGate: true,
      onDecide: async (p) => (seen.push(p), false),
    });
    return { obs, seen };
  }

  it("anchors a trigger queued ahead of the frame clock instead of losing it", async () => {
    const { obs, seen } = isolated();
    let injected = false;
    await runStream(obs, 25, (ts) => {
      if (injected || ts < 5 - 1e-9) return;
      injected = true;
      // audio ahead of video: whistle onset 12 s (7 s in the future)...
      expect(obs.recordTrigger(whistle(12))).toBe(true);
      // ...and a roar that is already due at this tick.
      expect(obs.recordTrigger(trig(4))).toBe(true);
    });

    const anchored = seen.filter((p) => p.trigger).map((p) => p.trigger.onsetTs);
    // Before the fix the future whistle sat at the head of the FIFO: the roar
    // starved past the stale horizon and neither ever anchored a window.
    expect(anchored).toContain(4);
    expect(anchored).toContain(12);
    const s = obs.triggerStats();
    expect(s.fired).toBe(2);
    expect(s.expired ?? 0).toBe(0);
    expect(obs.triggerReconciliation().ok).toBe(true);
    // AC-2: latency measured per family, not pooled.
    const fams = Object.fromEntries(obs.anchoredLatencyByFamilyStats().map((f) => [f.family, f]));
    expect(fams.stageA?.samples).toBe(1);
    expect(fams.stageB?.samples).toBe(1);
    for (const f of Object.values(fams)) {
      expect(f.p50Ms).toBeGreaterThanOrEqual(1000);
      expect(f.p50Ms).toBeLessThanOrEqual(AUDIO_TRIGGER_MAX_ANCHOR_LATENCY_S * 1000);
    }
  });

  it("a signal-gated tick covers nothing (the window never reached gemma)", async () => {
    const { obs, seen } = isolated();
    let injected = false;
    await runStream(obs, 14, (ts) => {
      if (injected) return;
      injected = true;
      // 0.2 s in the future at the moment it is queued — the cadence ticks that
      // follow are gated off, so only a real decide may claim it.
      obs.recordTrigger(trig(ts + 0.2));
    });
    expect(seen.filter((p) => p.trigger)).toHaveLength(1);
    expect(obs.triggerStats().covered ?? 0).toBe(0);
    expect(obs.triggerStats().fired).toBe(1);
  });

  it("accounts a share-end dangling trigger as expired instead of pending", async () => {
    const seen: any[] = [];
    const obs = new LiveObserver({
      cadenceS: OBSERVE_CADENCE_S,
      windowS: 10,
      maxFrames: 30,
      fps: 10,
      onDecide: async (p) => (seen.push(p), false),
    });
    obs.record(0, "f0", { ts: 0 });
    await obs.maybeFire(0);
    // The audio tap reported an onset far past the tail the video rail reached.
    obs.recordTrigger(whistle(300));
    await obs.flush();
    const s = obs.triggerStats();
    expect(s.pending).toBe(0);
    expect(s.expired).toBe(1);
    expect(obs.triggerReconciliation().ok).toBe(true);
    expect(seen.every((p) => !p.trigger)).toBe(true);
    // the tail decide still happened (flush is unchanged)
    expect(obs.decideCalls()).toBeGreaterThanOrEqual(2);
  });

  it("keeps the decide cadence baseline (no storm from the coverage fix)", async () => {
    const seen: any[] = [];
    const obs = new LiveObserver({
      cadenceS: OBSERVE_CADENCE_S,
      windowS: 10,
      maxFrames: 30,
      fps: 10,
      onDecide: async (p) => (seen.push(p), false),
    });
    await runStream(obs, 60, (ts) => {
      // a trigger every 2 s across both families — denser than the cadence
      if (ts >= 4 && Math.abs(ts - Math.round(ts)) < 1e-9 && Math.round(ts) % 2 === 0) {
        obs.recordTrigger(Math.round(ts) % 4 === 0 ? whistle(ts) : trig(ts));
      }
    });
    // 60 s at a 3 s cadence = 21 blind-cadence decides; anchored fires spend the
    // SAME budget, so the total can never exceed it (AC-3).
    expect(seen.length).toBeLessThanOrEqual(21);
    expect(obs.triggerFireCount() + obs.cadenceFireCount()).toBe(obs.decideCalls());
    expect(obs.triggerReconciliation().ok).toBe(true);
    const s = obs.triggerStats();
    expect((s.fired ?? 0) + (s.covered ?? 0) + (s.expired ?? 0) + (s.pending ?? 0)).toBe(s.accepted);
    // the share-end flush closes the ledger: nothing is left dangling
    await obs.flush();
    expect(obs.triggerStats().pending).toBe(0);
    expect(obs.triggerReconciliation().ok).toBe(true);
  });
});

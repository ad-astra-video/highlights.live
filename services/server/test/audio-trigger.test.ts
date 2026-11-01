// ADAAAA-7658: audio-noise trigger windows.
//
// Two layers of coverage:
//   1. TriggerWindowScheduler — coalescing, one-analysis-per-trigger, lead,
//      coverage, expiry, invalid-record rejection (pure, deterministic).
//   2. LiveObserver integration — a fired trigger anchors ONE decide window
//      instead of a per-frame storm, and trigger windows REPLACE cadence ticks
//      so the decide-call count can never exceed the blind-cadence baseline
//      (AC3: 0 added steady-state GPU sessions).
import { describe, expect, it } from "vitest";
import {
  AUDIO_TRIGGER_COALESCE_S,
  AUDIO_TRIGGER_LEAD_S,
  TriggerWindowScheduler,
  audioTriggerFromCandidate,
  audioTriggerFromSignal,
  type AudioTriggerRecord,
} from "../src/audio-trigger";
import { LiveObserver, buildObservePayload, OBSERVE_CADENCE_S } from "../src/observe-loop";

function trig(onsetTs: number, kind: "burst" | "swell" = "burst", overrides: Partial<AudioTriggerRecord> = {}): AudioTriggerRecord {
  return {
    kind,
    onsetTs,
    firedAt: onsetTs + 1,
    onsetLatencyS: 1,
    peakEnergy: 0.4,
    baselineEnergy: 0.05,
    thresholdId: `stageA/${kind}/1.3x/0.3s`,
    ...overrides,
  };
}

/** Drive an observer over `seconds` of content at `fps` frames/s. `beforeFire`
 *  lets a test inject a trigger at a given content time (what the audio tap leg
 *  does between frames). */
async function runStream(
  obs: LiveObserver,
  seconds: number,
  opts: { fps?: number; onFrame?: (ts: number) => void } = {}
): Promise<void> {
  const fps = opts.fps ?? 10;
  const dt = 1 / fps;
  for (let i = 0; i * dt <= seconds + 1e-9; i++) {
    const ts = Number((i * dt).toFixed(4));
    obs.record(ts, `frame-${ts}`, { ts });
    opts.onFrame?.(ts);
    await obs.maybeFire(ts);
  }
}

function captureDecides() {
  const seen: any[] = [];
  const obs = new LiveObserver({
    cadenceS: OBSERVE_CADENCE_S,
    windowS: 10,
    maxFrames: 30,
    fps: 10,
    onDecide: async (payload) => {
      seen.push(payload);
      return false;
    },
  });
  return { obs, seen };
}

describe("audioTriggerFromSignal / fromCandidate (normalization)", () => {
  it("normalizes a perceive AudioSignal into the trigger record shape", () => {
    const t = audioTriggerFromSignal({
      kind: "burst",
      ts: 12.5,
      firedAt: 13.4,
      onsetLatencyS: 0.9,
      peakEnergy: 0.42,
      baselineEnergy: 0.03,
      thresholdId: "stageA/burst/1.3x/0.3s",
    });
    expect(t).toEqual({
      kind: "burst",
      onsetTs: 12.5,
      firedAt: 13.4,
      onsetLatencyS: 0.9,
      peakEnergy: 0.42,
      baselineEnergy: 0.03,
      thresholdId: "stageA/burst/1.3x/0.3s",
    });
  });

  it("defaults thresholdId for evidence recorded before the field existed", () => {
    const t = audioTriggerFromSignal({
      kind: "swell",
      ts: 1,
      firedAt: 2,
      onsetLatencyS: 1,
      peakEnergy: 0.3,
      baselineEnergy: 0.02,
    });
    expect(t?.thresholdId).toBe("stageA/swell");
  });

  it("rejects missing / invalid evidence instead of scheduling an analysis", () => {
    expect(audioTriggerFromSignal(null)).toBeNull();
    expect(audioTriggerFromSignal(undefined)).toBeNull();
    expect(
      audioTriggerFromSignal({ kind: "burst", ts: Number.NaN, firedAt: 2, onsetLatencyS: 1, peakEnergy: 0.3, baselineEnergy: 0.1 })
    ).toBeNull();
    // latency outside the 1-5 s budget is not a valid trigger
    expect(
      audioTriggerFromSignal({ kind: "burst", ts: 1, firedAt: 12, onsetLatencyS: 11, peakEnergy: 0.3, baselineEnergy: 0.1 })
    ).toBeNull();
  });

  it("pulls the trigger off `candidate.audio`", () => {
    const t = audioTriggerFromCandidate({
      audio: { kind: "burst", ts: 3, firedAt: 4, onsetLatencyS: 1, peakEnergy: 0.5, baselineEnergy: 0.04 },
    });
    expect(t?.onsetTs).toBe(3);
    expect(audioTriggerFromCandidate({})).toBeNull();
    expect(audioTriggerFromCandidate(null)).toBeNull();
  });
});

describe("TriggerWindowScheduler (dedup / coalesce / expiry)", () => {
  it("coalesces re-fires of the same audible event into ONE analysis", () => {
    const s = new TriggerWindowScheduler();
    expect(s.record(trig(10))).toBe(true);
    // inside the coalesce window (the gate's own cooldown is 2 s)
    expect(s.record(trig(10.5))).toBe(false);
    expect(s.record(trig(11.0))).toBe(false);
    // a distinct event beyond the coalesce window is queued
    expect(s.record(trig(10 + AUDIO_TRIGGER_COALESCE_S + 0.1))).toBe(true);
    expect(s.pendingCount()).toBe(2);
    expect(s.stats().coalesced).toBe(2);
  });

  it("does not release a trigger before the lead window elapses", () => {
    const s = new TriggerWindowScheduler();
    s.record(trig(10));
    expect(s.due(10 + AUDIO_TRIGGER_LEAD_S - 0.1)).toBeNull();
    const due = s.due(10 + AUDIO_TRIGGER_LEAD_S);
    expect(due?.onsetTs).toBe(10);
    expect(s.due(20)).toBeNull(); // handed out exactly once
  });

  it("drops stale triggers (their frames are already evicted)", () => {
    const s = new TriggerWindowScheduler({ maxStaleS: 8 });
    s.record(trig(10));
    expect(s.due(30)).toBeNull();
    expect(s.stats().expired).toBe(1);
  });

  it("marks pending triggers inside an already-analyzed window as covered", () => {
    const s = new TriggerWindowScheduler();
    s.record(trig(10));
    s.record(trig(15));
    expect(s.coverThrough(9, 16)).toBe(2);
    expect(s.pendingCount()).toBe(0);
  });

  it("never queues a structurally invalid record", () => {
    const s = new TriggerWindowScheduler();
    expect(s.record(null)).toBe(false);
    expect(s.record(trig(10, "burst", { onsetLatencyS: 9 }))).toBe(false);
    expect(s.stats().invalid).toBe(2);
  });
});

describe("LiveObserver trigger windows", () => {
  it("baseline: blind cadence fires ~1 decide per cadenceS", async () => {
    const { obs, seen } = captureDecides();
    await runStream(obs, 60);
    expect(seen.length).toBe(21); // t = 0,3,...,60
    expect(obs.triggerFireCount()).toBe(0);
    expect(obs.cadenceFireCount()).toBe(21);
  });

  it("one trigger => exactly one anchored analysis (no per-frame storm)", async () => {
    const { obs, seen } = captureDecides();
    let injected = false;
    await runStream(obs, 20, {
      onFrame: (ts) => {
        if (!injected && ts >= 5) {
          injected = true;
          expect(obs.recordTrigger(trig(5))).toBe(true);
        }
      },
    });
    const anchored = seen.filter((p) => p.trigger);
    expect(anchored).toHaveLength(1);
    expect(anchored[0].trigger.onsetTs).toBe(5);
    // the window is anchored at/near the trigger moment, not at a random frame
    expect(anchored[0].centerTs).toBeGreaterThanOrEqual(5 + AUDIO_TRIGGER_LEAD_S - 1e-9);
    expect(anchored[0].centerTs).toBeLessThanOrEqual(5 + AUDIO_TRIGGER_LEAD_S + 0.11);
    // latency: level change -> decide request inside the 1.5 s p95 bar
    expect(anchored[0].centerTs - 5).toBeLessThanOrEqual(1.5);
    // the trigger rides as provenance in the bias hints too
    expect(anchored[0].biasHints.some((h: any) => h.eventType === "AUDIO_BURST" && h.ts === 5)).toBe(true);
  });

  it("a storm of triggers does NOT add decide calls beyond the cadence baseline (AC3)", async () => {
    const { obs, seen } = captureDecides();
    const baseline = 21; // 60 s at a 3 s cadence
    await runStream(obs, 60, {
      onFrame: (ts) => {
        // a trigger every 2 s (denser than the cadence) — the worst case
        if (ts >= 5 && Math.abs(ts * 10 - Math.round(ts * 10)) < 1e-9 && Math.round(ts) === ts && Math.round(ts) % 2 === 1) {
          obs.recordTrigger(trig(ts));
        }
      },
    });
    expect(seen.length).toBeLessThanOrEqual(baseline);
    expect(obs.triggerFireCount()).toBeGreaterThan(0);
    expect(obs.cadenceFireCount() + obs.triggerFireCount()).toBe(obs.decideCalls());
    // every anchored window carries its trigger record
    for (const p of seen) {
      if (p.trigger) expect(typeof p.trigger.thresholdId).toBe("string");
    }
  });

  it("realistic sparse triggers: every onset is analyzed within 1.5 s (anchored or covered)", async () => {
    const { obs, seen } = captureDecides();
    const onsets = [10.5, 30.5, 50.5];
    await runStream(obs, 60, {
      onFrame: (ts) => {
        for (const onset of onsets) {
          if (Math.abs(ts - onset) < 1e-6) obs.recordTrigger(trig(onset));
        }
      },
    });
    // AC2 on both scheduling paths: an anchored window fires at onset+lead, and
    // a trigger a cadence window already covered was analyzed by that tick.
    for (const onset of onsets) {
      const analyzed = seen.filter((p) => p.centerTs >= onset && p.centerTs <= onset + 1.5);
      expect(analyzed.length).toBeGreaterThanOrEqual(1);
    }
    const anchored = seen.filter((p) => p.trigger);
    expect(anchored.length).toBeGreaterThan(0);
    for (const p of anchored) {
      expect(p.centerTs - p.trigger.onsetTs).toBeGreaterThanOrEqual(AUDIO_TRIGGER_LEAD_S - 1e-9);
      expect(p.centerTs - p.trigger.onsetTs).toBeLessThanOrEqual(1.5);
    }
    // one analysis per distinct trigger: no onset produced two anchored windows
    const onsetCounts = new Map<number, number>();
    for (const p of anchored) onsetCounts.set(p.trigger.onsetTs, (onsetCounts.get(p.trigger.onsetTs) ?? 0) + 1);
    for (const n of onsetCounts.values()) expect(n).toBe(1);
  });

  it("an invalid/broken trigger record never throws and never schedules", async () => {
    const { obs, seen } = captureDecides();
    let injected = false;
    await runStream(obs, 12, {
      onFrame: (ts) => {
        if (!injected && ts >= 4) {
          injected = true;
          expect(() => obs.recordTrigger(null)).not.toThrow();
          expect(obs.recordTrigger({ ...trig(4), onsetTs: Number.NaN })).toBe(false);
          expect(obs.recordTrigger({ ...trig(4), onsetLatencyS: 100 })).toBe(false);
        }
      },
    });
    expect(seen.every((p) => !p.trigger)).toBe(true);
  });

  it("the Tier-2 signal gate never skips a trigger-anchored window", async () => {
    const seen: any[] = [];
    const obs = new LiveObserver({
      cadenceS: OBSERVE_CADENCE_S,
      windowS: 10,
      maxFrames: 30,
      fps: 10,
      signalGate: true,
      onDecide: async (p) => {
        seen.push(p);
        return false;
      },
    });
    let injected = false;
    await runStream(obs, 20, {
      onFrame: (ts) => {
        if (!injected && ts >= 5) {
          injected = true;
          obs.recordTrigger(trig(5));
        }
      },
    });
    // no perceive signal is present in this stream, so cadence ticks are gated
    // off — but the audio trigger window still fires.
    expect(seen.filter((p) => p.trigger)).toHaveLength(1);
    expect(obs.gatedSkipCount()).toBeGreaterThan(0);
  });

  it("buildObservePayload carries the trigger only when anchored", () => {
    const win = { centerTs: 5, frames: [{ ts: 5, imageB64: "x" }], capped: false, droppedCount: 0 };
    const plain = buildObservePayload(win, new Map());
    expect(plain.trigger).toBeUndefined();
    const anchored = buildObservePayload(win, new Map(), [], trig(4));
    expect(anchored.trigger?.onsetTs).toBe(4);
  });
});

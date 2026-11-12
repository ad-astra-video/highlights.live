// ADAAAA-8807: a live share that stops supplying DECIDE frames must NAME the
// stall instead of deciding nothing for the rest of an `active` window.
//
// Measured on leg `3740585f` (one nominal 600 s browser share): 21 decides up to
// content t = 99.592 s, then ZERO for ~9 more minutes while the job stayed
// `active`, the transport stayed `connected` and audio kept arriving (the rail's
// audio tap reached 601.89 s). The record's only trace was
// `observeMetrics.perceive.analysedThroughTs === 99.592` frozen beside
// `liveWatchMinutes === 11.818` — a cost meter reading 11.8 min "watched" over a
// 1.7 min decide sample, with no line naming why.
//
// These tests pin the three lanes the watch must tell apart, the one-shot
// semantics (one line per stall, not one per tick), the recovery, and the
// persisted snapshot the job record carries.
import { describe, it, expect } from "vitest";
import { SupplyStallWatch, LIVE_SUPPLY_STALL_S } from "../src/live-supply-stall";
import { MediaRailObserver } from "../src/media-rail";

/** Simulated served clock (epoch ms). */
function clockAt(base = 1_700_000_000_000) {
  let now = base;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
      return now;
    },
    base,
  };
}

describe("SupplyStallWatch (ADAAAA-8807)", () => {
  it("stays silent while decide frames keep landing, and names nothing at the threshold", () => {
    const c = clockAt();
    const w = new SupplyStallWatch({ stallS: 10, now: c.now });
    w.start(c.now());
    for (let i = 0; i < 6; i++) {
      w.noteObservation(i, c.advance(5_000));
      expect(w.poll(c.now())).toBeNull();
    }
    w.noteObservation(6, c.advance(9_900));
    expect(w.poll(c.now())).toBeNull();
    expect(w.snapshot()).toBeNull();
  });

  it("names `no-video-supply` when audio keeps flowing and frames stop", () => {
    const c = clockAt();
    const w = new SupplyStallWatch({ stallS: 10, now: c.now });
    w.start(c.now());
    w.noteObservation(99.592, c.advance(1_000));
    w.noteAudio(120, c.advance(4_000));
    // Threshold not reached yet.
    expect(w.poll(c.advance(3_000))).toBeNull();
    const ev = w.poll(c.advance(4_000));
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("stalled");
    expect(ev!.reason).toBe("no-video-supply");
    expect(ev!.contentTs).toBe(99.592);
    expect(ev!.audioTs).toBe(120);
    // 11.0 s of frozen decide supply (from the last decide frame at served 1 s).
    expect(ev!.stallSeconds).toBe(11);
    expect(ev!.frames).toBe(0);
    // One line per stall: the next poll must not repeat it.
    expect(w.poll(c.advance(5_000))).toBeNull();
  });

  it("names `no-observation-supply` when the node keeps publishing frames but no observation lands", () => {
    const c = clockAt();
    const w = new SupplyStallWatch({ stallS: 10, now: c.now });
    w.start(c.now());
    w.noteObservation(5, c.advance(1_000));
    // Frames published (ticks) but the relay delivered nothing decidable.
    w.noteFrameTick(8, c.advance(5_000));
    w.noteFrameTick(12, c.advance(11_000));
    const ev = w.poll(c.advance(1_500));
    expect(ev?.type).toBe("stalled");
    expect(ev?.reason).toBe("no-observation-supply");
    expect(ev?.tickTs).toBe(12);
  });

  it("names `no-media-supply` when nothing at all is arriving", () => {
    const c = clockAt();
    const w = new SupplyStallWatch({ stallS: 10, now: c.now });
    w.start(c.now());
    w.noteObservation(5, c.advance(1_000));
    w.noteAudio(6, c.advance(1_000));
    // Audio has been silent for far longer than the attribution window.
    const ev = w.poll(c.advance(20_000));
    expect(ev?.type).toBe("stalled");
    expect(ev?.reason).toBe("no-media-supply");
  });

  it("reports a recovery once, keeps the stall on the snapshot, and counts a second stall", () => {
    const c = clockAt();
    const w = new SupplyStallWatch({ stallS: 10, now: c.now });
    w.start(c.now());
    w.noteObservation(10, c.advance(1_000));
    const first = w.poll(c.advance(12_000));
    expect(first?.type).toBe("stalled");
    expect(w.isStalled).toBe(true);
    // Same poll while still frozen.
    expect(w.poll(c.advance(1_000))).toBeNull();

    w.noteObservation(20, c.advance(1_000));
    const back = w.poll(c.now());
    expect(back?.type).toBe("recovered");
    expect(back?.contentTs).toBe(20);
    expect(w.isStalled).toBe(false);

    const snap = w.snapshot(c.now())!;
    expect(snap.active).toBe(false);
    expect(snap.recoveredAtContentTs).toBe(20);
    expect(snap.occurrences).toBe(1);
    expect(snap.reason).toBe("no-media-supply");
    expect(snap.longestStallSeconds).toBeGreaterThanOrEqual(12);

    // A second stall increments the count and re-arms the name (audio recent).
    w.noteAudio(30, c.advance(1_000));
    const second = w.poll(c.advance(9_000));
    expect(second?.type).toBe("stalled");
    expect(second?.reason).toBe("no-video-supply");
    expect(w.snapshot(c.now())!.occurrences).toBe(2);
    expect(w.snapshot(c.now())!.active).toBe(true);
  });

  it("uses the documented default threshold", () => {
    const c = clockAt();
    const w = new SupplyStallWatch({ now: c.now });
    expect(w.stallS).toBe(LIVE_SUPPLY_STALL_S);
    w.start(c.now());
    w.noteObservation(1, c.advance(1_000));
    expect(w.poll(c.advance((LIVE_SUPPLY_STALL_S - 1) * 1_000))).toBeNull();
    expect(w.poll(c.advance(1_100))?.type).toBe("stalled");
  });
});

describe("media rail supply stall is named on the share (ADAAAA-8807)", () => {
  /** A rail on a simulated served clock; `poll` is driven by hand so the
   *  boundary needs no sleeping (`supplyStallPollMs: 0` disables the timer). */
  function railOnClock(stallS: number) {
    const c = clockAt();
    const rail = new MediaRailObserver({
      jobId: "job-8807",
      fps: 3,
      windowS: 7,
      cadenceS: 5,
      maxFrames: 4,
      supplyStallS: stallS,
      supplyStallPollMs: 0,
      wallClock: c.now,
      onDecide: async () => false,
    });
    return { rail, c };
  }

  it("never publishes a stall block on a healthy share", () => {
    const { rail, c } = railOnClock(10);
    const T0 = c.base / 1000;
    for (let i = 0; i < 8; i++) {
      rail.onObservation(
        { timestamp: T0 + i / 3, tracks: [], objects: [], ocr: [] } as any,
        Buffer.from(`jpeg-8807-${i}`).toString("base64")
      );
      c.advance(2_000);
      expect(rail.pollSupplyStall()).toEqual([]);
    }
    expect(rail.observeMetrics().supplyStall).toBeUndefined();
  });

  it("names the frozen video lane and persists it beside the serve clock", () => {
    const { rail, c } = railOnClock(10);
    const T0 = c.base / 1000;
    // Leg `3740585f` shape: content stops at 99.592 s of a 600 s share while
    // audio keeps arriving.
    for (let i = 0; i < 3; i++) {
      rail.onObservation(
        { timestamp: T0 + i, tracks: [], objects: [], ocr: [] } as any,
        Buffer.from(`jpeg-8807-v${i}`).toString("base64")
      );
      c.advance(1_000);
    }
    c.advance(60_000);
    rail.onAudioChunk(T0 + 45, Buffer.alloc(1600 * 2).toString("base64"));
    c.advance(1_000);

    const [ev] = rail.pollSupplyStall();
    expect(ev?.type).toBe("stalled");
    expect(ev?.reason).toBe("no-video-supply");
    expect(ev?.contentTs).toBeCloseTo(2, 3);
    expect(ev?.frames).toBe(3);

    const stall = rail.observeMetrics().supplyStall!;
    expect(stall.reason).toBe("no-video-supply");
    expect(stall.active).toBe(true);
    expect(stall.occurrences).toBe(1);
    expect(stall.contentTs).toBeCloseTo(2, 3);
    // The persisted block is the ONE the record carries: a share that stalled
    // can no longer read as a healthy share whose decide sample simply ended.
    expect(stall.wallS).toBeGreaterThanOrEqual(60);
  });

  it("is fully disabled by supplyStallS <= 0 (the pre-change silence)", () => {
    const { rail, c } = railOnClock(0);
    const T0 = c.base / 1000;
    rail.onObservation(
      { timestamp: T0, tracks: [], objects: [], ocr: [] } as any,
      Buffer.from("jpeg-8807-off").toString("base64")
    );
    c.advance(600_000);
    expect(rail.pollSupplyStall()).toEqual([]);
    expect(rail.observeMetrics().supplyStall).toBeUndefined();
  });
});

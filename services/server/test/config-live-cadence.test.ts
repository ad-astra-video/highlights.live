// ADAAAA-7808: docker-compose maps the optional live knobs as `${X:-}`, so a
// knob that is absent from `docker/.env` still reaches the container as an EMPTY
// string. `Number("")` is 0, and 0 is not nullish, so it beat the CEO-locked 3 s
// cadence in `analyzer.ts` (`cfg.liveObserveCadenceS ?? cfg.observeCadenceS`) and
// the live pass fired on every consumed frame: measured 601 decide opportunities
// / 110 decides per 300 s at 2 streams instead of 101 / 68 — ~6x the funded rate.
// Only a positive finite value may ever act as a hop.
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config";
import { assembleObserveWindow } from "../src/observe-loop";

describe("loadConfig — live observe cadence hop (ADAAAA-7808)", () => {
  it("treats an empty value as unset, so the 3 s cadence stands", () => {
    expect(loadConfig({ LIVE_OBSERVE_CADENCE_S: "" }).liveObserveCadenceS).toBeUndefined();
    expect(loadConfig({}).liveObserveCadenceS).toBeUndefined();
  });

  it("treats zero and garbage as unset", () => {
    expect(loadConfig({ LIVE_OBSERVE_CADENCE_S: "0" }).liveObserveCadenceS).toBeUndefined();
    expect(loadConfig({ LIVE_OBSERVE_CADENCE_S: "-5" }).liveObserveCadenceS).toBeUndefined();
    expect(loadConfig({ LIVE_OBSERVE_CADENCE_S: "not-a-number" }).liveObserveCadenceS).toBeUndefined();
  });

  it("still accepts a real hop", () => {
    expect(loadConfig({ LIVE_OBSERVE_CADENCE_S: "5" }).liveObserveCadenceS).toBe(5);
  });
});

// ADAAAA-8004 (CEO question on the live rail's decide cadence): reducing the
// decide OVERLAP moves the HOP only. The window span (~10 s) and therefore the
// frames one decide sees are a function of `windowS` x the decode fps alone, so
// a 5 s hop (the lever-C CEO row, ADAAAA-7799) changes how OFTEN a window is
// judged, never the payload size — it is a decide-RATE knob, not a
// cost-per-decide knob. Pinned here because the tempting "cheaper overlap"
// implementation is to shrink the window, which silently trades precision and
// instead of cadence (AC5 of ADAAAA-8004).
describe("live decide hop — overlap changes cadence only (ADAAAA-8004)", () => {
  const DECODE_FPS = 3; // funded decode on the live rail (measured 2.85 fps)
  const WINDOW_S = 10; // LIVE_OBSERVE_WINDOW_S
  const MAX_FRAMES = 30; // LIVE_OBSERVE_MAX_FRAMES
  const DURATION_S = 300; // the AC1/AC4 measurement window

  const frames = Array.from({ length: DURATION_S * DECODE_FPS }, (_, i) => ({
    ts: i / DECODE_FPS,
    imageB64: "x",
    seq: i,
  }));
  const centersFor = (hop: number): number[] => {
    const out: number[] = [];
    for (let c = WINDOW_S / 2; c <= DURATION_S - WINDOW_S / 2 + 1e-9; c += hop) out.push(c);
    return out;
  };

  it("keeps the window span and the frames/decide payload fixed across hops", () => {
    for (const hop of [3, 5, 8]) {
      const centers = centersFor(hop);
      for (const c of centers) {
        const win = assembleObserveWindow(frames, c, { windowS: WINDOW_S, maxFrames: MAX_FRAMES, fps: DECODE_FPS });
        // The frames one decide carries: a function of the window, not the hop.
        expect(win.frames.length).toBe(MAX_FRAMES);
        const span = win.frames[win.frames.length - 1].ts - win.frames[0].ts;
        // and the span never exceeds the ~10 s window (AC5: the window is fixed)
        expect(span).toBeLessThanOrEqual(WINDOW_S + 1e-9);
      }
    }
  });

  it("changes only how many decides are requested per 300 s", () => {
    // hop -> decide opportunities over 300 s at the funded 3 fps decode.
    expect(centersFor(3).length).toBe(97);
    expect(centersFor(5).length).toBe(59);
    expect(centersFor(8).length).toBe(37);
    // And the overlap each hop leaves (window span unchanged).
    expect([WINDOW_S - 3, WINDOW_S - 5, WINDOW_S - 8]).toEqual([7, 5, 2]);
  });
});

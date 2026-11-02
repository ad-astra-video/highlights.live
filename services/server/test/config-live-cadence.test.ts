// ADAAAA-7808: docker-compose maps the optional live knobs as `${X:-}`, so a
// knob that is absent from `docker/.env` still reaches the container as an EMPTY
// string. `Number("")` is 0, and 0 is not nullish, so it beat the CEO-locked 3 s
// cadence in `analyzer.ts` (`cfg.liveObserveCadenceS ?? cfg.observeCadenceS`) and
// the live pass fired on every consumed frame: measured 601 decide opportunities
// / 110 decides per 300 s at 2 streams instead of 101 / 68 — ~6x the funded rate.
// Only a positive finite value may ever act as a hop.
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config";

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

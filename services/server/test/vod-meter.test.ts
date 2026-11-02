import { describe, expect, it } from "vitest";
import { buildVodMeter, formatVodMeterLine } from "../src/vod-meter";

// ADAAAA-7821: the VOD meter must turn the recorded spend into a
// per-video-hour figure that matches the ratified price model's units
// ($ per SOURCE hour), and must not invent a runtime when the probe failed.
describe("buildVodMeter", () => {
  it("normalises the recorded spend to one source hour", () => {
    // 90 s source, 68 decides at $0.0033 + 309.1 s perceive at $0.01/h
    // = 0.2244 + 0.0008586 = 0.2252586 -> 0.2253 recorded.
    const m = buildVodMeter({
      wallClockS: 331.42,
      decideCalls: 68,
      sourceDurationS: 90.012,
      costUsd: 0.2253,
      decideFeeUsd: 0.0033,
    });
    expect(m.wallClockS).toBe(331.4);
    expect(m.decideCalls).toBe(68);
    expect(m.sourceDurationS).toBe(90.0);
    expect(m.costUsd).toBe(0.2253);
    expect(m.decideFeeUsd).toBe(0.0033);
    // 0.2253 / (90.012/3600) = 9.0108 $/video-hour
    expect(m.perVideoHourCostUsd).toBe(9.0108);
    // 331.42 / 90.012 = 3.682x real time
    expect(m.rtf).toBe(3.682);
  });

  it("keeps dollar-per-video-hour linear in decide count", () => {
    const base = { wallClockS: 60, sourceDurationS: 3600, costUsd: 0, decideFeeUsd: 0.0033 };
    const a = buildVodMeter({ ...base, decideCalls: 10 });
    const b = buildVodMeter({ ...base, decideCalls: 20 });
    expect(a.perVideoHourCostUsd).toBe(0);
    expect(b.perVideoHourCostUsd).toBe(0);
    const withCost = (n: number) => buildVodMeter({ ...base, decideCalls: n, costUsd: n * 0.0033 });
    // A one-hour source normalises 1:1, so $/video-hour === costUsd.
    expect(withCost(10).perVideoHourCostUsd).toBe(0.033);
    expect(withCost(20).perVideoHourCostUsd).toBe(0.066);
    // A half-hour source doubles the per-hour figure.
    const half = buildVodMeter({ ...base, sourceDurationS: 1800, decideCalls: 10, costUsd: 0.033 });
    expect(half.perVideoHourCostUsd).toBe(0.066);
  });

  it("returns null runtime-derived fields when the probe failed", () => {
    const m = buildVodMeter({
      wallClockS: 12.5,
      decideCalls: 3,
      sourceDurationS: null,
      costUsd: 0.0099,
      decideFeeUsd: 0.0033,
    });
    expect(m.sourceDurationS).toBeNull();
    expect(m.perVideoHourCostUsd).toBeNull();
    expect(m.rtf).toBeNull();
    // The measured (non-derived) values still survive.
    expect(m.wallClockS).toBe(12.5);
    expect(m.decideCalls).toBe(3);
    expect(m.costUsd).toBe(0.0099);
  });

  it("treats a zero or non-finite runtime as unmeasured", () => {
    for (const d of [0, -5, Number.NaN]) {
      const m = buildVodMeter({
        wallClockS: 5,
        decideCalls: 1,
        sourceDurationS: d as number,
        costUsd: 0.01,
        decideFeeUsd: 0.0033,
      });
      expect(m.sourceDurationS).toBeNull();
      expect(m.perVideoHourCostUsd).toBeNull();
    }
  });
});

describe("formatVodMeterLine", () => {
  it("emits the fixed [vod-meter] prefix with every measured field", () => {
    const line = formatVodMeterLine(
      "917bc0e3-066b-4f76-ada2-3791be0c2e13",
      buildVodMeter({
        wallClockS: 331.42,
        decideCalls: 68,
        sourceDurationS: 90.012,
        costUsd: 0.2253,
        decideFeeUsd: 0.0033,
      })
    );
    expect(line.startsWith("[vod-meter] job=917bc0e3-066b-4f76-ada2-3791be0c2e13 ")).toBe(true);
    expect(line).toContain("wallClockS=331.4");
    expect(line).toContain("decideCalls=68");
    expect(line).toContain("sourceDurationS=90.0");
    expect(line).toContain("costUsd=0.2253");
    expect(line).toContain("perVideoHourCostUsd=9.0108");
  });

  it("prints n/a (never a fabricated number) for an unprobed runtime", () => {
    const line = formatVodMeterLine(
      "job-1",
      buildVodMeter({ wallClockS: 5, decideCalls: 1, sourceDurationS: null, costUsd: 0.01, decideFeeUsd: 0.0033 })
    );
    expect(line).toContain("sourceDurationS=n/a");
    expect(line).toContain("perVideoHourCostUsd=n/a");
  });
});

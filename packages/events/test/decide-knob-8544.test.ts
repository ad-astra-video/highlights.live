// ADAAAA-8544 (spec rev 3 §3/§6, parent ADAAAA-8527): the SHIPPED `est-v2`
// estimate must reproduce the graded rows and the resolved table, so AC3 is
// asserted on the same function the board prints from and QA grades.
//
// The 3 s rows are measured (jobs b55c5781 $2.893/h and 50b7aed6 $3.399/h); the
// 5 s rows are the documented EXTRAPOLATION (`grown(5 s)`), which is exactly why
// the estimate ships with a band and why the default is only ever printed as
// point + band.
import { describe, it, expect } from "vitest";
import {
  DECIDE_ESTIMATE_VERSION,
  DECIDE_RATE_FLOOR_PER_300S,
  DECIDE_USD_PER_DECIDE,
  DecideKnobStampSchema,
  decideBandPer300s,
  decideCadenceLabel,
  decideEstimateLabel,
  decideOpportunitiesPer300s,
  decideRailForSource,
  estimateDecideUsdPerHour,
  resolveDecideKnob,
  validateDecideKnobInput,
} from "../src/index";

const cents = (usd: number) => Number(usd.toFixed(2));
/** decides / 300 s -> $/h on the content clock (12 five-minute blocks/h). */
const usdFor = (decidesPer300s: number) => decidesPer300s * DECIDE_USD_PER_DECIDE * 12;

describe("est-v2 (ADAAAA-8544 AC3): the shipped estimate reproduces the resolved table", () => {
  it("prices the DEFAULT posture (browser, 5 s, uncapped) at exactly $2.01/h with the measured band", () => {
    const est = estimateDecideUsdPerHour({ cadenceSec: 5, rateCapPer300s: null, rail: "browser" });
    // AC3 grades the shipped default as $2.01/h. The density is spec rev 3 §3's
    // own printed row (50.3 decides / 300 s = the midpoint of the scaled measured
    // band), not the 50.05 product `78.2 x 0.64`, which would print $2.00.
    expect(cents(est.usdPerHour)).toBe(2.01);
    expect(est.usdPerHour).toBeCloseTo(2.0114, 3);
    expect(est.bandUsdPerHour.map(cents)).toEqual([1.86, 2.16]);
    expect(est.opportunitiesPer300s).toBe(50.3);
    expect(est.estimateVersion).toBe(DECIDE_ESTIMATE_VERSION);
  });

  it("prices the 104-window rail at 5 s and both 3 s postures exactly as the table does", () => {
    const a5 = estimateDecideUsdPerHour({ cadenceSec: 5, rateCapPer300s: null, rail: "analyzer" });
    expect(cents(a5.usdPerHour)).toBe(2.5);
    expect(a5.opportunitiesPer300s).toBeCloseTo(62.4, 6);

    const b3 = estimateDecideUsdPerHour({ cadenceSec: 3, rateCapPer300s: null, rail: "browser" });
    expect(cents(b3.usdPerHour)).toBe(3.13);
    expect(b3.bandUsdPerHour.map(cents)).toEqual([2.91, 3.38]);

    const a3 = estimateDecideUsdPerHour({ cadenceSec: 3, rateCapPer300s: null, rail: "analyzer" });
    expect(cents(a3.usdPerHour)).toBe(4.16);
    expect(a3.opportunitiesPer300s).toBe(104);
  });

  it("reproduces both GRADED rows within +/-10 % (AC3's real grade)", () => {
    // Graded content-clock rates from the two closed tickets: `cost charged /
    // content seconds`, the ADAAAA-8269 accounting — not costUsd/watchMinutes.
    const graded = [
      { job: "b55c5781", usdPerHour: 2.893 },
      { job: "50b7aed6", usdPerHour: 3.399 },
    ];
    const est = estimateDecideUsdPerHour({ cadenceSec: 3, rateCapPer300s: null, rail: "browser" });
    for (const row of graded) {
      const err = (est.usdPerHour - row.usdPerHour) / row.usdPerHour;
      expect(Math.abs(err), `${row.job} error ${(err * 100).toFixed(1)}%`).toBeLessThanOrEqual(0.1);
    }
    // …and the direction is the one the spec documents (+8.1 % / -8.0 %): the
    // centre of the band is calibrated, not fitted to either sample.
    expect(cents(est.usdPerHour)).toBe(3.13);
  });

  it("prices a CAP at min(cap, N) and never above the rail's density", () => {
    for (const cap of [63, 66, 69]) {
      const est = estimateDecideUsdPerHour({ cadenceSec: 3, rateCapPer300s: cap, rail: "browser" });
      expect(est.chargedDecidesPer300s).toBe(cap);
      expect(cents(est.usdPerHour)).toBe(cents(usdFor(cap)));
      // A cap is a single number on every rail: no band to print.
      expect(est.bandUsdPerHour.map(cents)).toEqual([cents(usdFor(cap)), cents(usdFor(cap))]);
    }
    // A cap above the rail's density bills the density, never the cap.
    const generous = estimateDecideUsdPerHour({ cadenceSec: 5, rateCapPer300s: 999, rail: "analyzer" });
    expect(generous.chargedDecidesPer300s).toBeCloseTo(62.4, 6);
    expect(cents(generous.usdPerHour)).toBe(2.5);
  });

  it("scales the browser band by the cadence growth, not by a plain 3/5 ratio", () => {
    expect(decideBandPer300s("browser", 5)).toEqual([
      72.76 * 0.64,
      84.51 * 0.64,
    ]);
    expect(decideBandPer300s("analyzer", 5)).toEqual([
      decideOpportunitiesPer300s("analyzer", 5),
      decideOpportunitiesPer300s("analyzer", 5),
    ]);
    // The analyzer rail's cadence IS the limiter, so 3 s -> 5 s is exactly 3/5.
    expect(decideOpportunitiesPer300s("analyzer", 5)).toBeCloseTo(104 * 0.6, 6);
  });
});

describe("the 63-decide coverage floor (ADAAAA-8544 AC4)", () => {
  it("rejects 62 with the 422 code and accepts 63", () => {
    const rejected = validateDecideKnobInput({ rateCapPer300s: 62 });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("decide_rate_below_coverage_floor");
    const accepted = validateDecideKnobInput({ rateCapPer300s: 63 });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.rateCapPer300s).toBe(63);
    expect(DECIDE_RATE_FLOOR_PER_300S).toBe(63);
  });

  it("treats absent/null as uncapped and rejects a wrong cadence rather than coercing it", () => {
    expect(validateDecideKnobInput({})).toEqual({ ok: true, cadenceSec: 5, rateCapPer300s: null });
    expect(validateDecideKnobInput({ rateCapPer300s: null })).toEqual({
      ok: true,
      cadenceSec: 5,
      rateCapPer300s: null,
    });
    expect(validateDecideKnobInput({ cadenceSec: 3, rateCapPer300s: null })).toEqual({
      ok: true,
      cadenceSec: 3,
      rateCapPer300s: null,
    });
    const badCadence = validateDecideKnobInput({ cadenceSec: 4 });
    expect(badCadence.ok).toBe(false);
    if (!badCadence.ok) expect(badCadence.code).toBe("decide_cadence_invalid");
    const badRate = validateDecideKnobInput({ rateCapPer300s: 63.5 });
    expect(badRate.ok).toBe(false);
    if (!badRate.ok) expect(badRate.code).toBe("decide_rate_invalid");
  });
});

describe("resolveDecideKnob (ADAAAA-8544 AC1): the stamp is frozen with its provenance", () => {
  it("the shipped default is economy: cadence 5, uncapped, browser rail", () => {
    const stamp = resolveDecideKnob({ rail: "browser" });
    expect(stamp.cadenceSec).toBe(5);
    expect(stamp.rateCapPer300s).toBeNull();
    expect(stamp.resolvedSource).toBe("default");
    expect(stamp.opportunitiesPer300s).toBe(50.3);
    expect(stamp.usdPerDecide).toBe(DECIDE_USD_PER_DECIDE);
    expect(cents(stamp.predictedUsdPerHour)).toBe(2.01);
    expect(stamp.predictedBandUsdPerHour.map(cents)).toEqual([1.86, 2.16]);
    expect(stamp.estimateVersion).toBe("est-v2");
    // The stamp round-trips through the persisted contract — an unparseable
    // stamp would be stripped by `JobSchema.parse` on write.
    expect(DecideKnobStampSchema.parse(stamp)).toEqual(stamp);
  });

  it("records a user's posture as user, and the env posture as env", () => {
    const user = resolveDecideKnob({ cadenceSec: 3, rateCapPer300s: 63, rail: "analyzer" });
    expect(user.resolvedSource).toBe("user");
    expect(user.cadenceSec).toBe(3);
    expect(user.rateCapPer300s).toBe(63);

    const halfUser = resolveDecideKnob({ cadenceSec: 3, rail: "browser" });
    expect(halfUser.resolvedSource).toBe("user");
    expect(halfUser.rateCapPer300s).toBeNull();

    // A job started before the knob existed: the deploy-time fraction is what the
    // observer will run, and a grader must not read the null cap as "the user
    // asked for uncapped".
    const env = resolveDecideKnob({
      rail: "analyzer",
      legacyEnvPosture: true,
      envDecideKeepRatio: 0.64,
      envRateCapPer300s: 64,
    });
    expect(env.resolvedSource).toBe("env");
    expect(env.rateCapPer300s).toBe(64);
  });

  it("routes the source to the right rail (a browser stream is not quoted 104)", () => {
    expect(decideRailForSource("browser")).toBe("browser");
    expect(decideRailForSource("screen")).toBe("browser");
    // The app's client-side capture id: it POSTs `source: "browser"`, so the
    // control must quote the browser rail for it too.
    expect(decideRailForSource("screenshare")).toBe("browser");
    expect(decideRailForSource("rtmp")).toBe("analyzer");
    expect(decideRailForSource("file-sim")).toBe("analyzer");
    expect(decideRailForSource("file")).toBe("analyzer");
    expect(
      resolveDecideKnob({ rail: decideRailForSource("browser"), cadenceSec: 3 }).opportunitiesPer300s
    ).toBeCloseTo(78.2, 6);
  });
});

describe("the control copy (ADAAAA-8544 item 7)", () => {
  it("carries the 5 s latency trade in the option's own label", () => {
    const label = decideCadenceLabel(5);
    expect(label).toContain("up to 5 s to flag");
    expect(label).toContain("top of the 1-5 s budget");
    // 3 s stays inside the budget and says so.
    const three = decideCadenceLabel(3);
    expect(three).toContain("3 s");
    expect(three).toContain("1-5 s latency budget");
    expect(three).not.toContain("up to 5 s to flag");
  });

  it("prints a point BESIDE its measured band, never a bare point", () => {
    const label = decideEstimateLabel({ cadenceSec: 3, rateCapPer300s: null, rail: "browser" });
    expect(label).toContain("approx $3.13/h");
    expect(label).toContain("measured band");
    expect(label).toContain("$2.91/h-$3.38/h");
    const economy = decideEstimateLabel({ cadenceSec: 5, rateCapPer300s: null, rail: "browser" });
    expect(economy).toContain("approx $2.01/h");
    expect(economy).toContain("$1.86/h-$2.16/h");
  });
});

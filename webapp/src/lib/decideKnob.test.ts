// ADAAAA-8544 item 7 (spec rev 3 §1/§3/§7): the LIVE start control's pure parts.
//
// The page keeps only markup + setState; everything that can be WRONG about the
// knob (the request body, the floor refusal, the printed estimate, the option
// labels) is a pure function here, asserted against the same `@highlights/events`
// contract the server validates and the window audit grades. A control that
// retyped $2.01 or 63 could drift from the stamped record silently — that is what
// this file prevents.
import { describe, expect, it } from "vitest";
import {
  DECIDE_KNOB_UNCAPPED_LABEL,
  buildDecideKnobSubmission,
  decideKnobCadenceOptions,
  decideKnobEstimateLabel,
  decideKnobReadout,
  decideKnobRequestBody,
  isDecideKnobLiveSource,
  parseRateCapInput,
} from "./decideKnob";

describe("isDecideKnobLiveSource", () => {
  it("gives the knob to every LIVE rail and no VOD upload", () => {
    for (const source of ["screenshare", "browser", "rtmp", "webrtc", "file-sim"]) {
      expect(isDecideKnobLiveSource(source), source).toBe(true);
    }
    // A VOD upload runs the offline pipeline: no decide throttle, no price tag.
    expect(isDecideKnobLiveSource("file")).toBe(false);
    expect(isDecideKnobLiveSource(undefined)).toBe(false);
    expect(isDecideKnobLiveSource(null)).toBe(false);
  });
});

describe("parseRateCapInput — the 63 floor is refused before the job starts", () => {
  it("blank is Uncapped (the shipped default, rateCapPer300s null)", () => {
    expect(parseRateCapInput("")).toEqual({ ok: true, rateCapPer300s: null });
    expect(parseRateCapInput("   ")).toEqual({ ok: true, rateCapPer300s: null });
    expect(parseRateCapInput(null)).toEqual({ ok: true, rateCapPer300s: null });
  });

  it("62 is refused and 63 is accepted (AC4's boundary, client side)", () => {
    const below = parseRateCapInput("62");
    expect(below.ok).toBe(false);
    if (below.ok) throw new Error("unreachable");
    expect(below.error).toContain("63");
    expect(below.error).toContain("coverage floor");
    // The refusal names the same floor the server's 422 states, so a user who
    // types 62 is told the rule rather than shown a generic failure.
    expect(below.error).toContain("ADAAAA-8427");

    expect(parseRateCapInput("63")).toEqual({ ok: true, rateCapPer300s: 63 });
    expect(parseRateCapInput(" 66 ")).toEqual({ ok: true, rateCapPer300s: 66 });
  });

  it("refuses a non-whole, zero or negative cap instead of coercing it", () => {
    for (const raw of ["6.5", "abc", "0", "-1", "1e3"]) {
      const parsed = parseRateCapInput(raw);
      expect(parsed.ok, raw).toBe(false);
    }
  });
});

describe("buildDecideKnobSubmission / decideKnobRequestBody", () => {
  it("defaults to the CEO posture: 5 s cadence, uncapped", () => {
    expect(buildDecideKnobSubmission({ source: "screenshare", cadenceSec: 5, rateCapInput: "" })).toEqual({
      cadenceSec: 5,
      rateCapPer300s: null,
    });
    // Absent/garbage cadence resolves to the shipped default, never a third posture.
    expect(buildDecideKnobSubmission({ source: "rtmp", cadenceSec: NaN, rateCapInput: "" })).toEqual({
      cadenceSec: 5,
      rateCapPer300s: null,
    });
  });

  it("keeps 3 s user-selectable and carries a valid cap through", () => {
    expect(buildDecideKnobSubmission({ source: "rtmp", cadenceSec: 3, rateCapInput: "66" })).toEqual({
      cadenceSec: 3,
      rateCapPer300s: 66,
    });
  });

  it("sends nothing for a VOD upload or a refused cap", () => {
    const ok = buildDecideKnobSubmission({ source: "file", cadenceSec: 5, rateCapInput: "" });
    expect(decideKnobRequestBody({ source: "file", submission: ok })).toEqual({});
    const refused = buildDecideKnobSubmission({ source: "browser", cadenceSec: 5, rateCapInput: "62" });
    expect(decideKnobRequestBody({ source: "browser", submission: refused })).toEqual({});
  });

  it("merges exactly the two knob fields into POST /jobs", () => {
    const submission = buildDecideKnobSubmission({ source: "browser", cadenceSec: 5, rateCapInput: "70" });
    const body = decideKnobRequestBody({ source: "browser", submission });
    expect(body).toEqual({ cadenceSec: 5, rateCapPer300s: 70 });
    // Nothing else: AC2 says the knob resolves exactly the cadence and the cap.
    expect(Object.keys(body).sort()).toEqual(["cadenceSec", "rateCapPer300s"]);
  });
});

describe("the estimate line (AC3: point BESIDE the measured band)", () => {
  it("prints the shipped default at $2.01/h with the band $1.86-$2.16", () => {
    const label = decideKnobEstimateLabel({ source: "screenshare", cadenceSec: 5, rateCapInput: "" });
    expect(label).toContain("approx $2.01/h");
    expect(label).toContain("measured band $1.86/h-$2.16/h");
  });

  it("uses the rail the user is on, not the 104-window cell for everything", () => {
    // A browser stream at 3 s is $3.13/h; the RTMP/file rail at 3 s is $4.16/h.
    expect(decideKnobEstimateLabel({ source: "browser", cadenceSec: 3, rateCapInput: "" })).toContain(
      "approx $3.13/h"
    );
    expect(decideKnobEstimateLabel({ source: "rtmp", cadenceSec: 3, rateCapInput: "" })).toContain(
      "approx $4.16/h"
    );
    expect(decideKnobEstimateLabel({ source: "rtmp", cadenceSec: 5, rateCapInput: "" })).toContain(
      "approx $2.50/h"
    );
  });

  it("prices a cap at min(cap, density) and never prints a refused posture", () => {
    expect(decideKnobEstimateLabel({ source: "browser", cadenceSec: 3, rateCapInput: "63" })).toContain(
      "approx $2.52/h"
    );
    // A refused cap is priced as uncapped — the control shows the error, not a
    // price for a posture the job cannot run in.
    expect(decideKnobEstimateLabel({ source: "browser", cadenceSec: 5, rateCapInput: "62" })).toContain(
      "approx $2.01/h"
    );
  });
});

describe("the cadence picker copy", () => {
  it("offers 3 s and 5 s, and the 5 s label carries the latency trade itself", () => {
    const options = decideKnobCadenceOptions();
    expect(options.map((o) => o.cadenceSec)).toEqual([3, 5]);
    const five = options.find((o) => o.cadenceSec === 5)!.label;
    // Not a tooltip: the trade is IN the option label (spec §1/§9).
    expect(five).toContain("up to 5 s to flag");
    expect(five).toContain("top of the 1-5 s budget");
    const three = options.find((o) => o.cadenceSec === 3)!.label;
    expect(three).toContain("within the 1-5 s latency budget");
    expect(three).not.toContain("up to 5 s to flag");
  });
});

describe("decideKnobReadout — the monitor side reads the FROZEN stamp", () => {
  it("states the posture the job actually runs", () => {
    expect(
      decideKnobReadout({
        cadenceSec: 5,
        rateCapPer300s: null,
        predictedUsdPerHour: 2.0114,
        predictedBandUsdPerHour: [1.8621, 2.1629],
        estimateVersion: "est-v2",
        resolvedSource: "default",
      })
    ).toBe(
      `5 s cadence · ${DECIDE_KNOB_UNCAPPED_LABEL.toLowerCase()} · approx $2.01/h (measured band $1.86/h-$2.16/h) · est-v2`
    );
  });

  it("names a cap and marks a pre-knob row as the deploy-time default", () => {
    const line = decideKnobReadout({
      cadenceSec: 3,
      rateCapPer300s: 63,
      predictedUsdPerHour: 2.52,
      predictedBandUsdPerHour: [2.52, 2.52],
      estimateVersion: "est-v2",
      resolvedSource: "env",
    });
    expect(line).toContain("cap 63 decides / 5 min");
    expect(line).toContain("approx $2.52/h");
    expect(line).toContain("deploy-time default");
  });
});

// ADAAAA-8425: the admin window audit readout must show the five causes side
// by side + decideCalls/supply + the effective/funded ceiling, and must render
// nothing when the record carries no stored split (never fabricated zeros).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import React from "react";
import { WindowAuditPanel } from "./WindowAudit";
import { auditRenderable, capacityPair, type WindowAuditPayload } from "../lib/windowAudit";

const AUDIT: WindowAuditPayload = {
  jobId: "job-2stream-8425",
  status: "done",
  source: "rtmp",
  stored: true,
  causes: [
    { field: "skippedStaleWindows", cause: "stale", label: "Stale (past lag budget)", count: 0 },
    { field: "backpressureSkippedWindows", cause: "backpressure", label: "Backpressure (in-flight slots busy)", count: 11 },
    { field: "admissionSkippedWindows", cause: "admission", label: "Admission (other live job held the slot)", count: 0 },
    { field: "throttleSkippedWindows", cause: "throttle", label: "Throttle (funded rate cap)", count: 4 },
    { field: "capacityDroppedWindows", cause: "capacityDrop", label: "Capacity drop (runner refused)", count: 2 },
  ],
  decideCalls: 96,
  decideCallsCompleted: 94,
  supplySkippedWindows: 11,
  skippedWindows: 17,
  accountedWindows: 111,
  decideCapacity: { advertised: 6, funded: 8, effective: 6, probeOk: true, runners: 3, source: "probe", cap: 32 },
};

function render(audit: WindowAuditPayload): string {
  return renderToStaticMarkup(React.createElement(WindowAuditPanel, { audit }));
}

describe("WindowAuditPanel (ADAAAA-8425 AC2/AC3)", () => {
  it("renders the five causes with their exact counts", () => {
    const html = render(AUDIT);
    expect(html).toContain("data-window-audit");
    for (const c of AUDIT.causes) {
      expect(html).toContain(`data-window-audit-cause="${c.cause}"`);
      expect(html).toContain(`data-count="${c.count}"`);
    }
    expect(html).toContain("Capacity drop (runner refused)");
    expect(html).toContain("96");
    expect(html).toContain("supply skipped");
    expect(html).toContain("accounted windows");
  });

  it("shows the pool the job actually ran at as effective / funded (6 / 8)", () => {
    const html = render(AUDIT);
    expect(html).toContain("6 / 8");
    expect(html).not.toContain("8 / 8");
    expect(html).toContain("data-window-audit-advertised");
    expect(html).toContain("advertised");
  });

  it("ADAAAA-8437: carries the DECIDE_MAX_ADMISSION cap beside the pair", () => {
    const html = render(AUDIT);
    expect(html).toContain("data-window-audit-max-admission");
    expect(html).toContain("cap");
    // Absent on a pre-8437 record: no cap, no crash, no fabricated 0.
    const legacy = render({ ...AUDIT, decideCapacity: { advertised: 6, funded: 8, effective: 6 } });
    expect(legacy).not.toContain("data-window-audit-max-admission");
  });

  it("renders nothing for a record without a stored split", () => {
    expect(render({ ...AUDIT, stored: false, decideCalls: null, supplySkippedWindows: null, accountedWindows: null })).toBe("");
    expect(auditRenderable(null)).toBe(false);
    expect(auditRenderable({ ...AUDIT, stored: false })).toBe(false);
  });
});

describe("capacityPair", () => {
  it("quotes effective / funded, never funded / funded", () => {
    expect(capacityPair(AUDIT.decideCapacity)).toEqual({ effective: 6, funded: 8, text: "6 / 8" });
    expect(capacityPair(null)).toBeNull();
  });
});

// ADAAAA-8544 (AC1): the window audit echoes the knob the job RAN — it never
// re-derives it. A row written before the knob existed says "not recorded"
// rather than implying the user chose uncapped, and an unmeasured density reads
// `n/a` rather than a fabricated `0`.
describe("the decide knob echo (ADAAAA-8544)", () => {
  it("prints the stored posture and the measured density", () => {
    const html = render({
      ...AUDIT,
      decideKnob: {
        cadenceSec: 5,
        rateCapPer300s: null,
        resolvedSource: "default",
        opportunitiesPer300s: 50.3,
        usdPerDecide: 0.0033324,
        predictedUsdPerHour: 2.01143664,
        predictedBandUsdPerHour: [1.862146, 2.162905],
        estimateVersion: "est-v2",
      },
      decideOpportunities: 287,
      decideOpportunitiesPer300s: 84.4,
    });
    expect(html).toContain("data-window-audit-decide-knob");
    expect(html).toContain("Decide posture");
    expect(html).toContain("5 s cadence");
    expect(html).toContain("approx $2.01/h");
    expect(html).toContain("measured band $1.86/h-$2.16/h");
    expect(html).toContain("est-v2");
    expect(html).toContain("84.4 / 300 s");
    expect(html).toContain("data-window-audit-decide-opportunities");
  });

  it("says not recorded (never 'uncapped') on a pre-knob row", () => {
    const html = render({ ...AUDIT });
    expect(html).toContain("not recorded (pre-knob row)");
    expect(html).not.toContain("uncapped");
    // No counter on the record -> `n/a`, not 0.
    expect(html).toContain("n/a");
  });
});

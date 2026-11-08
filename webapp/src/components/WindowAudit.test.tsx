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
  decideCapacity: { advertised: 6, funded: 8, effective: 6, probeOk: true, runners: 3, source: "probe" },
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

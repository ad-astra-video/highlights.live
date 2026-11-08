import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import React from "react";
import { WindowSkipAuditPanel } from "./WindowSkipAuditPanel";
import type { WindowSkipAudit } from "../lib/jobDetail";

// ADAAAA-8425 (AC2/AC3): the admin window audit renders the five skip causes
// side by side with the decide count, the supply total and the decide ceiling the
// job actually ran at — and renders NOTHING for a customer session, so the
// customer analysis surface stays byte-identical.

const AUDIT: WindowSkipAudit = {
  jobId: "job-8425",
  status: "done",
  source: "rtmp",
  decideCalls: 24,
  skippedWindows: 3,
  staleSkippedWindows: 1,
  backpressureSkippedWindows: 2,
  admissionSkippedWindows: 0,
  throttleSkippedWindows: 5,
  capacityDroppedWindows: 3,
  observeRecorded: true,
  decideCapacity: { advertised: 8, funded: 8, effective: 6, probeOk: true, runners: 2, source: "probe" },
};

/** Pull the text of one `data-window-audit-<cause>` tile. */
function tile(html: string, cause: string): string {
  const m = html.match(new RegExp(`data-window-audit-${cause}[^>]*>([\\s\\S]*?)<\\/span>`));
  return (m?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
}

describe("WindowSkipAuditPanel (ADAAAA-8425)", () => {
  it("renders the five causes with their numbers, the decide count and the ceiling", () => {
    const html = renderToStaticMarkup(<WindowSkipAuditPanel audit={AUDIT} admin />);
    expect(html).toContain("data-window-audit");
    expect(tile(html, "stale")).toBe("stale 1");
    expect(tile(html, "backpressure")).toBe("backpressure 2");
    expect(tile(html, "admission")).toBe("admission 0");
    expect(tile(html, "throttle")).toBe("throttle 5");
    expect(tile(html, "capacity")).toBe("capacity-drop 3");
    // AC2: the decide count and the SUPPLY total sit beside the causes.
    expect(html).toContain("24 decide");
    expect(html).toContain("3 supply skipped");
    // AC3: advertised vs effective from the snapshot latched at job start.
    expect(html).toContain("advertised 8");
    expect(html).toContain("effective 6");
    expect(html).toContain("funded 8");
  });

  it("renders nothing for a customer session", () => {
    const html = renderToStaticMarkup(<WindowSkipAuditPanel audit={AUDIT} admin={false} />);
    expect(html).toBe("");
  });

  it("renders nothing when the payload carries no audit (older server / role filter)", () => {
    expect(renderToStaticMarkup(<WindowSkipAuditPanel audit={undefined} admin />)).toBe("");
  });

  it("says NOT MEASURED instead of a fabricated zero on a record with no snapshot", () => {
    const legacy: WindowSkipAudit = {
      ...AUDIT,
      observeRecorded: false,
      decideCalls: 0,
      skippedWindows: 0,
      staleSkippedWindows: 0,
      backpressureSkippedWindows: 0,
      admissionSkippedWindows: 0,
      throttleSkippedWindows: 0,
      capacityDroppedWindows: null,
      decideCapacity: null,
    };
    const html = renderToStaticMarkup(<WindowSkipAuditPanel audit={legacy} admin />);
    expect(html).toContain("data-window-audit-unrecorded");
    expect(tile(html, "capacity")).toBe("capacity-drop n/a");
    expect(html).toContain("no capacity snapshot on this record");
  });
});

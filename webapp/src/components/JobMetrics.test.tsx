import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import React from "react";
import { JobDetailMetrics, JobTileMetrics } from "./JobMetrics";

// ADAAAA-7727 (Inc 1 of ADAAAA-7726): AC1 says a `role=user` session renders no
// cost figure, no decide/perceive/observe counters and no audio Stage-A counter
// on a customer route. These SSR renders are the deterministic proof of that
// gate: the same job record that carries the internal fields renders them for an
// admin and renders nothing internal for a customer.

const JOB = {
  source: "file",
  gameHint: "soccer",
  framesAnalyzed: 240,
  costUsd: 0.02,
  decideCalls: 7,
  candidatesTriggered: 4,
  stageAMetricsStatus: "measured" as const,
  stageAMetrics: {
    totalCandidates: 4,
    accepted: 2,
    rejected: 2,
    fpRate: 0.5,
    meanOnsetLatencyS: 1.2,
    maxOnsetLatencyS: 2.4,
    p50LatencyS: 1,
    p95LatencyS: 2,
    gemmaFpRate: 0.5,
    fpRateWithinBudget: true,
  },
};

function tile(admin: boolean): string {
  return renderToStaticMarkup(
    React.createElement(JobTileMetrics, { job: JOB as any, acceptedCount: 2, rejectedCount: 1, span: "1m 3s", admin })
  );
}

function header(admin: boolean): string {
  return renderToStaticMarkup(
    React.createElement(JobDetailMetrics, { job: JOB as any, frameCount: 240, partition: { ok: true }, admin })
  );
}

describe("customer surfaces render no internal diagnostics", () => {
  it("job tile hides cost and decide counters for a non-admin", () => {
    const html = tile(false);
    expect(html).not.toContain("$");
    expect(html).not.toContain("decide");
    expect(html).not.toContain("data-job-tile-cost");
    expect(html).not.toContain("data-job-tile-decide-calls");
    // The customer's own work counters still render — the gate must not blank
    // the tile (that would be a regression to the customer flow).
    expect(html).toContain("240 frames");
    expect(html).toContain("2 accepted");
    expect(html).toContain("1 rejected");
    expect(html).toContain("1m 3s");
  });

  it("job tile shows cost and decide counters for an admin", () => {
    const html = tile(true);
    expect(html).toContain("$0.02");
    expect(html).toContain("7 decide");
    expect(html).toContain("data-job-tile-cost");
    expect(html).toContain("data-job-tile-decide-calls");
  });

  it("job detail header hides decide/candidates/Stage-A/cost/partition for a non-admin", () => {
    const html = header(false);
    for (const marker of ["data-detail-decide-calls", "data-detail-candidates", "data-detail-stage-a", "data-detail-cost", "data-detail-partition"]) {
      expect(html).not.toContain(marker);
    }
    expect(html).not.toContain("$");
    expect(html).not.toContain("Decide calls");
    expect(html).not.toContain("judged");
    // Customer-facing metadata survives.
    expect(html).toContain("Source");
    expect(html).toContain("Frames");
    expect(html).toContain("soccer");
    expect(html).toContain("240");
  });

  it("job detail header shows the internal readouts for an admin", () => {
    const html = header(true);
    for (const marker of ["data-detail-decide-calls", "data-detail-candidates", "data-detail-stage-a", "data-detail-cost", "data-detail-partition"]) {
      expect(html).toContain(marker);
    }
    expect(html).toContain("$0.02");
    expect(html).toContain("Decide calls");
  });
});

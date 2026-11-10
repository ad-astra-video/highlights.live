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

// ADAAAA-7854: the tile's accepted read is the deduped postable moment count the
// server derives (17 for d61e52f6, never its 24 raw rows), with the merged-away
// duplicates as a secondary read; the admin-only Candidates counter states its raw
// row basis so it can't be mistaken for the customer-facing clip total.
describe("clip counts on the tile (ADAAAA-7854)", () => {
  it("renders the deduped accepted count with a secondary merged read", () => {
    const html = renderToStaticMarkup(
      React.createElement(JobTileMetrics, {
        job: JOB as any,
        acceptedCount: 17,
        mergedCount: 4,
        rejectedCount: 1,
        span: null,
        admin: false,
      })
    );
    expect(html).toContain("17 accepted");
    expect(html).toContain("4 merged");
    expect(html).toContain("data-job-tile-merged");
    expect(html).not.toContain("24 accepted");
  });

  it("omits the merged read when nothing was merged", () => {
    const html = renderToStaticMarkup(
      React.createElement(JobTileMetrics, {
        job: JOB as any,
        acceptedCount: 3,
        mergedCount: 0,
        rejectedCount: 0,
        span: null,
        admin: false,
      })
    );
    expect(html).toContain("3 accepted");
    expect(html).not.toContain("merged");
    expect(html).not.toContain("data-job-tile-merged");
  });

  it("states the raw-row basis on the admin Candidates header only", () => {
    expect(header(true)).toContain("Candidates (raw rows)");
    const customer = header(false);
    expect(customer).not.toContain("Candidates");
    expect(customer).not.toContain("raw rows");
  });
});

// ADAAAA-8544 item 7 (monitor side): the live job header states the FROZEN
// decide posture — cadence, cap, the `est-v2` point BESIDE its measured band —
// and never re-derives a price from the current form state. It is a spend
// readout, so it stays behind the same ADAAAA-7727 admin gate as Cost.
const KNOB_JOB = {
  ...JOB,
  source: "browser",
  decideKnob: {
    cadenceSec: 5 as const,
    rateCapPer300s: null,
    resolvedSource: "default" as const,
    opportunitiesPer300s: 50.3,
    usdPerDecide: 0.0033324,
    predictedUsdPerHour: 2.01143664,
    predictedBandUsdPerHour: [1.862146, 2.162905] as [number, number],
    estimateVersion: "est-v2",
  },
};

function headerWithKnob(admin: boolean): string {
  return renderToStaticMarkup(
    React.createElement(JobDetailMetrics, { job: KNOB_JOB as any, frameCount: 240, partition: { ok: true }, admin })
  );
}

describe("the live decide posture readout (ADAAAA-8544)", () => {
  it("states the stamped posture with its point and measured band for an admin", () => {
    const html = headerWithKnob(true);
    expect(html).toContain("data-detail-decide-knob");
    expect(html).toContain("Decide posture");
    expect(html).toContain("5 s cadence");
    expect(html).toContain("uncapped");
    expect(html).toContain("approx $2.01/h");
    expect(html).toContain("measured band $1.86/h-$2.16/h");
    expect(html).toContain("est-v2");
  });

  it("renders no posture (and no dollars) for a customer session", () => {
    const html = headerWithKnob(false);
    expect(html).not.toContain("data-detail-decide-knob");
    expect(html).not.toContain("Decide posture");
    expect(html).not.toContain("$");
  });

  it("renders nothing when the record predates the knob", () => {
    const html = header(true);
    expect(html).not.toContain("data-detail-decide-knob");
    expect(html).not.toContain("Decide posture");
  });
});

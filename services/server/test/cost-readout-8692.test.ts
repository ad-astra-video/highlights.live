// ADAAAA-8692: a completed / cancelled job record must carry the AC5 cost
// readout (`costPerStreamHour` = the job's billed `costUsd` normalised to one
// hour of stream) and the AC6 job-level summary meter rollup.
//
// What went wrong, measured on the served build `c76ab91`:
//   * QA-C `ec068bcd`, QA-D `5cc78c08`, QA-E `572f1ec7` all stored
//     `costPerStreamHour: null`. The field existed ONLY inside `observeMetrics`,
//     `withDiveCostReadout` refused to stamp it without a `diveAdmission` block
//     (a dive field), and the VOD/file completion path writes no
//     `observeMetrics` at all — so the field had no writer on that rail.
//   * the same record carried no job-level `summaryCalls` / `summaryDropped` /
//     `summaryDroppedByReason` / `summaryP95Ms` (AC6), only the per-row meters.
//
// This suite pins the pure readout, every settlement path that must stamp it,
// the zod retention (a zod object STRIPS undeclared keys — the ADAAAA-8242
// failure mode), the customer-visibility gate, and one REAL VOD job end to end
// through the durable worker.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobSchema, type Job } from "@highlights/events";
import { buildTerminalAccountingPatch, costPerStreamHour, liveCancelledSettlement } from "../src/job-settlement";
import {
  jobSummaryMeterFields,
  summaryMeterFromRows,
  withDiveCostReadout,
  type JobSummaryMeterFields,
} from "../src/api";
import { jobForRole } from "../src/job-visibility";
import { buildTestApp, waitForJob } from "./helpers";

const DECIDE_FEE = 0.0033;
/** QA-E's measured job `572f1ec7`: 101 decides, 300.05 s source, $0.3594. */
const QA_E = { decideCalls: 101, sourceDurationS: 300.05, costUsd: 0.3594 };

describe("costPerStreamHour (ADAAAA-8692)", () => {
  it("prices the AC5 clause off the recorded cost and the stream clock", () => {
    // 0.3594 / (300.05 / 3600) = 4.3121...
    expect(costPerStreamHour(QA_E.costUsd, QA_E.sourceDurationS)).toBe(4.3121);
  });

  it("is absent — never invented — when the stream clock is unknown", () => {
    expect(costPerStreamHour(0.3594, 0)).toBeUndefined();
    expect(costPerStreamHour(0.3594, null)).toBeUndefined();
    expect(costPerStreamHour(0.3594, undefined)).toBeUndefined();
    expect(costPerStreamHour(0.3594, Number.NaN)).toBeUndefined();
  });
});

describe("withDiveCostReadout stamps the readout without a dive admission block", () => {
  const snapshot = {
    decideCalls: 70,
    accepted: 0,
    maxFrames: 4,
    meanE2eMs: 5_883.2,
    maxE2eMs: 15_656,
    meanCadenceMs: 3_009.4,
    maxCadenceMs: 3_120,
  } as Job["observeMetrics"];

  it("QA-D's cancelled-leg shape (no confirm lane => no diveAdmission) still carries costPerStreamHour", () => {
    const row = withDiveCostReadout(snapshot!, DECIDE_FEE, 319.8);
    expect(row.diveAdmission).toBeUndefined();
    expect(row.costPerStreamHour).toBeCloseTo((DECIDE_FEE * 70 + (319.8 / 3600) * 0.01) / (319.8 / 3600), 3);
  });

  it("keeps the dive admission block (and its own priced fields) when the lane ran", () => {
    const withAdmission = {
      ...snapshot!,
      confirmCalls: 2,
      diveAdmission: {
        dispatched: 2,
        queued: 0,
        maxInFlight: 1,
        capacityEffective: 4,
        divesBilled: 0,
        diveCostUsd: 0,
      },
    } as Job["observeMetrics"];
    const row = withDiveCostReadout(withAdmission!, DECIDE_FEE, 319.8);
    expect(row.diveAdmission?.divesBilled).toBe(2);
    expect(row.diveAdmission?.diveCostUsd).toBeCloseTo(DECIDE_FEE * 2, 6);
    expect(row.costPerStreamHour).toBeGreaterThan(0);
  });

  it("prices the summary term into the readout (ADAAAA-8668 identity)", () => {
    const feeUsd = DECIDE_FEE * 1.5;
    const row = withDiveCostReadout(snapshot!, DECIDE_FEE, 319.8, { calls: 3, feeUsd });
    const expected = (DECIDE_FEE * 70 + feeUsd * 3 + (319.8 / 3600) * 0.01) / (319.8 / 3600);
    expect(row.costPerStreamHour).toBeCloseTo(expected, 3);
  });
});

describe("job-level summary meter rollup (ADAAAA-8692 / AC6)", () => {
  it("publishes the counters QA-E's job billed, per row", () => {
    // QA-E job 572f1ec7: three promoted rows, summaryCalls 1/2/2, two drops by
    // `gate`, per-row p95 648 / 1235 / 1684.
    const rows = [
      { summaryCalls: 1, summaryDropped: 0 },
      { summaryCalls: 2, summaryDropped: 1, summaryDroppedByReason: { gate: 1 } },
      { summaryCalls: 2, summaryDropped: 1, summaryDroppedByReason: { gate: 1 } },
    ];
    expect(summaryMeterFromRows(rows)).toEqual({
      summaryCalls: 5,
      summaryDropped: 2,
      summaryDroppedByReason: { gate: 2 },
    });
  });

  it("writes NO key when the lane never ran (absent is not zero)", () => {
    expect(jobSummaryMeterFields(undefined)).toEqual({});
    expect(jobSummaryMeterFields({ summaryCalls: 0, summaryDropped: 0, summaryDroppedByReason: {}, summaryP95Ms: 0 })).toEqual({});
    expect(summaryMeterFromRows([])).toEqual({});
  });

  it("carries the lane's measured p95 when a lane snapshot exists", () => {
    const fields = jobSummaryMeterFields({
      summaryCalls: 5,
      summaryDropped: 2,
      summaryDroppedByReason: { gate: 2 },
      summaryP95Ms: 1684,
    });
    expect(fields).toEqual({ summaryCalls: 5, summaryDropped: 2, summaryDroppedByReason: { gate: 2 }, summaryP95Ms: 1684 });
  });
});

describe("terminal settlements stamp the readout (ADAAAA-8692)", () => {
  it("a failed/swept settlement with a known stream clock prices costUsd/hour", () => {
    const patch = buildTerminalAccountingPatch({
      status: "failed",
      decideFee: DECIDE_FEE,
      decideCalls: 70,
      perceiveSessionS: 319.8,
      streamSeconds: 319.8,
    });
    expect(patch.costUsd).toBeGreaterThan(0);
    expect(patch.costPerStreamHour).toBeCloseTo((patch.costUsd as number) / (319.8 / 3600), 3);
  });

  it("never prices a row whose stream clock is unknown", () => {
    const patch = buildTerminalAccountingPatch({
      status: "failed",
      decideFee: DECIDE_FEE,
      decideCalls: 70,
      perceiveSessionS: 319.8,
    });
    expect(patch.costUsd).toBeGreaterThan(0);
    expect(patch.costPerStreamHour).toBeUndefined();
  });

  it("a cancelled live leg (QA-D 5cc78c08) bills its copy calls and stamps the readout", () => {
    const patch = liveCancelledSettlement({
      decideFee: DECIDE_FEE,
      perceiveSessionS: 300,
      observeMetrics: {
        decideCalls: 70,
        accepted: 0,
        maxFrames: 4,
        meanE2eMs: 1,
        maxE2eMs: 1,
        meanCadenceMs: 1,
        maxCadenceMs: 1,
        summaryCalls: 3,
        summaryDropped: 1,
        summaryDroppedByReason: { gate: 1 },
        summaryP95Ms: 900,
      } as Job["observeMetrics"],
      decideRows: 70,
      summaryCalls: 3,
      summaryFee: DECIDE_FEE * 1.5,
      persistedHighlights: 3,
      progressLabel: "stopped",
    });
    // costUsd = decide + confirm(0) + summary(3 x 1.5x fee) + perceive
    const expected = DECIDE_FEE * 70 + DECIDE_FEE * 1.5 * 3 + (300 / 3600) * 0.01;
    expect(patch.costUsd).toBeCloseTo(expected, 4);
    expect(patch.status).toBe("cancelled");
    expect(patch.costPerStreamHour).toBeCloseTo((patch.costUsd as number) / (300 / 3600), 3);
  });
});

describe("the stored record keeps the new fields (JobSchema.parse)", () => {
  it("retains costPerStreamHour + the job-level summary meters", () => {
    const parsed = JobSchema.parse({
      id: "572f1ec7-7fef-4813-bd19-15c762d6f8eb",
      status: "done",
      source: "file",
      createdAt: "2026-11-11T16:51:00.000Z",
      costUsd: QA_E.costUsd,
      costPerStreamHour: 4.3121,
      summaryCalls: 5,
      summaryDropped: 2,
      summaryDroppedByReason: { gate: 2 },
      summaryP95Ms: 1684,
    });
    expect(parsed.costPerStreamHour).toBe(4.3121);
    expect(parsed.summaryCalls).toBe(5);
    expect(parsed.summaryDropped).toBe(2);
    expect(parsed.summaryDroppedByReason).toEqual({ gate: 2 });
    expect(parsed.summaryP95Ms).toBe(1684);
  });
});

describe("visibility: the new job fields are internal (ADAAAA-7727 rule)", () => {
  const job = {
    id: "j1",
    costUsd: 0.3594,
    costPerStreamHour: 4.3121,
    summaryCalls: 5,
    summaryDropped: 2,
    summaryDroppedByReason: { gate: 2 },
    summaryP95Ms: 1684,
  } as any;

  it("an owner payload omits them; the admin payload keeps them", () => {
    const owner = jobForRole(job, "user") as any;
    for (const key of ["costPerStreamHour", "summaryCalls", "summaryDropped", "summaryDroppedByReason", "summaryP95Ms"]) {
      expect(owner[key]).toBeUndefined();
    }
    const admin = jobForRole(job, "admin") as any;
    expect(admin.costPerStreamHour).toBe(4.3121);
    expect(admin.summaryCalls).toBe(5);
  });
});

// --- one REAL VOD job through the durable worker ---------------------------
const tmp = mkdtempSync(path.join(tmpdir(), "hl-cost8692-"));
const videoPath = path.join(tmp, "test.mp4");
beforeAll(() => {
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=1",
    "-pix_fmt", "yuv420p", videoPath,
  ]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("a completed VOD/file job carries the readout (end to end)", () => {
  it("writes costPerStreamHour on the stored record, priced from its own costUsd", async () => {
    const { app, store } = await buildTestApp();
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "cost8692@test.dev", password: "password123" } });
    expect(reg.statusCode).toBe(200);
    const token = reg.json().token as string;
    const submitted = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(submitted.statusCode).toBe(202);
    const jobId = submitted.json().job.id as string;
    const body = await waitForJob(app, jobId, token);
    expect(body.job.status).toBe("done");

    const stored = store.getJob(jobId) as Job;
    const durationS = (stored.durationMs ?? 0) / 1000;
    expect(durationS).toBeGreaterThan(0);
    expect(stored.costUsd).toBeGreaterThan(0);
    // The AC5 clause: the fee is in BOTH `costUsd` and `costPerStreamHour`.
    expect(stored.costPerStreamHour).toBeDefined();
    expect(stored.costPerStreamHour).toBeCloseTo((stored.costUsd as number) / (durationS / 3600), 2);
    // The VOD meter's $/video-hour and the readout are the same quantity priced
    // from the same cost — a disagreement would mean two expressions again.
    expect(stored.costPerStreamHour).toBeCloseTo(stored.vodMeter!.perVideoHourCostUsd as number, 4);
    // A VOD job still writes no `observeMetrics` (live-only block), and the
    // readout is therefore job-level — the reader QA uses.
    expect(stored.observeMetrics).toBeUndefined();
    // No summary lane ran in this harness, so the rollup stays absent rather
    // than writing a fabricated zero.
    expect(stored.summaryCalls).toBeUndefined();
    const fields: JobSummaryMeterFields = jobSummaryMeterFields(undefined);
    expect(fields).toEqual({});
  });
});

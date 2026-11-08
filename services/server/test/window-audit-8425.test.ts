// ADAAAA-8425: windows skipped by cause + the decide capacity-drop counter.
//
// Two seams are pinned here:
//   (a) the LIVE pass counts a decide the runner REFUSED for capacity
//       (`isDecideCapacityError`) exactly once per cadence window and persists
//       it next to the other four causes, leaving `supplySkippedWindows`
//       untouched (the ADAAAA-7808 definition is a PO ruling);
//   (b) the admin projection (`windowAuditForJob`, the body of
//       `GET /admin/jobs/:id/window-audit`) returns the five causes, the supply
//       number and `decideCalls` field-for-field off a stored record, plus the
//       decided pool's `advertised` / `funded` / `effective` ceiling.
//
// $0 GPU, no live leg: the decide is a stub that throws a `DecideCapacityError`.
import { describe, it, expect } from "vitest";
import { analyzeJob, buildLiveObserveMetrics, type PipelineClient } from "../src/analyzer";
import { LiveObserver } from "../src/observe-loop";
import { windowAuditForJob } from "../src/window-audit";
import { DecideCapacityError } from "@highlights/livepeer-session";

/** A live-shaped frame rail: 0.04 s of content per frame, no wall delay. */
async function* frames(count: number) {
  for (let i = 0; i < count; i++) {
    const ts = Number((i * 0.04).toFixed(6));
    yield { seq: i, timestamp: ts, imageB64: `f${ts}` };
  }
}

/** A client whose every decide is refused by the runner for capacity. */
function capacityRefusingClient(): { client: PipelineClient; attempts: { ts: number }[] } {
  const attempts: { ts: number }[] = [];
  let currentTs = 0;
  const client = {
    reservePerceive: async () => ({ sessionId: "sess-cap", appUrl: "", controlUrl: "" }),
    analyze: async (_sid: string, frame: any) => {
      currentTs = frame.timestamp;
      return { observation: { tracks: [], seq: frame.seq, timestamp: frame.timestamp } as any };
    },
    decide: async () => {
      attempts.push({ ts: currentTs });
      throw new DecideCapacityError(60_000, 60_000);
    },
    plan: async () => ({
      planVersion: 1,
      category: "soccer",
      intent: "",
      source: "planner-fallback",
      maxTracks: 3,
      targets: [{ label: "player", role: "player" }],
      reason: "test",
    }),
    postAudio: async () => ({ candidate: null, series: [] }),
    controlForward: async () => null,
    train: async () => ({ run: "x", checkpoint: "/runs/x/model.safetensors" }),
    stopPerceive: async () => {},
    confirm: async () => ({
      enabled: false,
      confidence: 0,
      reason: "",
      evidence: {},
      stage1Disagreed: false,
      decision: { isHighlight: false, score: 0, outcome: "not_highlight" },
    }),
  } as any;
  return { client, attempts };
}

const BASE_CFG = {
  jobId: "job-cap-drop",
  clipBeforeS: 4,
  clipAfterS: 4,
  gameHint: "soccer",
  liveObserveLoop: true,
  observeCadenceS: 0.2,
  observeWindowS: 1,
  observeMaxFrames: 30,
  sampleFps: 25,
  liveObserveContentFps: 1000,
  // The shipped default: decide issued off the frame-consume loop (staged
  // depth 1), which is the path every live stream on the box takes.
  observeDecideOffLoop: true,
} as const;

describe("capacityDroppedWindows counter (ADAAAA-8425 AC1)", () => {
  it("counts one refusal per window and never twice for the same window", () => {
    const obs = new LiveObserver({ cadenceS: 3, windowS: 10, fps: 2 });
    expect(obs.capacityDropCount()).toBe(0);
    obs.noteCapacityDrop(9);
    // A retry that reports the SAME window (same center) is the same lost
    // window — one count.
    obs.noteCapacityDrop(9);
    expect(obs.capacityDropCount()).toBe(1);
    // The next cadence window is a distinct loss.
    obs.noteCapacityDrop(12);
    expect(obs.capacityDropCount()).toBe(2);
    // Metrics carry it next to the other causes, and the supply definition is
    // unchanged (capacity drop is its own cause, not folded in).
    const m = buildLiveObserveMetrics(obs);
    expect(m.capacityDroppedWindows).toBe(2);
    expect(m.supplySkippedWindows).toBe(0);
  });

  it("counts every decide the stub refuses, on the real analyzeJob live pass", async () => {
    const { client, attempts } = capacityRefusingClient();
    const outcome = await analyzeJob(
      client,
      frames(60) as any,
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { ...BASE_CFG } as any,
      undefined
    );
    const m = outcome.observeMetrics!;
    expect(attempts.length).toBeGreaterThan(0);
    // Every issued decide was refused, so `decideCalls` (issued windows) equals
    // the attempts and the completed count is zero...
    expect(m.decideCalls).toBe(attempts.length);
    // ...and every refused window is counted, once (the stub refuses one
    // attempt per fired window, so the counts must agree exactly).
    expect(m.capacityDroppedWindows).toBe(attempts.length);
    expect(m.capacityDroppedWindows).toBeGreaterThan(0);
    // The refusal is NOT one of the other causes: content was not late, the
    // in-flight depth was not full and the rate cap is off.
    expect(m.skippedStaleWindows).toBe(0);
    expect(m.backpressureSkippedWindows).toBe(0);
    expect(m.admissionSkippedWindows).toBe(0);
    expect(m.throttleSkippedWindows).toBe(0);
    expect(m.supplySkippedWindows).toBe(0);
    // Accounting: `decideCalls` counts ISSUED windows (the observer records a
    // sample at settle even with no verdict), so the dropped windows are inside
    // it. The readout subtracts them to name the calls that produced a verdict.
    const audit = windowAuditForJob({ id: "job-cap-drop", status: "done", observeMetrics: m } as any);
    expect(audit.decideCalls).toBe(attempts.length);
    expect(audit.decideCallsCompleted).toBe(0);
    expect(audit.skippedWindows).toBe(attempts.length);
    expect(audit.accountedWindows).toBe(attempts.length);
  }, 30_000);
});

describe("windowAuditForJob (ADAAAA-8425 AC2/AC3)", () => {
  const record = {
    id: "job-2stream-8425",
    status: "done",
    source: "rtmp",
    observeMetrics: {
      decideCalls: 96,
      skippedStaleWindows: 0,
      backpressureSkippedWindows: 11,
      admissionSkippedWindows: 0,
      throttleSkippedWindows: 4,
      capacityDroppedWindows: 2,
      supplySkippedWindows: 11,
      decideCapacity: { advertised: 6, funded: 8, effective: 6, probeOk: true, runners: 3, source: "probe" },
    },
  };

  it("returns the five causes side by side with decideCalls and the supply number", () => {
    const audit = windowAuditForJob(record as any);
    expect(audit.jobId).toBe("job-2stream-8425");
    expect(audit.stored).toBe(true);
    expect(Object.fromEntries(audit.causes.map((c) => [c.cause, c.count]))).toEqual({
      stale: 0,
      backpressure: 11,
      admission: 0,
      throttle: 4,
      capacityDrop: 2,
    });
    // Field names are the record's own, so a reader can match
    // `record->'observeMetrics'` field for field.
    expect(audit.causes.map((c) => c.field)).toEqual([
      "skippedStaleWindows",
      "backpressureSkippedWindows",
      "admissionSkippedWindows",
      "throttleSkippedWindows",
      "capacityDroppedWindows",
    ]);
    expect(audit.decideCalls).toBe(96);
    expect(audit.decideCallsCompleted).toBe(94);
    expect(audit.supplySkippedWindows).toBe(11);
    // Every window that produced no verdict: 0 stale + 11 bp + 0 admission +
    // 4 throttle + 2 capacity drops.
    expect(audit.skippedWindows).toBe(17);
    // Opportunities: decideCalls counts ISSUED windows, so the four non-fired
    // causes add to it — the capacity drops are already inside decideCalls.
    expect(audit.accountedWindows).toBe(111);
    expect(audit.decideCallsCompleted! + audit.skippedWindows!).toBe(audit.accountedWindows);
  });

  it("surfaces the ceiling the job actually ran at: effective 6 of 8 funded", () => {
    const audit = windowAuditForJob(record as any);
    expect(audit.decideCapacity).toMatchObject({
      advertised: 6,
      funded: 8,
      effective: 6,
      probeOk: true,
      runners: 3,
      source: "probe",
    });
    // The pair a reader quotes is effective/funded, never funded/funded.
    expect(`${audit.decideCapacity!.effective} / ${audit.decideCapacity!.funded}`).toBe("6 / 8");
  });

  it("never fabricates a split when the record carries no observe snapshot", () => {
    const audit = windowAuditForJob({ id: "job-live", status: "analyzing", source: "rtmp" } as any);
    expect(audit.stored).toBe(false);
    expect(audit.decideCalls).toBeNull();
    expect(audit.supplySkippedWindows).toBeNull();
    expect(audit.accountedWindows).toBeNull();
    expect(audit.decideCapacity).toBeNull();
    expect(audit.causes.every((c) => c.count === null)).toBe(true);
  });

  it("derives supply from the three supply causes for a record that predates the field", () => {
    const audit = windowAuditForJob({
      id: "job-old",
      status: "done",
      observeMetrics: { decideCalls: 10, skippedStaleWindows: 2, backpressureSkippedWindows: 3, admissionSkippedWindows: 1 },
    } as any);
    expect(audit.supplySkippedWindows).toBe(6);
    expect(audit.accountedWindows).toBe(16);
  });
});

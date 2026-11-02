// ADAAAA-7722: make the whistle envelope MEASURABLE.
//
// The ADAAAA-7713 spend envelope's hard tripwire is the whistle SHARE of a
// window's decides (>25%) and its alert is added trigger volume (2.0/min). Both
// were advisory on the deployed box because:
//
//   1. the trigger FAMILY (`stageB/whistle/...`) existed only inside the
//      in-flight `ObserveDecidePayload.trigger` — after the run nothing named it,
//      so `whistleDecides / allDecides` could not be computed; and
//   2. `stageAMetrics` had to stay whistle-free, otherwise the FP ledger the
//      envelope is sanity-checked against was contaminated by whistle fires.
//
// These tests pin the fix at the observer + contract layer:
//
//   - the anchored window RECORD carries the trigger identity/family, and
//     `observeMetrics` persists `allDecides` + `whistleWindows` through the
//     Zod contract (the ADAAAA-7691 "schema strips undeclared fields" trap);
//   - a whistle fire leaves `stageAMetrics` BYTE-IDENTICAL to the same run
//     without it, while a `stageA/burst/1.3x/0.3s` fire still moves it;
//   - the decide-audit descriptor is stamped with the family so a
//     whistle-anchored decide is countable in `decide_audit` post-run.
import { describe, it, expect } from "vitest";
import { JobSchema, ObserveMetricsSnapshotSchema } from "@highlights/events";
import { WHISTLE_THRESHOLD_ID } from "../src/audio-trigger";
import { LiveObserver, OBSERVE_CADENCE_S } from "../src/observe-loop";
import { attachTriggerFamilyToAudit, buildLiveObserveMetrics, LiveRunShared } from "../src/analyzer";
import { whistleEvidenceLine } from "../src/stage-a-metrics";

const STAGE_A_BURST_ID = "stageA/burst/1.3x/0.3s";

function whistleTrigger(onsetTs = 2.0, onsetLatencyS = 0.2) {
  return {
    kind: "burst" as const,
    onsetTs,
    firedAt: onsetTs + onsetLatencyS,
    onsetLatencyS,
    peakEnergy: 0.31,
    baselineEnergy: 0.02,
    thresholdId: WHISTLE_THRESHOLD_ID,
  };
}

function stageATrigger(onsetTs = 2.0, onsetLatencyS = 0.2) {
  return {
    kind: "burst" as const,
    onsetTs,
    firedAt: onsetTs + onsetLatencyS,
    onsetLatencyS,
    peakEnergy: 0.42,
    baselineEnergy: 0.03,
    thresholdId: STAGE_A_BURST_ID,
  };
}

/** Drive one live observer over a fixed frame sequence, optionally injecting a
 *  trigger at `trigger.onsetTs`. Returns the observer + the run it judged. */
async function runObserver(
  opts: { trigger?: ReturnType<typeof whistleTrigger> | ReturnType<typeof stageATrigger>; accepted?: boolean } = {}
) {
  const run = new LiveRunShared();
  const payloads: any[] = [];
  const obs = new LiveObserver({
    cadenceS: OBSERVE_CADENCE_S,
    windowS: 10,
    maxFrames: 30,
    fps: 10,
    stageA: run.stageAOutcomes,
    stageB: run.stageBOutcomes,
    onDecide: async (p) => {
      payloads.push(p);
      return opts.accepted ?? false;
    },
  });
  let injected = false;
  for (let i = 0; i <= 120; i++) {
    const ts = Number((i / 10).toFixed(4));
    obs.record(ts, `frame-${ts}`, { ts });
    if (opts.trigger && !injected && ts >= opts.trigger.onsetTs) {
      injected = true;
      // Production order: the audio tap records the trigger on the RUN (which
      // routes it into its family's ledger) and the live loop drains it into the
      // observer, which anchors one window on it.
      run.recordAudioTrigger(opts.trigger);
      obs.recordTrigger(opts.trigger);
    }
    await obs.maybeFire(ts);
  }
  return { obs, run, payloads };
}

describe("whistle family is persisted on the anchored window record (ADAAAA-7722 AC1)", () => {
  it("labels the whistle-anchored decide by family and agrees allDecides with decideCalls", async () => {
    const { obs } = await runObserver({ trigger: whistleTrigger(2.0) });
    const m = buildLiveObserveMetrics(obs);

    expect(m.whistleFires).toBe(1);
    expect(m.whistleDecides).toBe(1);
    // The explicit denominator: every decide this run made.
    expect(m.allDecides).toBe(m.decideCalls);
    expect(m.allDecides).toBeGreaterThan(1);
    // The crowding arithmetic is computable from the two persisted counts.
    expect(m.whistleShare).toBeCloseTo(m.whistleDecides! / m.allDecides!, 4);

    // The anchored window RECORD names the trigger that scheduled it.
    expect(m.whistleWindows).toHaveLength(1);
    const w = m.whistleWindows![0];
    expect(w.thresholdId).toBe(WHISTLE_THRESHOLD_ID);
    expect(w.family).toBe("stageB");
    expect(w.centerTs).toBeGreaterThanOrEqual(2.0);
    expect(w.centerTs - 2.0).toBeLessThanOrEqual(1.5);
  });

  it("a cadence-only run persists no whistle window and a zero numerator", async () => {
    const { obs } = await runObserver({});
    const m = buildLiveObserveMetrics(obs);
    expect(m.decideCalls).toBeGreaterThan(1);
    expect(m.allDecides).toBe(m.decideCalls);
    expect(m.whistleDecides).toBe(0);
    expect(m.whistleWindows).toEqual([]);
  });

  it("the new fields SURVIVE the job contract (no schema stripping)", async () => {
    const { obs } = await runObserver({ trigger: whistleTrigger(2.0) });
    const m = buildLiveObserveMetrics(obs);
    // The contract layer that stripped ADAAAA-7691's counters first.
    const parsed = ObserveMetricsSnapshotSchema.parse(m);
    expect(parsed.allDecides).toBe(m.allDecides);
    expect(parsed.whistleWindows).toEqual(m.whistleWindows);
    // ...and the full job record (store.patchJob round-trips through JobSchema).
    const job = JobSchema.parse({
      id: "job-adaaa-7722",
      ownerId: "user-1",
      source: "file-sim",
      status: "done",
      createdAt: new Date().toISOString(),
      observeMetrics: m,
      liveWatchMinutes: 5.25,
    });
    expect(job.observeMetrics?.whistleWindows?.[0].thresholdId).toBe(WHISTLE_THRESHOLD_ID);
    expect(job.observeMetrics?.allDecides).toBe(m.allDecides);
    expect(job.liveWatchMinutes).toBe(5.25);
  });

  it("the evidence line prints the numerator AND the denominator it was taken over", async () => {
    const { obs } = await runObserver({ trigger: whistleTrigger(2.0) });
    const m = buildLiveObserveMetrics(obs);
    const line = whistleEvidenceLine("live", "job-adaaa-7722", m)!;
    expect(line).toContain("stageB whistle fires=1 decides=1");
    expect(line).toContain(`allDecides=${m.allDecides}`);
    expect(line).toContain("withinTripwire=true");
  });
});

describe("stageAMetrics is whistle-free (ADAAAA-7722 AC2)", () => {
  it("a whistle fire leaves the Stage-A snapshot BYTE-IDENTICAL to a run without it", async () => {
    const baseline = await runObserver({});
    const withWhistle = await runObserver({ trigger: whistleTrigger(2.0), accepted: true });

    // Byte-identical: same JSON, same order, same numbers.
    expect(JSON.stringify(withWhistle.run.stageA.snapshot())).toBe(JSON.stringify(baseline.run.stageA.snapshot()));
    expect(withWhistle.run.stageA.totalCandidates).toBe(0);
    expect(baseline.run.stageA.totalCandidates).toBe(0);

    // ...while the whistle path measured the fire in its OWN ledger.
    expect(withWhistle.run.stageB.totalCandidates).toBe(1);
    expect(withWhistle.run.stageB.acceptedCount).toBe(1);
    expect(baseline.run.stageB.totalCandidates).toBe(0);
  });

  it("a stageA/burst fire still MOVES the Stage-A ledger", async () => {
    const baseline = await runObserver({});
    const withBurst = await runObserver({ trigger: stageATrigger(2.0), accepted: true });

    expect(withBurst.run.stageA.totalCandidates).toBe(1);
    expect(withBurst.run.stageA.acceptedCount).toBe(1);
    expect(JSON.stringify(withBurst.run.stageA.snapshot())).not.toBe(JSON.stringify(baseline.run.stageA.snapshot()));
    // ...and it never lands in the whistle ledger.
    expect(withBurst.run.stageB.totalCandidates).toBe(0);
  });

  it("a coalesced re-fire is still ONE audible event (existing rule stays green)", async () => {
    const run = new LiveRunShared();
    expect(run.recordAudioTrigger(whistleTrigger(2.0))).toBe(true);
    // `recordAudioTrigger` always accepts the record (it is also a queue push);
    // the COALESCE decision is the ledger's — the second fire must not re-count.
    run.recordAudioTrigger(whistleTrigger(2.3));
    expect(run.whistleTriggerCount()).toBe(1);
    expect(run.stageBOutcomes.pendingCount()).toBe(1);
    expect(run.stageA.totalCandidates).toBe(0);
  });
});

describe("the decide-audit row names the trigger family (ADAAAA-7722 AC1)", () => {
  it("stamps family + threshold id, preserving existing params", () => {
    const audit = { groupKey: "g12", params: { model: "gemma", reasoningEffort: "none" }, frameCount: 16 };
    const out: any = attachTriggerFamilyToAudit(audit, whistleTrigger(2.0));
    expect(out.params.model).toBe("gemma");
    expect(out.params.reasoningEffort).toBe("none");
    expect(out.params.triggerFamily).toBe("stageB");
    expect(out.params.triggerThresholdId).toBe(WHISTLE_THRESHOLD_ID);
    expect(out.groupKey).toBe("g12");
    expect(out.frameCount).toBe(16);
    // Non-destructive: the descriptor passed in is untouched.
    expect((audit as any).params.triggerFamily).toBeUndefined();
  });

  it("stamps stageA for a Stage-A anchored window and leaves cadence rows alone", () => {
    const burst: any = attachTriggerFamilyToAudit({ groupKey: "g9", params: {} }, stageATrigger(2.0));
    expect(burst.params.triggerFamily).toBe("stageA");
    expect(burst.params.triggerThresholdId).toBe(STAGE_A_BURST_ID);

    const cadence = { groupKey: "g13", params: { model: "gemma" } };
    expect(attachTriggerFamilyToAudit(cadence, undefined)).toEqual(cadence);
    expect(attachTriggerFamilyToAudit(null, whistleTrigger())).toBeNull();
  });
});

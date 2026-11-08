// ADAAAA-8344 AC1 (wiring): the ON-CHAIN decide path must publish the securing
// leg as its own stages, and the instrumentation must not change the verdict, the
// payload or the number of billable calls.
//
// The deciding property of this ticket is "probe, then sign, then pay" being
// measurable per call. A unit test on the recorder alone would pass while the
// adapter published nothing — the ADAAAA-8300 phase-1 failure mode. So this test
// drives the real `decide()` control flow with a stubbed client that answers
// exactly like the orchestrator (402 with a challenge, then 200 with a verdict)
// and asserts the published stage record.
import { describe, expect, it } from "vitest";
import { OrchestratorAdapter } from "../src/livepeer-adapter.js";
import { PaymentRequiredError, type SignerClient } from "@highlights/livepeer-session";
import type { ServerConfig } from "../src/config.js";
import {
  DECIDE_STAGE_KEYS,
  decideStageRecorder,
  decideStageSum,
  type DecideStageTimings,
} from "../src/decide-stage-timings.js";

const EVIDENCE = { eventType: "SPORTING_EVENT", trackCount: 3, maxVelocity: 0.5, ocrHits: 16 };

function fakeSigner(): SignerClient {
  return {
    discover: async () => [],
    signOrchInfo: async () => ({}),
    generateLivePayment: async () => ({ payment: "pmt-1", segCreds: "seg-1", signerState: null }),
  } as unknown as SignerClient;
}

function harness(opts: { offchain?: boolean } = {}) {
  const published: DecideStageTimings[] = [];
  const adapter = new OrchestratorAdapter(
    { orchestratorUrl: "http://127.0.0.1:1", decideCapacityDiscovery: false } as unknown as ServerConfig,
    {
      signer: opts.offchain ? undefined : fakeSigner(),
      payerAddress: opts.offchain ? undefined : "0xpayer",
      onDecideStages: (t) => published.push(t),
    }
  );
  const calls: { paid: boolean }[] = [];
  (adapter as any).client = {
    decide: async (_route: string, _payload: any, o?: any) => {
      // Offchain posture: there is no payer/signer, so the orchestrator serves
      // the unpaid call directly (200) — the probe has nothing to probe.
      const paid = opts.offchain ? true : Boolean(o?.paymentHeaders?.["Livepeer-Payment"]);
      calls.push({ paid });
      // The client reports its transport stages through the per-call sink.
      o?.onAttempt?.({
        attempt: 0,
        status: paid ? 200 : 402,
        queueMs: paid ? 0 : 4,
        serializeMs: 2,
        sentBytes: 48_000,
        ttfbMs: paid ? 1_800 : 190,
        bodyMs: paid ? 520 : 8,
        parseMs: paid ? 9 : 1,
      });
      if (!paid) {
        throw new PaymentRequiredError(
          { payment_params: "b64", manifest_id: "m-1" },
          { paymentParams: "b64", manifestId: "m-1", orchestrator: "orch" }
        );
      }
      return { status: 200, data: { isHighlight: true, score: 0.9 } };
    },
  };
  return { adapter, published, calls };
}

describe("orchestrator decide stage instrument (ADAAAA-8344)", () => {
  it("publishes probe (402) + signer + paid stages for an on-chain decide", async () => {
    const { adapter, published, calls } = harness();
    const verdict = await adapter.decide(EVIDENCE as any, { jobId: "job-wire", groupKey: "g42" });
    expect(verdict.isHighlight).toBe(true);
    // Behavior preserved: exactly one unpaid probe and one paid call.
    expect(calls).toEqual([{ paid: false }, { paid: true }]);
    expect(published.length).toBe(1);
    const t = published[0];
    expect(t.jobId).toBe("job-wire");
    expect(t.groupKey).toBe("g42");
    expect(t.probeCount).toBe(1);
    expect(t.probeStatus).toBe(402);
    expect(t.probeSkipped).toBe(false);
    expect(t.paidRetries).toBe(1);
    expect(t.payloadBytes).toBe(48_000);
    expect(t.paidTtfbMs).toBe(1_800);
    expect(t.paidParseMs).toBe(9);
    expect(t.signerMs).toBeGreaterThanOrEqual(0);
    expect(t.signerRetries).toBe(0);
    // The stage sum closes on the call wall time, per call.
    expect(decideStageSum(t)).toBe(t.totalMs);
    expect(t.totalMs).toBeGreaterThanOrEqual(t.probeMs + t.paidMs);
    // Every pinned stage key is populated (a future key added only on one side
    // would come back undefined here).
    for (const k of DECIDE_STAGE_KEYS) expect(Number.isFinite(t[k] as number)).toBe(true);
    // The bounded recorder carries the same call, so the job record can read it.
    expect(decideStageRecorder.summary("job-wire")!.calls).toBe(1);
    decideStageRecorder.clear("job-wire");
  });

  it("reports the offchain posture as probe 200 instead of pretending a 402", async () => {
    const { adapter, published } = harness({ offchain: true });
    await adapter.decide(EVIDENCE as any, { jobId: "job-offchain" });
    const t = published[0];
    // Offchain (no signer): the single call IS the decide — no probe, no signer.
    expect(t.probeStatus).toBe(200);
    expect(t.probeCount).toBe(1);
    expect(t.signerMs).toBe(0);
    expect(t.paidMs).toBe(0);
    expect(decideStageSum(t)).toBe(t.totalMs);
    decideStageRecorder.clear("job-offchain");
  });
});

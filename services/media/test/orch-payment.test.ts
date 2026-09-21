import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { MediaOrchestrator } from "../src/orch";
import type { SignerClient, LivePayment } from "@highlights/livepeer-session";

// The orchestrator's transport is injected as `_req` (real fetch). We stub
// global.fetch to simulate an ON-CHAIN orchestrator: the first reserve returns
// 402 with the live-payment challenge BODY (payment_params = base64
// OrchestratorInfo, manifest_id = AuthToken.SessionId), the paid retry returns
// 200, then analyze opens the trickle channels and stats reports them.
const appUrl = "http://orch/apps/highlights-perceive/session/sess-pay";
const controlUrl = "http://orch/apps/highlights-perceive/session/sess-pay/control";

// go-livepeer `liveRunnerPaymentChallengeResponse` shape (server/ai_http.go).
const CHALLENGE = {
  payment_params: "b3JjaC1pbmZv", // base64 net.OrchestratorInfo
  orchestrator: "http://orch",
  manifest_id: "sess-abc", // AuthToken.SessionId
  payment_url: "http://orch/apps/highlights-perceive/session/sess-abc/payment",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeFetch(opts: { paidReserve?: boolean; challengeBody?: any }) {
  let reserveCalls = 0;
  const log: Array<{ url: string; headers: Record<string, string> }> = [];
  return {
    fn: vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      const headers = { ...((init?.headers as any) || {}) };
      log.push({ url, headers });
      if (url.endsWith("/apps/highlights-perceive/session")) {
        reserveCalls++;
        if (reserveCalls === 1 && !opts.paidReserve) {
          return jsonResponse(402, opts.challengeBody ?? { error: "payment required" });
        }
        return jsonResponse(200, { session_id: "sess-pay", app_url: appUrl, control_url: controlUrl });
      }
      if (url.endsWith("/app/analyze")) {
        return jsonResponse(200, { ok: true });
      }
      if (url.includes("/app/session/stats")) {
        return jsonResponse(200, {
          trickle: {
            video_in: `${appUrl}/trickle/video-in`,
            events_out: `${appUrl}/trickle/events-out`,
            control: `${appUrl}/trickle/control`,
          },
        });
      }
      return jsonResponse(404, { error: "nf" });
    }),
    log,
  };
}

// Records the orchestrator info + state each generateLivePayment receives, so
// the test can prove the 402-challenge wire fix: the base64 OrchestratorInfo
// comes from the 402 challenge's `payment_params` (NOT null, and NOT fetched via
// gRPC GetOrchestrator), and the manifestID comes from the challenge's
// `manifest_id` (== AuthToken.SessionId).
const generatePaymentCalls: Array<{ orchInfoB64: unknown; prev: unknown; opts: unknown }> = [];
const fakeSigner: SignerClient = {
  async discover() {
    return [];
  },
  async signOrchInfo() {
    return {};
  },
  async generateLivePayment(
    orchInfoB64: string,
    prev: unknown,
    opts: { app?: string; type?: "live" | "lv2v" | "fixed"; inPixels?: number; manifestID?: string } = {}
  ): Promise<LivePayment> {
    generatePaymentCalls.push({ orchInfoB64, prev, opts });
    return { payment: "livepeer-payment-ticket", segCreds: "segment-creds", signerState: { State: "c3RhdGU=", Sig: "c2ln" } };
  },
};

beforeEach(() => {
  generatePaymentCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MediaOrchestrator on-chain: 402 -> paid reserve -> open channels", () => {
  it("forwards the 402 challenge's payment_params + manifest_id to the signer and retries the reserve", async () => {
    const { fn, log } = fakeFetch({ paidReserve: false, challengeBody: CHALLENGE });
    vi.stubGlobal("fetch", fn);

    const orch = new MediaOrchestrator({
      orchBase: "http://orch",
      signer: fakeSigner,
      payerAddress: "0x68d6FF3938Ff63d2df16567Cb8CA9772e14496F7",
    });

    const p = await orch.provision();

    expect(fn).toHaveBeenCalledTimes(4); // reserve(402) + reserve(paid) + analyze + stats
    // The paid retry carried the signer's Livepeer-Payment / Livepeer-Segment.
    const paymentReserves = log.filter((c) => c.url.endsWith("/apps/highlights-perceive/session"));
    expect(paymentReserves).toHaveLength(2);
    expect(paymentReserves[1].headers["Livepeer-Payment"]).toBe("livepeer-payment-ticket");
    expect(paymentReserves[1].headers["Livepeer-Segment"]).toBe("segment-creds");
    // Payer address advertised on both reserves.
    expect(paymentReserves[0].headers["Livepeer-Payer-Address"]).toBe("0x68d6FF3938Ff63d2df16567Cb8CA9772e14496F7");

    expect(p.sessionId).toBe("sess-pay");
    expect(p.videoIn).toContain("/trickle/video-in");
    expect(p.eventsOut).toContain("/trickle/events-out");
    // 402-CHALLENGE WIRE FIX: the signer received the base64 OrchestratorInfo
    // straight from the 402 challenge's `payment_params` — NOT null (the bug
    // that caused "400 missing orchestrator") and NOT a gRPC GetOrchestrator
    // fetch against the orchestrator.
    expect(generatePaymentCalls).toHaveLength(1);
    expect(generatePaymentCalls[0].orchInfoB64).toBe("b3JjaC1pbmZv");
    expect(generatePaymentCalls[0].prev).toBe(null); // first payment: no state yet
    // manifestID comes from the challenge's `manifest_id` (== AuthToken.SessionId);
    // without it the orchestrator returns `403 mismatched manifest and auth token`.
    expect((generatePaymentCalls[0].opts as any).manifestID).toBe("sess-abc");
    // The signer state from the paid reserve is seeded for the refresher, and
    // the orchestrator info + sessionId are carried onto the session so the
    // refresher can re-issue tickets without refetching.
    expect(p.paymentState).toEqual({ State: "c3RhdGU=", Sig: "c2ln" });
    expect(p.orchInfoB64).toBe("b3JjaC1pbmZv");
    expect(p.orchInfoSessionId).toBe("sess-abc");
  });

  it("uses the signer's /discover-orchestrators to pick the orchestrator for the session start", async () => {
    const { fn, log } = fakeFetch({ paidReserve: false, challengeBody: CHALLENGE });
    vi.stubGlobal("fetch", fn);

    const orch = new MediaOrchestrator({
      orchBase: "http://fallback-orch", // should NOT be used once discovery resolves
      signer: fakeSigner,
      // The signer discovers an orchestrator advertising the perceive runner.
      discoverOrchestrators: async () => [
        { address: "http://not-perceive", runners: [{ app: "something-else" } as any] },
        { address: "http://orch-disc", runners: [{ app: "highlights-perceive" } as any] },
      ],
    });

    const p = await orch.provision();

    const paymentReserves = log.filter((c) => c.url.endsWith("/apps/highlights-perceive/session"));
    expect(paymentReserves).toHaveLength(2);
    // Session start went to the DISCOVERED orchestrator (the one advertising the
    // perceive runner), not the configured fallback.
    expect(paymentReserves[0].url.startsWith("http://orch-disc")).toBe(true);
    expect(p.orchInfoB64).toBe("b3JjaC1pbmZv");
  });

  it("falls back to the configured orchBase when discovery returns nothing", async () => {
    const { fn, log } = fakeFetch({ paidReserve: false, challengeBody: CHALLENGE });
    vi.stubGlobal("fetch", fn);

    const orch = new MediaOrchestrator({
      orchBase: "http://fallback-orch",
      signer: fakeSigner,
      discoverOrchestrators: async () => [], // discovery empty / unavailable
    });

    await orch.provision();

    const paymentReserves = log.filter((c) => c.url.endsWith("/apps/highlights-perceive/session"));
    expect(paymentReserves[0].url.startsWith("http://fallback-orch")).toBe(true);
  });

  it("fails hard with a clear error when a 402 challenge carries no payment_params", async () => {
    const { fn } = fakeFetch({ paidReserve: false, challengeBody: {} }); // no payment_params/manifest_id
    vi.stubGlobal("fetch", fn);

    const orch = new MediaOrchestrator({
      orchBase: "http://orch",
      signer: fakeSigner,
    });
    await expect(orch.provision()).rejects.toThrow(/payment_params/);
  });

  it("stays offchain (one unpaid reserve, no signer payment) when no signer is configured", async () => {
    const { fn, log } = fakeFetch({ paidReserve: true }); // never 402s
    vi.stubGlobal("fetch", fn);

    const orch = new MediaOrchestrator({ orchBase: "http://orch" }); // no signer, no payer
    const p = await orch.provision();

    expect(fn).toHaveBeenCalledTimes(3); // reserve(200) + analyze + stats
    const paymentReserves = log.filter((c) => c.url.endsWith("/apps/highlights-perceive/session"));
    expect(paymentReserves).toHaveLength(1);
    expect(paymentReserves[0].headers["Livepeer-Payment"]).toBeUndefined();
    expect(paymentReserves[0].headers["Livepeer-Payer-Address"]).toBeUndefined();
    expect(p.paymentState).toBeUndefined();
  });

  it("fails hard when an on-chain reserve is unpaid (402) and no signer is present", async () => {
    const { fn } = fakeFetch({ paidReserve: false, challengeBody: CHALLENGE }); // 402 on first reserve
    vi.stubGlobal("fetch", fn);

    const orch = new MediaOrchestrator({ orchBase: "http://orch" }); // no signer
    await expect(orch.provision()).rejects.toThrow(/402 Payment Required/);
  });
});

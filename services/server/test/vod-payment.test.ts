import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestratorAdapter } from "../src/livepeer-adapter";
import { loadConfig } from "../src/config";
import type { SignerClient, LivePayment } from "@highlights/livepeer-session";

/** Minimal cfg for the adapter: only the orchestrator URL matters here. */
function cfg(env: Record<string, string> = {}) {
  return loadConfig({ ORCHESTRATOR_URL: "http://orch", ...env });
}

// VOD submissions pay the orchestrator through the SAME on-chain path the live
// media server uses. Regression for ADAAAA-3192: before this, the server's VOD
// adapter called reservePerceive() with NO payer address, so the on-chain
// orchestrator's live-runner payment validation returned
// `invalid live runner payment signer address` (HTTP 402) and VOD was blocked.

// go-livepeer `liveRunnerPaymentChallengeResponse` shape (server/ai_http.go).
const CHALLENGE = {
  payment_params: "b3JjaC1pbmZv", // base64 net.OrchestratorInfo
  orchestrator: "http://orch",
  manifest_id: "sess-abc", // AuthToken.SessionId
  payment_url: "http://orch/apps/highlights-perceive/session/sess-abc/payment",
};

const PAYER = "0x68d6FF3938Ff63d2df16567Cb8CA9772e14496F7";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeFetch(opts: { paidReserve?: boolean; paidDecide?: boolean; challengeBody?: any } = {}) {
  let reserveCalls = 0;
  let decideCalls = 0;
  const log: Array<{ url: string; headers: Record<string, string>; method: string }> = [];
  return {
    fn: vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      const headers = { ...((init?.headers as any) || {}) };
      log.push({ url, headers, method: init?.method || "GET" });
      if (url.endsWith("/apps/highlights-perceive/session")) {
        reserveCalls++;
        if (reserveCalls === 1 && !opts.paidReserve) {
          return jsonResponse(402, opts.challengeBody ?? { error: "payment required" });
        }
        return jsonResponse(200, {
          session_id: "sess-pay",
          app_url: "http://orch/app",
          control_url: "http://orch/ctl",
        });
      }
      if (url.endsWith("/apps/highlights-decide/app/highlight")) {
        decideCalls++;
        // The single-shot decide runner 402s once with the payment challenge,
        // then accepts the retry carrying Livepeer-Payment/Livepeer-Segment.
        if (decideCalls === 1 && !opts.paidDecide) {
          return jsonResponse(402, opts.challengeBody ?? { error: "payment required" });
        }
        return jsonResponse(200, { decision: "make_clip" });
      }
      if (url.includes("/payment")) return jsonResponse(200, { ok: true });
      if (url.endsWith("/stop")) return new Response(null, { status: 204 });
      return jsonResponse(404, { error: "nf" });
    }),
    log,
  };
}

const generatePaymentCalls: Array<{ orchInfoB64: unknown; prev: unknown; opts: any }> = [];
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
    return {
      payment: "livepeer-payment-ticket",
      segCreds: "segment-creds",
      signerState: { State: "c3RhdGU=", Sig: "c2ln" },
    };
  },
};

beforeEach(() => {
  generatePaymentCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OrchestratorAdapter (VOD) on-chain payment", () => {
  it("passes a real payer address and pays via the remote signer so the orchestrator no longer rejects the signer", async () => {
    const { fn, log } = fakeFetch({ paidReserve: false, challengeBody: CHALLENGE });
    vi.stubGlobal("fetch", fn);

    const adapter = new OrchestratorAdapter(cfg(), {
      signer: fakeSigner,
      payerAddress: PAYER,
    });

    const r = await adapter.reservePerceive();

    const reserves = log.filter((c) => c.url.endsWith("/apps/highlights-perceive/session"));
    expect(reserves).toHaveLength(2);
    // Every reserve advertises the signer's payer address (this was the missing
    // header that made the orchestrator return `invalid live runner payment signer address`).
    expect(reserves[0].headers["Livepeer-Payer-Address"]).toBe(PAYER);
    expect(reserves[1].headers["Livepeer-Payer-Address"]).toBe(PAYER);
    // The paid retry carried the signer's Livepeer-Payment / Livepeer-Segment.
    expect(reserves[1].headers["Livepeer-Payment"]).toBe("livepeer-payment-ticket");
    expect(reserves[1].headers["Livepeer-Segment"]).toBe("segment-creds");

    expect(r.sessionId).toBe("sess-pay");

    // The signer received the 402 challenge's base64 OrchestratorInfo + manifest id.
    // (The payment refresher may have re-issued tickets on later ticks, so the
    // FIRST call is the reserve payment — that is the one that must carry the
    // challenge's orch info + null prev-state.)
    expect(generatePaymentCalls.length).toBeGreaterThanOrEqual(1);
    expect(generatePaymentCalls[0].orchInfoB64).toBe("b3JjaC1pbmZv");
    expect(generatePaymentCalls[0].prev).toBe(null);
    expect(generatePaymentCalls[0].opts.manifestID).toBe("sess-abc");
    expect(generatePaymentCalls[0].opts.app).toBe("highlights-perceive");
    expect(generatePaymentCalls[0].opts.type).toBe("live");

    // stopPerceive stops the session (and the payment refresher).
    await adapter.stopPerceive(r.sessionId);
    const stops = log.filter((c) => c.url.endsWith(`/apps/highlights-perceive/session/${r.sessionId}/stop`));
    expect(stops.length).toBeGreaterThan(0);
  });

  it("stays offchain (one unpaid reserve, no payer) when no signer is configured", async () => {
    const { fn, log } = fakeFetch({ paidReserve: true }); // orchestrator never 402s
    vi.stubGlobal("fetch", fn);

    const adapter = new OrchestratorAdapter(cfg()); // no signer, no payer
    const r = await adapter.reservePerceive();

    const reserves = log.filter((c) => c.url.endsWith("/apps/highlights-perceive/session"));
    expect(reserves).toHaveLength(1);
    expect(reserves[0].headers["Livepeer-Payment"]).toBeUndefined();
    expect(reserves[0].headers["Livepeer-Payer-Address"]).toBeUndefined();
    expect(r.sessionId).toBe("sess-pay");
    expect(generatePaymentCalls).toHaveLength(0);
  });

  it("fails hard when an on-chain reserve 402s and there is no signer to pay", async () => {
    const { fn } = fakeFetch({ paidReserve: false, challengeBody: CHALLENGE });
    vi.stubGlobal("fetch", fn);

    const adapter = new OrchestratorAdapter(cfg()); // no signer
    await expect(adapter.reservePerceive()).rejects.toThrow(/402 Payment Required/);
  });

  it("pays the single-shot decide runner via the remote signer on 402 (regression: decide-path 402)", async () => {
    const { fn, log } = fakeFetch({ paidReserve: true, challengeBody: CHALLENGE });
    vi.stubGlobal("fetch", fn);

    const adapter = new OrchestratorAdapter(cfg(), {
      signer: fakeSigner,
      payerAddress: PAYER,
    });

    const res = await adapter.decide(
      { eventType: "KILL", trackCount: 1, maxVelocity: 0, ocrHits: 0 },
      { gameHint: "final" }
    );

    const decideCalls = log.filter((c) => c.url.endsWith("/apps/highlights-decide/app/highlight"));
    // First unpaid decide 402s with the challenge; the paid retry succeeds.
    expect(decideCalls).toHaveLength(2);
    // Every decide advertises the signer's payer address (this is what the
    // orchestrator validated to return `invalid live runner payment signer address`).
    expect(decideCalls[0].headers["Livepeer-Payer-Address"]).toBe(PAYER);
    expect(decideCalls[0].headers["Livepeer-Payment"]).toBeUndefined();
    // The paid retry carried the signer's Livepeer-Payment / Livepeer-Segment.
    expect(decideCalls[1].headers["Livepeer-Payment"]).toBe("livepeer-payment-ticket");
    expect(decideCalls[1].headers["Livepeer-Segment"]).toBe("segment-creds");

    // The signer got the fixed-price request with the 402 challenge's orch info + manifest id.
    const fixed = generatePaymentCalls.filter((c) => c.opts.type === "fixed");
    expect(fixed.length).toBeGreaterThanOrEqual(1);
    expect(fixed[fixed.length - 1].orchInfoB64).toBe("b3JjaC1pbmZv");
    expect(fixed[fixed.length - 1].prev).toBe(null);
    expect(fixed[fixed.length - 1].opts.app).toBe("highlights-decide");
    expect(fixed[fixed.length - 1].opts.manifestID).toBe("sess-abc");

    expect(res).toEqual({ decision: "make_clip" });
  });
});

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { MediaOrchestrator } from "../src/orch";
import type { SignerClient, LivePayment } from "@highlights/livepeer-session";

// The orchestrator's transport is injected as `_req` (real fetch). We stub
// global.fetch to simulate an ON-CHAIN orchestrator: the first reserve returns
// 402 (payment required), the paid retry returns 200, then analyze opens the
// trickle channels and stats reports them.
const appUrl = "http://orch/apps/highlights-perceive/session/sess-pay";
const controlUrl = "http://orch/apps/highlights-perceive/session/sess-pay/control";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeFetch(opts: { paidReserve?: boolean }) {
  let reserveCalls = 0;
  const gotHeaders: Array<Record<string, string>> = [];
  return vi.fn(async (input: any) => {
    const url = String(input);
    if (url.endsWith("/apps/highlights-perceive/session")) {
      reserveCalls++;
      const h = (input?.headers as any) || {};
      gotHeaders.push({ ...h });
      if (reserveCalls === 1 && !opts.paidReserve) {
        return jsonResponse(402, { error: "payment required", params: {} });
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
  });
}

// Records the orchestrator info + state each generateLivePayment receives, so
// the test can prove the wire fix (a real base64 net.OrchestratorInfo is sent,
// NOT null as in the pre-fix bug that caused "400 missing orchestrator").
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
    opts: { app?: string; type?: "live" | "lv2v" | "fixed"; inPixels?: number } = {}
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
  it("retries the reserve with signer payment material and seeds the refresh state", async () => {
    const fetchMock = fakeFetch({ paidReserve: false });
    vi.stubGlobal("fetch", fetchMock);

    const orch = new MediaOrchestrator({
      orchBase: "http://orch",
      signer: fakeSigner,
      payerAddress: "0x68d6FF3938Ff63d2df16567Cb8CA9772e14496F7",
      orchInfoB64Provider: async () => "b3JjaC1pbmZv", // base64 net.OrchestratorInfo
    });

    const p = await orch.provision();

    expect(fetchMock).toHaveBeenCalledTimes(4); // reserve(402) + reserve(paid) + analyze + stats
    // The paid retry carried the signer's Livepeer-Payment / Livepeer-Segment.
    const payHeader = gotHeader(fetchMock, "Livepeer-Payment");
    expect(payHeader).toBe("livepeer-payment-ticket");
    expect(gotHeader(fetchMock, "Livepeer-Segment")).toBe("segment-creds");
    // Payer address advertised on both reserves.
    expect(gotHeader(fetchMock, "Livepeer-Payer-Address")).toBe("0x68d6FF3938Ff63d2df16567Cb8CA9772e14496F7");

    expect(p.sessionId).toBe("sess-pay");
    expect(p.videoIn).toContain("/trickle/video-in");
    expect(p.eventsOut).toContain("/trickle/events-out");
    // WIRE FIX: the signer received the real orchestrator info (base64
    // net.OrchestratorInfo), NOT null — the bug that caused "400 missing
    // orchestrator" on every paid reserve.
    expect(generatePaymentCalls).toHaveLength(1);
    expect(generatePaymentCalls[0].orchInfoB64).toBe("b3JjaC1pbmZv");
    expect(generatePaymentCalls[0].prev).toBe(null); // first payment: no state yet
    // The signer state from the paid reserve is seeded for the refresher, and
    // the orchestrator info is carried onto the session so the refresher can
    // re-issue tickets without refetching.
    expect(p.paymentState).toEqual({ State: "c3RhdGU=", Sig: "c2ln" });
    expect(p.orchInfoB64).toBe("b3JjaC1pbmZv");
  });

  it("fails hard with a clear error when an on-chain 402 needs orchestrator info but no provider is configured", async () => {
    const fetchMock = fakeFetch({ paidReserve: false }); // 402 on first reserve
    vi.stubGlobal("fetch", fetchMock);

    const orch = new MediaOrchestrator({
      orchBase: "http://orch",
      signer: fakeSigner, // on-chain path, but no orchInfoB64Provider
    });
    await expect(orch.provision()).rejects.toThrow(/orchInfoB64Provider/);
  });

  it("stays offchain (one unpaid reserve, no signer payment) when no signer is configured", async () => {
    const fetchMock = fakeFetch({ paidReserve: true }); // never 402s
    vi.stubGlobal("fetch", fetchMock);

    const orch = new MediaOrchestrator({ orchBase: "http://orch" }); // no signer, no payer
    const p = await orch.provision();

    expect(fetchMock).toHaveBeenCalledTimes(3); // reserve(200) + analyze + stats
    expect(gotHeader(fetchMock, "Livepeer-Payment")).toBeUndefined();
    expect(gotHeader(fetchMock, "Livepeer-Payer-Address")).toBeUndefined();
    expect(p.paymentState).toBeUndefined();
  });

  it("fails hard when an on-chain reserve is unpaid (402) and no signer is present", async () => {
    const fetchMock = fakeFetch({ paidReserve: false }); // 402 on first reserve
    vi.stubGlobal("fetch", fetchMock);

    const orch = new MediaOrchestrator({ orchBase: "http://orch" }); // no signer
    await expect(orch.provision()).rejects.toThrow(/402 Payment Required/);
  });
});

function gotHeader(fetchMock: ReturnType<typeof vi.fn>, name: string): string | undefined {
  for (const call of fetchMock.mock.calls) {
    // fetch(url, init) -> headers live in init (call[1]); fall back to input.
    const h = (call[1]?.headers as any) || (call[0]?.headers as any) || {};
    if (h[name] != null) return h[name];
  }
  return undefined;
}

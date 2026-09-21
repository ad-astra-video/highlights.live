
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { MediaOrchestrator, DEFAULT_STREAM_PIXELS_PER_SEC } from "../src/orch";
import { NoTicketsError, RefreshSessionError } from "@highlights/livepeer-session";
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
    // The payment refresh POSTs a ticket to {controlUrl}/payment; a real
    // (successful) refresh must get a 200 back so the loop keeps ticking.
    if (url.endsWith("/control/payment")) {
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
  it("retries the reserve with signer payment material and seeds the refresh state", async () => {
    const fetchMock = fakeFetch({ paidReserve: false });
    vi.stubGlobal("fetch", fetchMock);

    const orch = new MediaOrchestrator({
      orchBase: "http://orch",
      signer: fakeSigner,
      payerAddress: "0x68d6FF3938Ff63d2df16567Cb8CA9772e14496F7",
      // Returns the base64 net.OrchestratorInfo + the AuthToken.SessionId the
      // live payment's manifestID must match (go-livepeer rejects a mismatch
      // with `403 mismatched manifest and auth token`).
      orchInfoProvider: async () => ({
        b64: "b3JjaC1pbmZv",
        sessionId: "sess-abc",
      }),
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
    // WIRE FIX #2: the live payment carries the orchestrator's AuthToken
    // SessionId as manifestID — without it the orchestrator returns
    // `403 mismatched manifest and auth token`.
    expect((generatePaymentCalls[0].opts as any).manifestID).toBe("sess-abc");
    // The signer state from the paid reserve is seeded for the refresher, and
    // the orchestrator info + sessionId are carried onto the session so the
    // refresher can re-issue tickets without refetching.
    expect(p.paymentState).toEqual({ State: "c3RhdGU=", Sig: "c2ln" });
    expect(p.orchInfoB64).toBe("b3JjaC1pbmZv");
    expect(p.orchInfoSessionId).toBe("sess-abc");
  });

  it("refreshes orchestrator info + retries once when the signer returns a 480 (expired auth token)", async () => {
    const fetchMock = fakeFetch({ paidReserve: false }); // 402 on first reserve
    vi.stubGlobal("fetch", fetchMock);

    const providerCalls: boolean[] = []; // true = force refresh
    // A custom signer that 480s on the FIRST generateLivePayment (expired
    // token) and succeeds on the retry with the fresh orch info.
    const signer480: SignerClient = {
      ...fakeSigner,
      generateLivePayment: (async (orchInfoB64: string, prev: unknown, opts: any = {}) => {
        generatePaymentCalls.push({ orchInfoB64, prev, opts });
        if (generatePaymentCalls.length === 1) {
          throw new RefreshSessionError("http://orch");
        }
        return { payment: "paid-ticket", segCreds: "seg", signerState: { State: "c3RhdGU=", Sig: "c2ln" } };
      }) as SignerClient["generateLivePayment"],
    };

    const orch = new MediaOrchestrator({
      orchBase: "http://orch",
      signer: signer480,
      payerAddress: "0x68d6FF3938Ff63d2df16567Cb8CA9772e14496F7",
      orchInfoProvider: async (force = false) => {
        providerCalls.push(force);
        // First (cached) fetch returns an info whose auth token has already
        // expired; the forced refresh returns a fresh token + sessionId.
        return providerCalls.length === 1
          ? { b64: "ZXhwLXRva2Vu", sessionId: "sess-expired" }
          : { b64: "ZnJlc2gtdG9rZW4=", sessionId: "sess-fresh" };
      },
    });

    const p = await orch.provision();

    // The signer was asked twice: once with the expired token (480) and once
    // with the forcibly-refreshed (fresh) orch info.
    expect(generatePaymentCalls).toHaveLength(2);
    expect(generatePaymentCalls[0].orchInfoB64).toBe("ZXhwLXRva2Vu");
    expect(generatePaymentCalls[1].orchInfoB64).toBe("ZnJlc2gtdG9rZW4=");
    expect(providerCalls).toContain(true); // a force refresh happened
    // The successful paid retry carried the fresh sessionId as manifestID.
    expect((generatePaymentCalls[1].opts as any).manifestID).toBe("sess-fresh");
    expect(p.sessionId).toBe("sess-pay");
    expect(p.orchInfoB64).toBe("ZnJlc2gtdG9rZW4=");
    expect(p.orchInfoSessionId).toBe("sess-fresh");
  });

  it("fails hard with a clear error when an on-chain 402 needs orchestrator info but no provider is configured", async () => {
    const fetchMock = fakeFetch({ paidReserve: false }); // 402 on first reserve
    vi.stubGlobal("fetch", fetchMock);

    const orch = new MediaOrchestrator({
      orchBase: "http://orch",
      signer: fakeSigner, // on-chain path, but no orchInfoProvider
    });
    await expect(orch.provision()).rejects.toThrow(/orchInfoProvider/);
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

describe("MediaOrchestrator on-chain ticket sizing + cadence", () => {
  it("sizes each live top-up to the next window's pixel burn (streamPixelsPerSec × interval)", async () => {
    vi.useFakeTimers();
    const fetchMock = fakeFetch({ paidReserve: false }); // 402 first reserve
    vi.stubGlobal("fetch", fetchMock);

    const orch = new MediaOrchestrator({
      orchBase: "http://orch",
      signer: fakeSigner,
      payerAddress: "0x68d6FF3938Ff63d2df16567Cb8CA9772e14496F7",
      streamPixelsPerSec: 1920 * 1080 * 30, // 1080p30
      paymentIntervalMs: 5_000, // orchestrator charges every 5s
      orchInfoProvider: async () => ({ b64: "b3JjaC1pbmZv", sessionId: "sess-abc" }),
    });
    const p = await orch.provision();
    generatePaymentCalls.length = 0; // ignore the reserve tick

    await orch.startPayment(p);
    await vi.advanceTimersByTimeAsync(5_000); // one full advertised window
    const tick = generatePaymentCalls[generatePaymentCalls.length - 1];
    orch.stopPayment(p.sessionId);
    vi.useRealTimers();

    // Each refresh top-up = round(streamPixelsPerSec * intervalMs / 1000).
    const expectedInPixels = Math.round((1920 * 1080 * 30 * 5_000) / 1000);
    expect(tick).toBeDefined();
    expect((tick.opts as any).inPixels).toBe(expectedInPixels);
    // Chronically over-funding guard: sized to ONE window, not a large multiple.
    expect(expectedInPixels).toBeLessThan(1920 * 1080 * 30 * 60);
  });

  it("drives cadence from the orchestrator's announced payment interval (fallback 10s)", async () => {
    vi.useFakeTimers();
    const fetchMock = fakeFetch({ paidReserve: false });
    vi.stubGlobal("fetch", fetchMock);

    const orch = new MediaOrchestrator({
      orchBase: "http://orch",
      signer: fakeSigner,
      payerAddress: "0x68d6FF3938Ff63d2df16567Cb8CA9772e14496F7",
      orchInfoProvider: async () => ({ b64: "b3JjaC1pbmZv", sessionId: "sess-abc", paymentIntervalMs: 3_000 }),
    });
    const p = await orch.provision();
    generatePaymentCalls.length = 0;
    await orch.startPayment(p); // immediate tick (cadence measured from here)
    const startCount = generatePaymentCalls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    const announced3sRefreshes = generatePaymentCalls.length - startCount;
    orch.stopPayment(p.sessionId);
    vi.useRealTimers();

    // In 6s at the announced 3s cadence we get ~2 refresh ticks; at the 10s
    // default fallback we'd get ~0-1. Proves the refresh loop used the
    // orchestrator's announced interval, not the hardcoded 10s.
    expect(announced3sRefreshes).toBeGreaterThanOrEqual(2);
  });

  it("treats a signer 482 'no payment needed' as benign (no teardown, session continues)", async () => {
    vi.useFakeTimers();
    const fetchMock = fakeFetch({ paidReserve: false });
    vi.stubGlobal("fetch", fetchMock);

    const failures: string[] = [];
    let signerCalls = 0;
    const noTicketsSigner: SignerClient = {
      ...fakeSigner,
      generateLivePayment: (async (orchInfoB64: string, prev: unknown, opts: any = {}) => {
        signerCalls++;
        generatePaymentCalls.push({ orchInfoB64, prev, opts });
        // Reserve (call 1) needs a real ticket; 482 only during the refresh loop.
        if (signerCalls > 1) throw new NoTicketsError();
        return { payment: "paid-ticket", segCreds: "seg", signerState: { State: "c3RhdGU=", Sig: "c2ln" } };
      }) as SignerClient["generateLivePayment"],
    };
    const orch = new MediaOrchestrator({
      orchBase: "http://orch",
      signer: noTicketsSigner,
      payerAddress: "0x68d6FF3938Ff63d2df16567Cb8CA9772e14496F7",
      onPaymentFailure: (_sid: string, e: Error) => failures.push(e.message),
      orchInfoProvider: async () => ({ b64: "b3JjaC1pbmZv", sessionId: "sess-abc" }),
    });
    const p = await orch.provision();
    const beforeCalls = generatePaymentCalls.length;

    // A benign 482 on every refresh: loop keeps ticking, never calls onPaymentFailure.
    await orch.startPayment(p);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failures).toHaveLength(0); // no teardown despite repeated 482s
    expect(generatePaymentCalls.length).toBeGreaterThan(beforeCalls); // kept refreshing
    orch.stopPayment(p.sessionId);
    vi.useRealTimers();
  });

  it("still tears down on a real (non-482) payment failure", async () => {
    vi.useFakeTimers();
    const fetchMock = fakeFetch({ paidReserve: false });
    vi.stubGlobal("fetch", fetchMock);

    const failures: string[] = [];
    let failingCalls = 0;
    const failingSigner: SignerClient = {
      ...fakeSigner,
      generateLivePayment: (async (orchInfoB64: string, prev: unknown, opts: any = {}) => {
        failingCalls++;
        // Reserve (call 1) needs a real ticket; fail only during the refresh loop.
        if (failingCalls > 1) throw new Error("orchestrator rejected /payment HTTP 500");
        return { payment: "paid-ticket", segCreds: "seg", signerState: { State: "c3RhdGU=", Sig: "c2ln" } };
      }) as SignerClient["generateLivePayment"],
    };
    const orch = new MediaOrchestrator({
      orchBase: "http://orch",
      signer: failingSigner,
      payerAddress: "0x68d6FF3938Ff63d2df16567Cb8CA9772e14496F7",
      onPaymentFailure: (_sid: string, e: Error) => failures.push(e.message),
      orchInfoProvider: async () => ({ b64: "b3JjaC1pbmZv", sessionId: "sess-abc" }),
    });
    const p = await orch.provision();
    await orch.startPayment(p);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(failures.length).toBeGreaterThan(0); // real failure IS fatal
    orch.stopPayment(p.sessionId);
    vi.useRealTimers();
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
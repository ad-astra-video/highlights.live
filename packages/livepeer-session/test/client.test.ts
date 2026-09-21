import { describe, it, expect, vi } from "vitest";
import { LivepeerClient, PaymentRequiredError, ROUTES, type SignerClient, type Transport } from "../src/index";

class MockTransport implements Transport {
  calls: { method: string; url: string; headers?: Record<string, string>; body?: unknown }[] = [];
  responses: Array<any> = [];
  constructor(responses: Array<any>) {
    this.responses = responses;
  }
  async request(method: string, url: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}) {
    this.calls.push({ method, url, headers: init.headers, body: init.body });
    const r = this.responses.shift() ?? { status: 200, data: {} };
    return {
      status: r.status,
      headers: new Headers(),
      async json() {
        return r.data;
      },
      async text() {
        return typeof r.data === "string" ? r.data : JSON.stringify(r.data);
      },
    };
  }
}

describe("LivepeerClient", () => {
  it("reserves a perceive session and parses returned URLs", async () => {
    const t = new MockTransport([
      { status: 200, data: { session_id: "sess-1", app_url: "http://x/apps/highlights-perceive/session/sess-1", control_url: "http://x/apps/highlights-perceive/session/sess-1/control" } },
    ]);
    const c = new LivepeerClient("http://orch:8935", t);
    const r = await c.reservePerceive();
    expect(r.sessionId).toBe("sess-1");
    expect(t.calls[0]).toMatchObject({ method: "POST", url: `/apps/${ROUTES.perceive}/session` });
  });

  it("throws PaymentRequiredError on 402 with the challenge parsed from the body", async () => {
    const t = new MockTransport([
      {
        status: 402,
        data: { payment_params: "b3JjaA==", orchestrator: "http://orch", manifest_id: "sess-abc", payment_url: "http://orch/pay" },
      },
    ]);
    const c = new LivepeerClient("http://orch:8935", t);
    try {
      await c.reservePerceive();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentRequiredError);
      const e = err as PaymentRequiredError;
      // go-livepeer carries the OrchestratorInfo in the 402 challenge body — the
      // payer forwards these to the signer rather than dialing the orchestrator.
      expect(e.challenge?.paymentParams).toBe("b3JjaA==");
      expect(e.challenge?.manifestId).toBe("sess-abc");
      expect(e.challenge?.orchestrator).toBe("http://orch");
      expect(e.challenge?.paymentUrl).toBe("http://orch/pay");
    }
  });

  it("throws on unexpected errors", async () => {
    const t = new MockTransport([{ status: 500, data: "boom" }]);
    const c = new LivepeerClient("http://orch", t);
    await expect(c.reservePerceive()).rejects.toThrow(/500/);
  });

  it("appCall proxies to the persistent session app path", async () => {
    const t = new MockTransport([{ status: 200, data: { ok: true } }]);
    const c = new LivepeerClient("http://orch", t);
    const res = await c.appCall<{ ok: boolean }>("sess-9", "analyze", { method: "POST", headers: { "Content-Type": "application/json" } });
    expect(res.data.ok).toBe(true);
    expect(t.calls[0].url).toBe(`/apps/${ROUTES.perceive}/session/sess-9/app/analyze`);
    expect(t.calls[0].method).toBe("POST");
    expect(t.calls[0].headers?.["Content-Type"]).toBe("application/json");
  });

  it("decide posts single-shot to the decide runner app path", async () => {
    const t = new MockTransport([{ status: 200, data: { isHighlight: true, score: 80 } }]);
    const c = new LivepeerClient("http://orch", t);
    const res = await c.decide("highlight", { eventType: "KILL" });
    expect((res.data as any).isHighlight).toBe(true);
    expect(t.calls[0].url).toBe(`/apps/${ROUTES.decide}/app/highlight`);
    expect(t.calls[0].method).toBe("POST");
  });

  it("stopPerceive handles 204", async () => {
    const t = new MockTransport([{ status: 204, data: "" }]);
    const c = new LivepeerClient("http://orch", t);
    await c.stopPerceive("sess-1");
    expect(t.calls[0].url).toContain(`/apps/${ROUTES.perceive}/session/sess-1/stop`);
  });

  it("refreshPerceivePayment no-ops when no signer", async () => {
    const t = new MockTransport([]);
    const c = new LivepeerClient("http://orch", t);
    const out = await c.refreshPerceivePayment("s1", "http://c/payment");
    expect(out).toBeNull();
    expect(t.calls.length).toBe(0);
  });

  it("refreshPerceivePayment uses signer when present", async () => {
    const t = new MockTransport([{ status: 200, data: { ok: true } }]);
    const c = new LivepeerClient("http://orch", t);
    const refreshOpts: unknown[] = [];
    const signer: SignerClient = {
      async discover() {
        return [];
      },
      async signOrchInfo() {
        return { a: 1 };
      },
      async generateLivePayment(_b64: string, _prev: unknown, opts: unknown = {}) {
        refreshOpts.push(opts);
        return { payment: "P", segCreds: "S", signerState: { State: "c3RhdGU=", Sig: "c2ln" } };
      },
    };
    // The 4th arg is now the base64 net.OrchestratorInfo (go-livepeer requires
    // it in every /generate-live-payment call); the 5th is the opaque state.
    const out = await c.refreshPerceivePayment("s1", "http://c", signer, "b3JjaA==", null);
    expect(out).toMatchObject({ State: "c3RhdGU=", Sig: "c2ln" });
    expect(t.calls[0].url).toBe("http://c/payment");
    expect(t.calls[0].headers).toMatchObject({ "Livepeer-Payment": "P", "Livepeer-Segment": "S" });
    // Refresh must restate the app (ROUTES.perceive) or the signer rejects the
    // established state with `400 app mismatch`.
    expect(refreshOpts).toEqual([{ app: ROUTES.perceive, type: "live", manifestID: undefined }]);
  });
});

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

  it("throws PaymentRequiredError on 402", async () => {
    const t = new MockTransport([{ status: 402, data: { err: "payment" } }]);
    const c = new LivepeerClient("http://orch:8935", t);
    await expect(c.reservePerceive()).rejects.toBeInstanceOf(PaymentRequiredError);
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
    const signer: SignerClient = {
      async discover() {
        return [];
      },
      async signOrchInfo() {
        return { a: 1 };
      },
      async generateLivePayment() {
        return { payment: "P", segCreds: "S", signerState: { st: 2 } };
      },
    };
    const out = await c.refreshPerceivePayment("s1", "http://c", signer, { st: 1 });
    expect(out).toMatchObject({ st: 2 });
    expect(t.calls[0].url).toBe("http://c/payment");
    expect(t.calls[0].headers).toMatchObject({ "Livepeer-Payment": "P", "Livepeer-Segment": "S" });
  });
});

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

  it("reservePerceive retries a transient 503 no-capacity and succeeds (ADAAAA-6619)", async () => {
    // The capacity-1 perceive runner is momentarily contended by a concurrent
    // job -> `503 no capacity available for runner`. This is a momentary slot
    // collision (request NOT routed), so the reserve is retried with backoff
    // rather than failing the whole VOD/live job at reserve time.
    const t = new MockTransport([
      { status: 503, data: "no capacity available for runner" },
      { status: 200, data: { session_id: "sess-1", app_url: "http://x/apps/highlights-perceive/session/sess-1", control_url: "http://x/apps/highlights-perceive/session/sess-1/control" } },
    ]);
    const c = new LivepeerClient("http://orch:8935", t);
    const r = await c.reservePerceive();
    expect(r.sessionId).toBe("sess-1");
    expect(t.calls.length).toBe(2);
    expect(t.calls[0].url).toBe(`/apps/${ROUTES.perceive}/session`);
    expect(t.calls[1].url).toBe(`/apps/${ROUTES.perceive}/session`);
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

  it("decide retries a transient 404 runner-not-found (orchestrator health flap) and returns the success", async () => {
    const t = new MockTransport([
      { status: 404, data: "runner not found" },
      { status: 200, data: { isHighlight: true, score: 80 } },
    ]);
    const c = new LivepeerClient("http://orch", t);
    const res = await c.decide("highlight", { eventType: "GOAL" });
    expect((res.data as any).isHighlight).toBe(true);
    expect(t.calls.length).toBe(2);
    expect(t.calls[0].url).toBe(`/apps/${ROUTES.decide}/app/highlight`);
    expect(t.calls[1].url).toBe(`/apps/${ROUTES.decide}/app/highlight`);
  });

  it("decide retries a transient 404 session not found (session-lost, ADAAAA-6623) and returns the success", async () => {
    // go-livepeer released the decide runner's session on a flap / orchestrator
    // restart -> 404 "runner session not found". The old `/runner not found/i`
    // regex did NOT match this phrasing (the word `session` sits between
    // `runner` and `not found`), so the decide call returned immediately and
    // dropped the candidate — the same class of symptom the perceive path fix
    // (ADAAAA-6577) targeted. A 404 means the request was not routed/processed,
    // so retrying with bounded backoff cannot double-bill or double-persist a
    // highlight.
    const t = new MockTransport([
      { status: 404, data: "runner session not found" },
      { status: 404, data: "session not found" },
      { status: 200, data: { isHighlight: true, score: 80 } },
    ]);
    const c = new LivepeerClient("http://orch", t);
    const res = await c.decide("highlight", { eventType: "GOAL" });
    expect((res.data as any).isHighlight).toBe(true);
    expect(t.calls.length).toBe(3);
    expect(t.calls[0].url).toBe(`/apps/${ROUTES.decide}/app/highlight`);
    expect(t.calls[2].url).toBe(`/apps/${ROUTES.decide}/app/highlight`);
  });

  it("decide does NOT retry a genuine 404 (non runner-not-found) and returns it", async () => {
    const t = new MockTransport([{ status: 404, data: { error: "unknown app route" } }]);
    const c = new LivepeerClient("http://orch", t);
    const res = await c.decide("nope", { eventType: "GOAL" });
    expect(res.status).toBe(404);
    expect(t.calls.length).toBe(1);
  });

  it("decide backs off exponentially 500ms->1s->2s->4s on runner-not-found (ADAAAA-6709)", async () => {
    // ADAAAA-6709 fidelity: a flapping decide runner 404s every call; the retry
    // must idle near ~1 req/sec (exponential doubling from 500ms, cap 8s) rather
    // than hammering the orchestrator. We capture the scheduled setTimeout delay
    // and re-schedule at 0ms so the test runs fast but still asserts the cadence.
    const orig = globalThis.setTimeout;
    const delays: number[] = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms?: number, ...rest: any[]) => {
      if (typeof fn === "function") delays.push(Number(ms));
      return orig(fn as any, 0, ...rest) as any;
    });
    try {
      const t = new MockTransport([
        { status: 404, data: "runner not found" },
        { status: 404, data: "runner not found" },
        { status: 404, data: "runner not found" },
        { status: 404, data: "runner not found" },
        { status: 200, data: { isHighlight: true, score: 80 } },
      ]);
      const c = new LivepeerClient("http://orch", t, { decideBackoffBaseMs: 500, decideMaxAttempts: 5 });
      const res = await c.decide("highlight", { eventType: "GOAL" });
      expect((res.data as any).isHighlight).toBe(true);
      expect(t.calls.length).toBe(5);
      expect(delays).toEqual([500, 1000, 2000, 4000]);
    } finally {
      spy.mockRestore();
    }
  });

  it("decide aborts cleanly with a clear error after bounded runner-not-found retries (ADAAAA-6709)", async () => {
    // All calls 404 "runner not found": the loop must NOT spin past the bound.
    // It should issue at most `decideMaxAttempts` requests and then throw a
    // clear error (so the job aborts without a tight/endless retry loop).
    const t = new MockTransport(Array.from({ length: 8 }, () => ({ status: 404, data: "runner not found" })));
    const c = new LivepeerClient("http://orch", t, { decideBackoffBaseMs: 1, decideMaxAttempts: 5 });
    await expect(c.decide("highlight", { eventType: "GOAL" })).rejects.toThrow(
      /decide runner unavailable after 5 attempts .*runner not found/
    );
    expect(t.calls.length).toBe(5);
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
    // ADAAAA-6575: refresh returns both the new signerState AND the OrchestratorInfo
    // it was signed against, so the caller can keep re-funding the same session.
    expect(out).toMatchObject({
      signerState: { State: "c3RhdGU=", Sig: "c2ln" },
      orchInfoB64: "b3JjaA==",
    });
    expect(t.calls[0].url).toBe("http://c/payment");
    expect(t.calls[0].headers).toMatchObject({ "Livepeer-Payment": "P", "Livepeer-Segment": "S" });
    // Refresh must restate the app (ROUTES.perceive) or the signer rejects the
    // established state with `400 app mismatch`.
    expect(refreshOpts).toEqual([{ app: ROUTES.perceive, type: "live", manifestID: undefined }]);
  });

  it("refreshPerceivePayment re-mints fresh info via /refresh-payment on signer HTTP 480 and re-signs", async () => {
    // First transport call = /refresh-payment (returns a fresh OrchestratorInfo);
    // second = the re-sign's POST to <controlUrl>/payment.
    const t = new MockTransport([
      // The orchestrator returns the challenge in the SAME snake_case shape as the
      // 402 reserve body (liveRunnerPaymentChallengeResponse: `payment_params`,
      // `manifest_id`, `orchestrator`). Parse it, don't cast to camelCase.
      { status: 200, data: { payment_params: "ZnJlc2g=", manifest_id: "sess-1", orchestrator: "http://orch" } },
      { status: 200, data: { ok: true } },
    ]);
    const c = new LivepeerClient("http://orch", t);
    const signedB64: string[] = [];
    const refreshOpts: unknown[] = [];
    let first = true;
    const signer: SignerClient = {
      async discover() {
        return [];
      },
      async signOrchInfo() {
        return { a: 1 };
      },
      async generateLivePayment(b64: string, _prev: unknown, opts: unknown = {}) {
        signedB64.push(b64);
        refreshOpts.push(opts);
        // First sign on the expired OrchestratorInfo -> the signer asks the payer
        // to refresh the session (HTTP 480); the caller re-mints info and tries once.
        if (first) {
          first = false;
          throw new Error("signer generateLivePayment failed: HTTP 480");
        }
        return { payment: "P", segCreds: "S", signerState: { State: "c3RhdGU=", Sig: "c2ln" } };
      },
    };
    const out = await c.refreshPerceivePayment(
      "s1",
      "http://c",
      signer,
      "b3JjaA==",
      null,
      "sess-1",
      "0xabc"
    );
    // The first sign (with the expired info) threw 480 -> /refresh-payment minted a
    // fresh OrchestratorInfo (ZnJlc2g=) -> the retry signed with it.
    expect(signedB64).toEqual(["b3JjaA==", "ZnJlc2g="]);
    expect(t.calls[0].url).toBe("/refresh-payment");
    expect(JSON.parse(t.calls[0].body as string)).toEqual({ sender: "0xabc", manifest_id: "sess-1" });
    expect(t.calls[1].url).toBe("http://c/payment");
    // The freshest OrchestratorInfo is returned so the caller persists it for the
    // next tick instead of re-using the expired one.
    expect(out).toMatchObject({
      signerState: { State: "c3RhdGU=", Sig: "c2ln" },
      orchInfoB64: "ZnJlc2g=",
    });
  });

  it("refreshPerceivePayment treats signer HTTP 482 (no new tickets needed) as a benign no-op, not a failure (ADAAAA-6588)", async () => {
    // 482 = the signer's committed reserve already covers the orchestrator's
    // minimum credit for the billable window; nothing new to POST to the
    // orchestrator. Must NOT throw and must NOT hit the <controlUrl>/payment
    // endpoint (there is no fresh ticket to deliver).
    const t = new MockTransport([]);
    const c = new LivepeerClient("http://orch", t);
    const signer: SignerClient = {
      async discover() {
        return [];
      },
      async signOrchInfo() {
        return { a: 1 };
      },
      async generateLivePayment() {
        throw new Error("signer generateLivePayment failed: HTTP 482");
      },
    };
    const out = await c.refreshPerceivePayment("s1", "http://c", signer, "b3JjaA==", null, "sess-1", "0xabc");
    // Benign no-op: no payment POST, fresh state not advanced (caller keeps the
    // last known-good state so the next tick still carries the funded reserves).
    expect(out).toBeNull();
    expect(t.calls.length).toBe(0);
  });

  it("refreshPerceivePayment treats signer HTTP 481 (price over ceiling) as a benign no-op, not a failure (ADAAAA-6588)", async () => {
    const t = new MockTransport([]);
    const c = new LivepeerClient("http://orch", t);
    const signer: SignerClient = {
      async discover() {
        return [];
      },
      async signOrchInfo() {
        return { a: 1 };
      },
      async generateLivePayment() {
        throw new Error("signer generateLivePayment failed: HTTP 481");
      },
    };
    const out = await c.refreshPerceivePayment("s1", "http://c", signer, "b3JjaA==", null, "sess-1", "0xabc");
    expect(out).toBeNull();
    expect(t.calls.length).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { HttpSignerClient, type Transport } from "../src/index";

const mkTransport = (routes: Record<string, (init?: any) => { status: number; body: unknown }>): Transport => {
  return {
    async request(method: string, url: string, init: any = {}) {
      const key = `${method} ${url}`;
      const handler = routes[key] || routes[`${method} *`];
      if (!handler) return { status: 404, headers: new Headers(), json: async () => ({}), text: async () => "nf" };
      return {
        status: handler(init).status,
        headers: new Headers(),
        json: async () => handler(init).body,
        text: async () => JSON.stringify(handler(init).body),
      };
    },
  };
};

describe("HttpSignerClient", () => {
  it("discover passes caps and parses runners", async () => {
    const t = mkTransport({
      "GET /discover-orchestrators?caps=highlights-live%2Fperceive&caps=highlights-live%2Fdecide": () => ({
        status: 200,
        body: [{ address: "0xabc", runners: [{ url: "http://o/app", app: "highlights-live/perceive", mode: "persistent" }] }],
      }),
    });
    const c = new HttpSignerClient("http://signer", t);
    const res = await c.discover(["highlights-live/perceive", "highlights-live/decide"]);
    expect(res[0].address).toBe("0xabc");
    expect(res[0].runners[0].app).toBe("highlights-live/perceive");
  });

  it("signOrchInfo posts the orchestrator address", async () => {
    let body: any;
    const t = mkTransport({
      "POST /sign-orchestrator-info": (init) => {
        body = JSON.parse(init.body);
        return { status: 200, body: { signed: "sig" } };
      },
    });
    const c = new HttpSignerClient("http://signer", t);
    await c.signOrchInfo("0xabc");
    expect(body.orchestrator).toBe("0xabc");
  });

  it("generateLivePayment sends the go-livepeer RemotePaymentRequest schema (regression: non-null orchestrator)", async () => {
    let body: any;
    const t = mkTransport({
      "POST /generate-live-payment": (init) => {
        body = JSON.parse(init.body);
        return {
          status: 200,
          body: { payment: "pay", segCreds: "seg", state: { State: "c3RhdGU=", Sig: "c2ln" } },
        };
      },
    });
    const c = new HttpSignerClient("http://signer", t);

    // First payment: omits `state`, but MUST include base64 `orchestrator`.
    const orchB64 = Buffer.from("net.OrchestratorInfo proto bytes").toString("base64");
    const p1 = await c.generateLivePayment(orchB64, null, { type: "live", app: "highlights-perceive" });
    expect(body.orchestrator).toBe(orchB64);
    expect(body.state).toBeUndefined();
    expect(body.type).toBe("live");
    expect(body.app).toBe("highlights-perceive");
    // OLD (buggy) shape must NOT be sent: no `orchInfo` / `prevState` keys.
    expect(body).not.toHaveProperty("orchInfo");
    expect(body).not.toHaveProperty("prevState");
    expect(p1.payment).toBe("pay");
    expect(p1.segCreds).toBe("seg");
    expect(p1.signerState).toEqual({ State: "c3RhdGU=", Sig: "c2ln" });

    // Refresh: passes the opaque signed state back verbatim.
    const p2 = await c.generateLivePayment(orchB64, p1.signerState);
    expect(body.state).toEqual({ State: "c3RhdGU=", Sig: "c2ln" });
    expect(body.orchestrator).toBe(orchB64);
    expect(p2.signerState).toEqual({ State: "c3RhdGU=", Sig: "c2ln" });
  });

  it("signaler surfaces a 400 (e.g. missing orchestrator) as generateLivePayment failed", async () => {
    const t = mkTransport({ "POST /generate-live-payment": () => ({ status: 400, body: { err: "missing orchestrator" } }) });
    const c = new HttpSignerClient("http://signer", t);
    await expect(c.generateLivePayment("b64", null)).rejects.toThrow(/HTTP 400/);
  });

  it("throws on non-200", async () => {
    const t = mkTransport({ "GET *": () => ({ status: 500, body: {} }) });
    const c = new HttpSignerClient("http://signer", t);
    await expect(c.discover(["x"])).rejects.toThrow(/500/);
  });
});

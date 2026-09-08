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

  it("generateLivePayment returns payment headers + state", async () => {
    const t = mkTransport({
      "POST /generate-live-payment": () => ({
        status: 200,
        body: { payment: "pay", segCreds: "seg", signerState: { n: 1 } },
      }),
    });
    const c = new HttpSignerClient("http://signer", t);
    const p = await c.generateLivePayment({ orch: 1 }, { prev: 0 });
    expect(p.payment).toBe("pay");
    expect(p.segCreds).toBe("seg");
    expect(p.signerState).toEqual({ n: 1 });
  });

  it("throws on non-200", async () => {
    const t = mkTransport({ "GET *": () => ({ status: 500, body: {} }) });
    const c = new HttpSignerClient("http://signer", t);
    await expect(c.discover(["x"])).rejects.toThrow(/500/);
  });
});

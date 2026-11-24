// ADAAAA-8196 (2/2): a CONFIGURABLE decide route list, so the client addresses
// the 5090 pool members directly instead of only through the nginx upstreams.
//
// AC coverage in this file:
//   AC-A1 a configured route list is unioned with the discovered pool: a route
//         discovery never mentions is still addressable (`/apps/<route>/app/...`),
//         and a configured route discovery DOES advertise keeps the measured
//         capacity/tier while keeping its configured weight/pool.
//   AC-A2 the weighted ranking is deterministic: a weight-2 route takes twice
//         the concurrent load of a weight-1 route, and equal weights reproduce
//         the ADAAAA-8559 rotation.
//   AC-A3 every attempt carries `X-Runner-Route` (the route it really posts to)
//         plus `X-Runner-Pool`/`X-Runner-Tier` when known, which is what lets the
//         serving worker echo runnerRoute/runnerHost for attribution.
//   AC-A4 UNSET config is byte-identical to ADAAAA-8559: with a dark discovery
//         the legacy `highlights-decide` id is posted, unchanged.
import { describe, it, expect } from "vitest";
import {
  LivepeerClient,
  ROUTES,
  summarizeDecideDiscovery,
  type DiscoveredRunner,
  type Transport,
} from "../src/index";

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Answers every request 200 and records url + headers. */
class RecordingTransport implements Transport {
  readonly calls: Call[] = [];
  /** When set, every request waits for it before answering (keeps attempts
   * in flight so the selection ranking is observable). */
  hold: Promise<void> | null = null;
  async request(_method: string, url: string, init: { headers?: Record<string, string>; body?: any } = {}) {
    this.calls.push({ url, headers: { ...(init.headers || {}) } });
    if (this.hold) await this.hold;
    const text = JSON.stringify({ ok: true });
    return {
      status: 200,
      headers: new Headers(),
      async json() {
        return JSON.parse(text);
      },
      async text() {
        return text;
      },
    };
  }
  urls(): string[] {
    return this.calls.map((c) => c.url);
  }
}

const registered = (id: string, capacity: number, tier: string): DiscoveredRunner => ({
  url: `https://orch.example:8935/apps/${id}/app`,
  app: "highlights-live/decide",
  capacity,
  capacity_available: capacity,
  metadata: JSON.stringify({ model: "gemma", engine: "vllm", tier, seqs: capacity }),
});

describe("ADAAAA-8196 AC-A1: configured routes are unioned with the discovered pool", () => {
  it("addresses a configured 5090 route directly while discovery is dark", async () => {
    const t = new RecordingTransport();
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 8,
      decideRoutes: [
        { route: "highlights-decide-5090-gpu1", tier: "5090", capacity: 4 },
        { route: "highlights-decide-5090-gpu2", tier: "5090", capacity: 4 },
      ],
    });
    await c.decide("highlight", { id: 1 });
    // The retired aggregate id is NEVER posted when routes are configured.
    expect(t.urls()).toEqual(["/apps/highlights-decide-5090-gpu1/app/highlight"]);
    expect(t.urls()[0]).not.toBe(`/apps/${ROUTES.decide}/app/highlight`);
  });

  it("keeps the discovered numbers for an advertised route and adds the un-advertised one", async () => {
    const t = new RecordingTransport();
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 8,
      decideCapacityProbe: async () =>
        summarizeDecideDiscovery([
          { runners: [registered("highlights-decide-5090-gpu1", 4, "x99-fallback")] },
        ]),
      decideRoutes: [
        // Discovery says gpu1 is an x99-fallback with capacity 4: the MEASURED
        // tier must win, so the other (configured, tier=5090) route is preferred.
        { route: "highlights-decide-5090-gpu1", tier: "5090", capacity: 99 },
        { route: "highlights-decide-5090-gpu2", tier: "5090", capacity: 1 },
      ],
    });
    await c.refreshDecideCapacity(true);
    await c.decide("highlight", { id: 1 });
    expect(t.urls()[0]).toBe("/apps/highlights-decide-5090-gpu2/app/highlight");
  });

  it("does not double-list a route that is both configured and advertised", async () => {
    const t = new RecordingTransport();
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 8,
      decideCapacityProbe: async () => summarizeDecideDiscovery([{ runners: [registered("decide-a", 2, "5090")] }]),
      decideRoutes: [{ route: "decide-a", tier: "5090", capacity: 2 }],
    });
    await c.refreshDecideCapacity(true);
    await c.decide("highlight", { id: 1 });
    await c.decide("highlight", { id: 2 });
    await c.decide("highlight", { id: 3 });
    expect(new Set(c.decideRunnerAttribution().map((a) => a.runner_id))).toEqual(new Set(["decide-a"]));
    expect(c.decideRunnerAttribution()).toHaveLength(1);
    expect(c.decideRunnerAttribution()[0]).toMatchObject({ runner_id: "decide-a", tier: "5090", served: 3 });
  });
});

describe("ADAAAA-8196 AC-A2: weighted least-loaded selection", () => {
  it("routes a weight-2 member twice per two weight-1 members under equal concurrency", async () => {
    const t = new RecordingTransport();
    // Hold every attempt open so all three picks happen with live in-flight
    // counters — that is exactly the state weighting has to rebalance.
    let release!: () => void;
    t.hold = new Promise<void>((r) => (release = r));
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 8,
      decideRoutes: [
        { route: "decide-a", tier: "5090", weight: 2 },
        { route: "decide-b", tier: "5090", weight: 1 },
      ],
    });
    const pending = [c.decide("highlight", { id: 1 }), c.decide("highlight", { id: 2 }), c.decide("highlight", { id: 3 })];
    await new Promise((r) => setTimeout(r, 30));
    release();
    await Promise.all(pending);
    const hits = t.urls().map((u) => u.match(/\/apps\/([^/]+)\/app/)?.[1]);
    // a: 0/2 -> pick; b: 0/1 vs a 1/2=0.5 -> pick; a 0.5 vs b 1 -> pick.
    expect(hits).toEqual(["decide-a", "decide-b", "decide-a"]);
  });

  it("reproduces the equal-weight rotation when weights are 1", async () => {
    const t = new RecordingTransport();
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 8,
      decideRoutes: [
        { route: "decide-a", tier: "5090" },
        { route: "decide-b", tier: "5090" },
      ],
    });
    await c.decide("highlight", { id: 1 });
    await c.decide("highlight", { id: 2 });
    expect(t.urls()).toEqual(["/apps/decide-a/app/highlight", "/apps/decide-b/app/highlight"]);
  });
});

describe("ADAAAA-8196 AC-A3: attribution headers name the serving route", () => {
  it("sends X-Runner-Route = the posted route, plus pool and tier when known", async () => {
    const t = new RecordingTransport();
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 8,
      decidePoolLabel: "decide-pool-8183",
      decideRoutes: [
        { route: "highlights-decide-5090-gpu1", tier: "5090", pool: "decide-pool-8183" },
        { route: "highlights-decide-5090-gpu2", tier: "5090" },
      ],
    });
    await c.decide("highlight", { id: 1 });
    await c.decide("highlight", { id: 2 });
    expect(t.calls.map((x) => x.headers["X-Runner-Route"])).toEqual([
      "highlights-decide-5090-gpu1",
      "highlights-decide-5090-gpu2",
    ]);
    expect(t.calls.map((x) => x.headers["X-Runner-Pool"])).toEqual(["decide-pool-8183", "decide-pool-8183"]);
    expect(t.calls.map((x) => x.headers["X-Runner-Tier"])).toEqual(["5090", "5090"]);
    // The payment/content headers the decide path already sent are untouched.
    expect(t.calls[0].headers["Content-Type"]).toBe("application/json");
  });

  it("carries the route header even on the legacy single-registration path", async () => {
    const t = new RecordingTransport();
    const c = new LivepeerClient("http://orch:8935", t, { decideConcurrency: 8 });
    await c.decide("highlight", { id: 1 });
    expect(t.calls[0].headers["X-Runner-Route"]).toBe(ROUTES.decide);
    expect(t.calls[0].headers["X-Runner-Pool"]).toBeUndefined();
  });
});

describe("ADAAAA-8196 AC-A4: unset config is byte-identical to ADAAAA-8559", () => {
  it("posts the legacy aggregate id when discovery is dark and no routes are configured", async () => {
    const t = new RecordingTransport();
    const c = new LivepeerClient("http://orch:8935", t, { decideConcurrency: 8 });
    await c.decide("highlight", { id: 1 });
    expect(t.urls()).toEqual([`/apps/${ROUTES.decide}/app/highlight`]);
  });

  it("ignores blank/malformed configured routes instead of posting them", async () => {
    const t = new RecordingTransport();
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 8,
      decideRoutes: [{ route: "" }, { route: "   " }],
    });
    await c.decide("highlight", { id: 1 });
    expect(t.urls()).toEqual([`/apps/${ROUTES.decide}/app/highlight`]);
  });
});

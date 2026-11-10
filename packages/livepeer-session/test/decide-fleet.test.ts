// ADAAAA-8559 (S2): the decide client routes each attempt at a runner from the
// discovered FLEET instead of one hard-coded id.
//
// AC coverage in this file:
//   AC1/AC3 the probe carries the pool ({runner_id, capacity, tier,
//        capacity_available}) alongside the unchanged sum over decide runners.
//   AC4 selection order: tier=5090 before x99-fallback, then least local
//        in-flight, then wider capacity; `advertised` still sizes admission.
//   AC5 support / AC6 attribution: per-runner attempts/served/503/404 and the
//        local concurrency watermark, per job.
//   AC7 the 503/404 hop posts to the NEXT runner (bounded, never an id this call
//        already tried), there is no hard-coded `/apps/highlights-decide/app`
//        route, and a hop yields exactly ONE 200 (one bill, one persist).
//   Fallbacks pinned too: a single registration with no ids behaves exactly as
//   today, and a discovery answer with zero decide runners falls back to the
//   funded ceiling (never 0).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DecideCapacityError,
  LivepeerClient,
  ROUTES,
  decideRunnerIdFromDiscoveryUrl,
  decideRunnerTierFromMetadata,
  decideTierRank,
  summarizeDecideDiscovery,
  type DiscoveredRunner,
  type Transport,
} from "../src/index";

interface Attempt {
  url: string;
  status: number;
  at: number;
}

/** Answers every request from a handler keyed by the posted path. */
class FleetTransport implements Transport {
  readonly calls: Attempt[] = [];
  constructor(private readonly answer: (url: string, n: number, at: number) => number) {}
  async request(_method: string, url: string, init: { headers?: Record<string, string>; body?: any } = {}) {
    const status = this.answer(url, this.calls.length, Date.now());
    this.calls.push({ url, status, at: Date.now() });
    const text = JSON.stringify({ ok: status === 200, id: init.body ? JSON.parse(String(init.body))?.id ?? null : null });
    return {
      status,
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
  successes(): Attempt[] {
    return this.calls.filter((c) => c.status === 200);
  }
}

/** One discovery registration exactly as go-livepeer renders it: the runner id
 * is the `/apps/<id>/app` route segment and the tier rides `metadata`. */
const registered = (id: string, capacity: number, tier: string, available = capacity): DiscoveredRunner => ({
  url: `https://orch.example:8935/apps/${id}/app`,
  app: "highlights-live/decide",
  capacity,
  capacity_available: available,
  metadata: JSON.stringify({ model: "gemma", engine: "vllm", tier, seqs: capacity }),
});

const FLEET: DiscoveredRunner[] = [
  registered("highlights-decide-5090-1", 4, "5090"),
  registered("highlights-decide-5090-2", 4, "5090"),
  registered("highlights-decide-5090-3", 4, "5090"),
  registered("highlights-decide-x99", 2, "x99-fallback"),
  registered("highlights-decide-x99-b", 2, "x99-fallback"),
];

const fleetProbe = async () => summarizeDecideDiscovery([{ runners: FLEET }]);

describe("ADAAAA-8559 AC1/AC3: the probe carries the pool", () => {
  it("summarizes the five registrations: advertised 16, five ids, tiers from metadata", async () => {
    const summary = summarizeDecideDiscovery([{ runners: FLEET }]);
    expect(summary.capacity).toBe(16);
    expect(summary.runners).toBe(5);
    expect(summary.pool).toEqual([
      { runner_id: "highlights-decide-5090-1", capacity: 4, capacity_available: 4, tier: "5090" },
      { runner_id: "highlights-decide-5090-2", capacity: 4, capacity_available: 4, tier: "5090" },
      { runner_id: "highlights-decide-5090-3", capacity: 4, capacity_available: 4, tier: "5090" },
      { runner_id: "highlights-decide-x99", capacity: 2, capacity_available: 2, tier: "x99-fallback" },
      { runner_id: "highlights-decide-x99-b", capacity: 2, capacity_available: 2, tier: "x99-fallback" },
    ]);
    // AC3: the startup/refresh line keeps `advertised` as the unchanged sum
    // under the cap of 32, and the runner count reads the registrations.
    const lines: string[] = [];
    const c = new LivepeerClient("http://orch:8935", new FleetTransport(() => 200), {
      decideCapacityProbe: fleetProbe,
      onDecideCapacity: (s) =>
        lines.push(
          `[decide-capacity] advertised=${s.advertised} funded=${s.funded} effective=${s.effective}` +
            ` probeOk=${s.probeOk} runners=${s.runners} source=${s.source} cap=${s.cap}`,
        ),
    });
    await c.refreshDecideCapacity(true);
    expect(lines.at(-1)).toBe(
      "[decide-capacity] advertised=16 funded=2 effective=16 probeOk=true runners=5 source=probe cap=32",
    );
  });

  it("reads the runner id and tier without prefix-matching runner ids", () => {
    expect(decideRunnerIdFromDiscoveryUrl("https://o:8935/apps/highlights-decide-5090-1/app")).toBe(
      "highlights-decide-5090-1",
    );
    expect(decideRunnerIdFromDiscoveryUrl("https://o:8935/apps/highlights-perceive/session")).toBe("highlights-perceive");
    // A proxied runner exposes no id, and a non-route url exposes none either.
    expect(decideRunnerIdFromDiscoveryUrl("https://o:8935/apps/proxy/abc/app")).toBeNull();
    expect(decideRunnerIdFromDiscoveryUrl("https://o:8935/discovery")).toBeNull();
    expect(decideRunnerTierFromMetadata('{"tier":"5090","seqs":4}')).toBe("5090");
    expect(decideRunnerTierFromMetadata("tier=x99-fallback,seqs=2")).toBe("x99-fallback");
    expect(decideRunnerTierFromMetadata('{"model":"gemma"}')).toBe("unknown");
    expect(decideRunnerTierFromMetadata(undefined)).toBe("unknown");
    // Tier order: 5090 -> unknown -> x99-fallback.
    expect(decideTierRank("5090")).toBeLessThan(decideTierRank("unknown"));
    expect(decideTierRank("unknown")).toBeLessThan(decideTierRank("x99-fallback"));
  });

  it("de-duplicates a repeated runner id (the signer can repeat an orchestrator)", () => {
    const summary = summarizeDecideDiscovery([
      { runners: [registered("highlights-decide-5090-1", 4, "5090")] },
      { runners: [registered("highlights-decide-5090-1", 4, "5090")] },
    ]);
    expect(summary.capacity).toBe(8);
    expect(summary.pool).toHaveLength(1);
  });

  it("keeps a runner with no usable capacity number out of the pool but in the count", () => {
    const summary = summarizeDecideDiscovery([
      { runners: [{ url: "https://o/apps/highlights-decide-5090-1/app", app: "highlights-decide" }] },
    ]);
    expect(summary.capacity).toBeNull();
    expect(summary.runners).toBe(1);
    expect(summary.pool).toEqual([]);
  });
});

describe("ADAAAA-8559 AC4: selection order", () => {
  it("posts to a tier=5090 runner, never the retired aggregate id", async () => {
    const t = new FleetTransport(() => 200);
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 16,
      decideCapacityProbe: fleetProbe,
    });
    await c.refreshDecideCapacity(true);
    await c.decide("highlight", { id: 1 });
    expect(t.urls()).toEqual(["/apps/highlights-decide-5090-1/app/highlight"]);
  });

  it("prefers tier=5090 over x99-fallback even when the x99 advertises wider capacity", async () => {
    const t = new FleetTransport(() => 200);
    const c = new LivepeerClient("http://orch:8935", t, {
      decideCapacityProbe: async () =>
        summarizeDecideDiscovery([
          { runners: [registered("highlights-decide-x99", 8, "x99-fallback"), registered("highlights-decide-5090-1", 4, "5090")] },
        ]),
    });
    await c.refreshDecideCapacity(true);
    await c.decide("highlight", { id: 1 });
    expect(t.urls()[0]).toBe("/apps/highlights-decide-5090-1/app/highlight");
  });

  it("spreads to the least-in-flight 5090 (no runner above its local in-flight)", async () => {
    const slow = new FleetTransport((url) => 200);
    const original = slow.request.bind(slow);
    // Hold the first request open so the second decide must pick the other 5090.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    slow.request = async (method, url, init) => {
      const res = await original(method, url, init);
      if (url.includes("5090-1")) await held;
      return res;
    };
    const c = new LivepeerClient("http://orch:8935", slow, {
      decideConcurrency: 16,
      decideCapacityProbe: fleetProbe,
    });
    await c.refreshDecideCapacity(true);
    const first = c.decide("highlight", { id: 1 });
    await new Promise((r) => setTimeout(r, 20)); // the first attempt is in flight on 5090-1
    const second = await c.decide("highlight", { id: 2 });
    expect(second.status).toBe(200);
    expect(slow.urls()[0]).toBe("/apps/highlights-decide-5090-1/app/highlight");
    expect(slow.urls()[1]).toBe("/apps/highlights-decide-5090-2/app/highlight");
    release();
    expect((await first).status).toBe(200);
    const attribution = c.decideRunnerAttribution();
    expect(attribution.map((a) => [a.runner_id, a.maxInFlight])).toEqual([
      ["highlights-decide-5090-1", 1],
      ["highlights-decide-5090-2", 1],
    ]);
  });
});

describe("ADAAAA-8559 AC7: 503/404 hop to the next runner", () => {
  it("hops a 503 to the next runner and bills exactly one 200", async () => {
    const t = new FleetTransport((url) => (url.includes("5090-1") ? 503 : 200));
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 16,
      decideBackoffBaseMs: 5,
      decideBackoffJitterRatio: 0,
      decideQueueMaxWaitMs: 5_000,
      decideCapacityProbe: fleetProbe,
    });
    await c.refreshDecideCapacity(true);
    const res = await c.decide("highlight", { id: 7 });
    expect(res.status).toBe(200);
    expect(t.urls()).toEqual([
      "/apps/highlights-decide-5090-1/app/highlight",
      "/apps/highlights-decide-5090-2/app/highlight",
    ]);
    // AC6: one 200 = one bill/one persist; the 503 was never routed.
    expect(t.successes()).toHaveLength(1);
    const byId = Object.fromEntries(c.decideRunnerAttribution().map((a) => [a.runner_id, a]));
    expect(byId["highlights-decide-5090-1"]).toMatchObject({ attempts: 1, served: 0, s503: 1, s404: 0 });
    expect(byId["highlights-decide-5090-2"]).toMatchObject({ attempts: 1, served: 1, s503: 0, s404: 0 });
  });

  it("hops a 404 runner-not-found to the next runner and bills exactly one 200", async () => {
    const t = new FleetTransport((url) => (url.includes("5090-1") ? 404 : 200));
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 16,
      decideBackoffBaseMs: 1,
      decideBackoffJitterRatio: 0,
      decideQueueMaxWaitMs: 5_000,
      decideCapacityProbe: fleetProbe,
    });
    await c.refreshDecideCapacity(true);
    // The transport body must actually say "runner not found" for the 404 to be
    // a HOP rather than a hard failure; FleetTransport answers JSON `{ok:false}`,
    // so wrap it once to emit the orchestrator's message.
    const real = t.request.bind(t);
    t.request = async (method, url, init) => {
      const res = await real(method, url, init);
      if (res.status === 404) {
        return { ...res, async text() { return '{"error":"runner not found"}'; } } as any;
      }
      return res;
    };
    const res = await c.decide("highlight", { id: 8 });
    expect(res.status).toBe(200);
    expect(t.urls()).toEqual([
      "/apps/highlights-decide-5090-1/app/highlight",
      "/apps/highlights-decide-5090-2/app/highlight",
    ]);
    expect(t.successes()).toHaveLength(1);
    expect(c.decideRunnerAttribution().find((a) => a.runner_id === "highlights-decide-5090-1")).toMatchObject({
      s404: 1,
      served: 0,
    });
  });

  it("walks every 5090 before touching an x99 fallback", async () => {
    const t = new FleetTransport((url) => (url.includes("5090") ? 503 : 200));
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 16,
      decideBackoffBaseMs: 2,
      decideBackoffJitterRatio: 0,
      decideQueueMaxWaitMs: 5_000,
      decideMaxAttempts: 5,
      decideCapacityProbe: fleetProbe,
    });
    await c.refreshDecideCapacity(true);
    const res = await c.decide("highlight", { id: 9 });
    expect(res.status).toBe(200);
    expect(t.urls()).toEqual([
      "/apps/highlights-decide-5090-1/app/highlight",
      "/apps/highlights-decide-5090-2/app/highlight",
      "/apps/highlights-decide-5090-3/app/highlight",
      "/apps/highlights-decide-x99/app/highlight",
    ]);
    expect(t.successes()).toHaveLength(1);
  });

  it("whole pool exhausted on 503 -> typed DecideCapacityError, each id tried once", async () => {
    const t = new FleetTransport(() => 503);
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 16,
      decideBackoffBaseMs: 2,
      decideBackoffJitterRatio: 0,
      decideQueueMaxWaitMs: 5_000,
      decideMaxAttempts: 8,
      decideCapacityProbe: async () =>
        summarizeDecideDiscovery([
          { runners: [registered("highlights-decide-5090-1", 4, "5090"), registered("highlights-decide-5090-2", 4, "5090")] },
        ]),
    });
    await c.refreshDecideCapacity(true);
    await expect(c.decide("highlight", { id: 10 })).rejects.toBeInstanceOf(DecideCapacityError);
    expect(t.urls()).toEqual([
      "/apps/highlights-decide-5090-1/app/highlight",
      "/apps/highlights-decide-5090-2/app/highlight",
    ]);
    expect(c.decideAdmissionMetrics().decideDropped).toBe(1);
  });

  it("whole pool exhausted on 404 -> a clear non-typed error naming the exhausted pool", async () => {
    const t = new FleetTransport(() => 404);
    const real = t.request.bind(t);
    t.request = async (method, url, init) => {
      const res = await real(method, url, init);
      return { ...res, async text() { return '{"error":"runner not found"}'; } } as any;
    };
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 16,
      decideBackoffBaseMs: 1,
      decideBackoffJitterRatio: 0,
      decideQueueMaxWaitMs: 5_000,
      decideMaxAttempts: 8,
      decideCapacityProbe: async () =>
        summarizeDecideDiscovery([
          { runners: [registered("highlights-decide-x99", 2, "x99-fallback"), registered("highlights-decide-x99-b", 2, "x99-fallback")] },
        ]),
    });
    await c.refreshDecideCapacity(true);
    await expect(c.decide("highlight", { id: 11 })).rejects.toThrow(/decide pool exhausted/);
    expect(t.urls()).toEqual([
      "/apps/highlights-decide-x99/app/highlight",
      "/apps/highlights-decide-x99-b/app/highlight",
    ]);
  });

  it("never exceeds the unchanged attempt budget, however many runners advertise", async () => {
    const t = new FleetTransport(() => 503);
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 16,
      decideBackoffBaseMs: 2,
      decideBackoffJitterRatio: 0,
      decideQueueMaxWaitMs: 5_000,
      decideMaxAttempts: 3,
      decideCapacityProbe: fleetProbe,
    });
    await c.refreshDecideCapacity(true);
    await expect(c.decide("highlight", { id: 12 })).rejects.toBeInstanceOf(DecideCapacityError);
    expect(t.calls).toHaveLength(3);
    // Three DISTINCT runners, not three posts at one id.
    expect(new Set(t.urls()).size).toBe(3);
  });
});

describe("ADAAAA-8559 AC4/current-suite: single-registration fallback", () => {
  it("a single decide runner with no route behaves exactly as today (fixed id, retried)", async () => {
    const t = new FleetTransport((url, n) => (n === 0 ? 404 : 200));
    const real = t.request.bind(t);
    t.request = async (method, url, init) => {
      const res = await real(method, url, init);
      return res.status === 404 ? ({ ...res, async text() { return '{"error":"runner not found"}'; } } as any) : res;
    };
    const c = new LivepeerClient("http://orch:8935", t, {
      decideBackoffBaseMs: 1,
      decideBackoffJitterRatio: 0,
      decideQueueMaxWaitMs: 5_000,
      decideCapacityProbe: async () =>
        summarizeDecideDiscovery([
          { runners: [{ url: "https://orch.example:8935", app: "highlights-decide", capacity: 2 }] },
        ]),
    });
    await c.refreshDecideCapacity(true);
    expect((await c.decide("highlight", { id: 13 })).status).toBe(200);
    expect(t.urls()).toEqual([
      `/apps/${ROUTES.decide}/app/highlight`,
      `/apps/${ROUTES.decide}/app/highlight`,
    ]);
    expect(c.decideRunnerAttribution()).toEqual([
      {
        runner_id: "highlights-decide",
        tier: "legacy-single",
        attempts: 2,
        served: 1,
        s503: 0,
        s404: 1,
        maxInFlight: 1,
      },
    ]);
  });

  it("zero decide runners advertises unknown capacity and never shrinks the gate to 0", async () => {
    const summary = summarizeDecideDiscovery([
      { runners: [{ url: "https://orch.example:8935/apps/highlights-perceive/session", app: "highlights-perceive", capacity: 4 }] },
    ]);
    expect(summary.capacity).toBeNull();
    expect(summary.pool).toEqual([]);
    const t = new FleetTransport(() => 200);
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 8,
      decideCapacityProbe: async () => summary,
    });
    const snap = await c.refreshDecideCapacity(true);
    expect(snap).toMatchObject({ advertised: 0, funded: 8, effective: 8, probeOk: true, runners: 0 });
    // Dark discovery keeps the funded fallback route rather than idling.
    await c.decide("highlight", { id: 14 });
    expect(t.urls()).toEqual([`/apps/${ROUTES.decide}/app/highlight`]);
  });
});

describe("ADAAAA-8559 AC7: no stale single-id route in the client", () => {
  it("the source carries no hard-coded /apps/highlights-decide/app path", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts"), "utf8");
    expect(src.includes("/apps/highlights-decide/app")).toBe(false);
    expect(src).toContain("this.decidePath(runnerId, path)");
  });

  it("every attempt path is built from the selected runner id", async () => {
    const seen: string[] = [];
    const t = new FleetTransport(() => 200);
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 16,
      decideCapacityProbe: fleetProbe,
      onDecideAttempt: (timing) => {
        if (timing.status === 200) seen.push(timing.runnerId ?? "");
      },
    });
    await c.refreshDecideCapacity(true);
    await c.decide("confirm", { id: 15 });
    expect(seen).toEqual(["highlights-decide-5090-1"]);
    expect(t.urls().every((u) => /^\/apps\/highlights-decide-5090-\d\/app\//.test(u))).toBe(true);
  });
});

describe("ADAAAA-8559 AC4 attribution", () => {
  it("reports per-runner counters as a per-job DELTA and resets the watermark", async () => {
    const t = new FleetTransport((url) => (url.includes("5090-1") ? 503 : 200));
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 16,
      decideBackoffBaseMs: 2,
      decideBackoffJitterRatio: 0,
      decideQueueMaxWaitMs: 5_000,
      decideCapacityProbe: fleetProbe,
    });
    await c.refreshDecideCapacity(true);
    c.beginDecideJob();
    await c.decide("highlight", { id: 20 });
    const jobA = c.decideAdmissionMetrics().runnerAttribution ?? [];
    expect(jobA.map((a) => [a.runner_id, a.attempts, a.served, a.s503, a.maxInFlight])).toEqual([
      ["highlights-decide-5090-1", 1, 0, 1, 1],
      ["highlights-decide-5090-2", 1, 1, 0, 1],
    ]);
    // Job B starts on the SAME client: job A's counters are not re-reported.
    c.beginDecideJob();
    expect(c.decideAdmissionMetrics().runnerAttribution).toEqual([]);
    await c.decide("highlight", { id: 21 });
    const jobB = c.decideAdmissionMetrics().runnerAttribution ?? [];
    // Only the runner that served job B's call carries a delta (the LRU
    // tie-break rotated it to the next idle 5090 after job A's picks).
    expect(jobB).toHaveLength(1);
    expect(jobB[0]).toMatchObject({ tier: "5090", attempts: 1, served: 1, s503: 0, s404: 0 });
    expect(jobB[0].runner_id).not.toBe("highlights-decide-5090-1");
  });
});

// ADAAAA-8559 (S2) server-side leg: the decide client now calls the discovered
// FLEET, so (a) the `[decide-capacity]` line must read the five registrations
// once S1 is deployed, (b) each decide must log/serve WHICH runner answered it,
// and (c) the per-runner attribution must SURVIVE persistence onto the job record
// (a field the zod schema does not declare is stripped by `JobSchema.parse`
// before it reaches `jobs.record` — the `perceiveSource` / `decideStages` trap).
import { describe, it, expect, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { SqliteDb } from "../src/db";
import { Store } from "../src/store";
import { loadConfig } from "../src/config";
import { OrchestratorAdapter } from "../src/livepeer-adapter";
import { withDecideAdmissionMetrics } from "../src/analyzer";
import { decideStageRecorder } from "../src/decide-stage-timings";
import {
  summarizeDecideDiscovery,
  type DecideRunnerAttribution,
  type DiscoveredRunner,
} from "@highlights/livepeer-session";

const baseObserveMetrics = {
  decideCalls: 31,
  accepted: 2,
  maxFrames: 30,
  meanE2eMs: 1900,
  maxE2eMs: 4200,
  meanCadenceMs: 3000,
  maxCadenceMs: 3400,
  triggerFires: 4,
  cadenceFires: 27,
};

/** The five registrations S1 creates, exactly as go-livepeer renders them:
 * the runner id is the `/apps/<id>/app` route and the tier rides `metadata`. */
const fifoRegistration = (id: string, capacity: number, tier: string): DiscoveredRunner => ({
  url: `https://192.168.1.6:8935/apps/${id}/app`,
  app: "highlights-live/decide",
  capacity,
  capacity_available: capacity,
  metadata: JSON.stringify({ model: "gemma", engine: "vllm", tier, seqs: capacity }),
});

const FIVE = [
  fifoRegistration("highlights-decide-5090-1", 4, "5090"),
  fifoRegistration("highlights-decide-5090-2", 4, "5090"),
  fifoRegistration("highlights-decide-5090-3", 4, "5090"),
  fifoRegistration("highlights-decide-x99", 2, "x99-fallback"),
  fifoRegistration("highlights-decide-x99-b", 2, "x99-fallback"),
];

describe("ADAAAA-8559 AC3: the startup line reads the five-registration fleet", () => {
  it("prints [decide-capacity] advertised=16 runners=5 probeOk=true (effective 16 under cap 32)", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const cfg = { ...loadConfig({} as NodeJS.ProcessEnv), decideConcurrency: 8, orchestratorUrl: "http://orch:8935" };
      const signer = {
        async discover() {
          return [{ address: "https://orch", runners: FIVE }];
        },
        async signOrchInfo() {
          return {};
        },
        async generateLivePayment() {
          return { payment: "", segCreds: "", signerState: null };
        },
      };
      const adapter = new OrchestratorAdapter(cfg, { signer: signer as any });
      const snap = await adapter.primeDecideCapacity();
      expect(snap).toEqual({
        advertised: 16,
        funded: 8,
        effective: 16,
        probeOk: true,
        runners: 5,
        source: "probe",
        cap: 32,
      });
      expect(lines).toContain(
        "[decide-capacity] advertised=16 funded=8 effective=16 probeOk=true runners=5 source=probe cap=32",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("the probe carries the pool the client selects from (ids + tiers)", () => {
    const summary = summarizeDecideDiscovery([{ runners: FIVE }]);
    expect(summary.capacity).toBe(16);
    expect(summary.pool?.map((r) => `${r.runner_id}:${r.tier}:${r.capacity}`)).toEqual([
      "highlights-decide-5090-1:5090:4",
      "highlights-decide-5090-2:5090:4",
      "highlights-decide-5090-3:5090:4",
      "highlights-decide-x99:x99-fallback:2",
      "highlights-decide-x99-b:x99-fallback:2",
    ]);
  });
});

describe("ADAAAA-8559 AC4: attribution is logged and served, not read off nginx", () => {
  /** A real orchestrator-shaped HTTP endpoint answering every decide 200. */
  const serve = async (statuses: Record<string, number>): Promise<{ server: Server; base: string; paths: string[] }> => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url || "");
      const id = /^\/apps\/([^/]+)\//.exec(req.url || "")?.[1] ?? "";
      const status = statuses[id] ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { isHighlight: false, score: 0, reason: "test" } : { error: "no capacity" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return { server, base: `http://127.0.0.1:${port}`, paths };
  };

  it("an offchain decide serves the 5090 tier, logs its id, and feeds the job record", async () => {
    const { server, base, paths } = await serve({});
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const cfg = { ...loadConfig({} as NodeJS.ProcessEnv), orchestratorUrl: base, decideConcurrency: 16 };
      const signer = {
        async discover() {
          return [{ address: "https://orch", runners: FIVE }];
        },
        async signOrchInfo() {
          return {};
        },
        async generateLivePayment() {
          return { payment: "", segCreds: "", signerState: null };
        },
      };
      const adapter = new OrchestratorAdapter(cfg, { signer: signer as any });
      const jobId = "job-8559-e2e";
      adapter.beginDecideJob();
      // The job-start probe is fire-and-forget; await the same single-flight
      // refresh so this call selects from the fleet (not the legacy fallback).
      await adapter.primeDecideCapacity();

      const dives = [1, 2, 3];
      for (const n of dives) {
        const verdict = await adapter.decide(
          { eventType: "score_change", trackCount: 1, maxVelocity: 1, ocrHits: 0 },
          { jobId, groupKey: `g${n}` },
        );
        expect(verdict.isHighlight).toBe(false);
      }
      // Every posted path was a selected runner id — never the retired aggregate.
      expect(paths.every((p) => /^\/apps\/highlights-decide-5090-\d\/app\//.test(p))).toBe(true);
      expect(new Set(paths).size).toBe(3); // spread across all three 5090 ids
      expect(lines.filter((l) => l.startsWith("[decide-runner]"))).toHaveLength(3);
      expect(lines.some((l) => l.includes("runner=highlights-decide-5090-1 tier=5090"))).toBe(true);

      // AC4 durability: the attribution is on the observe snapshot that the
      // analyzer folds onto the record (one entry per serving runner).
      const attribution = adapter.decideAdmissionMetrics().runnerAttribution!;
      expect(attribution.map((a) => [a.runner_id, a.served, a.s503, a.maxInFlight])).toEqual([
        ["highlights-decide-5090-1", 1, 0, 1],
        ["highlights-decide-5090-2", 1, 0, 1],
        ["highlights-decide-5090-3", 1, 0, 1],
      ]);
      // The stage recorder's samples also name the serving runner (same instant).
      const samples = decideStageRecorder.samples(jobId);
      expect(samples.map((s) => s.runnerId)).toEqual([
        "highlights-decide-5090-1",
        "highlights-decide-5090-2",
        "highlights-decide-5090-3",
      ]);
      decideStageRecorder.clear(jobId);
    } finally {
      spy.mockRestore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a 503 on a 5090 hops to the next 5090 and attributes the hop", async () => {
    const { server, base, paths } = await serve({ "highlights-decide-5090-1": 503 });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const cfg = {
        ...loadConfig({} as NodeJS.ProcessEnv),
        orchestratorUrl: base,
        decideConcurrency: 16,
        decideBackoffBaseMs: 5,
        decideBackoffJitterRatio: 0,
      };
      const signer = {
        async discover() {
          return [{ address: "https://orch", runners: FIVE }];
        },
        async signOrchInfo() {
          return {};
        },
        async generateLivePayment() {
          return { payment: "", segCreds: "", signerState: null };
        },
      };
      const adapter = new OrchestratorAdapter(cfg as any, { signer: signer as any });
      adapter.beginDecideJob();
      await adapter.primeDecideCapacity();
      const verdict = await adapter.decide(
        { eventType: "score_change", trackCount: 1, maxVelocity: 1, ocrHits: 0 },
        { jobId: "job-8559-hop", groupKey: "g1" },
      );
      expect(verdict.isHighlight).toBe(false);
      expect(paths).toEqual([
        "/apps/highlights-decide-5090-1/app/highlight",
        "/apps/highlights-decide-5090-2/app/highlight",
      ]);
      const attribution = adapter.decideAdmissionMetrics().runnerAttribution!;
      expect(attribution.find((a) => a.runner_id === "highlights-decide-5090-1")).toMatchObject({
        attempts: 1,
        served: 0,
        s503: 1,
      });
      expect(attribution.find((a) => a.runner_id === "highlights-decide-5090-2")).toMatchObject({
        attempts: 1,
        served: 1,
        s503: 0,
      });
    } finally {
      spy.mockRestore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("ADAAAA-8559 AC4: decideRunners survives the job record (zod declares it)", () => {
  const attribution: DecideRunnerAttribution[] = [
    { runner_id: "highlights-decide-5090-1", tier: "5090", attempts: 11, served: 11, s503: 0, s404: 0, maxInFlight: 3 },
    { runner_id: "highlights-decide-5090-2", tier: "5090", attempts: 10, served: 10, s503: 0, s404: 0, maxInFlight: 2 },
    { runner_id: "highlights-decide-5090-3", tier: "5090", attempts: 10, served: 10, s503: 0, s404: 0, maxInFlight: 2 },
  ];

  it("writes decideRunners onto jobs.record and reads it back", async () => {
    const db = new SqliteDb(":memory:");
    const s = new Store(db);
    const j = await s.createJob({ ownerId: "u1", source: "rtmp", sourceUrl: "rtmp://test/stream" });
    const observeMetrics = withDecideAdmissionMetrics(baseObserveMetrics, {
      decideQueued: 0,
      decideDropped: 0,
      decide503: 0,
      decidePauses: 0,
      capacityProbeErrors: 0,
      capacity: { advertised: 16, funded: 8, effective: 16, probeOk: true, runners: 5, source: "probe", cap: 32 },
      runnerAttribution: attribution,
    });
    await s.patchJob(j.id, { status: "done", completedAt: new Date().toISOString(), observeMetrics });

    const stored = (await db.getJob(j.id))!;
    expect(stored.observeMetrics!.decideRunners).toEqual(attribution);
    // Three distinct 5090 ids serving, none above 4 concurrent — AC4's shape.
    expect(new Set(stored.observeMetrics!.decideRunners!.map((r) => r.runner_id)).size).toBe(3);
    expect(Math.max(...stored.observeMetrics!.decideRunners!.map((r) => r.maxInFlight))).toBeLessThanOrEqual(4);
    expect(JSON.stringify(stored)).toContain('"decideRunners"');

    // A restart hydrates the attribution back onto the row.
    const reloaded = new Store(db);
    await reloaded.load();
    expect(reloaded.getJob(j.id)!.observeMetrics!.decideRunners).toHaveLength(3);
  });

  it("an empty attribution is NOT recorded (absent = not measured, never 0)", () => {
    const merged = withDecideAdmissionMetrics(baseObserveMetrics, {
      decideQueued: 0,
      decideDropped: 0,
      decide503: 0,
      decidePauses: 0,
      capacityProbeErrors: 0,
      capacity: { advertised: 16, funded: 8, effective: 16, probeOk: true, runners: 5, source: "probe", cap: 32 },
      runnerAttribution: [],
    });
    expect((merged as any).decideRunners).toBeUndefined();
    // An older client that reports no attribution at all stays byte-identical.
    const older = withDecideAdmissionMetrics(baseObserveMetrics, {
      decideQueued: 0,
      decideDropped: 0,
      decide503: 0,
      decidePauses: 0,
      capacityProbeErrors: 0,
      capacity: { advertised: 16, funded: 8, effective: 16, probeOk: true, runners: 5, source: "probe", cap: 32 },
    });
    expect((older as any).decideRunners).toBeUndefined();
  });
});

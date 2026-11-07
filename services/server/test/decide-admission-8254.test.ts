// ADAAAA-8254 server-side leg: the capacity-aware decide ceiling + ordered 503
// queue must be reachable from the server config, wired to the signer, and the
// admission counters must SURVIVE persistence onto the job record (the
// ADAAAA-8219 trap: a counter the analyzer computes but the schema does not
// declare is stripped by `JobSchema.parse` before it reaches `jobs.record`).
import { describe, it, expect, vi } from "vitest";
import { DecideCapacityError, type DiscoveredRunner } from "@highlights/livepeer-session";
import { SqliteDb } from "../src/db";
import { Store } from "../src/store";
import { loadConfig, parseBooleanFlag } from "../src/config";
import { OrchestratorAdapter } from "../src/livepeer-adapter";
import { isDecideCapacityError, withDecideAdmissionMetrics } from "../src/analyzer";

const baseObserveMetrics = {
  decideCalls: 73,
  accepted: 1,
  maxFrames: 30,
  meanE2eMs: 5602,
  maxE2eMs: 9000,
  meanCadenceMs: 5000,
  maxCadenceMs: 6000,
  triggerFires: 2,
  cadenceFires: 71,
};

describe("ADAAAA-8254 AC4: admission counters persist on the job record", () => {
  const observeMetrics = {
    ...baseObserveMetrics,
    decideQueued: 4,
    decideDropped: 1,
    decide503: 3,
    decidePauses: 2,
    capacityProbeErrors: 0,
    decideCapacity: { advertised: 12, funded: 8, effective: 8 },
  };

  it("keeps decideQueued/Dropped/503/Pauses/probeErrors + the capacity snapshot in the stored row", async () => {
    const db = new SqliteDb(":memory:");
    const s = new Store(db);
    const j = await s.createJob({ ownerId: "u1", source: "rtmp", sourceUrl: "rtmp://test/stream" });
    await s.patchJob(j.id, {
      status: "done",
      completedAt: new Date().toISOString(),
      observeMetrics,
    });

    const stored = await db.getJob(j.id);
    const m = stored!.observeMetrics!;
    expect(m.decideQueued).toBe(4);
    expect(m.decideDropped).toBe(1);
    expect(m.decide503).toBe(3);
    expect(m.decidePauses).toBe(2);
    expect(m.capacityProbeErrors).toBe(0);
    expect(m.decideCapacity).toEqual({ advertised: 12, funded: 8, effective: 8 });

    // The raw record is what QA's `record->'observeMetrics'` read returns.
    const raw = JSON.stringify(stored);
    expect(raw).toContain('"decideDropped":1');
    expect(raw).toContain('"decide503":3');
    expect(raw).toContain('"decideCapacity":{"advertised":12,"funded":8,"effective":8}');

    // A restart hydrates the counters back onto the row.
    const reloaded = new Store(db);
    await reloaded.load();
    expect(reloaded.getJob(j.id)!.observeMetrics!.decideDropped).toBe(1);
  });

  it("an older row without the counters stays valid (additive optional)", async () => {
    const db = new SqliteDb(":memory:");
    const s = new Store(db);
    const j = await s.createJob({ ownerId: "u1", source: "file" });
    await s.patchJob(j.id, { status: "done", observeMetrics: baseObserveMetrics });
    const m = (await db.getJob(j.id))!.observeMetrics!;
    expect(m.decideDropped).toBeUndefined();
    expect(m.decideCapacity).toBeUndefined();
  });

  it("withDecideAdmissionMetrics folds the gate counters onto the observe snapshot", () => {
    const merged = withDecideAdmissionMetrics(baseObserveMetrics, {
      decideQueued: 5,
      decideDropped: 2,
      decide503: 4,
      decidePauses: 3,
      capacityProbeErrors: 1,
      capacity: { advertised: 4, funded: 8, effective: 4 },
    });
    expect(merged).toMatchObject({
      decideCalls: 73, // base untouched
      decideQueued: 5,
      decideDropped: 2,
      decide503: 4,
      decidePauses: 3,
      capacityProbeErrors: 1,
      decideCapacity: { advertised: 4, funded: 8, effective: 4 },
    });
    // No gate (direct-dev / older client) => byte-identical snapshot.
    expect(withDecideAdmissionMetrics(baseObserveMetrics, undefined)).toEqual(baseObserveMetrics);
  });

  it("the live rail's continue-guard recognises the gate's typed drop", () => {
    expect(isDecideCapacityError(new DecideCapacityError(60_000, 60_000))).toBe(true);
    expect(isDecideCapacityError(new Error("decide runner unavailable after 5 attempts"))).toBe(false);
    expect(isDecideCapacityError(undefined)).toBe(false);
  });
});

describe("ADAAAA-8254 AC6: config knobs", () => {
  it("parses DECIDE_CAPACITY_REFRESH_S / DECIDE_QUEUE_MAX_WAIT_MS / DECIDE_CAPACITY_DISCOVERY", () => {
    const cfg = loadConfig({
      DECIDE_CONCURRENCY: "8",
      DECIDE_CAPACITY_REFRESH_S: "30",
      DECIDE_QUEUE_MAX_WAIT_MS: "45000",
      DECIDE_CAPACITY_DISCOVERY: "0",
    } as NodeJS.ProcessEnv);
    expect(cfg.decideConcurrency).toBe(8);
    expect(cfg.decideCapacityRefreshS).toBe(30);
    expect(cfg.decideQueueMaxWaitMs).toBe(45_000);
    expect(cfg.decideCapacityDiscovery).toBe(false);
  });

  it("all knobs unset = client defaults (AC1 last row: today's behaviour)", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.decideConcurrency).toBeUndefined();
    expect(cfg.decideCapacityRefreshS).toBeUndefined();
    expect(cfg.decideQueueMaxWaitMs).toBeUndefined();
    expect(cfg.decideCapacityDiscovery).toBe(true);
    expect(parseBooleanFlag(undefined, true)).toBe(true);
    expect(parseBooleanFlag("off", true)).toBe(false);
    expect(parseBooleanFlag("1", false)).toBe(true);
    expect(parseBooleanFlag("garbage", true)).toBe(true);
  });
});

describe("ADAAAA-8254 adapter wiring: the signer is the capacity source", () => {
  const decideRunner = (capacity: number, app = "highlights-live/decide"): DiscoveredRunner => ({
    url: `https://orch/${app}`,
    app,
    capacity,
    capacity_available: capacity,
  });

  const cfg = { ...loadConfig({} as NodeJS.ProcessEnv), decideConcurrency: 8, orchestratorUrl: "http://orch:8935" };

  const signer = (runners: DiscoveredRunner[], capsSeen?: string[][]) => ({
    async discover(caps: string[]) {
      capsSeen?.push(caps);
      return [{ address: "https://orch", runners }];
    },
    async signOrchInfo() {
      return {};
    },
    async generateLivePayment() {
      return { payment: "", segCreds: "", signerState: null };
    },
  });

  /** Wait (bounded) for the fire-and-forget probe to land on `want`. */
  const settle = async (
    read: () => { advertised: number; funded: number; effective: number },
    want: { advertised: number; effective: number }
  ) => {
    for (let i = 0; i < 100; i++) {
      const snap = read();
      if (snap.advertised === want.advertised && snap.effective === want.effective) return snap;
      await new Promise((r) => setTimeout(r, 5));
    }
    return read();
  };

  it("discovering 8/2/2 with DECIDE_CONCURRENCY=8 yields advertised 12 / funded 8 / effective 8", async () => {
    const capsSeen: string[][] = [];
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const adapter = new OrchestratorAdapter(cfg, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signer: signer([decideRunner(8), decideRunner(2, "highlights-decide"), decideRunner(2)], capsSeen) as any,
      });
      adapter.beginDecideJob();
      const m = await settle(() => adapter.decideAdmissionMetrics().capacity, { advertised: 12, effective: 8 });
      expect(capsSeen[0]).toEqual(["highlights-live/decide"]);
      expect(m).toEqual({ advertised: 12, funded: 8, effective: 8 });
      // AC1: the startup/refresh log line carries the three numbers.
      expect(lines).toContain("[decide-capacity] advertised=12 funded=8 effective=8");
    } finally {
      spy.mockRestore();
    }
  });

  it("a single cap-4 fleet lowers the ceiling to 4", async () => {
    const adapter = new OrchestratorAdapter(cfg, { signer: signer([decideRunner(4)]) as any });
    adapter.beginDecideJob();
    expect(await settle(() => adapter.decideAdmissionMetrics().capacity, { advertised: 4, effective: 4 })).toEqual({
      advertised: 4,
      funded: 8,
      effective: 4,
    });
  });

  it("no signer => no probe, funded ceiling only (byte-identical admission)", async () => {
    const adapter = new OrchestratorAdapter(cfg);
    adapter.beginDecideJob();
    await new Promise((r) => setTimeout(r, 20));
    expect(adapter.decideAdmissionMetrics().capacity).toEqual({ advertised: 0, funded: 8, effective: 8 });
    expect(adapter.decideAdmissionMetrics().capacityProbeErrors).toBe(0);
  });

  it("DECIDE_CAPACITY_DISCOVERY=0 disables the probe even with a signer", async () => {
    const capsSeen: string[][] = [];
    const adapter = new OrchestratorAdapter(
      { ...cfg, decideCapacityDiscovery: false },
      { signer: signer([decideRunner(8)], capsSeen) as any }
    );
    adapter.beginDecideJob();
    await new Promise((r) => setTimeout(r, 20));
    expect(capsSeen).toHaveLength(0);
    expect(adapter.decideAdmissionMetrics().capacity).toEqual({ advertised: 0, funded: 8, effective: 8 });
  });

  it("a failing signer discovery is counted and never blocks admission", async () => {
    const adapter = new OrchestratorAdapter(cfg, {
      signer: {
        async discover() {
          throw new Error("signer discover failed: HTTP 500");
        },
        async signOrchInfo() {
          return {};
        },
        async generateLivePayment() {
          return { payment: "", segCreds: "", signerState: null };
        },
      } as any,
    });
    adapter.beginDecideJob();
    for (let i = 0; i < 100 && adapter.decideAdmissionMetrics().capacityProbeErrors === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const m = adapter.decideAdmissionMetrics();
    expect(m.capacityProbeErrors).toBe(1);
    expect(m.capacity).toEqual({ advertised: 0, funded: 8, effective: 8 });
  });
});

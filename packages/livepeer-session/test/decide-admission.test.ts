// ADAAAA-8254: decide admission — capacity-aware ceiling (downward only) and
// the ordered 503 queue with a single-flight probe.
//
// AC coverage in this file:
//   AC1 effective ceiling = min(funded, advertised) clamped [1, funded];
//       8/2/2 -> 8, single cap-4 -> 4, unset env + no signer -> today's value.
//   AC2 a discovery 500 / timeout / malformed advertisement never throws into
//       decide; probe errors are counted and last-known capacity is kept.
//   AC3 FIFO order preserved and a zero-capacity episode costs ~one decide
//       probe per backoff window (not one per queued request).
//   AC4 an exhausted decide raises the typed DecideCapacityError, increments
//       decideDropped, and the client keeps working (the job is not aborted).
import { describe, it, expect, vi } from "vitest";
import {
  DecideCapacityError,
  LivepeerClient,
  ROUTES,
  summarizeDecideDiscovery,
  type DecideCapacityProbeResult,
  type DiscoveredRunner,
  type Transport,
} from "../src/index";

interface Call {
  at: number;
  body: any;
  status: number;
}

/**
 * A transport that answers every decide POST from a caller-supplied handler.
 * Counts every request so a test can assert the probe rate (AC3).
 */
class ScriptedTransport implements Transport {
  readonly calls: Call[] = [];
  constructor(private readonly answer: (body: any, n: number, at: number) => number) {}
  async request(_method: string, url: string, init: { headers?: Record<string, string>; body?: any } = {}) {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const at = Date.now();
    const status = url.includes(`/apps/${ROUTES.decide}/app/`)
      ? this.answer(body, this.calls.length, at)
      : 200;
    this.calls.push({ at, body, status });
    const text = JSON.stringify({ ok: status === 200, id: body?.id ?? null });
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
  get decideCalls(): Call[] {
    return this.calls.filter((c) => c.status !== undefined);
  }
  get probes(): Call[] {
    return this.calls.filter((c) => c.status === 503);
  }
  get successes(): Call[] {
    return this.calls.filter((c) => c.status === 200);
  }
}

const runner = (app: string, capacity?: number, capacity_available?: number): DiscoveredRunner => ({
  url: `https://orch/${app}`,
  app,
  ...(capacity !== undefined ? { capacity } : {}),
  ...(capacity_available !== undefined ? { capacity_available } : {}),
});

describe("ADAAAA-8254 AC1: capacity-aware effective ceiling (downward only)", () => {
  it("sums the advertised decide capacity (8/2/2 = 12) and admits min(funded 8, 12) = 8", async () => {
    const discovery = [
      { address: "a", runners: [runner("highlights-live/decide", 8)] },
      { address: "b", runners: [runner("highlights-decide", 2)] },
      // A perceive runner on the same orchestrator must NOT be counted.
      { address: "c", runners: [runner("highlights-perceive", 8), runner("highlights-live/decide", 2)] },
    ];
    const summary = summarizeDecideDiscovery(discovery);
    expect(summary.capacity).toBe(12);

    const seen: { advertised: number; funded: number; effective: number }[] = [];
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => summary,
      onDecideCapacity: (s) => seen.push(s),
    });
    const snap = await c.refreshDecideCapacity(true);
    expect(snap).toEqual({ advertised: 12, funded: 8, effective: 8 });
    // AC1 startup log line carries the three numbers.
    expect(seen.at(-1)).toEqual({ advertised: 12, funded: 8, effective: 8 });
  });

  it("shrinks to a single cap-4 fleet when the pool is smaller than the funded ceiling", async () => {
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => ({ capacity: 4 }),
    });
    const snap = await c.refreshDecideCapacity(true);
    expect(snap).toEqual({ advertised: 4, funded: 8, effective: 4 });
  });

  it("never sizes UP past the funded ceiling (advertised 12 with DECIDE_CONCURRENCY=2 -> 2)", async () => {
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 2,
      decideCapacityProbe: async () => ({ capacity: 12 }),
    });
    expect((await c.refreshDecideCapacity(true)).effective).toBe(2);
  });

  it("falls back to capacity_available when an older advertisement has no `capacity`", async () => {
    const summary = summarizeDecideDiscovery([{ runners: [runner("highlights-decide", undefined, 3)] }]);
    expect(summary.capacity).toBe(3);
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => summary,
    });
    expect((await c.refreshDecideCapacity(true)).effective).toBe(3);
  });

  it("never shrinks to 0 and never below 1 (clamped to [1, funded])", async () => {
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => ({ capacity: 0 }),
    });
    expect((await c.refreshDecideCapacity(true)).effective).toBe(1);
  });

  it("a missing/NaN capacity on every runner keeps the funded ceiling (unknown != zero)", async () => {
    const summary = summarizeDecideDiscovery([
      { runners: [{ url: "x", app: "highlights-decide" }] },
      { runners: [] },
    ]);
    expect(summary.capacity).toBeNull();
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => summary,
    });
    expect(await c.refreshDecideCapacity(true)).toEqual({ advertised: 0, funded: 8, effective: 8 });
  });

  it("unset env + no signer (no probe) is byte-identical to today's static gate", async () => {
    const t = new ScriptedTransport(() => 200);
    const c = new LivepeerClient("http://orch:8935", t);
    // No probe: the funded default (capacity-2 admission, ADAAAA-6911) wins.
    expect(c.decideAdmissionMetrics().capacity).toEqual({ advertised: 0, funded: 2, effective: 2 });
    const r = await c.decide("decide", { id: 1 });
    expect(r.status).toBe(200);
    expect(t.calls.length).toBe(1);
  });
});

describe("ADAAAA-8254 AC2: discovery failures never reach the decide path", () => {
  it("a rejecting probe is counted, does not throw, and keeps the funded ceiling", async () => {
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => {
        throw new Error("signer discover failed: HTTP 500");
      },
    });
    const snap = await c.refreshDecideCapacity(true);
    expect(snap).toEqual({ advertised: 0, funded: 8, effective: 8 });
    expect(c.decideAdmissionMetrics().capacityProbeErrors).toBe(1);
    // Decide still returns 200 while the probe is broken.
    const r = await c.decide("decide", { id: 7 });
    expect(r.status).toBe(200);
  });

  it("a hanging probe times out (never awaits the decide path) and keeps the last known capacity", async () => {
    let mode: "ok" | "hang" = "ok";
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async (): Promise<DecideCapacityProbeResult> => {
        if (mode === "ok") return { capacity: 4 };
        return new Promise(() => {}); // never settles
      },
      decideCapacityProbeTimeoutMs: 10,
    });
    expect((await c.refreshDecideCapacity(true)).effective).toBe(4);
    mode = "hang";
    const started = Date.now();
    const snap = await c.refreshDecideCapacity(true);
    expect(Date.now() - started).toBeLessThan(500);
    // Last known advertised capacity survives the failed probe.
    expect(snap).toEqual({ advertised: 4, funded: 8, effective: 4 });
    expect(c.decideAdmissionMetrics().capacityProbeErrors).toBe(1);
    // Decide is unaffected.
    expect((await c.decide("decide", { id: 1 })).status).toBe(200);
  });

  it("a malformed advertisement (no runners / garbage) leaves the ceiling unchanged", async () => {
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => ({ capacity: null }),
    });
    expect((await c.refreshDecideCapacity(true)).effective).toBe(8);
    expect(c.decideAdmissionMetrics().capacityProbeErrors).toBe(0);
    expect(summarizeDecideDiscovery(null).capacity).toBeNull();
    expect(summarizeDecideDiscovery([{ runners: [runner("other-app", 99)] }]).capacity).toBeNull();
  });

  it("calls decide() without ever awaiting the probe (refresh is fired, not awaited)", async () => {
    let probes = 0;
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityRefreshMs: 0,
      decideCapacityProbe: async () => {
        probes++;
        return new Promise<DecideCapacityProbeResult>(() => {}); // hangs
      },
      decideCapacityProbeTimeoutMs: 60_000,
    });
    const t0 = Date.now();
    expect((await c.decide("decide", { id: 1 })).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(probes).toBe(1);
  });
});

describe("ADAAAA-8254 AC3: ordered queue with a single-flight probe", () => {
  it("keeps FIFO order and costs one probe per backoff window during a zero-capacity episode", async () => {
    const episodeMs = 150;
    const baseMs = 50;
    let episodeStart = 0;
    const t = new ScriptedTransport((body, _n, at) => {
      if (episodeStart === 0) episodeStart = at;
      return at - episodeStart < episodeMs ? 503 : 200;
    });
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 1, // one slot: every queued decide really queues
      decideBackoffBaseMs: baseMs,
      decideBackoffJitterRatio: 0,
      decideMaxAttempts: 10,
      decideQueueMaxWaitMs: 10_000,
    });
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((id) => c.decide("decide", { id }))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    // FIFO: the five decides are admitted (and succeed) in enqueue order.
    expect(t.successes.map((c) => c.body.id)).toEqual([0, 1, 2, 3, 4]);
    // AC3 probe bar: <= ceil(episode / window) + 1 shared probes, not one per
    // queued decide per window (5 decides would otherwise produce 5 x windows).
    const maxProbes = Math.ceil(episodeMs / baseMs) + 1;
    expect(t.probes.length).toBeLessThanOrEqual(maxProbes);
    expect(c.decideAdmissionMetrics().decide503).toBe(t.probes.length);
  });

  it("does not fan a pause window out to the whole queue", async () => {
    // 8 concurrent decides, all 503 for one window: exactly ONE probe runs for
    // the second window (the first window's initial in-flight admits are the
    // funded ceiling, not extra probes).
    const baseMs = 40;
    let episodeStart = 0;
    const t = new ScriptedTransport((_body, _n, at) => {
      if (episodeStart === 0) episodeStart = at;
      return at - episodeStart < baseMs + 5 ? 503 : 200;
    });
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 2,
      decideBackoffBaseMs: baseMs,
      decideBackoffJitterRatio: 0,
      decideMaxAttempts: 5,
      decideQueueMaxWaitMs: 10_000,
    });
    const out = await Promise.all([0, 1, 2, 3].map((id) => c.decide("decide", { id })));
    expect(out.every((r) => r.status === 200)).toBe(true);
    // 2 initial slots + 1 probe in the pause window (<= funded + 1).
    expect(t.probes.length).toBeLessThanOrEqual(3);
  });
});

describe("ADAAAA-8254 AC4: bounded, counted loss", () => {
  it("an always-503 runner drops with DecideCapacityError, counts it, and the client keeps working", async () => {
    let healthy = false;
    const t = new ScriptedTransport(() => (healthy ? 200 : 503));
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 2,
      decideBackoffBaseMs: 10,
      decideBackoffJitterRatio: 0,
      decideMaxAttempts: 3,
      decideQueueMaxWaitMs: 10_000,
    });
    c.beginDecideJob();
    const [a, b] = await Promise.allSettled([c.decide("decide", { id: 0 }), c.decide("decide", { id: 1 })]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect((a as PromiseRejectedResult).reason).toBeInstanceOf(DecideCapacityError);
    expect((a as PromiseRejectedResult).reason.name).toBe("DecideCapacityError");
    const m = c.decideAdmissionMetrics();
    expect(m.decideDropped).toBe(2);
    expect(m.decide503).toBeGreaterThanOrEqual(2);
    expect(m.decidePauses).toBeGreaterThanOrEqual(1);
    // The job is NOT aborted: once the runner recovers the next decide succeeds.
    healthy = true;
    expect((await c.decide("decide", { id: 2 })).status).toBe(200);
  });

  it("a decide past DECIDE_QUEUE_MAX_WAIT_MS is dropped and counted (queue-budget path)", async () => {
    const t = new ScriptedTransport(() => 503);
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 1,
      decideBackoffBaseMs: 8_000, // one long pause: the queue must expire first
      decideBackoffJitterRatio: 0,
      decideMaxAttempts: 10,
      decideQueueMaxWaitMs: 60,
    });
    const first = c.decide("decide", { id: 0 }).catch((e) => e); // takes the single slot, 503s, pauses
    await new Promise((r) => setTimeout(r, 10));
    const queued = c.decide("decide", { id: 1 }); // waits in the queue
    await expect(queued).rejects.toBeInstanceOf(DecideCapacityError);
    expect(await first).toBeInstanceOf(DecideCapacityError);
    const m = c.decideAdmissionMetrics();
    expect(m.decideQueued).toBeGreaterThanOrEqual(1);
    expect(m.decideDropped).toBeGreaterThanOrEqual(1);
  });

  it("a second beginDecideJob on the shared client reports a DELTA, not a zeroed running job", async () => {
    let mode: "503" | "ok" = "503";
    const t = new ScriptedTransport(() => (mode === "503" ? 503 : 200));
    const c = new LivepeerClient("http://orch:8935", t, {
      decideConcurrency: 2,
      decideBackoffBaseMs: 5,
      decideBackoffJitterRatio: 0,
      decideMaxAttempts: 2,
      decideQueueMaxWaitMs: 5_000,
    });
    // Job A sees one lost decide.
    await c.decide("decide", { id: 0 }).catch(() => {});
    const jobA = c.decideAdmissionMetrics();
    expect(jobA.decideDropped).toBe(1);
    // Job B starts on the SAME client: its counters start from the baseline, so
    // A's drops are not reported as B's and A's snapshot is not zeroed.
    mode = "ok";
    c.beginDecideJob();
    await c.decide("decide", { id: 1 });
    const jobB = c.decideAdmissionMetrics();
    expect(jobB.decideDropped).toBe(0);
    // B inherited A's still-open pause, so it may legitimately queue — but A's
    // 503/drop are NOT reported as B's.
    expect(jobB.decide503).toBe(0);
  });

  it("the admission counters mirror onto the job's observe metrics shape", async () => {
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => ({ capacity: 4 }),
    });
    await c.refreshDecideCapacity(true);
    await c.decide("decide", { id: 0 });
    const m = c.decideAdmissionMetrics();
    expect(m).toMatchObject({
      decideQueued: 0,
      decideDropped: 0,
      decide503: 0,
      decidePauses: 0,
      capacityProbeErrors: 0,
      capacity: { advertised: 4, funded: 8, effective: 4 },
    });
  });

});

describe("ADAAAA-8254 summarizeDecideDiscovery", () => {
  it("ignores non-decide runners and reports the stall signal only when every runner says 0 available", () => {
    expect(
      summarizeDecideDiscovery([
        { runners: [runner("highlights-decide", 4, 2), runner("highlights-perceive", 8, 8)] },
      ])
    ).toEqual({ capacity: 4, noneAvailable: false });
    expect(
      summarizeDecideDiscovery([{ runners: [runner("highlights-decide", 4, 0), runner("highlights-live/decide", 2, 0)] }])
    ).toEqual({ capacity: 6, noneAvailable: true });
    // Absent capacity_available is not "zero available".
    expect(summarizeDecideDiscovery([{ runners: [runner("highlights-decide", 4)] }])).toEqual({
      capacity: 4,
      noneAvailable: false,
    });
  });

  it("two consecutive zero-available samples hold the queue (hysteresis, not one noisy sample)", async () => {
    let available: number | undefined = 0;
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => ({ capacity: 8, noneAvailable: available === 0 }),
    });
    await c.refreshDecideCapacity(true);
    expect(c.decideAdmissionMetrics().decidePauses).toBe(0); // one sample = noise
    await c.refreshDecideCapacity(true);
    expect(c.decideAdmissionMetrics().decidePauses).toBe(1); // two = hold
    available = 4;
    await c.refreshDecideCapacity(true);
    expect((await c.decide("decide", { id: 1 })).status).toBe(200);
  });
});

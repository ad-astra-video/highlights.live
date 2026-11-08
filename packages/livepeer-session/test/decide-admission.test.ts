// ADAAAA-8254, revised by ADAAAA-8437: decide admission — the effective ceiling
// FOLLOWS the advertised capacity (up or down) bounded by a safety cap, plus the
// ordered 503 queue with a single-flight probe.
//
// AC coverage in this file (ADAAAA-8437):
//   AC1 effective = advertised whenever the probe is well-formed; DECIDE_CONCURRENCY
//       is no longer a ceiling (advertised 12 + funded 2 -> 12).
//   AC2 the safety cap DECIDE_MAX_ADMISSION (default 32) clamps [1, cap].
//   AC3 a discovery 500 / timeout / malformed advertisement never throws into
//       decide; probe errors are counted and last-known capacity is kept, then
//       the funded value.
//   AC6 advertised 6 -> 6, advertised 12 -> 12, probe dark -> last-known ->
//       funded, advertised 0 -> 1, advertised 1e6 -> cap.
//   ADAAAA-8254 AC3/AC4 keep their coverage: FIFO order, one probe per backoff
//       window during a zero-capacity episode, typed DecideCapacityError + a
//       counted `decideDropped` that never aborts the job.
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

describe("ADAAAA-8437 AC1: admission follows the advertised capacity", () => {
  it("sums the advertised decide capacity (8/2/2 = 12) and admits 12 even with DECIDE_CONCURRENCY=8", async () => {
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
    expect(snap).toEqual({
      advertised: 12,
      funded: 8,
      effective: 12,
      probeOk: true,
      runners: 3,
      source: "probe",
      cap: 32,
    });
    // AC4 startup log line carries the numbers plus the cap.
    expect(seen.at(-1)).toEqual({
      advertised: 12,
      funded: 8,
      effective: 12,
      probeOk: true,
      runners: 3,
      source: "probe",
      cap: 32,
    });
  });

  it("follows the routed 5090 set: advertised 6 -> effective 6 (funded stays 8)", async () => {
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => ({ capacity: 6, runners: 1 }),
    });
    expect(await c.refreshDecideCapacity(true)).toEqual({
      advertised: 6,
      funded: 8,
      effective: 6,
      probeOk: true,
      runners: 1,
      source: "probe",
      cap: 32,
    });
  });

  it("shrinks to a single cap-4 fleet when the pool is smaller than the funded value", async () => {
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => ({ capacity: 4 }),
    });
    const snap = await c.refreshDecideCapacity(true);
    expect(snap).toEqual({ advertised: 4, funded: 8, effective: 4, probeOk: true, runners: 0, source: "probe", cap: 32 });
  });

  it("sizes UP past the funded value: advertised 12 with DECIDE_CONCURRENCY=2 -> 12", async () => {
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 2,
      decideCapacityProbe: async () => ({ capacity: 12, runners: 3 }),
    });
    const snap = await c.refreshDecideCapacity(true);
    expect(snap.effective).toBe(12);
    // `funded` survives for reporting, it is simply not a ceiling any more.
    expect(snap.funded).toBe(2);
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
    expect(await c.refreshDecideCapacity(true)).toEqual({ advertised: 0, funded: 8, effective: 8, probeOk: true, runners: 1, source: "funded", cap: 32 });
  });

  it("unset env + no signer (no probe) is byte-identical to today's static gate", async () => {
    const t = new ScriptedTransport(() => 200);
    const c = new LivepeerClient("http://orch:8935", t);
    // No probe: the funded default (capacity-2 admission, ADAAAA-6911) wins.
    expect(c.decideAdmissionMetrics().capacity).toEqual({ advertised: 0, funded: 2, effective: 2, probeOk: false, runners: 0, source: "funded", cap: 32 });
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
    // ADAAAA-8262: a FAILED probe (probeOk false) is not an empty fleet.
    expect(snap).toEqual({ advertised: 0, funded: 8, effective: 8, probeOk: false, runners: 0, source: "funded", cap: 32 });
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
    // Last known advertised capacity survives the failed probe — and the
    // snapshot says so (`probeOk: false`, `source: "last-known"`), which is
    // exactly the distinction ADAAAA-8254 could not express.
    expect(snap).toEqual({ advertised: 4, funded: 8, effective: 4, probeOk: false, runners: 0, source: "last-known", cap: 32 });
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

  it("ADAAAA-8262: a FAILED probe and an advertisement with no decide runner are distinguishable", async () => {
    let mode: "fail" | "empty" | "zero" = "empty";
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async (): Promise<DecideCapacityProbeResult> => {
        if (mode === "fail") throw new Error("signer discover failed: HTTP 503 cache empty");
        if (mode === "zero") return summarizeDecideDiscovery([{ runners: [runner("highlights-decide", 0, 0)] }]);
        // A well-formed signer answer that carries only a perceive runner.
        return summarizeDecideDiscovery([{ runners: [runner("highlights-perceive", 4)] }]);
      },
    });

    // Probe OK, fleet empty: advertised 0 but `probeOk: true, runners: 0`.
    expect(await c.refreshDecideCapacity(true)).toEqual({
      advertised: 0,
      funded: 8,
      effective: 8,
      probeOk: true,
      runners: 0,
      source: "funded",
      cap: 32,
    });

    // Probe OK, decide runner present but at zero capacity: a REAL advertisement.
    mode = "zero";
    expect(await c.refreshDecideCapacity(true)).toEqual({
      advertised: 0,
      funded: 8,
      effective: 1,
      probeOk: true,
      runners: 1,
      source: "probe",
      cap: 32,
    });

    // Signer dark (503 cache empty): the probe FAILED — the snapshot says so
    // instead of silently reading like an empty fleet. The last advertised
    // number is kept (0 here) and labelled `last-known`.
    mode = "fail";
    const dark = await c.refreshDecideCapacity(true);
    expect(dark).toEqual({
      advertised: 0,
      funded: 8,
      effective: 1,
      probeOk: false,
      runners: 0,
      source: "last-known",
      cap: 32,
    });
    expect(c.decideAdmissionMetrics().capacityProbeErrors).toBe(1);
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
      capacity: { advertised: 4, funded: 8, effective: 4, cap: 32 },
    });
  });

});

describe("ADAAAA-8254 summarizeDecideDiscovery", () => {
  it("ignores non-decide runners and reports the stall signal only when every runner says 0 available", () => {
    expect(
      summarizeDecideDiscovery([
        { runners: [runner("highlights-decide", 4, 2), runner("highlights-perceive", 8, 8)] },
      ])
    ).toEqual({ capacity: 4, noneAvailable: false, runners: 1 });
    expect(
      summarizeDecideDiscovery([{ runners: [runner("highlights-decide", 4, 0), runner("highlights-live/decide", 2, 0)] }])
    ).toEqual({ capacity: 6, noneAvailable: true, runners: 2 });
    // Absent capacity_available is not "zero available".
    expect(summarizeDecideDiscovery([{ runners: [runner("highlights-decide", 4)] }])).toEqual({
      capacity: 4,
      noneAvailable: false,
      runners: 1,
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

describe("ADAAAA-8437 AC2/AC6: the safety cap bounds a malformed advertisement", () => {
  it("advertised 1e6 clamps to the default cap (32)", async () => {
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => ({ capacity: 1_000_000, runners: 3 }),
    });
    const snap = await c.refreshDecideCapacity(true);
    expect(snap.advertised).toBe(1_000_000);
    expect(snap.effective).toBe(32);
    expect(snap.cap).toBe(32);
  });

  it("DECIDE_MAX_ADMISSION (client option) lowers the cap: advertised 12 with cap 8 -> 8", async () => {
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideMaxAdmission: 8,
      decideCapacityProbe: async () => ({ capacity: 12, runners: 3 }),
    });
    const snap = await c.refreshDecideCapacity(true);
    expect(snap).toMatchObject({ advertised: 12, effective: 8, cap: 8 });
    // A cap of 0/negative is clamped to 1, never to 0.
    const zero = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideMaxAdmission: 0,
      decideCapacityProbe: async () => ({ capacity: 12, runners: 3 }),
    });
    expect((await zero.refreshDecideCapacity(true)).effective).toBe(1);
  });

  it("discovery dark: capacity absent keeps last-known, then funded when nothing was ever advertised", async () => {
    let mode: "ok" | "absent" = "ok";
    const c = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => (mode === "ok" ? { capacity: 6, runners: 1 } : { capacity: null }),
    });
    expect((await c.refreshDecideCapacity(true)).effective).toBe(6);
    // `capacity: null` is NOT zero: the last known advertisement survives.
    mode = "absent";
    expect(await c.refreshDecideCapacity(true)).toMatchObject({
      advertised: 6,
      effective: 6,
      source: "last-known",
    });
    // Nothing was ever advertised => funded (AC7).
    const dark = new LivepeerClient("http://orch:8935", new ScriptedTransport(() => 200), {
      decideConcurrency: 8,
      decideCapacityProbe: async () => ({ capacity: null }),
    });
    expect(await dark.refreshDecideCapacity(true)).toMatchObject({
      advertised: 0,
      funded: 8,
      effective: 8,
      source: "funded",
    });
  });
});

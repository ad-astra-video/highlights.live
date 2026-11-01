import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { createServer, type Server } from "node:http";
import { MediaServer } from "../src/server";
import type { ProvisionedSession } from "../src/orch";

// ADAAAA-7689 — media session ownership + close attribution.
//
// F1: `POST /jobs/{id}/media` (control plane) AND the harness/browser both called
// `POST /sessions { jobId }`, so a 24 s browser run reserved and paid for TWO
// perceive sessions: one the browser used, one that idled out on the 60 s
// no-client timer and was still charged at teardown.
//
// F2/AC3: closing that session left the browser job `active` on the control
// plane until somebody called `POST /jobs/:id/stop` by hand, so the node never
// heard about the close at all.

/** Orchestrator stub: every provision() hands out a NEW session id. */
class CountingOrch {
  provisions: string[] = [];
  released: string[] = [];
  closed: string[] = [];
  async provision(): Promise<ProvisionedSession> {
    const n = this.provisions.length + 1;
    const sessionId = `sess-${n}`;
    this.provisions.push(sessionId);
    return {
      sessionId,
      appUrl: "http://fake",
      controlUrl: "http://fake",
      videoIn: `http://orch/video-in/${sessionId}`,
      eventsOut: `http://orch/events-out/${sessionId}`,
      control: `http://orch/control/${sessionId}`,
    };
  }
  startPayment() {}
  stopPayment() {}
  isPaying() {
    return false;
  }
  payingCount() {
    return 0;
  }
  paysOnchain() {
    return false;
  }
  async publishFrame() {
    return 200;
  }
  async readObservation() {
    return null;
  }
  async releaseSession(sessionId: string) {
    this.released.push(sessionId);
  }
  async closeSession(sessionId: string) {
    this.closed.push(sessionId);
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function build(opts: Record<string, any> = {}, orch = new CountingOrch()) {
  const ms = new MediaServer(
    { orchBase: "http://orch", reconnectGraceMs: 40, provisionNoClientMs: 0, ...opts },
    orch as any,
  );
  const app: FastifyInstance = await ms.build();
  cleanups.push(() => app.close());
  return { app, orch };
}

/** A local control-plane stand-in that records the session-closed callbacks. */
async function controlPlaneStub(): Promise<{
  base: string;
  calls: any[];
  headers: any[];
  close: () => Promise<void>;
}> {
  const calls: any[] = [];
  const headers: any[] = [];
  const srv: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ url: req.url, method: req.method, body: raw ? JSON.parse(raw) : null });
      headers.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  return {
    base,
    calls,
    headers,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

const health = async (app: FastifyInstance) => (await app.inject({ method: "GET", url: "/health" })).json();

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("browser job owns ONE media session (ADAAAA-7689 AC1)", () => {
  it("adopts the job's live session instead of reserving a second one", async () => {
    const { app, orch } = await build();
    // 1st call: the control plane's POST /jobs/:id/media provision.
    const first = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-a" } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ sessionId: "sess-1", jobId: "job-a", reused: false });
    // 2nd call: the browser/harness asking again for the SAME job.
    const second = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-a" } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ sessionId: "sess-1", jobId: "job-a", reused: true });

    // Exactly one perceive session was reserved for the job, and the node is
    // still holding only that one lease.
    expect(orch.provisions).toEqual(["sess-1"]);
    const h = await health(app);
    expect(h.capacity).toMatchObject({ provisionAttempts: 2, provisionReuses: 1, activeSessions: 1 });
    expect(h.leases.total).toBe(1);
  });

  it("keeps different jobs (and anonymous probes) on their own sessions", async () => {
    const { app, orch } = await build();
    const a = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-a" } });
    const b = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-b" } });
    // A probe with no job id can never adopt a job's session.
    const probe1 = await app.inject({ method: "POST", url: "/sessions", payload: {} });
    const probe2 = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "" } });
    expect(new Set([a.json().sessionId, b.json().sessionId])).toEqual(new Set(["sess-1", "sess-2"]));
    expect([probe1.json().sessionId, probe2.json().sessionId]).toEqual(["sess-3", "sess-4"]);
    expect(orch.provisions).toHaveLength(4);
    expect((await health(app)).capacity.provisionReuses).toBe(0);
  });

  it("hands the browser the SAME session it then connects to (+1 completed session)", async () => {
    const { app, orch } = await build();
    await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-c" } });
    const adopted = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-c" } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as any).port}`;

    // The browser connects to the session the control-plane route handed it.
    const ws = new WebSocket(`${base.replace("http", "ws")}/stream/${adopted.json().sessionId}`);
    const closed = new Promise<void>((res, rej) => {
      ws.on("error", rej);
      ws.on("close", () => res());
    });
    await new Promise<void>((res, rej) => {
      ws.on("open", () => res());
      ws.on("error", rej);
    });
    // AC2: a browser run charges ONE session (never the abandoned twin).
    ws.close();
    await closed;
    await waitFor(() => orch.released.length === 1);

    const h = await health(app);
    expect(h.cost).toMatchObject({ sessionsCompleted: 1, sessionsUnused: 0 });
    // A ~0 s harness run: session seconds are the stream's own age only, nowhere
    // near the 60 s a no-client teardown used to bill.
    expect(h.cost.sessionSeconds).toBeLessThan(5);
    expect(h.capacity.activeSessions).toBe(0);
  });

  it("an abandoned provision is counted as unused, never as a completed session", async () => {
    const { app } = await build({ provisionNoClientMs: 40 });
    const created = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-d" } });
    expect(created.statusCode).toBe(200);
    // No browser ever connects: the node releases the slot on its no-client timer.
    await new Promise((r) => setTimeout(r, 120));
    const h = await health(app);
    expect(h.capacity.activeSessions).toBe(0);
    expect(h.cost).toMatchObject({ sessionsCompleted: 0, sessionsUnused: 1, sessionSeconds: 0 });
  });
});

describe("session close is reported to the control plane (ADAAAA-7689 AC3)", () => {
  it("POSTs session-closed with the job, the session and the close reason", async () => {
    const cp = await controlPlaneStub();
    cleanups.push(cp.close);
    const { app } = await build({ callbackBase: cp.base });
    const created = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-e" } });
    const sid = created.json().sessionId;

    const closed = await app.inject({ method: "POST", url: `/sessions/${sid}/close` });
    expect(closed.statusCode).toBe(200);
    await waitFor(() => cp.calls.length === 1);

    expect(cp.calls[0].url).toBe("/jobs/job-e/media/session-closed");
    expect(cp.calls[0].body).toMatchObject({
      sessionId: sid,
      jobId: "job-e",
      reason: "control-close",
      neverAttached: true,
      nodeId: "media-0",
      transport: "ws",
    });
    expect((await health(app)).cost.sessionClosedNotifies).toBe(1);
  });

  it("reports a client close (browser dropped) as client-closed after the grace window", async () => {
    const cp = await controlPlaneStub();
    cleanups.push(cp.close);
    const { app } = await build({ callbackBase: cp.base, reconnectGraceMs: 30 });
    const created = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-f" } });
    const sid = created.json().sessionId;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
    const ws = new WebSocket(`${base.replace("http", "ws")}/stream/${sid}`);
    await new Promise<void>((res, rej) => {
      ws.on("open", () => res());
      ws.on("error", rej);
    });
    ws.close();
    await waitFor(() => cp.calls.length === 1);
    expect(cp.calls[0].body).toMatchObject({ jobId: "job-f", reason: "client-closed", neverAttached: false });
  });

  it("carries the shared health token when one is configured", async () => {
    const cp = await controlPlaneStub();
    cleanups.push(cp.close);
    const { app } = await build({ callbackBase: cp.base, healthToken: "tok-abc" });
    const created = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-g" } });
    await app.inject({ method: "POST", url: `/sessions/${created.json().sessionId}/close` });
    await waitFor(() => cp.headers.length === 1);
    expect(cp.headers[0].authorization).toBe("Bearer tok-abc");
  });
});

describe("restart attribution surface (ADAAAA-7689 AC4)", () => {
  it("publishes the boot id, the running build revision and the restart cause", async () => {
    const lifecycle = () => ({
      boots: 4,
      bootId: "boot-4",
      buildRef: "abc1234",
      lastStartAt: "2026-11-01T21:10:00.000Z",
      lastExit: { at: "2026-11-01T21:09:58.000Z", code: null, signal: null, reason: "unobserved-exit" },
      previousBoot: {
        at: Date.parse("2026-11-01T20:55:00.000Z"),
        atIso: "2026-11-01T20:55:00.000Z",
        bootId: "boot-3",
        buildRef: "abc1234",
        exit: { at: "2026-11-01T21:09:58.000Z", code: null, signal: null, reason: "unobserved-exit" },
      },
      restartCause: "crash" as const,
      windowS: 600,
      threshold: 3,
      bootsInWindow: 2,
      degraded: false,
    });
    const { app } = await build({ lifecycle });
    const h = await health(app);
    expect(h.restarts).toMatchObject({
      boots: 4,
      bootId: "boot-4",
      buildRef: "abc1234",
      restartCause: "crash",
      lastExit: { reason: "unobserved-exit" },
      previousBoot: { bootId: "boot-3", buildRef: "abc1234" },
    });
  });
});

import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MediaServer } from "../src/server";
import type { ProvisionedSession } from "../src/orch";

// ADAAAA-6869 Phase 4: the media node must publish a capacity/health surface
// (load, session/lease state, payment, per-node cost meter) and must NOT leak
// session/job identifiers on the public `/health` route. The identifier-carrying
// per-session detail lives on `GET /node`, which stays bearer-gated.

class FakeOrch {
  provisioned: ProvisionedSession = {
    sessionId: "sess-health",
    appUrl: "http://fake",
    controlUrl: "http://fake",
    videoIn: "http://orch/video-in",
    eventsOut: "http://orch/events-out",
    control: "http://orch/control",
  };
  async provision(): Promise<ProvisionedSession> {
    return this.provisioned;
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
  async releaseSession() {}
  async closeSession() {}
}

async function build(opts: Record<string, any> = {}) {
  const ms = new MediaServer(
    { orchBase: "http://orch", reconnectGraceMs: 60_000, provisionNoClientMs: 60_000, ...opts },
    new FakeOrch() as any,
  );
  const app: FastifyInstance = await ms.build();
  return app;
}

describe("media node capacity/health surface (ADAAAA-6869)", () => {
  it("publishes node identity + capacity/load and no identifiers while idle", async () => {
    const app = await build({ nodeId: "media-0", maxSessions: 1 });
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    const h = r.json();
    expect(h.status).toBe("ok");
    expect(h.node).toMatchObject({ id: "media-0", role: "media" });
    expect(h.capacity).toMatchObject({
      maxSessions: 1,
      activeSessions: 0,
      availableSessions: 1,
      loadPct: 0,
      saturated: false,
    });
    expect(h.leases).toMatchObject({ active: 0, grace: 0, awaitingClient: 0, total: 0 });
    expect(h.sessions).toBeUndefined(); // counts-only on the public route
    await app.close();
  });

  it("reports an active lease + saturation once a session is provisioned", async () => {
    const app = await build({ nodeId: "media-0", maxSessions: 1 });
    const created = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-h1" } });
    expect(created.statusCode).toBe(200);
    // The node hands the control plane its identity for per-node attribution.
    expect(created.json().nodeId).toBe("media-0");
    const h = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(h.capacity).toMatchObject({ activeSessions: 1, availableSessions: 0, loadPct: 100, saturated: true });
    expect(h.leases).toMatchObject({ awaitingClient: 1, active: 0, total: 1 });
    expect(h.capacity.provisionAttempts).toBe(1);
    // Public route must not carry the session or job id.
    expect(JSON.stringify(h)).not.toContain("sess-health");
    expect(JSON.stringify(h)).not.toContain("job-h1");
    await app.close();
  });

  it("gates the per-session detail on GET /node behind MEDIA_HEALTH_TOKEN", async () => {
    const app = await build({ nodeId: "media-0", healthToken: "tok-123" });
    await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-h2" } });

    const anon = await app.inject({ method: "GET", url: "/node" });
    expect(anon.statusCode).toBe(401);

    const ok = await app.inject({ method: "GET", url: "/node", headers: { authorization: "Bearer tok-123" } });
    expect(ok.statusCode).toBe(200);
    const d = ok.json();
    expect(d.sessions).toHaveLength(1);
    expect(d.sessions[0]).toMatchObject({
      sessionId: "sess-health",
      jobId: "job-h2",
      transport: "ws",
      lease: { state: "awaiting-client" },
    });
    await app.close();
  });

  it("disables the detail route (404) when no health token is configured", async () => {
    const app = await build({ nodeId: "media-0" });
    const r = await app.inject({ method: "GET", url: "/node" });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it("accrues the per-node cost meter when a session is torn down", async () => {
    const app = await build({ nodeId: "media-0" });
    await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-h3" } });
    const closed = await app.inject({ method: "POST", url: "/sessions/sess-health/close" });
    expect(closed.statusCode).toBe(200);
    const h = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(h.cost.sessionsCompleted).toBe(1);
    expect(h.cost.sessionSeconds).toBeGreaterThanOrEqual(0);
    expect(h.capacity.activeSessions).toBe(0);
    await app.close();
  });
});

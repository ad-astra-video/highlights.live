import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildTestApp } from "./helpers";

// ADAAAA-6738 G1: the webapp-relay analysis persistence routes. Verifies the
// owner-scoped write path (auth + ownership) and that the relayed perceive
// analysis data / trace actually lands in the store (and thus the durable Db).
describe("analysis persistence routes (ADAAAA-6738 G1)", () => {
  let app: any;
  let store: any;
  let token: string;
  let userId: string;
  let job: any;

  beforeAll(async () => {
    const built = await buildTestApp();
    app = built.app;
    store = built.store;
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "g1@test.dev", password: "password123" } });
    expect(reg.statusCode).toBe(200);
    token = reg.json().token as string;
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    userId = me.json().user.id as string;
    job = await store.createJob({ ownerId: userId, source: "browser" });
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it("persists relayed analysis events (owner-scoped)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/analysis/events`,
      headers: { authorization: `Bearer ${token}` },
      payload: { events: [{ timestamp: 1, kind: "audio_energy", data: { level: 3 } }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().persisted).toBe(1);
    // Invalid rows are skipped, not fatal.
    const mixed = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/analysis/events`,
      headers: { authorization: `Bearer ${token}` },
      payload: { events: [{ timestamp: 2, kind: "detection", data: {} }, { bad: "row" }] },
    });
    expect(mixed.statusCode).toBe(200);
    expect(mixed.json().persisted).toBe(1);
    expect(await store.listAnalysisEvents(job.id)).toHaveLength(2);
  });

  it("persists a relayed analysis-session trace", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/analysis/trace`,
      headers: { authorization: `Bearer ${token}` },
      payload: { trace: { at: 1000, tool: "get_tracked_players", request: { tool: "get_tracked_players" }, response: { count: 8 } } },
    });
    expect(r.statusCode).toBe(200);
    expect(await store.listAnalysisTraces(job.id)).toHaveLength(1);
  });

  it("rejects a cross-owner write with 403 and a bad trace with 422", async () => {
    const other = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "g1-other@test.dev", password: "password123" } });
    const otherToken = other.json().token as string;
    const denied = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/analysis/events`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { events: [{ timestamp: 3, kind: "caption", data: {} }] },
    });
    expect(denied.statusCode).toBe(403);

    const badTrace = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/analysis/trace`,
      headers: { authorization: `Bearer ${token}` },
      payload: { trace: { noRequest: true } },
    });
    expect(badTrace.statusCode).toBe(422);
  });
});

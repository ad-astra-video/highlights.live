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

  it("exposes the analysis-session trace + events as inspectable GET routes (owner-scoped)", async () => {
    // POST a distinctive trace + event, then read them back (timeline-ordered).
    await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/analysis/trace`,
      headers: { authorization: `Bearer ${token}` },
      payload: { trace: { at: 2000, tool: "get_audio_levels", request: { tool: "get_audio_levels" }, response: { peakEnergy: 0.9 } } },
    });
    expect(
      await app.inject({
        method: "POST",
        url: `/jobs/${job.id}/analysis/events`,
        headers: { authorization: `Bearer ${token}` },
        payload: { events: [{ timestamp: 7, kind: "detection", data: { label: "ball" } }] },
      })
    ).toMatchObject({ statusCode: 200 });
    const evPost = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/analysis/events`,
      headers: { authorization: `Bearer ${token}` },
      payload: { events: [{ timestamp: 8, kind: "caption", data: { text: "GOAL" } }] },
    });
    expect(evPost.json()).toMatchObject({ ok: true, persisted: 1 });

    const tr = await app.inject({ method: "GET", url: `/jobs/${job.id}/analysis/trace`, headers: { authorization: `Bearer ${token}` } });
    expect(tr.statusCode).toBe(200);
    const traces = tr.json().traces;
    expect(traces.some((t: any) => t.tool === "get_audio_levels" && t.at === 2000)).toBe(true);
    // Timeline-ordered (oldest first): the appended trace is last.
    expect(traces[0].at).toBeLessThanOrEqual(traces[traces.length - 1].at);

    const ev = await app.inject({ method: "GET", url: `/jobs/${job.id}/analysis/events`, headers: { authorization: `Bearer ${token}` } });
    expect(ev.statusCode).toBe(200);
    expect(ev.json().events.some((e: any) => e.kind === "detection" && e.timestamp === 7)).toBe(true);

    // Cross-owner read -> 403.
    const other = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "g1-read@test.dev", password: "password123" } });
    const denied = await app.inject({ method: "GET", url: `/jobs/${job.id}/analysis/trace`, headers: { authorization: `Bearer ${other.json().token}` } });
    expect(denied.statusCode).toBe(403);
  });
});

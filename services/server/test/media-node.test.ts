import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMediaNodeReport } from "../src/media-node";
import {
  attributeLiveIngest,
  fetchMediaNodeIdentity,
  ingestSessionId,
  isMediaTierLiveSource,
} from "../src/media-ingest";
import { buildTestApp } from "./helpers";

// ADAAAA-6869 Phase 4: media-node capacity/health + per-node cost attribution.
// The pure builder is asserted directly (no live node, no DB), and the
// GET /media/node route is asserted through its two failure modes: node
// unreachable (degrade to cost-only) and node healthy + detail configured.

const job = (id: string, costUsd?: number) => ({ id, costUsd } as any);
const sess = (jobId: string, nodeId: string | null) =>
  ({
    jobId,
    sessionId: `s-${jobId}`,
    streamId: "st",
    wsUrl: "ws://x",
    mediaOrigin: "http://media:4070",
    nodeId,
    status: "active",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
  } as any);

const health = {
  status: "ok",
  node: { id: "media-0", role: "media", uptimeS: 120 },
  capacity: {
    maxSessions: 1,
    activeSessions: 1,
    availableSessions: 0,
    loadPct: 100,
    saturated: true,
    provisionAttempts: 4,
    provisionFailures: 1,
    noCapacityFailures: 1,
  },
  leases: { active: 1, grace: 0, awaitingClient: 0, paying: 1, total: 1 },
  payment: { onchain: true, payingSessions: 1 },
  cost: { basis: "media-node session meter", sessionsCompleted: 7, sessionSeconds: 812.4 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildMediaNodeReport", () => {
  it("attributes job.costUsd to the node recorded on the job's media session", () => {
    const r = buildMediaNodeReport({
      origin: "http://media:4070",
      health,
      detail: { ...health, sessions: [{ sessionId: "s-j1", jobId: "j1", transport: "webrtc", ageS: 9, sockets: 1, recording: false, paying: true, lease: { state: "active", expiresInS: null } }] },
      mediaSessions: [sess("j1", "media-0"), sess("j2", "media-0"), sess("j3", null)],
      jobs: [job("j1", 0.0863), job("j2", 0.5), job("j3", 0.25), job("j4")],
    });
    expect(r.reachable).toBe(true);
    expect(r.node).toMatchObject({ id: "media-0" });
    expect(r.capacity).toMatchObject({ loadPct: 100, saturated: true });
    expect(r.detailAvailable).toBe(true);
    expect(r.sessions).toHaveLength(1);
    expect(r.meter).toMatchObject({ sessionsCompleted: 7 });
    // j1+j2 attributed to media-0; j3's session predates node_id -> its spend is
    // still counted, under `unattributed`, so the total never silently drops.
    const byId = Object.fromEntries(r.cost.perNode.map((n) => [n.nodeId, n]));
    expect(byId["media-0"]).toMatchObject({ jobs: 2, costUsd: 0.5863, sessions: 2 });
    expect(byId.unattributed).toMatchObject({ jobs: 1, costUsd: 0.25 });
    expect(r.cost.total).toMatchObject({ nodes: 2, jobs: 3, costUsd: 0.8363 });
    // A job with no recorded costUsd is never counted as free spend.
    expect(r.cost.total.jobs).toBe(3);
  });

  it("degrades to cost-only when the node is unreachable", () => {
    const r = buildMediaNodeReport({
      origin: "http://media:4070/",
      health: null,
      mediaSessions: [sess("j1", "media-0")],
      jobs: [job("j1", 0.02)],
    });
    expect(r.reachable).toBe(false);
    expect(r.node).toBeNull();
    expect(r.capacity).toBeNull();
    expect(r.sessions).toEqual([]);
    expect(r.detailAvailable).toBe(false);
    // The node id is derived from the configured origin while it is down.
    expect(r.cost.perNode.map((n) => n.nodeId)).toEqual(["media-0"]);
    expect(r.cost.total.costUsd).toBe(0.02);
  });
});

describe("GET /media/node", () => {
  async function register(app: any): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "node@test.dev", password: "password123" },
    });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }

  it("requires authentication", async () => {
    const { app } = await buildTestApp({ MEDIA_SERVER_URL: "http://media:4070" });
    const r = await app.inject({ method: "GET", url: "/media/node" });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it("reports unreachable when the media node does not answer", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    const { app } = await buildTestApp({ MEDIA_SERVER_URL: "http://media:4070" });
    const token = await register(app);
    const r = await app.inject({ method: "GET", url: "/media/node", headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.reachable).toBe(false);
    expect(body.cost.total.costUsd).toBe(0);
    await app.close();
  });

  it("proxies capacity/health and the token-gated lease detail", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: any, init: any) => {
      calls.push(String(url));
      const payload = String(url).endsWith("/health")
        ? { status: "ok", node: health.node, capacity: health.capacity, leases: health.leases, payment: health.payment, cost: health.cost }
        : { ...health, sessions: [{ sessionId: "s-j1", jobId: "j1", transport: "ws", ageS: 3, sockets: 1, recording: false, paying: false, lease: { state: "active", expiresInS: null } }] };
      // The detail surface must be presented with the configured bearer.
      if (String(url).endsWith("/node")) expect(init?.headers?.authorization).toBe("Bearer hel-tok");
      return { ok: true, status: 200, json: async () => payload } as any;
    });
    const { app } = await buildTestApp({ MEDIA_SERVER_URL: "http://media:4070", MEDIA_HEALTH_TOKEN: "hel-tok" });
    const token = await register(app);
    const r = await app.inject({ method: "GET", url: "/media/node", headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(calls).toEqual(["http://media:4070/health", "http://media:4070/node"]);
    expect(body.reachable).toBe(true);
    expect(body.capacity).toMatchObject({ activeSessions: 1, saturated: true });
    expect(body.leases).toMatchObject({ active: 1, paying: 1 });
    expect(body.detailAvailable).toBe(true);
    expect(body.sessions[0]).toMatchObject({ sessionId: "s-j1", jobId: "j1" });
    await app.close();
  });
});

// ADAAAA-7670: live ingest that never provisions a media session (RTMP-pull is
// pulled server-side in live.ts) is attributed from the ingest path, so its
// spend lands on the node that carried it instead of on `unattributed`.
describe("media-tier attribution for live ingest (ADAAAA-7670)", () => {
  const ingestRow = (jobId: string, nodeId: string) => ({
    jobId,
    sessionId: ingestSessionId(jobId),
    streamId: jobId,
    wsUrl: "",
    mediaOrigin: "http://media:4070",
    nodeId,
    status: "closed" as const,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  });

  const okHealth = (id: string) =>
    ({ ok: true, status: 200, json: async () => ({ status: "ok", node: { id } }) }) as any;

  function fakeDb(seed: any[] = []) {
    const rows = [...seed];
    const written: any[] = [];
    return {
      rows,
      written,
      async getMediaSession(jobId: string) {
        return rows.find((r) => r.jobId === jobId);
      },
      async setMediaSession(ms: any) {
        written.push(ms);
        const i = rows.findIndex((r) => r.jobId === ms.jobId);
        if (i >= 0) rows[i] = ms;
        else rows.push(ms);
      },
    };
  }

  it("classifies the live sources as media-tier and keeps VOD `file` out", () => {
    for (const s of ["rtmp", "webrtc", "screenshare", "screen", "file-sim"]) expect(isMediaTierLiveSource(s)).toBe(true);
    for (const s of ["file", "upload", "", null, undefined]) expect(isMediaTierLiveSource(s)).toBe(false);
  });

  it("takes the node id the media server reports, and nothing when it cannot", async () => {
    vi.stubGlobal("fetch", async () => okHealth("media-7"));
    await expect(fetchMediaNodeIdentity("http://media:4070/")).resolves.toEqual({
      nodeId: "media-7",
      origin: "http://media:4070",
    });
    // Answers, but does not identify itself -> not attributable.
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ status: "ok" }) }) as any);
    await expect(fetchMediaNodeIdentity("http://media:4070")).resolves.toBeNull();
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(fetchMediaNodeIdentity("http://media:4070")).resolves.toBeNull();
    await expect(fetchMediaNodeIdentity(undefined)).resolves.toBeNull();
  });

  it("records a settled ingest row and splits perNode per node", async () => {
    vi.stubGlobal("fetch", async () => okHealth("media-0"));
    const db = fakeDb();
    const row = await attributeLiveIngest({ db, mediaServerUrl: "http://media:4070", jobId: "rtmp-1", source: "rtmp" });
    expect(row).toMatchObject({
      jobId: "rtmp-1",
      sessionId: "ingest:rtmp-1",
      streamId: "rtmp-1",
      wsUrl: "",
      mediaOrigin: "http://media:4070",
      nodeId: "media-0",
      status: "closed",
    });
    expect(db.written).toHaveLength(1);

    // A pre-migration row (node_id NULL) keeps its historical job under
    // `unattributed` while the RTMP-pull job lands on media-0.
    const r = buildMediaNodeReport({
      origin: "http://media:4070",
      health,
      mediaSessions: [row!, sess("legacy-1", null)],
      jobs: [job("rtmp-1", 0.25), job("legacy-1", 0.5)],
    });
    const byId = Object.fromEntries(r.cost.perNode.map((n) => [n.nodeId, n]));
    expect(byId["media-0"]).toMatchObject({ jobs: 1, costUsd: 0.25, sessions: 1 });
    expect(byId.unattributed).toMatchObject({ jobs: 1, costUsd: 0.5, sessions: 1 });
    expect(r.cost.perNode).toHaveLength(2);
    expect(r.cost.total).toMatchObject({ nodes: 2, jobs: 2, costUsd: 0.75 });
  });

  it("publishes one perNode row per node in a two-node fleet", async () => {
    vi.stubGlobal("fetch", async () => okHealth("media-0"));
    const db = fakeDb();
    await attributeLiveIngest({ db, mediaServerUrl: "http://media:4070", jobId: "a", source: "rtmp" });
    await attributeLiveIngest({ db, mediaServerUrl: "http://media:4070", jobId: "b", source: "screenshare" });
    const r = buildMediaNodeReport({
      origin: "http://media:4070",
      health,
      // The fleet shape: two different nodes carried one ingest each.
      mediaSessions: [ingestRow("a", "media-0"), ingestRow("b", "media-1")],
      jobs: [job("a", 0.1), job("b", 0.3)],
    });
    const byId = Object.fromEntries(r.cost.perNode.map((n) => [n.nodeId, n]));
    expect(byId["media-0"]).toMatchObject({ jobs: 1, costUsd: 0.1 });
    expect(byId["media-1"]).toMatchObject({ jobs: 1, costUsd: 0.3 });
    expect(r.cost.perNode.map((n) => n.nodeId)).toHaveLength(2);
    expect(r.cost.total).toMatchObject({ nodes: 2, jobs: 2, costUsd: 0.4 });
  });

  it("leaves a job unattributed when the node is unreachable or unconfigured", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    const db = fakeDb();
    await expect(
      attributeLiveIngest({ db, mediaServerUrl: "http://media:4070", jobId: "rtmp-2", source: "rtmp" })
    ).resolves.toBeNull();
    await expect(attributeLiveIngest({ db, mediaServerUrl: undefined, jobId: "rtmp-3", source: "rtmp" })).resolves.toBeNull();
    expect(db.written).toHaveLength(0);
    const r = buildMediaNodeReport({
      origin: "http://media:4070",
      health: null,
      mediaSessions: [],
      jobs: [job("rtmp-2", 0.4)],
    });
    expect(r.cost.perNode.map((n) => n.nodeId)).toEqual(["unattributed"]);
    expect(r.cost.total.costUsd).toBe(0.4);
  });

  it("never re-labels a job that already has a media session row", async () => {
    vi.stubGlobal("fetch", async () => okHealth("media-1"));
    const db = fakeDb([sess("j1", "media-0")]);
    const row = await attributeLiveIngest({ db, mediaServerUrl: "http://media:4070", jobId: "j1", source: "webrtc" });
    expect(row?.nodeId).toBe("media-0");
    expect(db.written).toHaveLength(0);
  });

  it("never probes the media node for VOD jobs", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const db = fakeDb();
    for (const source of ["file", "upload"]) {
      await expect(
        attributeLiveIngest({ db, mediaServerUrl: "http://media:4070", jobId: `vod-${source}`, source })
      ).resolves.toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.written).toHaveLength(0);
  });
});

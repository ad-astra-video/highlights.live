import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteDb, type MediaSession } from "../src/db";
import { Store } from "../src/store";
import { probeMediaNode, sweepDetachedMediaSessions } from "../src/media-session-sweep";

// ADAAAA-8824: the control-plane backstop for a media node that NEVER returns.
// The media node releases its own ledger leftovers at boot (ADAAAA-8813), but a
// node that is removed/pulled/host-dead never boots — its orchestrator
// live-runner sessions keep `Accounted payment` every 5 s and hold the
// capacity-1 perceive slot until balance expiry. These tests pin the sweep that
// stops them, against a FAKE media node (a real local HTTP server), at $0.

const TOKEN = "test-health-token";

function session(jobId: string, over: Partial<MediaSession> = {}): MediaSession {
  const at = new Date().toISOString();
  return {
    jobId,
    sessionId: `sess-${jobId}`,
    streamId: jobId,
    wsUrl: "ws://media.test/ingest",
    mediaOrigin: "http://media.test",
    nodeId: "media-0",
    status: "active",
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

function tmpDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "hl-media-sweep-"));
  const db = new SqliteDb(path.join(dir, "test.db"));
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Fake media node. `sessions` is what `GET /node` lists. */
async function fakeNode(opts: {
  sessions: string[];
  token?: string;
  status?: number;
  body?: unknown;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url !== "/node") {
      res.writeHead(404).end("{}");
      return;
    }
    const expected = opts.token ?? TOKEN;
    const presented = String(req.headers.authorization ?? "");
    if (presented !== `Bearer ${expected}`) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
      return;
    }
    const status = opts.status ?? 200;
    const body =
      opts.body ??
      {
        status: "ok",
        node: { id: "media-0", role: "media" },
        sessions: opts.sessions.map((sessionId) => ({ sessionId, jobId: "j", lease: { state: "active" } })),
      };
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A port nothing listens on: connection refused = "the node never returns". */
const DEAD_NODE_URL = "http://127.0.0.1:1";

function countingStopper() {
  const stops: string[] = [];
  return {
    stops,
    stopper: {
      stopPerceive: async (sessionId: string) => {
        stops.push(sessionId);
      },
    },
  };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

describe("media-session sweep: detached sessions are released (ADAAAA-8824)", () => {
  it("(a) node unreachable => exactly one stop per in-flight session, rows settled, re-run is a no-op", async () => {
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      for (const id of ["job-a", "job-b"]) {
        await store.createJob({ id, ownerId: "u1", source: "browser" });
        await store.patchJob(id, { status: "active" });
        await db.setMediaSession(session(id));
      }
      const { stops, stopper } = countingStopper();
      const run = () =>
        sweepDetachedMediaSessions({
          db,
          getJob: (id) => store.getJob(id),
          mediaServerUrl: DEAD_NODE_URL,
          mediaHealthToken: TOKEN,
          stopper,
          probeAttempts: 1,
        });

      const first = await run();
      expect(first.enabled).toBe(true);
      expect(first.node).toBe("unreachable");
      expect(first.candidates).toBe(2);
      expect(first.released).toBe(2);
      expect(first.releasedSessionIds.sort()).toEqual(["sess-job-a", "sess-job-b"]);
      expect(stops.sort()).toEqual(["sess-job-a", "sess-job-b"]);
      // A confirmed stop settles the row (kept, attribution intact) so the
      // session can never be re-used against a node that does not hold it.
      expect((await db.getMediaSession("job-a"))?.status).toBe("closed");
      expect((await db.getMediaSession("job-a"))?.nodeId).toBe("media-0");

      // (d) re-run: one stop per session TOTAL — nothing left to release.
      const again = await run();
      expect(again.candidates).toBe(0);
      expect(again.released).toBe(0);
      expect(stops).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it("(b) node serves another session but not this one => only the absent session is stopped", async () => {
    const node = await fakeNode({ sessions: ["sess-job-served"] });
    open.push(node.close);
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      for (const id of ["job-served", "job-detached"]) {
        await store.createJob({ id, ownerId: "u1", source: "browser" });
        await store.patchJob(id, { status: "active" });
        await db.setMediaSession(session(id));
      }
      const { stops, stopper } = countingStopper();
      const rec = await sweepDetachedMediaSessions({
        db,
        getJob: (id) => store.getJob(id),
        mediaServerUrl: node.url,
        mediaHealthToken: TOKEN,
        stopper,
      });
      expect(rec.node).toBe("served");
      expect(rec.served).toBe(1);
      expect(rec.released).toBe(1);
      expect(stops).toEqual(["sess-job-detached"]);
      expect((await db.getMediaSession("job-served"))?.status).toBe("active");
      expect((await db.getMediaSession("job-detached"))?.status).toBe("closed");

      // Re-run: the settled row is no longer a candidate; the served one stays.
      const again = await sweepDetachedMediaSessions({
        db,
        getJob: (id) => store.getJob(id),
        mediaServerUrl: node.url,
        mediaHealthToken: TOKEN,
        stopper,
      });
      expect(again.released).toBe(0);
      expect(stops).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("(c) node serves the session => no stop, row stays active", async () => {
    const node = await fakeNode({ sessions: ["sess-job-live"] });
    open.push(node.close);
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      await store.createJob({ id: "job-live", ownerId: "u1", source: "browser" });
      await store.patchJob("job-live", { status: "active" });
      await db.setMediaSession(session("job-live"));
      const { stops, stopper } = countingStopper();
      const rec = await sweepDetachedMediaSessions({
        db,
        getJob: (id) => store.getJob(id),
        mediaServerUrl: node.url,
        mediaHealthToken: TOKEN,
        stopper,
      });
      expect(rec.node).toBe("served");
      expect(rec.served).toBe(1);
      expect(rec.released).toBe(0);
      expect(stops).toEqual([]);
      expect((await db.getMediaSession("job-live"))?.status).toBe("active");
    } finally {
      cleanup();
    }
  });

  it("terminal jobs are not candidates (the boot reconcile owns those rows)", async () => {
    const node = await fakeNode({ sessions: [] });
    open.push(node.close);
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      await store.createJob({ id: "job-done", ownerId: "u1", source: "browser" });
      await store.patchJob("job-done", { status: "active" });
      await db.setMediaSession(session("job-done"));
      await store.patchJob("job-done", { status: "failed" });
      // Simulate a pre-hook row: force it back to `active` on a terminal job.
      await db.setMediaSession(session("job-done"));
      const { stops, stopper } = countingStopper();
      const rec = await sweepDetachedMediaSessions({
        db,
        getJob: (id) => store.getJob(id),
        mediaServerUrl: node.url,
        mediaHealthToken: TOKEN,
        stopper,
      });
      expect(rec.scanned).toBe(1);
      expect(rec.candidates).toBe(0);
      expect(rec.released).toBe(0);
      expect(stops).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("media-session sweep: the safety gates (a misconfig must never kill a live stream)", () => {
  it("is inert without MEDIA_HEALTH_TOKEN (GET /node answers 404 when detail is disabled)", async () => {
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      await store.createJob({ id: "job-live", ownerId: "u1", source: "browser" });
      await store.patchJob("job-live", { status: "active" });
      await db.setMediaSession(session("job-live"));
      const { stops, stopper } = countingStopper();
      const rec = await sweepDetachedMediaSessions({
        db,
        getJob: (id) => store.getJob(id),
        mediaServerUrl: DEAD_NODE_URL,
        stopper,
      });
      expect(rec.enabled).toBe(false);
      expect(rec.disabledReason).toContain("MEDIA_HEALTH_TOKEN");
      expect(stops).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("is inert without MEDIA_SERVER_URL", async () => {
    const { stops, stopper } = countingStopper();
    const rec = await sweepDetachedMediaSessions({
      db: { listMediaSessions: async () => [], closeMediaSession: async () => false },
      getJob: () => undefined,
      stopper,
    });
    expect(rec.enabled).toBe(false);
    expect(rec.disabledReason).toContain("MEDIA_SERVER_URL");
    expect(stops).toEqual([]);
  });

  it("an unauthorized node (401 token mismatch) stops NOTHING — unverified, not detached", async () => {
    const node = await fakeNode({ sessions: [], token: "a-different-token" });
    open.push(node.close);
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      await store.createJob({ id: "job-live", ownerId: "u1", source: "browser" });
      await store.patchJob("job-live", { status: "active" });
      await db.setMediaSession(session("job-live"));
      const { stops, stopper } = countingStopper();
      const rec = await sweepDetachedMediaSessions({
        db,
        getJob: (id) => store.getJob(id),
        mediaServerUrl: node.url,
        mediaHealthToken: TOKEN,
        stopper,
      });
      expect(rec.node).toBe("unverified");
      expect(rec.unverified).toBe(1);
      expect(rec.released).toBe(0);
      expect(stops).toEqual([]);
      expect((await db.getMediaSession("job-live"))?.status).toBe("active");
    } finally {
      cleanup();
    }
  });

  it("a degraded node (5xx) stops nothing", async () => {
    const node = await fakeNode({ sessions: [], status: 503 });
    open.push(node.close);
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      await store.createJob({ id: "job-live", ownerId: "u1", source: "browser" });
      await store.patchJob("job-live", { status: "active" });
      await db.setMediaSession(session("job-live"));
      const { stops, stopper } = countingStopper();
      const rec = await sweepDetachedMediaSessions({
        db,
        getJob: (id) => store.getJob(id),
        mediaServerUrl: node.url,
        mediaHealthToken: TOKEN,
        stopper,
      });
      expect(rec.node).toBe("unverified");
      expect(stops).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("a row owned by another media node is not judged by this node's list", async () => {
    const node = await fakeNode({ sessions: [] });
    open.push(node.close);
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      await store.createJob({ id: "job-other", ownerId: "u1", source: "browser" });
      await store.patchJob("job-other", { status: "active" });
      await db.setMediaSession(session("job-other", { nodeId: "media-1" }));
      const { stops, stopper } = countingStopper();
      const rec = await sweepDetachedMediaSessions({
        db,
        getJob: (id) => store.getJob(id),
        mediaServerUrl: node.url,
        mediaHealthToken: TOKEN,
        stopper,
      });
      expect(rec.otherNode).toBe(1);
      expect(rec.released).toBe(0);
      expect(stops).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("retries an unreachable probe before acting (one dropped packet is not a dead node)", async () => {
    let calls = 0;
    const probe = async (): Promise<
      { kind: "served"; nodeId: string; sessionIds: string[] } | { kind: "unreachable"; error: string }
    > => {
      calls++;
      return calls === 1
        ? { kind: "unreachable", error: "ECONNRESET" }
        : { kind: "served", nodeId: "media-0", sessionIds: ["sess-job-live"] };
    };
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      await store.createJob({ id: "job-live", ownerId: "u1", source: "browser" });
      await store.patchJob("job-live", { status: "active" });
      await db.setMediaSession(session("job-live"));
      const { stops, stopper } = countingStopper();
      const rec = await sweepDetachedMediaSessions({
        db,
        getJob: (id) => store.getJob(id),
        mediaServerUrl: "http://media.test",
        mediaHealthToken: TOKEN,
        stopper,
        probeAttempts: 2,
        probeRetryDelayMs: 0,
        probe: probe as any,
      });
      expect(calls).toBe(2);
      expect(rec.released).toBe(0);
      expect(stops).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("bounds the rows it inspects", async () => {
    const rows = ["a", "b", "c"].map((id) => session(id));
    const closed: string[] = [];
    const { stops, stopper } = countingStopper();
    const rec = await sweepDetachedMediaSessions({
      db: {
        listMediaSessions: async () => rows,
        closeMediaSession: async (jobId: string) => {
          closed.push(jobId);
          return true;
        },
      },
      getJob: () => ({ status: "active" }),
      mediaServerUrl: DEAD_NODE_URL,
      mediaHealthToken: TOKEN,
      stopper,
      maxRows: 2,
      probeAttempts: 1,
    });
    expect(rec.candidates).toBe(2);
    expect(rec.released).toBe(2);
    expect(stops).toHaveLength(2);
    expect(closed).toHaveLength(2);
  });
});

describe("probeMediaNode reads the node's detail surface", () => {
  it("returns the served session ids on 200", async () => {
    const node = await fakeNode({ sessions: ["s1", "s2"] });
    open.push(node.close);
    const probe = await probeMediaNode({ mediaServerUrl: node.url, mediaHealthToken: TOKEN });
    expect(probe.kind).toBe("served");
    if (probe.kind === "served") {
      expect(probe.nodeId).toBe("media-0");
      expect(probe.sessionIds.sort()).toEqual(["s1", "s2"]);
    }
  });

  it("reads a transport failure as unreachable and an HTTP error as unverified", async () => {
    const dead = await probeMediaNode({ mediaServerUrl: DEAD_NODE_URL, mediaHealthToken: TOKEN });
    expect(dead.kind).toBe("unreachable");

    const bad = await fakeNode({ sessions: [], body: { status: "ok" } });
    open.push(bad.close);
    const noList = await probeMediaNode({ mediaServerUrl: bad.url, mediaHealthToken: TOKEN });
    expect(noList.kind).toBe("unverified");
  });
});

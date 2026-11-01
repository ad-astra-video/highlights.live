// ADAAAA-7700 — the server half of "media-node restart must be surfaced, not silent".
//
// When the media node reports `reason: "media-node-restart"` on the 7689
// session-closed callback (its boot reconcile reports every session the previous
// boot took down), the browser job must:
//   1. land `failed` (not `done`, not a stale `active`),
//   2. carry `failureReason: "media-session-lost"` + an actionable `error`,
//   3. append a durable activity row readable at GET /jobs/:id/lifecycle,
//   4. refuse a later `POST /jobs/:id/media` with 409 — a dead session must never
//      be re-provisioned into a SECOND paid session for the same share.
import { createServer, type Server } from "node:http";
import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers";

async function register(app: any, email: string, pw: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

/** Media-node stand-in that counts provisions (to prove no double session). */
async function mediaStub(): Promise<{ url: string; provisions: () => number; close: () => Promise<void> }> {
  let provisions = 0;
  const srv: Server = createServer((req, res) => {
    const url = (req.url || "").split("?")[0];
    if (url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    if (url === "/sessions" && req.method === "POST") {
      provisions += 1;
      const sid = `sess-${provisions}`;
      req.on("data", () => undefined);
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: sid, wsPath: `/stream/${sid}`, streamId: `st-${provisions}`, nodeId: "media-0" }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(srv.address() as any).port}`,
    provisions: () => provisions,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

async function browserJob(app: any, token: string): Promise<string> {
  const jr = await app.inject({
    method: "POST",
    url: "/jobs",
    headers: { authorization: `Bearer ${token}` },
    payload: { source: "browser", gameHint: "esports" },
  });
  expect([200, 202]).toContain(jr.statusCode);
  return jr.json().job.id as string;
}

describe("media-node restart mid-share is attributable (ADAAAA-7700)", () => {
  it("fails the job with media-session-lost, logs the transition and blocks a re-provision", async () => {
    const media = await mediaStub();
    const { app } = await buildTestApp({ MEDIA_SERVER_URL: media.url });
    const token = await register(app, "lost1@test.dev", "password123");
    const jobId = await browserJob(app, token);

    const m = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(m.statusCode).toBe(200);
    expect(media.provisions()).toBe(1);

    // The media node restarted and its boot reconcile reports the dead session.
    const closed = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media/session-closed`,
      payload: { sessionId: m.json().mediaSessionId, reason: "media-node-restart", neverAttached: false, nodeId: "media-0" },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().job.status).toBe("failed");
    expect(closed.json().job.failureReason).toBe("media-session-lost");
    expect(String(closed.json().job.error)).toMatch(/media node restarted/i);
    expect(String(closed.json().job.error)).toMatch(/click start to share again/i);

    // The record is the user-visible surface: GET /jobs/:id carries the attribution.
    const got = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    expect(got.json().job.status).toBe("failed");
    expect(got.json().job.failureReason).toBe("media-session-lost");

    // The transition is activity-logged durably (append-only, readable).
    const life = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}/lifecycle`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(life.statusCode).toBe(200);
    const events = life.json().events as any[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === "failed" && /media-session-lost/.test(e.detail))).toBe(true);
    expect(events.some((e) => /media-node-restart/.test(e.detail))).toBe(true);

    // A browser reconnect must NOT mint a second paid session for this share.
    const again = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().failureReason).toBe("media-session-lost");
    expect(media.provisions()).toBe(1);

    await app.close();
    await media.close();
  });

  it("keeps a clean client close as `done` with no failure reason", async () => {
    const media = await mediaStub();
    const { app } = await buildTestApp({ MEDIA_SERVER_URL: media.url });
    const token = await register(app, "lost2@test.dev", "password123");
    const jobId = await browserJob(app, token);
    const m = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    const closed = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media/session-closed`,
      payload: { sessionId: m.json().mediaSessionId, reason: "client-closed" },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().job.status).toBe("done");
    expect(closed.json().job.failureReason).toBeUndefined();

    await app.close();
    await media.close();
  });
});

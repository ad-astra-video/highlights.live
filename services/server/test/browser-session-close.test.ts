// ADAAAA-7689 AC3: a browser job must leave `active` when its media/RTC session
// closes, without anyone calling `POST /jobs/:id/stop`.
//
// The media node reports the close (best-effort, fire-and-forget) to
// `POST /jobs/:id/media/session-closed`. This route has to be safe to repeat, to
// ignore a close that belongs to an older session, and to leave the job alone
// when it is not a browser capture. `POST /jobs/:id/stop` must stay idempotent
// afterwards so the webapp's own stop (which runs milliseconds later) is
// harmless instead of a 409.
import { createServer, type Server } from "node:http";
import { describe, it, expect } from "vitest";
import { buildTestApp, fakePipeline } from "./helpers";

async function register(app: any, email: string, pw: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

/** Stand-in media node: provisions a session for POST /sessions, closes on /close. */
async function mediaStub(): Promise<{ url: string; sessionId: () => string; close: () => Promise<void> }> {
  let n = 0;
  const srv: Server = createServer((req, res) => {
    const url = (req.url || "").split("?")[0];
    if (url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    if (url === "/sessions" && req.method === "POST") {
      n += 1;
      const sid = `sess-${n}`;
      req.on("data", () => undefined);
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: sid, wsPath: `/stream/${sid}`, streamId: `st-${n}` }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(srv.address() as any).port}`,
    sessionId: () => `sess-${n}`,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

async function browserJob(app: any, token: string): Promise<string> {
  const jr = await app.inject({
    method: "POST",
    url: "/jobs",
    headers: { authorization: `Bearer ${token}` },
    payload: { source: "browser", gameHint: "soccer" },
  });
  expect([200, 202]).toContain(jr.statusCode);
  return jr.json().job.id as string;
}

async function jobStatus(app: any, token: string, jobId: string): Promise<string> {
  const r = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
  return r.json().job.status as string;
}

describe("browser job lifecycle on media session close (ADAAAA-7689 AC3)", () => {
  it("takes the job out of `active` when its media session closes", async () => {
    const media = await mediaStub();
    const { app } = await buildTestApp({ MEDIA_SERVER_URL: media.url });
    const token = await register(app, "life1@test.dev", "password123");
    const jobId = await browserJob(app, token);

    const m = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(m.statusCode).toBe(200);
    expect(await jobStatus(app, token, jobId)).toBe("active");

    // The browser's RTC session ends and the media node reports it.
    const closed = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media/session-closed`,
      payload: { sessionId: m.json().mediaSessionId, reason: "client-closed", neverAttached: false },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().reason).toBe("client-closed");
    expect(await jobStatus(app, token, jobId)).toBe("done");

    // GET /jobs reports no `active` job — the AC is measured from the edge.
    const list = await app.inject({ method: "GET", url: "/jobs", headers: { authorization: `Bearer ${token}` } });
    const active = (list.json().jobs ?? []).filter((j: any) => j.status === "active");
    expect(active).toHaveLength(0);

    await app.close();
    await media.close();
  });

  it("is idempotent: a repeat close and a late /stop both answer 200", async () => {
    const media = await mediaStub();
    const { app } = await buildTestApp({ MEDIA_SERVER_URL: media.url });
    const token = await register(app, "life2@test.dev", "password123");
    const jobId = await browserJob(app, token);
    const m = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    const body = { sessionId: m.json().mediaSessionId, reason: "client-closed" };

    const first = await app.inject({ method: "POST", url: `/jobs/${jobId}/media/session-closed`, payload: body });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: `/jobs/${jobId}/media/session-closed`, payload: body });
    expect(again.statusCode).toBe(200);
    expect(again.json().ignored).toBe("job already finalized");

    // The webapp closes the peer then posts /stop: it must not 409 now that the
    // job is already done.
    const stop = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/stop`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().alreadyTerminal).toBe(true);
    expect(await jobStatus(app, token, jobId)).toBe("done");

    await app.close();
    await media.close();
  });

  it("ignores a close that belongs to an older media session", async () => {
    const media = await mediaStub();
    const { app } = await buildTestApp({ MEDIA_SERVER_URL: media.url });
    const token = await register(app, "life3@test.dev", "password123");
    const jobId = await browserJob(app, token);
    const m = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(m.statusCode).toBe(200);
    const stale = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media/session-closed`,
      payload: { sessionId: "sess-from-a-previous-run", reason: "client-closed" },
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().ignored).toBe("stale session");
    // ...and with the node's live count, a close is ignored while another session
    // for the job is still live.
    const stillLive = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media/session-closed`,
      payload: { sessionId: m.json().mediaSessionId, reason: "client-closed", liveSessionsForJob: 1 },
    });
    expect(stillLive.json().ignored).toBe("another media session is still live for this job");
    // The live stream is untouched.
    expect(await jobStatus(app, token, jobId)).toBe("active");

    await app.close();
    await media.close();
  });

  it("finalizes when the closing session is one the control plane never tracked", async () => {
    // The harness provisioned its own session (instead of adopting the control
    // plane's) and the control plane's provision already idled out: the close of
    // that untracked session is the LAST one for the job, so the job must not be
    // left `active` (ADAAAA-7689 F2/AC3).
    const media = await mediaStub();
    const { app } = await buildTestApp({ MEDIA_SERVER_URL: media.url });
    const token = await register(app, "life6@test.dev", "password123");
    const jobId = await browserJob(app, token);
    await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    const r = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media/session-closed`,
      payload: { sessionId: "sess-harness-own", reason: "client-closed", liveSessionsForJob: 0 },
    });
    expect(r.statusCode).toBe(200);
    expect(await jobStatus(app, token, jobId)).toBe("done");
    await app.close();
    await media.close();
  });

  it("ignores a non-browser job and an unknown job instead of failing", async () => {
    const { app } = await buildTestApp({}, { adapter: fakePipeline() });
    const token = await register(app, "life4@test.dev", "password123");
    const unknown = await app.inject({
      method: "POST",
      url: "/jobs/does-not-exist/media/session-closed",
      payload: { sessionId: "s" },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().ignored).toBe("not a browser capture job");

    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "file", videoPath: "/data/nope.mp4" },
    });
    if (jr.statusCode === 200 || jr.statusCode === 202) {
      const r = await app.inject({
        method: "POST",
        url: `/jobs/${jr.json().job.id}/media/session-closed`,
        payload: { sessionId: "s" },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().ignored).toBe("not a browser capture job");
    }
    await app.close();
  });

  it("requires the shared media token when one is configured", async () => {
    const media = await mediaStub();
    const { app } = await buildTestApp({ MEDIA_SERVER_URL: media.url, MEDIA_HEALTH_TOKEN: "tok-shared" });
    const token = await register(app, "life5@test.dev", "password123");
    const jobId = await browserJob(app, token);
    await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    const anon = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media/session-closed`,
      payload: { reason: "client-closed" },
    });
    expect(anon.statusCode).toBe(401);
    expect(await jobStatus(app, token, jobId)).toBe("active");

    const authed = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media/session-closed`,
      headers: { authorization: "Bearer tok-shared" },
      payload: { reason: "client-closed" },
    });
    expect(authed.statusCode).toBe(200);
    expect(await jobStatus(app, token, jobId)).toBe("done");

    await app.close();
    await media.close();
  });
});

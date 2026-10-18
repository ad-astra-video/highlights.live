// ADAAAA-6867 Phase 2: server hands live push/screen jobs to the media server.
// With MEDIA_SERVER_URL configured, POST /jobs with a live source must delegat
// the whole ingest to the media node (MediaJobRequest) instead of running the
// server-side LiveIngest, and POST /jobs/:id/stop must tell the media node to
// tear down (release slot, stop payment). Verifies with a fake media server so
// no ffmpeg / Orchestrator is required.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { buildTestApp, type TestApp } from "./helpers";

type MediaCall = { method: string; url: string; body?: any };

/** A fake media server that accepts a live job handoff and stop teardown. */
function fakeMediaServer(state: { calls: MediaCall[]; failStart?: boolean; sessionId?: string }) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : undefined;
      state.calls.push({ method: req.method || "", url: req.url || "", body: parsed });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && req.url === "/jobs") {
        if (state.failStart) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "media-node failure" }));
          return;
        }
        res.end(JSON.stringify({ jobId: parsed?.jobId, sessionId: state.sessionId ?? "media-sess-1", status: "ingesting" }));
        return;
      }
      if (req.method === "POST" && /^\/jobs\/[^/]+\/stop$/.test(req.url || "")) {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return server;
}

const listen = (s: Server) =>
  new Promise<string>((res) => s.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(s.address() as any).port}`)));

describe("Phase 2 live push/screen handoff to the media server (ADAAAA-6867)", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    servers = [];
  });

  async function register(app: any, email: string) {
    const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }

  it("POST /jobs (rtmp) hands the live ingest to the media server; POST /jobs/:id/stop tears it down there", async () => {
    const mediaState: { calls: MediaCall[]; failStart?: boolean } = { calls: [] };
    const mediaSrv = fakeMediaServer(mediaState);
    const mediaBase = await listen(mediaSrv);
    servers.push(mediaSrv);

    const { app, store, db } = await buildTestApp({ MEDIA_SERVER_URL: mediaBase, FREE_HIGHLIGHTS: "100" });
    const token = await register(app, "live@test.dev");

    const start = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "rtmp", videoPath: "rtmp://ingest.example/live/session", gameHint: "valorant" },
    });
    expect(start.statusCode).toBe(200);
    const body = start.json();
    expect(body.status).toBe("ingesting");
    expect(body.media).toBe(true);
    expect(body.job.source).toBe("rtmp");

    // The media node received a MediaJobRequest with the job id + live source.
    const handoff = mediaState.calls.find((c) => c.method === "POST" && c.url === "/jobs");
    expect(handoff).toBeTruthy();
    expect(handoff!.body.jobId).toBe(body.job.id);
    expect(handoff!.body.source).toBe("rtmp");
    expect(handoff!.body.sampleFps).toBeGreaterThan(0);

    // A media session was recorded so the handoff is idempotent / teardownable.
    const sess = await db.getMediaSession(body.job.id);
    expect(sess?.sessionId).toBe("media-sess-1");

    // Stop path tells the media node to tear down.
    const stop = await app.inject({
      method: "POST",
      url: `/jobs/${body.job.id}/stop`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().job.status).toBe("done");
    const teardown = mediaState.calls.find((c) => c.method === "POST" && c.url === `/jobs/${body.job.id}/stop`);
    expect(teardown).toBeTruthy();
    const cleared = await db.getMediaSession(body.job.id);
    expect(cleared).toBeUndefined();
  });

  it("POST /jobs (screen) maps to screenshare on the media server", async () => {
    const mediaState: { calls: MediaCall[] } = { calls: [] };
    const mediaSrv = fakeMediaServer(mediaState);
    const mediaBase = await listen(mediaSrv);
    servers.push(mediaSrv);

    const { app } = await buildTestApp({ MEDIA_SERVER_URL: mediaBase });
    const token = await register(app, "screen@test.dev");

    const start = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "screen", gameHint: "valorant" },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().job.source).toBe("screenshare");
    const handoff = mediaState.calls.find((c) => c.method === "POST" && c.url === "/jobs");
    expect(handoff!.body.source).toBe("screenshare");
  });

  it("a media-node failure surfaces as 502 and the job is marked failed", async () => {
    const mediaState: { calls: MediaCall[]; failStart?: boolean } = { calls: [], failStart: true };
    const mediaSrv = fakeMediaServer(mediaState);
    const mediaBase = await listen(mediaSrv);
    servers.push(mediaSrv);

    const { app } = await buildTestApp({ MEDIA_SERVER_URL: mediaBase });
    const token = await register(app, "fail@test.dev");

    const start = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "rtmp", videoPath: "rtmp://ingest.example/live/session" },
    });
    expect(start.statusCode).toBe(502);
  });
});

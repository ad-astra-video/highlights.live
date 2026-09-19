import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";

const tmp = mkdtempSync(path.join(tmpdir(), "hl-test-"));
const videoPath = path.join(tmp, "test.mp4");

beforeAll(() => {
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=1",
    "-pix_fmt", "yuv420p", videoPath,
  ]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function register(app: any, email: string, pw: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

describe("API end-to-end (auth + billing gated, real ffmpeg, fake runners)", () => {
  it("register -> login -> run auth'd job -> review as admin", async () => {
    const { app, cfg } = await buildTestApp();
    const userToken = await register(app, "a@test.dev", "password123");
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "a@test.dev", password: "password123" } });
    expect(login.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.framesAnalyzed).toBeGreaterThan(0);
    expect(body.job.status).toBe("done");
    expect(body.job.ownerId).toBeTruthy();

    // user sees their highlights
    const hl = await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${userToken}` } });
    const myhl = hl.json().highlights;
    expect(myhl.length).toBe(1);
    expect(myhl[0].score).toBe(86);

    const clipFile = path.join(cfg.dataDir, "clips", path.basename(myhl[0].clipUri));
    expect(existsSync(clipFile)).toBe(true);

    // another user cannot see it
    const otherToken = await register(app, "b@test.dev", "password456");
    const other = await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${otherToken}` } });
    expect(other.json().highlights.length).toBe(0);

    // review is admin-only
    const userReview = await app.inject({
      method: "POST",
      url: `/highlights/${myhl[0].id}/review`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { status: "accepted" },
    });
    expect(userReview.statusCode).toBe(403);

    const admin = await app.inject({ method: "POST", url: "/auth/login", payload: { email: cfg.adminEmail, password: cfg.adminPassword } });
    expect(admin.statusCode).toBe(200);
    const admintok = admin.json().token;
    const rev = await app.inject({
      method: "POST",
      url: `/highlights/${myhl[0].id}/review`,
      headers: { authorization: `Bearer ${admintok}` },
      payload: { status: "accepted" },
    });
    expect(rev.statusCode).toBe(200);
    expect(rev.json().status).toBe("accepted");

    // unauthenticated job -> 401
    const anon = await app.inject({ method: "POST", url: "/jobs", payload: { videoPath } });
    expect(anon.statusCode).toBe(401);

    await app.close();
  });

  it("public /feed returns only accepted highlights, newest first, no auth", async () => {
    const { app, store } = await buildTestApp();
    const mkHl = (id: string, status: string, creator: string) =>
      store.addHighlight({
        id,
        ownerId: "u1",
        jobId: "j1",
        clipUri: `/clips/${id}.mp4`,
        start: 1,
        end: 5,
        eventType: "KILL",
        score: 90,
        reason: creator,
        status: status as any,
        createdAt: creator,
      });
    mkHl("hl-new", "pending", "2026-09-09T00:00:03Z");
    mkHl("hl-old", "accepted", "2026-09-09T00:00:01Z");
    mkHl("hl-pass", "accepted", "2026-09-09T00:00:02Z");
    mkHl("hl-rej", "rejected", "2026-09-09T00:00:04Z");

    // no auth header — public
    const res = await app.inject({ method: "GET", url: "/feed" });
    expect(res.statusCode).toBe(200);
    const hl = res.json().highlights;
    expect(hl.map((h: any) => h.id)).toEqual(["hl-pass", "hl-old"]); // accepted only
    await app.close();
  });

  it("closed-beta auto-publish: a generated clip shows in /feed with no admin review (default ON)", async () => {
    const { app } = await buildTestApp(); // AUTO_PUBLISH_HIGHLIGHTS unset -> default true
    const userToken = await register(app, "ap@test.dev", "password123");
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.status).toBe("done");

    // No admin review performed — the clip is already published.
    const feed = await app.inject({ method: "GET", url: "/feed" });
    expect(feed.statusCode).toBe(200);
    const hl = feed.json().highlights;
    expect(hl.length).toBe(1);
    expect(hl[0].status).toBe("accepted");
    expect(hl[0].ownerId).toBeTruthy();
    await app.close();
  });

  it("AUTO_PUBLISH_HIGHLIGHTS=0 keeps generated clips pending (not in /feed until admin review)", async () => {
    const { app } = await buildTestApp({ AUTO_PUBLISH_HIGHLIGHTS: "0" });
    const userToken = await register(app, "ap0@test.dev", "password123");
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.status).toBe("done");

    const feed = await app.inject({ method: "GET", url: "/feed" });
    expect(feed.json().highlights.length).toBe(0); // not published without review

    const mine = await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${userToken}` } });
    expect(mine.json().highlights[0].status).toBe("pending");
    await app.close();
  });

  it("acks operator control intents on a job and 401s without auth", async () => {
    const { app } = await buildTestApp();
    const token = await register(app, "ctl@test.dev", "password123");
    const job = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath },
    });
    const jobId = job.json().job.id;

    const ctl = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/control`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "preferLabels", args: { labels: ["headshot", "clutch"] } },
    });
    expect(ctl.statusCode).toBe(200);
    expect(ctl.json().ok).toBe(true);
    expect(ctl.json().control.type).toBe("preferLabels");
    expect(ctl.json().control.args.labels).toEqual(["headshot", "clutch"]);

    // unauthenticated control -> 401
    const anon = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/control`,
      payload: { type: "lock", args: { trackId: "a" } },
    });
    expect(anon.statusCode).toBe(401);
    await app.close();
  });

  it("exposes observations + frames for the frame debugger after a VOD job", async () => {
    const { app } = await buildTestApp();
    const token = await register(app, "dbg@test.dev", "password123");
    const job = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath },
    });
    const jobId = job.json().job.id;

    const obs = await app.inject({ method: "GET", url: `/jobs/${jobId}/observations`, headers: { authorization: `Bearer ${token}` } });
    expect(obs.statusCode).toBe(200);
    const observations = obs.json().observations;
    expect(observations.length).toBeGreaterThan(1);
    expect(observations[0]).toHaveProperty("seq");
    expect(observations[0]).toHaveProperty("tracks");

    const frames = await app.inject({ method: "GET", url: `/jobs/${jobId}/frames`, headers: { authorization: `Bearer ${token}` } });
    expect(frames.statusCode).toBe(200);
    const frameList = frames.json().frames;
    expect(frameList.length).toBeGreaterThan(0);
    expect(frameList[0].seq).toBe(0);
    expect(frameList[0].uri).toContain("/frames/0");

    // first frame image actually serves
    const img = await app.inject({ method: "GET", url: `/jobs/${jobId}/frames/0`, headers: { authorization: `Bearer ${token}` } });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toContain("image/jpeg");
    expect(img.rawPayload.length).toBeGreaterThan(100);

    // out of range frame -> 404
    const missing = await app.inject({ method: "GET", url: `/jobs/${jobId}/frames/99999`, headers: { authorization: `Bearer ${token}` } });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("browser capture: ingest frames -> highlight, recording -> stop cuts the clip", async () => {
    const { app, cfg } = await buildTestApp();
    const token = await register(app, "bz@test.dev", "password123");

    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser", gameHint: "Esports" },
    });
    expect(jr.statusCode).toBe(200);
    expect(jr.json().status).toBe("ready");
    const jobId = jr.json().job.id;
    expect(jr.json().job.status).toBe("active");

    // first ingest triggers a candidate + highlight (fake pipeline)
    const ing = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/ingest`,
      headers: { authorization: `Bearer ${token}` },
      payload: { seq: 0, timestamp: 0, image: "aGVsbG8=" },
    });
    expect(ing.statusCode).toBe(200);
    const hl = ing.json().highlight;
    expect(hl).toBeTruthy();
    expect(hl.id).toBeTruthy();
    expect(hl.clipUri).toBe(""); // clip cut deferred until stop

    // upload a recording (the test mp4) so clips can be cut at stop
    const { readFileSync } = await import("node:fs");
    const recordingB64 = readFileSync(videoPath).toString("base64");
    const rec = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/recording`,
      headers: { authorization: `Bearer ${token}` },
      payload: { base64: recordingB64, mime: "video/mp4" },
    });
    expect(rec.statusCode).toBe(200);

    // stop -> finalize: cut clip from recording
    const st = await app.inject({ method: "POST", url: `/jobs/${jobId}/stop`, headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(st.statusCode).toBe(200);
    expect(st.json().job.status).toBe("done");

    const hlList = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } })).json().highlights;
    expect(hlList.length).toBe(1);
    expect(hlList[0].clipUri).toMatch(/^\/clips\//);
    const clipFile = path.join(cfg.dataDir, "clips", path.basename(hlList[0].clipUri));
    expect(existsSync(clipFile)).toBe(true);
    await app.close();
  });

  it("rejects a user's job when the free allowance is exhausted (402)", async () => {
    const { app, db } = await buildTestApp({ FREE_HIGHLIGHTS: "2" });
    const token = await register(app, "c@test.dev", "password123");
    const cid = (await db.getUserByEmail("c@test.dev"))!.id;
    await db.recordUsage(cid, "highlight");
    await db.recordUsage(cid, "highlight");
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().upgrade).toBe("/billing/checkout");
    await app.close();
  });
});

describe("media session reroute (DB-tracked)", () => {
  it("provisions once, reuses while the node is healthy, re-provisions + reroutes when media goes down", async () => {
    // Tiny fake media server: /health (toggleable), /sessions, /sessions/:sid/close.
    let down = false;
    let provisions = 0;
    const srv = createServer((req, res) => {
      const url = (req.url || "").split("?")[0];
      if (url === "/health") {
        res.writeHead(down ? 500 : 200, { "content-type": "application/json" });
        res.end(down ? "{}" : '{"status":"ok"}');
        return;
      }
      if (url === "/sessions" && req.method === "POST") {
        provisions += 1;
        const n = provisions;
        req.on("data", () => undefined);
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              sessionId: `sess-${n}`,
              wsPath: `/stream/sess-${n}`,
              wsUrl: `ws://127.0.0.1:${(srv.address() as any).port}/stream/sess-${n}`,
              streamId: `st-${n}`,
            })
          );
        });
        return;
      }
      if (req.method === "POST" && url.endsWith("/close")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"nf"}');
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;

    const { app, db } = await buildTestApp({ MEDIA_SERVER_URL: `http://127.0.0.1:${port}` });
    const token = await register(app, "m@test.dev", "password123");
    const jr = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload: { source: "browser", gameHint: "x" } });
    const jobId = jr.json().job.id;

    const m1 = await app.inject({ method: "POST", url: `/jobs/${jobId}/media`, headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(m1.statusCode).toBe(200);
    expect(m1.json().wsUrl).toContain("/stream/sess-1");
    expect(provisions).toBe(1);

    // healthy + already provisioned -> idempotent reuse, no second session
    const m2 = await app.inject({ method: "POST", url: `/jobs/${jobId}/media`, headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(m2.statusCode).toBe(200);
    expect(m2.json().wsUrl).toBe(m1.json().wsUrl);
    expect(provisions).toBe(1);
    const rec = await db.getMediaSession(jobId);
    expect(rec?.sessionId).toBe("sess-1");
    expect(rec?.status).toBe("active");

    // media node goes DOWN -> next /media transparently re-provisions + reroutes
    down = true;
    const m3 = await app.inject({ method: "POST", url: `/jobs/${jobId}/media`, headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(m3.statusCode).toBe(200);
    expect(m3.json().wsUrl).toContain("/stream/sess-2");
    expect(m3.json().wsUrl).not.toBe(m1.json().wsUrl);
    expect(provisions).toBe(2);
    expect((await db.getMediaSession(jobId))!.sessionId).toBe("sess-2");

    await app.close();
    await new Promise<void>((r) => srv.close(() => r()));
  });
});

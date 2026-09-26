import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";

const tmp = mkdtempSync(path.join(tmpdir(), "hl-test-"));
const videoPath = path.join(tmp, "test.mp4");
// A valid video genuinely larger than the historical 1 MiB truncation point, so
// the 413/truncation regression test exercises busboy's fileSize default.
const bigVideoPath = path.join(tmp, "big-test.mp4");

beforeAll(() => {
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=1",
    "-pix_fmt", "yuv420p", videoPath,
  ]);
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc2=duration=2:size=1280x720:rate=30",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "0", "-pix_fmt", "yuv420p", bigVideoPath,
  ]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function register(app: any, email: string, pw: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

describe("API end-to-end (auth + billing gated, real ffmpeg, fake runners)", () => {
  it("register -> login -> run auth'd job -> review own highlight as user", async () => {
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

    // the OWNER can review their own highlight (accept + reject), not admin-only
    const userAccept = await app.inject({
      method: "POST",
      url: `/highlights/${myhl[0].id}/review`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { status: "accepted" },
    });
    expect(userAccept.statusCode).toBe(200);
    expect(userAccept.json().status).toBe("accepted");

    const userReject = await app.inject({
      method: "POST",
      url: `/highlights/${myhl[0].id}/review`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { status: "rejected" },
    });
    expect(userReject.statusCode).toBe(200);
    expect(userReject.json().status).toBe("rejected");

    // a user cannot review another user's highlight
    const otherReview = await app.inject({
      method: "POST",
      url: `/highlights/${myhl[0].id}/review`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { status: "accepted" },
    });
    expect(otherReview.statusCode).toBe(403);

    // admin can still review any highlight
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

  it("reject releases the clip-count slot; only accepted clips consume the limit (idempotent)", async () => {
    const { app } = await buildTestApp({ BETA_CLIP_QUOTA: "10" });
    const userToken = await register(app, "quota-rej@test.dev", "password123");

    // A generated highlight debits the quota once.
    const gen = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(gen.statusCode).toBe(200);
    const myhl = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${userToken}` } })).json().highlights;
    expect(myhl.length).toBe(1);

    const status = async () => (await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${userToken}` } })).json();
    expect((await status()).clipQuotaUsed).toBe(1);

    // Reject -> the clip no longer counts toward the quota.
    const rej = await app.inject({
      method: "POST",
      url: `/highlights/${myhl[0].id}/review`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { status: "rejected" },
    });
    expect(rej.statusCode).toBe(200);
    expect(rej.json().status).toBe("rejected");
    expect((await status()).clipQuotaUsed).toBe(0);
    expect((await status()).clipQuotaRemaining).toBe(10);

    // Idempotent: re-rejecting the already-rejected clip must not double-release (stays 0).
    const rej2 = await app.inject({
      method: "POST",
      url: `/highlights/${myhl[0].id}/review`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { status: "rejected" },
    });
    expect(rej2.statusCode).toBe(200);
    expect((await status()).clipQuotaUsed).toBe(0);

    // Re-accepting a rejected clip re-consumes the released slot (consistency).
    const acc = await app.inject({
      method: "POST",
      url: `/highlights/${myhl[0].id}/review`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { status: "accepted" },
    });
    expect(acc.statusCode).toBe(200);
    expect((await status()).clipQuotaUsed).toBe(1);

    // A rejected clip is removed from the public feed; an accepted one is present.
    const feed = await app.inject({ method: "GET", url: "/feed" });
    expect(feed.json().highlights.some((h: any) => h.id === myhl[0].id)).toBe(true); // accepted

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

describe("VOD browser upload (multipart POST /jobs/upload)", () => {
  async function multipart(opts: {
    fields?: Record<string, string>;
    file?: Buffer | string;
    filename?: string;
    mime?: string;
  }) {
    const boundary = "----hlBoundary" + Math.random().toString(36).slice(2);
    const chunks: Buffer[] = [];
    for (const [k, v] of Object.entries(opts.fields ?? {})) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, "utf8"));
    }
    if (opts.file !== undefined) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${opts.filename ?? "clip.mp4"}"\r\nContent-Type: ${opts.mime ?? "video/mp4"}\r\n\r\n`,
          "utf8"
        )
      );
      chunks.push(Buffer.isBuffer(opts.file) ? opts.file : Buffer.from(opts.file, "utf8"));
      chunks.push(Buffer.from("\r\n", "utf8"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
    return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  it("valid small upload -> job created + standard VOD pipeline runs", async () => {
    const { app, cfg } = await buildTestApp();
    const token = await register(app, "up@test.dev", "password123");
    const { payload, contentType } = await multipart({
      fields: { gameHint: "valorant" },
      file: readFileSync(videoPath),
      filename: "my clip.mp4",
      mime: "video/mp4",
    });
    const res = await app.inject({
      method: "POST",
      url: "/jobs/upload",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.framesAnalyzed).toBeGreaterThan(0);
    expect(body.job.status).toBe("done");
    expect(body.job.source).toBe("file");
    // File landed at dataDir/uploads/<jobId>/<safe-filename> (spaces kept, no path traversal).
    expect(existsSync(path.join(cfg.dataDir, "uploads", body.job.id, "my clip.mp4"))).toBe(true);
    // Generated a highlight through the same pipeline as a local path source.
    const hl = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } })).json().highlights;
    expect(hl.length).toBe(1);
    expect(hl[0].score).toBe(86);
    await app.close();
  });

  it("over-limit upload returns 413 before any job/compute is queued", async () => {
    // Smaller cap so the ">2GB" path is testable without a 2GB fixture.
    const { app, cfg } = await buildTestApp({ VOD_MAX_UPLOAD_BYTES: "2048" });
    const token = await register(app, "big@test.dev", "password123");
    const { payload, contentType } = await multipart({
      file: Buffer.alloc(3000, 0x61), // 3 KB > 2 KB cap, declared video/mp4
      filename: "big.mp4",
      mime: "video/mp4",
    });
    const res = await app.inject({
      method: "POST",
      url: "/jobs/upload",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      payload,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toContain("File too large");
    // No job was created, no upload dir persisted, no compute (no highlights).
    expect(existsSync(path.join(cfg.dataDir, "uploads"))).toBe(false);
    const hl = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } })).json().highlights;
    expect(hl.length).toBe(0);
    await app.close();
  });

  it("accepts a >1 MiB upload intact — regression for the 1 MiB default fileSize truncation", async () => {
    // @fastify/multipart defaults busboy's `fileSize` to fastify's bodyLimit
    // (1 MiB = 1,048,576), so an unset limit silently truncates every upload to
    // exactly 1,048,576 bytes and the 2 GB counter can never trip. Verify a
    // real >1 MiB video passes through byte-for-byte (stored size == sent size).
    const sent = readFileSync(bigVideoPath);
    expect(sent.length).toBeGreaterThan(1024 * 1024); // precondition: fixture is > the old truncation point
    const { app, cfg } = await buildTestApp(); // default cap = 2 GiB
    const token = await register(app, "multi@test.dev", "password123");
    const { payload, contentType } = await multipart({
      file: sent,
      filename: "big clip.mp4",
      mime: "video/mp4",
    });
    const res = await app.inject({
      method: "POST",
      url: "/jobs/upload",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.framesAnalyzed).toBeGreaterThan(0);
    const stored = path.join(cfg.dataDir, "uploads", body.job.id, "big clip.mp4");
    expect(statSync(stored).size).toBe(sent.length); // NOT truncated to 1,048,576
    await app.close();
  });

  it("rejects a non-video upload with a readable message (415)", async () => {
    const { app, cfg } = await buildTestApp();
    const token = await register(app, "nv@test.dev", "password123");
    const { payload, contentType } = await multipart({
      file: "not a video at all",
      filename: "notes.txt",
      mime: "text/plain",
    });
    const res = await app.inject({
      method: "POST",
      url: "/jobs/upload",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      payload,
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toContain("Unsupported file type");
    expect(existsSync(path.join(cfg.dataDir, "uploads"))).toBe(false);
    await app.close();
  });

  it("requires auth (401) and sanitizes path-traversal filenames", async () => {
    const { app, cfg } = await buildTestApp();
    const token = await register(app, "tra@test.dev", "password123");
    // Unauthenticated -> 401, no compute.
    const { payload: anonPayload, contentType: anonCt } = await multipart({
      file: readFileSync(videoPath),
      filename: "x.mp4",
      mime: "video/mp4",
    });
    const anon = await app.inject({ method: "POST", url: "/jobs/upload", headers: { "content-type": anonCt }, payload: anonPayload });
    expect(anon.statusCode).toBe(401);

    // A hostile filename must be stripped to its safe basename, never escape uploads/.
    const { payload, contentType } = await multipart({
      fields: { gameHint: "Esports" },
      file: readFileSync(videoPath),
      filename: "../../evil.mp4",
      mime: "video/mp4",
    });
    const res = await app.inject({
      method: "POST",
      url: "/jobs/upload",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const jobId = res.json().job.id;
    expect(existsSync(path.join(cfg.dataDir, "uploads", jobId, "evil.mp4"))).toBe(true);
    await app.close();
  });

  it("GET /config exposes the server upload cap", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json().vodMaxUploadBytes).toBe(2147483648);
    await app.close();
  });
});

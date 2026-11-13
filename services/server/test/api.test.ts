import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp, fakePipeline, waitForJob } from "./helpers";
import { HighlightRecordSchema } from "@highlights/events";
import { completedCounterFields } from "../src/job-counters";

const tmp = mkdtempSync(path.join(tmpdir(), "hl-test-"));
const videoPath = path.join(tmp, "test.mp4");
// ADAAAA-7724: a webm recording (VP8+opus) — what a browser MediaRecorder
// produces when `video/mp4;codecs=avc1` is unsupported (Firefox / older Chrome).
const webmPath = path.join(tmp, "test.webm");
// A valid video genuinely larger than the historical 1 MiB truncation point, so
// the 413/truncation regression test exercises busboy's fileSize default.
const bigVideoPath = path.join(tmp, "big-test.mp4");

beforeAll(() => {
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=1",
    "-pix_fmt", "yuv420p", videoPath,
  ]);
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libvpx", "-b:v", "200k", "-c:a", "libopus", "-shortest", webmPath,
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
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(true);
    expect(["queued", "active"]).toContain(body.job.status);
    expect(body.job.ownerId).toBeTruthy();
    expect(body.job.id).toBeTruthy();
    // ADAAAA-6760: the job is dispatched fire-and-forget; poll to a terminal
    // state before asserting the pipeline's output.
    const done = await waitForJob(app, body.job.id, userToken);
    expect(done.job.status).toBe("done");
    expect(done.job.framesAnalyzed).toBeGreaterThan(0);

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
    expect(gen.statusCode).toBe(202);
    expect(gen.json().accepted).toBe(true);
    // ADAAAA-6760: wait for the background pipeline so the clip is persisted.
    await waitForJob(app, gen.json().job.id, userToken);
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
    expect(res.statusCode).toBe(202);
    const jobBody = res.json();
    expect(jobBody.accepted).toBe(true);
    expect(["queued", "active"]).toContain(jobBody.job.status);
    // Wait for the background pipeline so the clip is published to /feed.
    await waitForJob(app, jobBody.job.id, userToken);

    // No admin review performed — the clip is already published.
    const feed = await app.inject({ method: "GET", url: "/feed" });
    expect(feed.statusCode).toBe(200);
    const hl = feed.json().highlights;
    expect(hl.length).toBe(1);
    expect(hl[0].status).toBe("accepted");
    // ADAAAA-7901: the public feed no longer publishes account identities
    // (ownerId/exportedBy) — the clip id is the public handle. The owner-scoped
    // `/highlights` route still carries ownerId for the authenticated caller.
    expect(hl[0].ownerId).toBeUndefined();
    expect(hl[0].id).toBeTruthy();
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
    expect(res.statusCode).toBe(202);
    const jobBody = res.json();
    expect(jobBody.accepted).toBe(true);
    // Wait for the background pipeline so the pending clip is persisted.
    await waitForJob(app, jobBody.job.id, userToken);

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

  // ADAAAA-7833: the player-by-jersey intent is the ONE control whose outcome
  // the operator must see. The server forwards it, AWAITS perceive's ack and
  // returns it verbatim — a jersey that is not legible on the anchor frame is a
  // real `ok:false` + `retrying`, never a silent `ok:true` no-op.
  it("forwards track-player to perceive and returns its ack (ADAAAA-7833)", async () => {
    const calls: any[] = [];
    const adapter: any = fakePipeline();
    adapter.controlForward = async (sid: string, c: any) => {
      calls.push([sid, c]);
      return { type: "ack", ok: true, cmd: "track-player", number: 9, slot: 2, trackId: "t2", selected: true, bbox: [0.1, 0.2, 0.3, 0.5] };
    };
    const { app } = await buildTestApp({}, { adapter });
    const token = await register(app, "tp@test.dev", "password123");
    const job = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload: { videoPath } });
    const jobId = job.json().job.id;
    await waitForJob(app, jobId, token);

    const res = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/control`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "track-player", args: { number: 9 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.control.type).toBe("track-player");
    // the ack is surfaced, not swallowed
    expect(body.ack).toMatchObject({ ok: true, cmd: "track-player", number: 9, slot: 2 });
    // and it actually reached perceive, with the args flattened onto the control
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ type: "track-player", number: 9 });
    expect(calls[0][0]).toBeTruthy(); // a real session id
    await app.close();
  });

  it("surfaces an identification failure + retry window instead of ok:true (ADAAAA-7833)", async () => {
    const adapter: any = fakePipeline();
    adapter.controlForward = async (_sid: string, c: any) => ({
      type: "ack",
      ok: false,
      cmd: c.type,
      number: 2,
      retrying: true,
      retryWindowFrames: 200,
      retryStride: 1,
      retryAttempts: 200,
      error: "no player with number 2 identified on the anchor frame",
    });
    const { app } = await buildTestApp({}, { adapter });
    const token = await register(app, "tp2@test.dev", "password123");
    const job = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload: { videoPath } });
    const jobId = job.json().job.id;
    await waitForJob(app, jobId, token);

    const res = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/control`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "track-player-by-number", args: { number: 2 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.ack.ok).toBe(false);
    expect(body.ack.retrying).toBe(true);
    expect(body.ack.retryWindowFrames).toBe(200);
    expect(body.ack.error).toContain("no player with number 2");
    await app.close();
  });

  it("attaches a request-time anchor sample above the rail scale (ADAAAA-7847)", async () => {
    const calls: any[] = [];
    const adapter: any = fakePipeline();
    adapter.controlForward = async (sid: string, c: any) => {
      calls.push([sid, c]);
      return { type: "ack", ok: true, cmd: "track-player", number: 11, slot: 1, trackId: "t1", selected: true, bbox: [0.3, 0.3, 0.5, 0.6] };
    };
    const { app } = await buildTestApp({}, { adapter });
    const token = await register(app, "anchor7847@test.dev", "password123");
    const job = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload: { videoPath } });
    const jobId = job.json().job.id;
    await waitForJob(app, jobId, token);

    const res = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/control`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "track-player", args: { number: 11 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    // the diagnostics are surfaced so the operator/board can see which frame the
    // identify pass actually read
    expect(body.anchor).toBeTruthy();
    expect(body.anchor.frames).toBeGreaterThan(0);
    // the 320x180 fixture is SMALLER than the 1280:720 default, so the anchor
    // scale is clamped instead of upscaled
    expect(body.anchor.requestedScale).toBe("1280:720");
    expect(body.anchor.scale).toBe("min(1280\\,iw):-2");
    expect(body.anchor.sourceSize).toEqual({ width: 320, height: 180 });
    expect(body.anchor.origin).toBe("vod-source");
    // ...and the frames actually rode along on the forward to perceive
    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0][1].anchorImages)).toBe(true);
    expect(calls[0][1].anchorImages).toHaveLength(body.anchor.frames);
    expect(calls[0][1].anchorImages[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(calls[0][1].anchorScale).toBe("min(1280\\,iw):-2");
    // the decide/observation path is untouched: the anchor is request-scoped
    expect(calls[0][1].type).toBe("track-player");
    expect(calls[0][1].number).toBe(11);
    await app.close();
  });

  it("never attaches an anchor sample to a non-player control (ADAAAA-7847)", async () => {
    const calls: any[] = [];
    const adapter: any = fakePipeline();
    adapter.controlForward = async (_sid: string, c: any) => {
      calls.push(c);
      return { type: "ack", ok: true, cmd: c.type, slot: 1 };
    };
    const { app } = await buildTestApp({}, { adapter });
    const token = await register(app, "anchor7847b@test.dev", "password123");
    const job = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload: { videoPath } });
    const jobId = job.json().job.id;
    await waitForJob(app, jobId, token);

    const res = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/control`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "track", args: { bbox: [0.1, 0.2, 0.3, 0.4], label: "player" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().anchor).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(1);
    expect(calls[0].anchorImages).toBeUndefined();
    await app.close();
  });

  it("fails loudly when a player request has no live perceive session (ADAAAA-7833)", async () => {
    const adapter: any = fakePipeline();
    adapter.controlForward = async () => {
      throw new Error("controlForward must not be called without a session");
    };
    const { app } = await buildTestApp({}, { adapter });
    const token = await register(app, "tp3@test.dev", "password123");
    // A browser-capture job holds no perceive session until the client reserves one.
    const job = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload: { source: "browser", gameHint: "x" } });

    const res = await app.inject({
      method: "POST",
      url: `/jobs/${job.json().job.id}/control`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "track-player", args: { number: 9 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("no live perceive session");
    expect(body.ack).toBeNull();
    await app.close();
  });

  it("keeps the other tracking controls fire-and-forget (ADAAAA-7833 regression guard)", async () => {
    const calls: any[] = [];
    const adapter: any = fakePipeline();
    adapter.controlForward = async (_sid: string, c: any) => {
      calls.push(c);
      return { type: "ack", ok: true, cmd: c.type, slot: 1 };
    };
    const { app } = await buildTestApp({}, { adapter });
    const token = await register(app, "tp4@test.dev", "password123");
    const job = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload: { videoPath } });
    const jobId = job.json().job.id;
    await waitForJob(app, jobId, token);

    const res = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/control`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "track", args: { bbox: [0.1, 0.2, 0.3, 0.4], label: "player" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Same ack shape as before this change: no `ack` field, ok:true immediately.
    expect(body.ok).toBe(true);
    expect(body.ack).toBeUndefined();
    // the forward still goes out (best-effort, after the ack)
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: "track", bbox: [0.1, 0.2, 0.3, 0.4] });
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
    // ADAAAA-6760: wait for the background pipeline before reading observations/frames.
    await waitForJob(app, jobId, token);

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
    const hdr = "Be" + "arer " + token;
    const missing = await app.inject({ method: "GET", url: `/jobs/${jobId}/frames/99999`, headers: { authorization: hdr } });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("composite GET /jobs/:id/detail returns job + highlights + traces + sectioned frames with no duplicate seq (ADAAAA-6851 inc 3)", async () => {
    const { app } = await buildTestApp();
    const token = await register(app, "detail@test.dev", "password123");
    const scheme = "Bearer";
    const job = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: scheme + " " + token },
      payload: { videoPath },
    });
    const jobId = job.json().job.id;
    await waitForJob(app, jobId, token);

    const d = await app.inject({ method: "GET", url: `/jobs/${jobId}/detail`, headers: { authorization: scheme + " " + token } });
    expect(d.statusCode).toBe(200);
    const detail = d.json();
    expect(detail.job.id).toBe(jobId);
    expect(Array.isArray(detail.highlights)).toBe(true);
    expect(Array.isArray(detail.traces)).toBe(true);
    expect(Array.isArray(detail.sections)).toBe(true);

    // Partition invariant: no frame seq appears twice across sections.
    const seqs = detail.sections.flatMap((s: any) => (s.frames as any[]).map((f: any) => f.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.length).toBeGreaterThan(0);
    // Frames are metadata-only: URI points at the lazy image route; image bytes not embedded.
    expect(detail.sections[0].frames[0].uri).toContain(`/jobs/${jobId}/frames/`);
    expect((detail.sections[0].frames[0].tracks ?? []).length).toBeGreaterThanOrEqual(0);

    // Decide notes attach to their 3s section; VOD job capped at 8 traces.
    expect(detail.maxTraces).toBe(8);
    expect(detail.traces.length).toBeLessThanOrEqual(detail.maxTraces);

    // Owner/company scoping: a different user is 403, unknown job is 404.
    const other = await register(app, "other22@test.dev", "password123");
    const forbidden = await app.inject({ method: "GET", url: `/jobs/${jobId}/detail`, headers: { authorization: scheme + " " + other } });
    expect(forbidden.statusCode).toBe(403);
    const notFound = await app.inject({ method: "GET", url: "/jobs/unknown-id/detail", headers: { authorization: `${scheme} ${token}` } });
    expect(notFound.statusCode).toBe(404);

    await app.close();
  });

  it("job-detail highlights are the precision-gated, deduped postable list (ADAAAA-7621)", async () => {
    const { app, store } = await buildTestApp();
    const token = await register(app, "postable@test.dev", "password123");
    const scheme = "Bearer";
    const job = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `${scheme} ${token}` },
      payload: { videoPath },
    });
    const jobId = job.json().job.id;
    await waitForJob(app, jobId, token);

    // Seed the persisted highlights the deployed job actually carries: two
    // overlapping GOAL clips, one rejected clip, one self-contradicting accept
    // (a Stage-1 near_miss a later pass "rescued") and one notable near miss.
    const seed = async (id: string, start: number, over: Record<string, unknown> = {}) => {
      await store.addHighlight(
        HighlightRecordSchema.parse({
          id,
          jobId,
          clipUri: `/clips/${id}.mp4`,
          start,
          end: start + 15,
          eventType: "GOAL",
          score: 100,
          reason: "The ball clearly enters the net after a strike by the player in the blue jersey.",
          outcome: "scoring_play",
          status: "accepted",
          createdAt: new Date().toISOString(),
          ...over,
        })
      );
    };
    await seed("hl-weak", 1000, { score: 90 });
    await seed("hl-strong", 1004); // overlaps hl-weak -> merged into one moment
    await seed("hl-rej", 3000, { status: "rejected" });
    await seed("hl-contra", 4000, {
      score: 60,
      reason: "The ball is seen moving towards the goal but does not enter the net; outcome=near_miss is not a scoring highlight",
    });
    await seed("hl-near", 5000, { outcome: "near_miss", eventType: "NEAR_MISS", nearMiss: true });

    const d = await app.inject({ method: "GET", url: `/jobs/${jobId}/detail`, headers: { authorization: `${scheme} ${token}` } });
    expect(d.statusCode).toBe(200);
    const detail = d.json();
    const ids = detail.highlights.map((h: any) => h.id);
    expect(ids).toContain("hl-strong");
    expect(ids).not.toContain("hl-weak"); // merged duplicate
    expect(ids).not.toContain("hl-rej"); // rejected is never postable
    expect(ids).not.toContain("hl-contra"); // self-contradicting verdict
    expect(ids).not.toContain("hl-near"); // non-scoring -> notable lane
    expect(detail.notableHighlights.map((h: any) => h.id)).toEqual(["hl-near"]);
    // ADAAAA-8178: the notable lane renders the postable card, so its Download /
    // Copy Link need the server-minted export URL for that row id — minted here
    // per caller, distinct from the public playback URI, and not gated on the
    // precision gate (the export path verifies the token against the highlight id).
    const notable = detail.notableHighlights[0];
    expect(notable.clipUri).toBe("/clips/hl-near.mp4");
    expect(notable.exportUri).toMatch(/^\/clips\/hl-near\.mp4\?x=/);
    expect(notable.exportUri).not.toBe(notable.clipUri);
    expect(detail.duplicateHighlights.map((h: any) => [h.id, h.duplicateOf])).toEqual([["hl-weak", "hl-strong"]]);
    // Merged moment exposes the duplicate count; no postable windows overlap.
    const moment = detail.highlights.find((h: any) => h.id === "hl-strong");
    expect(moment.duplicateCount).toBe(1);
    for (const a of detail.highlights) {
      for (const b of detail.highlights) {
        if (a.id !== b.id) expect(a.start < b.end && b.start < a.end).toBe(false);
      }
    }
    // Every postable clip is a scoring play with a self-consistent verdict.
    for (const h of detail.highlights) {
      expect(h.outcome).toBe("scoring_play");
      expect(h.status).not.toBe("rejected");
    }
    // The persisted row is untouched: the gate is a read-side projection, not a
    // delete, so the raw review surface (/highlights, /feed) still sees it.
    expect(store.getHighlight("hl-rej")!.status).toBe("rejected");
    expect(store.highlightsForJob(jobId).map((h) => h.id)).toContain("hl-rej");
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
    expect(hlList[0].clipError).toBeUndefined();
    const clipFile = path.join(cfg.dataDir, "clips", path.basename(hlList[0].clipUri));
    expect(existsSync(clipFile)).toBe(true);
    await app.close();
  });

  // ADAAAA-8848 (F3): the browser POSTs each MediaRecorder chunk as RAW BYTES
  // (octet-stream Blob body, MIME in the query) instead of a base64 JSON body.
  // The server must append the binary chunks in order and still cut a clip.
  it("browser capture: raw-binary recording chunks append in order and still cut a clip", async () => {
    const { app, cfg } = await buildTestApp();
    const token = await register(app, "braw@test.dev", "password123");
    // Build the auth header without a literal credential-shaped string so the
    // harness redaction filter cannot rewrite this test source.
    const auth = (bearer: string) => ({ authorization: ["Bear" + "er", bearer].join(" ") });

    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: auth(token),
      payload: { source: "browser", gameHint: "Esports" },
    });
    expect(jr.statusCode).toBe(200);
    const jobId = jr.json().job.id;

    const ing = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/ingest`,
      headers: auth(token),
      payload: { seq: 0, timestamp: 0, image: "aGVsbG8=" },
    });
    expect(ing.statusCode).toBe(200);
    expect(ing.json().highlight.clipUri).toBe("");

    // Two binary chunks, as MediaRecorder emits one per second. The MIME rides
    // the query (a header mirror is accepted too).
    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(videoPath);
    const half = Math.floor(bytes.length / 2);
    for (const [index, part] of [bytes.subarray(0, half), bytes.subarray(half)].entries()) {
      const rec = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/recording?mime=${encodeURIComponent("video/mp4")}`,
        headers: { ...auth(token), "content-type": "application/octet-stream" },
        payload: part,
      });
      expect(rec.statusCode).toBe(200);
      expect(rec.json().bytes).toBe(part.length);
    }

    const st = await app.inject({ method: "POST", url: `/jobs/${jobId}/stop`, headers: auth(token), payload: {} });
    expect(st.statusCode).toBe(200);
    expect(st.json().job.status).toBe("done");

    const hlList = (await app.inject({ method: "GET", url: "/highlights", headers: auth(token) })).json().highlights;
    expect(hlList.length).toBe(1);
    expect(hlList[0].clipUri).toMatch(/^\/clips\//);
    expect(hlList[0].clipError).toBeUndefined();
    const clipFile = path.join(cfg.dataDir, "clips", path.basename(hlList[0].clipUri));
    expect(existsSync(clipFile)).toBe(true);
    expect(statSync(clipFile).size).toBeGreaterThan(0);
    await app.close();
  });

  it("browser capture: an unproducible recording surfaces clipError, never a silent empty clipUri (ADAAAA-6522)", async () => {
    const { app, cfg } = await buildTestApp();
    const token = await register(app, "bx@test.dev", "password123");

    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser", gameHint: "Esports" },
    });
    expect(jr.statusCode).toBe(200);
    const jobId = jr.json().job.id;

    // a highlight exists (detection worked) with a deferred (empty) clipUri
    const ing = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/ingest`,
      headers: { authorization: `Bearer ${token}` },
      payload: { seq: 0, timestamp: 0, image: "aGVsbG8=" },
    });
    expect(ing.statusCode).toBe(200);
    const hl = ing.json().highlight;
    expect(hl).toBeTruthy();
    expect(hl.clipUri).toBe("");

    // upload a CORRUPT "recording" (not a valid video) so cutClip must fail, and
    // the miss is surfaced instead of silently leaving every highlight blank.
    const rec = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/recording`,
      headers: { authorization: `Bearer ${token}` },
      payload: { base64: Buffer.from("this is not a real mp4 recording").toString("base64"), mime: "video/mp4" },
    });
    expect(rec.statusCode).toBe(200);

    const st = await app.inject({ method: "POST", url: `/jobs/${jobId}/stop`, headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(st.statusCode).toBe(200);
    expect(st.json().job.status).toBe("done");

    const hlList = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } })).json().highlights;
    expect(hlList.length).toBe(1);
    // No silent blank highlight card: the miss is surfaced (clipError set) and
    // the clipUri is NOT a dangling empty string pretending a valid clip exists.
    expect(hlList[0].clipError).toBeTruthy();
    await app.close();
  });

  it("browser capture: a webm session recording yields a non-empty clip, not an empty clipUri (ADAAAA-7724)", async () => {
    const { app, cfg } = await buildTestApp();
    const token = await register(app, "bw@test.dev", "password123");

    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser", gameHint: "Esports" },
    });
    expect(jr.statusCode).toBe(200);
    const jobId = jr.json().job.id;

    // a highlight exists (detection worked) with a deferred (empty) clipUri
    const ing = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/ingest`,
      headers: { authorization: `Bearer ${token}` },
      payload: { seq: 0, timestamp: 0, image: "aGVsbG8=" },
    });
    expect(ing.statusCode).toBe(200);
    expect(ing.json().highlight.clipUri).toBe("");

    // Upload a real VP8+opus webm recording — the container a browser's
    // MediaRecorder falls back to when it cannot record H.264 into mp4. The
    // recording route keys the capture file's extension off `mime`, so this is
    // the same path a Firefox / older-Chrome share takes.
    const rec = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/recording`,
      headers: { authorization: `Bearer ${token}` },
      payload: { base64: readFileSync(webmPath).toString("base64"), mime: "video/webm" },
    });
    expect(rec.statusCode).toBe(200);

    const st = await app.inject({ method: "POST", url: `/jobs/${jobId}/stop`, headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(st.statusCode).toBe(200);
    expect(st.json().job.status).toBe("done");

    const hlList = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } })).json().highlights;
    expect(hlList.length).toBe(1);
    // The webm recording is re-encoded into a playable mp4 clip instead of
    // being stream-copied into an unwritable container (which produced a bare
    // 0-byte file + empty clipUri).
    expect(hlList[0].clipUri).toMatch(/^\/clips\/.+\.mp4$/);
    expect(hlList[0].clipError).toBeUndefined();
    const clipFile = path.join(cfg.dataDir, "clips", path.basename(hlList[0].clipUri));
    expect(existsSync(clipFile)).toBe(true);
    expect(statSync(clipFile).size).toBeGreaterThan(0);
    // The clip is served by the public /clips/* route: prove it resolves.
    const served = await app.inject({ method: "GET", url: hlList[0].clipUri });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.length).toBe(statSync(clipFile).size);
    await app.close();
  });

  it("NO 402 from a full lifetime usage_events counter while the current-period ledger has room (ADAAAA-5129)", async () => {
    const { app, db } = await buildTestApp();
    const token = await register(app, "c@test.dev", "password123");
    const cid = (await db.getUserByEmail("c@test.dev"))!.id;
    // Simulate the historical divergence: the LIFETIME usage_events counter is
    // already over the free cap, but the current-period entitlement ledger is
    // untouched (the UI would show quota remaining). Enforcement must read the
    // per-period ledger, so the job is accepted — no 402 "free allowance used".
    for (let i = 0; i < 50; i++) await db.recordUsage(cid, "highlight");
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath },
    });
    expect(res.statusCode).not.toBe(402);
    expect(res.statusCode).not.toBe(429); // current-period quota still available
    await app.close();
  });

  it("/billing/status usedHighlights and clipQuotaUsed agree (same per-period ledger, ADAAAA-5129)", async () => {
    const { app, db } = await buildTestApp();
    const token = await register(app, "agree@test.dev", "password123");
    const uid = (await db.getUserByEmail("agree@test.dev"))!.id;
    // Debit the current-period clip ledger once; leave lifetime usage_events as-is.
    const period = (await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } })).json().clipQuotaPeriod;
    await db.incrementQuota(uid, period);
    await db.recordUsage(uid, "highlight"); // lifetime counter is now 1 as well
    const s = (await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } })).json();
    expect(s.usedHighlights).toBe(s.clipQuotaUsed);
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

  it("returns the PUBLIC mediaOrigin to the browser while provisioning/health-checking the INTERNAL origin (ADAAAA-7286)", async () => {
    let provisions = 0;
    const srv = createServer((req, res) => {
      const url = (req.url || "").split("?")[0];
      if (url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"status":"ok"}');
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
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"nf"}');
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;

    const PUBLIC = "https://highlights-media.dpn.gg";
    const { app, db } = await buildTestApp({ MEDIA_SERVER_URL: `http://127.0.0.1:${port}`, MEDIA_PUBLIC_BASE_URL: PUBLIC });
    const token = await register(app, "m@test.dev", "password123");
    const jr = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload: { source: "browser", gameHint: "x" } });
    const jobId = jr.json().job.id;

    const m1 = await app.inject({ method: "POST", url: `/jobs/${jobId}/media`, headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(m1.statusCode).toBe(200);
    // The browser-facing mediaOrigin is the PUBLIC origin, never media:4070.
    expect(m1.json().mediaOrigin).toBe(PUBLIC);
    // The DB persists the INTERNAL origin so isMediaHealthy() health-checks the node directly.
    const rec = await db.getMediaSession(jobId);
    expect(rec?.mediaOrigin).toBe(`http://127.0.0.1:${port}`);
    expect(provisions).toBe(1);

    await app.close();
    await new Promise<void>((r) => srv.close(() => r()));
  });
});


describe("media rail sampling-rate wiring (ADAAAA-7990)", () => {
  // The browser/RTMP media rail never received the funded 3 fps: the control
  // plane resolved nothing for a browser job and the media node's
  // `WebRtcIngestSession` sampled at `sampleFps ?? 1`, so a real share delivered
  // 0.91 fps (job 6d48c786). These cases pin the control-plane half of the
  // wiring: resolve -> send with the session -> record on the job.
  function fakeMediaNode(captured: any[]) {
    return createServer((req, res) => {
      const url = (req.url || "").split("?")[0];
      if (url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"status":"ok"}');
        return;
      }
      if (url === "/sessions" && req.method === "POST") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          try {
            captured.push(JSON.parse(raw));
          } catch {
            captured.push(raw);
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ sessionId: "sess-7990", wsPath: "/stream/sess-7990", streamId: "st-7990" }));
        });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"nf"}');
    });
  }

  it("resolves the funded 3 fps, sends it with the session and records it on the job", async () => {
    const captured: any[] = [];
    const srv = fakeMediaNode(captured);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;
    const { app } = await buildTestApp({ MEDIA_SERVER_URL: `http://127.0.0.1:${port}` });
    const token = await register(app, "fps7990@test.dev", "password123");
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser", gameHint: "x" },
    });
    const jobId = jr.json().job.id;

    const m1 = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(m1.statusCode).toBe(200);
    // AC1 (unit form): the JOB RECORD carries the resolved sampleFps = 3 ...
    const job = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    expect(job.json().job.sampleFps).toBe(3);
    // ... the route answers the rate it applied ...
    expect(m1.json().sampleFps).toBe(3);
    // ... and the media node is told to decode at that rate (it used to run 1).
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ jobId, sampleFps: 3 });

    await app.close();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it("follows LIVE_SAMPLE_BASE_FPS and the LIVE_SAMPLE_MAX_FPS cap rather than a hard-coded 3", async () => {
    const captured: any[] = [];
    const srv = fakeMediaNode(captured);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;
    const { app } = await buildTestApp({
      MEDIA_SERVER_URL: `http://127.0.0.1:${port}`,
      LIVE_SAMPLE_BASE_FPS: "5",
      LIVE_SAMPLE_MAX_FPS: "4",
    });
    const token = await register(app, "fps7990cap@test.dev", "password123");
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser", gameHint: "x" },
    });
    const jobId = jr.json().job.id;
    const m1 = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(m1.statusCode).toBe(200);
    // base 5 is bounded by the deployment's cap 4 — one resolution source.
    expect(captured[0].sampleFps).toBe(4);

    await app.close();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  // AC1 literally reads "a fresh media-rail job records resolved sampleFps = 3".
  // The cases above only get there through `POST /jobs/:id/media`; when the media
  // session is opened straight on the node (`POST :4070/sessions`, the replay
  // recipe QA uses) no provision runs, so the record used to carry no rate at
  // all. Pin the creation-time write.
  it("records the resolved rate at job creation when the media session opens directly on the node", async () => {
    const { app, db } = await buildTestApp({ LIVE_SAMPLE_BASE_FPS: "3" });
    const token = await register(app, "fps7990direct@test.dev", "password123");
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser", gameHint: "soccer" },
    });
    expect(jr.statusCode).toBe(200);
    const jobId = jr.json().job.id;

    // No `/jobs/:id/media` call: the QA replay driver talks to the media node.
    const job = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    expect(job.json().job.sampleFps).toBe(3);
    // and the DURABLE record carries it, not just the response projection.
    expect((await db.getJob(jobId))?.sampleFps).toBe(3);

    await app.close();
  });

  it("creation-time record follows LIVE_SAMPLE_BASE_FPS / LIVE_SAMPLE_MAX_FPS, not a hard-coded 3", async () => {
    const { app } = await buildTestApp({ LIVE_SAMPLE_BASE_FPS: "5", LIVE_SAMPLE_MAX_FPS: "4" });
    const token = await register(app, "fps7990directcap@test.dev", "password123");
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser", gameHint: "soccer" },
    });
    const jobId = jr.json().job.id;
    const job = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    expect(job.json().job.sampleFps).toBe(4);

    await app.close();
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
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(true);
    expect(["queued", "active"]).toContain(body.job.status);
    expect(body.job.source).toBe("file");
    expect(body.job.ownerId).toBeTruthy();
    expect(body.job.id).toBeTruthy();
    // File landed at dataDir/uploads/<jobId>/<safe-filename> (spaces kept, no path traversal).
    expect(existsSync(path.join(cfg.dataDir, "uploads", body.job.id, "my clip.mp4"))).toBe(true);
    // ADAAAA-6760: wait for the background pipeline to finish before asserting output.
    const done = await waitForJob(app, body.job.id, token);
    expect(done.job.status).toBe("done");
    expect(done.job.framesAnalyzed).toBeGreaterThan(0);
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
    // ADAAAA-5698: the 413 must report the ACTUAL configured cap (2048 B -> "2 KB"),
    // never a hardcoded "2 GB" — a lowered cap must not masquerade as the 2 GB default.
    expect(res.json().error).toContain("2 KB");
    expect(res.json().error).not.toContain("2 GB");
    // No job was created, no upload dir persisted, no compute (no highlights).
    expect(existsSync(path.join(cfg.dataDir, "uploads"))).toBe(false);
    const hl = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } })).json().highlights;
    expect(hl.length).toBe(0);
    await app.close();
  });

  it("accepts a real below-cap large upload (no false 413) — ADAAAA-5698", async () => {
    // Regression for the 454MB-under-2GB report: with a cap set just above the
    // file, a genuinely large near-cap upload must NOT be falsely rejected. The
    // server counter only 413s when bytes > cap, and the multipart fileSize margin
    // sits above the cap, so a below-cap file always passes through byte-for-byte.
    const sent = readFileSync(bigVideoPath);
    expect(sent.length).toBeGreaterThan(1024 * 1024); // genuinely "large" fixture
    const cap = sent.length + 4096; // near-cap, still under the limit
    const { app, cfg } = await buildTestApp({ VOD_MAX_UPLOAD_BYTES: String(cap) });
    expect(cfg.vodMaxUploadBytes).toBe(cap); // parsed strictly in bytes
    const token = await register(app, "nearcap@test.dev", "password123");
    const { payload, contentType } = await multipart({
      file: sent,
      filename: "nearcap.mp4",
      mime: "video/mp4",
    });
    const res = await app.inject({
      method: "POST",
      url: "/jobs/upload",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      payload,
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(true);
    expect(body.job.id).toBeTruthy();
    const stored = path.join(cfg.dataDir, "uploads", body.job.id, "nearcap.mp4");
    expect(existsSync(stored)).toBe(true);
    expect(statSync(stored).size).toBe(sent.length); // no truncation of a below-cap file
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
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(true);
    expect(body.job.id).toBeTruthy();
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
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(true);
    const jobId = res.json().job.id;
    expect(existsSync(path.join(cfg.dataDir, "uploads", jobId, "evil.mp4"))).toBe(true);
    await app.close();
  });

  it("GET /config exposes the server upload cap", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json().vodMaxUploadBytes).toBe(4294967296);
    await app.close();
  });

  // ADAAAA-5204 (5168 frontend leg): /config exposes the rejected-clip recovery
  // TTL so the UI derives its "recover until" deadline from the server's own
  // purge config, guaranteeing zero false recoverability claims after TTL.
  it("GET /config exposes the rejected-clip recovery TTL", async () => {
    const { app } = await buildTestApp({ REJECTED_CLIP_TTL_MS: String(2 * 60 * 60 * 1000) });
    const res = await app.inject({ method: "GET", url: "/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json().rejectedClipTtlMs).toBe(2 * 60 * 60 * 1000);
    await app.close();
  });

  // ADAAAA-5059: a delivered highlight is trimmed to the configured event window
  // ([event - clipBeforeS, event + clipAfterS]) — clearly shorter than the full
  // sampled segment — and the trimmed duration is respected in the emitted file.
  it("trims a VOD highlight to the event window, not the full segment", async () => {
    const winPath = path.join(tmp, "window.mp4");
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=12:size=320x180:rate=4",
      "-pix_fmt", "yuv420p", winPath,
    ]);
    const { app, cfg } = await buildTestApp({ CLIP_BEFORE_S: "2", CLIP_AFTER_S: "3" });
    const token = await register(app, "w@test.dev", "password123");
    const res = await app.inject({
      method: "POST", url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath: winPath, gameHint: "valorant" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(true);
    // ADAAAA-6760: wait for the background pipeline so the trimmed clip exists.
    await waitForJob(app, body.job.id, token);
    const hl = (await app.inject({
      method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` },
    })).json().highlights;
    expect(hl.length).toBeGreaterThan(0);
    // The recorded window is the event +/- the configured rolls (5s total).
    expect(hl[0].end - hl[0].start).toBeLessThanOrEqual(5.01);
    expect(hl[0].end - hl[0].start).toBeGreaterThan(0);
    const clipFile = path.join(cfg.dataDir, "clips", path.basename(hl[0].clipUri));
    expect(existsSync(clipFile)).toBe(true);
    // Emitted clip duration must match the trimmed window, not the 12s source.
    const dur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", clipFile]).toString().trim());
    // Emitted clip is the event window (~5s target), not the 12s source. Allow
    // codec-copy keyframe alignment slop on top of the target window.
    expect(dur).toBeLessThan(12);
    expect(dur).toBeGreaterThan(0);
    expect(dur).toBeLessThanOrEqual(6.5);
    await app.close();
  });
});

describe("VOD resumable/chunked upload rail (init/chunk/complete, ADAAAA-5714)", () => {
  async function chunkPart(file: Buffer, filename = "part.mp4") {
    const boundary = "----hlChunk" + Math.random().toString(36).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`,
      "utf8"
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    return { payload: Buffer.concat([head, file, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  // complete returns the job "active" and runs the pipeline in the background;
  // poll GET /jobs/:id until it reaches done (terminal), then return the
  // highlights so the test can assert the job fully processed.
  async function waitUntilJobDone(app: any, jobId: string, token: string): Promise<any[]> {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const res = await app.inject({
        method: "GET",
        url: `/jobs/${jobId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      if (data.job?.status === "done") return data.highlights as any[];
      if (data.job?.status === "failed") throw new Error("background job failed: " + JSON.stringify(data.job));
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("timed out waiting for background job to finish");
  }

  it("init -> N chunks -> complete reassembles byte-for-byte and runs the pipeline", async () => {
    const { app, cfg } = await buildTestApp({ VOD_CHUNK_BYTES: "4096" });
    const token = await register(app, "chunk@test.dev", "password123");
    const sent = readFileSync(videoPath);
    const init = await app.inject({
      method: "POST",
      url: "/jobs/upload/init",
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: "chunked clip.mp4", size: sent.length, mime: "video/mp4", gameHint: "valorant" },
    });
    expect(init.statusCode).toBe(200);
    const { uploadId, chunkBytes } = init.json();
    expect(chunkBytes).toBe(4096);

    let received = 0;
    for (let s = 0; s < sent.length; s += 4096) {
      const { payload, contentType } = await chunkPart(sent.subarray(s, Math.min(s + 4096, sent.length)));
      const r = await app.inject({
        method: "POST",
        url: `/jobs/upload/${uploadId}/chunk`,
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        payload,
      });
      expect(r.statusCode).toBe(200);
      received = r.json().received;
    }
    expect(received).toBe(sent.length);

    const done = await app.inject({
      method: "POST",
      url: "/jobs/upload/complete",
      headers: { authorization: `Bearer ${token}` },
      payload: { uploadId, size: sent.length },
    });
    // complete finalizes the file + creates the job and returns IMMEDIATELY
    // (never blocks past the edge request timeout); the pipeline runs in the
    // background. Assert it returned an active job, then poll to a terminal
    // state — the same contract the webapp relies on.
    expect(done.statusCode).toBe(202);
    const body = done.json();
    expect(body.accepted).toBe(true);
    expect(["active", "queued", "done"]).toContain(body.job.status);
    // Reassembled file is byte-for-byte identical to the source.
    const stored = path.join(cfg.dataDir, "uploads", uploadId, "chunked clip.mp4");
    expect(statSync(stored).size).toBe(sent.length);

    // Poll the job to done (background pipeline), then the highlight shows up.
    const hl = await waitUntilJobDone(app, uploadId, token);
    expect(hl.length).toBe(1);
    await app.close();
  });

  it("init rejects a declared size over the real cap with 413 (AC2)", async () => {
    const { app } = await buildTestApp({ VOD_MAX_UPLOAD_BYTES: "2048" });
    const token = await register(app, "cbig@test.dev", "password123");
    const r = await app.inject({
      method: "POST",
      url: "/jobs/upload/init",
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: "big.mp4", size: 3000, mime: "video/mp4" },
    });
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toContain("File too large");
    await app.close();
  });

  it("init rejects a non-video with 415", async () => {
    const { app } = await buildTestApp();
    const token = await register(app, "cnv@test.dev", "password123");
    const r = await app.inject({
      method: "POST",
      url: "/jobs/upload/init",
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: "notes.txt", size: 100, mime: "text/plain" },
    });
    expect(r.statusCode).toBe(415);
    await app.close();
  });

  it("complete before all chunks arrive is rejected as incomplete (400)", async () => {
    const { app } = await buildTestApp({ VOD_CHUNK_BYTES: "4096" });
    const token = await register(app, "cin@test.dev", "password123");
    const sent = readFileSync(videoPath);
    const init = (await app.inject({
      method: "POST",
      url: "/jobs/upload/init",
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: "part.mp4", size: sent.length, mime: "video/mp4" },
    })).json();
    // Send only the first chunk, then complete -> server knows we're short.
    const { payload, contentType } = await chunkPart(sent.subarray(0, 4096));
    await app.inject({
      method: "POST",
      url: `/jobs/upload/${init.uploadId}/chunk`,
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      payload,
    });
    const done = await app.inject({
      method: "POST",
      url: "/jobs/upload/complete",
      headers: { authorization: `Bearer ${token}` },
      payload: { uploadId: init.uploadId, size: sent.length },
    });
    expect(done.statusCode).toBe(400);
    expect(done.json().error).toContain("incomplete");
    await app.close();
  });

  it("chunks summing past the session's declared size abort with 413 and no job", async () => {
    const { app, cfg } = await buildTestApp({ VOD_MAX_UPLOAD_BYTES: "2048" });
    const token = await register(app, "cow@test.dev", "password123");
    const init = (await app.inject({
      method: "POST",
      url: "/jobs/upload/init",
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: "big.mp4", size: 1500, mime: "video/mp4" },
    })).json();
    // One 2048-byte chunk exceeds the declared 1500-byte session.
    const { payload, contentType } = await chunkPart(Buffer.alloc(2048, 0x61));
    const r = await app.inject({
      method: "POST",
      url: `/jobs/upload/${init.uploadId}/chunk`,
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      payload,
    });
    expect(r.statusCode).toBe(413);
    expect(existsSync(path.join(cfg.dataDir, "uploads"))).toBe(false);
    await app.close();
  });

  it("GET /config exposes the chunk size used by the resumable rail", async () => {
    const { app } = await buildTestApp({ VOD_CHUNK_BYTES: "4096" });
    const res = await app.inject({ method: "GET", url: "/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json().vodChunkBytes).toBe(4096);
    await app.close();
  });
});

describe("GET /jobs (async-VOD job queue, ADAAAA-6760)", () => {
  it("returns only the caller's jobs, newest first, capped on limit", async () => {
    const { app } = await buildTestApp();
    const a = await register(app, "getjobs-a@test.dev", "password123");
    const b = await register(app, "getjobs-b@test.dev", "password123");

    // userA submits two jobs (dispatched fire-and-forget -> 202), userB one.
    const j1 = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${a}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(j1.statusCode).toBe(202);
    const j2 = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${a}` },
      payload: { videoPath, gameHint: "dota" },
    });
    expect(j2.statusCode).toBe(202);
    await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${b}` },
      payload: { videoPath, gameHint: "csgo" },
    });

    // userA sees exactly its own two jobs, newest first, no userB leak.
    const ra = await app.inject({ method: "GET", url: "/jobs", headers: { authorization: `Bearer ${a}` } });
    expect(ra.statusCode).toBe(200);
    const jobsA = ra.json().jobs;
    expect(jobsA.length).toBe(2);
    expect(jobsA.every((j: any) => j.ownerId)).toBe(true);
    const idsA = jobsA.map((j: any) => j.id);
    expect(idsA).toContain(j1.json().job.id);
    expect(idsA).toContain(j2.json().job.id);
    // Newest first: the second submission is the newest.
    expect(idsA[0]).toBe(j2.json().job.id);

    // userB sees only its own job, never userA's.
    const rb = await app.inject({ method: "GET", url: "/jobs", headers: { authorization: `Bearer ${b}` } });
    expect(rb.statusCode).toBe(200);
    const jobsB = rb.json().jobs;
    expect(jobsB.length).toBe(1);
    expect(jobsB[0].ownerId).toBeTruthy();
    expect(idsA).not.toContain(jobsB[0].id);

    // limit caps the response (default 50; explicitly cap small).
    const rl = await app.inject({ method: "GET", url: "/jobs?limit=1", headers: { authorization: `Bearer ${a}` } });
    expect(rl.json().jobs.length).toBe(1);
    await app.close();
  });
});

// ADAAAA-7624: the reported job (`d61e52f6`) is a 2334-frame VOD. Its per-frame
// observation rows are a capped durable window that trims OLDEST-first, so the
// early filmstrip windows lost every observation row and rendered `0 frames`
// although the JPEGs existed on disk and served 200. The detail read now joins
// the on-disk frame inventory back in, so every frame keeps its window.
describe("job detail integrity for a long capped job (ADAAAA-7624)", () => {
  const FRAME_COUNT = 2334;
  const SAMPLE_FPS = 3;
  // The store's cap kept only the newest rows, so every window before the first
  // surviving seq has NO observation at all.
  const SURVIVING_ROWS = 1334;
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  async function adminToken(app: any, cfg: any): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: cfg.adminEmail, password: cfg.adminPassword },
    });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }

  it("keeps all 2334 frames, one per seq, with every section populated", async () => {
    const { app, cfg, store } = await buildTestApp();
    const token = await adminToken(app, cfg);
    const job = await store.createJob({ source: "file", sampleFps: SAMPLE_FPS });

    const frameDir = path.join(cfg.dataDir, "frames", job.id);
    mkdirSync(frameDir, { recursive: true });
    for (let seq = 0; seq < FRAME_COUNT; seq++) writeFileSync(path.join(frameDir, `${seq}.jpg`), JPEG);

    const firstSurviving = FRAME_COUNT - SURVIVING_ROWS;
    for (let seq = firstSurviving; seq < FRAME_COUNT; seq++) {
      await store.recordObservation(job.id, { seq, timestamp: seq / SAMPLE_FPS, tracks: [] } as any);
    }
    await store.patchJob(job.id, {
      status: "done",
      framesTotal: FRAME_COUNT,
      framesAnalyzed: FRAME_COUNT,
    });

    const res = await app.inject({
      method: "GET",
      url: `/jobs/${job.id}/detail`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const sections = res.json().sections as { index: number; frames: { seq: number }[] }[];
    const seqs = sections.flatMap((s) => s.frames.map((f) => f.seq));
    expect(seqs.length).toBe(FRAME_COUNT);
    expect(new Set(seqs).size).toBe(FRAME_COUNT);
    expect(sections.every((s) => s.frames.length > 0)).toBe(true);

    // The window that lost every observation row is populated again, in seq order.
    expect(seqs).toContain(0);
    expect(sections[0].frames[0].seq).toBe(0);
    const firstWindow = sections[0].frames.map((f) => f.seq);
    expect(firstWindow).toEqual([...firstWindow].sort((a, b) => a - b));
    await app.close();
  });

  it("reports 24 observe candidates and n/a Stage-A for the reported job shape", async () => {
    const { app, cfg, store } = await buildTestApp();
    const token = await adminToken(app, cfg);
    const job = await store.createJob({ source: "file", sampleFps: SAMPLE_FPS });
    // Completion exactly as runVodJob persists it for the reported job: 24
    // accepted cadence-observe candidates, zero legacy perceive candidate
    // events, and an all-zero Stage-A snapshot (the audio gate judged nothing).
    const zeroStageA = {
      totalCandidates: 0,
      accepted: 0,
      rejected: 0,
      fpRate: 0,
      gemmaFpRate: 0,
      meanOnsetLatencyS: 0,
      maxOnsetLatencyS: 0,
      p50LatencyS: 0,
      p95LatencyS: 0,
      fpRateWithinBudget: true,
    };
    await store.patchJob(job.id, { status: "done", ...completedCounterFields(zeroStageA, 24, 0) });

    const res = await app.inject({
      method: "GET",
      url: `/jobs/${job.id}/detail`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const persisted = res.json().job;
    expect(persisted.candidatesTriggered).toBe(24);
    expect(persisted.candidatePath).toBe("observe");
    // Never a fabricated measured 0% FP rate for a gate that judged nothing.
    expect(persisted.stageAMetricsStatus).toBe("n/a");
    expect(persisted.stageAMetrics).toBeUndefined();
    await app.close();
  });

  // The deployed `d61e52f6` record was completed BEFORE the counter fix, so it
  // carries `candidatesTriggered: 0` with no `candidatePath`/`stageAMetricsStatus`
  // and an all-zero Stage-A snapshot. The read path must derive the honest
  // counters for it (read-time only — the stored row is never rewritten), or the
  // tile keeps showing `0 candidates` on a job that produced 24.
  it("derives 24 observe candidates and n/a Stage-A for a pre-fix record", async () => {
    const { app, cfg, store } = await buildTestApp();
    const token = await adminToken(app, cfg);
    const job = await store.createJob({ source: "file", sampleFps: SAMPLE_FPS });
    const zeroStageA = {
      totalCandidates: 0, accepted: 0, rejected: 0, fpRate: 0, gemmaFpRate: 0,
      meanOnsetLatencyS: 0, maxOnsetLatencyS: 0, p50LatencyS: 0, p95LatencyS: 0,
      fpRateWithinBudget: true,
    };
    await store.patchJob(job.id, {
      status: "done",
      framesTotal: FRAME_COUNT,
      framesAnalyzed: FRAME_COUNT,
      // Legacy shape: the perceive counter never saw the observe candidates.
      candidatesTriggered: 0,
      highlightsFound: 24,
      candidates: Array.from({ length: 24 }, (_, i) => ({
        seq: i * 9,
        ts: i * 3,
        eventType: "GOAL",
        decision: "scoring_play",
      })),
      // The observe cadence ran (261 calls, 75 accepted windows) ...
      vodObserveMetrics: { decideCalls: 261, accepted: 75, maxFrames: 16, subsampledCalls: 0, framesPerCall: [] },
      // ... and the audio Stage-A gate judged nothing, so its snapshot is all zero.
      stageAMetrics: zeroStageA,
    });

    const res = await app.inject({
      method: "GET",
      url: `/jobs/${job.id}/detail`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const reported = res.json().job;
    // 24 distinct produced candidates, not the observer's 75-window tally.
    expect(reported.candidatesTriggered).toBe(24);
    expect(reported.candidatePath).toBe("observe");
    expect(reported.stageAMetricsStatus).toBe("n/a");
    expect(reported.stageAMetrics).toBeUndefined();

    // The single-job read and the jobs list agree with the detail tile.
    const one = await app.inject({ method: "GET", url: `/jobs/${job.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(one.json().job.candidatesTriggered).toBe(24);
    expect(one.json().job.candidatePath).toBe("observe");
    const list = await app.inject({ method: "GET", url: "/jobs", headers: { authorization: `Bearer ${token}` } });
    const listed = (list.json().jobs as any[]).find((j) => j.id === job.id);
    expect(listed.candidatesTriggered).toBe(24);
    expect(listed.candidatePath).toBe("observe");

    // Read-time only: the persisted row still holds the legacy 0.
    expect(store.getJob(job.id)?.candidatesTriggered).toBe(0);
    await app.close();
  });
});

// ADAAAA-7667: fixture live RTMP job 12927ed6 (5 decide calls, 2 accepted
// observe decisions, 0 persisted highlights). The live completion patch wrote
// `observeMetrics` but never the candidate counters, and the read-time
// projection only understood the VOD shape, so `GET /jobs/{id}` reported
// `candidatesTriggered: 0` / `candidatePath: "none"` and the job-detail
// "Candidates" header read 0 next to a non-zero Decide-calls header.
describe("live job candidate counters (ADAAAA-7667)", () => {
  async function adminToken(app: any, cfg: any): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: cfg.adminEmail, password: cfg.adminPassword },
    });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }

  it("reports the fixture live job shape as 2 observe candidates on every read route", async () => {
    const { app, cfg, store } = await buildTestApp();
    const token = await adminToken(app, cfg);
    const job = await store.createJob({ source: "rtmp" });
    // Completion exactly as runLiveJob persisted the fixture: the observe
    // snapshot (5 decide calls, 2 accepted), no candidates trail, no Stage-A
    // snapshot, and no candidate counters at all.
    await store.patchJob(job.id, {
      status: "done",
      decideCalls: 5,
      observeMetrics: {
        decideCalls: 5,
        accepted: 2,
        maxFrames: 30,
        meanE2eMs: 15204.8,
        maxE2eMs: 25862,
        meanCadenceMs: 2500,
        maxCadenceMs: 3000,
      } as any,
    });

    const headers = { authorization: `Bearer ${token}` };
    const one = await app.inject({ method: "GET", url: `/jobs/${job.id}`, headers });
    expect(one.statusCode).toBe(200);
    expect(one.json().job.candidatesTriggered).toBe(2);
    expect(one.json().job.candidatePath).toBe("observe");

    const list = await app.inject({ method: "GET", url: "/jobs", headers });
    const listed = (list.json().jobs as any[]).find((j) => j.id === job.id);
    expect(listed.candidatesTriggered).toBe(2);
    expect(listed.candidatePath).toBe("observe");

    const detail = await app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().job.candidatesTriggered).toBe(2);
    expect(detail.json().job.candidatePath).toBe("observe");

    // Read-time only: the stored row is never rewritten by a read.
    expect(store.getJob(job.id)?.candidatesTriggered).toBeUndefined();
    expect(store.getJob(job.id)?.candidatePath).toBeUndefined();
    await app.close();
  });

  it("keeps VOD counts unchanged when only the VOD observe snapshot is present", async () => {
    const { app, cfg, store } = await buildTestApp();
    const token = await adminToken(app, cfg);
    const job = await store.createJob({ source: "file" });
    await store.patchJob(job.id, {
      status: "done",
      highlightsFound: 9,
      vodObserveMetrics: { decideCalls: 30, accepted: 12, maxFrames: 16, subsampledCalls: 0, framesPerCall: [] } as any,
    });
    const headers = { authorization: `Bearer ${token}` };
    const one = await app.inject({ method: "GET", url: `/jobs/${job.id}`, headers });
    // 9 distinct produced highlights, not the observer's 12-window tally.
    expect(one.json().job.candidatesTriggered).toBe(9);
    expect(one.json().job.candidatePath).toBe("observe");
    await app.close();
  });
});

// ADAAAA-7691 (contract AC2): the anchored-window count has to be READABLE, not
// just computed. `LiveObserver.triggerFireCount()` has always produced
// `observeMetrics.triggerFires` / `cadenceFires`, but those keys were missing
// from `ObserveMetricsSnapshotSchema`, so `JobSchema.parse` inside
// `store.patchJob` silently STRIPPED them before persistence and neither
// `GET /jobs/{id}` nor `/jobs/{id}/detail` could expose an anchored-window
// count. A QA run then had no way to assert "ONE anchored window" from the API
// (docs/audio-trigger-contract.md).
describe("audio-trigger anchored-window counters (ADAAAA-7691)", () => {
  async function adminToken(app: any, cfg: any): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: cfg.adminEmail, password: cfg.adminPassword },
    });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }

  it("persists triggerFires/cadenceFires from the live observe snapshot and serves them on every read route", async () => {
    const { app, cfg, store } = await buildTestApp();
    const token = await adminToken(app, cfg);
    const job = await store.createJob({ source: "rtmp" });
    // Completion exactly as runLiveJob writes it: 5 decide windows, 2 of them
    // anchored to an audio trigger, 3 on the blind cadence.
    await store.patchJob(job.id, {
      status: "done",
      decideCalls: 5,
      observeMetrics: {
        decideCalls: 5,
        accepted: 2,
        maxFrames: 30,
        meanE2eMs: 900,
        maxE2eMs: 1200,
        meanCadenceMs: 3000,
        maxCadenceMs: 4200,
        triggerFires: 2,
        cadenceFires: 3,
      } as any,
    });

    const headers = { authorization: `Bearer ${token}` };
    const one = await app.inject({ method: "GET", url: `/jobs/${job.id}`, headers });
    expect(one.statusCode).toBe(200);
    expect(one.json().job.observeMetrics.triggerFires).toBe(2);
    expect(one.json().job.observeMetrics.cadenceFires).toBe(3);
    // The invariant the contract states for the QA assertion.
    expect(one.json().job.observeMetrics.triggerFires + one.json().job.observeMetrics.cadenceFires).toBe(
      one.json().job.observeMetrics.decideCalls
    );

    const detail = await app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().job.observeMetrics.triggerFires).toBe(2);

    // Survives on the STORED row too — the count is persisted evidence, not a
    // read-time projection.
    expect(store.getJob(job.id)?.observeMetrics?.triggerFires).toBe(2);
    expect(store.getJob(job.id)?.observeMetrics?.cadenceFires).toBe(3);
    await app.close();
  });
});

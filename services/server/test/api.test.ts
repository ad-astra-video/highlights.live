import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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

  it("rejects a user's job when the free allowance is exhausted (402)", async () => {
    const { app, db } = await buildTestApp({ FREE_HIGHLIGHTS: "2" });
    const token = await register(app, "c@test.dev", "password123");
    db.recordUsage(db.getUserByEmail("c@test.dev")!.id, "highlight");
    db.recordUsage(db.getUserByEmail("c@test.dev")!.id, "highlight");
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

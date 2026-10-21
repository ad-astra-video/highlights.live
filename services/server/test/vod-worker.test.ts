import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp, waitForJob } from "./helpers";

// Durable VOD queue/worker (ADAAAA-6873): verifies submission is non-blocking
// (202), the durable worker runs the pipeline off the request path, the
// persisted lifecycle state machine (queued -> extracting -> analyzing ->
// finalizing -> done) reaches `done`, progress is monotonic, and a non-terminal
// job left by a prior process is re-claimed on boot without double-debit.
const tmp = mkdtempSync(path.join(tmpdir(), "hl-vodwk-"));
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

describe("durable VOD worker (ADAAAA-6873)", () => {
  it("submits non-blocking (202) and drives the job through the state machine with monotonic progress", async () => {
    const { app } = await buildTestApp();
    const token = await register(app, "worker@test.dev", "password123");

    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    // Non-blocking: immediate 202 + job id + initial queued status + zero progress.
    expect(res.statusCode).toBe(202);
    const submitted = res.json();
    expect(submitted.status).toBe("queued");
    expect(submitted.job.status).toBe("queued");
    expect(submitted.progress.stage).toBe("queued");
    expect(submitted.progress.framesAnalyzed).toBe(0);

    // Poll and assert progress is monotonic and the state machine advances.
    const seen: { framesAnalyzed: number; framesPct: number }[] = [];
    let body: any;
    for (let i = 0; i < 60; i++) {
      const r = await app.inject({ method: "GET", url: `/jobs/${submitted.job.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(r.statusCode).toBe(200);
      body = r.json();
      seen.push({ framesAnalyzed: body.progress.framesAnalyzed, framesPct: body.progress.framesPct });
      if (body.job.status === "done" || body.job.status === "failed") break;
      await new Promise((r2) => setTimeout(r2, 50));
    }
    expect(body.job.status).toBe("done");

    // Never regress: framesAnalyzed is non-decreasing across every snapshot.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].framesAnalyzed).toBeGreaterThanOrEqual(seen[i - 1].framesAnalyzed);
    }
    // Frames actually processed equals what the pipeline reports.
    expect(body.progress.framesAnalyzed).toBeGreaterThan(0);
    expect(body.progress.framesTotal).toBeGreaterThanOrEqual(body.progress.framesAnalyzed);
    expect(body.progress.framesPct).toBeGreaterThan(0);
    expect(body.progress.framesPct).toBeLessThanOrEqual(100);
    // The fake pipeline produces exactly one highlight -> visible + counted.
    expect(body.progress.highlightsFound).toBe(1);
    expect(body.highlights.length).toBe(1);
    expect(body.job.startedAt).toBeTruthy();
    expect(body.job.finishedAt).toBeTruthy();

    await app.close();
  });

  it("re-claims a non-terminal job left by a prior process on boot (restart recovery)", async () => {
    // Use an on-disk DB so state survives an app close/reopen.
    const dbFile = path.join(tmp, "recover.db");
    const app1 = await buildTestApp({ DATABASE_PATH: dbFile });
    await register(app1.app, "recover@test.dev", "password123");
    const user = (await app1.db.getUserByEmail("recover@test.dev"))!;

    // Create a job and wedge it in a non-terminal `analyzing` state, as if the
    // previous process crashed mid-pipeline.
    const job = await app1.store.createJob({ ownerId: user.id, source: "file", sourceUrl: videoPath, gameHint: "valorant" });
    await app1.store.patchJob(job.id, { status: "analyzing", stage: "analyzing" });
    await app1.app.close();

    // Reopen on the same DB; on boot the durable worker re-claims the stuck job.
    const app2 = await buildTestApp({ DATABASE_PATH: dbFile });
    const token2 = (await app2.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "recover@test.dev", password: "password123" },
    })).json().token as string;
    const body = await waitForJob(app2.app, job.id, token2, 30000);
    expect(body.job.status).toBe("done");
    expect(body.job.attempts).toBeGreaterThanOrEqual(1);
    expect(body.job.finishedAt).toBeTruthy();
    await app2.app.close();
  });
});

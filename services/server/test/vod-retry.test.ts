import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";
import { SessionLostError } from "../src/analyzer";

// ADAAAA-6763: durable server-driven retry of session-404'd VOD jobs.
//
// A VOD pass that dies on a perceive-runner/session 404 is parked into a
// retryable state on the job row and re-run by a periodic server worker with
// backoff. These tests feed a transient SessionLostError (runner down) then a
// healthy session and assert the job reaches `done` exactly once with NO
// double-persist, and that a job that never recovers fails cleanly after
// maxAttempts with the error surfaced on GET /jobs/:id.

const tmp = mkdtempSync(path.join(tmpdir(), "hl-vod-retry-"));
const videoPath = path.join(tmp, "test.mp4");

beforeAll(() => {
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=2",
    "-pix_fmt", "yuv420p", videoPath,
  ]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A controllable fake pipeline. When `degraded` is true, analyze() throws a
 * SessionLostError for every frame at/after seq 1, simulating the perceive
 * runner being down (go-livepeer released the session -> 404). Frame 0 always
 * yields a KILL candidate that decide() accepts, so the FIRST partial pass
 * persists one highlight before the failure — exactly the double-persist risk
 * a retried pass has to dedupe. */
function retryableAdapter() {
  const a: any = {
    degraded: true,
    reservePerceive: async () => ({ sessionId: "sess-it", appUrl: "", controlUrl: "" }),
    async analyze(_sid: string, frame: any) {
      // Runner down for seq >= 1: the pass persists the frame-0 highlight, then
      // the session 404s on the next frame and the job is parked retryable.
      if (frame.seq >= 1 && a.degraded) throw new SessionLostError("runner session not found (404)");
      const observation = {
        tracks: [{ trackId: "a", slot: 0, bbox: [0.1, 0.1, 0.5, 0.5], kind: "player", lostFrames: 0 }],
        seq: frame.seq,
        timestamp: frame.timestamp,
      };
      if (frame.seq === 0) {
        return { observation, candidate: { eventType: "KILL", timestamp: 0 } };
      }
      return { observation };
    },
    async decide() {
      return { isHighlight: true, score: 86, eventType: "KILL", reason: "test" };
    },
    async postAudio() {
      return null;
    },
    async controlForward() {},
    async stopPerceive() {},
  };
  return a;
}

async function register(app: any, email: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

describe("VOD server-driven retry (ADAAAA-6763)", () => {
  it("recovers a session-404'd job to done exactly once, with no double-persist", async () => {
    const adapter = retryableAdapter();
    const { app, store } = await buildTestApp({}, { adapter });
    const token = await register(app, "retry@test.dev");

    // Phase 1: perceive runner is DOWN. Submit -> first pass persists the
    // frame-0 highlight then 404s -> job is parked retryable (HTTP 202).
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.retry).toBe(true);
    expect(body.retryAttempts).toBe(1);
    expect(body.job.status).toBe("failed");
    expect(body.job.retryAttempts).toBe(1);
    const jobId = body.job.id;

    // Phase 1 persisted exactly one highlight (the frame-0 KILL).
    expect(store.highlightsForJob(jobId).length).toBe(1);

    // Phase 2: runner is HEALTHY again. Make the job due now, then drive the
    // server worker sweep.
    adapter.degraded = false;
    await store.patchJob(jobId, { nextRetryAt: new Date(Date.now() - 1000).toISOString() });
    const ran = await (app as any).vodRetryWorker.tick();
    expect(ran).toBeGreaterThanOrEqual(1);

    const job = store.getJob(jobId)!;
    expect(job.status).toBe("done");
    // No double-persist: the frame-0 highlight from the failed first pass was
    // deduped (deterministic id) and NOT re-persisted or re-billed.
    expect(store.highlightsForJob(jobId).length).toBe(1);
    // Retry watermark cleared on success.
    expect(job.retryAttempts).toBe(0);
    expect(job.lastError).toBeUndefined();

    await app.close();
  });

  it("fails cleanly after maxAttempts and surfaces lastError on GET /jobs/:id", async () => {
    const adapter = retryableAdapter();
    // maxAttempts=2: the initial run (attempt 1) is retryable; the single
    // worker retry that fails again is permanently failed.
    const { app, store } = await buildTestApp({ VOD_RETRY_MAX_ATTEMPTS: "2" }, { adapter });
    const token = await register(app, "dead@test.dev");

    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(res.statusCode).toBe(202);
    const jobId = res.json().job.id;

    // Runner still DOWN. Drive the worker -> this retry fails; since it is the
    // 2nd attempt it is permanently failed (no further retry window).
    await store.patchJob(jobId, { nextRetryAt: new Date(Date.now() - 1000).toISOString() });
    await (app as any).vodRetryWorker.tick();

    const job = store.getJob(jobId)!;
    expect(job.status).toBe("failed");
    expect(job.retryAttempts).toBe(2);
    expect(job.maxRetryAttempts).toBe(2);
    expect(job.nextRetryAt).toBeUndefined();
    expect(job.lastError).toContain("runner session not found");

    // The failure is surfaced to the user via GET /jobs/:id.
    const view = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    expect(view.statusCode).toBe(200);
    const vj = view.json().job;
    expect(vj.status).toBe("failed");
    expect(vj.lastError).toContain("runner session not found");
    expect(vj.maxRetryAttempts).toBe(2);

    await app.close();
  });
});

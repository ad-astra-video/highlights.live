import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp, waitForJob, fakePipeline } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(path.join(tmpdir(), "hl-voderr-"));
const videoPath = path.join(tmp, "vod.mp4");

beforeAll(() => {
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x180:rate=2",
    "-pix_fmt", "yuv420p", videoPath,
  ]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function register(app: any, email: string, pw: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

// B.6 (ADAAAA-6781): a failed VOD job must persist the server-side error text
// on the job row and expose it through GET /jobs/:id and GET /jobs so the
// webapp can render the real reason instead of the generic client string.
describe("VOD job failure persists + surfaces server error text (ADAAAA-6781)", () => {
  it("marks the job failed and records the thrown error in GET /jobs/:id and GET /jobs", async () => {
    const failing = fakePipeline();
    // The mid-run analyze pipeline throws with a realistic server-side message
    // (e.g. unsupported video content that survived the 415 gate).
    (failing as any).analyze = async () => {
      throw new Error("mock: unsupported video content (B.6)");
    };
    const { app } = await buildTestApp({}, { adapter: failing });
    const token = await register(app, "vod-err@test.dev", "password123");

    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(res.statusCode).toBe(202);
    const jobId = res.json().job.id as string;

    const done = await waitForJob(app, jobId, token);
    expect(done.job.status).toBe("failed");
    // The real server-side error text is persisted, not null.
    expect(done.job.error).toBeTruthy();
    expect(done.job.error).toContain("mock: unsupported video content (B.6)");

    // GET /jobs/:id exposes the exact error text.
    const jobRes = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(jobRes.statusCode).toBe(200);
    expect(jobRes.json().job.error).toContain("mock: unsupported video content (B.6)");

    // GET /jobs list also exposes it on the row.
    const list = await app.inject({
      method: "GET",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
    });
    const row = (list.json().jobs as any[]).find((j) => j.id === jobId);
    expect(row).toBeTruthy();
    expect(row.status).toBe("failed");
    expect(row.error).toContain("mock: unsupported video content (B.6)");
  });

  it("truncates a very long error message to the 500-char cap", async () => {
    const failing = fakePipeline();
    (failing as any).analyze = async () => {
      throw new Error("x".repeat(2000));
    };
    const { app, store } = await buildTestApp({}, { adapter: failing });
    const token = await register(app, "vod-trunc@test.dev", "password123");

    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(res.statusCode).toBe(202);
    const jobId = res.json().job.id as string;

    const done = await waitForJob(app, jobId, token);
    expect(done.job.status).toBe("failed");
    expect(done.job.error!.length).toBe(500);
  });
});

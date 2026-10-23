import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A capacity-1 perceive runner: a slot is either held (one session) or free.
// reservePerceive throws a 503-like error when the slot is still held, exactly
// like the orchestrator's "no capacity available for runner". stopPerceive(sid)
// releases only the session that currently holds the slot (so releasing an old
// session after a re-reserve is a no-op, matching the real orchestrator).
function capacityAdapter(analyzeDelayMs = 1500) {
  const state = {
    current: null as string | null, // session id currently holding the slot
    reserveCount: 0, // successful reserves only
    stopCount: 0, // times stopPerceive was invoked
  };
  const adapter = {
    state,
    async reservePerceive() {
      if (state.current) {
        throw new Error("reserve perceive failed: HTTP 503 no capacity available for runner");
      }
      const sid = `sess-${++state.reserveCount}`;
      state.current = sid;
      return { sessionId: sid, appUrl: "", controlUrl: "" };
    },
    async analyze() {
      // Simulate the in-flight GPU /analyze that used to keep the slot held
      // after a stop until the pipeline's `finally` released it (pre-fix).
      await sleep(analyzeDelayMs);
      return { observation: { tracks: [], seq: 0, timestamp: 0 } };
    },
    async decide() {
      return { isHighlight: false, score: 0, eventType: "" };
    },
    async plan() {
      return {
        planVersion: 1,
        category: "soccer",
        intent: "",
        source: "planner-fallback",
        maxTracks: 3,
        targets: [{ label: "player", role: "player" }],
        reason: "test",
      };
    },
    async train() {
      return { run: "x", checkpoint: "/x" };
    },
    async postAudio() {
      return { candidate: null, series: [] };
    },
    async controlForward() {},
    async stopPerceive(sessionId: string) {
      state.stopCount++;
      if (state.current === sessionId) state.current = null;
    },
  };
  return adapter;
}

describe("perceive slot released promptly on job-stop (ADAAAA-6561)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hl-slot-release-"));
  const liveSrc = path.join(tmp, "live.mp4");

  beforeAll(() => {
    // A file-sim source that ffmpeg loops at real-time rate, so the live job
    // keeps streaming until explicitly stopped.
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x180:rate=10",
      "-pix_fmt", "yuv420p", liveSrc,
    ]);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  async function register(app: any): Promise<string> {
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "slot@test.dev", password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    return reg.json().token as string;
  }

  async function startLive(app: any, token: string) {
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "file-sim", videoPath: liveSrc, gameHint: "Esports" },
    });
    expect(jr.statusCode).toBe(200);
    return jr.json().job.id as string;
  }

  it("releases the perceive slot on stop so a live job started right after does not 503", async () => {
    const adapter = capacityAdapter();
    const { app } = await buildTestApp({}, { adapter });
    const token = await register(app);

    // Job A reserves the single perceive slot and starts analyzing.
    const jobA = await startLive(app, token);
    const deadline = Date.now() + 8000;
    while (adapter.state.reserveCount < 1 && Date.now() < deadline) await sleep(50);
    expect(adapter.state.reserveCount).toBe(1);
    expect(adapter.state.current).not.toBeNull();

    // Stop job A. With the ADAAAA-6561 fix the stop path releases the perceive
    // slot SYNCHRONOUSLY (not waiting for the in-flight /analyze's `finally`),
    // so the slot is free the moment the stop response returns.
    const st = await app.inject({
      method: "POST",
      url: `/jobs/${jobA}/stop`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(st.statusCode).toBe(200);
    // The stop path must have released the slot before returning.
    expect(adapter.state.current).toBeNull();
    expect(adapter.state.stopCount).toBeGreaterThanOrEqual(1);

    // Start job B immediately after the stop — it must re-reserve without a 503.
    const jobB = await startLive(app, token);
    // Wait for B's async reserve to run inside runLiveJob.
    const bDeadline = Date.now() + 8000;
    while (adapter.state.reserveCount < 2 && Date.now() < bDeadline) await sleep(50);
    expect(adapter.state.reserveCount).toBe(2);

    // B must settle as ingesting/active, never failed (a 503 reserve -> failed).
    let bStatus = "ingesting";
    const sDeadline = Date.now() + 8000;
    while (Date.now() < sDeadline) {
      const job = (await app.inject({ method: "GET", url: `/jobs/${jobB}`, headers: { authorization: `Bearer ${token}` } })).json();
      bStatus = job.job?.status ?? "ingesting";
      if (bStatus === "done" || bStatus === "failed") break;
      await sleep(200);
    }
    expect(bStatus).not.toBe("failed");

    // Tear down job B.
    await app.inject({ method: "POST", url: `/jobs/${jobB}/stop`, headers: { authorization: `Bearer ${token}` }, payload: {} });
    await app.close();
  });

  it("does not re-reserve a fresh perceive session once the job is stopped", async () => {
    // Unit-level guard (ADAAAA-6561): once the stop path has released the slot,
    // the in-flight /analyze fails as session-lost, and analyzeJob must NOT
    // re-bind a fresh capacity-1 session to a job that is already stopping.
    const { analyzeJob, SessionLostError } = await import("../src/analyzer");
    const log: string[] = [];
    let stopped = false;
    const client: any = {
      reservePerceive: async () => {
        log.push("reserve");
        return { sessionId: "sess-x", appUrl: "", controlUrl: "" };
      },
      analyze: async () => {
        log.push("analyze");
        // The stop path released the slot mid-analyze, so the job is stopped
        // and the in-flight analyze now fails as session-lost.
        stopped = true;
        throw new SessionLostError("session lost");
      },
      decide: async () => ({ isHighlight: false, score: 0, eventType: "" }),
      plan: async () => ({ planVersion: 1, category: "soccer", intent: "", source: "x", maxTracks: 3, targets: [], reason: "t" }),
      train: async () => ({ run: "x", checkpoint: "/x" }),
      postAudio: async () => ({ candidate: null, series: [] }),
      controlForward: async () => {},
      stopPerceive: async () => {
        log.push("stop");
      },
    };
    async function* frames(n: number) {
      for (let i = 0; i < n; i++) yield { seq: i, timestamp: i, imageB64: `img${i}` };
    }
    await analyzeJob(
      client,
      frames(3),
      async () => ({ clipId: "c", clipUri: "/c.mp4" , hasAudio: true }),
      { jobId: "job-x", clipBeforeS: 1, clipAfterS: 1, gameHint: "", maxReReserves: 3 },
      undefined,
      undefined,
      undefined,
      { onReserve: () => {}, isStopped: () => stopped }
    );
    // Exactly one reserve (the initial) and NO re-reserve despite the
    // session-lost, and the session is still released in `finally`.
    expect(log.filter((l) => l === "reserve").length).toBe(1);
    expect(log).toContain("stop");
  });
});

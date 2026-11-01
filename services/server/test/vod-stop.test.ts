import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";
import { SessionLostError } from "../src/analyzer";

// ADAAAA-6625: `POST /jobs/:id/stop` must cancel a VOD `file` job through the
// API — no container restart, no stale non-terminal row, no leaked perceive
// session. The local hand-off bar for the build is:
//   1. a `source:file` job driven to stop reaches a TERMINAL status without a
//      container restart (asserted here through the real HTTP route),
//   2. zero rows left at a non-terminal status for that job,
//   3. the held perceive session is released in the SAME commit as the route.
// On-box GPU verification (GPU% -> 0, no further burst writes) is the deferred
// AC tracked on the issue; it needs the box, not this build.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deterministic stand-in for the orchestrator's capacity-1 perceive runner.
 *
 * `/analyze` is HELD open (the pass is genuinely in flight, as with a real GPU
 * call) until `stopPerceive` releases the session; the in-flight call then
 * fails session-lost, which is exactly what go-livepeer does when a session is
 * stopped mid-call and what analyzeJob's stop path reacts to.
 */
function stoppableAdapter() {
  const state = {
    current: null as string | null,
    reserveCount: 0,
    stopCount: 0,
    analyzeCalls: 0,
    stopped: [] as string[],
  };
  let release: (() => void) | null = null;
  return {
    state,
    async reservePerceive() {
      const sid = `sess-${++state.reserveCount}`;
      state.current = sid;
      return { sessionId: sid, appUrl: "", controlUrl: "" };
    },
    async analyze(sessionId: string) {
      state.analyzeCalls++;
      await new Promise<void>((r) => {
        release = r;
      });
      if (state.current !== sessionId || state.stopped.includes(sessionId)) {
        throw new SessionLostError(`session ${sessionId} lost`);
      }
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
      state.stopped.push(sessionId);
      if (state.current === sessionId) state.current = null;
      // The orchestrator releases the session: the held /analyze now fails.
      release?.();
      release = null;
    },
  };
}

describe("VOD file job stop/cancel route (ADAAAA-6625)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hl-vod-stop-"));
  const videoPath = path.join(tmp, "test.mp4");

  beforeAll(() => {
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=1",
      "-pix_fmt", "yuv420p", videoPath,
    ]);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  async function register(app: any, email: string): Promise<string> {
    const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }

  async function getJob(app: any, jobId: string, token: string) {
    const r = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(200);
    return r.json();
  }

  /** Raw `jobs` table status — the durable column the orphan/stale-row AC is
   * about, not just the in-memory record projection. */
  function rawStatus(db: any, jobId: string): string | undefined {
    const row = db.db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId);
    return row?.status as string | undefined;
  }

  it("stops an in-flight source:file job: terminal `cancelled`, perceive released, no further frames", async () => {
    const adapter = stoppableAdapter();
    const t = await buildTestApp({}, { adapter });
    const token = await register(t.app, "stop-flight@test.dev");

    const sub = await t.app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "soccer" },
    });
    // Durable non-blocking submit: the worker runs the pass off the request path.
    expect(sub.statusCode).toBe(202);
    const jobId = sub.json().job.id as string;

    // Wait until the pass genuinely holds a perceive session and is mid-frame.
    const deadline = Date.now() + 15000;
    while (adapter.state.analyzeCalls < 1 && Date.now() < deadline) await sleep(25);
    expect(adapter.state.analyzeCalls).toBeGreaterThanOrEqual(1);
    expect(adapter.state.current).not.toBeNull();
    expect(["extracting", "analyzing"]).toContain((await getJob(t.app, jobId, token)).job.status);
    const callsAtStop = adapter.state.analyzeCalls;
    const sessionAtStop = adapter.state.current as string;

    // THE AC: stop through the API, no container restart.
    const st = await t.app.inject({
      method: "POST",
      url: `/jobs/${jobId}/stop`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(st.statusCode).toBe(200);
    const stopBody = st.json();
    expect(stopBody.cancelled).toBe(true);
    // The row is terminal the moment the response lands.
    expect(stopBody.job.status).toBe("cancelled");
    // Held perceive session released synchronously (same response).
    expect(stopBody.releasedPerceiveSessions).toContain(sessionAtStop);
    expect(adapter.state.current).toBeNull();
    expect(adapter.state.stopCount).toBeGreaterThanOrEqual(1);

    // Job row: terminal, no error, no stale non-terminal status — in the record
    // AND in the durable `jobs.status` column.
    const body = await getJob(t.app, jobId, token);
    expect(body.job.status).toBe("cancelled");
    expect(body.job.stage).toBe("cancelled");
    expect(body.job.error).toBeUndefined();
    expect(body.job.finishedAt).toBeTruthy();
    expect(rawStatus(t.db, jobId)).toBe("cancelled");
    const liveRows = (t.db as any).db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE id = ? AND status IN ('queued','active','extracting','analyzing','finalizing')"
      )
      .get(jobId);
    expect(liveRows.n).toBe(0);

    // No further frame work after the stop returns: analyzeJob unwinds on the
    // next frame and the worker finalizes as cancelled, never `done`/`failed`.
    await sleep(300);
    expect(adapter.state.analyzeCalls).toBe(callsAtStop);
    const settled = await getJob(t.app, jobId, token);
    expect(settled.job.status).toBe("cancelled");

    // The stop is idempotent: a retry does not regress the terminal row.
    const again = await t.app.inject({
      method: "POST",
      url: `/jobs/${jobId}/stop`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadyTerminal).toBe(true);
    expect((await getJob(t.app, jobId, token)).job.status).toBe("cancelled");

    await t.app.close();
  });

  it("reconciles an orphaned non-terminal row (restart survivor) with no in-flight promise", async () => {
    // The ADAAAA-6571 incident: a container restart dropped the in-flight
    // runVodJob promise and left a stale `status=active` row. Stop must cancel
    // that orphan too (the old route 409'd because no perceive slot was held),
    // releasing the recorded perceive session and clearing the media row.
    const adapter = stoppableAdapter();
    const t = await buildTestApp({}, { adapter });
    const token = await register(t.app, "orphan@test.dev");
    const user = (await t.db.getUserByEmail("orphan@test.dev"))!;

    const orphan = await t.store.createJob({ ownerId: user.id, source: "file", sourceUrl: videoPath, gameHint: "soccer" });
    await t.store.patchJob(orphan.id, { status: "active", perceiveSessionId: "sess-orphan" });
    await t.db.setMediaSession({
      jobId: orphan.id,
      sessionId: "media-orphan",
      streamId: "stream-orphan",
      wsUrl: "ws://media.local/x",
      mediaOrigin: "http://media.local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const st = await t.app.inject({
      method: "POST",
      url: `/jobs/${orphan.id}/stop`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(st.statusCode).toBe(200);
    expect(st.json().cancelled).toBe(true);
    expect(st.json().releasedPerceiveSessions).toContain("sess-orphan");
    expect(adapter.state.stopped).toContain("sess-orphan");
    expect(rawStatus(t.db, orphan.id)).toBe("cancelled");
    // Orphan session reconciled: no media_sessions row survives at active.
    expect(await t.db.getMediaSession(orphan.id)).toBeUndefined();

    // A queued job that the worker has not claimed is cancellable too.
    const queued = await t.store.createJob({ ownerId: user.id, source: "file", sourceUrl: videoPath });
    const qs = await t.app.inject({
      method: "POST",
      url: `/jobs/${queued.id}/stop`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(qs.statusCode).toBe(200);
    expect(qs.json().job.status).toBe("cancelled");
    expect(rawStatus(t.db, queued.id)).toBe("cancelled");
    // Never started: no perceive session was reserved for the cancelled queued job.
    expect(adapter.state.reserveCount).toBe(0);
    expect(adapter.state.analyzeCalls).toBe(0);

    await t.app.close();
  });

  it("never downgrades a completed job: stop on a done row is an idempotent no-op", async () => {
    const adapter = stoppableAdapter();
    const t = await buildTestApp({}, { adapter });
    const token = await register(t.app, "stop-done@test.dev");
    const user = (await t.db.getUserByEmail("stop-done@test.dev"))!;

    const done = await t.store.createJob({ ownerId: user.id, source: "file", sourceUrl: videoPath });
    await t.store.patchJob(done.id, { status: "done", finishedAt: new Date().toISOString() });

    const st = await t.app.inject({
      method: "POST",
      url: `/jobs/${done.id}/stop`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(st.statusCode).toBe(200);
    expect(st.json().alreadyTerminal).toBe(true);
    expect(rawStatus(t.db, done.id)).toBe("done");

    await t.app.close();
  });

  it("still rejects a non-file job that has no stoppable session", async () => {
    const adapter = stoppableAdapter();
    const t = await buildTestApp({}, { adapter });
    const token = await register(t.app, "stop-other@test.dev");
    const user = (await t.db.getUserByEmail("stop-other@test.dev"))!;
    const rtmp = await t.store.createJob({ ownerId: user.id, source: "rtmp", sourceUrl: "rtmp://example/x" });

    const st = await t.app.inject({
      method: "POST",
      url: `/jobs/${rtmp.id}/stop`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(st.statusCode).toBe(409);
    expect(st.json().error).toMatch(/not a live ingest or browser capture/);

    await t.app.close();
  });
});

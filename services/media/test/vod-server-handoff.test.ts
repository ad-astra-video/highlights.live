// ADAAAA-6895 Phase 1b — server-side VOD handoff. Wires a REAL MediaServer
// `POST /jobs/vod` to a REAL buildTestApp server to prove that when
// MEDIA_SERVER_URL is configured, the main server hands the VOD job to the media
// node (which runs ffmpeg + perceive session + per-candidate decide + clip cut)
// and stays a pure negotiator/persister: it persists the media-reported
// highlight + clip URI + stageAMetrics + costUsd + perceiveSessionId, reaches
// `status: done` on the final `cost` completion event, and NEVER runs ffmpeg or
// reserves a perceive session itself (asserted via the injected adapter spy).
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MediaServer } from "../src/server";
import type { ProvisionedSession } from "../src/orch";
import { buildTestApp } from "../../server/test/helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (s: Server) =>
  new Promise<string>((res) => s.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(s.address() as any).port}`)));

/** Fake Orchestrator that emits a candidate for EVERY published frame (so the
 *  media VOD pass is deterministic: >=1 candidate -> decide -> highlight). */
class FakeCandidateOrch {
  obsBySeq = new Map<number, any>();
  provisioned: ProvisionedSession = {
    sessionId: "sess-handoff",
    appUrl: "http://fake",
    controlUrl: "http://fake",
    videoIn: "http://orch/ai/trickle/sess-handoff-video-in",
    eventsOut: "http://orch/ai/trickle/sess-handoff-events-out",
    control: "http://orch/ai/trickle/sess-handoff-control",
  };
  closed: string[] = [];
  constructor(public sid = "sess-handoff") { this.provisioned.sessionId = sid; }
  async provision() { return this.provisioned; }
  startPayment() {}
  stopPayment() {}
  async releaseSession(s: string) { this.closed.push(s); }
  async closeSession() {}
  async publishFrame(p: ProvisionedSession, seq: number, _jpeg: Uint8Array, ts: number) {
    this.obsBySeq.set(seq, {
      type: "candidate", sessionId: p.sessionId, seq, timestamp: ts, eventType: "GOAL",
      audio: { kind: "burst", ts, firedAt: ts + 0.3, onsetLatencyS: 0.8, peakEnergy: 0.6, baselineEnergy: 0.1 },
    });
    return 200;
  }
  async readObservation(_p: ProvisionedSession, seq: number) { return this.obsBySeq.get(seq) ?? null; }
}

function makeDecideRunner(accepted: boolean) {
  let calls = 0;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/app/highlight")) {
      calls += 1; req.resume(); req.on("end", () => {
        res.end(JSON.stringify(accepted
          ? { isHighlight: true, score: 88, eventType: "GOAL", reason: "goal in box", outcome: "scoring_play" }
          : { isHighlight: false, score: 12, reason: "no highlight", outcome: "not_highlight" }));
      });
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
  return { server, calls: () => calls };
}

/** Create a real short MP4 that the media node can frame-extract. */
function makeMp4(p: string): void {
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=15", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", p]);
}

describe("Phase 1b server-side VOD handoff (ADAAAA-6895)", () => {
  let servers: Server[] = [];
  let app: FastifyInstance | null = null;
  let mediaApp: FastifyInstance | null = null;
  afterEach(async () => {
    if (mediaApp) { try { await mediaApp.close(); } catch { /* ignore */ } mediaApp = null; }
    if (app) { try { await app.close(); } catch { /* ignore */ } app = null; }
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    servers = [];
  });

  it("hands a VOD file job to the media server; persists highlights/cost/session and reaches done without the server running ffmpeg or reserving a session", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "hl-handoff-"));
    const clipsDir = path.join(tmp, "clips");
    const mp4 = path.join(tmp, "src.mp4");
    makeMp4(mp4);

    // Fake Gemma decide runner (accepted verdict) — the MEDIA node fires decide.
    const decide = makeDecideRunner(true);
    const decideBase = await listen(decide.server);
    servers.push(decide.server);

    // 1) Build the REAL server (in-memory DB) and bind it so the media node can
    //    POST result events back over the callback.
    const adapterSpy: any = buildTestAppOpts();
    const built = await buildTestApp({}, { adapter: adapterSpy });
    app = built.app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const serverBase = `http://127.0.0.1:${(app.server.address() as any).port}`;

    // 2) Build a REAL MediaServer whose callback maps onto the server's observe
    //    route, and point the server's cfg.mediaServerUrl at it.
    const ms = new MediaServer({
      orchBase: "http://orch",
      callbackBase: serverBase,
      decideUrl: decideBase,
      decideAuthToken: "test-secret",
      reconnectGraceMs: 60_000,
      tmpDir: tmp,
      clipsDir,
      clipBeforeS: 1,
      clipAfterS: 2,
      decideFee: 0.05,
      perceivePerHourUsd: 0.1,
      ffmpegPath: "ffmpeg",
    } as any, new FakeCandidateOrch("sess-handoff") as any);
    mediaApp = await ms.build();
    await mediaApp.listen({ port: 0, host: "127.0.0.1" });
    const mediaBase = `http://127.0.0.1:${(mediaApp.server.address() as any).port}`;
    built.cfg.mediaServerUrl = mediaBase;

    // 3) Register a user and submit a VOD `file` job.
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "handoff@test.dev", password: "password123" } });
    const token = reg.json().token;
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "file", videoPath: mp4, gameHint: "Esports" },
    });
    expect(jr.statusCode).toBe(202);
    const submit = jr.json();
    const jobId = submit.job.id;
    // Media-served jobs are `active` immediately (not `queued` for a local worker).
    expect(submit.status).toBe("active");

    // 4) Poll until the media node's final `cost` completion event lands -> done.
    let body: any = null;
    const dl = Date.now() + 20000;
    while (Date.now() < dl) {
      const got = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
      body = got.json();
      if (body?.job?.status === "done" || body?.job?.status === "failed") break;
      await sleep(150);
    }

    // The media node actually ran the VOD pass (decide fired on the media side).
    expect(decide.calls()).toBeGreaterThan(0);
    // The job reached `done` via the media-reported cost completion event.
    expect(body.job.status).toBe("done");
    // Media-reported cost + perceive session id + stage-A metrics are on the job.
    expect(typeof body.job.costUsd).toBe("number");
    expect(body.job.costUsd).toBeGreaterThan(0);
    expect(body.job.perceiveSessionId).toBe("sess-handoff");
    expect(body.job.stageAMetrics?.totalCandidates).toBeGreaterThan(0);
    // A highlight (with a real clip URI) was reported by the media node and
    // persisted by the server.
    expect(Array.isArray(body.highlights)).toBe(true);
    expect(body.highlights.length).toBeGreaterThan(0);
    const hl = body.highlights[0];
    expect(hl.eventType).toBe("GOAL");
    expect(hl.clipUri).toMatch(/^\/clips\/[0-9a-f-]+\.mp4$/);
    // The clip is a real file on the media node.
    const clipName = hl.clipUri.split("/").pop()!;
    expect(existsSync(path.join(clipsDir, clipName))).toBe(true);

    // ACCEPTANCE CHECK: the server did NOT reserve a perceive session on the
    // media-served path (no runVodJob / reservePerceive / ffmpeg call in-server).
    expect(adapterSpy.reserveCount).toBe(0);
  });

  it("falls back to the legacy in-process worker when MEDIA_SERVER_URL is unset", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "hl-handoff-worker-"));
    const mp4 = path.join(tmp, "src.mp4");
    makeMp4(mp4);

    const adapterSpy: any = buildTestAppOpts();
    // No MEDIA_SERVER_URL -> the runVodJob worker path is used.
    const built = await buildTestApp({}, { adapter: adapterSpy });
    app = built.app;

    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "worker@test.dev", password: "password123" } });
    const token = reg.json().token;
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "file", videoPath: mp4, gameHint: "Esports" },
    });
    expect(jr.statusCode).toBe(202);
    const jobId = jr.json().job.id;

    let body: any = null;
    const dl = Date.now() + 20000;
    while (Date.now() < dl) {
      const got = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
      body = got.json();
      if (body?.job?.status === "done" || body?.job?.status === "failed") break;
      await sleep(150);
    }
    // The in-process worker path reserved a perceive session (runVodJob ran).
    expect(adapterSpy.reserveCount).toBeGreaterThan(0);
    expect(["done", "failed"]).toContain(body.job.status);
  });
});

/** A fake pipeline adapter that records reservePerceive calls, so the test can
 *  assert the server either did NOT reserve (media path) or DID (worker path). */
function buildTestAppOpts(): any {
  const adapter = {
    reserveCount: 0,
    stopCount: 0,
    async reservePerceive() {
      (this as any).reserveCount++;
      return { sessionId: "sess-it", appUrl: "", controlUrl: "" };
    },
    async stopPerceive() { (this as any).stopCount++; },
    async analyze() { return { observation: { tracks: [{ trackId: "a", slot: 0, bbox: [0.1, 0.1, 0.5, 0.5], kind: "player", lostFrames: 0 }], seq: 0, timestamp: 0 } }; },
    async decide() { return { isHighlight: true, score: 86, eventType: "KILL", reason: "test" }; },
    async plan(_req: any) { return { planVersion: 1, category: "soccer", intent: "", source: "planner-fallback", maxTracks: 3, targets: [{ label: "player", role: "player" }], reason: "test" }; },
    async train(_req: any) { return { run: "train-smoke", checkpoint: "/runs/train-smoke/model.safetensors", epochs: 5, samples: 2, eval: { eval: "completed", precision: 0.91, recall: 0.88, f1: 0.895 } }; },
  };
  return adapter;
}

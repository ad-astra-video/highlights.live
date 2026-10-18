// ADAAAA-6865 true-integration: real MediaServer -> real server POST /jobs/:id/observe
// Verifies a media-served candidate yields an end-to-end highlight (candidate ->
// decide -> highlight -> clip URI) REPORTED TO and PERSISTED BY the server, with
// decide fired by the media server. Uses real ffmpeg for the clip; the Orchestrator
// candidate signal and the Gemma decide runner are faked (no live Orchestrator reachable).
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MediaServer } from "../src/server";
import type { ProvisionedSession } from "../src/orch";
import { buildTestApp } from "../../server/test/helpers";

const wsConnect = (url: string) =>
  new Promise<WebSocket>((res, rej) => {
    const ws = new WebSocket(url);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (s: Server) =>
  new Promise<string>((res) => s.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(s.address() as any).port}`)));

class FakeCandidateOrch {
  obsBySeq = new Map<number, any>();
  provisioned: ProvisionedSession = {
    sessionId: "sess-int",
    appUrl: "http://fake",
    controlUrl: "http://fake",
    videoIn: "http://orch/ai/trickle/sess-int-video-in",
    eventsOut: "http://orch/ai/trickle/sess-int-events-out",
    control: "http://orch/ai/trickle/sess-int-control",
  };
  closed: string[] = [];
  constructor(public sid = "sess-int") { this.provisioned.sessionId = sid; }
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

function makeMp4(tmp: string): Buffer {
  const src = path.join(tmp, "src.mp4");
  execFileSync("ffmpeg", ["-y","-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=160x90:rate=15","-t","3","-c:v","libx264","-pix_fmt","yuv420p",src]);
  return readFileSync(src);
}

describe("Phase 0 true integration: real MediaServer -> real server /observe (ADAAAA-6865)", () => {
  let servers: Server[] = [];
  let app: FastifyInstance | null = null;
  let mediaApp: FastifyInstance | null = null;
  let ws: WebSocket | null = null;
  afterEach(async () => {
    try { ws?.close(); } catch { /* ignore */ }
    if (mediaApp) { try { await mediaApp.close(); } catch { /* ignore */ } mediaApp = null; }
    if (app) { try { await app.close(); } catch { /* ignore */ } app = null; }
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    servers = [];
  });

  it("media-served candidate -> media-server decide -> highlight + clip URI persisted by the server", async () => {
    // Real server (in-memory DB).
    const built = await buildTestApp();
    app = built.app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const serverBase = `http://127.0.0.1:${(app.server.address() as any).port}`;

    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "int@test.dev", password: "password123" } });
    const token = reg.json().token;
    const jr = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload: { source: "browser", gameHint: "Esports" } });
    expect(jr.statusCode).toBe(200);
    const jobId = jr.json().job.id;

    // Fake Gemma decide runner (accepted verdict).
    const decide = makeDecideRunner(true);
    const decideBase = await listen(decide.server);
    servers.push(decide.server);

    // Real MediaServer whose callback maps onto the REAL server's observe route.
    const tmp = mkdtempSync(path.join(tmpdir(), "hl-int-"));
    const clipsDir = path.join(tmp, "clips");
    const ms = new MediaServer({
      orchBase: "http://orch",
      callbackBase: serverBase,
      decideUrl: decideBase,
      decideAuthToken: "test-secret",
      reconnectGraceMs: 60_000,
      tmpDir: tmp,
      clipsDir,
      clipBeforeS: 1, clipAfterS: 2,
      decideFee: 0.05, perceivePerHourUsd: 0.1,
      ffmpegPath: "ffmpeg",
    } as any, new FakeCandidateOrch("sess-int") as any);
    mediaApp = await ms.build();
    await mediaApp.listen({ port: 0, host: "127.0.0.1" });
    const mediaBase = `http://127.0.0.1:${(mediaApp.server.address() as any).port}`;

    // Open a media stream for the SAME jobId the server owns.
    const prov = await mediaApp.inject({ method: "POST", url: "/sessions", payload: { jobId } });
    expect(prov.statusCode).toBe(200);
    const sid = prov.json().sessionId;
    ws = await wsConnect(`${mediaBase.replace("http", "ws")}/stream/${sid}`);

    // Feed a real MP4 recording + one frame -> fake orch publishes a candidate.
    const srcBuf = makeMp4(tmp);
    ws.send(JSON.stringify({ type: "media", mime: "video/mp4", seq: 0, timestamp: 0, data: srcBuf.toString("base64") }));
    const recPath = path.join(tmp, `${sid}.mp4`);
    let dl = Date.now() + 5000;
    while (Date.now() < dl && !(existsSync(recPath) && statSync(recPath).size >= srcBuf.length)) await sleep(50);
    ws.send(JSON.stringify({ seq: 7, image: Buffer.from("fake-jpeg").toString("base64"), timestamp: 1.5 }));

    // Wait for the server to persist a highlight for the job.
    let body: any = null;
    dl = Date.now() + 12000;
    while (Date.now() < dl) {
      const got = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
      body = got.json();
      if (Array.isArray(body?.highlights) && body.highlights.length > 0) break;
      await sleep(200);
    }

    // Exactly one per-candidate decide fired by the media server.
    expect(decide.calls()).toBe(1);
    // A highlight was reported to and persisted by the server.
    expect(Array.isArray(body?.highlights)).toBe(true);
    expect(body.highlights.length).toBeGreaterThan(0);
    const hl = body.highlights[0];
    expect(hl.eventType).toBe("GOAL");
    expect(hl.score).toBe(88);
    expect(hl.clipUri).toMatch(/^\/clips\/[0-9a-f-]+\.mp4$/);
    // The clip is a real file on the media node and fetchable via /clips.
    const clipName = hl.clipUri.split("/").pop()!;
    const f = path.join(clipsDir, clipName);
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).size).toBeGreaterThan(0);
    const clipRes = await mediaApp.inject({ method: "GET", url: `/clips/${clipName}` });
    expect(clipRes.statusCode).toBe(200);
    expect(clipRes.rawPayload.length).toBeGreaterThan(0);
    // Server persisted stage-A metrics + cost on the job record.
    expect(body.job.stageAMetrics?.totalCandidates).toBe(1);
    expect(typeof body.job.costUsd).toBe("number");
  });
});

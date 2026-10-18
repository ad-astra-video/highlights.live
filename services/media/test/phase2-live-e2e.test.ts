// ADAAAA-6867 Phase 2 true-integration: real server -> real MediaServer live
// push/screen handoff -> media-node ingest/decide -> highlight + clip URI
// persisted by the server -> POST /jobs/:id/stop tears down on the media node.
// The MediaServer is real; only the Orchestrator candidate signal, the Gemma
// decide runner, and the ffmpeg child are faked (the ffmpeg ingest itself is
// exercised by live-ingest.test.ts). Verifies the WHOLE Phase 2 acceptance
// criterion at the integrated level: a live job ingests + clips on the media
// node and stop tears it down there.
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { MediaServer } from "../src/server";
import type { ProvisionedSession } from "../src/orch";
import type { MediaLiveSpec } from "../src/live";
import { buildTestApp } from "../../server/test/helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (s: Server) =>
  new Promise<string>((res) => s.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(s.address() as any).port}`)));

class FakeCandidateOrch {
  obsBySeq = new Map<number, any>();
  provisioned: ProvisionedSession = {
    sessionId: "sess-live2",
    appUrl: "http://fake",
    controlUrl: "http://fake",
    videoIn: "http://orch/ai/trickle/sess-live2-video-in",
    eventsOut: "http://orch/ai/trickle/sess-live2-events-out",
    control: "http://orch/ai/trickle/sess-live2-control",
  };
  released: string[] = [];
  paymentStops = 0;
  audioChunks: any[] = [];
  async provision() { return this.provisioned; }
  startPayment() {}
  stopPayment() { this.paymentStops++; }
  async releaseSession(s: string) { this.released.push(s); }
  async closeSession() {}
  async publishFrame(_p: ProvisionedSession, seq: number, _j: Uint8Array, ts: number) {
    this.obsBySeq.set(seq, {
      type: "candidate", sessionId: "sess-live2", seq, timestamp: ts, eventType: "GOAL",
      audio: { kind: "burst", ts, firedAt: ts + 0.3, onsetLatencyS: 0.8, peakEnergy: 0.6, baselineEnergy: 0.1 },
    });
    return 200;
  }
  async readObservation(_p: ProvisionedSession, seq: number) { return this.obsBySeq.get(seq) ?? null; }
  async postAudio(_p: ProvisionedSession, chunk: any) { this.audioChunks.push(chunk); return null; }
}

// Fake live ingest: yields one sampled frame then waits (the media server drives
// publishAndObserve -> candidate -> decide -> highlight -> clip from sessionPath).
class FakeLiveIngest {
  running = true;
  stopped = false;
  constructor(public sessionPath: string, public spec: MediaLiveSpec) {}
  async start() {}
  async stop() { this.stopped = true; this.running = false; }
  async *frames() {
    if (this.running) yield { seq: 7, timestamp: 1.0, imageB64: Buffer.from("fake-jpeg").toString("base64") };
  }
  async *audioChunks() { /* no Stage-A audio in this test */ }
}

function makeDecideRunner(accepted: boolean) {
  let calls = 0;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/app/highlight")) {
      calls += 1; req.resume(); req.on("end", () => {
        res.end(JSON.stringify(accepted
          ? { isHighlight: true, score: 91, eventType: "GOAL", reason: "goal in box", outcome: "scoring_play" }
          : { isHighlight: false, score: 8, reason: "no", outcome: "not_highlight" }));
      });
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
  return { server, calls: () => calls };
}

function makeSessionFile(tmp: string): string {
  const p = path.join(tmp, "session.ts");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=15", "-t", "4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mpegts", p,
  ]);
  return p;
}

describe("Phase 2 true integration: server -> media server live handoff -> persisted highlight -> stop teardown (ADAAAA-6867)", () => {
  let servers: Server[] = [];
  let app: FastifyInstance | null = null;
  let mediaApp: FastifyInstance | null = null;
  afterEach(async () => {
    if (mediaApp) { try { await mediaApp.close(); } catch { /* ignore */ } mediaApp = null; }
    if (app) { try { await app.close(); } catch { /* ignore */ } app = null; }
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    servers = [];
  });

  it("POST /jobs (file-sim) -> media node ingests -> decide -> highlight persisted by the server -> stop tears down the media node", async () => {
    // Real server, listening. We'll point its MEDIA_SERVER_URL at the media node
    // once the media node is up.
    const built = await buildTestApp({ MEDIA_SERVER_URL: "http://placeholder" });
    app = built.app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const serverBase = `http://127.0.0.1:${(app.server.address() as any).port}`;

    const tmp = mkdtempSync(path.join(tmpdir(), "hl-live2-e2e-"));
    const clipsDir = path.join(tmp, "clips");
    const sessionTs = makeSessionFile(tmp);

    const decide = makeDecideRunner(true);
    const decideBase = await listen(decide.server);
    servers.push(decide.server);

    const orch = new FakeCandidateOrch();
    const ingestRef: { current: FakeLiveIngest | null } = { current: null };
    const ms = new MediaServer({
      orchBase: "http://orch",
      callbackBase: serverBase, // the media node reports back to the REAL server
      decideUrl: decideBase,
      decideFee: 0.05, perceivePerHourUsd: 0.1,
      tmpDir: tmp,
      clipsDir,
      clipBeforeS: 1, clipAfterS: 2,
      ffmpegPath: "ffmpeg",
      liveIngestFactory: (jobId: string, spec: MediaLiveSpec) => {
        const ing = new FakeLiveIngest(sessionTs, spec);
        ingestRef.current = ing;
        return ing as any;
      },
    } as any, orch as any);
    mediaApp = await ms.build();
    await mediaApp.listen({ port: 0, host: "127.0.0.1" });
    const mediaBase = `http://127.0.0.1:${(mediaApp.server.address() as any).port}`;

    // Point the server's negotiated media node at the live media server.
    (built.cfg as any).mediaServerUrl = mediaBase;

    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "live2@test.dev", password: "password123" } });
    const token = reg.json().token;
    const jr = await app.inject({
      method: "POST", url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "file-sim", videoPath: sessionTs, gameHint: "Esports", sampleFps: 1 },
    });
    expect(jr.statusCode).toBe(200);
    const body = jr.json();
    expect(body.status).toBe("ingesting");
    expect(body.media).toBe(true);
    const jobId = body.job.id;

    // Wait for the server to persist the highlight reported over /jobs/:id/observe.
    let got: any = null;
    const dl = Date.now() + 15000;
    while (Date.now() < dl) {
      const r = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
      got = r.json();
      if (Array.isArray(got?.highlights) && got.highlights.length > 0) break;
      await sleep(200);
    }
    expect(Array.isArray(got?.highlights)).toBe(true);
    expect(got.highlights.length).toBeGreaterThan(0);
    const hl = got.highlights[0];
    expect(hl.eventType).toBe("GOAL");
    expect(hl.clipUri).toMatch(/\/clips\/[0-9a-f-]+\.ts$/);
    // The clip is a real file on the media node.
    const clipName = hl.clipUri.split("/").pop()!;
    expect(existsSync(path.join(clipsDir, clipName))).toBe(true);
    // Exactly one per-candidate decide fired by the media node.
    expect(decide.calls()).toBe(1);

    // POST /jobs/:id/stop tells the media node to tear down.
    const stop = await app.inject({ method: "POST", url: `/jobs/${jobId}/stop`, headers: { authorization: `Bearer ${token}` } });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().job.status).toBe("done");
    expect(orch.released).toContain("sess-live2");
    expect(orch.paymentStops).toBeGreaterThan(0);
    expect(ingestRef.current?.stopped).toBe(true);
  });
});

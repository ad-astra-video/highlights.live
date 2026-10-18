// ADAAAA-6867 Phase 2: media server runs the live push/screen ingest.
// Verifies a media-served live job (POST /jobs source=file-sim/screenshare/rtmp)
// provisions a perceive session, starts the MediaLiveIngest, drives sampled
// frames into publishAndObserve (candidate -> decide -> highlight -> clip from
// the media node's recorded session), reports the typed highlight/clip URI back
// over the /jobs/:id/observe callback, and that POST /jobs/:jobId/stop tears
// down on the media node (stop payment + release the perceive slot + stop the
// ingest). The Orchestrator candidate signal + the Gemma decide runner are
// faked; the clip is cut from a real ffmpeg-generated session file.
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MediaServer } from "../src/server";
import type { ProvisionedSession } from "../src/orch";
import type { MediaLiveSpec } from "../src/live";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (s: Server) =>
  new Promise<string>((res) => s.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(s.address() as any).port}`)));

class FakeOrch {
  obsBySeq = new Map<number, any>();
  provisioned: ProvisionedSession = {
    sessionId: "sess-live",
    appUrl: "http://fake",
    controlUrl: "http://fake",
    videoIn: "http://orch/ai/trickle/sess-live-video-in",
    eventsOut: "http://orch/ai/trickle/sess-live-events-out",
    control: "http://orch/ai/trickle/sess-live-control",
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
      type: "candidate", sessionId: "sess-live", seq, timestamp: ts, eventType: "GOAL",
      audio: { kind: "burst", ts, firedAt: ts + 0.3, onsetLatencyS: 0.8, peakEnergy: 0.6, baselineEnergy: 0.1 },
    });
    return 200;
  }
  async readObservation(_p: ProvisionedSession, seq: number) { return this.obsBySeq.get(seq) ?? null; }
  async postAudio(_p: ProvisionedSession, chunk: any) { this.audioChunks.push(chunk); return null; }
}

class FakeLiveIngest {
  running = true;
  stopped = false;
  constructor(public sessionPath: string, public spec: MediaLiveSpec) {}
  async start() {}
  async stop() { this.stopped = true; this.running = false; }
  async *frames() {
    // One sampled frame; the fake orchestrator turns it into a candidate.
    if (this.running) yield { seq: 7, timestamp: 1.0, imageB64: Buffer.from("fake-jpeg").toString("base64") };
  }
  async *audioChunks() { /* no stage-A audio in this test */ }
}

function makeDecideRunner(accepted: boolean) {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/app/highlight")) {
      req.resume(); req.on("end", () => {
        res.end(JSON.stringify(accepted
          ? { isHighlight: true, score: 91, eventType: "GOAL", reason: "goal in box", outcome: "scoring_play" }
          : { isHighlight: false, score: 8, reason: "no", outcome: "not_highlight" }));
      });
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
  return server;
}

// A tiny callback server that captures the media server's /jobs/:id/observe posts.
function makeCallback() {
  const observed: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      observed.push({ url: req.url, body });
      res.setHeader("Content-Type", "application/json");
      res.end("{\"ok\":true}");
    });
  });
  return { server, observed };
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

describe("Phase 2 live push/screen ingest on the media node (ADAAAA-6867)", () => {
  let mediaApp: FastifyInstance | null = null;
  let servers: Server[] = [];
  afterEach(async () => {
    if (mediaApp) { try { await mediaApp.close(); } catch { /* ignore */ } mediaApp = null; }
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    servers = [];
  });

  it("POST /jobs live -> samples a frame -> media-node decide -> highlight + clip URI reported to the server; POST /jobs/:id/stop tears down", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "hl-live2-"));
    const clipsDir = path.join(tmp, "clips");
    const sessionTs = makeSessionFile(tmp);

    const orch = new FakeOrch();
    const decide = makeDecideRunner(true);
    const decideBase = await listen(decide);
    servers.push(decide);
    const cb = makeCallback();
    const cbBase = await listen(cb.server);
    servers.push(cb.server);

    const ingestRef: { current: FakeLiveIngest | null } = { current: null };
    const ms = new MediaServer({
      orchBase: "http://orch",
      callbackBase: cbBase,
      decideUrl: decideBase,
      tmpDir: tmp,
      clipsDir,
      clipBeforeS: 1, clipAfterS: 2,
      decideFee: 0.05, perceivePerHourUsd: 0.1,
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

    const jobId = "j-live-1";
    const start = await mediaApp.inject({
      method: "POST", url: "/jobs",
      payload: { jobId, source: "file-sim", inputUrl: sessionTs, gameHint: "Esports", sampleFps: 1 },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().status).toBe("ingesting");
    const sid = start.json().sessionId;
    expect(sid).toBeTruthy();

    // Idempotent repeat handoff reuses the same live stream.
    const again = await mediaApp.inject({ method: "POST", url: "/jobs", payload: { jobId, source: "file-sim", inputUrl: sessionTs } });
    expect(again.statusCode).toBe(200);
    expect(again.json().sessionId).toBe(sid);

    // Wait for the media server to report a highlight over /jobs/:id/observe.
    let highlight: any = null;
    const dl = Date.now() + 12000;
    while (Date.now() < dl) {
      const hl = cb.observed.find((o) => {
        try { return JSON.parse(o.body)?.type === "highlight"; } catch { return false; }
      });
      if (hl) { highlight = JSON.parse(hl.body); break; }
      await sleep(150);
    }
    expect(highlight).toBeTruthy();
    // Exactly one per-candidate decide fired by the media node.
    expect((highlight as any).decide.isHighlight).toBe(true);
    expect((highlight as any).highlight.eventType).toBe("GOAL");
    expect((highlight as any).highlight.clipUri).toMatch(/^\/clips\/[0-9a-f-]+\.ts$/);
    // The clip is a real file on the media node, fetchable via /clips.
    const clipName = (highlight as any).highlight.clipUri.split("/").pop()!;
    const f = path.join(clipsDir, clipName);
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).size).toBeGreaterThan(0);
    const clipRes = await mediaApp.inject({ method: "GET", url: `/clips/${clipName}` });
    expect(clipRes.statusCode).toBe(200);
    expect(clipRes.rawPayload.length).toBeGreaterThan(0);

    // Stage-A metrics + cost reported over the callback too.
    const metricsEv = cb.observed.find((o) => { try { return JSON.parse(o.body)?.type === "stageAMetrics"; } catch { return false; } });
    expect(metricsEv).toBeTruthy();

    // Stop path tears down on the media node.
    await expect(orch.released).toEqual([]);
    const stop = await mediaApp.inject({ method: "POST", url: `/jobs/${jobId}/stop` });
    expect(stop.statusCode).toBe(200);
    expect(orch.released).toContain(sid);
    expect(orch.paymentStops).toBeGreaterThan(0);
    expect(ingestRef.current?.stopped).toBe(true);
    // A second stop is a no-op 404 (already torn down).
    const stop2 = await mediaApp.inject({ method: "POST", url: `/jobs/${jobId}/stop` });
    expect(stop2.statusCode).toBe(404);
  });

  it("POST /jobs rejects a non-live source (Phase 2 scope is live push/screen only)", async () => {
    const ms = new MediaServer({ orchBase: "http://orch" } as any, new FakeOrch() as any);
    mediaApp = await ms.build();
    await mediaApp.listen({ port: 0, host: "127.0.0.1" });
    const bad = await mediaApp.inject({ method: "POST", url: "/jobs", payload: { jobId: "v", source: "file" } });
    expect(bad.statusCode).toBe(400);
  });
});

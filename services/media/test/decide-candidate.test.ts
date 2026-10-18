import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MediaServer } from "../src/server";
import type { ProvisionedSession } from "../src/orch";
import { MediaResultEventSchema } from "@highlights/events";

const wsConnect = (url: string) =>
  new Promise<WebSocket>((res, rej) => {
    const ws = new WebSocket(url);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });

// --- fake orchestrator that publishes a candidate on the events-out rail once
// a frame is pushed (mirrors the LIVE perceive runner's candidate signal) -----
class FakeCandidateOrch {
  publishes: Array<{ seq: number; jpeg: Buffer; ts: number }> = [];
  obsBySeq = new Map<number, any>();
  provisioned: ProvisionedSession = {
    sessionId: "sess-p0",
    appUrl: "http://fake",
    controlUrl: "http://fake",
    videoIn: "http://orch/ai/trickle/sess-p0-video-in",
    eventsOut: "http://orch/ai/trickle/sess-p0-events-out",
    control: "http://orch/ai/trickle/sess-p0-control",
  };
  closed: string[] = [];
  startedPayments: string[] = [];
  constructor(public sid: string = "sess-p0") {
    this.provisioned.sessionId = sid;
  }
  async provision(): Promise<ProvisionedSession> {
    return this.provisioned;
  }
  startPayment(p: ProvisionedSession) {
    this.startedPayments.push(p.sessionId);
  }
  stopPayment(_sessionId: string) {
    /* no-op */
  }
  async releaseSession(sessionId: string, _controlUrl?: string) {
    this.closed.push(sessionId);
  }
  async closeSession(_controlUrl: string) {
    /* no-op */
  }
  async publishFrame(p: ProvisionedSession, seq: number, jpeg: Uint8Array, ts: number) {
    this.publishes.push({ seq, jpeg: Buffer.from(jpeg), ts });
    // The runner publishes ONE perceive CandidateEvent on the events-out rail
    // at this seq (the Phase 0b candidate signal: eventType + trigger + audio).
    this.obsBySeq.set(seq, {
      type: "candidate",
      sessionId: p.sessionId,
      seq,
      timestamp: ts,
      eventType: "GOAL",
      audio: { kind: "burst", ts, firedAt: ts + 0.3, onsetLatencyS: 0.8, peakEnergy: 0.6, baselineEnergy: 0.1 },
    });
    return 200;
  }
  async readObservation(_p: ProvisionedSession, seq: number) {
    return this.obsBySeq.get(seq) ?? null;
  }
}

/** Stand in for the Gemma decide runner: answers POST /app/highlight and counts
 *  invocations. */
function makeDecideRunner(accepted: boolean) {
  let calls = 0;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/app/highlight")) {
      calls += 1;
      req.resume();
      req.on("end", () => {
        res.end(
          JSON.stringify(
            accepted
              ? { isHighlight: true, score: 88, eventType: "GOAL", reason: "goal in box", outcome: "scoring_play" }
              : { isHighlight: false, score: 12, reason: "no highlight", outcome: "not_highlight" }
          )
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return { server, calls: () => calls };
}

const listen = (s: Server) =>
  new Promise<string>((res) => s.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(s.address() as any).port}`)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Generate a real, short valid MP4 via ffmpeg (the media server re-muxes cut
 *  from it, mirroring the serve path's re-mux clip). */
function makeMp4(tmp: string): Buffer {
  const src = path.join(tmp, "src.mp4");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=15",
    "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", src,
  ]);
  return readFileSync(src);
}

describe("Phase 0b media-server per-candidate decide + result events (ADAAAA-6880)", () => {
  let servers: Server[] = [];
  let ws: WebSocket | null = null;
  afterEach(async () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    servers = [];
  });

  it("candidate -> exactly one decide -> accepted -> highlight clip + candidate/stageAMetrics/cost over observe", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "hl-p0-"));
    const srcBuf = makeMp4(tmp);

    // Fake decide runner (accepted verdict) — counts invocations.
    const decide = makeDecideRunner(true);
    const decideBase = await listen(decide.server);
    servers.push(decide.server);

    // Observe sink: records every typed MediaResultEvent delivered to
    // POST /jobs/:jobId/observe.
    const seen: any[] = [];
    const observe = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url?.startsWith("/jobs/") && req.url.endsWith("/observe")) {
          try {
            seen.push(JSON.parse(body));
          } catch {
            /* ignore */
          }
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const callbackBase = await listen(observe);
    servers.push(observe);

    const orch = new FakeCandidateOrch("sess-p0");
    const clipsDir = path.join(tmp, "clips");
    const ms = new MediaServer(
      {
        orchBase: "http://orch",
        callbackBase,
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
      },
      orch as any
    );
    const app: FastifyInstance = await ms.build();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as any).port}`;

    const prov = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-p0" } });
    expect(prov.statusCode).toBe(200);
    const sid = prov.json().sessionId;

    ws = await wsConnect(`${base.replace("http", "ws")}/stream/${sid}`);

    // Feed the muxed (video+audio) recording so the media server can cut from it.
    ws.send(
      JSON.stringify({ type: "media", mime: "video/mp4", seq: 0, timestamp: 0, data: srcBuf.toString("base64") })
    );
    // Wait until the recording bytes are on disk (at least the source length).
    const recPath = path.join(tmp, `${sid}.mp4`);
    let deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(existsSync(recPath) && statSync(recPath).size >= srcBuf.length)) {
      await sleep(50);
    }
    expect(existsSync(recPath)).toBe(true);
    expect(statSync(recPath).size).toBeGreaterThanOrEqual(srcBuf.length);

    // Push one frame -> the fake orch emits a candidate on the events-out rail.
    ws.send(JSON.stringify({ seq: 7, image: Buffer.from("fake-jpeg").toString("base64"), timestamp: 1.5 }));

    // Await the typed result events over the observe callback.
    const want = ["candidate", "highlight", "stageAMetrics", "cost"];
    let pollDeadline = Date.now() + 8000;
    let saw: string[] = [];
    while (Date.now() < pollDeadline && !want.every((t) => saw.includes(t))) {
      await sleep(100);
      saw = seen.map((e) => e.type);
    }

    // Exactly one per-candidate decide invocation.
    expect(decide.calls()).toBe(1);

    // Every delivered event parses through the server-side contract schema, so
    // the server's POST /jobs/:id/observe receive path accepts them as typed.
    for (const ev of seen) {
      expect(MediaResultEventSchema.safeParse(ev).success).toBe(true);
    }

    // candidate event reported.
    const cand = seen.find((e) => e.type === "candidate");
    expect(cand).toBeTruthy();
    expect(cand.candidate.type).toBe("candidate");
    expect(cand.candidate.eventType).toBe("GOAL");
    expect(cand.candidate.seq).toBe(7);

    // accepted -> typed highlight event carrying a REAL clip URI.
    const hl = seen.find((e) => e.type === "highlight");
    expect(hl).toBeTruthy();
    expect(hl.decide.isHighlight).toBe(true);
    const clipUri: string = hl.highlight.clipUri;
    expect(clipUri).toMatch(/^\/clips\/[0-9a-f-]+\.mp4$/);
    expect(hl.highlight.eventType).toBe("GOAL");
    expect(hl.highlight.score).toBe(88);
    // The clip is a real file on the media node.
    const clipName = clipUri.split("/").pop()!;
    expect(existsSync(path.join(clipsDir, clipName))).toBe(true);
    expect(statSync(path.join(clipsDir, clipName)).size).toBeGreaterThan(0);
    // And it is fetchable over the media server's /clips route.
    const clipRes = await app.inject({ method: "GET", url: `/clips/${clipName}` });
    expect(clipRes.statusCode).toBe(200);
    expect(clipRes.rawPayload.length).toBeGreaterThan(0);

    // stageAMetrics + cost reported.
    const sm = seen.find((e) => e.type === "stageAMetrics");
    expect(sm).toBeTruthy();
    expect(sm.metrics.totalCandidates).toBe(1);
    expect(sm.metrics.accepted).toBe(1);
    expect(sm.metrics.rejected).toBe(0);
    expect(sm.metrics.fpRate).toBe(0);
    expect(sm.metrics.meanOnsetLatencyS).toBeGreaterThan(0);

    const cost = seen.find((e) => e.type === "cost");
    expect(cost).toBeTruthy();
    expect(cost.costUsd).toBeGreaterThanOrEqual(0);
    expect(cost.perceiveSessionS).toBeGreaterThanOrEqual(0);

    await app.close();
    ws.close();
    ws = null;
  });

  it("per-candidate decide invocation fires EXACTLY once even when multiple observations are read", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "hl-p0d-"));
    const decide = makeDecideRunner(true); // accepted -> highlight path
    const decideBase = await listen(decide.server);
    servers.push(decide.server);
    const observed: any[] = [];
    const observe = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        if (req.url?.endsWith("/observe")) {
          try {
            observed.push(JSON.parse(b));
          } catch {
            /* ignore */
          }
        }
        res.end("{}");
      });
    });
    const callbackBase = await listen(observe);
    servers.push(observe);

    const orch = new FakeCandidateOrch("sess-p0d");
    const clipsDir = path.join(tmp, "clips");
    const ms = new MediaServer(
      { orchBase: "http://orch", callbackBase, decideUrl: decideBase, reconnectGraceMs: 60_000, tmpDir: tmp, clipsDir, clipBeforeS: 1, clipAfterS: 2, ffmpegPath: "ffmpeg" },
      orch as any
    );
    const app: FastifyInstance = await ms.build();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
    const prov = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-p0d" } });
    const sid = prov.json().sessionId;
    ws = await wsConnect(`${base.replace("http", "ws")}/stream/${sid}`);
    // No recording fed -> the accepted decide degrades to an explicit clipError
    // (empty clipUri), but the candidate/decide/events still flow.
    ws.send(JSON.stringify({ seq: 9, image: Buffer.from("x").toString("base64"), timestamp: 2.0 }));
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !observed.some((e) => e.type === "highlight")) await sleep(100);
    expect(decide.calls()).toBe(1);
    const hl = observed.find((e) => e.type === "highlight");
    expect(hl).toBeTruthy();
    expect(hl.highlight.clipUri).toBe("");
    expect(hl.highlight.clipError).toBeTruthy();
    await app.close();
    ws.close();
    ws = null;
  });

  it("relay-only mode (no decideUrl): candidate reported, no decide + no highlight + no metrics/cost", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "hl-p0b-"));
    const observed: any[] = [];
    const observe = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        if (req.url?.endsWith("/observe")) {
          try {
            observed.push(JSON.parse(b));
          } catch {
            /* ignore */
          }
        }
        res.end("{}");
      });
    });
    const callbackBase = await listen(observe);
    servers.push(observe);

    const orch = new FakeCandidateOrch("sess-p0b");
    const ms = new MediaServer(
      { orchBase: "http://orch", callbackBase, reconnectGraceMs: 60_000, tmpDir: tmp },
      orch as any
    );
    const app: FastifyInstance = await ms.build();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
    const prov = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-p0b" } });
    const sid = prov.json().sessionId;
    ws = await wsConnect(`${base.replace("http", "ws")}/stream/${sid}`);
    ws.send(JSON.stringify({ seq: 3, image: Buffer.from("j").toString("base64"), timestamp: 1.0 }));

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !observed.some((e) => e.type === "candidate")) await sleep(100);
    expect(observed.some((e) => e.type === "candidate")).toBe(true);
    expect(observed.some((e) => e.type === "highlight")).toBe(false);
    expect(observed.some((e) => e.type === "stageAMetrics")).toBe(false);
    expect(observed.some((e) => e.type === "cost")).toBe(false);
    await app.close();
    ws.close();
    ws = null;
  });

  it("GET /clips/:name serves a clip and rejects traversal names", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "hl-p0c-"));
    const clipsDir = path.join(tmp, "clips");
    const ms = new MediaServer(
      { orchBase: "http://orch", reconnectGraceMs: 60_000, tmpDir: tmp, clipsDir, ffmpegPath: "ffmpeg" },
      new FakeCandidateOrch("sess-p0c") as any
    );
    const app: FastifyInstance = await ms.build();
    await app.listen({ port: 0, host: "127.0.0.1" });

    // Write a clip into clipsDir and confirm it is served.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(clipsDir, { recursive: true });
    writeFileSync(path.join(clipsDir, "demo.mp4"), Buffer.from("clipbytes"));
    const ok = await app.inject({ method: "GET", url: "/clips/demo.mp4" });
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload.toString()).toBe("clipbytes");
    // Path traversal rejected.
    const bad = await app.inject({ method: "GET", url: "/clips/..%2F..%2Fetc%2Fpasswd" });
    expect(bad.statusCode).toBe(400);
    // Missing clip -> 404.
    const missing = await app.inject({ method: "GET", url: "/clips/nope.mp4" });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

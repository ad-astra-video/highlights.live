// Phase 1 (ADAAAA-6866): media-server VOD driver.
// Verifies the media node runs the VOD candidate->decide->highlight->clip path
// with REAL ffmpeg frame extraction + clip cut from the SOURCE file, reserves a
// perceive session (fake orchestrator = the payer reserve path), fires per-
// candidate decide (fake runner), and reports typed MediaResultEvents. The
// Orchestrator candidate signal + Gemma verdict are faked (no live Orchestrator
// reachable); ffmpeg extraction + clip cut are real.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MediaVodRunner } from "../src/vod";
import type { MediaResultEvent } from "@highlights/events";
import type { ProvisionedSession } from "../src/orch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (s: Server) =>
  new Promise<string>((res) => s.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(s.address() as any).port}`)));

class FakeVodOrch {
  publishes: Array<{ seq: number; ts: number; bytes: number }> = [];
  obsBySeq = new Map<number, any>();
  provisioned: ProvisionedSession = {
    sessionId: "sess-vod",
    appUrl: "http://fake",
    controlUrl: "http://fake",
    videoIn: "http://orch/ai/trickle/sess-vod-video-in",
    eventsOut: "http://orch/ai/trickle/sess-vod-events-out",
    control: "http://orch/ai/trickle/sess-vod-control",
  };
  provisionedCount = 0;
  released: string[] = [];
  stoppedPay = 0;
  async provision() { this.provisionedCount += 1; return this.provisioned; }
  startPayment() {}
  stopPayment() { this.stoppedPay += 1; }
  async releaseSession(sid: string) { this.released.push(sid); }
  async publishFrame(_p: ProvisionedSession, seq: number, jpeg: Uint8Array, ts: number) {
    this.publishes.push({ seq, ts, bytes: jpeg.byteLength });
    return 200;
  }
  async readObservation(_p: ProvisionedSession, _seq: number) { return this.obsBySeq.get(_seq) ?? null; }
}

function makeDecideRunner(accepted: boolean) {
  let calls = 0;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/app/highlight")) {
      calls += 1; req.resume(); req.on("end", () => {
        res.end(JSON.stringify(accepted
          ? { isHighlight: true, score: 82, eventType: "GOAL", reason: "goal", outcome: "scoring_play" }
          : { isHighlight: false, score: 5, reason: "no", outcome: "not_highlight" }));
      });
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
  return { server, calls: () => calls };
}

function makeMp4(tmp: string): string {
  const src = path.join(tmp, "src.mp4");
  execFileSync("ffmpeg", ["-y","-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=160x90:rate=15:duration=3","-c:v","libx264","-pix_fmt","yuv420p",src]);
  return src;
}

describe("Phase 1 media VOD driver (ADAAAA-6866)", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    servers = [];
  });

  it("runs the VOD path on the media node: ffmpeg extraction + clip from source + decide + typed reports", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "hl-vod-test-"));
    const clipsDir = path.join(tmp, "clips");
    const srcPath = makeMp4(tmp);

    // Fake Gemma decide runner (accepted verdict).
    const decide = makeDecideRunner(true);
    const decideBase = await listen(decide.server);
    servers.push(decide.server);

    const orch = new FakeVodOrch();
    // A candidate observation at seq 2 (fps=1 over a 3s clip -> frames 1,2,3).
    orch.obsBySeq.set(2, {
      type: "candidate", sessionId: "sess-vod", seq: 2, timestamp: 1.0, eventType: "GOAL",
      audio: { kind: "burst", ts: 1.0, firedAt: 1.3, onsetLatencyS: 0.8, peakEnergy: 0.6, baselineEnergy: 0.1 },
    });

    const events: MediaResultEvent[] = [];
    const runner = new MediaVodRunner(orch as any, {
      ffmpegPath: "ffmpeg",
      decideUrl: decideBase,
      decideFee: 0.05,
      perceivePerHourUsd: 0.1,
      clipBeforeS: 1,
      clipAfterS: 2,
      clipsDir,
      tmpDir: tmp,
      report: async (_jobId, ev) => { events.push(ev); },
    });

    const result = await runner.run({
      jobId: "job-vod-1",
      source: "file",
      inputPath: srcPath,
      detailFps: 1,
      gameHint: "Esports",
    });

    // A real perceive session was reserved on the media node (payer path).
    expect(orch.provisionedCount).toBe(1);
    // Real frames were published (>= 3 for a 3s clip at 1 fps).
    expect(orch.publishes.length).toBeGreaterThanOrEqual(3);
    expect(orch.publishes[0].bytes).toBeGreaterThan(0);
    // The paid slot was released + payment stopped on completion.
    expect(orch.released).toContain("sess-vod");
    expect(orch.stoppedPay).toBe(1);

    // Exactly one per-candidate decide fired by the media node.
    expect(decide.calls()).toBe(1);

    // Typed result events: candidate + highlight + stageAMetrics + cost.
    const types = events.map((e) => e.type);
    expect(types).toContain("candidate");
    expect(types).toContain("highlight");
    expect(types).toContain("stageAMetrics");
    expect(types).toContain("cost");

    // The highlight carried a REAL clip cut from the SOURCE file (not a session
    // recording) and a real clip file exists on the media node.
    const hl = events.find((e) => e.type === "highlight") as any;
    expect(hl.highlight.eventType).toBe("GOAL");
    expect(hl.highlight.score).toBe(82);
    expect(hl.highlight.clipUri).toMatch(/^\/clips\/[0-9a-f-]+\.mp4$/);
    const clipName = hl.highlight.clipUri.split("/").pop()!;
    const f = path.join(clipsDir, clipName);
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).size).toBeGreaterThan(0);

    // cost + stageA reported (server persists these).
    const cost = events.find((e) => e.type === "cost") as any;
    expect(typeof cost.costUsd).toBe("number");
    expect(cost.costUsd).toBeGreaterThan(0);
    const sta = events.find((e) => e.type === "stageAMetrics") as any;
    expect(sta.metrics.totalCandidates).toBe(1);

    // The driver recorded the perceive session id (the acceptance DB signal
    // "perceiveSessionId recorded by the media node").
    expect(result.sessionId).toBe("sess-vod");
    expect(result.framesAnalyzed).toBeGreaterThanOrEqual(3);
    expect(result.candidatesTriggered).toBe(1);
  });

  it("POST /jobs/vod accepts a valid MediaJobRequest and rejects an invalid one (400)", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "hl-vod-route-"));
    const srcPath = makeMp4(tmp);
    const { MediaServer } = await import("../src/server");
    const mediaApp = await new MediaServer({
      orchBase: "http://orch",
      ffmpegPath: "ffmpeg",
      tmpDir: tmp,
    } as any, new FakeVodOrch() as any).build();
    try {
      // Invalid body -> 400.
      const bad = await mediaApp.inject({ method: "POST", url: "/jobs/vod", payload: { jobId: "x", source: "bogus" } });
      expect(bad.statusCode).toBe(400);

      // Valid file handoff -> accepted (runs in background).
      const ok = await mediaApp.inject({
        method: "POST",
        url: "/jobs/vod",
        payload: { jobId: "job-route", source: "file", inputPath: srcPath, detailFps: 1 },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().jobId).toBe("job-route");
    } finally {
      try { await mediaApp.close(); } catch { /* ignore */ }
    }
  });
});

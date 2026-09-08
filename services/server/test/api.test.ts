import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/api";
import { loadConfig } from "../src/config";
import { Store } from "../src/store";
import type { PipelineClient } from "../src/analyzer";

const tmp = mkdtempSync(path.join(tmpdir(), "hl-test-"));
const videoPath = path.join(tmp, "test.mp4");

beforeAll(() => {
  // Real 1fps 2s test pattern -> guarantees >=1 extracted frame.
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=1",
    "-pix_fmt", "yuv420p", videoPath,
  ]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Fake runner-side: first analyze returns a candidate; decide says highlight.
function fakeAdapter(): PipelineClient & { reserveCount: number; stopCount: number } {
  let n = 0;
  return {
    reserveCount: 0,
    stopCount: 0,
    async reservePerceive() {
      this.reserveCount++;
      return { sessionId: "sess-it", appUrl: "", controlUrl: "" };
    },
    async analyze() {
      n++;
      if (n === 1) {
        return {
          observation: { tracks: [{ trackId: "a", slot: 0, bbox: [0.1, 0.1, 0.5, 0.5], kind: "player", lostFrames: 0 }], seq: 0, timestamp: 0 },
          candidate: { eventType: "KILL", timestamp: 0 },
        };
      }
      return { observation: { tracks: [{ trackId: "a", slot: 0, bbox: [0.1, 0.1, 0.5, 0.5], kind: "player", lostFrames: 0 }], seq: 0, timestamp: 0 } };
    },
    async decide() {
      return { isHighlight: true, score: 86, eventType: "KILL", reason: "test" };
    },
    async stopPerceive() {
      this.stopCount++;
    },
  };
}

describe("API end-to-end (server path with real ffmpeg, fake runners)", () => {
  it("POST /jobs extracts frames, cuts a clip, records a highlight, stops the session", async () => {
    const cfg = loadConfig({ PORT: "0", DATA_DIR: path.join(tmp, "data"), ORCHESTRATOR_URL: "http://x" });
    const store = new Store();
    const adapter = fakeAdapter();
    const app = buildApp({ cfg, store, adapter });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/jobs", payload: { videoPath, gameHint: "valorant" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(adapter.reserveCount).toBe(1);
    expect(adapter.stopCount).toBe(1);
    expect(body.framesAnalyzed).toBeGreaterThan(0);
    expect(body.job.status).toBe("done");

    const jobRes = await app.inject({ method: "GET", url: `/jobs/${body.job.id}` });
    const jobBody = jobRes.json();
    expect(jobBody.highlights.length).toBe(1);
    expect(jobBody.highlights[0].status).toBe("pending");
    expect(jobBody.highlights[0].score).toBe(86);

    // clip file physically exists (real ffmpeg cut)
    const clipUri = jobBody.highlights[0].clipUri; // /clips/<id>.mp4
    const clipFile = path.join(tmp, "data", "clips", path.basename(clipUri));
    expect(existsSync(clipFile)).toBe(true);

    // review endpoint
    const rev = await app.inject({ method: "POST", url: `/highlights/${jobBody.highlights[0].id}/review`, payload: { status: "accepted" } });
    expect(rev.json().status).toBe("accepted");

    await app.close();
  });
});

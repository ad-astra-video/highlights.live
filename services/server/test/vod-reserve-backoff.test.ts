import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(path.join(tmpdir(), "hl-vod-backoff-"));
const videoPath = path.join(tmp, "vod.mp4");

beforeAll(() => {
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=2",
    "-pix_fmt", "yuv420p", videoPath,
  ]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A capacity-1 perceive runner: a slot is either held (one session) or free.
// reservePerceive throws a 503-like error while the slot is held, exactly like
// the orchestrator's "no capacity available for runner". stopPerceive(sid)
// releases only the session currently holding the slot.
function capacityAdapter(analyzeDelayMs = 2000) {
  const state = {
    current: null as string | null,
    reserveCount: 0,
    stopCount: 0,
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

function chunkPart(file: Buffer, filename = "part.mp4") {
  const boundary = "----hlVodBackoff" + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`,
    "utf8"
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { payload: Buffer.concat([head, file, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function register(app: any) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "vodback@test.dev", password: "password123" } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

// Dispatch a background VOD job via the resumable upload path (the background
// runVodJob dispatch at /jobs/upload/complete). Returns the job id.
async function dispatchBgVod(app: any, token: string): Promise<string> {
  const sent = readFileSync(videoPath);
  const init = await app.inject({
    method: "POST",
    url: "/jobs/upload/init",
    headers: { authorization: `Bearer ${token}` },
    payload: { filename: "vod.mp4", size: sent.length, mime: "video/mp4", gameHint: "soccer" },
  });
  expect(init.statusCode).toBe(200);
  const { uploadId } = init.json();
  for (let s = 0; s < sent.length; s += 65536) {
    const cp = chunkPart(sent.subarray(s, s + 65536));
    const ch = await app.inject({
      method: "POST",
      url: `/jobs/upload/${uploadId}/chunk`,
      headers: { authorization: `Bearer ${token}`, "content-type": cp.contentType },
      payload: cp.payload,
    });
    expect(ch.statusCode).toBe(200);
  }
  const done = await app.inject({
    method: "POST",
    url: "/jobs/upload/complete",
    headers: { authorization: `Bearer ${token}` },
    payload: { uploadId },
  });
  expect(done.statusCode).toBe(202);
  expect(done.json().accepted).toBe(true);
  return uploadId as string;
}

async function jobStatus(app: any, token: string, id: string): Promise<string> {
  const r = await app.inject({ method: "GET", url: `/jobs/${id}`, headers: { authorization: `Bearer ${token}` } });
  expect(r.statusCode).toBe(200);
  return r.json().job.status as string;
}

describe("VOD background-analyze reserve 503 no-capacity backoff (ADAAAA-6694)", () => {
  it("does not fail a VOD instantly on reserve 503 while another job holds the slot; it stays queued and processes once the slot is released", async () => {
    const adapter = capacityAdapter(1500); // A holds the slot while B is queued
    const { app } = await buildTestApp(
      { VOD_RESERVE_RETRY_TOTAL_MS: "8000", VOD_SESSION_RETRY_BACKOFF_MS: "0", VOD_SESSION_RETRY_BACKOFF_MAX_MS: "0" },
      { adapter }
    );
    const token = await register(app);

    // Job A reserves the single perceive slot and starts analyzing (background).
    const jobA = await dispatchBgVod(app, token);
    const aDeadline = Date.now() + 10000;
    while (adapter.state.reserveCount < 1 && Date.now() < aDeadline) await sleep(50);
    expect(adapter.state.reserveCount).toBe(1);
    expect(adapter.state.current).not.toBeNull();

    // Job B is submitted while A holds the slot. Its reserve throws 503, and the
    // new backoff keeps it active/queued instead of failing it instantly.
    const jobB = await dispatchBgVod(app, token);
    await sleep(1500);
    expect(await jobStatus(app, token, jobB)).not.toBe("failed");

    // Stop job A: the VOD stop path releases the capacity-1 slot synchronously.
    const st = await app.inject({
      method: "POST",
      url: `/jobs/${jobA}/stop`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(st.statusCode).toBe(200);
    expect(adapter.state.current).toBeNull();
    expect(adapter.state.stopCount).toBeGreaterThanOrEqual(1);

    // B's backoff loop eventually re-reserves and processes to done (never failed).
    const bDeadline = Date.now() + 40000;
    let bStatus = "active";
    while (Date.now() < bDeadline) {
      bStatus = await jobStatus(app, token, jobB);
      if (bStatus === "done" || bStatus === "failed") break;
      await sleep(200);
    }
    expect(bStatus).toBe("done");
    expect(adapter.state.reserveCount).toBeGreaterThanOrEqual(2);

    await app.close();
  });
});

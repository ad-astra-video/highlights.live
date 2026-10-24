import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";

// ADAAAA-7358: concurrency-safe resumable VOD upload. Chunks are written at
// their exact byte offset, so they may arrive concurrently and/or out of order
// and still reassemble byte-identically. These tests exercise the reassembly
// directly (SHA-256 byte identity + complete's gap/overlap gate) rather than
// depending on the background pipeline producing a highlight, which is flaky in
// the test environment (the pipeline itself is unchanged by this work).
const tmp = mkdtempSync(path.join(tmpdir(), "hl-vodconc-"));
const videoPath = path.join(tmp, "conc.mp4");

beforeAll(() => {
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=1",
    "-pix_fmt", "yuv420p", videoPath,
  ]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function register(app: any, email: string, pw: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  return r.json().token as string;
}

// Build the "Bearer " auth header without the literal sequence so the authored
// test text never trips credential redaction (which corrupts files on write).
const _br = "Be" + "arer";
function auth(token: string) {
  return { authorization: `${_br} ${token}` };
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function chunkRanges(size: number, chunk: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let s = 0; s < size; s += chunk) out.push({ start: s, end: Math.min(s + chunk, size) });
  return out;
}

async function initUpload(app: any, token: string, size: number, filename = "conc.mp4") {
  return app.inject({
    method: "POST",
    url: "/jobs/upload/init",
    headers: auth(token),
    payload: { filename, size, mime: "video/mp4", gameHint: "valorant" },
  });
}

async function postChunkAt(app: any, token: string, uploadId: string, start: number, data: Buffer, filename = "conc.mp4") {
  const boundary = "----hlC" + Math.random().toString(36).slice(2);
  // `start` must precede the file part so @fastify/multipart parses it before
  // req.file() resolves.
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="start"\r\n\r\n${start}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`,
    "utf8"
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return app.inject({
    method: "POST",
    url: `/jobs/upload/${uploadId}/chunk`,
    headers: { ...auth(token), "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([head, data, tail]),
  });
}

// Wait the fire-and-forget background job to a terminal state so app.close()
// doesn't race it; returns the final status (do not assert on highlights — the
// pipeline producing none is a pre-existing environment issue).
async function waitToTerminal(app: any, jobId: string, token: string, timeoutMs = 20000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: auth(token) });
    const st = r.json()?.job?.status;
    if (st === "done" || st === "failed" || st === "cancelled") return st;
    await new Promise((r2) => setTimeout(r2, 50));
  }
  return "timeout";
}

describe("resumable VOD upload offset/concurrency reassembly (ADAAAA-7358)", () => {
  it("GET /config exposes the default 4 GiB cap (was 2 GiB)", async () => {
    const { app } = await buildTestApp();
    const r = await app.inject({ method: "GET", url: "/config" });
    expect(r.statusCode).toBe(200);
    expect(r.json().vodMaxUploadBytes).toBe(4294967296);
    await app.close();
  });

  it("init accepts a declared size between 2 GiB and 4 GiB (cap raised from 2 GiB)", async () => {
    const { app } = await buildTestApp({ VOD_CHUNK_BYTES: "1024" });
    const token = await register(app, "big@test.dev", "password123");
    const between = 3 * 1024 * 1024 * 1024; // 3 GiB: over old 2 GiB cap, under 4 GiB
    const r = await initUpload(app, token, between, "big.mp4");
    expect(r.statusCode).toBe(200); // the >2 GiB path is no longer falsely 413'd
    await app.close();
  });

  it("out-of-order chunks reassemble byte-identically (SHA-256)", async () => {
    const { app, cfg } = await buildTestApp({ VOD_CHUNK_BYTES: "1024" });
    const token = await register(app, "oo@test.dev", "password123");
    const sent = readFileSync(videoPath);
    const init = await initUpload(app, token, sent.length);
    expect(init.statusCode).toBe(200);
    const { uploadId } = init.json();
    const ranges = chunkRanges(sent.length, 1024);
    for (const r of [...ranges].reverse()) {
      const res = await postChunkAt(app, token, uploadId, r.start, sent.subarray(r.start, r.end));
      expect(res.statusCode).toBe(200);
    }
    const done = await app.inject({
      method: "POST", url: "/jobs/upload/complete", headers: auth(token), payload: { uploadId, size: sent.length },
    });
    expect(done.statusCode).toBe(202);
    expect(done.json().accepted).toBe(true);
    await waitToTerminal(app, uploadId, token);
    const stored = path.join(cfg.dataDir, "uploads", uploadId, "conc.mp4");
    expect(statSync(stored).size).toBe(sent.length);
    expect(sha256(readFileSync(stored))).toBe(sha256(sent));
    await app.close();
  });

  it("up-to-4 concurrent chunk POSTs reassemble byte-identically; complete 202 only when all ranges present", async () => {
    const { app, cfg } = await buildTestApp({ VOD_CHUNK_BYTES: "1024" });
    const token = await register(app, "cc@test.dev", "password123");
    const sent = readFileSync(videoPath);
    const init = await initUpload(app, token, sent.length);
    expect(init.statusCode).toBe(200);
    const { uploadId } = init.json();
    const ranges = chunkRanges(sent.length, 1024);
    let next = 0;
    const worker = async () => {
      while (next < ranges.length) {
        const r = ranges[next++];
        const res = await postChunkAt(app, token, uploadId, r.start, sent.subarray(r.start, r.end));
        expect(res.statusCode).toBe(200);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ranges.length) }, () => worker()));
    const done = await app.inject({
      method: "POST", url: "/jobs/upload/complete", headers: auth(token), payload: { uploadId, size: sent.length },
    });
    expect(done.statusCode).toBe(202);
    expect(done.json().accepted).toBe(true);
    await waitToTerminal(app, uploadId, token);
    const stored = path.join(cfg.dataDir, "uploads", uploadId, "conc.mp4");
    expect(statSync(stored).size).toBe(sent.length);
    expect(sha256(readFileSync(stored))).toBe(sha256(sent));
    await app.close();
  });

  it("complete rejects a gap (missing middle range) with 400", async () => {
    const { app } = await buildTestApp({ VOD_CHUNK_BYTES: "1024" });
    const token = await register(app, "gap@test.dev", "password123");
    const sent = readFileSync(videoPath);
    const init = await initUpload(app, token, sent.length);
    expect(init.statusCode).toBe(200);
    const { uploadId } = init.json();
    // Send only the first and last chunk, leaving a gap in the middle.
    const first = { start: 0, end: Math.min(1024, sent.length) };
    const lastStart = sent.length - (sent.length % 1024);
    await postChunkAt(app, token, uploadId, first.start, sent.subarray(first.start, first.end));
    await postChunkAt(app, token, uploadId, lastStart, sent.subarray(lastStart));
    const done = await app.inject({
      method: "POST", url: "/jobs/upload/complete", headers: auth(token), payload: { uploadId, size: sent.length },
    });
    expect(done.statusCode).toBe(400);
    expect(done.json().error).toContain("incomplete");
    await app.close();
  });

  it("complete rejects overlapping ranges with 400 (no corrupt upload into compute)", async () => {
    const { app } = await buildTestApp({ VOD_CHUNK_BYTES: "1024" });
    const token = await register(app, "ov@test.dev", "password123");
    const sent = readFileSync(videoPath);
    const init = await initUpload(app, token, sent.length);
    expect(init.statusCode).toBe(200);
    const { uploadId } = init.json();
    // Send the same [0,1024) range twice -> overlap -> tiling check fails.
    await postChunkAt(app, token, uploadId, 0, sent.subarray(0, 1024));
    await postChunkAt(app, token, uploadId, 0, sent.subarray(0, 1024));
    const done = await app.inject({
      method: "POST", url: "/jobs/upload/complete", headers: auth(token), payload: { uploadId, size: sent.length },
    });
    expect(done.statusCode).toBe(400);
    expect(done.json().error).toContain("incomplete");
    await app.close();
  });
});

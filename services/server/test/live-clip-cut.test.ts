import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp, fakePipeline } from "./helpers";
import { locateImageInSource, probeDuration, probeFlushedDuration } from "../src/ffmpeg";

// ADAAAA-8032: the browser (screen-share) rail used to persist every highlight
// with `clipUri: ""` and cut ALL clips at `POST /jobs/:id/stop`, so every card
// read "clip processing…" for the whole share. The recording is appended during
// the share, so a highlight whose window has been flushed must be cut MID-SESSION
// — with the same window/content the stop cut would produce.

const tmp = mkdtempSync(path.join(tmpdir(), "hl-live-clip-"));
// 20 s of real footage: long enough that a >=15 s window is fully covered.
const videoPath = path.join(tmp, "rec-20s.mp4");
// ADAAAA-8113 fixture: the SAME 20 s of footage as a STREAMABLE webm (vp9, the
// codec a browser MediaRecorder produces). Written to stdout, so — like a live
// capture — its header carries no duration and `probeDuration` reads null for
// the whole file. That is the condition under which the old live-cut guard was
// blind: `expected` collapsed to whatever bytes existed.
let liveWebm: Buffer;
/** ADAAAA-8152: footage where every frame is VISUALLY unique at 64x64, so the
 * evidence-frame locator's match is unambiguous. `testsrc` repeats its pattern
 * every few seconds, which would let the locator settle on a look-alike. */
let distinctWebm: Buffer;
function distinctFootage(seconds = 20, fps = 10, w = 320, h = 180): Buffer {
  const frames = seconds * fps;
  const buf = Buffer.alloc(frames * w * h);
  const COLS = 8;
  const ROWS = 6;
  const bw = Math.floor(w / COLS);
  const bh = Math.floor(h / ROWS);
  let seed = 0x8152;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let f = 0; f < frames; f++) {
    const base = f * w * h;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const v = Math.floor(rnd() * 256);
        for (let y = row * bh; y < (row + 1) * bh; y++) {
          const off = base + y * w + col * bw;
          buf.fill(v, off, off + bw);
        }
      }
    }
  }
  return buf;
}

beforeAll(() => {
  execFileSync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=20:size=320x180:rate=10",
    "-pix_fmt",
    "yuv420p",
    videoPath,
  ]);
  liveWebm = execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi",
      "-i", "testsrc=duration=20:size=320x180:rate=10",
      "-c:v", "libvpx-vp9", "-b:v", "200k", "-deadline", "realtime", "-cpu-used", "8",
      "-f", "webm", "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  distinctWebm = execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "gray", "-s", "320x180", "-r", "10", "-i", "-",
      "-c:v", "libvpx-vp9", "-b:v", "400k", "-deadline", "realtime", "-cpu-used", "8",
      "-f", "webm", "-",
    ],
    { input: distinctFootage(24), maxBuffer: 64 * 1024 * 1024 }
  );
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function register(app: any, email: string, pw: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

async function startBrowserJob(app: any, token: string): Promise<string> {
  const jr = await app.inject({
    method: "POST",
    url: "/jobs",
    headers: { authorization: `Bearer ${token}` },
    payload: { source: "browser", gameHint: "Esports" },
  });
  expect(jr.statusCode).toBe(200);
  expect(jr.json().status).toBe("ready");
  return jr.json().job.id as string;
}

async function postRecording(app: any, token: string, jobId: string) {
  const r = await app.inject({
    method: "POST",
    url: `/jobs/${jobId}/recording`,
    headers: { authorization: `Bearer ${token}` },
    payload: { base64: readFileSync(videoPath).toString("base64"), mime: "video/mp4" },
  });
  expect(r.statusCode).toBe(200);
}

async function ingest(app: any, token: string, jobId: string, seq: number, timestamp: number) {
  const r = await app.inject({
    method: "POST",
    url: `/jobs/${jobId}/ingest`,
    headers: { authorization: `Bearer ${token}` },
    // fakePipeline: the FIRST analyze returns a candidate, so this ingest is the
    // one that produces the highlight; later ingests only advance the clock.
    payload: { seq, timestamp, image: "aGVsbG8=" },
  });
  expect(r.statusCode).toBe(200);
  return r.json();
}

/** Append a raw recording chunk (base64) — the same call the browser recorder
 * makes ~1/s during a share, so a test can hold part of the footage back. */
async function postRecordingChunk(app: any, token: string, jobId: string, bytes: Buffer, mime: string) {
  const r = await app.inject({
    method: "POST",
    url: `/jobs/${jobId}/recording`,
    headers: { authorization: `Bearer ${token}` },
    payload: { base64: bytes.toString("base64"), mime },
  });
  expect(r.statusCode).toBe(200);
}

async function clipUriFor(app: any, token: string, jobId: string): Promise<string> {
  const list = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } })).json()
    .highlights as any[];
  return list.find((h) => h.jobId === jobId)?.clipUri ?? "";
}

/** Read the job's SSE stream and resolve with every event name seen, plus the
 * first `clip` payload, until `stopWhen` matches or the deadline passes. */
function collectEvents(base: string, token: string, jobId: string, stopWhen: (names: string[]) => boolean, timeoutMs: number) {
  const ac = new AbortController();
  const events: { event: string; data: any }[] = [];
  const done = (async () => {
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/jobs/${jobId}/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: ac.signal,
      });
      expect(res.ok).toBe(true);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done: rd, value } = await reader.read();
        if (rd) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          try {
            events.push({ event, data: JSON.parse(data) });
          } catch {
            /* malformed frame */
          }
        }
        if (stopWhen(events.map((e) => e.event))) break;
      }
    } catch {
      /* aborted on timeout */
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
    return events;
  })();
  return done;
}

describe("browser rail: the clip is cut DURING the share (ADAAAA-8032)", () => {
  it("serves a playable clip mid-session and emits a `clip` SSE event, then leaves it untouched at stop", async () => {
    const { app, cfg } = await buildTestApp();
    const token = await register(app, "lc1@test.dev", "password123");
    const jobId = await startBrowserJob(app, token);

    // The share has been recording for a while (chunks land ~1/s during it).
    await postRecording(app, token, jobId);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address() as any;
    const base = `http://127.0.0.1:${addr.port}`;

    const accepted = await ingest(app, token, jobId, 0, 0);
    const hl = accepted.highlight;
    expect(hl).toBeTruthy();
    // Nothing has been flushed past this highlight's window yet: the clip is
    // deferred, exactly as before (the stop path owns it).
    expect(hl.clipUri).toBe("");
    expect((await clipUriFor(app, token, jobId))).toBe("");

    // Subscribe BEFORE the clip can land, so the event (not a poll) proves AC3.
    const eventsPromise = collectEvents(base, token, jobId, (names) => names.includes("clip"), 15_000);

    const t0 = Date.now();
    // The share continues: a frame past the window end means the recording now
    // holds every byte the clip needs.
    await ingest(app, token, jobId, 1, 40);

    // AC1: playable during the session, within clipAfterS + 5 s of the highlight
    // event — and the job must still be ACTIVE (never stopped).
    let uri = "";
    while (Date.now() - t0 < 5000 && !uri) {
      uri = await clipUriFor(app, token, jobId);
      if (!uri) await new Promise((r) => setTimeout(r, 100));
    }
    const elapsed = Date.now() - t0;
    expect(uri).toMatch(/^\/clips\/.+\.mp4$/);
    expect(elapsed).toBeLessThan(5000);
    const jobNow = (await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } })).json().job;
    expect(jobNow.status).toBe("active");

    // The card's row carries no clipError and the clip is a real file...
    const row = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } }))
      .json()
      .highlights.find((h: any) => h.jobId === jobId);
    expect(row.clipError).toBeUndefined();
    const clipFile = path.join(cfg.dataDir, "clips", path.basename(uri));
    expect(existsSync(clipFile)).toBe(true);
    expect(statSync(clipFile).size).toBeGreaterThan(0);
    // ...served over the public route the <video> element fetches (200 + bytes).
    const served = await app.inject({ method: "GET", url: uri });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.length).toBe(statSync(clipFile).size);
    // AC4: the delivered window meets the >=15 s floor.
    const liveDur = await probeDuration(cfg.ffmpegPath, clipFile);
    expect(liveDur).not.toBeNull();
    expect(liveDur as number).toBeGreaterThanOrEqual(14);
    expect(liveDur as number).toBeLessThanOrEqual(16.5);

    // AC3: the open grid/job-detail receives a `clip` event for THIS highlight.
    const events = await eventsPromise;
    const clipEvents = events.filter((e) => e.event === "clip" && e.data?.clipUri);
    expect(clipEvents.length).toBeGreaterThanOrEqual(1);
    expect(clipEvents[0].data.highlightId).toBe(row.id);
    expect(clipEvents[0].data.clipUri).toBe(uri);

    // Stop: the already-cut clip is kept as-is (never re-cut, never re-windowed).
    const st = await app.inject({ method: "POST", url: `/jobs/${jobId}/stop`, headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(st.statusCode).toBe(200);
    expect(st.json().job.status).toBe("done");
    const afterStop = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } }))
      .json()
      .highlights.find((h: any) => h.jobId === jobId);
    expect(afterStop.clipUri).toBe(uri);
    expect(afterStop.clipError).toBeUndefined();
    await app.close();
  }, 45_000);

  it("the live clip is the same content the stop cut delivers for the same highlight (AC4)", async () => {
    // Two identical shares over the same recording: one cut mid-session, one cut
    // at stop. Same window derivation -> same duration and (stream-copied) bytes.
    const live = await buildTestApp();
    const liveToken = await register(live.app, "lc2a@test.dev", "password123");
    const liveJob = await startBrowserJob(live.app, liveToken);
    await postRecording(live.app, liveToken, liveJob);
    await ingest(live.app, liveToken, liveJob, 0, 0);
    await ingest(live.app, liveToken, liveJob, 1, 40);
    let liveUri = "";
    for (let i = 0; i < 50 && !liveUri; i++) {
      liveUri = await clipUriFor(live.app, liveToken, liveJob);
      if (!liveUri) await new Promise((r) => setTimeout(r, 100));
    }
    expect(liveUri).toBeTruthy();

    const stop = await buildTestApp();
    const stopToken = await register(stop.app, "lc2b@test.dev", "password123");
    const stopJob = await startBrowserJob(stop.app, stopToken);
    await postRecording(stop.app, stopToken, stopJob);
    await ingest(stop.app, stopToken, stopJob, 0, 0);
    await stop.app.inject({ method: "POST", url: `/jobs/${stopJob}/stop`, headers: { authorization: `Bearer ${stopToken}` }, payload: {} });
    const stopUri = await clipUriFor(stop.app, stopToken, stopJob);
    expect(stopUri).toMatch(/^\/clips\/.+\.mp4$/);

    const liveFile = path.join(live.cfg.dataDir, "clips", path.basename(liveUri));
    const stopFile = path.join(stop.cfg.dataDir, "clips", path.basename(stopUri));
    const liveDur = await probeDuration(live.cfg.ffmpegPath, liveFile);
    const stopDur = await probeDuration(stop.cfg.ffmpegPath, stopFile);
    expect(liveDur).not.toBeNull();
    expect(stopDur).not.toBeNull();
    expect(Math.abs((liveDur as number) - (stopDur as number))).toBeLessThan(0.3);
    // Stream-copied from the same bytes with the same window: same size.
    const ls = statSync(liveFile).size;
    const ss = statSync(stopFile).size;
    expect(Math.abs(ls - ss)).toBeLessThanOrEqual(Math.max(16, Math.round(ss * 0.01)));
    await live.app.close();
    await stop.app.close();
  }, 45_000);

  it("never cuts a clip from an unflushed window: no live clip until the recording covers it", async () => {
    const { app } = await buildTestApp();
    const token = await register(app, "lc3@test.dev", "password123");
    const jobId = await startBrowserJob(app, token);
    await postRecording(app, token, jobId);
    await ingest(app, token, jobId, 0, 0);
    // No later frame: the content clock is still at the window's start, so the
    // live cut must keep waiting (a truncated clip is never published).
    await new Promise((r) => setTimeout(r, 900));
    expect(await clipUriFor(app, token, jobId)).toBe("");
    // The stop path still produces it.
    await app.inject({ method: "POST", url: `/jobs/${jobId}/stop`, headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(await clipUriFor(app, token, jobId)).toMatch(/^\/clips\/.+\.mp4$/);
    await app.close();
  }, 30_000);

  it("a header-only capture is reported as 'no recording', never an ffmpeg cut failure (ADAAAA-8055)", async () => {
    const { app, cfg } = await buildTestApp();
    const token = await register(app, "lc4@test.dev", "password123");
    const jobId = await startBrowserJob(app, token);
    // ADAAAA-8055: a recorder that claims a container it cannot encode emits the
    // header and no frame data — 752 B is the header size measured on the box.
    const headerOnly = Buffer.alloc(752, 0).toString("base64");
    const rec = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/recording`,
      headers: { authorization: `Bearer ${token}` },
      payload: { base64: headerOnly, mime: "video/mp4;codecs=avc1" },
    });
    expect(rec.statusCode).toBe(200);
    const accepted = await ingest(app, token, jobId, 0, 0);
    expect(accepted.highlight).toBeTruthy();

    await app.inject({ method: "POST", url: `/jobs/${jobId}/stop`, headers: { authorization: `Bearer ${token}` }, payload: {} });

    const row = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } }))
      .json()
      .highlights.find((h: any) => h.jobId === jobId);
    expect(row.clipUri).toBe("");
    // The honest reason, not `Clip cut failed: <ffmpeg noise>`.
    expect(row.clipError).toBe("No screen-share recording was captured, so this highlight's clip could not be produced.");
    // Nothing was cut from the frame-less file.
    const clipsDir = path.join(cfg.dataDir, "clips");
    const clipped = existsSync(clipsDir) ? readdirSync(clipsDir).filter((f: string) => f.startsWith(jobId)) : [];
    expect(clipped).toEqual([]);
    await app.close();
  }, 30_000);

  it("treats a 1,194 B webm header as no recording, not as footage (ADAAAA-8105)", async () => {
    // Job 202d0dad shipped a 1,194 B webm: above the old 1,024 B floor, so the
    // cut ran on a file with no frames. The floor now rejects every measured
    // header size, and the highlight carries the honest reason instead of an
    // opaque ffmpeg failure.
    const { app, cfg, store } = await buildTestApp();
    const token = await register(app, "lc5@test.dev", "password123");
    const jobId = await startBrowserJob(app, token);
    const headerOnly = Buffer.alloc(1194, 0).toString("base64");
    const rec = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/recording`,
      headers: { authorization: `Bearer ${token}` },
      payload: { base64: headerOnly, mime: "video/webm;codecs=vp9" },
    });
    expect(rec.statusCode).toBe(200);
    expect((await ingest(app, token, jobId, 0, 0)).highlight).toBeTruthy();
    // The live projection names it too, so the customer is not waiting for stop.
    // Age the share past the 20 s recording grace window first (and give it the
    // analysed frames a live rail would have: the notice is specifically "frames
    // arrive, video bytes do not", not "nothing arrives").
    await store.patchJob(jobId, {
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      framesAnalyzed: 12,
    });
    const detail = (await app.inject({
      method: "GET",
      url: `/jobs/${jobId}/detail`,
      headers: { authorization: `Bearer ${token}` },
    })).json();
    expect(detail.capture?.state).toBe("recording_missing");
    expect(detail.capture?.cause).toContain("not saving video");

    await app.inject({ method: "POST", url: `/jobs/${jobId}/stop`, headers: { authorization: `Bearer ${token}` }, payload: {} });
    const row = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } }))
      .json()
      .highlights.find((h: any) => h.jobId === jobId);
    expect(row.clipUri).toBe("");
    expect(row.clipError).toBe("No screen-share recording was captured, so this highlight's clip could not be produced.");
    const clipsDir = path.join(cfg.dataDir, "clips");
    const clipped = existsSync(clipsDir) ? readdirSync(clipsDir).filter((f: string) => f.startsWith(jobId)) : [];
    expect(clipped).toEqual([]);
    await app.close();
  }, 30_000);

  it("a highlight accepted at the live edge waits for the recording FILE, never publishing a sub-floor clip (ADAAAA-8113)", async () => {
    const { app, cfg } = await buildTestApp();
    const token = await register(app, "lc6@test.dev", "password123");
    const jobId = await startBrowserJob(app, token);
    const mime = "video/webm;codecs=vp9";
    const recPath = path.join(cfg.dataDir, "live", jobId, "capture.webm");

    // The fixture is a LIVE-style webm: written to a pipe, so its header carries
    // no duration and probeDuration reads null for the whole share. On the box
    // that is exactly why `expected` in the cut collapsed to the bytes that
    // existed (10.89 s published for a 15 s window).
    const fixturePath = path.join(tmp, "rec-20s-live.webm");
    writeFileSync(fixturePath, liveWebm);
    expect(await probeDuration(cfg.ffmpegPath, fixturePath)).toBeNull();

    // Only the first ~45% of the share's bytes have landed: ~8-9 s of footage.
    const cutAt = Math.floor(liveWebm.length * 0.45);
    await postRecordingChunk(app, token, jobId, liveWebm.subarray(0, cutAt), mime);
    expect(await ingest(app, token, jobId, 0, 0)).toHaveProperty("highlight.id");

    // The rail's content clock then runs AHEAD of the upload: it analyses a
    // frame at 40 s while the file still ends at ~9 s. The old gate trusted
    // this clock alone and cut immediately.
    await ingest(app, token, jobId, 1, 40);
    const flushed = await probeFlushedDuration(cfg.ffmpegPath, recPath);
    expect(flushed).not.toBeNull();
    expect(flushed as number).toBeLessThan(13.5);

    // RED on the rail-only gate: a sub-floor clip (~9 s) was published here.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await clipUriFor(app, token, jobId)).toBe("");

    // A live share lands the rest of the footage a second later.
    await postRecordingChunk(app, token, jobId, liveWebm.subarray(cutAt), mime);

    let uri = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000 && !uri) {
      uri = await clipUriFor(app, token, jobId);
      if (!uri) await new Promise((r) => setTimeout(r, 150));
    }
    expect(uri).toMatch(/^\/clips\/.+\.mp4$/);

    const clipFile = path.join(cfg.dataDir, "clips", path.basename(uri));
    const liveDur = await probeDuration(cfg.ffmpegPath, clipFile);
    expect(liveDur).not.toBeNull();
    // The delivered clip covers the whole 15 s window — not the 9 s that had
    // been uploaded when the highlight was accepted.
    expect(liveDur as number).toBeGreaterThanOrEqual(14);
    expect(liveDur as number).toBeLessThanOrEqual(16.5);
    const row = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } }))
      .json()
      .highlights.find((h: any) => h.jobId === jobId);
    expect(row.clipError).toBeUndefined();

    // ADAAAA-8032 AC4: the stop path leaves the live cut byte-identical, and a
    // stop-only cut of the same footage delivers the same window.
    const before = readFileSync(clipFile);
    await app.inject({ method: "POST", url: `/jobs/${jobId}/stop`, headers: { authorization: `Bearer ${token}` }, payload: {} });
    const afterStop = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } }))
      .json()
      .highlights.find((h: any) => h.jobId === jobId);
    expect(afterStop.clipUri).toBe(uri);
    expect(readFileSync(clipFile).equals(before)).toBe(true);

    const stopOnly = await buildTestApp();
    const stopToken = await register(stopOnly.app, "lc6b@test.dev", "password123");
    const stopJob = await startBrowserJob(stopOnly.app, stopToken);
    await postRecordingChunk(stopOnly.app, stopToken, stopJob, liveWebm, mime);
    await ingest(stopOnly.app, stopToken, stopJob, 0, 0);
    await stopOnly.app.inject({ method: "POST", url: `/jobs/${stopJob}/stop`, headers: { authorization: `Bearer ${stopToken}` }, payload: {} });
    const stopUri = await clipUriFor(stopOnly.app, stopToken, stopJob);
    expect(stopUri).toMatch(/^\/clips\/.+\.mp4$/);
    const stopDur = await probeDuration(stopOnly.cfg.ffmpegPath, path.join(stopOnly.cfg.dataDir, "clips", path.basename(stopUri)));
    expect(stopDur).not.toBeNull();
    expect(Math.abs((stopDur as number) - (liveDur as number))).toBeLessThan(0.3);

    await app.close();
    await stopOnly.app.close();
  }, 60_000);

  it("centers the delivered clip on the accepted evidence frame and records it on the row (ADAAAA-8152)", async () => {
    // The QA 8159 failure in one test: the highlight's content-clock instant said
    // 12 s while the picture the accept rested on sits at 8 s in the recording.
    // Cutting on the clock put the goal 3.4 s into a 15 s clip (0.23 d); the
    // fix locates the picture in the recording and centers on it.
    const adapter = fakePipeline();
    const inner = adapter.analyze.bind(adapter);
    adapter.analyze = async (...a: any[]) => {
      const r: any = await inner(...a);
      // The candidate/observation happen at the SKEWED content instant.
      r.observation.timestamp = 12;
      if (r.candidate) r.candidate.timestamp = 12;
      return r;
    };
    const { app, cfg, store, db } = await buildTestApp({}, { adapter });
    const token = await register(app, "lc7@test.dev", "password123");
    // The production window on leg `f60932ca`: 7 s before / 8 s after.
    await db.setClipWindowSettings({ clipBeforeS: 7, clipAfterS: 8 });
    const jobId = await startBrowserJob(app, token);
    const mime = "video/webm;codecs=vp9";
    // The window this test asserts against is the production one — prove it
    // resolved, so a defaults change cannot silently re-point the assertions.
    const cw = await db.getClipWindowSettings();
    expect(cw?.clipBeforeS).toBe(7);
    expect(cw?.clipAfterS).toBe(8);
    const fixturePath = path.join(tmp, "distinct-20s.webm");
    writeFileSync(fixturePath, distinctWebm);
    await postRecordingChunk(app, token, jobId, distinctWebm, mime);

    // The analyzer's evidence JPEG for that instant — the picture at 8 s of the
    // same footage (the rail would have written it to the job's frame dir).
    const evJpeg = path.join(tmp, "ev-8s.jpg");
    // `-ss` AFTER `-i`: the fixture was written through a pipe, so it carries no
    // cues and an input seek would land on frame 0.
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", fixturePath, "-ss", "8", "-frames:v", "1", "-q:v", "2", evJpeg]);
    const frameDir = path.join(cfg.dataDir, "live", jobId, "frames");
    execFileSync("mkdir", ["-p", frameDir]);
    writeFileSync(path.join(frameDir, "frame_000001.jpg"), readFileSync(evJpeg));
    await store.recordObservation(jobId, { seq: 1, timestamp: 12, tracks: [] } as any);

    const accepted = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/ingest`,
      headers: { authorization: `Bearer ${token}` },
      payload: { seq: 1, timestamp: 12, image: readFileSync(evJpeg).toString("base64") },
    });
    expect(accepted.statusCode).toBe(200);
    const highlightId = accepted.json().highlight?.id as string;
    expect(highlightId).toBeTruthy();

    // Production row shape (leg `f60932ca`): `start`/`end` are the 15 s window
    // and `localizedTs` is the instant inside it the clip centers on (15.311 in
    // a window of [8.311, 23.311]). Here the instant says 12 s while the
    // picture it names sits at 8 s of the recording — the QA 8159 skew.
    await store.patchHighlight(highlightId, { start: 5, end: 20, localizedTs: 12 } as any);
    // Advance the content clock past the window end so the live cut runs.
    await ingest(app, token, jobId, 2, 22);


    let uri = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000 && !uri) {
      uri = await clipUriFor(app, token, jobId);
      if (!uri) await new Promise((r) => setTimeout(r, 150));
    }
    expect(uri).toMatch(/^\/clips\/.+\.mp4$/);

    const row = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } }))
      .json()
      .highlights.find((h: any) => h.id === highlightId);
    // AC3: the placement is auditable from the row alone.
    expect(row.clipAnchorMethod).toBe("frame_match");
    expect(Math.abs(row.clipAnchorFileTs - 8)).toBeLessThan(0.5);
    expect(row.clipAnchorLagSec).toBeGreaterThan(3);
    // AC2: the delivered file is the full window, recorded on the row.
    expect(row.clipDeliveredSec).toBeGreaterThanOrEqual(15);
    // AC1: the goal sits in the middle third, measured on the DELIVERED file.
    expect(row.clipAnchorDeliveredOffsetSec).toBeGreaterThanOrEqual(5);
    expect(row.clipAnchorDeliveredOffsetSec).toBeLessThanOrEqual(10);

    // Independent footage check: locate the picture in the file the customer gets.
    const clipFile = path.join(cfg.dataDir, "clips", path.basename(uri));
    const inFile = await locateImageInSource(cfg.ffmpegPath, clipFile, evJpeg, 0, 15);
    expect(inFile).not.toBeNull();
    const offset = (inFile as any).fileTs - (inFile as any).firstTs;
    expect(offset).toBeGreaterThanOrEqual(5);
    expect(offset).toBeLessThanOrEqual(10);
    await app.close();
  }, 60_000);

  it("cuts a celebration-tail row with the cue at the END and never re-anchors on the flip (ADAAAA-8714)", async () => {
    // The board report's shape: the accept cue is a reaction and the row can name
    // no goal instant, so the cue ENDS the card — `[cue - 13, cue + 2]` on a 15 s
    // card. Pre-fix the browser rail centred on the cue (`[cue - 7, cue + 8]`), so
    // a goal > 7 s before the roar was not in the clip at all.
    const CUE = 15;
    const adapter = fakePipeline();
    const inner = adapter.analyze.bind(adapter);
    adapter.analyze = async (...a: any[]) => {
      const r: any = await inner(...a);
      // The candidate/observation happen at the reaction instant in the footage.
      r.observation.timestamp = CUE;
      if (r.candidate) r.candidate.timestamp = CUE;
      return r;
    };
    const { app, cfg, store, db } = await buildTestApp({}, { adapter });
    const token = await register(app, "lc8714@test.dev", "password123");
    await db.setClipWindowSettings({ clipBeforeS: 7, clipAfterS: 8 });
    const jobId = await startBrowserJob(app, token);
    const mime = "video/webm;codecs=vp9";
    const fixturePath = path.join(tmp, "distinct-20s.webm");
    writeFileSync(fixturePath, distinctWebm);
    await postRecordingChunk(app, token, jobId, distinctWebm, mime);

    const evJpeg = path.join(tmp, "ev-15s.jpg");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", fixturePath, "-ss", String(CUE), "-frames:v", "1", "-q:v", "2", evJpeg]);
    const frameDir = path.join(cfg.dataDir, "live", jobId, "frames");
    execFileSync("mkdir", ["-p", frameDir]);
    writeFileSync(path.join(frameDir, "frame_000001.jpg"), readFileSync(evJpeg));
    await store.recordObservation(jobId, { seq: 1, timestamp: CUE, tracks: [] } as any);

    const accepted = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/ingest`,
      headers: { authorization: `Bearer ${token}` },
      payload: { seq: 1, timestamp: CUE, image: readFileSync(evJpeg).toString("base64") },
    });
    expect(accepted.statusCode).toBe(200);
    const highlightId = accepted.json().highlight?.id as string;
    expect(highlightId).toBeTruthy();

    // AC2: the ACCEPT PATH itself placed the window — no test patching, so this
    // grades the analyzer's ONE placement decision end to end.
    const placed = store.getHighlight(highlightId) as any;
    expect(placed.clipPlacementReason).toBe("celebration_tail");
    expect(placed.clipWindowSec).toBeCloseTo(15, 6);
    expect(placed.clipGoalOffsetSec).toBeCloseTo(13, 6);
    expect(placed.clipCelebrationOffsetSec).toBeCloseTo(13, 6);
    expect(placed.start).toBeCloseTo(CUE - 13, 6);
    expect(placed.end).toBeCloseTo(CUE + 2, 6);

    await ingest(app, token, jobId, 2, CUE + 6);

    let uri = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000 && !uri) {
      uri = await clipUriFor(app, token, jobId);
      if (!uri) await new Promise((r) => setTimeout(r, 150));
    }
    expect(uri).toMatch(/^\/clips\/.+\.mp4$/);

    const row = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } }))
      .json()
      .highlights.find((h: any) => h.id === highlightId);
    // The placement audit survives the cut and names the ruling.
    expect(row.clipPlacementReason).toBe("celebration_tail");
    expect(row.clipCelebrationOffsetSec).toBeCloseTo(13, 6);
    expect(row.clipError).toBeUndefined();
    // AC2: the delivered file is the full >= 15 s card ...
    expect(row.clipDeliveredSec).toBeGreaterThanOrEqual(15);
    // ... the cue sits at the END (13 of 15, measured on the delivered file) and
    // the score-flip probe never re-centred the card.
    expect(row.clipAnchorMethod).toBe("frame_match");
    expect(row.clipAnchorDeliveredOffsetSec).toBeGreaterThanOrEqual(11);
    expect(row.clipAnchorDeliveredOffsetSec).toBeLessThanOrEqual(15);

    // Independent footage check: the cue picture is at the END of what ships.
    const clipFile = path.join(cfg.dataDir, "clips", path.basename(uri));
    const inFile = await locateImageInSource(cfg.ffmpegPath, clipFile, evJpeg, 0, 15);
    expect(inFile).not.toBeNull();
    const offset = (inFile as any).fileTs - (inFile as any).firstTs;
    expect(offset).toBeGreaterThanOrEqual(11);
    await app.close();
  }, 90_000);
});

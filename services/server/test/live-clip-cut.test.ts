import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";
import { probeDuration } from "../src/ffmpeg";

// ADAAAA-8032: the browser (screen-share) rail used to persist every highlight
// with `clipUri: ""` and cut ALL clips at `POST /jobs/:id/stop`, so every card
// read "clip processing…" for the whole share. The recording is appended during
// the share, so a highlight whose window has been flushed must be cut MID-SESSION
// — with the same window/content the stop cut would produce.

const tmp = mkdtempSync(path.join(tmpdir(), "hl-live-clip-"));
// 20 s of real footage: long enough that a >=15 s window is fully covered.
const videoPath = path.join(tmp, "rec-20s.mp4");

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
});

// ADAAAA-7285: serve a per-window audio URI so the analysis-window player plays.
// Integration test for GET /jobs/:id/windows/audio: re-extracts the window from
// the job source recording via ffmpeg and serves a valid mono 16 kHz WAV, while
// a silent (no-audio-track) source yields 404 (never a bogus playable URI).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";

const tmp = mkdtempSync(path.join(tmpdir(), "hl-winaudio-"));
// An audio-bearing source (sine tone in a video container) so ffmpeg has a real
// audio stream to extract, and a silent video-only source for the 404 case.
const withAudio = path.join(tmp, "with-audio.mp4");
const silent = path.join(tmp, "silent.mp4");

beforeAll(() => {
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=160x90:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-shortest", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", withAudio,
  ]);
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=160x90:rate=10",
    "-pix_fmt", "yuv420p", "-c:v", "libx264", "-an", silent,
  ]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function wavHeaderOk(buf: Buffer): boolean {
  return buf.length > 44 && buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WAVE";
}

describe("GET /jobs/:id/windows/audio (ADAAAA-7285)", () => {
  it("serves a valid WAV for a window re-extracted from an audio-bearing source", async () => {
    const { app, store } = await buildTestApp();
    const job = await store.createJob({ ownerId: "u1", source: "file", sourceUrl: withAudio });
    const res = await app.inject({ method: "GET", url: `/jobs/${job.id}/windows/audio?start=0.2&end=1.2` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/wav");
    expect(wavHeaderOk(res.rawPayload)).toBe(true);
    await app.close();
  });

  it("returns 404 for a silent (video-only) source so it never looks playable", async () => {
    const { app, store } = await buildTestApp();
    const job = await store.createJob({ ownerId: "u1", source: "file", sourceUrl: silent });
    const res = await app.inject({ method: "GET", url: `/jobs/${job.id}/windows/audio?start=0&end=1.2` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 404 when the source recording is gone / unknown job", async () => {
    const { app, store } = await buildTestApp();
    const job = await store.createJob({ ownerId: "u1", source: "file", sourceUrl: path.join(tmp, "missing.mp4") });
    const res = await app.inject({ method: "GET", url: `/jobs/${job.id}/windows/audio?start=0&end=1.2` });
    expect(res.statusCode).toBe(404);
    const unknown = await app.inject({ method: "GET", url: "/jobs/nope/windows/audio?start=0&end=1.2" });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it("returns 400 for a missing/invalid window range", async () => {
    const { app, store } = await buildTestApp();
    const job = await store.createJob({ ownerId: "u1", source: "file", sourceUrl: withAudio });
    const bad = await app.inject({ method: "GET", url: `/jobs/${job.id}/windows/audio?start=1&end=1` });
    expect(bad.statusCode).toBe(400);
    const noargs = await app.inject({ method: "GET", url: `/jobs/${job.id}/windows/audio` });
    expect(noargs.statusCode).toBe(400);
    await app.close();
  });
});

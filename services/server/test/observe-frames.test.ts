// ADAAAA-7734: the screen-share (media/RTC) rail must PERSIST and SERVE the
// frames it analysed.
//
// Deployed symptom (job 44d3a8a0, 3.4 min share, 21 decides): the model clearly
// saw pixels ("the frames show players in a huddle/celebration in a stadium")
// but `GET /jobs/:id/frames` 404'd, `/detail` reported `sections[].frames: 0`,
// `/observations` was empty, `progress.framesAnalyzed` was null (job page:
// "Frames shown 0", blank filmstrip tiles), and each decide note carried the
// placeholder `analysis.frames: [{seq:0, uri:""}]`. The JPEG the media node
// already POSTed with every observation was thrown away after the decide window.
//
// This test drives the real routes (observe -> stop -> read surfaces) and asserts
// the four read-side acceptance criteria end to end:
//   1. `/frames` lists >= 1 frame and `/frames/:seq` serves 200 image/jpeg bytes
//      that are byte-identical to the JPEG the media node relayed;
//   2. `/detail` partitions every analysed frame (no window renders 0 frames);
//   3. every decide note's `analysis.frames[]` names the frames that window
//      carried, and each uri resolves to 200 (no `uri: ""`);
//   4. `GET /jobs/:id` progress.framesAnalyzed == the relayed frame count.
import { describe, it, expect } from "vitest";
import { buildTestApp, fakePipeline } from "./helpers";

async function register(app: any, email: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

/** A tiny distinct "JPEG" per frame (the routes serve bytes opaquely). */
function jpeg(n: number): string {
  return Buffer.from(`jpeg-frame-${n}-payload`).toString("base64");
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition not met within timeout");
}

describe("media rail frame persistence (ADAAAA-7734)", () => {
  it("serves the frames the share analysed, the sections, the note evidence and the progress count", async () => {
    const decides: any[] = [];
    const base = fakePipeline();
    const adapter = {
      ...base,
      async decide(_evidence: any, opts: any) {
        decides.push({ opts });
        // No accept (keeps this test on the read surfaces), but a real analysis
        // block with the decide service's placeholder refs: the server must
        // replace them with the frames the window actually carried.
        return {
          isHighlight: false,
          score: 8,
          eventType: "SPORTING_EVENT",
          reason: "no goal",
          analysis: {
            prompt: "window prompt",
            dataItems: [],
            frames: [{ seq: 0, uri: "" }],
            images: [],
            audio: { uri: "", sampleRate: 16000, path: "none" },
            asr: { transcript: "" },
            response: {},
          },
        };
      },
    };
    const { app, cfg } = await buildTestApp({ LIVE_OBSERVE_LOOP: "1" }, { adapter });
    const token = await register(app, "frames7734@test.dev");
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser", gameHint: "soccer" },
    });
    expect([200, 202]).toContain(jr.statusCode);
    const jobId = jr.json().job.id as string;

    // Relay 3 frames (1 fps), as the media node does over a real share. The
    // second frame carries a track so the observation row is observable.
    const t0 = Date.now() / 1000;
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/observe`,
        payload: {
          seq: i,
          timestamp: t0 + i,
          tracks:
            i === 1
              ? [{ trackId: "p1", slot: 0, kind: "player", label: "player", bbox: [0.1, 0.1, 0.4, 0.5], lostFrames: 0 }]
              : [],
          frameB64: jpeg(i),
        },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ok: true });
    }
    // Stop settles the rail (tail decide) and drains the queued frame writes.
    const stop = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/stop`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stop.statusCode).toBe(200);
    await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: `/jobs/${jobId}/frames`, headers: { authorization: `Bearer ${token}` } });
      return r.statusCode === 200 && r.json().frames.length >= 3;
    });

    // --- AC-1: /frames lists every frame, /frames/:seq serves the real JPEG ---
    const list = await app.inject({ method: "GET", url: `/jobs/${jobId}/frames`, headers: { authorization: `Bearer ${token}` } });
    expect(list.statusCode).toBe(200);
    const frames = list.json().frames as any[];
    expect(frames.map((f) => f.seq)).toEqual([0, 1, 2]);
    expect(frames[0].uri).toBe(`/jobs/${jobId}/frames/0`);
    for (const f of frames) {
      const img = await app.inject({ method: "GET", url: f.uri, headers: { authorization: `Bearer ${token}` } });
      expect(img.statusCode).toBe(200);
      expect(img.headers["content-type"]).toMatch(/image\/jpeg/);
      // byte-identical to what the media node relayed (no re-decode / re-encode)
      expect(Buffer.from(img.rawPayload).toString("base64")).toBe(jpeg(f.seq));
    }
    // --- observations: one durable row per analysed frame (track overlay) ---
    const obs = await app.inject({ method: "GET", url: `/jobs/${jobId}/observations`, headers: { authorization: `Bearer ${token}` } });
    expect(obs.statusCode).toBe(200);
    const rows = obs.json().observations as any[];
    expect(rows.map((o) => o.seq)).toEqual([0, 1, 2]);
    expect(rows[1].tracks).toHaveLength(1);
    // content clock: rebased to the share start, never epoch seconds
    expect(rows[0].timestamp).toBe(0);
    expect(rows[2].timestamp).toBeCloseTo(2, 3);

    // --- AC-2: every analysed frame is partitioned into a section ---
    const detail = await app.inject({ method: "GET", url: `/jobs/${jobId}/detail`, headers: { authorization: `Bearer ${token}` } });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    const sectionFrames = (body.sections as any[]).flatMap((s) => s.frames);
    expect(sectionFrames.map((f) => f.seq).sort((a: number, b: number) => a - b)).toEqual([0, 1, 2]);
    expect((body.sections as any[]).every((s) => s.frames.length > 0)).toBe(true);

    // --- AC-3: decide notes name the frames their window carried, resolvable ---
    expect(decides.length).toBeGreaterThanOrEqual(1);
    // the frames handed to decide carry their global seq (so the note can name them)
    expect(decides[decides.length - 1].opts.frames.map((f: any) => f.seq)).toEqual([0, 1, 2]);
    const notes = (body.sections as any[]).flatMap((s) => s.decideNotes);
    expect(notes.length).toBeGreaterThanOrEqual(1);
    const tail = notes[notes.length - 1];
    expect(tail.analysis).toBeTruthy();
    const refs = tail.analysis.frames as any[];
    // no placeholder left behind: one ref per frame in the window, each named
    expect(refs.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(refs.every((r) => typeof r.uri === "string" && r.uri.length > 0)).toBe(true);
    for (const ref of refs) {
      const img = await app.inject({ method: "GET", url: ref.uri, headers: { authorization: `Bearer ${token}` } });
      expect(img.statusCode).toBe(200);
      expect(Buffer.from(img.rawPayload).toString("base64")).toBe(jpeg(ref.seq));
    }

    // --- AC-4: progress reads the relayed frame count, not null/0 ---
    const one = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    expect(one.statusCode).toBe(200);
    expect(one.json().progress.framesAnalyzed).toBe(3);
    expect(one.json().progress.framesTotal).toBe(3);
  });

  it("deletes a browser job's frame dir with the job", async () => {
    const { app, cfg } = await buildTestApp({ LIVE_OBSERVE_LOOP: "1" });
    const token = await register(app, "frames7734-del@test.dev");
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser" },
    });
    const jobId = jr.json().job.id as string;
    await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/observe`,
      payload: { seq: 0, timestamp: Date.now() / 1000, tracks: [], frameB64: jpeg(0) },
    });
    await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: `/jobs/${jobId}/frames`, headers: { authorization: `Bearer ${token}` } });
      return r.statusCode === 200;
    });
    await app.inject({ method: "POST", url: `/jobs/${jobId}/stop`, headers: { authorization: `Bearer ${token}` } });
    await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: `/jobs/${jobId}/frames`, headers: { authorization: `Bearer ${token}` } });
      return r.statusCode === 200;
    });
    // The retained frames live under data/live/<jobId>/frames; DELETE removes it.
    const { existsSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(cfg.dataDir, "live", jobId);
    expect(existsSync(dir)).toBe(true);
    const del = await app.inject({ method: "DELETE", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    expect(del.statusCode).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });
});

// ADAAAA-8776 route proof: the media node's FIRST session-naming callback binds
// the share, registers its `media_sessions` row, and the match-context fold then
// posts at that session instead of "".
//
// This is the shape of job `4cd84e86`: `POST /jobs` (browser) never calls
// `POST /jobs/:id/media` (the harness opened the session on the node itself), so
// the only places the control plane can learn the session id are the node's
// callbacks. Before the fix that meant `bj.mediaSessionId` stayed undefined for
// the whole share and every fold was skipped.
import { describe, expect, it } from "vitest";

import { buildTestApp, fakePipeline } from "./helpers";

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

describe("ADAAAA-8776: a share that never called POST /jobs/:id/media", () => {
  it("adopts the node session from the frame-tick callback and settles the row at share end", async () => {
    const { app, db } = await buildTestApp({ LIVE_OBSERVE_LOOP: "1", MATCH_CONTEXT: "1" });
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "adopt8776@test.dev", password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    const token = reg.json().token as string;

    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser", gameHint: "soccer" },
    });
    expect([200, 202]).toContain(jr.statusCode);
    const jobId = jr.json().job.id as string;

    // The media node reports its publish clock ~1/s, naming the session it paid
    // for. Nothing has provisioned through the control plane.
    const now = Math.floor(Date.now() / 1000);
    const frames = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media/frames`,
      payload: { sessionId: "16ee75dc-node", frames: [{ seq: 0, timestamp: now }] },
    });
    expect(frames.statusCode).toBe(200);
    expect(frames.json().recorded).toBe(1);

    const row = await until(() => db.getMediaSession(jobId));
    expect(row, "the share's media_sessions row is registered").toBeTruthy();
    expect(row!.sessionId).toBe("16ee75dc-node");
    expect(row!.status).toBe("active");
    // A callback carries no browser endpoint; provisionMedia must not reuse it.
    expect(row!.wsUrl).toBe("");

    // A late callback from a different (older) session must not move the share.
    const stale = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media/frames`,
      payload: { sessionId: "older-session", frames: [{ seq: 1, timestamp: now + 1 }] },
    });
    expect(stale.statusCode).toBe(200);
    expect((await db.getMediaSession(jobId))!.sessionId).toBe("16ee75dc-node");

    const stop = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/stop`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect([200, 202]).toContain(stop.statusCode);

    const settled = await until(async () => {
      const r = await db.getMediaSession(jobId);
      return r && r.status === "closed" ? r : undefined;
    });
    expect(settled, "the job's terminal transition settles the adopted row").toBeTruthy();
    expect(settled!.sessionId).toBe("16ee75dc-node");
  }, 30000);

  it("posts the match-context fold at the adopted session", async () => {
    const base = fakePipeline();
    const folds: Array<{ sessionId: string; body: any }> = [];
    const adapter = {
      ...base,
      async postMatchContext(sessionId: string, body: any) {
        folds.push({ sessionId, body });
        return {
          matchContext: {
            sport: "soccer",
            teams: [{ name: "RMA", side: "home", kitColors: [], confidence: 0.8, evidence: [] }],
            inferredAt: "2026-11-12T00:00:00.000Z",
            resolverVersion: 1,
            ambiguous: false,
            trail: [],
          },
        };
      },
    };
    const { app, store } = await buildTestApp(
      { LIVE_OBSERVE_LOOP: "1", MATCH_CONTEXT: "1", LIVE_OBSERVE_CADENCE_S: "1", LIVE_OBSERVE_WINDOW_S: "1" },
      { adapter }
    );
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "adopt8776fold@test.dev", password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    const token = reg.json().token as string;
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser", gameHint: "soccer" },
    });
    const jobId = jr.json().job.id as string;

    const now = Math.floor(Date.now() / 1000);
    await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media/frames`,
      payload: { sessionId: "16ee75dc-fold", frames: [{ seq: 0, timestamp: now }] },
    });
    // Observations carry the anchor JPEG the decide needs; two cadence windows
    // are enough to fire the first decide (which is what triggers the fold).
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/observe`,
        payload: {
          sessionId: "16ee75dc-fold",
          seq: i,
          timestamp: now + i * 1.5,
          tracks: [],
          frameB64: Buffer.from("frame").toString("base64"),
        },
      });
    }
    const fold = await until(async () => (folds.length ? folds[0] : undefined), 8000);
    expect(fold, "a fold posted").toBeTruthy();
    expect(fold!.sessionId).toBe("16ee75dc-fold");
    // The point of the fold: `matchContext` LANDS on the record. On job
    // `4cd84e86` it stayed NULL because the fold target was "".
    const stored = await until(async () => store.getJob(jobId)?.matchContext as any, 5000);
    expect(stored?.teams?.[0]?.name).toBe("RMA");
  }, 30000);
});

// ADAAAA-8419: the consume stride's skipped frames surface in the window audit
// at the ROUTE level, not only in the builder.
//
// $0 proof: no inference, no GPU, no media node — the rail is fed through the
// same `POST /jobs/:id/observe` route the media node uses, and the audit is read
// back through the composite detail, the sections delta and the per-section
// inspect route the webapp actually calls. The parity number is the rail's own
// `liveProgress.strideFramesSkipped` (machine evidence), compared against the
// grey-tile evidence the payload carries.
import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers";

async function register(app: any, email: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

function jpeg(n: number): string {
  return Buffer.from(`jpeg-8419-${n}`).toString("base64");
}

/** A live browser share whose rail consumes at 1 content fps. */
async function liveShare(email: string) {
  const { app, store } = await buildTestApp({ LIVE_OBSERVE_LOOP: "1", LIVE_OBSERVE_CONTENT_FPS: "1" });
  const token = await register(app, email);
  const jr = await app.inject({
    method: "POST",
    url: "/jobs",
    headers: { authorization: `Bearer ${token}` },
    payload: { source: "browser", gameHint: "soccer" },
  });
  expect([200, 202]).toContain(jr.statusCode);
  const jobId = jr.json().job.id as string;
  const t0 = Date.now() / 1000;
  const feed = async (timestamps: number[]) => {
    for (let i = 0; i < timestamps.length; i++) {
      const r = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/observe`,
        payload: { seq: i, timestamp: timestamps[i], tracks: [], frameB64: jpeg(i) },
      });
      expect(r.statusCode).toBe(200);
    }
  };
  const detail = async () =>
    app.inject({ method: "GET", url: `/jobs/${jobId}/detail`, headers: { authorization: `Bearer ${token}` } });
  const light = async () =>
    app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
  return { app, store, token, jobId, t0, feed, detail, light };
}

describe("window audit skipped[] parity on a live share (ADAAAA-8419 AC-3/AC-5)", () => {
  it("one skipped tile per refused frame in the window, matching the rail's count", async () => {
    const { feed, detail, light, t0 } = await liveShare("skip8419a@test.dev");
    // 15 relayed frames 0.25 s apart (~3.6 content s) at a 1 fps consume rate.
    await feed(Array.from({ length: 15 }, (_, i) => t0 + i * 0.25));

    const lightRes = await light();
    expect(lightRes.statusCode).toBe(200);
    const strided = Number(lightRes.json().liveProgress?.strideFramesSkipped);
    expect(strided).toBeGreaterThan(0);

    const res = await detail();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const sections = body.sections as any[];
    const tiles = sections.flatMap((s) => s.skipped ?? []);
    // AC-3: grey tiles == the rail's refused frames, within one boundary frame.
    expect(Math.abs(tiles.length - strided)).toBeLessThanOrEqual(1);
    // Each tile is timestamp-only: no seq/uri/tracks, inside its window.
    for (const s of sections) {
      for (const tile of s.skipped ?? []) {
        expect(Object.keys(tile).sort()).toEqual(["reason", "timestamp"]);
        expect(tile.reason).toBe("stride");
        expect(tile.timestamp).toBeGreaterThanOrEqual(s.startS);
        expect(tile.timestamp).toBeLessThan(s.endS);
      }
      const ts = (s.skipped ?? []).map((t: any) => t.timestamp);
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
    }
    // AC-6 (light read): GET /jobs/:id carries no skipped evidence — the audit
    // field is detail-only, so the light poll's payload is unchanged in shape.
    expect(lightRes.json().job.skipped).toBeUndefined();
    expect(JSON.stringify(lightRes.json())).not.toContain("skippedTimestamps");
  });

  it("sections-delta and per-section inspect carry the same skipped[] (AC-5)", async () => {
    const { app, token, jobId, feed, detail, t0 } = await liveShare("skip8419b@test.dev");
    await feed(Array.from({ length: 15 }, (_, i) => t0 + i * 0.25));
    const full = (await detail()).json();
    const fullSections = new Map<number, any[]>((full.sections as any[]).map((s) => [s.index, s.skipped ?? []]));

    const delta = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}/sections-delta?afterIndex=-1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(delta.statusCode).toBe(200);
    for (const s of delta.json().sections as any[]) {
      expect(s.skipped ?? []).toEqual(fullSections.get(s.index) ?? []);
    }

    // Every section that carries evidence serves it on the inspect route too.
    let inspected = 0;
    for (const [index, tiles] of fullSections) {
      if (!tiles.length) continue;
      const inspect = await app.inject({
        method: "GET",
        url: `/jobs/${jobId}/sections/${index}/inspect`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(inspect.statusCode).toBe(200);
      const payload = inspect.json();
      expect(payload.skipped ?? []).toEqual(tiles);
      inspected++;
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it("caps the audit at 30 tiles/section and states the remainder", async () => {
    const { app, token, jobId, feed, t0 } = await liveShare("skip8419c@test.dev");
    // 250 frames over 4 content seconds (20 ms apart) at 1 fps: ~3 consumed and
    // far more than 30 refused inside a single 3 s window.
    await feed(Array.from({ length: 250 }, (_, i) => t0 + i * 0.02));
    const res = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}/detail`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const capped = (res.json().sections as any[]).filter((s) => (s.skippedTotal ?? 0) > s.skipped.length);
    expect(capped.length).toBeGreaterThan(0);
    for (const s of capped) {
      expect(s.skipped.length).toBe(30);
      expect(s.skippedTotal).toBeGreaterThan(30);
    }
  });
});

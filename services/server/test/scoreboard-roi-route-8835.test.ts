/**
 * ADAAAA-8835 (Inc 1): the per-job score-bug pin at the REAL routes.
 *
 * The unit tests next door cover the pure pieces. These run `buildTestApp`
 * (in-memory sqlite, fake pipeline, no GPU, no live leg) because the defects this
 * ticket grades live in the CALLERS:
 *
 *  - AC6: `scoreboardSurface` is readable in the job API for every live and VOD
 *    job, with a truthful `source`. An operator pin must read `explicit` the
 *    moment the job exists (declared), and never `discovery`.
 *  - AC4: an unpinned submit leaves the record and the analyze body byte-identical
 *    — no key, no `undefined`, no empty array.
 *  - A malformed box is a 422 at create and leaves NO job row (silently dropping
 *    it would scope the OCR back onto whatever discovery picked).
 */
import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers";
import { buildLiveAnalyzerConfig, withScoreboardRoi } from "../src/api";
import { parseScoreboardRoi } from "../src/scoreboard-surface";
import { DirectAdapter } from "../src/livepeer-adapter";
import { loadConfig } from "../src/config";

async function registerUser(app: any, email: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

const PIN = [0, 0, 0.55, 0.18];

describe("POST /jobs — a pinned live job is readable with truthful provenance (AC6)", () => {
  it("stores the pin and a declared `explicit` surface before any frame runs", async () => {
    const { app, store } = await buildTestApp();
    const token = await registerUser(app, "roi-pin@test.dev");
    const r = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser", gameHint: "soccer", scoreboardRoi: PIN },
    });
    expect(r.statusCode).toBe(200);
    const jobId = r.json().job.id;

    const stored = store.getJob(jobId) as any;
    expect(stored.scoreboardRoi).toEqual(PIN);
    // Declared, not observed: -1 means no frame has reported the crop yet.
    expect(stored.scoreboardSurface).toEqual({
      roi: PIN,
      source: "explicit",
      seqFirstSeen: -1,
      verified: false,
    });

    const got = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().job.scoreboardRoi).toEqual(PIN);
    expect(got.json().job.scoreboardSurface.source).toBe("explicit");
    await app.close();
  });

  it("an unpinned submit carries neither key (AC4: record byte-identical)", async () => {
    const { app, store } = await buildTestApp();
    const token = await registerUser(app, "roi-bare@test.dev");
    const r = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser", gameHint: "soccer" },
    });
    expect(r.statusCode).toBe(200);
    const jobId = r.json().job.id;
    const stored = store.getJob(jobId) as any;
    expect(Object.prototype.hasOwnProperty.call(stored, "scoreboardRoi")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(stored, "scoreboardSurface")).toBe(false);
    const got = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(Object.prototype.hasOwnProperty.call(got.json().job, "scoreboardRoi")).toBe(false);
    await app.close();
  });

  it("a malformed box is a 422 with `invalid_scoreboard_roi` and creates no job row", async () => {
    const { app, store } = await buildTestApp();
    const token = await registerUser(app, "roi-bad@test.dev");
    const before = store.listAllJobs().length;
    for (const bad of [[0, 0, 0.5], [0, 0, 0.5, 2], [0.6, 0, 0.5, 0.2], "nope"]) {
      const r = await app.inject({
        method: "POST",
        url: "/jobs",
        headers: { authorization: `Bearer ${token}` },
        payload: { source: "browser", gameHint: "soccer", scoreboardRoi: bad },
      });
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe("invalid_scoreboard_roi");
    }
    expect(store.listAllJobs().length).toBe(before);
    await app.close();
  });
});

describe("VOD upload rail — the pin rides the upload session to the job row", () => {
  it("POST /jobs/upload/init refuses a malformed box before staging any byte", async () => {
    const { app } = await buildTestApp();
    const token = await registerUser(app, "roi-vod-bad@test.dev");
    const r = await app.inject({
      method: "POST",
      url: "/jobs/upload/init",
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: "clip.mp4", size: 1024, mime: "video/mp4", scoreboardRoi: [0.5, 0.5, 0.2, 0.9] },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("invalid_scoreboard_roi");
    await app.close();
  });
});

describe("the pin rides every /app/analyze for that job (AC1 delivery)", () => {
  it("buildLiveAnalyzerConfig puts the pin on the per-analyze calibration", () => {
    const cfg = loadConfig({ PERCEIVE_URL: "http://p", DECIDE_URL: "http://d" });
    const pinned = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-pin", scoreboardRoi: PIN as any },
      clipWindow: { clipBeforeS: 3, clipAfterS: 3 },
    });
    expect(pinned.calibration?.scoreboardRoi).toEqual(PIN);
    const bare = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-bare" },
      clipWindow: { clipBeforeS: 3, clipAfterS: 3 },
    });
    expect(bare.calibration?.scoreboardRoi).toBeUndefined();
  });

  it("the adapter body carries the pin once per call (not per frame state)", async () => {
    const cfg = loadConfig({ PERCEIVE_URL: "http://p", DECIDE_URL: "http://d" });
    const bodies: any[] = [];
    const fetchMock = async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ seq: 0, tracks: [] }), { status: 200 });
    };
    (globalThis as any).fetch = fetchMock as any;
    const adapter = new DirectAdapter(cfg);
    await adapter.analyze("s", { seq: 0, timestamp: 0, imageB64: "AA" }, { gameHint: "soccer", scoreboardRoi: PIN });
    expect(bodies[0].scoreboardRoi).toEqual(PIN);
    expect(Object.prototype.hasOwnProperty.call(bodies[0], "scoreboardRoi")).toBe(true);
  });
});

describe("the 422 gate is wired BEFORE the quota gate (no silent drop)", () => {
  it("parseScoreboardRoi is called from the jobs route before the subscription read", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    // Scope to the POST /jobs handler: the file has many earlier
    // getSubscription calls on other routes.
    const routeAt = src.indexOf('"/jobs",');
    expect(routeAt).toBeGreaterThan(0);
    const handler = src.slice(routeAt, routeAt + 12_000);
    const roiAt = handler.indexOf("const roiInput = parseScoreboardRoi(req.body?.scoreboardRoi);");
    const subAt = handler.indexOf("const sub = await db.getSubscription(user.id);");
    expect(roiAt).toBeGreaterThan(0);
    expect(subAt).toBeGreaterThan(0);
    expect(roiAt).toBeLessThan(subAt);
    // and the pin is merged into the calibration rather than dropped
    expect(withScoreboardRoi(undefined, PIN as any)).toEqual({ scoreboardRoi: PIN });
    expect(parseScoreboardRoi(PIN)).toEqual({ ok: true, roi: PIN });
  });
});

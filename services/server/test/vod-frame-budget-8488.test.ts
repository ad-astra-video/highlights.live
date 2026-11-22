// ADAAAA-8488 — `VOD_MAX_FRAMES_PER_ANALYSIS` was a no-op.
//
// The filing (2026-11-09): `VOD_MAX_FRAMES_PER_ANALYSIS=8` was set and
// `printenv`-proved on `highlights-server`, yet `decide_audit.frame_count` stayed
// at ~16 on the challenger arm, so an 8-frame VOD posture was not constructible
// and ADAAAA-8132's 8-frame price could not be verified.
//
// Root cause: the env reached `cfg.vodMaxFramesPerAnalysis` and was forwarded as
// `AnalyzerConfig.maxFramesPerAnalysis`, which only `assembleFrameSequence` (the
// Increment F trigger-window assembler) consumes — and no VOD decide path calls
// it. The VOD observe pass builds its decide images with `assembleObserveWindow`
// from `AnalyzerConfig.observeMaxFrames`, which the VOD builder never set, so the
// window stayed at the shared 30-frame ceiling (~11-16 frames in-window).
//
// This suite pins the fix at the two levels that matter:
//   1. resolution — the env is bounded at load (unset => the 30-frame ceiling,
//      i.e. today's window; a set value => [1, 30]); and
//   2. the served shape — a real VOD job through `buildTestApp` (real ffmpeg
//      extraction, fake perceive/decide adapter) carries <= budget frames per
//      decide, and the frame count lands on the durable `decide_audit` row the
//      ticket grades. The control arm (env unset) carries MORE than the budget,
//      so the fix is proven to bind rather than the test passing by accident.
//
// The frame count a decide call carries is what the decide service records as
// `decide_audit.frame_count` (`services/decide/app/__init__.py`: `"frameCount":
// len(req.frames)`), so the adapter below echoes that same measurement.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp, testCfg, waitForJob } from "./helpers";
import { loadConfig } from "../src/config";
import { OBSERVE_MAX_FRAMES, resolveVodDecideImageBudget } from "../src/observe-loop";

const DETAIL_FPS = 2;
const FRAME_COUNT = 48; // 24 s at 2 fps

/** The env the deployed VOD box runs the observe pass with. */
const VOD_ENV = {
  OBSERVE_LOOP: "1",
  VOD_DETAIL_FPS: String(DETAIL_FPS),
  VOD_RESUME_CHECKPOINT_WINDOWS: "1",
};

/**
 * Counting fake perceive/decide adapter. `decide` records the frames the call
 * carried (the number the decide service would write as `frameCount`) and echoes
 * a compact audit descriptor with that same measurement, so the server's real
 * `persistDecideAudit` path writes the row this test reads back.
 */
function frameBudgetAdapter() {
  const state = {
    decideCalls: 0,
    frameCounts: [] as number[],
  };
  return {
    state,
    async reservePerceive() {
      return { sessionId: `sess-8488-${state.decideCalls}`, appUrl: "", controlUrl: "" };
    },
    async analyze(_sid: string, frame: any) {
      return { observation: { tracks: [], seq: frame.seq, timestamp: frame.timestamp } };
    },
    async decide(_evidence: any, decideOpts: any) {
      state.decideCalls++;
      const frames = Array.isArray(decideOpts?.frames) ? decideOpts.frames : [];
      state.frameCounts.push(frames.length);
      const groupKey = String(decideOpts?.groupKey ?? "g0");
      const jobId = String(decideOpts?.jobId ?? "job");
      return {
        isHighlight: false,
        score: 0,
        eventType: "GOAL",
        outcome: "not_highlight",
        // Mirrors the decide service's `_audit` descriptor: frameCount is the
        // number of frames the request actually carried.
        audit: {
          jobId,
          sessionId: jobId,
          groupKey,
          timestamp: null,
          frameCount: frames.length,
          candidateCount: 1,
          params: {},
          createdAt: Date.now() / 1000,
        },
      };
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
    async stopPerceive() {},
  };
}

async function register(app: any, email: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

function decideAuditRows(t: any, jobId: string) {
  return (t.db as any).db
    .prepare("SELECT group_key, frame_count FROM decide_audit WHERE job_id = ? ORDER BY group_key")
    .all(jobId) as { group_key: string; frame_count: number | null }[];
}

/** Run one real VOD job over the fixture and return the frames each decide call
 * carried plus the job's durable decide_audit rows. */
async function runVodJob(env: Record<string, string>, email: string) {
  const adapter = frameBudgetAdapter();
  const t = await buildTestApp({ ...VOD_ENV, ...env }, { adapter });
  const token = await register(t.app, email);
  const sub = await t.app.inject({
    method: "POST",
    url: "/jobs",
    headers: { authorization: `Bearer ${token}` },
    payload: { videoPath: videoPath, gameHint: "soccer" },
  });
  expect(sub.statusCode).toBe(202);
  const jobId = sub.json().job.id as string;
  const done = await waitForJob(t.app, jobId, token, 120000);
  const rows = decideAuditRows(t, jobId);
  await t.app.close();
  return { cfg: t.cfg, done, counts: adapter.state.frameCounts, rows };
}

let tmp = "";
let videoPath = "";
let priorMatchContext: string | undefined;

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "hl-vod-frame-budget-"));
  videoPath = path.join(tmp, "match.mp4");
  execFileSync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=duration=24:size=320x180:rate=${DETAIL_FPS}`,
    "-pix_fmt",
    "yuv420p",
    videoPath,
  ]);
  // Keep the once-per-job match-context resolver (CPU ASR probe) out of a test
  // that measures decide payloads; it is irrelevant to the frame budget.
  priorMatchContext = process.env.MATCH_CONTEXT;
  process.env.MATCH_CONTEXT = "0";
});

afterAll(() => {
  if (priorMatchContext === undefined) delete process.env.MATCH_CONTEXT;
  else process.env.MATCH_CONTEXT = priorMatchContext;
  rmSync(tmp, { recursive: true, force: true });
});

describe("VOD decide frame budget resolution (ADAAAA-8488 AC1, cheap half)", () => {
  it("unset resolves to the 30-frame shared ceiling — the pre-8488 window, byte-identical", () => {
    expect(loadConfig({}).vodMaxFramesPerAnalysis).toBe(OBSERVE_MAX_FRAMES);
    // The compose line is `${VOD_MAX_FRAMES_PER_ANALYSIS:-}`, so a host that does
    // not set it hands the container an EMPTY string, not an absent var.
    expect(loadConfig({ VOD_MAX_FRAMES_PER_ANALYSIS: "" }).vodMaxFramesPerAnalysis).toBe(OBSERVE_MAX_FRAMES);
    expect(testCfg({}).vodMaxFramesPerAnalysis).toBe(OBSERVE_MAX_FRAMES);
  });

  it("a set value is honoured, and clamped into [1, ceiling] so a typo cannot raise or disable the cap", () => {
    expect(loadConfig({ VOD_MAX_FRAMES_PER_ANALYSIS: "8" }).vodMaxFramesPerAnalysis).toBe(8);
    expect(loadConfig({ VOD_MAX_FRAMES_PER_ANALYSIS: "1" }).vodMaxFramesPerAnalysis).toBe(1);
    expect(loadConfig({ VOD_MAX_FRAMES_PER_ANALYSIS: "99" }).vodMaxFramesPerAnalysis).toBe(OBSERVE_MAX_FRAMES);
    expect(loadConfig({ VOD_MAX_FRAMES_PER_ANALYSIS: "0" }).vodMaxFramesPerAnalysis).toBe(OBSERVE_MAX_FRAMES);
    expect(loadConfig({ VOD_MAX_FRAMES_PER_ANALYSIS: "-4" }).vodMaxFramesPerAnalysis).toBe(OBSERVE_MAX_FRAMES);
    expect(loadConfig({ VOD_MAX_FRAMES_PER_ANALYSIS: "abc" }).vodMaxFramesPerAnalysis).toBe(OBSERVE_MAX_FRAMES);
    expect(resolveVodDecideImageBudget(1.7)).toBe(1);
    expect(resolveVodDecideImageBudget(8)).toBe(8);
  });
});

describe("VOD decide frame budget end to end (ADAAAA-8488 AC1 served half)", () => {
  it("VOD_MAX_FRAMES_PER_ANALYSIS=8 bounds every VOD decide call (and the decide_audit row) to <= 8 frames", async () => {
    const { cfg, done, counts, rows } = await runVodJob(
      { VOD_MAX_FRAMES_PER_ANALYSIS: "8" },
      "vod-budget-8@test.dev"
    );
    expect(done.job.status).toBe("done");
    expect(done.job.framesTotal).toBe(FRAME_COUNT);
    // The budget the job resolved (the value the VOD analyzer config carried).
    expect(cfg.vodMaxFramesPerAnalysis).toBe(8);

    expect(counts.length).toBeGreaterThan(0);
    // Print the measurement even though the assertions pass: a pass is evidence,
    // not the absence of a number.
    console.log(`[vod-frame-budget] VOD_MAX_FRAMES_PER_ANALYSIS=8 decide frame counts: ${JSON.stringify(counts)}`);
    // AC1: no decide call exceeds the configured budget.
    expect(Math.max(...counts)).toBeLessThanOrEqual(8);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(mean).toBeLessThanOrEqual(8);
    // ...and the cap actually BOUND: a 10 s window at 2 fps supplies more than 8
    // frames, so a full window carries exactly 8 rather than passing trivially.
    expect(Math.max(...counts)).toBe(8);

    // The durable row the ticket grades carries the same measurement.
    expect(rows.length).toBeGreaterThan(0);
    const rowCounts = rows.map((r) => Number(r.frame_count)).filter((n) => Number.isFinite(n));
    expect(rowCounts.length).toBeGreaterThan(0);
    console.log(`[vod-frame-budget] decide_audit.frame_count rows: ${JSON.stringify(rowCounts)}`);
    expect(Math.max(...rowCounts)).toBeLessThanOrEqual(8);
    expect(rowCounts.reduce((a, b) => a + b, 0) / rowCounts.length).toBeLessThanOrEqual(8);
  }, 180000);

  it("control: with the env unset the same job carries MORE than 8 frames — the knob is what binds", async () => {
    const { cfg, done, counts } = await runVodJob({}, "vod-budget-unset@test.dev");
    expect(done.job.status).toBe("done");
    expect(cfg.vodMaxFramesPerAnalysis).toBe(OBSERVE_MAX_FRAMES);

    expect(counts.length).toBeGreaterThan(0);
    console.log(`[vod-frame-budget] env unset decide frame counts: ${JSON.stringify(counts)}`);
    // Pre-8488 posture: the window is NOT thinned to 8, so this arm is strictly
    // denser. (It is the arm the ticket measured at ~16 frames.)
    expect(Math.max(...counts)).toBeGreaterThan(8);
  }, 180000);
});

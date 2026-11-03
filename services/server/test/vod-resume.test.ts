// ADAAAA-7906 — VOD resume, Increments 1+2 (checkpoint contract, phase skip,
// failure classification and auto-retry).
//
// These tests drive the REAL in-process server (buildTestApp -> buildApp ->
// durable VOD worker) against a counting fake perceive/decide adapter, with the
// observe loop enabled exactly as the box runs it (OBSERVE_LOOP=1). Extraction
// is real ffmpeg over a generated clip, so the frame directory, its mtimes and
// the decide cadence are the deployed ones.
//
// Acceptance criteria covered here:
//   AC1  a failure during `analyzing` persists resume.phase/cursorTs/lastError
//   AC2  a resume does not re-run extraction (mtime unchanged)
//   AC3  a resume re-perceives only the bounded warm-up + remaining frames
//   AC4  a resume does not re-issue a window at or before the cursor
//   AC5  store counts are unchanged by the second attempt
//   AC6  transient retries up to the budget then terminal failed; a permanent
//        failure lands terminal failed on the first attempt with no retry
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp, waitForJob } from "./helpers";
import {
  RESUME_BACKOFF_CAP_MS,
  extractionReusable,
  mergeResumeCheckpoint,
  resumeRetryDelayMs,
  resumeStartTs,
  resumeWarmupFrames,
  resumeWarmupS,
  shouldArmResumeRetry,
} from "../src/vod-resume";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Frame geometry for the fixture: 24 s at 2 fps => 48 frames, and a 4-frame
 * decide window (2 s of content) so the warm-up maths are easy to assert. */
const DETAIL_FPS = 2;
const DECIDE_WINDOW_N = 4;
const WARMUP_S = resumeWarmupS(DECIDE_WINDOW_N, DETAIL_FPS); // 2 s
const WARMUP_FRAMES = resumeWarmupFrames(WARMUP_S, DETAIL_FPS); // 4

const ENV = {
  OBSERVE_LOOP: "1",
  VOD_DETAIL_FPS: String(DETAIL_FPS),
  VOD_DECIDE_WINDOW_N: String(DECIDE_WINDOW_N),
  // Persist the checkpoint on every applied window so a failure mid-analyze
  // always has a landed cursor.
  VOD_RESUME_CHECKPOINT_WINDOWS: "1",
  VOD_MAX_FRAMES_PER_ANALYSIS: "8",
};

/**
 * Counting fake perceive/decide adapter.
 *
 * - `analyze` counts every per-frame perceive call (AC3's budget).
 * - `decide` records the window's group key (`g<floor(ts/3)>`, the same key the
 *   real request carries) and can fail the Nth call (AC1/AC2) or every call
 *   (AC6 exhaustion) with a decide 5xx, which `classifyVodFailure` maps to
 *   `decide-unavailable`.
 */
function resumeAdapter(opts: { failDecideCall?: number; failAllDecide?: boolean } = {}) {
  const state = {
    reserveCount: 0,
    stopCount: 0,
    analyzeCalls: 0,
    decideCalls: 0,
    decideKeys: [] as string[],
    failedDecide: false,
  };
  return {
    state,
    async reservePerceive() {
      state.reserveCount++;
      return { sessionId: `sess-${state.reserveCount}`, appUrl: "", controlUrl: "" };
    },
    async analyze(_sid: string, frame: any) {
      state.analyzeCalls++;
      return { observation: { tracks: [], seq: frame.seq, timestamp: frame.timestamp } };
    },
    async decide(_evidence: any, decideOpts: any) {
      state.decideCalls++;
      state.decideKeys.push(String(decideOpts?.groupKey ?? ""));
      const shouldFail = opts.failAllDecide === true;
      const nthFail =
        typeof opts.failDecideCall === "number" && state.decideCalls === opts.failDecideCall && !state.failedDecide;
      if (shouldFail || nthFail) {
        state.failedDecide = true;
        throw new Error("decide failed: HTTP 503");
      }
      return { isHighlight: false, score: 0, eventType: "GOAL", outcome: "not_highlight" };
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
    async stopPerceive() {
      state.stopCount++;
    },
  };
}

async function register(app: any, email: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

async function getJob(app: any, jobId: string, token: string) {
  const r = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
  expect(r.statusCode).toBe(200);
  return r.json();
}

/** Poll until `predicate(job)` holds — used to observe the armed retry before
 * the worker claims attempt 2. */
async function waitForJobState(
  app: any,
  jobId: string,
  token: string,
  predicate: (job: any) => boolean,
  timeoutMs = 20000
): Promise<any> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await getJob(app, jobId, token);
    if (predicate(body.job)) return body;
    await sleep(20);
  }
  throw new Error(`job ${jobId} did not reach the expected state within ${timeoutMs}ms`);
}

function frameFiles(frameDir: string): string[] {
  return readdirSync(frameDir).filter((f) => f.startsWith("frame_"));
}

describe("vod-resume pure contract (ADAAAA-7906)", () => {
  it("merges a checkpoint patch and keeps cursorTs forward-only", () => {
    const first = mergeResumeCheckpoint(undefined, {
      phase: "analyze",
      analyze: { cursorTs: 12 },
      attempts: [{ attempt: 1, startedAt: "t0" }],
      totalAttempts: 1,
    });
    expect(first.version).toBe(1);
    expect(first.phase).toBe("analyze");
    expect(first.analyze?.cursorTs).toBe(12);
    expect(first.totalAttempts).toBe(1);
    // A later patch that carries a SMALLER cursor (a late/duplicate write) can
    // never move the cursor back — that is what protects the decide bill.
    const second = mergeResumeCheckpoint(first, { analyze: { cursorTs: 3, decideWindows: 4 } });
    expect(second.analyze?.cursorTs).toBe(12);
    expect(second.analyze?.decideWindows).toBe(4);
    // Nested blocks merge field by field: the attempt trail survives.
    expect(second.attempts).toHaveLength(1);
  });

  it("clears an armed retry when the patch passes null, and keeps phase on a bare merge", () => {
    const armed = mergeResumeCheckpoint(undefined, {
      phase: "analyze",
      nextAttemptAt: "2030-01-01T00:00:00.000Z",
    });
    expect(armed.nextAttemptAt).toBe("2030-01-01T00:00:00.000Z");
    const cleared = mergeResumeCheckpoint(armed, { nextAttemptAt: null });
    expect(cleared.nextAttemptAt).toBeUndefined();
    expect(cleared.phase).toBe("analyze");
  });

  it("computes the warm-up as windowN/fps capped at the 10 s observe window", () => {
    expect(resumeWarmupS(24, 3)).toBe(8);
    expect(resumeWarmupS(60, 3)).toBe(10); // capped
    expect(resumeWarmupS(undefined, 3)).toBe(10);
    expect(resumeWarmupFrames(2, 2)).toBe(4);
  });

  it("starts the resumed iterator one warm-up before the cursor, never at 0 for a cursor job", () => {
    expect(resumeStartTs(0, 8)).toBe(0);
    expect(resumeStartTs(12, 2)).toBe(10);
    expect(resumeStartTs(1, 8)).toBe(0);
  });

  it("skips extraction only when the marker, the frame dir and the source identity all agree", () => {
    const ck = mergeResumeCheckpoint(undefined, {
      phase: "analyze",
      extraction: {
        complete: true,
        frameCount: 48,
        fps: 2,
        scale: "640:360",
        sourceBytes: 1000,
        sourceMtimeMs: 5000,
        completedAt: "t",
      },
    });
    const ok = { frameDirUsable: true, source: { bytes: 1000, mtimeMs: 5000 } };
    expect(extractionReusable(ck, ok)).toBe(true);
    expect(extractionReusable(ck, { ...ok, frameDirUsable: false })).toBe(false);
    expect(extractionReusable(ck, { ...ok, source: null })).toBe(false);
    expect(extractionReusable(ck, { ...ok, source: { bytes: 999, mtimeMs: 5000 } })).toBe(false);
    expect(extractionReusable(undefined, ok)).toBe(false);
  });

  it("arms at most VOD_RESUME_MAX_ATTEMPTS retries and backs off exponentially to the cap", () => {
    expect(shouldArmResumeRetry(true, undefined, 2)).toBe(true);
    const oneFail = mergeResumeCheckpoint(undefined, {
      attempts: [{ attempt: 1, startedAt: "a", endedAt: "b" }],
    });
    expect(shouldArmResumeRetry(true, oneFail, 2)).toBe(true);
    const twoFails = mergeResumeCheckpoint(undefined, {
      attempts: [
        { attempt: 1, startedAt: "a", endedAt: "b" },
        { attempt: 2, startedAt: "c", endedAt: "d" },
      ],
    });
    expect(shouldArmResumeRetry(true, twoFails, 2)).toBe(false);
    expect(shouldArmResumeRetry(false, undefined, 2)).toBe(false);
    expect(resumeRetryDelayMs(0, 30_000)).toBe(30_000);
    expect(resumeRetryDelayMs(1, 30_000)).toBe(60_000);
    expect(resumeRetryDelayMs(9, 30_000)).toBe(RESUME_BACKOFF_CAP_MS);
  });
});

describe("VOD resume end to end (ADAAAA-7906 AC1-AC6)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hl-vod-resume-"));
  const videoPath = path.join(tmp, "match.mp4");
  let priorMatchContext: string | undefined;

  beforeAll(() => {
    // 24 s of content at 2 fps => 48 extracted frames (frame_000001..48).
    execFileSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=24:size=320x180:rate=2",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ]);
    // Keep the once-per-job match-context resolver (CPU ASR probe) out of these
    // timing-sensitive assertions; it is irrelevant to resume semantics.
    priorMatchContext = process.env.MATCH_CONTEXT;
    process.env.MATCH_CONTEXT = "0";
  });

  afterAll(() => {
    if (priorMatchContext === undefined) delete process.env.MATCH_CONTEXT;
    else process.env.MATCH_CONTEXT = priorMatchContext;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("AC1-AC5: a failed analyze pass checkpoints, resumes without re-extraction or re-judging, and completes", async () => {
    // Fail the 6th decide call: the pass has already APPLIED windows ~0..12 s of
    // content, so the cursor is well past 0 and the resumed pass has a real tail.
    const adapter = resumeAdapter({ failDecideCall: 6 });
    const t = await buildTestApp({ ...ENV, VOD_RESUME_BACKOFF_MS: "600", VOD_RESUME_MAX_ATTEMPTS: "2" }, { adapter });
    const token = await register(t.app, "resume-ok@test.dev");

    const sub = await t.app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "soccer" },
    });
    expect(sub.statusCode).toBe(202);
    const jobId = sub.json().job.id as string;

    // ---- AC1 + AC2 evidence at the failure, before the retry is claimed -----
    const failedSnap = await waitForJobState(
      t.app,
      jobId,
      token,
      (j) => j.status === "queued" && j.stage === "retry-scheduled"
    );
    const failedJob = failedSnap.job;
    expect(failedJob.resume).toBeTruthy();
    expect(failedJob.resume.phase).toBe("analyze");
    expect(failedJob.resume.analyze.cursorTs).toBeGreaterThan(0);
    expect(failedJob.resume.lastError.reason).toBe("decide-unavailable");
    expect(failedJob.resume.lastError.message).toMatch(/decide failed/i);
    // Not terminal: an armed retry with a due time, and a closed attempt entry.
    expect(failedJob.resume.nextAttemptAt).toBeTruthy();
    expect(failedJob.resume.attempts).toHaveLength(1);
    expect(failedJob.resume.attempts[0].endedAt).toBeTruthy();
    expect(failedJob.resume.attempts[0].failedAtPhase).toBe("analyze");
    expect(failedJob.resume.attempts[0].failureReason).toBe("decide-unavailable");
    expect(failedJob.resume.totalAttempts).toBe(1);
    // The extraction marker is on the record (the skip predicate's input).
    expect(failedJob.resume.extraction.complete).toBe(true);
    expect(failedJob.resume.extraction.frameCount).toBe(48);

    const frameDir = path.join(t.cfg.dataDir, "frames", jobId);
    const filesBefore = frameFiles(frameDir);
    expect(filesBefore).toHaveLength(48);
    const mtimeBefore = statSync(path.join(frameDir, filesBefore[0])).mtimeMs;
    const extractionCompletedAt = failedJob.resume.extraction.completedAt;
    const analyzeCallsAttempt1 = adapter.state.analyzeCalls;
    const cursorTs = failedJob.resume.analyze.cursorTs as number;
    const decideKeysAttempt1 = adapter.state.decideKeys.length;
    expect(decideKeysAttempt1).toBeGreaterThan(0);
    const highlightsBefore = t.store.highlightsForJob(jobId).length;

    // ---- the retry runs and completes ---------------------------------------
    const done = await waitForJob(t.app, jobId, token, 60000);
    expect(done.job.status).toBe("done");
    expect(done.job.attempts).toBe(2);
    expect(done.job.resume.totalAttempts).toBe(2);

    // AC2: extraction was NOT re-run — same frame files, byte-identical mtime,
    // same completion marker. `extractFrames` begins with `rm -rf`, so an
    // untouched mtime proves the directory was never wiped and rewritten.
    const filesAfter = frameFiles(frameDir);
    expect(filesAfter).toHaveLength(48);
    expect(statSync(path.join(frameDir, filesAfter[0])).mtimeMs).toBe(mtimeBefore);
    expect(done.job.resume.extraction.completedAt).toBe(extractionCompletedAt);

    // AC3: the resumed pass re-perceived only the bounded warm-up + the tail.
    const attempt2Analyze = adapter.state.analyzeCalls - analyzeCallsAttempt1;
    const frameStartTs = resumeStartTs(cursorTs, WARMUP_S);
    const skippedFrames = Math.ceil(frameStartTs * DETAIL_FPS);
    const remaining = 48 - skippedFrames;
    expect(attempt2Analyze).toBeGreaterThan(0);
    expect(attempt2Analyze).toBeLessThanOrEqual(WARMUP_FRAMES + remaining);
    // Not proportional to the full frame count: the skipped span is never paid.
    expect(attempt2Analyze).toBeLessThan(48);
    expect(skippedFrames).toBeGreaterThan(WARMUP_FRAMES);

    // AC4: no window at or before the cursor is re-issued. The first decide of
    // the resumed attempt is anchored after the cursor's cadence bucket.
    const attempt2Keys = adapter.state.decideKeys.slice(decideKeysAttempt1);
    expect(attempt2Keys.length).toBeGreaterThan(0);
    const cursorBucket = Math.floor(cursorTs / 3);
    expect(Number(attempt2Keys[0].replace(/^g/, ""))).toBeGreaterThanOrEqual(cursorBucket);
    // ... and VOD decide spend is not a usage_events row at all, so the ledger
    // cannot double-debit on a resume (job.costUsd/decideCalls carry it).
    const decideUsage = (t.db as any).db
      .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE event_type = 'decide'")
      .get();
    expect(decideUsage.n).toBe(0);

    // AC5: the second attempt duplicated no highlight / clip.
    expect(t.store.highlightsForJob(jobId).length).toBe(highlightsBefore);
    expect(done.job.highlightsFound).toBe(highlightsBefore);
    let clipFiles: string[] = [];
    try {
      clipFiles = readdirSync(path.join(t.cfg.dataDir, "clips")).filter((f) => f.endsWith(".mp4"));
    } catch {
      clipFiles = []; // the clips dir is created on the first cut only
    }
    expect(clipFiles).toHaveLength(highlightsBefore);

    await t.app.close();
  }, 120000);

  it("AC6: a transient failure retries up to VOD_RESUME_MAX_ATTEMPTS then lands terminal failed with the classified reason", async () => {
    const adapter = resumeAdapter({ failAllDecide: true });
    const t = await buildTestApp({ ...ENV, VOD_RESUME_BACKOFF_MS: "200", VOD_RESUME_MAX_ATTEMPTS: "1" }, { adapter });
    const token = await register(t.app, "resume-exhaust@test.dev");

    const sub = await t.app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "soccer" },
    });
    expect(sub.statusCode).toBe(202);
    const jobId = sub.json().job.id as string;

    const body = await waitForJob(t.app, jobId, token, 60000);
    const job = body.job;
    expect(job.status).toBe("failed");
    expect(job.stage).toBe("failed");
    expect(job.failureReason).toBe("decide-unavailable");
    expect(job.attempts).toBe(2); // 1 initial + 1 retry (budget = 1)
    expect(job.resume.totalAttempts).toBe(2);
    expect(job.resume.attempts).toHaveLength(2);
    for (const a of job.resume.attempts) {
      expect(a.failedAtPhase).toBe("analyze");
      expect(a.failureReason).toBe("decide-unavailable");
      expect(a.endedAt).toBeTruthy();
    }
    // The budget is spent: no retry armed, so the drain filter can never loop.
    expect(job.resume.nextAttemptAt).toBeUndefined();
    expect(job.resume.lastError.reason).toBe("decide-unavailable");

    await t.app.close();
  }, 120000);

  it("AC6: a classified-permanent failure (corrupt source) lands terminal failed on the first attempt with no retry", async () => {
    const corrupt = path.join(tmp, "corrupt.mp4");
    writeFileSync(corrupt, "this is not a video file");
    const adapter = resumeAdapter();
    const t = await buildTestApp({ ...ENV, VOD_RESUME_BACKOFF_MS: "200", VOD_RESUME_MAX_ATTEMPTS: "2" }, { adapter });
    const token = await register(t.app, "resume-corrupt@test.dev");

    const sub = await t.app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath: corrupt, gameHint: "soccer" },
    });
    expect(sub.statusCode).toBe(202);
    const jobId = sub.json().job.id as string;

    const body = await waitForJob(t.app, jobId, token, 60000);
    const job = body.job;
    expect(job.status).toBe("failed");
    expect(job.failureReason).toBe("pipeline-error");
    expect(job.attempts).toBe(1);
    expect(job.resume.totalAttempts).toBe(1);
    expect(job.resume.nextAttemptAt).toBeUndefined();
    expect(job.resume.attempts).toHaveLength(1);
    expect(job.resume.attempts[0].failedAtPhase).toBe("extract");
    expect(job.resume.lastError.reason).toBe("pipeline-error");
    // No retry ran: the decide adapter was never reached.
    expect(adapter.state.analyzeCalls).toBe(0);

    await t.app.close();
  }, 120000);
});

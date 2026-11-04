// ADAAAA-7907 — VOD resume, Increments 3+4 (manual resume route, webapp Resume
// action server side, cost/attempt accounting and boot recovery).
//
// The route matrix (AC7), the cross-attempt accounting (AC9), the one-line-per-
// attempt evidence (AC10), the stop-wins-over-a-retry rule and the restart
// simulation all run against the REAL in-process server: `buildTestApp` builds
// `buildApp` (durable VOD worker + Fastify routes) over a counting fake
// perceive/decide adapter, with real ffmpeg extraction of a generated clip, so
// the frame directory and its mtimes are the deployed ones.
//
// Boot recovery is simulated the way a restart actually looks: the job row is
// interrupted mid-analyze in the DB, the first app is closed, and a SECOND app
// (a second Store) is built over the same database file and data dir.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp, waitForJob } from "./helpers";
import {
  accumulateAttemptTotals,
  closeOpenAttempt,
  formatResumeAttemptLine,
  interruptedAttemptEvidence,
  nextAttemptNumber,
  recordAttemptProgress,
  resumeEligibleSource,
  resumePointLabel,
} from "../src/vod-resume";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DETAIL_FPS = 2;
const DECIDE_WINDOW_N = 4;
const FRAME_COUNT = 48; // 24 s at 2 fps

const ENV = {
  OBSERVE_LOOP: "1",
  VOD_DETAIL_FPS: String(DETAIL_FPS),
  VOD_DECIDE_WINDOW_N: String(DECIDE_WINDOW_N),
  VOD_RESUME_CHECKPOINT_WINDOWS: "1",
  VOD_MAX_FRAMES_PER_ANALYSIS: "8",
};

/** The shape AC10 pins: fixed prefix, fixed key order. */
const RESUME_LINE =
  /^\[vod-resume\] attempt=(\d+) phase=(extract|analyze|finalize) resumedFromTs=([\d.]+) skippedFrames=(\d+) warmupFrames=(\d+) decideCalls=(\d+) perceiveCalls=(\d+)$/;

/** AC10 crash half: the line boot recovery synthesizes for a KILLED attempt. */
const RESUME_RECOVERED_LINE =
  /^\[vod-resume\] attempt=(\d+) phase=(extract|analyze|finalize) resumedFromTs=([\d.]+) skippedFrames=(\d+) warmupFrames=(\d+) decideCalls=(\d+) perceiveCalls=(\d+) recovered=true$/;

/** The counters the killed attempt had PERSISTED at its last checkpoint write
 * (AC10 crash half). Distinct values, so the synthesized line's fields are
 * proven to come from disk rather than from a default. */
const KILLED_SKIPPED_FRAMES = 8;
const KILLED_WARMUP_FRAMES = 4; // resumeWarmupFrames(windowN=4, fps=2) = 4
const KILLED_DECIDE_CALLS = 3;
const KILLED_PERCEIVE_CALLS = 40;

/** Counting fake perceive/decide adapter (same shape as vod-resume.test.ts). */
function resumeAdapter(opts: { failDecideCall?: number; failAllDecide?: boolean } = {}) {
  const state = {
    reserveCount: 0,
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
    async stopPerceive() {},
  };
}

async function register(app: any, email: string, password = "password123"): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

async function login(app: any, email: string, password = "password123"): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

/** The seeded platform admin (testCfg ADMIN_EMAIL/ADMIN_PASSWORD): the only
 * caller that receives the spend diagnostics (ADAAAA-7727). */
async function adminToken(app: any): Promise<string> {
  return login(app, "admin@test.local", "adminpass");
}

async function getJob(app: any, jobId: string, token: string) {
  const r = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
  expect(r.statusCode).toBe(200);
  return r.json();
}

async function waitForState(
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

/** Submit one VOD job and return its id. */
async function submit(app: any, token: string, videoPath: string): Promise<string> {
  const sub = await app.inject({
    method: "POST",
    url: "/jobs",
    headers: { authorization: `Bearer ${token}` },
    payload: { videoPath, gameHint: "soccer" },
  });
  expect(sub.statusCode).toBe(202);
  return sub.json().job.id as string;
}

/** Collect the `[vod-resume]` lines logged while `fn` runs. */
async function captureResumeLines<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  const spy = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[vod-resume]")) lines.push(line);
    // Keep the rest quiet: this suite asserts on the evidence line, not on the
    // pipeline's own chatter (which would flood the vitest report).
  });
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    spy.mockRestore();
    void original;
  }
}

describe("vod-resume Inc 3+4 pure parts (ADAAAA-7907)", () => {
  it("sums an attempt's deltas onto the cross-attempt accumulators (AC9)", () => {
    const prev = { decideCalls: 12, perceiveSessionS: 30, costUsd: 0.25, wallClockS: 100 };
    const totals = accumulateAttemptTotals(prev, {
      decideCalls: 8,
      perceiveSessionS: 10,
      costUsd: 0.1,
      wallClockS: 40,
    });
    expect(totals).toEqual({ decideCalls: 20, perceiveSessionS: 40, costUsd: 0.35, wallClockS: 140 });
    // A first attempt (no prior block) reports only its own deltas.
    expect(accumulateAttemptTotals(undefined, { decideCalls: 3, perceiveSessionS: 1.25, costUsd: 0.01, wallClockS: 9.5 })).toEqual({
      decideCalls: 3,
      perceiveSessionS: 1.3,
      costUsd: 0.01,
      wallClockS: 9.5,
    });
    // Negative / garbage input can never reduce a total.
    expect(accumulateAttemptTotals(prev, { decideCalls: -5, wallClockS: Number.NaN }).decideCalls).toBe(12);
  });

  it("closes only the OPEN attempt entry, and only once", () => {
    const open = [
      { attempt: 1, startedAt: "a", endedAt: "b", failureReason: "decide-unavailable" as const },
      { attempt: 2, startedAt: "c" },
    ];
    const closed = closeOpenAttempt(open, { now: "d", phase: "analyze", reason: "server-restart" });
    expect(closed).toHaveLength(2);
    expect(closed[0].endedAt).toBe("b"); // already closed — untouched
    expect(closed[1]).toMatchObject({ endedAt: "d", failedAtPhase: "analyze", failureReason: "server-restart" });
    // Idempotent: nothing is open any more.
    const again = closeOpenAttempt(closed, { now: "e", phase: "analyze", reason: "server-restart" });
    expect(again[1]).toEqual(closed[1]);
  });

  it("reserves the next CLAIM number so totalAttempts never double-increments", () => {
    expect(nextAttemptNumber(undefined)).toBe(1);
    expect(nextAttemptNumber({ version: 1, phase: "analyze", attempts: [], totalAttempts: 1 })).toBe(2);
    // A failed, armed attempt: attempts trail and counter agree.
    const armed = {
      version: 1 as const,
      phase: "analyze" as const,
      attempts: [{ attempt: 1, startedAt: "a", endedAt: "b" }],
      totalAttempts: 1,
    };
    expect(nextAttemptNumber(armed)).toBe(2);
    // A crash left the claim counter ahead of the closed trail: the counter wins.
    expect(nextAttemptNumber({ ...armed, totalAttempts: 3 })).toBe(4);
  });

  it("only a VOD `file` job is resume-eligible (the scope guard)", () => {
    // A live/browser share has no source to replay, and a `queued` live row is
    // never reclaimed by the VOD drain: arming a retry on one would strand it
    // non-terminal forever, so the policy refuses anything but `file`.
    expect(resumeEligibleSource("file")).toBe(true);
    for (const source of ["browser", "rtmp", "webrtc", "screenshare", "file-sim", undefined] as const) {
      expect(resumeEligibleSource(source)).toBe(false);
    }
  });

  it("formats T+mm:ss and the one greppable evidence line per attempt (AC10)", () => {
    expect(resumePointLabel(0)).toBeNull();
    expect(resumePointLabel(undefined)).toBeNull();
    expect(resumePointLabel(30)).toBe("T+00:30");
    expect(resumePointLabel(750)).toBe("T+12:30");
    expect(resumePointLabel(3930)).toBe("T+1:05:30");
    const line = formatResumeAttemptLine({
      attempt: 2,
      phase: "analyze",
      resumedFromTs: 12,
      skippedFrames: 24,
      warmupFrames: 4,
      decideCalls: 7,
      perceiveCalls: 30,
    });
    expect(line).toBe(
      "[vod-resume] attempt=2 phase=analyze resumedFromTs=12.0 skippedFrames=24 warmupFrames=4 decideCalls=7 perceiveCalls=30"
    );
    expect(line).toMatch(RESUME_LINE);
  });

  it("records the OPEN attempt's running counters so a killer's crash keeps evidence (AC10 crash half)", () => {
    const trail = [
      { attempt: 1, startedAt: "a", endedAt: "b", failureReason: "decide-unavailable" as const },
      { attempt: 2, startedAt: "c" },
    ];
    const recorded = recordAttemptProgress(trail, {
      resumedFromTs: 12.5,
      skippedFrames: 24,
      warmupFrames: 4,
      decideCalls: 7,
      perceiveCalls: 30,
    })!;
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toMatchObject({
      attempt: 2,
      resumedFromTs: 12.5,
      skippedFrames: 24,
      warmupFrames: 4,
      decideCalls: 7,
      perceiveCalls: 30,
    });
    expect(recorded[1].endedAt).toBeUndefined(); // still open — the attempt is live
    expect(recorded[0]).toEqual(trail[0]); // a closed attempt is never rewritten
    // No open entry -> nothing to write, so the caller skips the DB write.
    expect(recordAttemptProgress([{ attempt: 1, startedAt: "a", endedAt: "b" }], { decideCalls: 3 })).toBeUndefined();
    expect(recordAttemptProgress(undefined, { decideCalls: 3 })).toBeUndefined();
    // Garbage / negative values keep the previous value instead of corrupting it.
    const kept = recordAttemptProgress(recorded, { decideCalls: Number.NaN, perceiveCalls: -4 })!;
    expect(kept[1].decideCalls).toBe(7);
    expect(kept[1].perceiveCalls).toBe(30);
  });

  it("synthesizes the killed attempt's line at recovery, marked recovered (AC10 crash half)", () => {
    const checkpoint = {
      version: 1 as const,
      phase: "analyze" as const,
      analyze: { cursorTs: 48 },
      attempts: [
        { attempt: 1, startedAt: "a", endedAt: "b" },
        { attempt: 2, startedAt: "c", resumedFromTs: 12.5, skippedFrames: 24, warmupFrames: 4, decideCalls: 7, perceiveCalls: 30 },
      ],
      totalAttempts: 2,
    };
    const evidence = interruptedAttemptEvidence(checkpoint);
    expect(evidence).toMatchObject({ attempt: 2, phase: "analyze", recovered: true, decideCalls: 7 });
    const line = formatResumeAttemptLine(evidence!);
    expect(line).toBe(
      "[vod-resume] attempt=2 phase=analyze resumedFromTs=12.5 skippedFrames=24 warmupFrames=4 decideCalls=7 perceiveCalls=30 recovered=true"
    );
    expect(line).toMatch(RESUME_RECOVERED_LINE);
    // Every attempt closed -> no synthesized line. A `failed` row's attempt already
    // emitted its own line, so a manual resume must never add a second row for it.
    expect(
      interruptedAttemptEvidence({ ...checkpoint, attempts: [{ attempt: 1, startedAt: "a", endedAt: "b" }] })
    ).toBeNull();
    expect(interruptedAttemptEvidence(undefined)).toBeNull();
  });
});

describe("VOD resume Inc 3+4 end to end (ADAAAA-7907 AC7, AC9, AC10)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hl-vod-resume34-"));
  const videoPath = path.join(tmp, "match.mp4");
  let priorMatchContext: string | undefined;

  beforeAll(() => {
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
    priorMatchContext = process.env.MATCH_CONTEXT;
    process.env.MATCH_CONTEXT = "0";
  });

  afterAll(() => {
    if (priorMatchContext === undefined) delete process.env.MATCH_CONTEXT;
    else process.env.MATCH_CONTEXT = priorMatchContext;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("AC7: refuses another user (403), is idempotent while a retry is armed (200), and a stop keeps winning", async () => {
    // Fail the 4th decide with a retry budget of 1 and a short backoff, so the
    // job sits `queued`/`retry-scheduled` with `nextAttemptAt` armed — the exact
    // state AC7's idempotent branch is about.
    const adapter = resumeAdapter({ failAllDecide: true });
    const t = await buildTestApp(
      { ...ENV, VOD_RESUME_BACKOFF_MS: "1500", VOD_RESUME_MAX_ATTEMPTS: "1" },
      { adapter }
    );
    const owner = await register(t.app, "inc34-matrix@test.dev");
    const other = await register(t.app, "inc34-other@test.dev");
    const jobId = await submit(t.app, owner, videoPath);

    const armedSnap = await waitForState(
      t.app,
      jobId,
      owner,
      (j) => j.status === "queued" && j.stage === "retry-scheduled" && !!j.resume?.nextAttemptAt
    );
    expect(armedSnap.job.resume.totalAttempts).toBe(1);

    // 403 — another user's job.
    const forbidden = await t.app.inject({
      method: "POST",
      url: `/jobs/${jobId}/resume`,
      headers: { authorization: `Bearer ${other}` },
    });
    expect(forbidden.statusCode).toBe(403);

    // 200 alreadyQueued — a retry is already armed; the counter must NOT move.
    const idem = await t.app.inject({
      method: "POST",
      url: `/jobs/${jobId}/resume`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(idem.statusCode).toBe(200);
    expect(idem.json().alreadyQueued).toBe(true);
    expect((await getJob(t.app, jobId, owner)).job.resume.totalAttempts).toBe(1);

    // Stop wins over the armed retry: cancelled, retry cleared, and the retry
    // timer fires nothing (the drain filter can never claim a cancelled row).
    const stopped = await t.app.inject({
      method: "POST",
      url: `/jobs/${jobId}/stop`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(stopped.statusCode).toBe(200);
    const cancelled = await getJob(t.app, jobId, owner);
    expect(cancelled.job.status).toBe("cancelled");
    expect(cancelled.job.resume?.nextAttemptAt).toBeUndefined();
    await sleep(2500); // past the 1.5 s backoff the armed retry would have fired at
    const still = await getJob(t.app, jobId, owner);
    expect(still.job.status).toBe("cancelled");
    expect(still.job.attempts).toBe(1);

    // 409 — cancelled is terminal; resume must refuse it.
    const refused = await t.app.inject({
      method: "POST",
      url: `/jobs/${jobId}/resume`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("terminal");

    await t.app.close();
  }, 120000);

  it("AC7/AC9/AC10: a manual resume of a failed job returns 202, resumes at the cursor and totals both attempts", async () => {
    // Fail the 4th decide with NO retry budget: the job lands terminal `failed`
    // with a checkpoint whose cursor is past zero — the manual-resume case.
    const adapter = resumeAdapter({ failDecideCall: 4 });
    const t = await buildTestApp({ ...ENV, VOD_RESUME_MAX_ATTEMPTS: "0" }, { adapter });
    const owner = await register(t.app, "inc34-manual@test.dev");
    const admin = await adminToken(t.app);

    const submittedAt = Date.now();
    const jobId = await submit(t.app, owner, videoPath);
    await waitForJob(t.app, jobId, owner, 60000);
    // AC9 is graded on the operator payload (the admin read carries the spend
    // diagnostics; the owner read is asserted separately below).
    const failed = await getJob(t.app, jobId, admin);
    expect(failed.job.status).toBe("failed");
    expect(failed.job.failureReason).toBe("decide-unavailable");
    expect(failed.job.resume.nextAttemptAt).toBeUndefined();
    expect(failed.job.resume.totalAttempts).toBe(1);
    expect(failed.job.resume.analyze.cursorTs).toBeGreaterThan(0);
    // The failed attempt's spend was persisted (not only the last checkpoint
    // write): AC9 needs it as the base for the resumed attempt's totals.
    expect(failed.job.resume.accumulators.decideCalls).toBeGreaterThan(0);
    const attempt1ElapsedS = (Date.now() - submittedAt) / 1000;

    const frameDir = path.join(t.cfg.dataDir, "frames", jobId);
    const filesBefore = frameFiles(frameDir);
    expect(filesBefore).toHaveLength(FRAME_COUNT);
    const mtimeBefore = statSync(path.join(frameDir, filesBefore[0])).mtimeMs;
    const cursorTs = failed.job.resume.analyze.cursorTs as number;
    const analyzeCallsAtFailure = adapter.state.analyzeCalls;

    // ---- 202: armed, queued, resume-queued, retry cleared, attempt reserved --
    const resumeStartedAt = Date.now();
    const resumed = await t.app.inject({
      method: "POST",
      url: `/jobs/${jobId}/resume`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(resumed.statusCode).toBe(202);
    const armedJob = resumed.json().job;
    expect(armedJob.status).toBe("queued");
    expect(armedJob.stage).toBe("resume-queued");
    expect(armedJob.resume.nextAttemptAt).toBeUndefined();
    expect(armedJob.resume.totalAttempts).toBe(2);
    expect(armedJob.resume.resumedFromTs).toBe(cursorTs);
    // The terminal attribution moves to the attempt trail: a running job must
    // not keep the old failure chip (AC8).
    expect(armedJob.failureReason).toBeUndefined();
    expect(armedJob.resume.attempts[0].failureReason).toBe("decide-unavailable");
    expect(resumed.json().resumedFromTs).toBe(cursorTs);
    expect(resumed.json().attempt).toBe(2);
    // The projected resume block a non-admin owner receives is the same shape
    // the webapp renders (no spend accumulators — ADAAAA-7727).
    expect(armedJob.resume.accumulators).toBeUndefined();

    // ---- it completes, resuming from the cursor ----------------------------
    await waitForJob(t.app, jobId, owner, 60000);
    const done = await getJob(t.app, jobId, admin);
    const job = done.job;
    expect(job.status).toBe("done");
    expect(job.attempts).toBe(2);
    expect(job.resume.totalAttempts).toBe(2); // == number of claims (AC9)
    expect(job.resume.attempts).toHaveLength(2);
    expect(job.resume.attempts[0].failureReason).toBe("decide-unavailable");
    expect(job.resume.attempts[0].endedAt).toBeTruthy();
    expect(job.resume.attempts[1].endedAt).toBeTruthy();
    expect(job.resume.maxAttempts).toBe(1); // 1 initial claim + 0 retries

    // Extraction was NOT re-run: same frames, byte-identical mtime.
    expect(frameFiles(frameDir)).toHaveLength(FRAME_COUNT);
    expect(statSync(path.join(frameDir, filesBefore[0])).mtimeMs).toBe(mtimeBefore);

    // The resumed attempt only paid the warm-up + tail, never the skipped span.
    const attempt2Analyze = adapter.state.analyzeCalls - analyzeCallsAtFailure;
    expect(attempt2Analyze).toBeGreaterThan(0);
    expect(attempt2Analyze).toBeLessThan(FRAME_COUNT);

    // ---- AC9: job-level spend + the meter cover BOTH attempts --------------
    const accum = job.resume.accumulators;
    expect(accum.decideCalls).toBeGreaterThan(failed.job.resume.accumulators.decideCalls);
    expect(job.vodMeter.decideCalls).toBe(accum.decideCalls);
    expect(job.decideCalls).toBe(accum.decideCalls);
    expect(job.vodMeter.costUsd).toBe(accum.costUsd);
    expect(job.costUsd).toBe(accum.costUsd);
    expect(job.vodMeter.wallClockS).toBe(accum.wallClockS);
    // Totals must at least cover both attempts' own wall clocks: the second
    // attempt alone would be strictly less than attempt1 + attempt2.
    const attempt2ElapsedS = (Date.now() - resumeStartedAt) / 1000;
    // The meter must be the SUM of the two attempts, not the second alone: it
    // exceeds the failed attempt's own recorded wall clock, and the remainder
    // covers the second attempt's measured duration.
    const attempt1WallS = failed.job.resume.accumulators.wallClockS as number;
    expect(attempt1WallS).toBeGreaterThan(0);
    expect(job.vodMeter.wallClockS).toBeGreaterThan(attempt1WallS);
    expect(job.vodMeter.wallClockS - attempt1WallS).toBeGreaterThanOrEqual(attempt2ElapsedS - 0.5);
    void attempt1ElapsedS;

    // ---- AC7: 409 on done ------------------------------------------------
    const onDone = await t.app.inject({
      method: "POST",
      url: `/jobs/${jobId}/resume`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(onDone.statusCode).toBe(409);
    expect(onDone.json().code).toBe("terminal");

    // AC8 payload: the OWNER's read of the same record keeps the resume trail
    // and loses the spend block.
    const ownerView = await getJob(t.app, jobId, owner);
    expect(ownerView.job.resume.resumedFromTs).toBe(cursorTs);
    expect(ownerView.job.resume.totalAttempts).toBe(2);
    expect(ownerView.job.resume.accumulators).toBeUndefined();
    expect(ownerView.job.vodMeter).toBeUndefined();

    await t.app.close();
  }, 180000);

  it("AC10: exactly one [vod-resume] line per attempt, with all seven fields", async () => {
    // Fail the 3rd decide, then let the automatic retry finish the job: two
    // attempts, two lines — no more, no fewer (the mid-pass lines that used to
    // fire on some paths are gone).
    const adapter = resumeAdapter({ failDecideCall: 3 });
    const t = await buildTestApp(
      { ...ENV, VOD_RESUME_BACKOFF_MS: "200", VOD_RESUME_MAX_ATTEMPTS: "1" },
      { adapter }
    );
    const owner = await register(t.app, "inc34-lines@test.dev");

    const { result: done, lines } = await captureResumeLines(async () => {
      const jobId = await submit(t.app, owner, videoPath);
      return waitForJob(t.app, jobId, owner, 90000);
    });
    expect(done.job.status).toBe("done");
    expect(done.job.attempts).toBe(2);

    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => {
      const m = l.match(RESUME_LINE);
      expect(m, `line did not match the AC10 shape: ${l}`).toBeTruthy();
      return {
        attempt: Number(m![1]),
        phase: m![2],
        resumedFromTs: Number(m![3]),
        skippedFrames: Number(m![4]),
        warmupFrames: Number(m![5]),
        decideCalls: Number(m![6]),
        perceiveCalls: Number(m![7]),
      };
    });
    // One line per attempt, in claim order, attempt numbers unique.
    expect(parsed.map((p) => p.attempt)).toEqual([1, 2]);
    // Attempt 1 started at zero and perceived/counted real work.
    expect(parsed[0].resumedFromTs).toBe(0);
    expect(parsed[0].skippedFrames).toBe(0);
    expect(parsed[0].decideCalls).toBeGreaterThan(0);
    expect(parsed[0].perceiveCalls).toBeGreaterThan(0);
    // Attempt 2 resumed at the cursor, skipped the already-judged span, and
    // re-perceived only the bounded warm-up plus the tail.
    expect(parsed[1].resumedFromTs).toBeGreaterThan(0);
    expect(parsed[1].skippedFrames).toBeGreaterThan(parsed[1].warmupFrames);
    expect(parsed[1].perceiveCalls).toBeLessThan(FRAME_COUNT);

    await t.app.close();
  }, 180000);
});

describe("VOD resume boot recovery (ADAAAA-7907 Increment 4)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hl-vod-resume34-boot-"));
  const videoPath = path.join(tmp, "match.mp4");
  const dataDir = path.join(tmp, "data");
  const dbPath = path.join(tmp, "restart.sqlite");
  let priorMatchContext: string | undefined;

  beforeAll(() => {
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
    priorMatchContext = process.env.MATCH_CONTEXT;
    process.env.MATCH_CONTEXT = "0";
  });

  afterAll(() => {
    if (priorMatchContext === undefined) delete process.env.MATCH_CONTEXT;
    else process.env.MATCH_CONTEXT = priorMatchContext;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a second store over the same DB resumes at the cursor, not from zero", async () => {
    const email = "inc34-boot@test.dev";
    // ---- first process: a pass that fails after judging a few windows ------
    // Fail the 4th decide so the pass judges a few windows first: the cursor the
    // restart must resume from has to be > 0 for the assertion to mean anything.
    const adapterA = resumeAdapter({ failDecideCall: 4 });
    const appA = await buildTestApp(
      { ...ENV, DATA_DIR: dataDir, DATABASE_PATH: dbPath, VOD_RESUME_MAX_ATTEMPTS: "0", VOD_RESUME_BACKOFF_MS: "200" },
      { adapter: adapterA }
    );
    const ownerA = await register(appA.app, email);
    const jobId = await submit(appA.app, ownerA, videoPath);
    const failed = await waitForJob(appA.app, jobId, ownerA, 60000);
    expect(failed.job.status).toBe("failed");
    // The spend accumulator is only on the operator payload (ADAAAA-7727).
    const failedAdmin = await getJob(appA.app, jobId, await adminToken(appA.app));
    expect(failedAdmin.job.resume.analyze.cursorTs).toBeGreaterThan(0);
    expect(failedAdmin.job.resume.extraction.complete).toBe(true);

    const frameDir = path.join(dataDir, "frames", jobId);
    const filesBefore = frameFiles(frameDir);
    expect(filesBefore).toHaveLength(FRAME_COUNT);
    const mtimeBefore = statSync(path.join(frameDir, filesBefore[0])).mtimeMs;
    const cursorTs = failedAdmin.job.resume.analyze.cursorTs as number;
    const attempt1Acc = failedAdmin.job.resume.accumulators;

    // ---- simulate the crash: the row is interrupted mid-analyze -----------
    // Boot recovery only sweeps NON-terminal rows, so the interrupted state has
    // to look the way a real process death leaves it: status analyzing + the
    // open attempt the claim appended. That is written straight to the DB (the
    // in-memory store of app A dies with the process).
    const interrupted = {
      ...failedAdmin.job,
      status: "analyzing" as const,
      stage: "analyzing",
      failureReason: undefined,
      attempts: 2,
      resume: {
        ...failedAdmin.job.resume,
        phase: "analyze" as const,
        attempts: [
          ...failedAdmin.job.resume.attempts,
          // ADAAAA-7907 (AC10): attempt 2 was CLAIMED and killed mid-analyze, so
          // its entry carries what its last checkpoint write persisted — the start
          // values plus the running counters. That is the evidence boot recovery
          // has to report for an attempt that never ran its exit hook.
          {
            attempt: 2,
            startedAt: new Date().toISOString(),
            resumedFromTs: cursorTs,
            skippedFrames: KILLED_SKIPPED_FRAMES,
            warmupFrames: KILLED_WARMUP_FRAMES,
            decideCalls: KILLED_DECIDE_CALLS,
            perceiveCalls: KILLED_PERCEIVE_CALLS,
          },
        ],
        totalAttempts: 2,
      },
    };
    await appA.db.saveJob(interrupted as any);
    await appA.app.close();

    // ---- second process: a fresh Store + app over the SAME db and data dir --
    const adapterB = resumeAdapter();
    const { result, lines } = await captureResumeLines(async () => {
      const appB = await buildTestApp(
        { ...ENV, DATA_DIR: dataDir, DATABASE_PATH: dbPath, VOD_RESUME_MAX_ATTEMPTS: "2", VOD_RESUME_BACKOFF_MS: "200" },
        { adapter: adapterB }
      );
      const ownerB = await login(appB.app, email);
      await waitForJob(appB.app, jobId, ownerB, 90000);
      // The operator payload carries the spend; label it clearly.
      const body = await getJob(appB.app, jobId, await adminToken(appB.app));
      return { appB, ownerB, body };
    });
    const { appB, ownerB, body } = result;

    // The pass resumed and completed instead of restarting from zero.
    expect(body.job.status).toBe("done");
    expect(body.job.sourceUrl).toBe(videoPath);
    // The interrupted attempt was CLOSED as a server restart, and the resumed
    // claim is attempt 3 — totalAttempts == claims.
    expect(body.job.resume.totalAttempts).toBe(body.job.attempts);
    const closed = body.job.resume.attempts.filter((a: any) => a.attempt === 2)[0];
    expect(closed.endedAt).toBeTruthy();
    expect(closed.failureReason).toBe("server-restart");
    expect(closed.failedAtPhase).toBe("analyze");

    // Extraction was not re-run (frame mtimes byte-identical): the resume
    // skipped the extract phase entirely.
    expect(frameFiles(frameDir)).toHaveLength(FRAME_COUNT);
    expect(statSync(path.join(frameDir, filesBefore[0])).mtimeMs).toBe(mtimeBefore);

    // Perceive paid only the warm-up + tail, never the whole pass.
    expect(adapterB.state.analyzeCalls).toBeGreaterThan(0);
    expect(adapterB.state.analyzeCalls).toBeLessThan(FRAME_COUNT);

    // The decide bill is protected: the first decide of the resumed attempt is
    // anchored at/after the cursor's cadence bucket.
    expect(adapterB.state.decideKeys.length).toBeGreaterThan(0);
    expect(Number(adapterB.state.decideKeys[0].replace(/^g/, ""))).toBeGreaterThanOrEqual(
      Math.floor(cursorTs / 3)
    );

    // AC9 across a restart: the failed attempt's spend is still in the totals.
    expect(body.job.vodMeter.decideCalls).toBeGreaterThan(attempt1Acc.decideCalls);
    expect(body.job.vodMeter.decideCalls).toBe(body.job.resume.accumulators.decideCalls);
    expect(body.job.vodMeter.wallClockS).toBeGreaterThanOrEqual(attempt1Acc.wallClockS ?? 0);

    // AC10: TWO lines now — one synthesized at boot recovery for the attempt the
    // kill took out (no exit hook ran), one measured for the resumed attempt. The
    // crash case is the incident class this criterion exists for, so a grep has to
    // count both.
    expect(lines).toHaveLength(2);
    const killedLine = lines[0].match(RESUME_RECOVERED_LINE);
    expect(killedLine, `unexpected recovered evidence line: ${lines[0]}`).toBeTruthy();
    expect(Number(killedLine![1])).toBe(2);
    expect(killedLine![2]).toBe("analyze");
    expect(Number(killedLine![3])).toBe(cursorTs);
    expect(Number(killedLine![4])).toBe(KILLED_SKIPPED_FRAMES);
    expect(Number(killedLine![5])).toBe(KILLED_WARMUP_FRAMES);
    expect(Number(killedLine![6])).toBe(KILLED_DECIDE_CALLS);
    expect(Number(killedLine![7])).toBe(KILLED_PERCEIVE_CALLS);
    // The resumed attempt's line is still the MEASURED shape (no recovered flag).
    const m = lines[1].match(RESUME_LINE);
    expect(m, `unexpected evidence line: ${lines[1]}`).toBeTruthy();
    expect(Number(m![1])).toBe(3);
    expect(Number(m![3])).toBe(cursorTs);
    expect(Number(m![4])).toBeGreaterThan(0);
    expect(Number(m![5])).toBeGreaterThan(0);

    // Reading the resumed job through the owner's route keeps the trail but not
    // the spend accumulators (AC8's payload).
    const ownerView = await getJob(appB.app, jobId, ownerB);
    expect(ownerView.job.resume.resumedFromTs).toBe(cursorTs);
    expect(ownerView.job.resume.accumulators).toBeUndefined();
    expect(ownerView.job.vodMeter).toBeUndefined();

    await appB.app.close();
  }, 240000);

  it("boot recovery never resurrects a cancelled row and never re-arms a queued one", async () => {
    const app = await buildTestApp({ ...ENV, DATA_DIR: dataDir, DATABASE_PATH: dbPath }, { adapter: resumeAdapter() });
    const owner = await login(app.app, "inc34-boot@test.dev");
    // Seed two terminal/queued rows directly: a cancelled job and a job already
    // queued with an armed retry far in the future.
    const now = new Date().toISOString();
    const base = {
      ownerId: (await app.db.getUserByEmail("inc34-boot@test.dev"))?.id,
      source: "file" as const,
      sourceUrl: videoPath,
      createdAt: now,
      preferLabels: [],
      attempts: 1,
    };
    await app.db.saveJob({
      ...base,
      id: "boot-cancelled",
      status: "cancelled",
      stage: "cancelled",
      resume: { version: 1, phase: "analyze", attempts: [], totalAttempts: 1 },
    } as any);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await app.db.saveJob({
      ...base,
      id: "boot-queued-arm",
      status: "queued",
      stage: "retry-scheduled",
      resume: { version: 1, phase: "analyze", attempts: [], totalAttempts: 1, nextAttemptAt: future },
    } as any);
    await app.store.load();
    // Run the boot sweep logic by rebuilding an app over the same DB: the
    // cancelled row must stay cancelled, and the armed row must keep its
    // schedule (the drain filter honours nextAttemptAt).
    await app.app.close();
    const app2 = await buildTestApp({ ...ENV, DATA_DIR: dataDir, DATABASE_PATH: dbPath }, { adapter: resumeAdapter() });
    await sleep(150);
    const cancelled = app2.store.getJob("boot-cancelled");
    const queued = app2.store.getJob("boot-queued-arm");
    expect(cancelled?.status).toBe("cancelled");
    expect(queued?.status).toBe("queued");
    expect(queued?.resume?.nextAttemptAt).toBe(future);
    expect(queued?.resume?.totalAttempts).toBe(1); // never double-incremented
    void owner;
    await app2.app.close();
  }, 60000);
});

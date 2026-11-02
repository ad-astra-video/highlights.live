// ADAAAA-7774: the LIVE observe loop was PERCEIVE-BOUND, not decide-bound.
// Measured on the box (job `b627dec0`, 1 stream / 305 s): 1504 frames arrived
// (~5 fps) and 847 were perceived at ~0.36 s of blocking `client.analyze` each
// (`perceiveSessionS` 304.9 s) — the loop ran ~1.8x slower than realtime, so the
// lag budget dropped the surplus in bursts and each ~3 s of dropped content
// counted as a skipped window (56-86 of ~100 windows lost per 300 s at EVERY
// decide depth). The decide window never carried more than ~2 fps of content
// anyway (`assembleLiveWindow` thins to `OBSERVE_CONTENT_FPS`), so 3 of every 5
// ingested frames were perceived and then discarded.
//
// This suite pins the fix:
//   (a) the pass CONSUMES frames at the analysis fps (content-time stride), so
//       `framesAnalyzed` ~ wall seconds x 2 while the ingest delivered ~5/s,
//   (b) the adaptive perceive cadence runs on the consumed set, so
//       `perceiveCalls < framesAnalyzed` in a cool region (`PERCEIVE_QUIET_STRIDE`),
//   (c) a perceive-skipped frame is still RECORDED with an EMPTY seed
//       (`signal: undefined`) — recall-safe, exactly like the VOD cadence path —
//       so the decide payload keeps ~2 fps of frames with no fabricated signal,
//   (d) total perceive work drops ≥2x versus the pre-7774 pass, which is the
//       cause of the lag/skip loss (the fixed loop stays inside the budget),
//   (e) a trigger / Tier-2 escalation arms FULL perceive (`armHot`), so the
//       goal moment is never under-sampled by the cool stride.
import { describe, it, expect } from "vitest";
import { analyzeJob, type PipelineClient } from "../src/analyzer";
import { PerceiveCadence } from "../src/perceive-cadence";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function frameTs(b64: string): number {
  return Number(b64.replace(/^f/, ""));
}

/** Perceive that costs real wall time (0.36 s on the box; 60 ms here so the
 *  suite stays fast) and returns a plain observation with no signal. */
function makeClient(analyzeMs: number) {
  const decided: { frames: number[]; tickTs: number }[] = [];
  let currentFrameTs = 0;
  let analyzeCalls = 0;
  const client: PipelineClient = {
    reservePerceive: async () => ({ sessionId: "sess-stride", appUrl: "", controlUrl: "" }),
    analyze: async (_sid: string, frame: any) => {
      analyzeCalls++;
      currentFrameTs = frame.timestamp;
      await sleep(analyzeMs);
      return { observation: { tracks: [], seq: frame.seq, timestamp: frame.timestamp } as any };
    },
    decide: async (_evidence: any, dOpts: any) => {
      decided.push({ frames: dOpts.frames.map((f: any) => frameTs(f.base64)), tickTs: currentFrameTs });
      return { isHighlight: false, score: 0, outcome: "not_highlight" } as any;
    },
    plan: async () => ({
      planVersion: 1,
      category: "soccer",
      intent: "",
      source: "planner-fallback",
      maxTracks: 3,
      targets: [{ label: "player", role: "player" }],
      reason: "test",
    }),
    postAudio: async () => ({ candidate: null, series: [] }),
    controlForward: async () => {},
    train: async () => ({ run: "x", checkpoint: "/runs/x/model.safetensors" }),
    stopPerceive: async () => {},
    confirm: async () => ({
      enabled: false,
      confidence: 0,
      reason: "",
      evidence: {},
      stage1Disagreed: false,
      decision: { isHighlight: false, score: 0, outcome: "not_highlight" },
    }),
  } as any;
  return { client, decided, analyzeCalls: () => analyzeCalls };
}

/** Realtime-shaped rail: frames arrive on a wall clock (as ffmpeg ingest does)
 *  at `frameEveryMs`, with their arrival time as the content timestamp — so the
 *  ingest rate is ~`1000/frameEveryMs` fps, exactly like the deployed ~5 fps. */
async function* bufferedFrames(durationMs: number, frameEveryMs = 200) {
  const queue: { seq: number; timestamp: number; imageB64: string }[] = [];
  const t0 = Date.now();
  let seq = 0;
  let finished = false;
  void (async () => {
    while (Date.now() - t0 < durationMs) {
      await sleep(frameEveryMs);
      const ts = Number(((Date.now() - t0) / 1000).toFixed(3));
      queue.push({ seq: seq++, timestamp: ts, imageB64: `f${ts}` });
    }
    finished = true;
  })();
  for (;;) {
    while (queue.length) yield queue.shift()!;
    if (finished) return;
    await sleep(5);
  }
}

/** Deterministic 3 fps feed (the rate the deployed rail actually delivers:
 *  ~899-900 frames per 300 s): the content clock advances by exactly 1/3 s per
 *  frame, so `contentSeconds` is known exactly, while arrival rides the wall
 *  clock like ffmpeg ingest does. */
async function* threeFpsFrames(contentSeconds: number) {
  const t0 = Date.now();
  const n = Math.round(contentSeconds * 3) + 1; // frame 0 sits at content t=0
  for (let k = 0; k < n; k++) {
    const ts = Number((k / 3).toFixed(3));
    const wait = t0 + (k * 1000) / 3 - Date.now();
    if (wait > 0) await sleep(wait);
    yield { seq: k, timestamp: ts, imageB64: `f${ts}` };
  }
}

const CFG = {
  jobId: "job-live-stride",
  clipBeforeS: 1,
  clipAfterS: 1,
  gameHint: "soccer",
  liveObserveLoop: true,
  observeCadenceS: 1,
  observeWindowS: 2,
  observeMaxFrames: 30,
  sampleFps: 5,
  liveObserveLagBudgetS: 30,
} as const;

const cut = async (ts: number) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` });

describe("analyzeJob live perceive stride (ADAAAA-7774)", () => {
  it("(a)+(b)+(c): consumes ~2 fps of the ~5 fps ingest, perceives less than it consumes, and keeps the ~2 fps decide payload", async () => {
    const strided = makeClient(60);
    const outcome = await analyzeJob(
      strided.client,
      bufferedFrames(6000, 200) as any, // ~5 fps ingest for 6 s of content
      cut as any,
      { ...CFG, liveObserveContentFps: 2, perceiveQuietStride: 2 } as any,
      undefined
    );
    const m = outcome.observeMetrics!;
    const p = m.perceive!;
    expect(p).toBeDefined();
    expect(p.analysisFps).toBe(2);
    // The ingest delivered ~5 fps for ~6 s (>= 20 frames); the pass consumed
    // ~2 per content second, so most frames never entered perceive at all.
    expect(p.framesSeen).toBeGreaterThanOrEqual(20);
    expect(p.framesAnalyzed).toBeGreaterThanOrEqual(8);
    expect(p.framesAnalyzed).toBeLessThanOrEqual(16);
    expect(p.framesStrided).toBeGreaterThan(p.framesAnalyzed);
    // Every ingested frame is accounted for: consumed + strided (no stale drops
    // in this run — the loop kept up, which is the point).
    expect(p.framesSeen).toBe(p.framesAnalyzed + p.framesStrided);
    // The cadence runs INSIDE the consumed set: a cool region perceives every
    // `quietStride`-th consumed frame, so perceiveCalls < framesAnalyzed.
    expect(p.perceiveCalls).toBeLessThan(p.framesAnalyzed);
    expect(p.perceiveSkipped).toBe(p.framesAnalyzed - p.perceiveCalls);
    expect(p.perceiveCalls).toBe(strided.analyzeCalls());
    // The decide payload contract is unchanged: every decided window still
    // carries ~2 fps of content (<= windowS * 2 + keyframes), even though only
    // some of those frames were perceived (the rest were recorded seed-less).
    expect(strided.decided.length).toBeGreaterThanOrEqual(3);
    const counts = strided.decided.map((d) => d.frames.length);
    // ~2 fps of a 2 s window: a couple of frames early on, ~4 once warmed. The
    // hard cap (windowS * 2 + keyframes) is never breached — the stride cannot
    // widen the payload.
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...counts)).toBeLessThanOrEqual(CFG.observeWindowS * 2 + 3);
    for (const d of strided.decided) {
      // Content order, no fabricated frames.
      expect([...d.frames].sort((a, b) => a - b)).toEqual(d.frames);
    }
    // A missing seed can never be turned into a signal: nothing was accepted
    // (the stub always answers not_highlight) and no stale window was dropped,
    // i.e. the loop kept up with the wall clock — the whole point of the stride.
    expect(m.skippedStaleWindows).toBe(0);
    expect(m.accepted).toBe(0);
  }, 60000);

  it("(h): a 3 fps ingest still consumes at the analysis fps — credit accumulator, not a 0.5 s floor", async () => {
    // The deployed rail delivers ~3 fps (899-900 frames per 300 s). A hard
    // `1 / analysisFps` (0.5 s) floor on the frame spacing alternates
    // consume/skip/consume on that feed — 0.667 s spacing = 1.5 content fps, i.e.
    // `framesAnalyzed` ~450 per 300 s on the shipped build. Credit banking makes
    // the consumed COUNT converge on the analysis fps instead.
    const contentSeconds = 6;
    const strided = makeClient(10);
    const outcome = await analyzeJob(
      strided.client,
      threeFpsFrames(contentSeconds) as any, // ~19 frames over 6 content seconds
      cut as any,
      { ...CFG, liveObserveContentFps: 2 } as any,
      undefined
    );
    const m = outcome.observeMetrics!;
    const p = m.perceive!;
    expect(p.analysisFps).toBe(2);
    expect(p.framesSeen).toBeGreaterThanOrEqual(contentSeconds * 3);
    // THE CLAUSE: consumed frames ~= analysis fps x content seconds (+-1).
    expect(Math.abs(p.framesAnalyzed - 2 * contentSeconds)).toBeLessThanOrEqual(1);
    expect(p.framesStrided).toBeGreaterThan(0);
    expect(p.framesSeen).toBe(p.framesAnalyzed + p.framesStrided);
    // Every ingested frame is accounted for and nothing went stale: the loop
    // stayed inside the lag budget (droppedFrames 0 on the live row).
    expect(m.skippedStaleWindows).toBe(0);

    // Stride off (`LIVE_OBSERVE_CONTENT_FPS=0`) still perceives every frame.
    const un = makeClient(10);
    const raw = await analyzeJob(
      un.client,
      threeFpsFrames(contentSeconds) as any,
      cut as any,
      { ...CFG, liveObserveContentFps: 0, perceiveCadence: false } as any,
      undefined
    );
    const u = raw.observeMetrics!.perceive!;
    expect(u.analysisFps).toBe(0);
    expect(u.framesStrided).toBe(0);
    expect(u.framesSeen).toBe(u.perceiveCalls);
    expect(un.analyzeCalls()).toBe(u.framesSeen);
  }, 60000);

  it("(d): the stride cuts perceive work >=2x versus perceiving every ingested frame", async () => {
    const before = makeClient(20);
    const after = makeClient(20);
    const liveCfg = { ...CFG, observeCadenceS: 5 } as any;
    // The control is the PRE-7774 pass: no ingest stride AND no perceive cadence
    // (the live cadence did not exist before this ticket), i.e. every ingested
    // frame goes to perceive.
    const un = await analyzeJob(
      before.client,
      bufferedFrames(4000, 200) as any,
      cut as any,
      { ...liveCfg, liveObserveContentFps: 0, perceiveCadence: false } as any,
      undefined
    );
    const st = await analyzeJob(after.client, bufferedFrames(4000, 200) as any, cut as any, { ...liveCfg, liveObserveContentFps: 2, perceiveQuietStride: 2 } as any, undefined);
    const unP = un.observeMetrics!.perceive!;
    const stP = st.observeMetrics!.perceive!;
    // No stride = the pre-7774 behaviour: the cadence is off the loop's hands,
    // every ingested frame is perceived.
    expect(unP.analysisFps).toBe(0);
    expect(unP.framesStrided).toBe(0);
    expect(unP.perceiveCalls).toBe(unP.framesSeen);
    // With the stride, at least half of the perceive work is gone — the ~1.8x
    // slower-than-realtime loop that caused the stale drops can no longer happen
    // at this ingest rate.
    expect(stP.perceiveCalls * 2).toBeLessThanOrEqual(unP.perceiveCalls);
    expect(after.analyzeCalls()).toBe(stP.perceiveCalls);
    expect(before.analyzeCalls()).toBe(unP.perceiveCalls);
  }, 60000);
});

describe("PerceiveCadence hot escalation for the live rail (ADAAAA-7774)", () => {
  it("(e): armHot forces full perceive for the hot window, then the cool stride resumes", () => {
    const cadence = new PerceiveCadence({ quietStride: 2, hotAfterS: 2 });
    // Cool region: every other frame.
    const cool = [0, 0.5, 1, 1.5].map((ts) => cadence.shouldPerceive(ts));
    expect(cool).toEqual([true, false, true, false]);
    // A trigger (or Tier-2 escalation) at 2 s arms full perceive from its onset.
    cadence.armHot(2);
    expect(cadence.tier(2)).toBe("hot");
    const hot = [2, 2.5, 3, 3.5, 4].map((ts) => cadence.shouldPerceive(ts));
    expect(hot).toEqual([true, true, true, true, true]);
    // After the 2 s hot window the cool stride resumes (never stuck hot).
    expect(cadence.tier(4.5)).toBe("cool");
    expect(cadence.shouldPerceive(4.5)).toBe(true);
    expect(cadence.shouldPerceive(5)).toBe(false);
  });

  it("(e): a Tier-2 signal arms the SAME hot window as a trigger (one predicate, no disagreement)", () => {
    const cadence = new PerceiveCadence({ quietStride: 2, hotAfterS: 3 });
    const signal = { goalCrossed: true } as any;
    cadence.noteFrameSignal(10, signal, { ballMinSpeedMps: 18 } as any);
    expect(cadence.tier(10)).toBe("hot");
    expect(cadence.shouldPerceive(12.5)).toBe(true);
  });

  it("(f): an ABSENT/uncalibrated signal does NOT arm the hot window on the live rail (the decide gate's recall-safe escalate must not disable the cadence)", () => {
    const liveOpts = { suppressQuietUncalibrated: true } as any;
    // No signal at all: the decide gate escalates (recall-safe), the cadence
    // must not — otherwise the whole run is "hot" (measured: perceiveHot=182 of
    // 183 calls at 1 stream, i.e. the cadence cut nothing).
    const absent = new PerceiveCadence({ quietStride: 2, hotAfterS: 10 });
    absent.noteFrameSignal(1, undefined, liveOpts);
    expect(absent.tier(2)).toBe("cool");
    // A frame the goal channel judged as NOT a goal is also cool.
    absent.noteFrameSignal(2, { goalInfra: true } as any, liveOpts);
    expect(absent.tier(3)).toBe("cool");
    // A REAL Tier-2 signal still arms the full-perceive window.
    absent.noteFrameSignal(3, { ballInNet: true } as any, liveOpts);
    expect(absent.tier(4)).toBe("hot");
    expect(absent.shouldPerceive(12)).toBe(true);
  });
});

describe("analyzeJob live cost-aware stride (ADAAAA-7774)", () => {
  it("(g): a GPU-bound perceive is BUDGETED instead of awaited per frame, so the loop keeps the analysis fps and nothing goes stale", async () => {
    // 0.9 s of blocking perceive against a 5 fps ingest (the box measured 1.9 s
    // at 1 stream and 4.1 s at 2 with decide depth 4). Awaiting it per consumed
    // frame would leave the loop 1.8x slower than realtime and the 2 s budget
    // would drop content (measured: 614 of 857 frames dropped, 56 skipped
    // windows). The budget spends at most 60 % of the clock in perceive, so the
    // pass still consumes at the analysis fps and records the frames it cannot
    // afford with an EMPTY seed.
    const slow = makeClient(900);
    const outcome = await analyzeJob(
      slow.client,
      bufferedFrames(6000, 200) as any, // ~5 fps ingest
      cut as any,
      { ...CFG, liveObserveContentFps: 2, perceiveQuietStride: 2, liveObserveLagBudgetS: 2 } as any,
      undefined
    );
    const m = outcome.observeMetrics!;
    const p = m.perceive!;
    // No stale content was dropped and no cadence window was swallowed...
    expect(m.skippedStaleWindows).toBe(0);
    expect(p.framesSeen).toBe(p.framesAnalyzed + p.framesStrided);
    // ...because perceive is budgeted: the pass consumed at the analysis fps
    // (~2 per content second) while only paying for what the 60 % budget allows.
    expect(p.framesAnalyzed).toBeGreaterThanOrEqual(8);
    expect(p.perceiveMeanCostMs).toBeGreaterThanOrEqual(700);
    expect(p.perceiveCalls).toBeLessThan(p.framesAnalyzed);
    expect(p.perceiveBudgetSkipped ?? 0).toBeGreaterThan(0);
    // It still decides on the cadence (the pass is not starved).
    expect(m.decideCalls).toBeGreaterThanOrEqual(2);
  }, 60000);
});

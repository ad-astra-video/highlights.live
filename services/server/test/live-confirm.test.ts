// ADAAAA-7663: the LIVE pass was never wired to the Stage-2 confirmation pass.
// `runLiveJob` built its AnalyzerConfig without `confirmEnabled`, so
// `shouldRunConfirm()` early-returned on every live read and a live RTMP job
// that accepted goal-shaped Stage-1 reads wrote 0 `gNNN:confirm` decide-audit
// rows (fixture 2118ea32: 16 Stage-1 rows, 0 confirm rows, 6 scoring_play
// GOAL accepts). These tests pin the fix:
//   (1) the live config derives the gate from DECIDE_CONFIRM_ENABLED and carries
//       the live-only exactly-once horizon,
//   (2) flag-off is a strict no-op (no confirm call, no confirm row),
//   (3) a live goal-shaped accept emits a job-scoped `gNNN:confirm` row that is
//       self-describing (prompt + per-frame sha256 + timings + replayable), and
//   (4) the rolling live window re-reads one goal across overlapping windows but
//       spends exactly ONE confirm dive (and one row) per distinct goal.
import { describe, it, expect } from "vitest";
import { analyzeJob, LiveRunShared, type PipelineClient } from "../src/analyzer";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";

// A Stage-1 read of an accepted scoring_play goal: the population shouldRunConfirm
// is scoped to (goal-shaped + no independent attestation).
const ACCEPTED_GOAL = {
  isHighlight: true,
  score: 80,
  eventType: "GOAL",
  outcome: "scoring_play",
  reason: "stage-1 goal read",
};

const NOT_HIGHLIGHT = { isHighlight: false, score: 0, outcome: "not_highlight", reason: "open play" };

function liveCfg(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    PERCEIVE_URL: "http://p",
    DECIDE_URL: "http://d",
    LIVE_OBSERVE_LOOP: "1",
    DECIDE_CONFIRM_ENABLED: "1",
    ...env,
  });
  return buildLiveAnalyzerConfig({
    cfg,
    job: { id: "job-live-confirm", gameHint: "soccer" },
    clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
  });
}

/** A mocked live pipeline: decide returns an accepted GOAL whenever the rolling
 * window center falls inside a goal band; confirm records each dive. */
function makeLiveClient(goalBands: [number, number][]) {
  const confirmCalls: { timestamp?: number; stage1?: unknown }[] = [];
  const decidedAt: number[] = [];
  let currentTs = 0;
  const client: PipelineClient = {
    reservePerceive: async () => ({ sessionId: "sess-live", appUrl: "", controlUrl: "" }),
    analyze: async (_sid: string, frame: any) => {
      currentTs = frame.timestamp;
      return { observation: { tracks: [], seq: frame.seq, timestamp: frame.timestamp } };
    },
    decide: async () => {
      decidedAt.push(currentTs);
      const inGoal = goalBands.some(([lo, hi]) => currentTs >= lo && currentTs <= hi);
      return (inGoal ? ACCEPTED_GOAL : NOT_HIGHLIGHT) as any;
    },
    confirm: async (req: any) => {
      confirmCalls.push({ timestamp: req?.timestamp, stage1: req?.stage1 });
      return {
        enabled: true,
        goalConfirmed: "confirmed_goal" as const,
        confidence: 0.9,
        reason: "ball in net",
        evidence: { ballInNet: true },
        stage1Disagreed: false,
        corroborated: true,
        corroborationSource: "frame_attestation" as const,
        decision: ACCEPTED_GOAL,
        // The /confirm service returns its own prompt in the pass analysis record;
        // the audit descriptor persists it verbatim (ADAAAA-7626).
        analysis: { request: { prompt: "CONFIRM PROMPT: did the ball cross the line?" } },
      } as any;
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
  };
  return { client, confirmCalls, decidedAt };
}

async function* liveFrames(fps: number, durationS: number) {
  const n = Math.floor(durationS * fps);
  for (let i = 0; i < n; i++) {
    const ts = Math.round((i / fps) * 100) / 100;
    yield { seq: i, timestamp: ts, imageB64: `frame-${ts}` };
  }
}

async function runLive(cfg: any, goalBands: [number, number][], durationS: number) {
  const audits: any[] = [];
  const { client, confirmCalls, decidedAt } = makeLiveClient(goalBands);
  const shared = new LiveRunShared();
  const runCfg = { ...cfg, onDecideAudit: (d: any) => audits.push(d) };
  const outcome = await analyzeJob(
    client,
    liveFrames(3, durationS),
    async (ts: number) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
    runCfg,
    undefined,
    { sessionId: "sess-live", appUrl: "", controlUrl: "" },
    shared
  );
  return {
    audits,
    confirmCalls,
    decidedAt,
    outcome,
    confirmRows: audits.filter((a) => typeof a?.groupKey === "string" && a.groupKey.endsWith(":confirm")),
    stage1Rows: audits.filter((a) => !(typeof a?.groupKey === "string" && a.groupKey.endsWith(":confirm"))),
  };
}

describe("buildLiveAnalyzerConfig — Stage-2 confirm wiring (ADAAAA-7663)", () => {
  it("carries the confirm gate + live reuse horizon with the flag on", () => {
    const cfg = liveCfg();
    expect(cfg.planMode).toBe("live");
    expect(cfg.confirmEnabled).toBe(true);
    expect(cfg.confirmWindowExtraS).toBe(4); // DECIDE_CONFIRM_EXTRA_WINDOW_S default
    expect(cfg.confirmReuseWindowS).toBe(30); // DECIDE_CONFIRM_LIVE_REUSE_WINDOW_S default
  });

  it("honours the env knobs", () => {
    const cfg = liveCfg({ DECIDE_CONFIRM_EXTRA_WINDOW_S: "6", DECIDE_CONFIRM_LIVE_REUSE_WINDOW_S: "45" });
    expect(cfg.confirmEnabled).toBe(true);
    expect(cfg.confirmWindowExtraS).toBe(6);
    expect(cfg.confirmReuseWindowS).toBe(45);
  });

  it("is a strict no-op with the flag off (confirmEnabled false)", () => {
    const cfg = liveCfg({ DECIDE_CONFIRM_ENABLED: "0" });
    expect(cfg.confirmEnabled).toBe(false);
  });

  it("keeps the live pass on the live observer branch (decideWindowN unset)", () => {
    const cfg = liveCfg();
    expect(cfg.liveObserveLoop).toBe(true);
    expect(cfg.decideWindowN).toBeUndefined();
  });
});

describe("live confirm driver (ADAAAA-7663)", () => {
  it("writes 0 confirm rows and makes 0 confirm calls when the flag is off (AC5)", async () => {
    const cfg = liveCfg({ DECIDE_CONFIRM_ENABLED: "0" });
    const { confirmCalls, confirmRows, stage1Rows, outcome } = await runLive(cfg, [[30, 45]], 60);
    expect(confirmCalls).toHaveLength(0);
    expect(confirmRows).toHaveLength(0);
    // The Stage-1 audit + accept path is untouched.
    expect(stage1Rows.length).toBeGreaterThan(0);
    expect(outcome.highlights.length).toBeGreaterThan(0);
  });

  it("emits a job-scoped, self-describing gNNN:confirm row for a live goal accept (AC1/AC2)", async () => {
    const cfg = liveCfg();
    const { confirmCalls, confirmRows, stage1Rows, outcome } = await runLive(cfg, [[30, 45]], 60);
    expect(confirmCalls.length).toBeGreaterThan(0);
    expect(confirmRows.length).toBeGreaterThan(0);
    expect(stage1Rows.length).toBeGreaterThan(0);
    expect(outcome.highlights.length).toBeGreaterThan(0);

    for (const row of confirmRows) {
      expect(row.groupKey).toMatch(/^g\d+:confirm$/);
      expect(row.jobId).toBe("job-live-confirm");
      expect(row.sessionId).toBe("job-live-confirm");
      expect(row.verdicts.runConfirmationPass).toBe(true);
      expect(row.verdicts.goalConfirmed).toBe("confirmed_goal");
      // AC2: the row must be replayable, not a thin placeholder.
      expect(typeof row.promptText).toBe("string");
      expect(row.promptText.length).toBeGreaterThan(0);
      expect(row.replayable).toBe(true);
      expect(Array.isArray(row.mediaHashes)).toBe(true);
      expect(row.mediaHashes.length).toBe(row.frameCount);
      expect(row.mediaHashes.length).toBeGreaterThan(0);
      expect(row.mediaHashes[0].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof row.timings.elapsedMs).toBe("number");
      expect(row.timings.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(row.frameCount).toBeGreaterThan(0);
    }
  });

  it("spends exactly one confirm dive per distinct goal across overlapping live windows (AC3)", async () => {
    const cfg = liveCfg();
    // A 15 s goal band with a 3 s cadence over a 10 s rolling window means the
    // goal is re-read by ~5 overlapping windows — each with a different center.
    const { confirmCalls, confirmRows, decidedAt } = await runLive(cfg, [[30, 45]], 60);
    const goalWindows = decidedAt.filter((t) => t >= 30 && t <= 45);
    expect(goalWindows.length).toBeGreaterThan(1); // the overlap is real
    expect(confirmCalls).toHaveLength(1);
    expect(confirmRows).toHaveLength(1);
    // Audit-to-call ratio for the Stage-2 stage is exactly 1.0.
    expect(confirmRows.length / confirmCalls.length).toBe(1);
  });

  it("re-dives for a genuinely distinct goal outside the reuse horizon (AC3)", async () => {
    const cfg = liveCfg();
    const { confirmCalls, confirmRows } = await runLive(cfg, [[20, 30], [75, 85]], 100);
    expect(confirmCalls).toHaveLength(2);
    expect(confirmRows).toHaveLength(2);
    expect(confirmRows.length).toBe(confirmCalls.length);
  });

  it("with the reuse horizon disabled the same goal re-dives per window (proves the reuse is load-bearing)", async () => {
    const cfg = liveCfg({ DECIDE_CONFIRM_LIVE_REUSE_WINDOW_S: "0" });
    const { confirmCalls, confirmRows, decidedAt } = await runLive(cfg, [[30, 45]], 60);
    const goalWindows = decidedAt.filter((t) => t >= 30 && t <= 45);
    expect(goalWindows.length).toBeGreaterThan(1);
    // Without the horizon every overlapping window would re-dive the same goal.
    expect(confirmCalls.length).toBe(goalWindows.length);
    expect(confirmRows.length).toBe(confirmCalls.length);
  });

  it("does not dive for a non-goal-shaped live accept (cost bound)", async () => {
    const cfg = liveCfg();
    const { confirmCalls } = await runLive(cfg, [], 60);
    expect(confirmCalls).toHaveLength(0);
  });
});

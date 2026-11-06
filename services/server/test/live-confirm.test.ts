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
//       self-describing (prompt + per-frame sha256 + timings + replayable),
//   (4) the rolling live window re-reads one goal across overlapping windows but
//       spends exactly ONE confirm dive (and one row) per distinct goal, and
//   (5) a nearby REFUTED dive never vetoes a later scoring_play accept.
import { describe, it, expect } from "vitest";
import { analyzeJob, confirmReconcile, LiveRunShared, type PipelineClient } from "../src/analyzer";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";

// LIVE_OBSERVE_WINDOW_S: the rolling window is 10 s of PAST content, so a goal is
// only visible while it sits inside that window and repeat reads span <= 10 s.
const WINDOW_S = 10;

// A Stage-1 read of an accepted scoring_play goal: the population shouldRunConfirm
// is scoped to (goal-shaped + no independent attestation).
const ACCEPTED_GOAL = {
  isHighlight: true,
  score: 80,
  eventType: "GOAL",
  outcome: "scoring_play",
  reason: "stage-1 goal read",
};

// The delayed-corroboration population (goal-shaped non-accept) — the same goal
// read a moment earlier, before the crossing was in frame.
const BARE_GOAL = {
  isHighlight: false,
  score: 0,
  eventType: "GOAL",
  outcome: "not_highlight",
  reason: "celebration only; no ball in net",
};

const NOT_HIGHLIGHT = { isHighlight: false, score: 0, outcome: "not_highlight", reason: "open play" };

function liveCfg(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    PERCEIVE_URL: "http://p",
    DECIDE_URL: "http://d",
    LIVE_OBSERVE_LOOP: "1",
    DECIDE_CONFIRM_ENABLED: "1",
    // ADAAAA-8205: this suite pins the INLINE dive lane (the LIVE_CONFIRM_ASYNC=0
    // posture, still supported). The async lane's own ACs live in
    // live-confirm-async-8205.test.ts.
    LIVE_CONFIRM_ASYNC: "0",
    ...env,
  });
  return buildLiveAnalyzerConfig({
    cfg,
    job: { id: "job-live-confirm", gameHint: "soccer" },
    clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
  });
}

/** A mocked live pipeline: decide accepts a GOAL when the rolling window
 * `[center - 10, center]` contains a goal INSTANT; confirm records each dive. */
function makeLiveClient(
  goalInstants: number[],
  confirmVerdict: "confirmed_goal" | "not_goal" = "confirmed_goal",
  /** Optional per-dive verdict sequence (last value repeats). */
  verdictSequence?: ("confirmed_goal" | "not_goal")[]
) {
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
      const goalInWindow = goalInstants.some((g) => currentTs >= g && currentTs <= g + WINDOW_S);
      return (goalInWindow ? ACCEPTED_GOAL : NOT_HIGHLIGHT) as any;
    },
    confirm: async (req: any) => {
      confirmCalls.push({ timestamp: req?.timestamp, stage1: req?.stage1 });
      const verdict =
        verdictSequence && verdictSequence.length
          ? verdictSequence[Math.min(confirmCalls.length - 1, verdictSequence.length - 1)]
          : confirmVerdict;
      return {
        enabled: true,
        goalConfirmed: verdict,
        confidence: 0.9,
        reason: verdict === "confirmed_goal" ? "ball in net" : "no ball in net",
        evidence: { ballInNet: verdict === "confirmed_goal" },
        stage1Disagreed: false,
        corroborated: verdict === "confirmed_goal",
        corroborationSource: verdict === "confirmed_goal" ? ("frame_attestation" as const) : null,
        decision: verdict === "confirmed_goal" ? ACCEPTED_GOAL : BARE_GOAL,
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
    controlForward: async () => null,
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

async function runLive(cfg: any, goalInstants: number[], durationS: number, confirmVerdict?: "confirmed_goal" | "not_goal") {
  const audits: any[] = [];
  const { client, confirmCalls, decidedAt } = makeLiveClient(goalInstants, confirmVerdict);
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
    goalWindows: decidedAt.filter((t) => goalInstants.some((g) => t >= g && t <= g + WINDOW_S)),
  };
}

describe("buildLiveAnalyzerConfig — Stage-2 confirm wiring (ADAAAA-7663)", () => {
  it("carries the confirm gate + live reuse horizon with the flag on", () => {
    const cfg = liveCfg();
    expect(cfg.planMode).toBe("live");
    expect(cfg.confirmEnabled).toBe(true);
    expect(cfg.confirmWindowExtraS).toBe(4); // DECIDE_CONFIRM_EXTRA_WINDOW_S default
    expect(cfg.confirmReuseWindowS).toBe(12); // DECIDE_CONFIRM_LIVE_REUSE_WINDOW_S default
  });

  it("honours the env knobs", () => {
    const cfg = liveCfg({ DECIDE_CONFIRM_EXTRA_WINDOW_S: "6", DECIDE_CONFIRM_LIVE_REUSE_WINDOW_S: "15" });
    expect(cfg.confirmEnabled).toBe(true);
    expect(cfg.confirmWindowExtraS).toBe(6);
    expect(cfg.confirmReuseWindowS).toBe(15);
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
    const { confirmCalls, confirmRows, stage1Rows, goalWindows, outcome } = await runLive(cfg, [34], 70);
    expect(goalWindows.length).toBeGreaterThan(0); // the accept population is real
    expect(confirmCalls).toHaveLength(0);
    expect(confirmRows).toHaveLength(0);
    // The Stage-1 audit + accept path is untouched.
    expect(stage1Rows.length).toBeGreaterThan(0);
    expect(outcome.highlights.length).toBeGreaterThan(0);
  });

  it("emits a job-scoped, self-describing gNNN:confirm row for a live goal accept (AC1/AC2)", async () => {
    const cfg = liveCfg();
    const { confirmCalls, confirmRows, stage1Rows, outcome } = await runLive(cfg, [34], 70);
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
    // One goal instant is re-read by every rolling window that still contains it
    // (centers spanning goalTs..goalTs+10) — each with a different center key.
    const { confirmCalls, confirmRows, goalWindows } = await runLive(cfg, [34], 70);
    expect(goalWindows.length).toBeGreaterThan(1); // the overlap is real
    expect(confirmCalls).toHaveLength(1);
    expect(confirmRows).toHaveLength(1);
    // Audit-to-call ratio for the Stage-2 stage is exactly 1.0.
    expect(confirmRows.length / confirmCalls.length).toBe(1);
  });

  it("re-dives for a genuinely distinct goal outside the reuse horizon (AC3)", async () => {
    const cfg = liveCfg();
    const { confirmCalls, confirmRows } = await runLive(cfg, [20, 60], 100);
    expect(confirmCalls).toHaveLength(2);
    expect(confirmRows).toHaveLength(2);
    expect(confirmRows.length).toBe(confirmCalls.length);
  });

  it("with the reuse horizon disabled the same goal re-dives per window (proves the reuse is load-bearing)", async () => {
    const cfg = liveCfg({ DECIDE_CONFIRM_LIVE_REUSE_WINDOW_S: "0" });
    const { confirmCalls, confirmRows, goalWindows } = await runLive(cfg, [34], 70);
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

describe("live exactly-once recall guard (ADAAAA-7663)", () => {
  it("does not let a nearby REFUTED dive veto a later scoring_play accept", async () => {
    const { client, confirmCalls } = makeLiveClient([30], "not_goal", ["not_goal", "confirmed_goal"]);
    const shared = new LiveRunShared();
    const cfg = { jobId: "job-guard", gameHint: "soccer", confirmEnabled: true, confirmReuseWindowS: 12 } as any;

    // 1) A celebration window reads the goal-shaped non-accept -> dive REFUTES it.
    const first = await confirmReconcile(client, shared, cfg, BARE_GOAL as any, { eventType: "GOAL", timestamp: 30 });
    expect(confirmCalls).toHaveLength(1);
    expect(first.confirm?.goalConfirmed).toBe("not_goal");

    // 2) 6 s later the SAME goal is accepted by Stage-1: the earlier refutation is
    //    NOT reused (a genuine goal must not be dropped by a celebration read).
    const second = await confirmReconcile(client, shared, cfg, ACCEPTED_GOAL as any, { eventType: "GOAL", timestamp: 36 });
    expect(confirmCalls).toHaveLength(2);

    // 3) A further repeat of that accepted goal reuses the accept's dive.
    const third = await confirmReconcile(client, shared, cfg, ACCEPTED_GOAL as any, { eventType: "GOAL", timestamp: 40 });
    expect(confirmCalls).toHaveLength(2);
    expect(third).toBe(second);
  });
});

describe("ADAAAA-8205 config posture — the async lane is on by default, bounded", () => {
  it("arms the lane from LIVE_CONFIRM_ASYNC (default on) and carries the 8/300 s budget", () => {
    const cfg = loadConfig({ LIVE_OBSERVE_LOOP: "1", DECIDE_CONFIRM_ENABLED: "1" });
    const armed = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-confirm-async-default", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    });
    expect(armed.liveConfirmAsync).toBe(true);
    expect(armed.liveConfirmMaxDivesPer300S).toBe(8);
    expect(armed.confirmEnabled).toBe(true);
    expect(loadConfig({ LIVE_CONFIRM_ASYNC: "0" }).liveConfirmAsync).toBe(false);
    expect(loadConfig({ LIVE_CONFIRM_MAX_DIVES_PER_300S: "3" }).liveConfirmMaxDivesPer300S).toBe(3);
    // The master gate still owns the dive: async armed does NOT imply a dive
    // when DECIDE_CONFIRM_ENABLED / LIVE_DECIDE_CONFIRM are off.
    const off = buildLiveAnalyzerConfig({
      cfg: loadConfig({ LIVE_OBSERVE_LOOP: "1", DECIDE_CONFIRM_ENABLED: "0" }),
      job: { id: "job-confirm-async-off", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    });
    expect(off.confirmEnabled).toBe(false);
  });
});

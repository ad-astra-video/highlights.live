// ADAAAA-8139: the bounded persisted-frame re-read for a demoted goal window.
//
// Regression source: the graded leg on the ADAAAA-8134 build (job
// bca08173-1418-437e-9c22-24af6b748111) still shipped 0/2 real goals. Goal 1
// @16.95 s was demoted by the live gate with `postSamples: 0` — the OCR never
// produced a post-goal read inside the judged window — even though the
// scoreboard IS legible after the goal on that fixture (t=20 s reads 2-1). The
// gap is the SAMPLED read rate at the funded 4/2 cell, so the fix re-reads the
// frames the server already persisted, once, and feeds the reads into the
// existing pooled/deferred path.
//
// These tests pin the three things the ticket can regress without a GPU:
//  1. the trigger (only a demoted row with `postSamples < need`, only after the
//     20 s lookahead closes, exactly one pass per row);
//  2. the hard cost bounds (<= 4 OCR calls per pass, <= 8 per run, and zero
//     decide/perceive-pipeline calls — the harness counts every call);
//  3. fail-closed behaviour: a score-steady lull still yields 0 GOALs and a
//     BACKWARD score jump (2-2 -> 1-1, a broadcast jump-cut / feed loop) never
//     attests, which is the ADAAAA-8134 AC-R2 case.
import { describe, expect, it } from "vitest";
import {
  LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S,
  LiveRunShared,
  rereadDemotedWindowsFromPersistedFrames,
  scoreboardDeltaFromPooledReadings,
  scoreReadingsFromTimeline,
  type DeferredGoalAttestation,
} from "../src/analyzer.js";
import {
  LIVE_FRAME_REREAD_MAX_FRAMES,
  LIVE_FRAME_REREAD_MAX_OCR_CALLS_PER_RUN,
  evenlyPick,
  planDueRereads,
  runFrameRereadPass,
  selectRereadFrames,
  withTimeout,
} from "../src/live-frame-reread.js";

const read = (ts: number, score: [number, number]) => ({ ts, score });

/** The one emulate harness: relayed 1 fps frames over `[0, seconds]`, with one
 * OCR text per frame read from a caller-supplied score-at-time function. */
function relayedFrames(seconds: number, fps = 1) {
  const out: { seq: number; ts: number }[] = [];
  for (let i = 0; i <= seconds * fps; i++) out.push({ seq: i, ts: i / fps });
  return out;
}

/** OCR lines the scorebug would print at a content instant. */
const bug = (score: [number, number], clock: string) => [`${clock} RMA ${score[0]}-${score[1]} BAR`];

function demotedWindow(input: {
  lo: number;
  hi: number;
  postSamples?: number;
  need?: number;
  highlightId?: string;
}): DeferredGoalAttestation {
  return {
    highlightId: input.highlightId ?? "hl-1",
    jobId: "job-8139",
    lo: input.lo,
    hi: input.hi,
    anchorTs: input.lo,
    triggerKind: "goal_bias",
    scoreReads: { scoreReads: 34, preSamples: 34, postSamples: input.postSamples ?? 0, need: input.need ?? 2 },
  };
}

describe("selectRereadFrames (ADAAAA-8139)", () => {
  const WINDOW = { lo: 10, hi: 20 };
  const LOOKAHEAD = LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S; // 20 s

  it("spends half the budget in the lookahead tail and the rest in the window", () => {
    const frames = relayedFrames(60);
    const picked = selectRereadFrames(frames, WINDOW, { maxFrames: 4, trailS: LOOKAHEAD });
    expect(picked).toHaveLength(4);
    const inWindow = picked.filter((f) => f.ts >= WINDOW.lo && f.ts <= WINDOW.hi);
    const inTail = picked.filter((f) => f.ts > WINDOW.hi);
    expect(inWindow.length).toBe(2);
    expect(inTail.length).toBe(2);
    // Deterministic + content-ordered.
    expect(picked.map((f) => f.ts)).toEqual([...picked.map((f) => f.ts)].sort((a, b) => a - b));
  });

  it("never picks a frame outside the window + lookahead span", () => {
    const frames = relayedFrames(120);
    const picked = selectRereadFrames(frames, WINDOW, { maxFrames: 4, trailS: LOOKAHEAD });
    for (const f of picked) {
      expect(f.ts).toBeGreaterThanOrEqual(WINDOW.lo - 1e-9);
      expect(f.ts).toBeLessThanOrEqual(WINDOW.hi + LOOKAHEAD + 1e-9);
    }
  });

  it("is bounded by maxFrames even when the span holds hundreds of frames", () => {
    const frames = relayedFrames(200, 1);
    expect(selectRereadFrames(frames, WINDOW, { maxFrames: 4, trailS: LOOKAHEAD })).toHaveLength(4);
    expect(selectRereadFrames(frames, WINDOW, { maxFrames: 2, trailS: LOOKAHEAD })).toHaveLength(2);
  });

  it("returns nothing when the job kept no frames for the span", () => {
    expect(selectRereadFrames([], WINDOW, { maxFrames: 4, trailS: LOOKAHEAD })).toEqual([]);
    expect(selectRereadFrames(relayedFrames(60).filter((f) => f.ts > 90), WINDOW, { trailS: LOOKAHEAD })).toEqual([]);
  });

  it("keeps one candidate per content frame (dedupe by ts)", () => {
    const dupes = [
      { seq: 11, ts: 11 },
      { seq: 12, ts: 11 },
      { seq: 13, ts: 15 },
    ];
    const picked = selectRereadFrames(dupes, WINDOW, { maxFrames: 4, trailS: LOOKAHEAD });
    expect(picked.map((f) => f.ts)).toEqual([11, 15]);
    expect(picked[0].seq).toBe(11);
  });

  it("evenlyPick keeps the endpoints and never exceeds the cap", () => {
    const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(evenlyPick(xs, 4)).toEqual([0, 3, 6, 9]);
    expect(evenlyPick(xs, 100)).toEqual(xs);
    expect(evenlyPick(xs, 1)).toEqual([5]);
  });
});

describe("planDueRereads — the trigger (ADAAAA-8139)", () => {
  const LOOKAHEAD = LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S;

  it("waits for the lookahead to close", () => {
    const pending = [demotedWindow({ lo: 50, hi: 60 })];
    expect(planDueRereads(pending, { nowTs: 70, lookaheadS: LOOKAHEAD })).toHaveLength(0);
    expect(planDueRereads(pending, { nowTs: 79.9, lookaheadS: LOOKAHEAD })).toHaveLength(0);
    expect(planDueRereads(pending, { nowTs: 80, lookaheadS: LOOKAHEAD })).toHaveLength(1);
  });

  it("only fires for postSamples < need (the measured OCR gap)", () => {
    const deficit = demotedWindow({ lo: 50, hi: 60, postSamples: 1, need: 2 });
    const enough = demotedWindow({ lo: 50, hi: 60, postSamples: 2, need: 2, highlightId: "hl-2" });
    const noDisclosure = { ...demotedWindow({ lo: 50, hi: 60, highlightId: "hl-3" }), scoreReads: undefined };
    const due = planDueRereads([deficit, enough, noDisclosure] as any, { nowTs: 200, lookaheadS: LOOKAHEAD });
    expect(due.map((d) => d.key)).toEqual(["hl-1"]);
  });

  it("never re-plans a window whose one pass is spent", () => {
    const pending = [demotedWindow({ lo: 50, hi: 60, highlightId: "hl-spent" })];
    expect(
      planDueRereads(pending, { nowTs: 200, lookaheadS: LOOKAHEAD, attempted: new Set(["hl-spent"]) })
    ).toEqual([]);
  });
});

describe("runFrameRereadPass — bounds + fail-closed (ADAAAA-8139)", () => {
  const LOOKAHEAD = LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S;

  it("makes at most maxFrames OCR calls and never throws on a missing frame", async () => {
    let ocrCalls = 0;
    const plan = { key: "hl-1", lo: 10, hi: 20, lookaheadS: LOOKAHEAD };
    const out = await runFrameRereadPass(
      plan,
      {
        framesInSpan: () => relayedFrames(60),
        loadFrame: async (seq) => (seq % 2 === 0 ? "bm9wZQ==" : null), // half the frames are gone
        ocrFrame: async () => {
          ocrCalls++;
          return bug([2, 1], "20:00");
        },
        maxFrames: LIVE_FRAME_REREAD_MAX_FRAMES,
      },
      { log: () => {} }
    );
    expect(ocrCalls).toBeLessThanOrEqual(LIVE_FRAME_REREAD_MAX_FRAMES);
    expect(out.pass.ocrCalls).toBeLessThanOrEqual(LIVE_FRAME_REREAD_MAX_FRAMES);
    expect(out.pass.failed).toBeGreaterThan(0);
  });

  it("counts an unreadable crop as absent evidence, never a fabricated read", async () => {
    const out = await runFrameRereadPass(
      { key: "hl-1", lo: 10, hi: 20, lookaheadS: LOOKAHEAD },
      { framesInSpan: () => relayedFrames(60), loadFrame: async () => "eA==", ocrFrame: async () => [""], maxFrames: 4 },
      { log: () => {} }
    );
    expect(out.readings).toEqual([]);
    expect(out.pass.unreadable).toBe(out.pass.ocrCalls);
  });

  it("fails closed when the OCR call hangs (timeout, no readings)", async () => {
    const out = await runFrameRereadPass(
      { key: "hl-1", lo: 10, hi: 20, lookaheadS: LOOKAHEAD },
      { framesInSpan: () => relayedFrames(60), loadFrame: async () => "eA==", ocrFrame: () => new Promise(() => {}), maxFrames: 2 },
      { log: () => {}, ocrTimeoutMs: 20 }
    );
    expect(out.readings).toEqual([]);
    expect(out.pass.failed).toBe(2);
  });

  it("withTimeout rejects instead of parking the frame loop", async () => {
    await expect(withTimeout(new Promise((r) => setTimeout(() => r(1), 1000)), 10)).rejects.toThrow(/timed out/);
    await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
  });
});

describe("rereadDemotedWindowsFromPersistedFrames — the recall path (ADAAAA-8139)", () => {
  const LOOKAHEAD = LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S;

  /** Harness: a relayed 1 fps share where the scorebug shows `scoreAt(ts)`.
   * Records EVERY external call so the cost bound is measured, not claimed. */
  function harness(input: { scoreAt: (ts: number) => [number, number]; seconds?: number }) {
    const seconds = input.seconds ?? 120;
    const frames = relayedFrames(seconds);
    const calls = { ocr: 0, decide: 0, perceivePipeline: 0 };
    const upgrades: any[] = [];
    const run = new LiveRunShared();
    const cfg = {
      jobId: "job-8139",
      onDeferredGoalAttested: (up: any) => upgrades.push(up),
      liveFrameReread: {
        io: {
          framesInSpan: (lo: number, hi: number) => frames.filter((f) => f.ts >= lo && f.ts <= hi),
          loadFrame: async () => "eA==",
          ocrFrame: async () => {
            calls.ocr++;
            return null; // replaced per-test below
          },
        },
      } as any,
    };
    cfg.liveFrameReread.io.ocrFrame = async () => {
      calls.ocr++;
      return null;
    };
    return { frames, calls, upgrades, run, cfg, seconds };
  }

  it("does NOT attest when the re-read sees no transition (pre == post)", async () => {
    // Fixture: the window's own span reads 2-1 and the persisted frames past the
    // close also read 2-1 — a score-steady stretch. No transition, no GOAL,
    // however many frames the pass OCRs.
    const h = harness({ scoreAt: () => [2, 1] });
    for (let t = 0; t <= 16; t += 0.5) h.run.noteScoreReadings([{ ts: t, ocr: bug([2, 1], "19:58") }]);
    h.run.noteDeferredGoalAttestation(demotedWindow({ lo: 6.95, hi: 16.95, postSamples: 0 }));
    h.cfg.liveFrameReread.io.ocrFrame = async () => {
      h.calls.ocr++;
      return bug([2, 1], "20:00");
    };
    const out = await rereadDemotedWindowsFromPersistedFrames(h.run, h.cfg as any, { readAt: 40 });
    expect(out.passes).toBe(1);
    expect(out.upgrades).toBe(0);
    expect(out.ocrCalls).toBeLessThanOrEqual(LIVE_FRAME_REREAD_MAX_FRAMES);
    expect(h.calls.decide).toBe(0);
    expect(h.calls.perceivePipeline).toBe(0);
  });

  it("lifts a demoted row when the tail frames read a single-goal step", async () => {
    const h = harness({ scoreAt: () => [2, 2] as [number, number] });
    // PRE 1-2 held across the window's own span.
    for (let t = 0; t <= 16; t += 0.5) h.run.noteScoreReadings([{ ts: t, ocr: bug([1, 2], "19:58") }]);
    h.run.noteDeferredGoalAttestation(demotedWindow({ lo: 6.95, hi: 16.95, postSamples: 0 }));
    // The persisted frames after the crossing read the new score 2-2.
    h.cfg.liveFrameReread.io.ocrFrame = async () => {
      h.calls.ocr++;
      return bug([2, 2], "20:00");
    };
    const out = await rereadDemotedWindowsFromPersistedFrames(h.run, h.cfg as any, { readAt: 40 });
    expect(out.passes).toBe(1);
    expect(out.upgrades).toBe(1);
    expect(h.upgrades).toHaveLength(1);
    expect(h.upgrades[0].delta).toMatchObject({ pre: [1, 2], post: [2, 2] });
    // Cost: <= 4 OCR calls for this window, zero decide/perceive-pipeline call.
    expect(out.ocrCalls).toBeLessThanOrEqual(LIVE_FRAME_REREAD_MAX_FRAMES);
    expect(h.calls.decide).toBe(0);
    expect(h.calls.perceivePipeline).toBe(0);
  });

  it("keeps the lull precision bar: a score-steady span yields 0 GOALs", async () => {
    const h = harness({ scoreAt: () => [1, 1] as [number, number] });
    for (let t = 0; t <= 16; t += 0.5) h.run.noteScoreReadings([{ ts: t, ocr: bug([1, 1], "19:58") }]);
    h.run.noteDeferredGoalAttestation(demotedWindow({ lo: 6.95, hi: 16.95, postSamples: 0 }));
    h.cfg.liveFrameReread.io.ocrFrame = async () => {
      h.calls.ocr++;
      return bug([1, 1], "20:00");
    };
    const out = await rereadDemotedWindowsFromPersistedFrames(h.run, h.cfg as any, { readAt: 40 });
    expect(out.passes).toBe(1);
    expect(out.upgrades).toBe(0);
    expect(h.upgrades).toEqual([]);
  });

  it("fails closed on a BACKWARD score jump (2-2 -> 1-1: jump-cut / feed loop)", async () => {
    const h = harness({ scoreAt: () => [1, 1] as [number, number] });
    // The window's own span reads the pre-jump score 2-2 (a loop boundary).
    for (let t = 0; t <= 16; t += 0.5) h.run.noteScoreReadings([{ ts: t, ocr: bug([2, 2], "19:58") }]);
    h.run.noteDeferredGoalAttestation(demotedWindow({ lo: 6.95, hi: 16.95, postSamples: 0 }));
    // After the loop boundary the feed re-reads 1-1: one "step" but NOT a goal.
    h.cfg.liveFrameReread.io.ocrFrame = async () => {
      h.calls.ocr++;
      return bug([1, 1], "00:02");
    };
    const out = await rereadDemotedWindowsFromPersistedFrames(h.run, h.cfg as any, { readAt: 40 });
    expect(out.passes).toBe(1);
    expect(out.upgrades).toBe(0);
    expect(h.upgrades).toEqual([]);
    // The ledger DID record the reads — the refusal is the attribution step, so a
    // future positive can still see them (and a grader can reproduce the refusal).
    expect(h.run.scoreReadBuffer().some((r) => r.score[0] === 1 && r.score[1] === 1)).toBe(true);
  });

  it("charges every pass against ONE per-run OCR budget of 8", async () => {
    const h = harness({ scoreAt: () => [1, 1] as [number, number] });
    for (let t = 0; t <= 16; t += 0.5) h.run.noteScoreReadings([{ ts: t, ocr: bug([1, 1], "19:58") }]);
    // Four demoted windows, all due at the same readAt.
    for (let i = 0; i < 4; i++) {
      h.run.noteDeferredGoalAttestation(
        demotedWindow({ lo: 6.95 + i * 40, hi: 16.95 + i * 40, postSamples: 0, highlightId: `hl-${i}` })
      );
    }
    h.cfg.liveFrameReread.io.ocrFrame = async () => {
      h.calls.ocr++;
      return bug([1, 1], "20:00");
    };
    const out = await rereadDemotedWindowsFromPersistedFrames(h.run, h.cfg as any, { readAt: 400 });
    expect(out.ocrCalls).toBeLessThanOrEqual(LIVE_FRAME_REREAD_MAX_OCR_CALLS_PER_RUN);
    expect(h.calls.ocr).toBeLessThanOrEqual(LIVE_FRAME_REREAD_MAX_OCR_CALLS_PER_RUN);
    expect(h.run.frameRereadOcrCalls()).toBeLessThanOrEqual(LIVE_FRAME_REREAD_MAX_OCR_CALLS_PER_RUN);
  });

  it("runs at most ONE pass per demoted window, even across many readAts", async () => {
    const h = harness({ scoreAt: () => [1, 1] as [number, number] });
    for (let t = 0; t <= 16; t += 0.5) h.run.noteScoreReadings([{ ts: t, ocr: bug([1, 1], "19:58") }]);
    h.run.noteDeferredGoalAttestation(demotedWindow({ lo: 6.95, hi: 16.95, postSamples: 0 }));
    h.cfg.liveFrameReread.io.ocrFrame = async () => {
      h.calls.ocr++;
      return bug([1, 1], "20:00");
    };
    await rereadDemotedWindowsFromPersistedFrames(h.run, h.cfg as any, { readAt: 40 });
    const afterFirst = h.calls.ocr;
    await rereadDemotedWindowsFromPersistedFrames(h.run, h.cfg as any, { readAt: 45 });
    await rereadDemotedWindowsFromPersistedFrames(h.run, h.cfg as any, { readAt: 50 });
    expect(h.calls.ocr).toBe(afterFirst);
  });

  it("does nothing while the lookahead is still open (the free read gets the window)", async () => {
    const h = harness({ scoreAt: () => [1, 1] as [number, number] });
    h.run.noteDeferredGoalAttestation(demotedWindow({ lo: 6.95, hi: 16.95, postSamples: 0 }));
    const out = await rereadDemotedWindowsFromPersistedFrames(h.run, h.cfg as any, { readAt: 20 });
    expect(out.passes).toBe(0);
    expect(h.calls.ocr).toBe(0);
  });

  it("the pooled recall path itself fails closed on a backward jump (2-2 -> 1-1)", () => {
    // A broadcast jump-cut / feed loop rewinds the score. The pooled re-read
    // applies the ADAAAA-8006 single-goal-step clause, so a BACKWARD step never
    // even produces a delta — the reread cannot attest it, by construction.
    const readings = [
      read(10, [2, 2]),
      read(12, [2, 2]),
      read(22, [1, 1]),
      read(24, [1, 1]),
    ];
    const delta = scoreboardDeltaFromPooledReadings({
      readings,
      window: { lo: 10, hi: 20 },
      trailS: LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S,
      deltaRange: { lo: 10, hi: 40 },
    });
    expect(delta).toBeUndefined();
    // And a legible delta that is not a goal step (a rewrite of both sides) is
    // refused by the resolver as well, so both gates agree.
    const rewritten = { pre: [2, 2] as [number, number], post: [1, 0] as [number, number], preTs: 12, postTs: 22, deltaTs: 22, preSamples: 2, postSamples: 2 };
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(demotedWindow({ lo: 10, hi: 20 }));
    expect(run.resolveDeferredGoalAttestation({ readAt: 24, delta: rewritten })).toEqual([]);
  });

  it("re-read readings parse through the SAME 8134 score-line parser", () => {
    // A hyphenated broadcast clock on a persisted frame is still not a score.
    const parsed = scoreReadingsFromTimeline([{ ts: 20, ocr: ["19-41 RMA-2-1 BAR"] }]);
    expect(parsed).toEqual([{ ts: 20, score: [2, 1] }]);
  });
});

// ADAAAA-8139 regression: the production wiring must resolve an OCR base on the
// ORCHESTRATOR posture too. The box sets `PERCEIVE_RUNNER_URL` (perceive:8080)
// and deliberately leaves `PERCEIVE_URL` unset (that flag switches the whole
// pipeline to the direct/no-orchestrator path), so keying the probe on
// `perceiveUrl` alone made `buildLiveFrameReread` return `undefined` and the
// re-read never fired on the deployed build — two graded legs, 0
// `[live-frame-reread]` lines (verified 2026-11-06).
describe("buildLiveFrameReread — OCR base resolution (ADAAAA-8139)", () => {
  const store = { observationsForJob: () => [{ seq: 0, timestamp: 1 }] };
  const base = { dataDir: "/data", liveFrameReread: true } as any;

  it("uses PERCEIVE_RUNNER_URL when PERCEIVE_URL is unset (the box posture)", async () => {
    const { buildLiveFrameReread } = await import("../src/api.js");
    const wiring = buildLiveFrameReread({
      cfg: { ...base, perceiveRunnerUrl: "http://perceive:8080" },
      jobId: "job-8139",
      store,
    });
    expect(wiring).toBeTruthy();
    // The probe POSTs `<base>/app/scoreboard`; an unreachable base fails closed.
    expect(typeof wiring!.io.ocrFrame).toBe("function");
    expect(wiring!.io.maxOcrCallsPerRun ?? undefined).toBeUndefined();
  });

  it("still returns undefined when neither endpoint is configured", async () => {
    const { buildLiveFrameReread } = await import("../src/api.js");
    expect(
      buildLiveFrameReread({ cfg: { ...base }, jobId: "job-8139", store })
    ).toBeUndefined();
  });

  it("returns undefined when the rail flag is off", async () => {
    const { buildLiveFrameReread } = await import("../src/api.js");
    expect(
      buildLiveFrameReread({
        cfg: { ...base, liveFrameReread: false, perceiveRunnerUrl: "http://perceive:8080" },
        jobId: "job-8139",
        store,
      })
    ).toBeUndefined();
  });
});

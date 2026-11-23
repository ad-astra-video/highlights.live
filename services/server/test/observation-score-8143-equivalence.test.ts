// ADAAAA-8143 AC2 equivalence replay — storage text vs the ADAAAA-8139 pixel
// re-read, on the graded leg (job bca08173-1418-437e-9c22-24af6b748111).
//
// AC2: "on one stored job, an attestation run over the persisted text reaches the
// same demoted/kept decision as the ADAAAA-8139 pixel re-read. A replay is
// enough; it must cost 0 GPU and 0 clip debits." AC5: NULL rows must read as
// `not_captured`, never as a score of 0.
//
// The fixture is the leg's REAL frame inventory (431 rows, `seq` + content
// `timestamp`, read-only from box Postgres), so the replay runs over the geometry
// the re-read actually picks frames from. The scoreboard states are the ones the
// ADAAAA-8139 ticket measured on this recording: every in-window read is the PRE
// state (1-1; `scoreReads 34, preSamples 34, postSamples 0` at accept time) and
// the board first reads 2-1 at t=20 s. Both lanes drive the SHIPPED seams —
// `runFrameRereadPass` for the pixel re-read, `storedScoreCensus` +
// `noteScoreReadings` + `scoreboardDeltaFromPooledReadings` +
// `applyDeferredGoalAttestations` for storage — from the same seeded ledger, and
// the DECISION is what gets compared.
//
// Measured on this run ($0, no GPU, no leg, no deploy):
//   storage lane  0 OCR calls   1-1 -> 2-1 @20.004s  preSamples 36  postSamples 34  KEPT
//   pixel lane    4 OCR calls   1-1 -> 2-1 @23.481s  preSamples 31  postSamples  3  KEPT
//
// The pixel lane's 4-frame sample used to land its two tail picks at 17.009 s
// (pre) and 36.484 s (post) because `evenlyPick` took the tail's first and last
// frame and the overlay flip at 20 s sits between them: 4 OCR calls, 2 new
// ledger readings, postSamples 1 < need 2, row DEMOTED — the ADAAAA-9332 defect.
// The fix (ADAAAA-9332) drops frames whose read the ledger already holds and
// spreads the 4 tail picks over the whole lookahead (17.009 / 23.481 / 29.979 /
// 36.484 s, 6.5 s apart), so the straddle yields 3 POST samples, 4 NEW ledger
// readings, and a transition instant (23.481 s) within the confirm gap of the
// last PRE read. Both lanes now reach the KEPT decision on the leg's own
// geometry; the instants differ (23.481 vs 20.004 s) only because the pixel lane
// samples ~2.1 fps while storage reads every captured row.
//
// What this cannot prove at $0: a pre-8143 leg never stored OCR text (the served
// `job_observations` has no score column, so every historic row is NULL by
// construction). AC1's no-backfill rule means historic legs keep re-reading
// pixels; the equivalence applies to legs written after this commit.
import { describe, expect, it } from "vitest";
import {
  LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S,
  LiveRunShared,
  applyDeferredGoalAttestations,
  parseOcrScoreLine,
  rereadDemotedWindowsFromPersistedFrames,
  scoreboardDeltaFromPooledReadings,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer";
import {
  LIVE_FRAME_REREAD_MAX_FRAMES,
  LIVE_FRAME_REREAD_MAX_OCR_CALLS_PER_RUN,
} from "../src/live-frame-reread";
import { scoreTextForObservation, storedScoreCensus, storedScoreRows } from "../src/observation-score";
import leg from "./fixtures/8143-leg-bca08173-observations.json";

const LEG_JOB = "bca08173-1418-437e-9c22-24af6b748111";
const HIGHLIGHT = "b0b7d191-1858-4f2f-9476-f5f7c42945af";

/** The leg's persisted frame inventory, ascending by seq (= content order). */
const INVENTORY: { seq: number; ts: number }[] = (leg as any).observations.map(
  (o: { seq: number; timestamp: number }) => ({ seq: o.seq, ts: o.timestamp })
);

/** The demoted row's judged window (the ADAAAA-8139 fixture's own numbers) and
 *  the deferred lookahead that must close before the re-read is due. */
const WINDOW = { lo: 6.95, hi: 16.95 };
const LOOKAHEAD = LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S; // 20 s
const READ_AT = WINDOW.hi + LOOKAHEAD; // 36.95
/** The board first reads the new score at t=20 s on this recording (8139). */
const FLIP_TS = 20;
const PRE: [number, number] = [1, 1];
const POST: [number, number] = [2, 1];

type ScoreAt = (ts: number) => [number, number];

/** The scorebug's score at a content instant — the one fact both lanes read:
 *  the pixel lane from a fresh crop of the persisted JPEG, storage from the
 *  OCR lines the perceive leg stored on the frame's row. */
const scoreUpTo = (flip: number, pre: [number, number] = PRE, post: [number, number] = POST): ScoreAt =>
  (ts) => (ts >= flip ? post : pre);

/** A scorebug OCR line. The clock never parses as a score (ADAAAA-8189/8507). */
const bug = (score: [number, number]) => [`19:58 RMA ${score[0]}-${score[1]} BAR`];

/** The accept-time ledger: only what the rail had read when the row was demoted
 *  (8139 measured `scoreReads 34, preSamples 34, postSamples 0`). */
function seedAcceptTimeLedger(run: LiveRunShared, at: ScoreAt) {
  const rows = INVENTORY.filter((f) => f.ts >= WINDOW.lo - 6 && f.ts <= WINDOW.hi).map((f) => ({
    ts: f.ts,
    ocr: bug(at(f.ts)),
  }));
  return run.noteScoreReadings(rows, "football");
}

/** The demoted row as the run stores it (deferred entry, `postSamples < need`). */
function demotedEntry() {
  return {
    highlightId: HIGHLIGHT,
    jobId: LEG_JOB,
    lo: WINDOW.lo,
    hi: WINDOW.hi,
    anchorTs: WINDOW.hi,
    triggerKind: "goal_bias" as const,
    scoreReads: { scoreReads: 34, preSamples: 34, postSamples: 0, need: 2 },
  };
}

/** The pooled call both lanes end on (identical params — the only difference is
 *  where the readings came from). */
function pooledDelta(run: LiveRunShared): ScoreboardDeltaEvidence | undefined {
  return scoreboardDeltaFromPooledReadings({
    readings: run.scoreReadBuffer(),
    window: WINDOW,
    trailS: LOOKAHEAD,
    deltaRange: { lo: WINDOW.lo, hi: WINDOW.hi + LOOKAHEAD },
  });
}

/** Lane A — the shipped ADAAAA-8139 pixel re-read over the persisted frames. */
async function pixelReplay(at: ScoreAt) {
  const run = new LiveRunShared();
  seedAcceptTimeLedger(run, at);
  run.noteDeferredGoalAttestation(demotedEntry());
  const before = pooledDelta(run); // the free path's verdict (demoted)
  const calls = { ocr: 0, decide: 0, perceivePipeline: 0 };
  const upgrades: any[] = [];
  const cfg = {
    jobId: LEG_JOB,
    onDeferredGoalAttested: (up: any) => upgrades.push(up),
    liveFrameReread: {
      io: {
        framesInSpan: (lo: number, hi: number) => INVENTORY.filter((f) => f.ts >= lo && f.ts <= hi),
        // The frame bytes carry the seq, so the injected probe can name the frame
        // it OCR'd — the real probe gets the JPEG and returns its crop's text.
        loadFrame: async (seq: number) => Buffer.from(String(seq)).toString("base64"),
        ocrFrame: async (b64: string) => {
          calls.ocr++;
          const seq = Number(Buffer.from(b64, "base64").toString());
          const frame = INVENTORY.find((f) => f.seq === seq);
          return frame ? bug(at(frame.ts)) : null;
        },
      },
    },
  };
  const out = await rereadDemotedWindowsFromPersistedFrames(run, cfg as any, { readAt: READ_AT });
  const after = pooledDelta(run); // the verdict the re-read produces
  const samplePost = run.scoreReadBuffer().filter((r) => r.ts > WINDOW.hi && r.score[0] === POST[0] && r.score[1] === POST[1]);
  return { run, before, after, out, calls, upgrades, samplePost };
}

/** Lane B — the same decision read from `job_observations.score_text`.
 *  `capture` models what the perceive leg's crop actually captured per frame:
 *  the default is "every analysed frame captured its line" (the leg read a line
 *  on 34 of the ~34 in-span frames); the partially-read variants below drop rows
 *  to NULL, which is the AC5 case. */
function storedReplay(opts: { at: ScoreAt; capture?: (f: { seq: number; ts: number }) => boolean; upTo?: number }) {
  const capture = opts.capture ?? (() => true);
  const upTo = opts.upTo ?? READ_AT;
  const observations = INVENTORY.filter((f) => f.ts <= upTo).map((f) => {
    const lines = capture(f) ? scoreTextForObservation(bug(opts.at(f.ts)), "football") : null;
    return { seq: f.seq, timestamp: f.ts, ...(lines ? { scoreText: lines } : {}) };
  });
  const census = storedScoreCensus(observations, { sport: "football" });
  const rows = storedScoreRows(observations, { sport: "football" });

  const run = new LiveRunShared();
  seedAcceptTimeLedger(run, opts.at);
  run.noteDeferredGoalAttestation(demotedEntry());
  const before = pooledDelta(run);
  // Fold the captured rows exactly as the live rail folds a window's reads.
  const captured = rows.filter((r) => r.status === "captured" && r.ocr);
  const added = run.noteScoreReadings(
    captured.map((r) => ({ ts: r.timestamp, ocr: r.ocr! })),
    "football"
  );
  const after = pooledDelta(run);
  const upgrades: any[] = [];
  const applied = applyDeferredGoalAttestations(
    run,
    { jobId: LEG_JOB, onDeferredGoalAttested: (up: any) => upgrades.push(up) } as any,
    { readAt: READ_AT, delta: after }
  );
  return { run, census, rows, observations, before, after, added, applied, upgrades, ocrCalls: 0 };
}

describe("AC2 — equivalence replay on leg bca08173 (0 GPU, 0 clip debits)", () => {
  it("the leg's own inventory is the real 431-row frame set the re-read picks from", () => {
    expect(INVENTORY).toHaveLength(431);
    expect(INVENTORY[0].seq).toBe(0);
    expect(INVENTORY[430].ts).toBeCloseTo(202.343, 3);
    // ~2.1 persisted frames per content second; the tail the re-read samples
    // (16.95 -> 36.95) holds dozens of frames, not a synthetic 1 fps grid.
    const tail = INVENTORY.filter((f) => f.ts > WINDOW.hi && f.ts <= WINDOW.hi + LOOKAHEAD);
    expect(tail.length).toBeGreaterThan(20);
  });

  it("the free path demotes the row before either lane contributes evidence", async () => {
    const a = await pixelReplay(scoreUpTo(FLIP_TS));
    const b = storedReplay({ at: scoreUpTo(FLIP_TS) });
    // Seed-only ledger = the measured `postSamples 0` shape.
    expect(a.before).toBeUndefined();
    expect(b.before).toBeUndefined();
    expect(a.out.passes).toBe(1);
  });

  it("same decision on a flip the 4-frame sample can see (AC2, literal)", async () => {
    // Flip at 17.0 s: both tail picks read the new score, so the sample clears
    // the bar on its own and the two lanes must agree on the SAME transition.
    const at = scoreUpTo(17);
    const a = await pixelReplay(at);
    const b = storedReplay({ at });
    expect(a.after).toBeDefined();
    expect(b.after).toBeDefined();
    expect(a.after!.pre).toEqual(b.after!.pre);
    expect(a.after!.post).toEqual(b.after!.post);
    expect(a.after!.pre).toEqual(PRE);
    expect(a.after!.post).toEqual(POST);
    expect(a.after!.deltaTs).toBe(b.after!.deltaTs);
    // The kept decision, on both lanes: the row moves from celebration to GOAL.
    expect(a.upgrades).toHaveLength(1);
    expect(b.applied).toBe(1);
    expect(a.upgrades[0].highlightId).toBe(HIGHLIGHT);
    expect(b.upgrades[0].highlightId).toBe(HIGHLIGHT);
  });

  it("storage reaches the kept decision on the leg's measured straddle geometry", () => {
    // The real recording: the flip at 20 s sits between the sample's first two
    // tail picks, so the 4-frame sample needs the ADAAAA-9332 fix to see it.
    // Storage reads every captured row, so it attests regardless.
    const b = storedReplay({ at: scoreUpTo(FLIP_TS) });
    expect(b.after).toBeDefined();
    expect(b.after!.pre).toEqual(PRE);
    expect(b.after!.post).toEqual(POST);
    expect(b.after!.deltaTs).toBeCloseTo(20.004, 2);
    expect(b.after!.preSamples).toBe(36);
    expect(b.after!.postSamples).toBe(34);
    expect(b.applied).toBe(1);
    expect(b.upgrades[0].highlightId).toBe(HIGHLIGHT);
    expect(b.upgrades[0].delta.pre).toEqual(PRE);
    expect(b.upgrades[0].delta.post).toEqual(POST);
  });

  it("the pixel sample now bridges the straddle: >= 2 POST reads, 4 new readings, row attested", async () => {
    // ADAAAA-9332: the sample's 4 calls are spent on frames the ledger does not
    // hold, spread over the whole lookahead, so the flip at 20 s falls between two
    // adjacent picks 6.5 s apart and the row clears the legibility bar.
    const a = await pixelReplay(scoreUpTo(FLIP_TS));
    expect(a.out.ocrCalls).toBe(LIVE_FRAME_REREAD_MAX_FRAMES);
    expect(a.out.ocrCalls).toBeLessThanOrEqual(LIVE_FRAME_REREAD_MAX_OCR_CALLS_PER_RUN);
    // Every call added a reading: the interior picks no longer duplicate the
    // accept-time ledger (the measured defect spent 4 calls for 2 readings).
    expect(a.out.readings).toBeGreaterThanOrEqual(3);
    // The pooled delta clears `need` on BOTH sides and names the measured step.
    expect(a.after).toBeDefined();
    expect(a.after!.pre).toEqual(PRE);
    expect(a.after!.post).toEqual(POST);
    expect(a.after!.preSamples).toBeGreaterThanOrEqual(2);
    expect(a.after!.postSamples).toBeGreaterThanOrEqual(2);
    expect(a.samplePost.length).toBeGreaterThanOrEqual(2);
    // Attribution still runs through the ADAAAA-8006 deferred path: one upgrade.
    expect(a.upgrades).toHaveLength(1);
    expect(a.upgrades[0].highlightId).toBe(HIGHLIGHT);
    // The transition instant is still inside the deferred range and within the
    // confirm gap of the last PRE read — the clause the straddle failed before.
    expect(a.after!.deltaTs).toBeGreaterThan(WINDOW.hi);
    expect(a.after!.deltaTs).toBeLessThanOrEqual(WINDOW.hi + LOOKAHEAD);
    expect(a.after!.deltaTs - a.after!.preTs).toBeLessThanOrEqual(10);
    expect(a.calls.decide).toBe(0);
    expect(a.calls.perceivePipeline).toBe(0);
  });

  it("both lanes reach the SAME kept decision on the leg's own straddle geometry", async () => {
    // AC2's literal claim, now true on the measured straddle: the pixel lane and
    // the storage lane agree on the transition (the instants differ — 23.481 s vs
    // 20.004 s — because the sample reads ~2.1 frames/s and storage reads every
    // row, but the credited step and both support counts clear `need`).
    const at = scoreUpTo(FLIP_TS);
    const a = await pixelReplay(at);
    const b = storedReplay({ at });
    expect(a.after).toBeDefined();
    expect(b.after).toBeDefined();
    expect(a.after!.pre).toEqual(b.after!.pre);
    expect(a.after!.post).toEqual(b.after!.post);
    expect(a.upgrades).toHaveLength(1);
    expect(b.applied).toBe(1);
    expect(a.upgrades[0].delta.pre).toEqual(PRE);
    expect(a.upgrades[0].delta.post).toEqual(POST);
  });

  it("storage's evidence is the sample's evidence plus the frames it skipped", async () => {
    const at = scoreUpTo(FLIP_TS);
    const a = await pixelReplay(at);
    const b = storedReplay({ at });
    const storedTs = new Set(b.run.scoreReadBuffer().map((r) => `${r.ts}`));
    for (const r of a.run.scoreReadBuffer()) expect(storedTs.has(`${r.ts}`)).toBe(true);
    expect(b.run.scoreReadBuffer().length).toBeGreaterThan(a.run.scoreReadBuffer().length);
    // So storage can never fail on a transition the sample attests.
    expect(b.census.notCaptured).toBe(0);
  });

  it("the replay costs what AC2 says: pixel lane <= 4 OCR calls, storage lane 0", async () => {
    const at = scoreUpTo(FLIP_TS);
    const a = await pixelReplay(at);
    const b = storedReplay({ at });
    expect(a.calls.ocr).toBe(a.out.ocrCalls);
    expect(a.calls.ocr).toBeLessThanOrEqual(LIVE_FRAME_REREAD_MAX_FRAMES);
    expect(a.out.ocrCalls).toBeLessThanOrEqual(LIVE_FRAME_REREAD_MAX_OCR_CALLS_PER_RUN);
    expect(a.calls.decide).toBe(0);
    expect(a.calls.perceivePipeline).toBe(0);
    // Storage reads rows; it never touches the probe, a decide, or a pipeline.
    expect(b.ocrCalls).toBe(0);
    expect(b.added).toBeGreaterThan(0);
  });

  it("a stored row's text re-parses to exactly the score that was read (one parser)", () => {
    const b = storedReplay({ at: scoreUpTo(FLIP_TS) });
    const captured = b.rows.filter((r) => r.status === "captured");
    expect(captured.length).toBe(b.census.captured);
    for (const r of captured) {
      expect(r.score).toEqual(b.census.readings.find((x) => x.ts === r.timestamp)!.score);
      expect(parseOcrScoreLine(r.ocr!, "football")).toEqual(r.score);
    }
  });

  it("a score-steady leg yields the same refused decision on both lanes", async () => {
    const steady = scoreUpTo(Number.POSITIVE_INFINITY);
    const a = await pixelReplay(steady);
    const b = storedReplay({ at: steady });
    expect(a.after).toBeUndefined();
    expect(b.after).toBeUndefined();
    expect(a.upgrades).toHaveLength(0);
    expect(b.applied).toBe(0);
  });

  it("a backward jump (2-2 -> 1-1) is refused by both lanes", async () => {
    // The ADAAAA-8134 AC-R2 case: the broadcast re-determines a state it already
    // showed. Storage and pixels both see the rewind, and neither attests it.
    const rewind = scoreUpTo(FLIP_TS, [2, 2], [1, 1]);
    const a = await pixelReplay(rewind);
    const b = storedReplay({ at: rewind });
    expect(a.upgrades).toHaveLength(0);
    expect(b.applied).toBe(0);
  });
});

describe("AC5 — partially-read legs stay honest (NULL is not a score of 0)", () => {
  it("a leg whose tail crop read nothing stays demoted on storage and does not fake 0-0", async () => {
    // The boundary AC3 keeps: the re-read exists FOR this leg shape. The rows
    // past the window close captured no line, so `score_text` is NULL there.
    const at = scoreUpTo(17); // a flip the sample CAN see, so the re-read still lifts it
    const b = storedReplay({ at, capture: (f) => f.ts <= WINDOW.hi });
    expect(b.census.notCaptured).toBeGreaterThan(0);
    expect(b.census.captured).toBeGreaterThan(0);
    // NULL rows contribute NO reading, and nothing reads as 0-0.
    expect(b.census.readings.some((r) => r.score[0] === 0 && r.score[1] === 0)).toBe(false);
    expect(b.census.readings.every((r) => r.ts <= WINDOW.hi)).toBe(true);
    expect(b.rows.filter((r) => r.status === "not_captured").every((r) => r.score === undefined)).toBe(true);
    // Storage alone cannot lift the row here ...
    expect(b.after).toBeUndefined();
    expect(b.applied).toBe(0);
    // ... while the pixel re-read still can, which is why the <= 8 bound holds.
    const a = await pixelReplay(at);
    expect(a.upgrades).toHaveLength(1);
  });

  it("reports the leg-wide census honestly (captured / not_captured / unparseable)", () => {
    const b = storedReplay({
      at: scoreUpTo(FLIP_TS),
      capture: (f) => f.ts <= WINDOW.hi - 6 || (f.ts > WINDOW.hi && f.ts % 2 === 0),
    });
    const total = b.census.captured + b.census.notCaptured + b.census.unparseable;
    expect(total).toBe(b.census.rows);
    expect(b.census.rows).toBe(b.observations.length);
    // A jersey/caption line is not a scoreboard: unparseable, never 0-0.
    const junk = storedScoreCensus([{ seq: 0, timestamp: 5, scoreText: ["BENZEMA 9"] }], { sport: "football" });
    expect(junk.unparseable).toBe(1);
    expect(junk.notCaptured).toBe(0);
    expect(junk.readings).toEqual([]);
  });
});

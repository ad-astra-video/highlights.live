// ADAAAA-8610: the rewind guard has to cover the ACCEPT lane, not only the
// deferred re-attestation lane.
//
// Measured on live job `0cade089` (served build `3f5734e`, `file-sim` of a
// looping fixture): the run read `2-2` at 116 s, then four goal-shaped windows
// re-read the board BELOW that state (`0-0 -> 0-1` at 147.667 s, `1-1` at
// 181.667 s, `2-1` at 214.667 s, `1-1` at 313.667 s) and every one of them
// shipped as a GOAL. The deferred lane refused the same shape at 280.667 s
// ("lands below the score state this run already read (2-2)"), which is why that
// window stayed `BIG_PLAY` — but the accept lane
// (`noteScoreReadings -> deriveWindowAttestation -> claimScoreTransition`) never
// consulted `scoreStateAlreadyRead`, so a rewind read that arrived with its own
// legible in-window delta attested a new goal.
//
// Shape rules this gate must NOT break (all pinned elsewhere, re-asserted here
// because the gate sits on the same seam):
//
//  - a genuine forward step that reaches the state already read still attests
//    (`2-1 -> 2-2` on the second clip of `54c03cfc`): the compare is strictly
//    BELOW, not "at or below";
//  - an EARLIER transition delivered out of order still attests (accepts
//    complete out of order on the offload path, ADAAAA-8078): the frontier is
//    dated by the read that seated it, so nothing before it can be a rewind;
//  - a run with no earlier score state fails open (absent evidence is not a
//    contradiction).
//
// And one interaction this gate deliberately does NOT override: ADAAAA-8604 (R2)
// re-baselines the high-water on a detected KICKOFF (two contiguous `0-0` reads
// after a non-zero state), so a scoreboard that resets to `0-0` on screen — a new
// match, or a looping broadcast fixture like `0cade089` — re-opens attestation by
// design. The last test below pins that, so the residual is a stated contract
// rather than a silent hole.
import { describe, expect, it, vi } from "vitest";
import {
  LiveRunShared,
  observeAcceptOnly,
  type AnalyzerConfig,
  type DecisionResult,
} from "../src/analyzer.js";

/** One perceive timeline record the live payload carries (ts + OCR lines). */
interface TimelineRecord {
  ts: number;
  ocr?: string[];
  tracks?: unknown[];
  objects?: unknown[];
}

function liveCfg() {
  return {
    jobId: "job-0cade089",
    gameHint: "soccer",
    clipBeforeS: 6,
    clipAfterS: 9,
    clipWindowMinSec: 15,
    preferLabels: [],
    confirmEnabled: false,
    liveObserveLoop: true,
    observeWindowS: 10,
    sampleFps: 3,
  } as unknown as AnalyzerConfig;
}

function goalDecision(): DecisionResult {
  return {
    isHighlight: true,
    score: 92,
    outcome: "scoring_play",
    eventType: "GOAL",
    reason: "the ball hits the net and the players celebrate",
  } as DecisionResult;
}

/** One live window's payload: the FULL observation set plus the 4 delivered
 *  images the cell actually ships (the last one AT the window's end). */
function livePayloadOf(records: TimelineRecord[], centerTs: number) {
  const n = records.length;
  const picks = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1];
  const frames = picks.map((i, seq) => ({ ts: records[i].ts, imageB64: "f", seq }));
  return {
    centerTs,
    frames,
    seeds: records.map((r) => ({ ts: r.ts, tracks: [], objects: [], ocr: r.ocr })),
    observations: records,
    biasHints: [],
    capped: false,
    droppedCount: 0,
  } as any;
}

const cut = async (t: number) => ({ clipId: `clip-${t}`, clipUri: "" });

/** The stored row's `attestationUsed`. ADAAAA-8663 declared `transitionKey` (and
 *  `transitionScore`) in the events schema, so the persisted shape carries it;
 *  the widening cast is kept so this file stays readable from the run ledger too
 *  (which holds the analyzer's richer payload, not the parsed row). */
const used = (row: { attestationUsed?: unknown }) =>
  (row.attestationUsed ?? {}) as Record<string, unknown>;
const client = { decide: async () => goalDecision(), confirm: async () => ({ enabled: false }) } as any;

/** The `2-2` the run read at 116 s on `0cade089` — the state every later window
 *  has to be compared against. Seated through the run's own read seam, exactly
 *  as `noteScoreReadings` does for an accepted window. */
function seatTwoTwo(run: LiveRunShared) {
  run.noteScoreReadings([
    { ts: 112.0, ocr: ["2 - 2"] },
    { ts: 116.0, ocr: ["2 - 2"] },
  ]);
  return run;
}

/** Read records for a window whose scoreboard goes `pre` -> `post`. */
function readsOf(pre: string, post: string, lo: number, hi: number): TimelineRecord[] {
  return [
    { ts: lo, ocr: [pre] },
    { ts: lo + 1, ocr: [pre] },
    { ts: hi - 1, ocr: [post] },
    { ts: hi, ocr: [post] },
  ] as TimelineRecord[];
}

describe("ADAAAA-8610 / accept lane: a measured rewind cannot attest a GOAL", () => {
  it("refuses the 214.667 s rewind (own reads 1-1 -> 2-1) after the run read 2-2 at 116 s", async () => {
    // The stored shape minus the kickoff: the window's own delta is a legible
    // single forward goal step, but its POST `2-1` lands below the `2-2` the run
    // already read (per team: the away side drops 2 -> 1, ADAAAA-8604 R1).
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const run = seatTwoTwo(new LiveRunShared({ goalBurstWindowS: 1 }));
      expect(run.scoreHighWaterState()).toEqual([2, 2]);
      await observeAcceptOnly(
        client,
        run,
        cut,
        liveCfg(),
        undefined,
        livePayloadOf(readsOf("1 - 1", "2 - 1", 205, 213), 214.667),
        goalDecision()
      );
      // Fail closed: the row still ships (a moment happened on screen) but it
      // leaves the scoring lane, so it can never be posted as a GOAL.
      expect(run.highlights).toHaveLength(1);
      expect(run.highlights[0].eventType).toBe("BIG_PLAY");
      expect(run.highlights[0].outcome).toBe("big_play");
      expect(used(run.highlights[0]).scoreBoardChanged).toBe(false);
      expect(used(run.highlights[0]).scoreRewindRefusal).toContain(
        "lands below the score state this run already read (2-2)"
      );
      expect(run.highlights[0].reason).toContain("a rewind cannot attest a new GOAL");
      // Auditable on the leg's own log, like the deferred lane's refusal line.
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
        "[live-score-rewind:job-0cade089] refused the window read"
      );
      // The refused transition never burns a run-wide key: the genuine forward
      // step from the same baseline can still claim its own.
      expect(run.creditedScoreTransitionKeys()).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("refuses it on the POOLED lane too (window-own span short of the legibility bar)", async () => {
    // The stored windows that carried only two post reads: the window's own
    // timeline has no PRE side, so the pooled re-read over the ledger is what
    // would have attested the rewind. Both lanes are gated.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const run = seatTwoTwo(new LiveRunShared({ goalBurstWindowS: 1 }));
      // The previous window's reads (folded by the rail at 141 s).
      run.noteScoreReadings([
        { ts: 134.0, ocr: ["1 - 1"] },
        { ts: 138.0, ocr: ["1 - 1"] },
      ]);
      await observeAcceptOnly(
        client,
        run,
        cut,
        liveCfg(),
        undefined,
        livePayloadOf(
          [
            { ts: 145.0, ocr: ["1 - 2"] },
            { ts: 147.0, ocr: ["1 - 2"] },
          ] as TimelineRecord[],
          147.667
        ),
        goalDecision()
      );
      expect(run.highlights.map((h) => h.eventType)).toEqual(["BIG_PLAY"]);
      expect(used(run.highlights[0]).scoreRewindRefusal).toContain("1-1>1-2");
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("refused the pooled read");
      expect(run.creditedScoreTransitionKeys()).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});

describe("ADAAAA-8610 / accept lane: the gate does not eat genuine goals", () => {
  it("accepts a forward step past the high-water (2-2 -> 2-3)", async () => {
    const run = seatTwoTwo(new LiveRunShared({ goalBurstWindowS: 1 }));
    await observeAcceptOnly(
      client,
      run,
      cut,
      liveCfg(),
      undefined,
      livePayloadOf(readsOf("2 - 2", "2 - 3", 138, 146), 147.667),
      goalDecision()
    );
    expect(run.highlights.map((h) => h.eventType)).toEqual(["GOAL"]);
    expect(used(run.highlights[0]).transitionKey).toBe("2-2>2-3");
    expect(used(run.highlights[0]).scoreRewindRefusal).toBeUndefined();
  });

  it("keeps the second clip's repeated 2-1 -> 2-2 accept (post lands ON the state already read)", async () => {
    // The `54c03cfc` rer8139 goal at 351.118 s: the second clip repeats the first
    // clip's progression, so its POST is exactly the state the run already read.
    // Strictly-below keeps this a GOAL (the withdrawn one-key-per-run rule that
    // would have demoted it stays withdrawn).
    const run = seatTwoTwo(new LiveRunShared({ goalBurstWindowS: 1 }));
    await observeAcceptOnly(
      client,
      run,
      cut,
      liveCfg(),
      undefined,
      livePayloadOf(readsOf("2 - 1", "2 - 2", 338, 346), 347.0),
      goalDecision()
    );
    expect(run.highlights.map((h) => h.eventType)).toEqual(["GOAL"]);
    expect(used(run.highlights[0]).transitionKey).toBe("2-1>2-2");
  });

  it("credits an EARLIER transition delivered out of order (dated frontier, ADAAAA-8078)", async () => {
    // The offload path completes accepts out of order: the window at 100 s is
    // judged AFTER the window at 168 s already read 2-2 (frontier dated 165 s).
    // Its own transition (`1-1 -> 2-1` at 95 s) is earlier than that instant, so
    // it is the run catching up — not a rewind of a state it had passed.
    const run = new LiveRunShared({ goalBurstWindowS: 1 });
    await observeAcceptOnly(
      client,
      run,
      cut,
      liveCfg(),
      undefined,
      livePayloadOf(readsOf("2 - 1", "2 - 2", 160, 166), 168.0),
      goalDecision()
    );
    expect(run.scoreHighWaterState()).toEqual([2, 2]);
    expect(run.scoreHighWaterReadAt()).toBe(165);
    await observeAcceptOnly(
      client,
      run,
      cut,
      liveCfg(),
      undefined,
      livePayloadOf(readsOf("1 - 1", "2 - 1", 92, 96), 100.0),
      goalDecision()
    );
    expect(run.highlights.map((h) => h.eventType)).toEqual(["GOAL", "GOAL"]);
    expect(used(run.highlights[1]).transitionKey).toBe("1-1>2-1");
  });

  it("fails OPEN when the run has no earlier score state", async () => {
    const run = new LiveRunShared({ goalBurstWindowS: 1 });
    await observeAcceptOnly(
      client,
      run,
      cut,
      liveCfg(),
      undefined,
      livePayloadOf(readsOf("1 - 1", "2 - 1", 92, 96), 100.0),
      goalDecision()
    );
    expect(run.scoreHighWaterState()).toEqual([2, 1]);
    expect(run.highlights.map((h) => h.eventType)).toEqual(["GOAL"]);
  });

  it("keeps the ADAAAA-8604 R2 contract: a detected kickoff re-opens attestation", async () => {
    // Two contiguous `0-0` reads after a non-zero state are a NEW MATCH (or, on a
    // looping broadcast fixture, the board resetting on screen) — R2 re-baselines
    // the high-water to `0-0`, so the new match's first goal attests. The rewind
    // gate must not override that: it compares against the CURRENT frontier.
    const run = seatTwoTwo(new LiveRunShared({ goalBurstWindowS: 1 }));
    await observeAcceptOnly(
      client,
      run,
      cut,
      liveCfg(),
      undefined,
      livePayloadOf(readsOf("0 - 0", "0 - 1", 138, 146), 147.667),
      goalDecision()
    );
    expect(run.scoreKickoffBaselineResets()).toBe(1);
    // The re-baseline lands after this window's own seat pass, so the frontier is
    // the kickoff state itself; the window's `0-1` is not below it and attests.
    expect(run.scoreHighWaterState()).toEqual([0, 0]);
    expect(run.highlights.map((h) => h.eventType)).toEqual(["GOAL"]);
  });
});

describe("ADAAAA-8610 / the settled record: the four 0cade089 POSTs are all refused", () => {
  it("refuses POST 0-1, 1-1, 2-1 and 1-1 against the run's printed high-water 2-2", () => {
    // The stored rows the parent grade (ADAAAA-8600 clause 2) named, in record
    // order, with the transition each window measured:
    //   99e75d43 (147.667 s) 0-0 -> 0-1
    //   994f2f76 (181.667 s) 0-1 -> 1-1
    //   b68b8967 (214.667 s) 1-1 -> 2-1
    //   2fd6de6e (313.667 s) 0-1 -> 1-1
    // Every POST is below the `2-2` this run had already read at 116 s, so every
    // one of them is a rewind and cannot attest a GOAL.
    const run = seatTwoTwo(new LiveRunShared());
    const stored: Array<[[number, number], [number, number], number]> = [
      [[0, 0], [0, 1], 147.667],
      [[0, 1], [1, 1], 181.667],
      [[1, 1], [2, 1], 214.667],
      [[0, 1], [1, 1], 313.667],
    ];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [pre, post, deltaTs] of stored) {
        expect(run.scoreRewindRefusal({
          pre,
          post,
          preTs: deltaTs - 2,
          postTs: deltaTs,
          deltaTs,
          preSamples: 2,
          postSamples: 2,
        })).toContain("lands below the score state this run already read (2-2)");
        expect(run.admitScoreDelta({
          pre,
          post,
          preTs: deltaTs - 2,
          postTs: deltaTs,
          deltaTs,
          preSamples: 2,
          postSamples: 2,
        })).toBe(false);
      }
      // Not one of them burned a transition key.
      expect(run.creditedScoreTransitionKeys()).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});

describe("ADAAAA-8610 / the frontier is dated by the read that seated it", () => {
  it("records the FIRST instant the state was read, and re-dates on a kickoff", () => {
    const run = new LiveRunShared();
    run.noteScoreReadings([{ ts: 116.0, ocr: ["2 - 2"] }]);
    expect(run.scoreHighWaterReadAt()).toBe(116.0);
    // A later re-read of the same state does not move the frontier's instant.
    run.noteScoreReadings([{ ts: 300.0, ocr: ["2 - 2"] }]);
    expect(run.scoreHighWaterReadAt()).toBe(116.0);
    // A new match's kickoff re-baselines BOTH the state and its instant.
    run.noteScoreReadings([
      { ts: 400.0, ocr: ["0 - 0"] },
      { ts: 403.0, ocr: ["0 - 0"] },
    ]);
    expect(run.scoreHighWaterState()).toEqual([0, 0]);
    expect(run.scoreHighWaterReadAt()).toBe(403.0);
    expect(run.scoreKickoffBaselineResets()).toBe(1);
  });

  it("admits and refuses on the accept lane's own predicate", () => {
    const run = seatTwoTwo(new LiveRunShared());
    const delta = (pre: [number, number], post: [number, number], deltaTs: number) =>
      ({ pre, post, preTs: deltaTs - 1, postTs: deltaTs, deltaTs, preSamples: 2, postSamples: 2 }) as never;
    const refused = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(run.scoreRewindRefusal(delta([1, 1], [2, 1], 145))).toContain("(2-2)");
      expect(run.admitScoreDelta(delta([1, 1], [2, 1], 145))).toBe(false);
      expect(run.admitScoreDelta(delta([2, 2], [2, 3], 145))).toBe(true);
      // Equal state: the repeat of the transition already read is not a rewind.
      expect(run.admitScoreDelta(delta([2, 1], [2, 2], 145))).toBe(true);
      // Earlier instant than the read that seated the frontier: fail open.
      expect(run.admitScoreDelta(delta([1, 1], [2, 1], 95))).toBe(true);
      // No water at all: absent evidence is not a contradiction.
      expect(new LiveRunShared().admitScoreDelta(delta([1, 1], [2, 1], 95))).toBe(true);
    } finally {
      refused.mockRestore();
    }
  });
});

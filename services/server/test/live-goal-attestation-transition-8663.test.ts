// ADAAAA-8663: a delivered GOAL row must disclose the transition it was CREDITED
// for, durably, on the row itself.
//
// Gap measured on leg `5f4c60cf-0844-48d1-afa6-92563512752f` (graded by QA on
// ADAAAA-8662): both delivered GOAL rows stored `attestationUsed.transitionKey =
// null` even though a score transition HAD been credited, so the attested POST
// was only readable from the leg's stderr (`[live-goal-gate-upgrade]`,
// `[goal-burst-suppress]`) — which dies with the next container recreate. The
// row is the durable evidence contract, so half (a) of a rewind-guard grade
// became log archaeology instead of one SQL query.
//
// Root cause (one line): the analyzer filled `transitionKey` from ADAAAA-8140,
// but the `@highlights/events` `attestationUsed` zod object never declared it, so
// `HighlightRecordSchema.parse` — the ONLY write path (`Store.addHighlight` /
// `Store.attestDeferredGoal`) — stripped the field on persist. In-memory tests
// read `run.highlights` (unparsed) and so never noticed.
//
// This file therefore asserts on the PERSISTED row (the shape the box stores),
// not on the run's in-memory ledger:
//   - a credited accept carries a non-null `transitionKey` + its `{pre, post}`;
//   - the deferred/promoted lane carries both too;
//   - a celebration/refused row keeps NULL (rows that never claimed stay null);
//   - the events schema accepts and round-trips the fields.
import { describe, expect, it, vi } from "vitest";
import { HighlightRecordSchema, type HighlightRecord } from "@highlights/events";
import {
  LiveRunShared,
  attestationUsedForDeferredResolution,
  observeAcceptOnly,
  type AnalyzerConfig,
  type DecisionResult,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer.js";
import { Store } from "../src/store.js";

interface TimelineRecord {
  ts: number;
  ocr?: string[];
  tracks?: unknown[];
  objects?: unknown[];
}

function liveCfg() {
  return {
    jobId: "job-8663",
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
const client = { decide: async () => goalDecision(), confirm: async () => ({ enabled: false }) } as any;

/** Read records for a window whose scoreboard goes `pre` -> `post`. */
function readsOf(pre: string, post: string, lo: number, hi: number): TimelineRecord[] {
  return [
    { ts: lo, ocr: [pre] },
    { ts: lo + 1, ocr: [pre] },
    { ts: hi - 1, ocr: [post] },
    { ts: hi, ocr: [post] },
  ] as TimelineRecord[];
}

/** What a `psql -At` grade actually reads: the stored JSON projection of
 *  `highlights.record->'attestationUsed'` (one JSON round-trip, exactly what the
 *  DB text column holds). */
const sqlProjection = (row: HighlightRecord) =>
  (JSON.parse(JSON.stringify(row)) as { attestationUsed?: Record<string, any> }).attestationUsed ?? {};

const delta8663: ScoreboardDeltaEvidence = {
  pre: [1, 1],
  post: [2, 1],
  preTs: 96,
  postTs: 99,
  deltaTs: 99,
  preSamples: 3,
  postSamples: 2,
};

describe("ADAAAA-8663 / a credited accept persists its transition", () => {
  it("stores transitionKey + {pre, post} on a delivered GOAL row (window-own lane)", async () => {
    // Deliberately NOT read through `run.highlights`: that is the unparsed
    // in-memory ledger, which is why the strip went unseen. Persist it.
    const run = new LiveRunShared({ goalBurstWindowS: 1 });
    await observeAcceptOnly(
      client,
      run,
      cut,
      liveCfg(),
      undefined,
      livePayloadOf(readsOf("1 - 1", "2 - 1", 92, 100), 100),
      goalDecision()
    );
    expect(run.highlights.map((h) => h.eventType)).toEqual(["GOAL"]);
    expect(run.creditedScoreTransitionKeys()).toEqual(["1-1>2-1"]);

    const store = new Store(null);
    const { record } = await store.addHighlight(run.highlights[0]);
    expect(record.eventType).toBe("GOAL");
    expect(record.outcome).toBe("scoring_play");
    // The durable contract: readable from the row alone.
    expect(record.attestationUsed?.transitionKey).toBe("1-1>2-1");
    expect(record.attestationUsed?.transitionScore).toEqual({ pre: [1, 1], post: [2, 1] });
    // And through the exact projection a box SQL grade reads.
    const projected = sqlProjection(record);
    expect(projected.transitionKey).toBe("1-1>2-1");
    expect(projected.transitionScore).toEqual({ pre: [1, 1], post: [2, 1] });
  });

  it("stores it on the POOLED re-read lane too (window-own span short of the bar)", async () => {
    const run = new LiveRunShared({ goalBurstWindowS: 1 });
    // PRE side lives in the previous window; this window carries only the POST
    // reads, so the pooled re-read over the run ledger is what claims the
    // transition — the `["live-score-pooled"]` shape of the graded leg.
    run.noteScoreReadings([
      { ts: 134.0, ocr: ["1 - 1"] },
      { ts: 138.0, ocr: ["1 - 1"] },
    ]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
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
      expect(run.highlights.map((h) => h.eventType)).toEqual(["GOAL"]);
      expect(run.creditedScoreTransitionKeys()).toEqual(["1-1>1-2"]);

      const store = new Store(null);
      const { record } = await store.addHighlight(run.highlights[0]);
      expect(record.attestationUsed?.transitionKey).toBe("1-1>1-2");
      expect(record.attestationUsed?.transitionScore).toEqual({ pre: [1, 1], post: [1, 2] });
    } finally {
      log.mockRestore();
    }
  });

  it("does not change admission: the claim ledger and delivered counts are untouched", async () => {
    const run = new LiveRunShared({ goalBurstWindowS: 1 });
    await observeAcceptOnly(
      client,
      run,
      cut,
      liveCfg(),
      undefined,
      livePayloadOf(readsOf("1 - 1", "2 - 1", 92, 100), 100),
      goalDecision()
    );
    // Persistence only: one row delivered, one transition credited, no refusal.
    expect(run.highlights).toHaveLength(1);
    expect(run.creditedScoreTransitionKeys()).toEqual(["1-1>2-1"]);
    expect(run.scoreFrontierRefusals()).toBe(0);
    expect(run.highlights[0].attestationUsed?.scoreRewindRefusal).toBeUndefined();
  });
});

describe("ADAAAA-8663 / rows that claimed nothing keep NULL", () => {
  it("a refused (rewind) celebration row stores no transitionKey and no pair", async () => {
    // The ADAAAA-8610 accept-lane rewind shape: a measured, admitted-nowhere
    // transition refused below the run's read high-water. It ships as a
    // celebration and MUST NOT disclose a credited transition.
    const run = new LiveRunShared({ goalBurstWindowS: 1 });
    run.noteScoreReadings([
      { ts: 112.0, ocr: ["2 - 2"] },
      { ts: 116.0, ocr: ["2 - 2"] },
    ]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await observeAcceptOnly(
        client,
        run,
        cut,
        liveCfg(),
        undefined,
        livePayloadOf(readsOf("1 - 1", "2 - 1", 205, 213), 214.667),
        goalDecision()
      );
      expect(run.highlights.map((h) => h.eventType)).toEqual(["BIG_PLAY"]);

      const store = new Store(null);
      const { record } = await store.addHighlight(run.highlights[0]);
      const projected = sqlProjection(record);
      // SQL NULL, exactly what the graded leg's two GOAL rows did NOT have.
      expect(projected.transitionKey ?? null).toBeNull();
      expect(projected.transitionScore).toBeUndefined();
      // The refusal itself is still disclosed (ADAAAA-8610 unchanged).
      expect(projected.scoreRewindRefusal).toContain("lands below the score state this run already read (2-2)");
      expect(run.creditedScoreTransitionKeys()).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("an uncontested celebration stores neither field", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const run = new LiveRunShared({ goalBurstWindowS: 1 });
      // No score reads at all: the ADAAAA-7996 gate demotes the GOAL accept to a
      // celebration, claiming nothing.
      await observeAcceptOnly(
        client,
        run,
        cut,
        liveCfg(),
        undefined,
        livePayloadOf([{ ts: 198.0, ocr: [] }, { ts: 202.0, ocr: [] }] as TimelineRecord[], 202),
        goalDecision()
      );
      expect(run.highlights.map((h) => h.eventType)).toEqual(["BIG_PLAY"]);
      const store = new Store(null);
      const { record } = await store.addHighlight(run.highlights[0]);
      const projected = sqlProjection(record);
      expect(projected.transitionKey ?? null).toBeNull();
      expect(projected.transitionScore).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });
});

describe("ADAAAA-8663 / the deferred (promoted) lane persists both too", () => {
  it("attestDeferredGoal keeps the resolving transition's key and pair", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A celebration row, exactly as the accept lane ships a demoted GOAL.
      const run = new LiveRunShared({ goalBurstWindowS: 1 });
      await observeAcceptOnly(
        client,
        run,
        cut,
        liveCfg(),
        undefined,
        livePayloadOf([{ ts: 198.0, ocr: [] }, { ts: 202.0, ocr: [] }] as TimelineRecord[], 202),
        goalDecision()
      );
      const celebration = run.highlights[0];
      expect(celebration.outcome).toBe("big_play");

      const store = new Store(null);
      await store.addHighlight(celebration);
      const used = attestationUsedForDeferredResolution({
        delta: delta8663,
        scoreReads: { scoreReads: 12, preSamples: 4, postSamples: 2, need: 2 },
      });
      expect(used.transitionKey).toBe("1-1>2-1");
      expect(used.transitionScore).toEqual({ pre: [1, 1], post: [2, 1] });

      const promoted = await store.attestDeferredGoal(celebration.id, {
        outcome: "scoring_play",
        eventType: "GOAL",
        attestationUsed: used,
      });
      expect(promoted.outcome).toBe("scoring_play");
      const projected = sqlProjection(promoted);
      expect(projected.transitionKey).toBe("1-1>2-1");
      expect(projected.transitionScore).toEqual({ pre: [1, 1], post: [2, 1] });
    } finally {
      log.mockRestore();
    }
  });
});

describe("ADAAAA-8663 / @highlights/events round-trips the attestation", () => {
  const attestation = {
    scoreBoardChanged: true,
    goalCrossed: false,
    ballOutcome: null,
    corroborated: false,
    goalConfirmed: null,
    scoreReads: 32,
    preSamples: 6,
    postSamples: 4,
    need: 2,
    transitionKey: "3-1>4-1",
    transitionScore: { pre: [3, 1], post: [4, 1] },
  };

  it("accepts the field and keeps it through parse -> JSON -> parse", async () => {
    const run = new LiveRunShared({ goalBurstWindowS: 1 });
    await observeAcceptOnly(
      client,
      run,
      cut,
      liveCfg(),
      undefined,
      livePayloadOf(readsOf("1 - 1", "2 - 1", 92, 100), 100),
      goalDecision()
    );
    const stored = (await new Store(null).addHighlight(run.highlights[0])).record;

    const withAttestation = HighlightRecordSchema.parse({ ...stored, attestationUsed: attestation });
    expect(withAttestation.attestationUsed?.transitionKey).toBe("3-1>4-1");
    expect(withAttestation.attestationUsed?.transitionScore).toEqual({ pre: [3, 1], post: [4, 1] });

    const reparsed = HighlightRecordSchema.parse(JSON.parse(JSON.stringify(withAttestation)));
    expect(reparsed.attestationUsed).toEqual(withAttestation.attestationUsed);

    // An explicit null is a legal "claimed nothing" value (SQL NULL).
    const nulled = HighlightRecordSchema.parse({
      ...stored,
      attestationUsed: { ...attestation, transitionKey: null, transitionScore: undefined },
    });
    expect(nulled.attestationUsed?.transitionKey).toBeNull();
    expect(nulled.attestationUsed?.transitionScore).toBeUndefined();
  });

  it("rejects a malformed pair instead of dropping it silently", async () => {
    const run = new LiveRunShared({ goalBurstWindowS: 1 });
    await observeAcceptOnly(
      client,
      run,
      cut,
      liveCfg(),
      undefined,
      livePayloadOf(readsOf("1 - 1", "2 - 1", 92, 100), 100),
      goalDecision()
    );
    const stored = (await new Store(null).addHighlight(run.highlights[0])).record;
    expect(() =>
      HighlightRecordSchema.parse({
        ...stored,
        attestationUsed: { ...attestation, transitionScore: { pre: [1], post: [2, 1] } },
      })
    ).toThrow();
  });
});

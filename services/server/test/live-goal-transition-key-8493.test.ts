import { describe, expect, it } from "vitest";
import { HighlightRecordSchema } from "@highlights/events";
import type { HighlightRecord } from "@highlights/events";
import { SqliteDb } from "../src/db";
import { Store } from "../src/store";
import {
  attestationUsedForDeferredResolution,
  liveGoalAttestationUsed,
  type LiveGoalAttestationUsed,
} from "../src/analyzer";

// ADAAAA-8493: an ACCEPTED GOAL row must disclose the score transition it
// credited. `liveGoalAttestationUsed()` (analyzer.ts:2001) spreads
// `transitionKey` on accepted rows and `attestationUsedForDeferredResolution()`
// always sets it, but `HighlightRecordSchema.attestationUsed` did not declare the
// key — Zod strips undeclared keys, and `Store.addHighlight` parses every row
// through that schema before it is stored. Measured on the instance DB
// (2026-11-09): 1710 `outcome=scoring_play` rows, 0 carrying
// `attestationUsed.transitionKey`.
//
// Fixture: leg `ec4c3e0e-aa74-4068-949f-d263b9a824d9`, delivered GOAL
// `1e56d981` @125.667 s — pooled reads split `2-1` -> `2-2`, so the credited
// transition is `2-1>2-2` (ADAAAA-8491 recorded the same key on its ledger).

const JOB = "ec4c3e0e-aa74-4068-949f-d263b9a824d9";
const TRANSITION = "2-1>2-2";

/** The measured attribution the live accept path folded for the delivered GOAL. */
const MEASURED_ATTRIBUTION = {
  scoreBoardChanged: true,
  goalCrossed: false,
  ballOutcome: undefined,
  scoreBoardDelta: {
    pre: [2, 1] as [number, number],
    post: [2, 2] as [number, number],
    preTs: 121.5,
    postTs: 125.5,
    deltaTs: 125.5,
    preSamples: 6,
    postSamples: 2,
  },
};

function acceptedGoalRow(
  overrides: Partial<HighlightRecord> = {}
): HighlightRecord {
  return {
    id: "1e56d981-3859-4f01-8c8f-bd0116b3271e",
    jobId: JOB,
    clipUri: "/clips/ec4c3e0e-1e56d981.mp4",
    start: 116,
    end: 131,
    localizedTs: 125.667,
    localizeSignal: "trigger",
    eventType: "GOAL",
    score: 90,
    outcome: "scoring_play",
    reason: "Scoreboard changes from 2-1 to 2-2 at t=-4.0s.",
    caption: "Scoreboard changes from 2-1 to 2-2 at t=-4.0s.",
    status: "accepted",
    createdAt: "2026-11-09T21:14:00.000Z",
    ...overrides,
  };
}

/** The census predicate the ticket quotes: `attestationUsed ? 'transitionKey'`. */
function censusRowsWithTransitionKey(rows: HighlightRecord[]): HighlightRecord[] {
  return rows.filter((r) => Boolean(r.attestationUsed?.transitionKey));
}

describe("attestationUsed.transitionKey survives the contract (ADAAAA-8493)", () => {
  it("keeps the credited transition on a parsed accepted GOAL row", () => {
    const used = liveGoalAttestationUsed({
      attribution: MEASURED_ATTRIBUTION,
      transitionKey: TRANSITION,
    });
    expect(used.transitionKey).toBe(TRANSITION);

    const parsed = HighlightRecordSchema.parse(
      acceptedGoalRow({ attestationUsed: used })
    );
    expect(parsed.attestationUsed?.transitionKey).toBe(TRANSITION);
    // The five flags and the ADAAAA-8134 read counts are untouched.
    expect(parsed.attestationUsed?.scoreBoardChanged).toBe(true);
    expect(parsed.attestationUsed?.postSamples).toBeUndefined();
  });

  it("accepts null (no credited transition) without inventing a key", () => {
    const parsed = HighlightRecordSchema.parse(
      acceptedGoalRow({
        attestationUsed: {
          scoreBoardChanged: false,
          goalCrossed: false,
          ballOutcome: null,
          corroborated: false,
          goalConfirmed: null,
          transitionKey: null,
        },
      })
    );
    expect(parsed.attestationUsed?.transitionKey).toBeNull();
  });

  it("leaves a legacy attestation byte-identical (no key added)", () => {
    const legacy: LiveGoalAttestationUsed = {
      scoreBoardChanged: true,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
      scoreReads: 14,
      preSamples: 14,
      postSamples: 0,
      need: 2,
    };
    const parsed = HighlightRecordSchema.parse(
      acceptedGoalRow({ attestationUsed: legacy })
    );
    expect(parsed.attestationUsed).toEqual(legacy);
    expect("transitionKey" in parsed.attestationUsed!).toBe(false);
  });

  it("always discloses the deferred resolution's key", () => {
    const used = attestationUsedForDeferredResolution({
      delta: MEASURED_ATTRIBUTION.scoreBoardDelta,
      scoreReads: { scoreReads: 8, preSamples: 6, postSamples: 2, need: 2 },
    });
    expect(used.transitionKey).toBe(TRANSITION);
    const parsed = HighlightRecordSchema.parse(
      acceptedGoalRow({ attestationUsed: used })
    );
    expect(parsed.attestationUsed?.transitionKey).toBe(TRANSITION);
  });
});

describe("store write path persists the transition (ADAAAA-8493)", () => {
  it("round-trips through the real SQLite record column", async () => {
    const db = new SqliteDb(":memory:");
    const store = new Store(db);

    const used = liveGoalAttestationUsed({
      attribution: MEASURED_ATTRIBUTION,
      transitionKey: TRANSITION,
    });
    const { created } = await store.addHighlight(
      acceptedGoalRow({ attestationUsed: used })
    );
    expect(created).toBe(true);

    // What a post-deploy read inspects: the stored row, not the builder's object.
    const stored = await db.getHighlight("1e56d981-3859-4f01-8c8f-bd0116b3271e");
    expect(stored?.outcome).toBe("scoring_play");
    expect(stored?.attestationUsed?.transitionKey).toBe(TRANSITION);
    expect(JSON.stringify(stored)).toContain(`"transitionKey":"${TRANSITION}"`);

    // A restart reads it back through the hydrate path.
    const reloaded = new Store(db);
    await reloaded.load();
    expect(
      reloaded.getHighlight("1e56d981-3859-4f01-8c8f-bd0116b3271e")?.attestationUsed
        ?.transitionKey
    ).toBe(TRANSITION);

    await db.close();
  });

  it("census over written rows is nonzero, and legacy rows stay uncounted", async () => {
    const db = new SqliteDb(":memory:");
    const store = new Store(db);

    // One ACCEPTED GOAL that credited a measured transition …
    await store.addHighlight(
      acceptedGoalRow({
        attestationUsed: liveGoalAttestationUsed({
          attribution: MEASURED_ATTRIBUTION,
          transitionKey: TRANSITION,
        }),
      })
    );
    // … one ACCEPTED GOAL carried by another channel (no measured delta) …
    await store.addHighlight(
      acceptedGoalRow({
        id: "1e56d981-legacy",
        idempotencyKey: "hl:ec4c3e0e:900:GOAL",
        attestationUsed: liveGoalAttestationUsed({
          attribution: { scoreBoardChanged: false },
          goalConfirmed: "asr_goal_call",
        }),
      })
    );
    // … and a celebration (no attestation at all), the noisy majority.
    await store.addHighlight(
      acceptedGoalRow({
        id: "1e56d981-celebration",
        idempotencyKey: "hl:ec4c3e0e:901:BIG_PLAY",
        eventType: "BIG_PLAY",
        outcome: "big_play",
      })
    );

    const stored = await db.listHighlights();
    expect(stored).toHaveLength(3);
    const census = censusRowsWithTransitionKey(stored);
    expect(census).toHaveLength(1);
    expect(census[0].attestationUsed?.transitionKey).toBe(TRANSITION);
    expect(census[0].outcome).toBe("scoring_play");

    await db.close();
  });
});

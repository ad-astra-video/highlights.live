// ADAAAA-8893 (D5, spec ADAAAA-8891 §4 D5) — the dive's re-centered cut is an
// OPTION of the card, never a replacement of it.
//
// The board's instruction, verbatim: "Always keep the first clip but provide a
// re-centered/adjusted clip as another option if the deep dive provides one."
//
// These tests pin the contract seam (AC5.1), the reserved slot (AC5.2/AC5.5
// bound) and the claim-neutrality that makes AC5.4 true by construction: the
// delivery seam has no write path to the owner row at all.
import { describe, expect, it } from "vitest";
import {
  MAX_ALTERNATIVES_PER_HIGHLIGHT,
  MAX_CLIP_RAIL_SLIDES,
  MAX_RECENTERED_ALTERNATIVES_PER_HIGHLIGHT,
  RECENTERED_ALTERNATIVE_EVENT_TYPE,
  HighlightAlternativeSchema,
  HighlightRecordSchema,
  type HighlightAlternative,
  type HighlightRecord,
} from "@highlights/events";
import { alternativePickerLabel } from "../src/clip-choice";
import {
  RECENTERED_MOMENT_BUCKET_S,
  acceptAnchorOf,
  buildRecenteredAlternative,
  canAddRecenteredAlternative,
  deliverRecenteredOption,
  recenteredAlternativeId,
  recenteredDedupeKey,
  recenteredMomentBucket,
} from "../src/recentered-alternative";

/** The owning card of a live goal (the shape the dive re-anchors on: a promoted
 *  `confirmed_goal` with a measured anchor). */
const owner: HighlightRecord = HighlightRecordSchema.parse({
  id: "hl-8893",
  ownerId: "owner",
  jobId: "job-8893",
  start: 150,
  end: 166,
  localizedTs: 158.667,
  clipUri: "/clips/job-8893-1587.mp4",
  eventType: "GOAL",
  outcome: "scoring_play",
  status: "accepted",
  score: 88,
  reason: "a striker finishes low past the keeper",
  createdAt: "2026-11-13T04:08:35.666Z",
});

const alt = (over: Partial<HighlightAlternative> = {}): HighlightAlternative =>
  HighlightAlternativeSchema.parse({
    id: "alt-recentered",
    jobId: "job-8893",
    highlightId: "hl-8893",
    relation: "alternative_of",
    eventType: "recentered",
    outcome: "scoring_play",
    windowAnchorTs: 162.25,
    distanceToGoalEndS: 3.75,
    score: 82,
    start: 150,
    end: 166,
    clipUri: "/clips/job-8893-1587-recentered.mp4",
    dedupeKey: "alt:hl-8893:recentered:162.000",
    createdAt: "2026-11-13T04:09:00.000Z",
    ...over,
  });

describe("the contract carries a third alternative role", () => {
  it("accepts a `recentered` alternative with its dive provenance", () => {
    const row = alt({ momentConfidence: 0.82, acceptAnchorTs: 158.667, driftSec: 3.583, clipBytes: 1_204_214 });
    expect(row.eventType).toBe(RECENTERED_ALTERNATIVE_EVENT_TYPE);
    expect(row.momentConfidence).toBeCloseTo(0.82, 6);
    expect(row.acceptAnchorTs).toBeCloseTo(158.667, 3);
    expect(row.driftSec).toBeCloseTo(3.583, 3);
    expect(row.clipBytes).toBe(1_204_214);
  });

  it("rejects an event type outside the closed enum (never `goal`)", () => {
    expect(() => alt({ eventType: "goal" as any })).toThrow();
  });

  it("keeps the celebration/replay cap and reserves its own slot", () => {
    // the celebration/replay cap is untouched by D5.
    expect(MAX_ALTERNATIVES_PER_HIGHLIGHT).toBe(2);
    expect(MAX_RECENTERED_ALTERNATIVES_PER_HIGHLIGHT).toBe(1);
    // own + 2 celebration/replay + 1 re-centered
    expect(MAX_CLIP_RAIL_SLIDES).toBe(4);
  });
});

describe("the option's identity is its own namespace", () => {
  it("keys on owner + `recentered` + moment bucket", () => {
    expect(recenteredDedupeKey("hl-8893", 162.25)).toBe(
      `alt:hl-8893:recentered:${recenteredMomentBucket(162.25).toFixed(3)}`
    );
    expect(recenteredDedupeKey("hl-8893", 162.25)).not.toBe(recenteredDedupeKey("hl-8893", 163.9));
    expect(recenteredDedupeKey("hl-8893", 162.25).startsWith("alt:hl-8893:recentered:")).toBe(true);
  });

  it("is stable across float noise (a re-dive of the same instant is one row)", () => {
    // a few ulps either side of the same instant must land in the same bucket
    expect(recenteredMomentBucket(162.2499999)).toBe(recenteredMomentBucket(162.2500001));
    expect(recenteredMomentBucket(162.7499999)).toBe(recenteredMomentBucket(162.7500001));
    expect(recenteredDedupeKey("hl-8893", 162.2499999)).toBe(recenteredDedupeKey("hl-8893", 162.2500001));
    expect(recenteredMomentBucket(162.25) % RECENTERED_MOMENT_BUCKET_S).toBe(0);
    expect(recenteredAlternativeId(recenteredDedupeKey("hl-8893", 162.25))).toBe(
      recenteredAlternativeId(recenteredDedupeKey("hl-8893", 162.25))
    );
  });
});

describe("the reserved slot does not consume the celebration/replay cap", () => {
  const celebration = alt({ id: "alt-c1", eventType: "celebration", windowAnchorTs: 180, dedupeKey: "alt:hl-8893:180.000" });
  const replay = alt({ id: "alt-r1", eventType: "replay", windowAnchorTs: 170, dedupeKey: "alt:hl-8893:170.000" });

  it("two celebration/replay rows leave the re-centered slot open", () => {
    expect(canAddRecenteredAlternative([celebration, replay], "hl-8893")).toBe(true);
  });

  it("one re-centered row takes the reserved slot (bounded: 1)", () => {
    expect(canAddRecenteredAlternative([celebration, replay, alt()], "hl-8893")).toBe(false);
  });

  it("another highlight's option never blocks this row", () => {
    expect(canAddRecenteredAlternative([alt({ highlightId: "hl-other" })], "hl-8893")).toBe(true);
  });
});

describe("the option row states the dive's provenance", () => {
  const built = buildRecenteredAlternative({
    jobId: "job-8893",
    ownerId: "owner",
    owner,
    momentTs: 162.25,
    momentConfidence: 0.82,
    acceptAnchorTs: 158.667,
    clipUri: "/clips/job-8893-1587-recentered.mp4",
    clipWindow: { start: 150, end: 166 },
    clipBytes: 1_204_214,
  });

  it("anchors on the dive moment, under the owner", () => {
    expect(built.eventType).toBe("recentered");
    expect(built.relation).toBe("alternative_of");
    expect(built.highlightId).toBe(owner.id);
    expect(built.windowAnchorTs).toBe(162.25);
    expect(built.clipUri).toContain("-recentered");
  });

  it("stamps confidence, the accept anchor and the SIGNED drift", () => {
    expect(built.momentConfidence).toBeCloseTo(0.82, 6);
    expect(built.acceptAnchorTs).toBeCloseTo(158.667, 3);
    expect(built.driftSec).toBeCloseTo(162.25 - 158.667, 3);
    expect(built.clipBytes).toBe(1_204_214);
  });

  it("keeps a negative drift negative (an EARLIER dive instant is not clamped)", () => {
    const early = buildRecenteredAlternative({
      jobId: "job-8893",
      owner,
      momentTs: 156.5,
      acceptAnchorTs: 158.667,
      clipUri: "/clips/job-8893-1587-recentered.mp4",
      clipWindow: { start: 150, end: 166 },
    });
    expect(early.driftSec).toBeCloseTo(-2.167, 3);
    expect(early.momentConfidence).toBeUndefined();
  });

  it("inherits the owner's outcome and is never a GOAL claim of its own", () => {
    expect(built.outcome).toBe("scoring_play");
    expect(alternativePickerLabel(built)).toBe("Re-centered @ 162 s");
  });
});

describe("delivery keeps the card's clip and never writes the owner row", () => {
  function harness(existing: HighlightAlternative[] = [], cutResult?: { clipUri: string; start: number; end: number; bytes?: number; offsetSec?: number | null }) {
    const rows = new Map([[owner.id, structuredClone(owner)]]);
    const stored: HighlightAlternative[] = [...existing];
    const cutCalls: number[] = [];
    const deps = {
      getHighlight: (id: string) => rows.get(id),
      alternativesForHighlight: (id: string) => stored.filter((a) => a.highlightId === id),
      addAlternative: async (a: HighlightAlternative) => {
        stored.push(a);
        return { record: a, created: true };
      },
      log: () => {},
    };
    const deliver = (dive = { ts: 162.25, confidence: 0.82 }) =>
      deliverRecenteredOption({
        deps,
        jobId: "job-8893",
        highlightId: owner.id,
        dive,
        cut: async () => {
          cutCalls.push(dive.ts);
          return cutResult ?? { clipUri: "/clips/job-8893-1587-recentered.mp4", start: 150, end: 166, bytes: 1_204_214 };
        },
      });
    return { rows, stored, cutCalls, deliver };
  }

  it("adds exactly one option and leaves the owner row byte-identical", async () => {
    const h = harness();
    const before = structuredClone(h.rows.get(owner.id));
    const option = await h.deliver();

    expect(option).not.toBeNull();
    expect(h.cutCalls).toHaveLength(1); // AC5.5: at most one re-cut attempt
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0].eventType).toBe("recentered");
    expect(h.stored[0].clipUri).not.toBe(before!.clipUri); // own file, never the card's
    // AC5.1/AC5.2: the card keeps its accept-anchor clip, byte for byte.
    expect(h.rows.get(owner.id)).toEqual(before);
    expect(h.rows.get(owner.id)?.clipUri).toBe("/clips/job-8893-1587.mp4");
  });

  it("stamps where the dive moment actually landed in the option file (ADAAAA-8906)", async () => {
    // The D5 grade could only see this by probing footage, because the row did
    // not record the delivered placement. The option row now carries the
    // measured number, so a mis-anchored cut is readable from the row.
    const h = harness([], { clipUri: "/clips/job-8893-1587-recentered.mp4", start: 150, end: 166, offsetSec: 11.02 });
    const option = await h.deliver();
    expect(option?.momentDeliveredOffsetSec).toBeCloseTo(11.02, 3);
    // Absent (content-clock fallback / a rail that measured nothing) stays absent.
    const noMeasure = harness([], { clipUri: "/clips/job-8893-1587-recentered.mp4", start: 150, end: 166 });
    expect((await noMeasure.deliver())?.momentDeliveredOffsetSec).toBeUndefined();
  });

  it("never cuts a second option for the same row", async () => {
    const h = harness([alt()]);
    const option = await h.deliver();
    expect(option).toBeNull();
    expect(h.cutCalls).toHaveLength(0);
    expect(h.stored).toHaveLength(1);
  });

  it("a failed option cut stores nothing and keeps the card serving", async () => {
    const h = harness([], { clipUri: "", start: 150, end: 166 });
    const before = structuredClone(h.rows.get(owner.id));
    const option = await h.deliver();
    expect(option).toBeNull();
    expect(h.stored).toHaveLength(0);
    expect(h.rows.get(owner.id)).toEqual(before);
  });

  it("a missing row delivers nothing", async () => {
    const h = harness();
    const option = await deliverRecenteredOption({
      deps: {
        getHighlight: () => undefined,
        alternativesForHighlight: () => [],
        addAlternative: async (a: HighlightAlternative) => ({ record: a, created: true }),
      },
      jobId: "job-8893",
      highlightId: "hl-gone",
      dive: { ts: 1 },
      cut: async () => ({ clipUri: "/clips/x.mp4", start: 0, end: 15 }),
    });
    expect(option).toBeNull();
  });
});

describe("acceptAnchorOf mirrors the row's accept anchor", () => {
  it("prefers localizedTs, then the trigger, then nothing", () => {
    expect(acceptAnchorOf({ localizedTs: 158.667 })).toBeCloseTo(158.667, 3);
    expect(acceptAnchorOf({ localizedTs: undefined as any, trigger: { timestamp: 40 } })).toBe(40);
    expect(acceptAnchorOf({ localizedTs: undefined as any })).toBeNull();
  });
});

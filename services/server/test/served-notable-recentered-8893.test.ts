// ADAAAA-8893 (D5): a dive's re-centered option must be served on the card it
// belongs to — on the NOTABLE lane too.
//
// The dive most often re-centers a card that its own score lane HELD
// (`dive_held` => `big_play`), and a `big_play` row is rendered by the notable
// card builder. The notable builder used to carry `siblingClips` only, so the
// option row existed in the payload but no card owned it: the served rail showed
// one slide while the row carried an alternative. This pins the shared builder
// (composite AND delta both call it).
import { describe, expect, it } from "vitest";
import { HighlightAlternativeSchema, HighlightRecordSchema, JobDetailSchema } from "@highlights/events";
import { countSuppressedSiblingAlternatives, servedNotableRow } from "../src/served-highlight-rows";

const owner = HighlightRecordSchema.parse({
  id: "hl-notable-8893",
  ownerId: "owner",
  jobId: "job-8893",
  start: 150,
  end: 166,
  localizedTs: 158.667,
  clipUri: "/clips/job-8893-1587.mp4",
  eventType: "BIG_PLAY",
  outcome: "big_play",
  status: "accepted",
  score: 85,
  reason: "a striker finishes low past the keeper",
  createdAt: "2026-11-13T06:52:00.000Z",
});

const recentered = HighlightAlternativeSchema.parse({
  id: "alt-recentered-8893",
  jobId: "job-8893",
  highlightId: owner.id,
  relation: "alternative_of",
  eventType: "recentered",
  outcome: "big_play",
  windowAnchorTs: 162.667,
  distanceToGoalEndS: 3.333,
  score: 100,
  start: 150,
  end: 166,
  clipUri: "/clips/job-8893-1587-recentered.mp4",
  clipBytes: 5_566_448,
  momentConfidence: 1,
  acceptAnchorTs: 158.667,
  driftSec: 4,
  dedupeKey: `alt:${owner.id}:recentered:162.500`,
  createdAt: "2026-11-13T06:53:06.973Z",
});

const ctx = { exportUriFor: () => "/export/tok" };
const cluster = { owner, options: [], memberCount: 1 } as any;

describe("the notable card serves its own re-centered option", () => {
  it("carries the option under the card, with its own clip (slide 2)", () => {
    const row = servedNotableRow(cluster, undefined, ctx, { alternatives: [recentered] });
    expect(row.clipUri).toBe("/clips/job-8893-1587.mp4"); // slide 1 = the card's clip
    expect(row.alternatives?.map((a) => a.eventType)).toEqual(["recentered"]);
    expect(row.alternatives?.[0].clipUri).toBe("/clips/job-8893-1587-recentered.mp4");
    expect(row.alternatives?.[0].driftSec).toBe(4);
  });

  it("survives the payload parse (JobDetailSchema must keep notable alternatives)", () => {
    // The detail route parses through JobDetailSchema. A notable row shape that
    // has no `alternatives` field strips it silently — the option then exists in
    // the DB and in the builder's output but reaches no slide.
    const row = servedNotableRow(cluster, undefined, ctx, { alternatives: [recentered] });
    const parsed = JobDetailSchema.parse({
      job: { id: "job-8893", ownerId: "owner", source: "file-sim", status: "done", createdAt: "2026-11-13T06:47:00.000Z" },
      highlights: [],
      notableHighlights: [row],
      maxTraces: 3,
    });
    expect(parsed.notableHighlights[0].alternatives?.map((a) => a.id)).toEqual(["alt-recentered-8893"]);
  });

  it("stays byte-identical when the card has no alternative", () => {
    const row = servedNotableRow(cluster, undefined, ctx);
    expect(row.alternatives).toBeUndefined();
    expect(row.clipUri).toBe("/clips/job-8893-1587.mp4");
  });
});

// ADAAAA-8912 (D5b/AC5.6b): an option delivered on a moment's SIBLING window is
// not projected (only the owner can carry one), so the read must COUNT it. The
// measured case is job a0e60cc2: sibling row `daa53f58` carries option
// `11d4d688` (recentered, window 416) and `-4150-recentered.mp4` appears nowhere
// in /detail — the option is suppressed, and the contract says report it.
describe("sibling-window options are counted, not silently dropped (AC5.6b)", () => {
  const siblingAlternative = HighlightAlternativeSchema.parse({
    ...recentered,
    id: "alt-sibling-8893",
    highlightId: "hl-sibling-8893",
    windowAnchorTs: 416,
    clipUri: "/clips/job-8893-4150-recentered.mp4",
    dedupeKey: "alt:hl-sibling-8893:recentered:416.000",
  });
  const sibling = HighlightRecordSchema.parse({
    ...owner,
    id: "hl-sibling-8893",
    start: 400,
    end: 430,
    localizedTs: 416,
    clipUri: "/clips/job-8893-4150.mp4",
  });
  const withSibling = { owner, options: [sibling], memberCount: 2 } as any;

  it("counts an option attached to a sibling window and names the row", () => {
    const counted = countSuppressedSiblingAlternatives(
      [withSibling],
      new Map([[sibling.id, [siblingAlternative]]])
    );
    expect(counted.count).toBe(1);
    expect(counted.rows).toEqual([
      { rowId: "hl-sibling-8893", ownerId: "hl-notable-8893", alternativeIds: ["alt-sibling-8893"] },
    ]);
  });

  it("counts 0 when the only option belongs to the owner (projected, not suppressed)", () => {
    const counted = countSuppressedSiblingAlternatives(
      [withSibling],
      new Map([[owner.id, [recentered]]])
    );
    expect(counted.count).toBe(0);
    expect(counted.rows).toEqual([]);
  });

  it("survives the payload parse, with the sibling row still carrying no alternativeId", () => {
    // The card serves the sibling as a read-only option: no `alternativeId` on the
    // sibling clip, so the rail cannot offer a pick for it.
    const row = servedNotableRow(withSibling, undefined, ctx, { alternatives: [] });
    expect(row.siblingClips?.[0]).not.toHaveProperty("alternativeId");
    const counted = countSuppressedSiblingAlternatives(
      [withSibling],
      new Map([[sibling.id, [siblingAlternative]]])
    );
    const parsed = JobDetailSchema.parse({
      job: { id: "job-8893", ownerId: "owner", source: "file-sim", status: "done", createdAt: "2026-11-13T06:47:00.000Z" },
      highlights: [],
      notableHighlights: [row],
      maxTraces: 3,
      suppressedSiblingAlternatives: counted,
    });
    expect(parsed.suppressedSiblingAlternatives?.count).toBe(1);
    expect(parsed.suppressedSiblingAlternatives?.rows[0].rowId).toBe("hl-sibling-8893");
  });
});

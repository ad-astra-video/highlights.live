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
import { HighlightAlternativeSchema, HighlightRecordSchema } from "@highlights/events";
import { servedNotableRow } from "../src/served-highlight-rows";

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

  it("stays byte-identical when the card has no alternative", () => {
    const row = servedNotableRow(cluster, undefined, ctx);
    expect(row.alternatives).toBeUndefined();
    expect(row.clipUri).toBe("/clips/job-8893-1587.mp4");
  });
});

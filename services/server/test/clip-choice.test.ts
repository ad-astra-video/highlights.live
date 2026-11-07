import { describe, expect, it } from "vitest";
import { HighlightAlternativeSchema, HighlightRecordSchema, type HighlightRecord } from "@highlights/events";
import {
  alternativePickerLabel,
  clipChoiceFor,
  servedClipUri,
  servedClipWindow,
  servesAlternative,
} from "../src/clip-choice";

// ADAAAA-8321 (AC6): the moment's served clip is a persisted POINTER swap. The
// pick never re-cuts, never moves the moment's own window and never touches a
// count — these tests pin that contract.
const JOB = "545be947-e989-4b26-a464-22b576d97373";

function record(over: Partial<HighlightRecord> = {}): HighlightRecord {
  return HighlightRecordSchema.parse({
    id: "goal-h1",
    jobId: JOB,
    clipUri: "/clips/original.mp4",
    start: 152,
    end: 167,
    localizedTs: 159,
    eventType: "GOAL",
    score: 95,
    outcome: "scoring_play",
    status: "accepted",
    createdAt: "2026-11-07T00:00:00.000Z",
    ...over,
  });
}

const replayAlternative = HighlightAlternativeSchema.parse({
  id: "play-h3",
  jobId: JOB,
  highlightId: "goal-h1",
  relation: "alternative_of",
  eventType: "replay",
  outcome: "big_play",
  replayOf: "goal-h1",
  replayEvidence: { kind: "footage_match", matches: 6, compared: 12, gapS: 48 },
  sourceHighlightId: "play-h3",
  windowAnchorTs: 207,
  distanceToGoalEndS: 40,
  score: 60,
  start: 200,
  end: 215,
  clipId: "play-h3",
  clipUri: "/clips/replay.mp4",
  dedupeKey: "replay:play-h3",
  createdAt: "2026-11-07T00:00:00.000Z",
});

describe("served clip", () => {
  it("serves the record's own clip when nothing is picked (the default)", () => {
    const h = record();
    expect(servedClipUri(h)).toBe("/clips/original.mp4");
    expect(servedClipWindow(h)).toEqual({ start: 152, end: 167 });
    expect(servesAlternative(h)).toBe(false);
  });

  it("serves the picked alternative's clip while the moment keeps its own window", () => {
    const h = record({
      clipChoice: { alternativeId: "play-h3", clipUri: "/clips/replay.mp4", start: 200, end: 215, chosenAt: "2026-11-07T00:00:00.000Z" },
    });
    expect(servedClipUri(h)).toBe("/clips/replay.mp4");
    expect(servedClipWindow(h)).toEqual({ start: 200, end: 215 });
    // The moment's own window is untouched: counts, ladder and quota stay put.
    expect(h.start).toBe(152);
    expect(h.end).toBe(167);
    expect(servesAlternative(h)).toBe(true);
  });

  it("restores the original when the choice is cleared", () => {
    const chosen = record({
      clipChoice: { alternativeId: "play-h3", clipUri: "/clips/replay.mp4", start: 200, end: 215, chosenAt: "2026-11-07T00:00:00.000Z" },
    });
    const { clipChoice: _drop, ...rest } = chosen;
    const cleared = HighlightRecordSchema.parse(rest);
    expect(servedClipUri(cleared)).toBe("/clips/original.mp4");
    expect(servesAlternative(cleared)).toBe(false);
  });
});

describe("clipChoiceFor", () => {
  it("accepts an alternative that belongs to the moment", () => {
    const c = clipChoiceFor("goal-h1", "play-h3", [replayAlternative], "2026-11-07T01:00:00.000Z");
    expect(c).toEqual({
      alternativeId: "play-h3",
      clipUri: "/clips/replay.mp4",
      start: 200,
      end: 215,
      chosenAt: "2026-11-07T01:00:00.000Z",
    });
  });

  it("rejects an alternative that belongs to another moment", () => {
    expect(clipChoiceFor("goal-h2", "play-h3", [replayAlternative])).toBeNull();
  });

  it("rejects an unknown id", () => {
    expect(clipChoiceFor("goal-h1", "nope", [replayAlternative])).toBeNull();
  });

  it("rejects an alternative without a clip", () => {
    const broken = HighlightAlternativeSchema.parse({ ...replayAlternative, clipUri: "" });
    expect(clipChoiceFor("goal-h1", "play-h3", [broken])).toBeNull();
  });
});

describe("alternativePickerLabel", () => {
  it("names the role and the window in customer-safe copy", () => {
    expect(alternativePickerLabel(replayAlternative)).toBe("Replay @ 207 s");
    expect(alternativePickerLabel({ eventType: "celebration", windowAnchorTs: 165 })).toBe("Celebration @ 165 s");
  });
});

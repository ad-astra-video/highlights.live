import { describe, it, expect } from "vitest";
import {
  clipRailBadgeLabel,
  clipRailDefaultIndex,
  clipRailIdentityLabel,
  clipRailPickerLabel,
  clipRailSlides,
  type ClipRailSlide,
} from "./clipRail";
import type { JobDetailAlternative, JobDetailHighlight } from "./jobDetail";

// ADAAAA-8893 (D5): the dive's re-centered cut is delivered as an OPTION, so it
// must render as its own slide ROLE beside the card's original clip — never as a
// "Celebration" and never as a replacement of slide 1 (board default).

function alt(over: Partial<JobDetailAlternative> = {}): JobDetailAlternative {
  return {
    id: "r1",
    jobId: "j1",
    highlightId: "h1",
    relation: "alternative_of",
    eventType: "recentered",
    windowAnchorTs: 47,
    start: 40,
    end: 55,
    clipUri: "/clips/j1-400-recentered.mp4",
    createdAt: "2026-11-13T04:09:00Z",
    ...over,
  };
}

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/j1-400.mp4",
    start: 40,
    end: 55,
    eventType: "GOAL",
    score: 92,
    status: "accepted",
    createdAt: "2026-11-13T04:08:35Z",
    ...over,
  };
}

function slide(over: Partial<ClipRailSlide> = {}): ClipRailSlide {
  return { kind: "recentered", key: "k", src: "/clips/x.mp4", start: 40, end: 55, momentTs: 47, ...over };
}

describe("the re-centered option is its own slide role", () => {
  it("slide 1 is ALWAYS the card's own clip; the option follows it", () => {
    const slides = clipRailSlides(hl({ alternatives: [alt()] }));
    expect(slides).toHaveLength(2);
    expect(slides[0].kind).toBe("highlight");
    expect(slides[0].src).toBe("/clips/j1-400.mp4");
    expect(slides[1].kind).toBe("recentered");
    expect(slides[1].src).toBe("/clips/j1-400-recentered.mp4");
    expect(slides[1].alternativeId).toBe("r1");
  });

  it("defaults to the original even when an option exists (no pick = board default)", () => {
    expect(clipRailDefaultIndex(hl({ alternatives: [alt()] }))).toBe(0);
  });

  it("opens on the option only after it is picked, and clearing returns to slide 1", () => {
    const picked = hl({
      alternatives: [alt()],
      clipChoice: {
        alternativeId: "r1",
        clipUri: "/clips/j1-400-recentered.mp4",
        start: 40,
        end: 55,
        chosenAt: "2026-11-13T04:10:00Z",
      },
    });
    expect(clipRailDefaultIndex(picked)).toBe(1);
    expect(clipRailDefaultIndex(hl({ alternatives: [alt()], clipChoice: undefined }))).toBe(0);
  });

  it("counts in the badge like any other clip (2 clips)", () => {
    const slides = clipRailSlides(hl({ alternatives: [alt()] }));
    expect(clipRailBadgeLabel(slides.length)).toBe("2 clips");
  });

  it("labels the option by the DIVE moment, not the clip start", () => {
    expect(clipRailPickerLabel(slide())).toBe("Re-centered @ 47 s");
    // the clip's own window start would read 40; the label must read the moment
    expect(slide().momentTs).not.toBe(slide().start);
  });

  it("never reuses the Celebration/Replay labels", () => {
    expect(clipRailPickerLabel(slide({ kind: "celebration" }))).toBe("Celebration @ 40 s");
    expect(clipRailPickerLabel(slide({ kind: "replay" }))).toBe("Replay @ 40 s");
    expect(clipRailIdentityLabel(slide()).startsWith("Re-centered · ")).toBe(true);
    expect(clipRailIdentityLabel(slide({ kind: "celebration" })).startsWith("Celebration · ")).toBe(true);
  });

  it("renders the option and a celebration side by side (own + 2 + 1 rail budget)", () => {
    const slides = clipRailSlides(
      hl({
        alternatives: [
          alt({ id: "r1", eventType: "recentered", windowAnchorTs: 47 }),
          alt({ id: "c1", eventType: "celebration", windowAnchorTs: 80 }),
          alt({ id: "c2", eventType: "celebration", windowAnchorTs: 95 }),
        ],
      })
    );
    expect(slides.map((s) => s.kind)).toEqual(["highlight", "recentered", "celebration", "celebration"]);
    expect(slides).toHaveLength(4);
  });
});

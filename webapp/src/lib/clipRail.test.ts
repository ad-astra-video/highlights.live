import { describe, it, expect } from "vitest";
import {
  clipRailBadgeLabel,
  clipRailClampIndex,
  clipRailIdentityLabel,
  clipRailIndexFromScroll,
  clipRailScrollLeft,
  clipRailSlides,
  clipRailStepIndex,
  pauseClipRailPlayers,
  type ClipRailSlide,
} from "./clipRail";
import type { JobDetailAlternative, JobDetailHighlight } from "./jobDetail";

// ADAAAA-8304: the goal card's clip rail. No jsdom in this package, so the
// interactive rules are pinned on these pure helpers (markup is graded in
// JobDetail.clipRail.test.tsx).

function alt(over: Partial<JobDetailAlternative> = {}): JobDetailAlternative {
  return {
    id: "a1",
    jobId: "j1",
    highlightId: "h1",
    relation: "alternative_of",
    eventType: "celebration",
    windowAnchorTs: 22,
    start: 20,
    end: 30,
    clipUri: "/clips/j1-61.mp4",
    createdAt: "2026-11-04T20:21:00Z",
    ...over,
  };
}

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/j1-55.mp4",
    start: 5,
    end: 20,
    eventType: "GOAL",
    score: 92,
    status: "accepted",
    createdAt: "2026-11-04T20:21:00Z",
    ...over,
  };
}

function slide(over: Partial<ClipRailSlide> = {}): ClipRailSlide {
  return { kind: "highlight", key: "k", src: "/clips/x.mp4", start: 5, end: 20, ...over };
}

describe("clipRailSlides — primary clip first, then the payload's alternatives in order", () => {
  it("a card with no alternatives yields exactly one slide (the highlight's own clip)", () => {
    const slides = clipRailSlides(hl());
    expect(slides).toHaveLength(1);
    expect(slides[0].kind).toBe("highlight");
    expect(slides[0].src).toBe("/clips/j1-55.mp4");
    expect(slides[0].start).toBe(5);
    expect(slides[0].end).toBe(20);
  });

  it("2 alternatives yield 3 slides in payload order (primary, alt-1, alt-2)", () => {
    const slides = clipRailSlides(
      hl({
        alternatives: [
          alt({ id: "a1", start: 20, end: 30, clipUri: "/clips/j1-61.mp4" }),
          alt({ id: "a2", start: 32, end: 41, clipUri: "/clips/j1-62.mp4" }),
        ],
      })
    );
    expect(slides.map((s) => s.src)).toEqual([
      "/clips/j1-55.mp4",
      "/clips/j1-61.mp4",
      "/clips/j1-62.mp4",
    ]);
    expect(slides.map((s) => s.kind)).toEqual(["highlight", "celebration", "celebration"]);
  });

  it("carries clipError through so a failed clip keeps its slide (and its badge count)", () => {
    const slides = clipRailSlides(hl({ alternatives: [alt({ clipError: "cut failed" })] }));
    expect(slides).toHaveLength(2);
    expect(slides[1].error).toBe("cut failed");
  });

  it("keeps the primary slide's bounded wait state (ADAAAA-8032)", () => {
    const slides = clipRailSlides(hl({ clipUri: "" }));
    expect(slides[0].waitingSinceMs).toBe(Date.parse("2026-11-04T20:21:00Z"));
  });
});

describe("clipRailBadgeLabel — no badge for 1 clip, the rendered count above that", () => {
  it("returns null for 0/1 slides", () => {
    expect(clipRailBadgeLabel(0)).toBeNull();
    expect(clipRailBadgeLabel(1)).toBeNull();
  });

  it("names the rendered slide count for 2 and 3 clips", () => {
    expect(clipRailBadgeLabel(2)).toBe("2 clips");
    expect(clipRailBadgeLabel(3)).toBe("3 clips");
  });
});

describe("clipRailIdentityLabel — role + the clip's own range, never the pipeline taxonomy", () => {
  it("labels the primary slide 'Highlight · <range>'", () => {
    expect(clipRailIdentityLabel(slide())).toBe("Highlight · T+5s – T+20s");
  });

  it("labels an alternative 'Celebration · <its own range>'", () => {
    expect(clipRailIdentityLabel(slide({ kind: "celebration", start: 20, end: 30 }))).toBe(
      "Celebration · T+20s – T+30s"
    );
  });
});

describe("rail index math — clamped steps, one slide per client width", () => {
  it("steps forward/backward and clamps at both edges (no wrap-around)", () => {
    expect(clipRailStepIndex(0, 1, 3)).toBe(1);
    expect(clipRailStepIndex(1, 1, 3)).toBe(2);
    expect(clipRailStepIndex(2, 1, 3)).toBe(2);
    expect(clipRailStepIndex(0, -1, 3)).toBe(0);
    expect(clipRailStepIndex(2, -1, 3)).toBe(1);
  });

  it("clamp keeps an out-of-range index inside the rail", () => {
    expect(clipRailClampIndex(9, 2)).toBe(1);
    expect(clipRailClampIndex(-4, 2)).toBe(0);
    expect(clipRailClampIndex(0, 0)).toBe(0);
  });

  it("scrollLeft is index * clientWidth (a slide occupies the card width)", () => {
    expect(clipRailScrollLeft(0, 400)).toBe(0);
    expect(clipRailScrollLeft(2, 400)).toBe(800);
    expect(clipRailScrollLeft(1, 0)).toBe(0);
  });

  it("a settled scroll maps back to the nearest slide", () => {
    expect(clipRailIndexFromScroll(0, 400, 3)).toBe(0);
    expect(clipRailIndexFromScroll(390, 400, 3)).toBe(1);
    expect(clipRailIndexFromScroll(800, 400, 3)).toBe(2);
    expect(clipRailIndexFromScroll(9999, 400, 3)).toBe(2);
  });
});

describe("pauseClipRailPlayers — at most one clip plays at a time (AC4)", () => {
  function fakeRail(): { rail: any; videos: Array<{ paused: boolean; pause: () => void }> } {
    const videos = [
      { paused: false, pause(this: { paused: boolean }) { this.paused = true; } },
      { paused: false, pause(this: { paused: boolean }) { this.paused = true; } },
      { paused: false, pause(this: { paused: boolean }) { this.paused = true; } },
    ];
    const slides = videos.map((v) => ({
      querySelectorAll: (sel: string) => (sel === "video" ? [v] : []),
    }));
    return {
      rail: { querySelectorAll: (sel: string) => (sel === "[data-detail-clip-slide]" ? slides : []) },
      videos,
    };
  }

  it("pauses every slide's player except the active one", () => {
    const { rail, videos } = fakeRail();
    pauseClipRailPlayers(rail, 1);
    expect(videos.map((v) => v.paused)).toEqual([true, false, true]);
  });

  it("is a no-op on a null rail and never re-pauses an already paused player", () => {
    expect(() => pauseClipRailPlayers(null, 0)).not.toThrow();
    const { rail, videos } = fakeRail();
    videos[0].paused = true;
    pauseClipRailPlayers(rail, 2);
    expect(videos.map((v) => v.paused)).toEqual([true, true, false]);
  });
});

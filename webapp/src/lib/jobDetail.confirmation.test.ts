import { describe, it, expect } from "vitest";
import {
  confirmationBadge,
  highlightMomentEntries,
  playTypeText,
  type HighlightConfirmation,
  type JobDetailHighlight,
} from "./jobDetail";

// ADAAAA-8530 (D1 = option A, confirmation state): the ONE badge on a Highlights
// card states whether a pipeline lane actually confirmed the row's window, and
// nothing else. These are the PURE halves the SSR fixtures in
// `pages/JobDetail.confirmationBadge.test.tsx` render:
//   - `confirmationBadge` — CONFIRMED iff lane ∈ {measured, dive}; every other
//     lane and an ABSENT lane read UNCONFIRMED (fail-closed, never invented);
//   - `playTypeText` — big play / near miss / goal-shaped as PLAIN detail text,
//     never badge copy and never an assertion that a goal was scored;
//   - `highlightMomentEntries` — ONE list: postable + notable moments ordered by
//     moment start, with a footage-less notable row kept as a text row inside it.

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/h1.mp4",
    start: 10,
    end: 25,
    eventType: "BIG_PLAY",
    score: 60,
    status: "accepted",
    createdAt: "2026-11-10T00:00:00Z",
    ...over,
  };
}

function confirmation(lane: HighlightConfirmation["lane"]): HighlightConfirmation {
  return { lane, label: `lane ${lane}` };
}

describe("confirmationBadge — CONFIRMED only on a lane that actually confirmed", () => {
  for (const lane of ["measured", "dive"] as const) {
    it(`lane=${lane} reads CONFIRMED`, () => {
      const badge = confirmationBadge(hl({ confirmation: confirmation(lane) }));
      expect(badge).toEqual({ lane, confirmed: true, text: "CONFIRMED" });
    });
  }

  for (const lane of ["dive_disagreed", "unconfirmed"] as const) {
    it(`lane=${lane} reads UNCONFIRMED`, () => {
      const badge = confirmationBadge(hl({ confirmation: confirmation(lane) }));
      expect(badge).toEqual({ lane, confirmed: false, text: "UNCONFIRMED" });
    });
  }

  it("an ABSENT lane reads UNCONFIRMED and never invents a lane", () => {
    const badge = confirmationBadge(hl());
    expect(badge.lane).toBeNull();
    expect(badge.confirmed).toBe(false);
    expect(badge.text).toBe("UNCONFIRMED");
  });
});

describe("playTypeText — taxonomy as plain detail text, never a goal claim", () => {
  it("names a demoted goal window 'goal-shaped play' (never GOAL)", () => {
    const text = playTypeText(
      hl({
        provisionalGoal: {
          status: "provisional",
          cues: ["asr_goal_call"],
          declaredTs: 10,
          note: "ASR goal call; scoreboard read still 1-1",
        },
      })
    );
    expect(text).toBe("goal-shaped play");
    expect(text ?? "").not.toMatch(/GOAL/);
  });

  it("names a big play and a near miss in lower case (no outcome code)", () => {
    expect(playTypeText(hl({ outcome: "big_play" }))).toBe("big play");
    expect(playTypeText(hl({ outcome: "near_miss" }))).toBe("near miss");
  });

  it("returns null for a row whose outcome carries no play type", () => {
    expect(playTypeText(hl({ outcome: "scoring_play" }))).toBeNull();
  });
});

describe("highlightMomentEntries — ONE list ordered by moment start", () => {
  const postable = hl({ id: "p-late", start: 40, end: 55 });
  const notableEarly = hl({ id: "n-early", start: 5, end: 20 });
  const notableMid = hl({ id: "n-mid", start: 25, end: 40 });
  const notableText = hl({ id: "n-text", start: 60, end: 75, clipUri: "" });

  it("interleaves postable and notable moments by start, ties broken by id", () => {
    const entries = highlightMomentEntries([postable], [notableMid, notableEarly, notableText]);
    expect(entries.map((e) => e.highlight.id)).toEqual(["n-early", "n-mid", "p-late", "n-text"]);
  });

  it("marks which entries are moments of the notable lane", () => {
    const entries = highlightMomentEntries([postable], [notableEarly]);
    expect(entries.map((e) => [e.highlight.id, e.notable])).toEqual([
      ["n-early", true],
      ["p-late", false],
    ]);
  });

  it("keeps a footage-less notable row as a text row INSIDE the list", () => {
    const entries = highlightMomentEntries([postable], [
      hl({ id: "n-nofootage", start: 60, end: 75, clipUri: "" }),
      hl({ id: "n-cliperror", start: 90, end: 105, clipUri: "", clipError: "empty recording" }),
      hl({ id: "n-footage", start: 120, end: 135 }),
    ]);
    const textRows = entries.filter((e) => e.textRow).map((e) => e.highlight.id);
    // Neither footage nor a named clip failure stays a text row; a row that
    // NAMES its clip failure is a card (it renders "Clip unavailable"), and so
    // is a row that carries footage.
    expect(textRows).toEqual(["n-nofootage"]);
    expect(entries.find((e) => e.highlight.id === "n-cliperror")?.textRow).toBe(false);
    expect(entries.find((e) => e.highlight.id === "n-footage")?.textRow).toBe(false);
  });

  it("never filters a row out and never mutates the caller's lists", () => {
    const postableList = [hl({ id: "p1", start: 40 }), hl({ id: "p2", start: 90 })];
    const notableList = [hl({ id: "n1", start: 5, clipUri: "" })];
    const entries = highlightMomentEntries(postableList, notableList);
    expect(entries).toHaveLength(postableList.length + notableList.length);
    expect(postableList.map((h) => h.id)).toEqual(["p1", "p2"]);
    expect(notableList.map((h) => h.id)).toEqual(["n1"]);
  });
});

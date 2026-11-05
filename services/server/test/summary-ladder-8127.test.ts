// ADAAAA-8127 (Defect A): a chapter digest lost its sentence period when the
// lead entry's ` — noise … ` trailer was trimmed.
//
// The lead row is a stored row from `28214400-df08-4f45-a182-367f818bcfa5`
// (chapter 1, build-up, 0 goals) — served digest `Player takes a shot from the
// box`, entry served whole with the trailer. `wholeFirstSentence` drops the
// colour beat and its period is dropped with it, and the digest only restored the
// sentence end when the chapter also carried a goal note, so every ZERO-goal
// chapter served a period-less label.
import { describe, it, expect } from "vitest";
import { buildSummaryLadder } from "../src/summary-ladder";

const LEAD_ROW = {
  seq: 5,
  windowTs: 21,
  verdict: "not_highlight",
  text: "Player takes a shot from the box — noise lifts, then settles.",
  text_raw: "Player in white takes a shot from the penalty area.",
  colour: {
    signal: "audio_noise",
    ratio: 8.71893693385746,
    sustained: 0.3333333333333333,
    peak: 0.204058,
    peakT: 19.3,
    frameTs: 19.666666666666664,
    frameSeq: 98,
  },
};

/** A second, trailer-free row so the chapter has a body after the lead. */
const TAIL_ROW = {
  seq: 6,
  windowTs: 30,
  verdict: "not_highlight",
  text: "A player takes a shot in midfield.",
  text_raw: "A player in white shoots the ball in the center of the pitch.",
};

/** An accepted goal inside the chapter (1-goal arm). */
const GOAL_ROW = {
  id: "hl-8127-goal",
  status: "accepted",
  outcome: "scoring_play",
  eventType: "GOAL",
  score: 85,
  start: 18,
  end: 33,
  localizedTs: 24,
  corroborated: true,
  goalConfirmed: "confirmed_goal",
};

const ladderFor = (highlights: unknown[]) =>
  buildSummaryLadder({
    summaryLog: [LEAD_ROW, TAIL_ROW] as never,
    highlights: highlights as never,
    gameHint: "soccer",
    fastRail: true,
  });

/** The pre-fix rule, frozen: the sentence end is restored only with a goal note. */
const preFixDigest = (leadDigest: string, goalNote: string): string =>
  leadDigest && goalNote && !/[.!?…]$/.test(leadDigest) ? `${leadDigest}.` : leadDigest;

describe("ADAAAA-8127 Defect A — a zero-goal chapter digest is a closed sentence", () => {
  it("closes the digest whose lead carried a ` — noise … ` trailer", () => {
    const ladder = ladderFor([]);
    expect(ladder.chapters.length).toBe(1);
    const chapter = ladder.chapters[0];
    expect(chapter.goalCount).toBe(0);
    expect(chapter.summary).toBe("Player takes a shot from the box.");
  });

  it("still serves the lead ENTRY whole, trailer and all (no regression)", () => {
    const ladder = ladderFor([]);
    expect(ladder.chapters[0].entries[0].text).toBe(LEAD_ROW.text);
    // …and the entry count is untouched by the punctuation fix.
    expect(ladder.chapters[0].entries.length).toBe(2);
  });

  it("carries the digest into the matchSummary bullet, closed", () => {
    const ladder = ladderFor([]);
    const bullet = ladder.matchSummary.text
      .split("\n")
      .find((line) => line.startsWith("- ") && line.includes(": ")) as string;
    expect(bullet.endsWith("Player takes a shot from the box.")).toBe(true);
  });
});

describe("ADAAAA-8127 Defect A — a one-goal chapter closes the digest too", () => {
  it("puts the goal note AFTER a closed digest", () => {
    const ladder = ladderFor([GOAL_ROW]);
    const chapter = ladder.chapters[0];
    expect(chapter.goalCount).toBe(1);
    expect(chapter.summary).toBe("Player takes a shot from the box. 1 accepted goal (1 corroborated).");
  });

  it("does not double the sentence end when the lead already carries one", () => {
    const ladder = buildSummaryLadder({
      summaryLog: [{ ...LEAD_ROW, text: "Player takes a shot from the box.", colour: null }] as never,
      highlights: [GOAL_ROW] as never,
      gameHint: "soccer",
      fastRail: true,
    });
    expect(ladder.chapters[0].summary).toBe("Player takes a shot from the box. 1 accepted goal (1 corroborated).");
  });
});

describe("ADAAAA-8127 Defect A — mechanical sweep: every served digest is closed", () => {
  it("has no non-empty digest that stops without [.!?]", () => {
    for (const highlights of [[], [GOAL_ROW]]) {
      const ladder = ladderFor(highlights);
      for (const chapter of ladder.chapters) {
        const summary = (chapter.summary ?? "").trim();
        if (!summary) continue;
        expect(/[.!?]$/.test(summary), JSON.stringify(summary)).toBe(true);
      }
      for (const line of ladder.matchSummary.text.split("\n")) {
        if (!line.startsWith("- ") || !line.includes(": ")) continue;
        const body = line.slice(line.indexOf(": ") + 2).trim();
        if (!body) continue;
        expect(/[.!?]$/.test(body), JSON.stringify(line)).toBe(true);
      }
    }
  });
});

describe("ADAAAA-8127 Defect A — negative arm: without the fix the period-less digest returns", () => {
  it("reproduces the served string with the frozen pre-fix rule", () => {
    const leadDigest = "Player takes a shot from the box";
    // The served build's rule: no goal note -> no sentence end.
    expect(preFixDigest(leadDigest, "")).toBe(leadDigest);
    expect(/[.!?]$/.test(preFixDigest(leadDigest, ""))).toBe(false);
    // …and the digest the ladder serves now is the closed form.
    expect(ladderFor([]).chapters[0].summary).toBe(`${leadDigest}.`);
  });
});

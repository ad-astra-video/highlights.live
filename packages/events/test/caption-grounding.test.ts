// ADAAAA-7948 (parent ADAAAA-7933 Inc 3): the caption grounding gate.
//
// Every user-visible FAST caption crosses this gate before it is persisted
// (server `summaryLog` seam) or seeded (webapp caption seam). The deployed v1
// captions lied, so these tests pin the three honesty rules and the two
// no-regression rules:
//   - a goal claim without a goal verdict is rewritten or dropped;
//   - a name the window's prompt_text cannot corroborate becomes a role;
//   - bracket/enum internals never reach a caption;
//   - a REAL goal verdict passes through byte-identical;
//   - grounding is idempotent and never lengthens a line.
import { describe, it, expect } from "vitest";
import {
  captionColour,
  findScoreClaims,
  gateGoalClaims,
  gateQuietWindow,
  groundCaption,
  groundSummaryText,
  groundNames,
  humanEventLabel,
  QUIET_MAX_WORDS,
  stripInternalTokens,
  trimQuietLine,
} from "../src/caption-grounding";

/** Word count the way the level grader counts a caption. */
const wordCountOf = (text: string): number => text.split(/\s+/).filter(Boolean).length;

const PROMPT =
  "Match context: RMA 1-1 BAR | scorebug OCR: RMA 1-1 BAR | No. 3 | ASR: (empty)\n" +
  "Window: 3 s at T+69s. Tracked: ball, player.";

describe("goal claims are gated by the window verdict (AC4b)", () => {
  it("rewrites a goal claim when the stored verdict is near_miss", () => {
    const out = groundCaption("Saka scores a goal at the far post.", { verdict: "near_miss", promptText: PROMPT });
    expect(out).not.toMatch(/\b(scores?|scored|goal)\b/i);
    // "Saka" is absent from prompt_text, so the name is grounded to a role too.
    expect(out).toBe("The striker shoots at the far post.");
  });

  it("rewrites 'GOAL' and 'into the net' on a not_highlight window", () => {
    expect(gateGoalClaims("GOAL! Into the net.", { verdict: "not_highlight" })).toBe(
      "Shot! Wide."
    );
  });

  it("rewrites 'net ripples' and 'levels it' without lengthening", () => {
    for (const [input, verdict] of [
      ["The net ripples.", "near_miss"],
      ["That levels it.", "not_highlight"],
    ] as const) {
      const out = gateGoalClaims(input, { verdict });
      expect(out).not.toMatch(/net ripples|levels it/i);
      expect(out.length).toBeLessThanOrEqual(input.length);
    }
  });

  it("keeps the pointed line — a fully goal-shaped caption is rewritten, never blanked", () => {
    const out = groundCaption("Mbappé scores a goal.", { verdict: "big_play" });
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out).not.toMatch(/\bscores?\b|\bgoal\b/i);
  });

  it("passes a REAL goal verdict through BYTE-IDENTICAL", () => {
    const line = "No. 9 scores at the near post — the net ripples.";
    expect(groundCaption(line, { verdict: "scoring_play", promptText: PROMPT, eventType: "GOAL" })).toBe(line);
  });

  it("passes a legacy GOAL row (no stored verdict) through unchanged", () => {
    const line = "A goal is scored from the edge of the box.";
    expect(groundCaption(line, { eventType: "GOAL" })).toBe(line);
  });

  it("does not touch 'goal kick' / 'goal line' (not goal claims)", () => {
    const line = "A goal kick restarts play near the goal line.";
    expect(gateGoalClaims(line, { verdict: "not_highlight" })).toBe(line);
  });
});

describe("names need a source (AC4 honesty half)", () => {
  it("replaces a two-word person name absent from the prompt with a role", () => {
    const out = groundNames("Manuel Ordoñez fires a shot from the box.", PROMPT);
    expect(out).not.toContain("Manuel");
    expect(out).not.toContain("Ordoñez");
    expect(out).toMatch(/the striker|the No\. 9|the midfielder/i);
  });

  it("replaces a club name with a side role", () => {
    const out = groundNames("Real Madrid press high in the midfield.", PROMPT);
    expect(out).not.toContain("Real Madrid");
    expect(out).toContain("The side");
  });

  it("keeps a name the prompt corroborates (accent-insensitive)", () => {
    const prompt = `${PROMPT}\nMatch context: Manuel Ordonez, Real Madrid`;
    expect(groundNames("Manuel Ordoñez shoots for Real Madrid.", prompt)).toBe(
      "Manuel Ordoñez shoots for Real Madrid."
    );
  });

  it("keeps a legible jersey number (evidence in its own right)", () => {
    const line = "The No. 9 shoots from the box.";
    expect(groundNames(line, PROMPT)).toBe(line);
  });

  it("is idempotent: grounding an already-grounded line is a byte-identical no-op", () => {
    const first = groundCaption("Real Madrid scores a goal in the box.", {
      verdict: "near_miss",
      promptText: PROMPT,
    });
    const second = groundCaption(first, { verdict: "near_miss", promptText: PROMPT });
    expect(second).toBe(first);
  });
});

describe("no internal tokens on a user surface (AC7 token half)", () => {
  it("strips a bracket verdict label", () => {
    expect(stripInternalTokens("[near_miss] Audio Burst")).toBe("Audio Burst");
  });

  it("strips a parenthesised verdict, key=value internals and T+ clocks", () => {
    const out = stripInternalTokens("GOAL (not_highlight) outcome=near_miss T+69s — shot saved");
    expect(out).not.toMatch(/near_miss|not_highlight|outcome=|T\+/i);
    expect(out).toContain("shot saved");
  });

  it("maps a SCREAMING_SNAKE enum to words instead of leaking it", () => {
    expect(stripInternalTokens("SPORTING_EVENT at the near post")).toBe("sporting moment at the near post");
  });

  it("grounds the seeded-caption shape that shipped as 'Goal: [near_miss] Audio Burst'", () => {
    const out = groundCaption("[near_miss] Audio Burst", { verdict: "near_miss", promptText: PROMPT });
    expect(out).toBe("Audio Burst");
  });

  it("leaves clean copy byte-identical", () => {
    const line = "The winger drives at the box and wins a corner.";
    expect(stripInternalTokens(line)).toBe(line);
  });
});

describe("scores must be corroborated by the window prompt", () => {
  it("finds score-shaped claims but not M:SS clocks", () => {
    expect(findScoreClaims("It is 1-1 now, at 12:30 on the clock.")).toEqual(["1-1"]);
  });

  it("removes a score the prompt does not carry", () => {
    const out = groundCaption("The scoreboard moves to 5-4 after the shot.", {
      verdict: "not_highlight",
      promptText: PROMPT,
    });
    expect(out).not.toContain("5-4");
  });

  it("keeps a score the prompt carries (scorebug OCR)", () => {
    const out = groundCaption("A shot with the board at 1-1.", {
      verdict: "near_miss",
      promptText: PROMPT,
    });
    expect(out).toContain("1-1");
  });
});

describe("never lengthen, never blank, multi-line entries", () => {
  it("never returns a longer line than it was given", () => {
    const cases: [string, string][] = [
      ["Real Madrid scores a goal from the corner.", "near_miss"],
      ["Manuel Ordoñez levels it with a header.", "not_highlight"],
      ["[goal] The net ripples as the ball crosses the line.", "not_highlight"],
    ];
    for (const [input, verdict] of cases) {
      expect(groundCaption(input, { verdict, promptText: PROMPT }).length).toBeLessThanOrEqual(input.length);
    }
  });

  it("grounds every line of a multi-line summary entry and keeps one line per input line", () => {
    const text = "Real Madrid scores a goal.\n[near_miss] Audio Burst";
    const out = groundSummaryText(text, { verdict: "near_miss", promptText: PROMPT });
    expect(out.split("\n")).toHaveLength(2);
    expect(out).not.toMatch(/Real Madrid|scores|\[near_miss\]/);
  });

  it("returns empty/whitespace input untouched", () => {
    expect(groundCaption("")).toBe("");
    expect(groundCaption("   ")).toBe("   ");
  });
});

describe("human labels", () => {
  it("maps known enums and degrades unknown ones to words", () => {
    expect(humanEventLabel("GOAL")).toBe("goal");
    expect(humanEventLabel("SOME_NEW_ENUM")).toBe("Some New Enum");
    expect(humanEventLabel(undefined)).toBe("highlight");
  });
});

describe("legitimate non-goal phrasings survive (ADAAAA-7948 follow-up)", () => {
  it("keeps 'shot on goal' and 'towards goal' on a non-goal verdict", () => {
    const line = "The winger takes a shot on goal, saved at the near post.";
    expect(gateGoalClaims(line, { verdict: "near_miss" })).toBe(line);
  });

  it("still rewrites a real goal claim in the same sentence", () => {
    const out = gateGoalClaims("The No. 9 has a shot on goal and then scores.", { verdict: "near_miss" });
    expect(out).not.toMatch(/\bscores\b/i);
    expect(out).toContain("shot on goal");
  });
});

describe("internal decision-reason tails and technical terms (ADAAAA-7948, level evidence)", () => {
  const TAIL =
    " | celebration of an already-delivered goal (anchor 120.0s, highlight abc): no independent score-transition evidence in this window";

  it("strips the internal audit tail instead of rewriting its words", () => {
    const out = groundCaption(`The player shoots and the ball enters the net.${TAIL}`, { verdict: "big_play", promptText: PROMPT });
    expect(out).not.toContain("celebration");
    expect(out).not.toContain("score-transition");
    expect(out).not.toContain("shoots-transition");
    expect(out).toBe("The player shoots and the ball stays out.");
  });

  it("leaves a hyphenated technical term intact when it survives (no 'shoots-transition')", () => {
    expect(gateGoalClaims("no independent score-transition evidence", { verdict: "near_miss" })).toBe(
      "no independent score-transition evidence"
    );
  });

  it("rewrites an un-negated net-crossing claim on a non-goal verdict", () => {
    expect(gateGoalClaims("The ball enters the net.", { verdict: "near_miss" })).toBe("The ball stays out.");
  });

  it("keeps the NEGATED form — it states the opposite, not a claim", () => {
    const line = "The ball does not enter the net; the keeper smothers it.";
    expect(gateGoalClaims(line, { verdict: "near_miss" })).toBe(line);
  });

  it("does not treat a quoted ALL-CAPS label as a player name", () => {
    const line = "The ball enters the net and the 'GOL' graphic appears.";
    const out = groundNames(line, PROMPT);
    expect(out).toBe(line);
  });
});

describe("score/evidence cleanup leaves readable copy (ADAAAA-7948, level evidence)", () => {
  it("drops a dangling preposition when an uncorroborated score is removed", () => {
    const out = groundCaption("The ball enters the net and the scoreboard updates to 2-1.; scoreboard score change confirmed", {
      verdict: "scoring_play",
      promptText: PROMPT,
    });
    expect(out).not.toContain("2-1");
    expect(out).not.toContain("score change confirmed");
    expect(out).not.toMatch(/\bupdates to\b/);
    expect(out).toContain("scoreboard updates");
  });

  it("strips a standalone evidence tag from a reason", () => {
    expect(stripInternalTokens("The shot is saved.; scoreboard score change confirmed")).toBe(
      "The shot is saved."
    );
  });
});

// ADAAAA-7956 (residual of ADAAAA-7949, contract v3): a not_highlight window is
// a QUIET window. The measured v2.5 level (job a988e52b) shipped replay /
// celebration windows that still read as fresh goals — "No. 3 drives into the
// box and scores — crowd erupts" on a row whose stored verdict was
// `not_highlight` — and that one class supplied the 6 quiet-row colour clauses
// (AC4/AC5) and the repeated lines (AC3). These pins are the CPU guard the
// prompt could not reach: the claim goes, and the crowd clause goes with it.
describe("rule 1: a quiet window carries no goal claim and no colour clause (ADAAAA-7956)", () => {
  const QUIET_PROMPT =
    "Match context: RMA 1-1 BAR | scorebug OCR: RMA 1-1 BAR | No. 3 | ASR: (empty)";

  it("rewrites the goal claim AND drops the colour clause on a not_highlight window", () => {
    const out = groundCaption("No. 3 drives into the box and scores — crowd erupts", {
      verdict: "not_highlight",
      promptText: QUIET_PROMPT,
    });
    expect(out).not.toMatch(/\bscores?\b|\bscored\b|\bgoal\b/i);
    expect(captionColour(out)).toBe("");
    expect(out).not.toContain("—");
    expect(out).toBe("No. 3 drives into the box and shoots");
  });

  it("drops the colour clause a rewritten claim brought with it on a near_miss window", () => {
    const out = groundCaption("No. 3 scores into the net — the crowd erupts.", {
      verdict: "near_miss",
      promptText: QUIET_PROMPT,
    });
    expect(out).not.toMatch(/\bscores?\b|\bscored\b|\bgoal\b|into the net/i);
    expect(captionColour(out)).toBe("");
  });

  it("keeps the colour clause on a real goal window (the loud channel survives)", () => {
    const line = "No. 9 scores at the near post — the crowd erupts.";
    const out = groundCaption(line, { verdict: "scoring_play", promptText: QUIET_PROMPT });
    expect(out).toBe(line);
    expect(captionColour(out)).toBe("the crowd erupts.");
  });

  it("drops a colour clause on a quiet window even when it never claimed a goal", () => {
    const out = groundCaption("Player in blue carries the ball in midfield — the bench is up.", {
      verdict: "not_highlight",
      promptText: QUIET_PROMPT,
    });
    expect(captionColour(out)).toBe("");
    expect(out).toContain("midfield");
  });

  it("leaves a legacy row with no stored verdict untouched", () => {
    const line = "Player in blue moves ball in center circle.";
    expect(groundCaption(line, { promptText: QUIET_PROMPT })).toBe(line);
  });

  it("is idempotent: a gated quiet line grounds to itself", () => {
    const once = groundCaption("No. 3 drives into the box and scores — crowd erupts", {
      verdict: "not_highlight",
      promptText: QUIET_PROMPT,
    });
    expect(groundCaption(once, { verdict: "not_highlight", promptText: QUIET_PROMPT })).toBe(once);
  });

  it("does not treat a goal kick / shot on goal as a claim (nothing to drop)", () => {
    const line = "Player in blue takes the goal kick in midfield";
    expect(gateQuietWindow(line, { verdict: "not_highlight" })).toBe(line);
  });
});

describe("rule 1b: a quiet line is blunt — 8 words (AC5, measured 72.9% on v2.5)", () => {
  it("trims the 10-word kit shape the level shipped to the 8-word budget", () => {
    const out = trimQuietLine("Player in blue and yellow kit dribbles in penalty area");
    expect(wordCountOf(out)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
    expect(out).toContain("penalty area");
    expect(out).toBe("Player in blue kit dribbles in penalty area");
  });

  it("trims the 9-word 'with ball' shape", () => {
    const out = trimQuietLine("Player in white moves with ball in center circle.");
    expect(wordCountOf(out)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
    expect(out).toBe("Player in white moves in center circle.");
  });

  it("is byte-identical when the line already fits the budget", () => {
    const line = "Player in blue dribbles in center circle.";
    expect(trimQuietLine(line)).toBe(line);
  });

  it("never trims a loud window (near_miss keeps its full sentence)", () => {
    const line = "Player in blue and yellow kit dribbles in penalty area";
    expect(groundCaption(line, { verdict: "near_miss" })).toBe(line);
  });
});

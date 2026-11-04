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
  captionLineKey,
  dedupeEmittedLines,
  findScoreClaims,
  gateGoalClaims,
  gateQuietWindow,
  gateUncorroboratedGoal,
  groundCaption,
  groundSummaryItems,
  groundSummaryText,
  groundNames,
  humanEventLabel,
  isCorroboratedHighlight,
  MAX_LINE_OCCURRENCES,
  QUIET_MAX_WORDS,
  stripInternalTokens,
  trimQuietLine,
  windowCorroborated,
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
    const out = gateQuietWindow(line, { verdict: "not_highlight" });
    // ADAAAA-7957: the quiet bar is a DETERMINISTIC 8-word count, so the 9-word
    // line is blunted even though it carries no claim — the place survives.
    expect(out).not.toMatch(/\bscores?\b|into the net/i);
    expect(wordCountOf(out)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
    expect(out).toContain("midfield");
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

  it("trims the 10-word 'The No. 9 controls the ball' shape measured on level 2", () => {
    // Job c571fad6 shipped this line on a not_highlight window; it was the one
    // quiet row over the budget. "The " before a jersey number is filler and
    // "penalty area" is the contract's own "box".
    const out = trimQuietLine("The No. 9 controls the ball in the penalty area.");
    expect(wordCountOf(out)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
    expect(out).toBe("No. 9 controls the ball in the box.");
  });

  it("trims the 9-word named-carrier shape measured on the integrated level", () => {
    // Job 8c045146 (my guard + the Inc 6 corroboration pass) shipped this on a
    // not_highlight window: one quiet row over the budget. "in center circle"
    // is the contract's own compressed place form.
    const out = trimQuietLine("Lamine Yamal carries the ball in the center circle.");
    expect(wordCountOf(out)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
    expect(out).toBe("Lamine Yamal carries the ball in center circle.");
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

// ---------------------------------------------------------------------------
// ADAAAA-7958 (contract v3 §3.4 + §3.6): the SURFACE pass. The QA verdict on
// the shipped v2 build (ADAAAA-7950, job 9fecca77) measured these exact strings
// on the page: three seeded caption cards asserting the three goals while the
// banner read "3 of 3 accepted goals are not corroborated by frames — counted,
// never asserted as scored", a goal claim used as a Lull chapter title, and 69
// summary rows producing only 29 distinct lines.
// ---------------------------------------------------------------------------
describe("corroboration propagation — a counted-but-uncorroborated goal is never asserted (§3.4)", () => {
  // The measured seeded cards, verbatim (QA defect 2) and the Lull title (3).
  const MEASURED = [
    "No. 10 strikes the ball into the net",
    "No. 6 shoots and scores in the box",
    "Player strikes ball into net",
    "Player in blue jersey shoots into the net — crowd reacts",
  ];
  const GOAL_CLAIM = /\b(?:goal|goals|scores?|scored|scoring|into the net|in the net)\b/i;

  it("rewrites every measured surface string when the window is not corroborated", () => {
    for (const line of MEASURED) {
      // The verdict DOES say scoring_play: the uncorroborated flag is what forbids
      // the claim, because the banner says the goal was never asserted as scored.
      const out = gateGoalClaims(line, { verdict: "scoring_play", corroborated: false });
      expect(GOAL_CLAIM.test(out)).toBe(false);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it("strips the claim through the full gate too (caption option + card title seed)", () => {
    const out = groundCaption("No. 10 strikes the ball into the net", {
      verdict: "scoring_play",
      corroborated: false,
    });
    expect(GOAL_CLAIM.test(out)).toBe(false);
  });

  it("a CORROBORATED goal verdict keeps its line byte-identical", () => {
    const line = "No. 10 strikes the ball into the net";
    expect(gateGoalClaims(line, { verdict: "scoring_play", corroborated: true })).toBe(line);
    expect(groundCaption(line, { verdict: "scoring_play", corroborated: true })).toBe(line);
  });

  it("no corroboration evidence (null/absent) leaves the verdict rule in charge", () => {
    const line = "No. 10 strikes the ball into the net";
    expect(gateGoalClaims(line, { verdict: "scoring_play", corroborated: null })).toBe(line);
    expect(gateGoalClaims(line, { verdict: "scoring_play" })).toBe(line);
  });

  it("gateUncorroboratedGoal is byte-identical for a corroborated window", () => {
    const line = "Fox scores at the far post";
    expect(gateUncorroboratedGoal(line, true)).toBe(line);
    expect(gateUncorroboratedGoal(line, false)).not.toMatch(/scores|goal/i);
  });
});

describe("windowCorroborated — which window instant a highlight corroborates (§3.4)", () => {
  const goals = [
    { start: 113, end: 128, localizedTs: 120.5, corroborated: false },
    { start: 155, end: 170, localizedTs: 162.4, corroborated: true },
  ];

  it("matches a window inside a clip window and at its anchor", () => {
    expect(windowCorroborated(goals, 155.2)).toBe(true);
    expect(windowCorroborated(goals, 162)).toBe(true);
  });

  it("is false for an uncorroborated cover", () => {
    expect(windowCorroborated(goals, 118)).toBe(false);
  });

  it("is false when no accepted highlight covers the window", () => {
    expect(windowCorroborated(goals, 282)).toBe(false);
    expect(windowCorroborated([], 120)).toBe(false);
  });
});

describe("dedupe at emission — distinctness is a property of the emitted set (§3.6 / AC3b)", () => {
  it("keeps a line twice, then drops the third and later occurrence", () => {
    const kept = dedupeEmittedLines([
      "Player in white moves in center circle.",
      "player in white moves in center circle",
      "PLAYER IN WHITE MOVES IN CENTER CIRCLE",
      "Player in white moves in center circle!",
      "Player in blue jersey dribbles in center field",
    ]);
    expect(kept[0]).not.toBeNull();
    expect(kept[1]).not.toBeNull();
    expect(kept[2]).toBeNull();
    expect(kept[3]).toBeNull();
    expect(kept[4]).toBe("Player in blue jersey dribbles in center field");
  });

  it("caps the measured 11x line on a 69-row level at 2 and never exceeds 4", () => {
    const rows: string[] = [];
    for (let i = 0; i < 11; i += 1) rows.push("Player in white moves in center circle.");
    for (let i = 0; i < 58; i += 1) rows.push(`Window ${i}: the blue shirt carries the ball wide.`);
    const kept = dedupeEmittedLines(rows).filter((l): l is string => l !== null);
    const counts = new Map<string, number>();
    for (const l of kept) counts.set(captionLineKey(l), (counts.get(captionLineKey(l)) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(MAX_LINE_OCCURRENCES);
    expect(kept.length).toBe(60);
  });

  it("is a no-op for empty input and deterministic across calls", () => {
    expect(dedupeEmittedLines([])).toEqual([]);
    const lines = ["A", "a", "A", "b"];
    expect(dedupeEmittedLines(lines)).toEqual(dedupeEmittedLines(lines));
  });
});

describe("groundSummaryItems — the flat Video Summary on the fast rail (§3.4 + §3.6)", () => {
  const highlights = [
    { start: 113, end: 128, corroborated: false },
    { start: 155, end: 170, corroborated: true },
  ];
  const items = [
    { seq: 1, windowTs: 120, text: "No. 10 strikes the ball into the net" },
    { seq: 2, windowTs: 162, text: "No. 6 shoots and scores in the box" },
    { seq: 3, windowTs: 200, text: "Player in white moves in center circle." },
    { seq: 4, windowTs: 205, text: "Player in white moves in center circle." },
    { seq: 5, windowTs: 210, text: "Player in white moves in center circle." },
  ];

  it("rewrites an uncorroborated goal item, keeps the corroborated one", () => {
    const out = groundSummaryItems(items, { highlights, fastRail: true });
    expect(out[0].text).not.toMatch(/into the net|goal/i);
    expect(out[1].text).toBe("No. 6 shoots and scores in the box");
  });

  it("keeps an identical item at most twice per job", () => {
    const out = groundSummaryItems(items, { highlights, fastRail: true });
    const repeats = out.filter((i) => i.text === "Player in white moves in center circle.");
    expect(repeats.length).toBe(2);
  });

  it("VOD (fastRail false) is byte-identical and in order", () => {
    expect(groundSummaryItems(items, { highlights, fastRail: false })).toEqual(items);
    expect(groundSummaryItems(items, { highlights })).toEqual(items);
  });
});

// ADAAAA-7957 (parent ADAAAA-7933 Inc 5) — contract v3 §3.1-§3.3 + §3.5.
//
// The shipped v2 build was graded FAIL on the trust bar (ADAAAA-7950, job
// 9fecca77): 3 rows claimed a goal on a `not_highlight` window, 2 rows invented
// a name, 45 of 53 quiet rows fit the 8-word bar (84.9%), and one "colour" beat
// was scorebug OCR. Each block below pins one rule at the failure mode that was
// measured, and the corpora are deliberately wider than the two measured strings
// so the gate is proven to fail CLOSED rather than to recognise a list.

/** Anything a caption may not say on a non-goal window (§3.1 vocabulary). */
const GOAL_PROBE =
  /\b(?:scores?|scored|scoring|go+al|goals?|gol|net|netted|equaliser|winner|taps?\s+(?:it\s+)?in|conver(?:ts|ted)|bur(?:ies|ied)|slots?|finds?\s+the)\b/i;

/** A colour beat is only allowed on a loud window with a crowd/bench channel. */
const COLOUR_OR_DASH = /[—–]|\bcrowd\b|\bbench\b|\bcelebrat|\broar\b|\berupts?\b/i;

const QUIET_PROMPT =
  "Match context: RMA 1-1 BAR | scorebug OCR: RMA 1-1 BAR | No. 3 | ASR: (empty)";

/** The graded sample's quiet offenders, verbatim (ADAAAA-7950). */
const MEASURED_QUIET_OFFENDERS = [
  "No. 10 strikes the ball into the net — players celebrate.",
  "No. 6 shoots and scores in the box — crowd erupts",
  "Player in blue and yellow kit dribbles in center circle.",
  "Player in blue and yellow kit dribbles in penalty area",
  "Player in white jersey moves with ball in center field",
  "Player in white moves in center area.",
  "No. 10 in white jersey enters the penalty area.",
];

describe("§3.1 claim gate fails closed (AC4b, measured strings)", () => {
  it.each([
    ["No. 10 strikes the ball into the net — players celebrate."],
    ["No. 6 shoots and scores in the box — crowd erupts"],
  ])("the measured non-goal claim is rewritten, not enumerated: %s", (line) => {
    const out = groundCaption(line, { verdict: "not_highlight", promptText: QUIET_PROMPT });
    expect(out).not.toMatch(GOAL_PROBE);
    expect(captionColour(out)).toBe("");
    expect(wordCountOf(out)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
  });

  it("keeps the actor and the shot verb instead of doubling it", () => {
    // "shoots and scores" must not become "shoots and shoots".
    expect(gateGoalClaims("No. 6 shoots and scores in the box", { verdict: "not_highlight" })).toBe(
      "No. 6 shoots in the box"
    );
  });

  // The negative corpus the AC names: >= 12 score-verb phrasings, none of them
  // in the old rewrite table, every one on a `not_highlight` window.
  it.each([
    ["No. 7 rifles it into the roof of the net"],
    ["The striker slots it home from six yards"],
    ["No. 4 buries it at the far post"],
    ["No. 5 taps it in at the back post"],
    ["The midfielder converts from the spot"],
    ["She finds the bottom corner with a curler"],
    ["No. 11 levels it with a header"],
    ["The ball crosses the line after a scramble"],
    ["No. 9 puts it away from close range"],
    ["The net bulges as the shot flies in"],
    ["GOOOAL! No. 5 finishes the move"],
    ["No. 8 hits the back of the net"],
    ["The captain smashes it in off the post"],
    ["No. 3 curls one into the top corner"],
    ["He rolls it over the line"],
    ["The ball is in the net before the whistle"],
    ["That is the equaliser"],
    ["No. 2 nets it at the near post"],
  ])("a non-goal window never ships %s", (line) => {
    const out = groundCaption(line, { verdict: "not_highlight", promptText: QUIET_PROMPT });
    expect(out, line).not.toMatch(GOAL_PROBE);
    expect(wordCountOf(out)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
  });

  it.each([
    ["near_miss"],
    ["big_play"],
    ["not_highlight"],
    ["a_verdict_the_pipeline_has_never_stored"],
  ])("fails closed for verdict %s on an unseen phrasing", (verdict) => {
    const out = groundCaption("No. 7 squeezes a finish inside the far stick", {
      verdict,
      promptText: QUIET_PROMPT,
    });
    // Not a claim by construction: whatever shape it lands on, no goal is said.
    expect(out).not.toMatch(/\bscores?|goal|\bnet\b/i);
  });

  it("still allows a claim on a real goal verdict (byte-identical)", () => {
    const line = "No. 9 scores at the near post — the net ripples.";
    expect(groundCaption(line, { verdict: "scoring_play", promptText: QUIET_PROMPT })).toBe(line);
  });

  it.each([
    ["The keeper takes the goal kick near the goal line."],
    ["The winger takes a shot on goal and the keeper saves it."],
    ["The ball does not enter the net; the keeper smothers it."],
    ["The scoreboard reads 1-1 at the interval."],
    ["The 'GOL' graphic appears on the replay overlay."],
  ])("does not treat a benign goal/net mention as a claim: %s", (line) => {
    expect(gateGoalClaims(line, { verdict: "near_miss" })).toBe(line);
  });
});

describe("§3.2 name gate is provenance, not shape (AC4 name half)", () => {
  // The two measured invented names, verbatim.
  it("replaces the measured g37 name with a role", () => {
    const out = groundCaption("Manuel Ordoñez moves in the center circle.", {
      verdict: "not_highlight",
      promptText: QUIET_PROMPT,
    });
    expect(out).not.toMatch(/Manuel|Ordoñez/);
    expect(out).toMatch(/the No\. \d|the midfielder|the striker|the side/i);
  });

  it("replaces the measured g56 name AND its goal claim", () => {
    const out = groundCaption("David Saez scores — crowd erupts", {
      verdict: "not_highlight",
      promptText: QUIET_PROMPT,
    });
    expect(out).not.toMatch(/David|Saez/i);
    expect(out).not.toMatch(GOAL_PROBE);
    expect(captionColour(out)).toBe("");
  });

  // >= 6 name SHAPES, none of which an allowlist could recognise.
  it.each([
    ["DAVID SAEZ drives at the box"],
    ["MBAPPÉ shoots from the edge of the area"],
    ["Real Madrid CF press high"],
    ["N'Golo Kanté wins the ball back"],
    ["van der Berg clears the danger"],
    ["Saka receives in midfield"],
    ["Julián Álvarez-Moran holds the ball up"],
  ])("an unsourced name shape becomes a role: %s", (line) => {
    const out = groundNames(line, QUIET_PROMPT);
    expect(out, line).not.toMatch(/SAEZ|MBAPPÉ|Madrid|Kanté|Berg|Saka|Álvarez/i);
  });

  it("fails closed when the seam has NO prompt (the v2 leak)", () => {
    // The live seam passed `null` when the decide analysis was absent, so the
    // gate never ran. An EMPTY prompt is "no evidence" and must still replace.
    expect(groundNames("Manuel Ordoñez moves in the center circle.", "")).not.toMatch(/Manuel|Ordoñez/);
    expect(groundNames("David Saez scores", "")).not.toMatch(/David|Saez/i);
    // ...and an absent prompt is the same fail-closed default.
    expect(groundNames("David Saez scores")).not.toMatch(/David|Saez/i);
  });

  it("keeps a name the window's prompt corroborates (accent-insensitive)", () => {
    const prompt = `${QUIET_PROMPT}\nMatch context: Manuel Ordonez, Real Madrid`;
    expect(groundNames("Manuel Ordoñez shoots for Real Madrid.", prompt)).toBe(
      "Manuel Ordoñez shoots for Real Madrid."
    );
  });

  it("keeps a legible jersey number and the codes the pipeline emits", () => {
    for (const line of ["The No. 9 shoots from the box.", "The VAR check is quick."]) {
      expect(groundNames(line, QUIET_PROMPT)).toBe(line);
    }
  });

  it("treats `null` as upstream-certified text only (server seam contract)", () => {
    // `null` is the documented "already certified with this window's prompt"
    // value the webapp passes for summary-log text; `""` is no evidence.
    expect(groundNames("Manuel Ordoñez moves in the center circle.", null)).toBe(
      "Manuel Ordoñez moves in the center circle."
    );
  });
});

describe("§3.3 quiet gate is deterministic at emission (AC5)", () => {
  it.each(MEASURED_QUIET_OFFENDERS)("blunts a measured quiet offender: %s", (line) => {
    const out = groundCaption(line, { verdict: "not_highlight", promptText: QUIET_PROMPT });
    expect(wordCountOf(out)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
    expect(out).not.toMatch(COLOUR_OR_DASH);
    expect(out).not.toMatch(GOAL_PROBE);
  });

  it("treats an unrecognised verdict as quiet (fail closed)", () => {
    const out = groundCaption("Player in white jersey moves with ball in center field", {
      verdict: "not_highlight_v2",
      promptText: QUIET_PROMPT,
    });
    expect(wordCountOf(out)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
  });

  it("does not length-gate a legacy row with no stored verdict", () => {
    const line = "Player in white jersey moves with ball in center field";
    expect(gateQuietWindow(line, { promptText: QUIET_PROMPT })).toBe(line);
  });

  it("leaves a loud window's line and colour beat alone", () => {
    const line = "No. 9 scores at the near post — the crowd erupts.";
    expect(gateQuietWindow(line, { verdict: "near_miss" })).toBe(line);
  });

  it("counts words AFTER the claim and name rewrites, so a rewrite cannot re-break the bar", () => {
    // 11 words -> claim rewritten -> name replaced -> still <= 8.
    const out = groundCaption("Manuel Ordoñez strikes the ball into the net — players celebrate.", {
      verdict: "not_highlight",
      promptText: QUIET_PROMPT,
    });
    expect(out).not.toMatch(/Manuel|net|scores?|goal/i);
    expect(wordCountOf(out)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
  });
});

describe("§3.5 OCR is not colour and not corroboration", () => {
  it("drops an OCR clause used as a colour beat (measured line 19)", () => {
    const out = groundCaption("Player strikes ball into net — GOL graphic appears", {
      verdict: "not_highlight",
      promptText: QUIET_PROMPT,
    });
    expect(out).not.toMatch(/GOL|graphic|net/i);
    expect(captionColour(out)).toBe("");
  });

  it("drops an OCR clause on a goal window too (OCR is never a colour channel)", () => {
    const out = groundCaption("No. 9 scores — the scorebug shows 2-1", {
      verdict: "scoring_play",
      promptText: "scorebug OCR: 2-1",
    });
    expect(captionColour(out)).toBe("");
    expect(out).toContain("No. 9 scores");
  });

  it("does not let a GOL OCR read authorize a claim", () => {
    const out = groundCaption("No. 9 scores at the far post", {
      verdict: "not_highlight",
      promptText: "scorebug OCR: GOL 2-1 | ASR: GOAL",
    });
    expect(out).not.toMatch(GOAL_PROBE);
  });
});

describe("one implementation, every surface (§3)", () => {
  const ctx = { verdict: "not_highlight", promptText: QUIET_PROMPT } as const;
  it("a summary-log item and a seeded caption cross the same gate", () => {
    const line = "No. 10 strikes the ball into the net — players celebrate.";
    expect(groundSummaryText(line, ctx)).toBe(groundCaption(line, ctx));
    expect(groundCaption(line, ctx)).not.toMatch(GOAL_PROBE);
  });

  it("is idempotent across the whole contract", () => {
    for (const line of [
      ...MEASURED_QUIET_OFFENDERS,
      "Manuel Ordoñez moves in the center circle.",
      "David Saez scores — crowd erupts",
    ]) {
      const once = groundCaption(line, ctx);
      expect(groundCaption(once, ctx), line).toBe(once);
    }
  });

  it("never lengthens a line", () => {
    for (const line of [...MEASURED_QUIET_OFFENDERS, "David Saez scores — crowd erupts"]) {
      expect(groundCaption(line, ctx).length).toBeLessThanOrEqual(line.length);
    }
  });
});

describe("corroboration uses the banner's own rule (§3.4)", () => {
  // `goalTimelineFrom` counts a goal as corroborated when `corroborated === true`
  // OR the Stage-2 confirm said `confirmed_goal`. The propagation must agree with
  // that exactly, or the banner and the strings disagree on the same page.
  const win = (over: Record<string, unknown>) => ({ start: 100, end: 115, ...over });

  it("a confirmed_goal corroborates even when the flag is absent", () => {
    expect(isCorroboratedHighlight(win({ goalConfirmed: "confirmed_goal" }))).toBe(true);
    expect(windowCorroborated([win({ goalConfirmed: "confirmed_goal" })], 108)).toBe(true);
  });

  it("absent evidence is NOT corroborated (the banner counts it as uncorroborated)", () => {
    expect(isCorroboratedHighlight(win({}))).toBe(false);
    expect(windowCorroborated([win({})], 108)).toBe(false);
    expect(windowCorroborated([win({ goalConfirmed: "near_miss" })], 108)).toBe(false);
  });

  it("fails closed on a net-crossing shape the claim lexicon has not learned", () => {
    // The measured chapter lead: "No. 8 headers ball into net — crowd erupts".
    const out = gateUncorroboratedGoal("No. 8 headers ball into net — crowd erupts", false);
    expect(out).not.toMatch(/\b(?:in|into)\s+(?:the\s+)?net\b/i);
    expect(out).toContain("headers ball wide");
    expect(out.length).toBeLessThanOrEqual("No. 8 headers ball into net — crowd erupts".length);
  });

  it("an explicit non-goal read keeps asserting no goal", () => {
    // The claim lexicon's own cosmetics on negatives belong to the Inc 5 gate;
    // the corroboration rule only has to guarantee no goal is ASSERTED, so the
    // net-crossing form is what must be gone.
    const out = gateUncorroboratedGoal("The ball is in the middle of the field and no goal is scored.", false);
    expect(out).not.toMatch(/\b(?:in|into)\s+(?:the\s+)?net\b/i);
    expect(out).toMatch(/\bno\b/i);
  });
});

// ADAAAA-8668: the `summary` lane's COPY CONTRACT. These are the unit bars the
// ticket names: the depth clamp (word/char ceilings), the gate composition, the
// caption-overlap bar and the "no name required for depth" case (ADAAAA-8456).
import { describe, expect, it } from "vitest";
import {
  SUMMARY_CALL_TIMEOUT_MS,
  SUMMARY_FEE_RATIO,
  SUMMARY_GENERATION_P95_BUDGET_MS,
  SUMMARY_LIVE_BAND,
  SUMMARY_MAX_CALLS_PER_ROW,
  SUMMARY_MAX_CAPTION_OVERLAP,
  SUMMARY_VOD_BAND,
  buildSummaryPrompt,
  captionTokenOverlap,
  clampSummaryDepth,
  gateSummaryDetail,
  hasAttestedEntity,
  newSummaryFacts,
  normalizeSummaryTokens,
  resolveSummaryFee,
  summaryFacts,
  summarySentenceCount,
  summaryViolations,
  summaryWordCount,
  type SummaryEvidence,
} from "../src/highlight-summary.js";

const live = (extra: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "live",
  verdict: "scoring_play",
  eventType: "goal",
  reason: "Scoreboard changes to 2-2 and the ball enters the net.",
  caption: "Ball enters the net at the near post.",
  postTitle: "GOAL · 2:38",
  windowTs: 158,
  windowDurationS: 12,
  scoreTransition: { from: "1-2", to: "2-2" },
  matchContext: { teams: [{ name: "Northbridge" }, { name: "Riverside" }] },
  transcript: "the equaliser, and it is level again",
  ...extra,
});

const BLOCK = (n: number): string =>
  Array.from({ length: n }, () => "word").join(" ");

describe("depth band constants", () => {
  it("carries the spec's live and VOD bars", () => {
    expect(SUMMARY_LIVE_BAND).toMatchObject({
      minSentences: 2,
      maxSentences: 3,
      targetMinWords: 25,
      targetMaxWords: 55,
      floorWords: 18,
      hardMaxWords: 70,
      hardMaxChars: 420,
    });
    expect(SUMMARY_VOD_BAND).toMatchObject({
      minSentences: 3,
      maxSentences: 5,
      targetMinWords: 40,
      targetMaxWords: 90,
      hardMaxWords: 120,
      hardMaxChars: 700,
    });
    expect(SUMMARY_MAX_CAPTION_OVERLAP).toBe(0.5);
    // One retry, so at most two billed calls per row; the p95 budget is the
    // post-promotion bound and one call fits inside it twice.
    expect(SUMMARY_MAX_CALLS_PER_ROW).toBe(2);
    expect(SUMMARY_CALL_TIMEOUT_MS * 2).toBeLessThanOrEqual(SUMMARY_GENERATION_P95_BUDGET_MS);
  });
});

describe("summaryWordCount / summarySentenceCount", () => {
  it("counts words as a reader does, ignoring a lone separator", () => {
    expect(summaryWordCount("two goals — and a save")).toBe(5);
    expect(summaryWordCount("")).toBe(0);
  });

  it("counts sentences without splitting on an initial", () => {
    expect(summarySentenceCount("One. Two. Three.")).toBe(3);
    expect(summarySentenceCount("Only one sentence without a period")).toBe(1);
    expect(summarySentenceCount("")).toBe(0);
  });
});

describe("clampSummaryDepth (extractive only)", () => {
  it("returns an in-band reply byte-identical", () => {
    const text =
      "The equaliser levels it at 2-2 in the second half. " +
      "A low drive from outside the box beats the keeper at the near post.";
    expect(clampSummaryDepth(text, "live")).toBe(text);
  });

  it("drops trailing sentences above the live 3-sentence ceiling", () => {
    const text = "One play here. Two plays there. Three plays again. Four plays last.";
    expect(clampSummaryDepth(text, "live")).toBe("One play here. Two plays there. Three plays again.");
  });

  it("trims to the live 70-word hard ceiling and re-closes", () => {
    const text = `${BLOCK(40)}. ${BLOCK(40)}.`;
    const out = clampSummaryDepth(text, "live");
    expect(summaryWordCount(out)).toBeLessThanOrEqual(70);
    expect(out.endsWith(".")).toBe(true);
  });

  it("trims to the VOD 120-word ceiling, not the live one", () => {
    const sentences = Array.from({ length: 6 }, () => `${BLOCK(30)}.`).join(" ");
    const out = clampSummaryDepth(sentences, "vod");
    expect(summaryWordCount(out)).toBeLessThanOrEqual(120);
    expect(clampSummaryDepth(sentences, "live")).not.toBe(out);
  });

  it("honours the char ceiling when one long run survives the word cap", () => {
    const text = `${"a".repeat(300)} ${"b".repeat(300)}.`;
    expect(clampSummaryDepth(text, "live").length).toBeLessThanOrEqual(420);
  });
});

describe("facts and entities", () => {
  it("extracts the score, clock, venue and action facts", () => {
    const kinds = summaryFacts("A 2-1 lead in the second half at the Riverside arena, finished by a header.").map((f) => f.kind);
    expect(kinds).toContain("score");
    expect(kinds).toContain("clock");
    expect(kinds).toContain("venue");
    expect(kinds).toContain("action");
  });

  it("counts a fact as NEW only when the title does not carry it", () => {
    const summary = "The equaliser makes it 2-2 in the second half.";
    expect(newSummaryFacts(summary, "GOAL · 2:38").map((f) => f.kind)).toEqual(
      expect.arrayContaining(["score", "clock"])
    );
    // A title that already carries the score leaves the clock as the new fact,
    // and a title carrying both leaves none.
    expect(newSummaryFacts(summary, "Level at 2-2").some((f) => f.kind === "score")).toBe(false);
    expect(newSummaryFacts("The equaliser makes it 2-2 in the second half.", "2-2 in the second half")).toHaveLength(0);
  });

  it("treats a score/clock fact as an attested entity (no name needed)", () => {
    const evidence = live({ matchContext: null, transcript: null });
    expect(hasAttestedEntity("It levels at 2-2 in the second half.", "no names here")).toBe(true);
    expect(hasAttestedEntity("A neat passage of play.", "no names here")).toBe(false);
  });

  it("finds the attested names in the row's own evidence", () => {
    expect(hasAttestedEntity("Northbridge pull one back.", "Teams: Northbridge vs Riverside")).toBe(true);
  });
});

describe("caption overlap bar", () => {
  it("measures the share of the caption the summary re-states", () => {
    const caption = "Ball enters the net at the near post.";
    expect(captionTokenOverlap(caption, caption)).toBe(1);
    expect(captionTokenOverlap("A different sentence entirely about the clock", caption)).toBeLessThan(0.5);
  });

  it("refuses a summary that restates the announcer line at >= 0.5", () => {
    const ev = live({
      caption: "Ball enters the net at the near post.",
      postTitle: "GOAL · 2:38",
      reason: "",
      transcript: "",
      scoreTransition: null,
    });
    const restated = "Ball enters the net at the near post. It is 2-2 in the second half now.";
    expect(summaryViolations(restated, ev)).toContain("restates-caption");
  });

  it("normalizes tokens (case, diacritics, punctuation, stopwords)", () => {
    expect(normalizeSummaryTokens("The BALL, enters — the NÉT!")).toEqual(["ball", "enters", "net"]);
  });
});

describe("gateSummaryDetail", () => {
  it("accepts an in-band, grounded, non-restating summary", () => {
    const decision = gateSummaryDetail(
      "The equaliser levels it at 2-2 in the second half. A low drive from the edge of the box beats the keeper at the near post.",
      live()
    );
    expect(decision.summary).toContain("2-2");
    expect(decision.gate).toBe("accepted");
    expect(decision.violations).toEqual([]);
    expect(decision.words).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.floorWords);
  });

  it("clamps an over-long reply and reports `trimmed`", () => {
    const long =
      "The equaliser levels it at 2-2 in the second half. A low drive from the edge of the box beats the keeper. " +
      "The crowd is up and the bench is on its feet. Northbridge restart from the centre.";
    const decision = gateSummaryDetail(long, live());
    expect(decision.gate).toBe("trimmed");
    expect(decision.sentences).toBeLessThanOrEqual(SUMMARY_LIVE_BAND.maxSentences);
  });

  it("refuses a reply below the floor", () => {
    expect(gateSummaryDetail("It is 2-2.", live()).gate).toMatch(/^refused:.*too-few-words/);
  });

  it("refuses a goal claim when the verdict does not attest one", () => {
    const ev = live({ verdict: "near_miss", eventType: "shot", reason: "The shot goes wide of the far post." });
    const decision = gateSummaryDetail(
      "The equaliser goes in at the near post to level it at 2-2 in the second half. The keeper is beaten low to his right.",
      ev
    );
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("goal-claim");
  });

  it("refuses an unattested name", () => {
    const decision = gateSummaryDetail(
      "Diego Maradona levels it at 2-2 in the second half. The strike beats the keeper at the near post.",
      live({ transcript: "the equaliser", matchContext: { teams: ["Northbridge", "Riverside"] } })
    );
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("ungrounded-name");
  });

  it("refuses speculative verbs and internal tokens", () => {
    expect(
      gateSummaryDetail(
        "It looked like a goal as the ball crossed the line at 2-2 in the second half. The keeper had no chance at all.",
        live()
      ).violations
    ).toContain("speculative-verb");
    const withToken = gateSummaryDetail(
      "The equaliser is 2-2 in the second half after a scoring_play at the far post. " +
        "The visitors restart from the centre circle.",
      live()
    );
    expect(withToken.summary).toBeNull();
    expect(withToken.violations).toContain("internal-token");
    // A bracketed/internal marker is STRIPPED (a clean, like the title lane), so
    // nothing internal is ever served.
    const stripped = gateSummaryDetail(
      "The equaliser is 2-2 in the second half [GOAL] and the drive beats the keeper. " +
        "The visitors restart from the centre circle.",
      live()
    );
    expect(stripped.summary ?? "").not.toContain("[GOAL]");
  });

  it("returns `absent` for an empty reply and never invents a placeholder", () => {
    const decision = gateSummaryDetail("   ", live());
    expect(decision.summary).toBeNull();
    expect(decision.gate).toBe("absent");
  });

  it("accepts when NO name is attested, on score/clock/action facts alone (ADAAAA-8456)", () => {
    const ev = live({
      matchContext: null,
      transcript: "",
      reason: "",
      scoreTransition: null,
      caption: "Shot saved at the near post.",
    });
    const decision = gateSummaryDetail(
      "A low drive from the edge of the box beats the keeper to level it at 2-2. The second half restarts with the visitors pressing high.",
      ev
    );
    expect(decision.summary).not.toBeNull();
    expect(decision.violations).toEqual([]);
  });

  it("enforces the VOD band (3-5 sentences / 120-word, 700-char hard ceiling)", () => {
    const vod: SummaryEvidence = { ...live({ caption: "Shot saved." }), rail: "vod" };
    const twoSentences =
      "The equaliser levels it at 2-2 in the second half. A low drive from the edge of the box beats the keeper at the near post.";
    // Two sentences pass the LIVE band (2-3) and fail the VOD band (3-5).
    expect(gateSummaryDetail(twoSentences, live()).summary).not.toBeNull();
    expect(gateSummaryDetail(twoSentences, vod).violations).toContain("too-few-sentences");
    const three =
      "The equaliser levels it at 2-2 in the second half. A low drive from the edge of the box beats the keeper at the near post. " +
      "The visitors restart from the centre with the clock running down.";
    expect(gateSummaryDetail(three, vod).summary).not.toBeNull();
  });
});

describe("fee", () => {
  it("resolves to the 1.5x ceiling and never breaches it", () => {
    expect(resolveSummaryFee(0.01)).toBeCloseTo(0.015, 6);
    expect(SUMMARY_FEE_RATIO).toBe(1.5);
    // An operator override above the ceiling is clamped, never billed.
    expect(resolveSummaryFee(0.01, 0.09)).toBeCloseTo(0.015, 6);
    expect(resolveSummaryFee(0.01, 0.004)).toBeCloseTo(0.004, 6);
  });
});

describe("prompt contract (snapshot)", () => {
  it("renders the summary prompt for a live row", () => {
    const prompt = buildSummaryPrompt({
      ...live(),
      postTitle: "GOAL · 2:38",
      adjacentScoreCue: "Northbridge had scored the opener on 12:04.",
    });
    expect(prompt).toMatchSnapshot();
  });

  it("renders the VOD band and omits absent evidence without inventing any", () => {
    const prompt = buildSummaryPrompt({
      rail: "vod",
      verdict: "scoring_play",
      eventType: "goal",
      postTitle: null,
      caption: null,
      reason: null,
      transcript: null,
      matchContext: null,
      scoreTransition: null,
      adjacentScoreCue: null,
    });
    expect(prompt).toContain("Rail: vod. Write 3-5 sentences, 40-90 words.");
    expect(prompt).toContain("Match context:\n(none)");
    expect(prompt).toContain("ASR transcript: (none)");
    expect(prompt).toMatchSnapshot();
  });
});

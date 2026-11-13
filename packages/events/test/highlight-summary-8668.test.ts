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
  SUMMARY_MAX_SHARED_RUN_TOKENS,
  SUMMARY_MIN_NOVEL_TOKENS,
  SUMMARY_RAW_MAX_CHARS,
  SUMMARY_VOD_BAND,
  buildSummaryPrompt,
  captionRestatesSummary,
  captionTokenOverlap,
  clampSummaryDepth,
  clockFrameClaims,
  gateSummaryDetail,
  hasAttestedEntity,
  internalLabelPhrases,
  newSummaryFacts,
  normalizeSummaryTokens,
  resolveSummaryFee,
  summaryFacts,
  summarySentenceCount,
  summaryViolations,
  summaryRestatement,
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
      // ADAAAA-8803: the VOD TARGET band moved above the 40-word serve floor
      // (was 40-90) so a compliant draft is not a one-word boundary case.
      targetMinWords: 45,
      targetMaxWords: 55,
      floorWords: 40,
      hardMaxWords: 120,
      hardMaxChars: 700,
    });
    // Spec rev 2 (ADAAAA-8687): restatement is R1-R3, not a coverage bar.
    expect(SUMMARY_MIN_NOVEL_TOKENS).toBe(8);
    expect(SUMMARY_MAX_SHARED_RUN_TOKENS).toBe(5);
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

  it("refuses a summary that restates the announcer line (rev 2: R1 novel-detail)", () => {
    const ev = live({
      caption: "Ball enters the net at the near post.",
      postTitle: "GOAL · 2:38",
      reason: "",
      transcript: "",
      scoreTransition: null,
    });
    const restated = "Ball enters the net at the near post. It is 2-2 in the second half now.";
    expect(summaryViolations(restated, ev)).toContain("restates-caption");
    // The rev-1 coverage figure is still high here; it is an observation now.
    expect(captionTokenOverlap(restated, ev.caption)).toBeGreaterThan(0.5);
  });

  it("normalizes tokens (case, diacritics, punctuation, stopwords)", () => {
    expect(normalizeSummaryTokens("The BALL, enters — the NÉT!")).toEqual(["ball", "enters", "net"]);
  });
});

describe("gateSummaryDetail", () => {
  it("accepts an in-band, grounded, non-restating summary", () => {
    // ADAAAA-8914 (AC14.1): the second sentence used to be "A low drive from the
    // edge of the box finds the far corner." — a ball description with no
    // attested fact in it, which the clause repair now deletes. A served body
    // carries a fact in every sentence, so the fixture does too.
    const decision = gateSummaryDetail(
      "The equaliser levels it at 2-2 in the second half. Northbridge keep possession as the clock runs to 2:38.",
      live()
    );
    expect(decision.summary).toContain("2-2");
    expect(decision.gate).toBe("accepted");
    expect(decision.violations).toEqual([]);
    expect(decision.words).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.floorWords);
  });

  it("clamps an over-long reply and reports `trimmed`", () => {
    const long =
      "The equaliser levels it at 2-2 in the second half. Northbridge keep possession as the clock runs to 2:38. " +
      "Riverside presses high to force a turnover. The scoreboard reads 2-2 at 2:41 into the clip.";
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

  it("accepts when NO name is attested, on clock + competition facts alone (ADAAAA-8456 / AC9)", () => {
    // Rev 3 (AC9) keeps the no-name rule but drops the CLOCK-ONLY body: the
    // second fact must come from another channel the row attests. No name here —
    // the clock plus the competition carries it.
    const ev = live({
      matchContext: { competition: "Champions League" },
      transcript: "",
      reason: "",
      scoreTransition: null,
      caption: "Shot saved at the near post.",
    });
    const decision = gateSummaryDetail(
      "The move develops at 2:40 in the second half of the Champions League tie. The clock still reads 2:40 through the next few passes.",
      ev
    );
    expect(decision.summary).not.toBeNull();
    expect(decision.violations).toEqual([]);
  });

  it("enforces the VOD band (3-5 sentences / 120-word, 700-char hard ceiling)", () => {
    const vod: SummaryEvidence = { ...live({ caption: "Shot saved." }), rail: "vod" };
    // ADAAAA-8914 (AC14.1): every sentence carries a fact, because the clause
    // repair deletes one that does not (the old fixtures' "A low drive … finds
    // the far corner" / "Both sides settle into shape" are exactly that filler).
    const twoSentences =
      "The equaliser levels it at 2-2 in the second half. Northbridge keep possession at 2:38 into the clip.";
    // Two sentences pass the LIVE band (2-3) and fail the VOD band (3-5).
    expect(gateSummaryDetail(twoSentences, live()).summary).not.toBeNull();
    expect(gateSummaryDetail(twoSentences, vod).violations).toContain("too-few-sentences");
    const three =
      "The equaliser levels it at 2-2 in the second half. Northbridge keep possession at 2:38 into the clip and work the ball toward the wing. " +
      "Riverside presses high to force a turnover near the touchline. The scoreboard reads 2-2 as Northbridge recycle the ball through midfield.";
    expect(gateSummaryDetail(three, vod).summary).not.toBeNull();
  });
});

describe("summaryRestatement — spec rev 2 R1/R2/R3 (ADAAAA-8687)", () => {
  it("R1: counts the novel content tokens a body adds", () => {
    const caption = "Ball shoots in midfield";
    const body =
      "The crowd erupts as the ball is worked through midfield in the opening exchanges. " +
      "A burst of noise and motion around 0:12 marks the move that briefly lifts the ground.";
    const r = summaryRestatement(body, caption);
    expect(r.novelTokens).toBeGreaterThanOrEqual(SUMMARY_MIN_NOVEL_TOKENS);
    expect(r.failed).toEqual([]);
    expect(r.restates).toBe(false);
    // R4 is still measured, and is still free to be high — it is no longer a gate.
    expect(r.overlap).toBeGreaterThan(0.5);
  });

  it("R2: refuses a body that echoes a >5-word run of the caption verbatim", () => {
    const caption = "Ball enters the net at the near post after the low drive";
    const echo =
      "Ball enters the net at the near post after the low drive from the left. " +
      "The crowd is up and the bench is on its feet as the visitors press again.";
    const r = summaryRestatement(echo, caption);
    expect(r.longestSharedRun).toBeGreaterThan(SUMMARY_MAX_SHARED_RUN_TOKENS);
    expect(r.failed).toContain("verbatim-echo");
    expect(r.restates).toBe(true);
  });

  it("R3: a caption superset that adds only filler is still a restatement", () => {
    const caption = "Ball shoots in midfield";
    const filler = "The ball, in midfield, shoots in midfield, ball, midfield.";
    const r = summaryRestatement(filler, caption);
    expect(r.captionSubset).toBe(true);
    expect(r.novelTokens).toBeLessThan(SUMMARY_MIN_NOVEL_TOKENS);
    expect(r.failed).toContain("subset-echo");
    expect(r.restates).toBe(true);
  });

  it("R3 does not refuse a superset that clears R1's novel-detail floor", () => {
    // The whole point of rev 2: an elaboration that still names ball/midfield but
    // carries >= 8 new content tokens is detail, not a restatement.
    const caption = "Ball shoots in midfield";
    const body =
      "The crowd erupts as the ball is worked through midfield in the opening exchanges. " +
      "A burst of noise and motion around 0:12 marks the move that briefly lifts the ground.";
    const r = summaryRestatement(body, caption);
    expect(r.captionSubset).toBe(false); // "shoots" is not repeated here
    expect(r.restates).toBe(false);
  });

  it("never fails closed on a missing caption or an empty body", () => {
    expect(captionRestatesSummary("A faithful line with facts in it.", null)).toBe(false);
    expect(captionRestatesSummary("", "Ball shoots in midfield")).toBe(false);
    expect(summaryRestatement("A line.", "").failed).toEqual([]);
  });
});

// ADAAAA-8687: QA-B (ADAAAA-8683) measured AC1-live coverage at 0/3 on the served
// build `9cc66b4` — every promoted row was refused `restates-caption`, because the
// bar was the share of the CAPTION's tokens the body reuses and the shipped live
// captions are 2-5 content tokens. These are that leg's own three captions, with
// the row's own verdict/headline/score transition.
describe("ADAAAA-8687: the shipped one-line caption shapes", () => {
  const shipped: { caption: string; body: string; evidence: SummaryEvidence }[] = [
    {
      // job 357a927d row fa7ac224 — BIG_PLAY delivered as a celebration
      caption: "Ball shoots in midfield",
      evidence: live({
        verdict: "big_play",
        eventType: "BIG_PLAY",
        caption: "Ball shoots in midfield",
        postTitle: null,
        reason: "Ball shoots in midfield",
        windowTs: 12,
        scoreTransition: null,
        matchContext: null,
        transcript: "",
      }),
      body:
        "The crowd erupts as the ball shoots through midfield in the opening exchanges. " +
        "A burst of noise near 0:12 marks the move that breaks forward again.",
    },
    {
      // row f647c078 — provisional celebration, caption is the absence line
      caption: "No measured scoreboard change yet.",
      evidence: live({
        verdict: "big_play",
        eventType: "BIG_PLAY",
        caption: "No measured scoreboard change yet.",
        postTitle: null,
        reason: "No measured scoreboard change yet.",
        windowTs: 102,
        scoreTransition: null,
        matchContext: null,
        transcript: "",
      }),
      body:
        "The audio feed carries a loud call near 1:42 and the crowd answers it at once. " +
        "No scoreboard read inside the window backs the moment up, so the replay stays a celebration.",
    },
    {
      // row 1b43c21c — the confirmed GOAL, headline `Midfielder scores`
      caption: "Scoreboard changes to 2-2.",
      evidence: live({
        verdict: "scoring_play",
        eventType: "GOAL",
        caption: "Scoreboard changes to 2-2.",
        postTitle: "Midfielder scores",
        reason: "Scoreboard changes to 2-2.",
        windowTs: 160,
        scoreTransition: { from: "2-1", to: "2-2" },
        matchContext: null,
        transcript: "",
      }),
      body:
        "The scoreboard flips from 2-1 to 2-2 at 2:40 off a strike from the edge of the box. " +
        // ADAAAA-8914: the old second sentence ("The near post is beaten low and
        // the crowd behind the net is up before the restart.") was an atmosphere
        // clause — the exact copy AC14 refuses. This row attests no actor (no
        // matchContext, no transcript), so the fact that keeps its depth is the
        // scoreboard line itself.
        "The scoreboard holds at 2-2 as the clip runs on.",
    },
  ];

  // AC9 (rev 3): row f647c078's own evidence attests ONLY the clock (no name, no
  // score change, no competition), so a body for that row can never carry two
  // attested facts. Its faithful rev-2 body is now a `too-few-facts` refusal —
  // stated here rather than dropped from the sample, because that row IS the
  // clock-only shape AC9 exists to refuse.
  //
  // AC9 (rev 4, ADAAAA-8735): row fa7ac224 is the same class. Its evidence carries
  // no matchContext and no transcript, so `action` is no longer available off the
  // sentence-initial capital of `Ball` — the row attests the clock only, and its
  // (faithful, non-restating) body is refused for fact density, not for novelty.
  const NO_FACT_ROWS = [0, 1];

  it("accepts a faithful deeper body for every one of them", () => {
    shipped.forEach((row, i) => {
      if (NO_FACT_ROWS.includes(i)) return;
      const decision = gateSummaryDetail(row.body, row.evidence);
      expect({ caption: row.caption, violations: decision.violations }).toEqual({ caption: row.caption, violations: [] });
      expect(decision.summary).toBe(row.body);
      expect(decision.gate).toBe("accepted");
      expect(decision.words).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.targetMinWords);
      expect(decision.words).toBeLessThanOrEqual(SUMMARY_LIVE_BAND.hardMaxWords);
      expect(decision.sentences).toBe(SUMMARY_LIVE_BAND.minSentences);
    });
  });

  it("refuses the rows whose evidence attests only the clock on fact density (AC9)", () => {
    for (const i of NO_FACT_ROWS) {
      const row = shipped[i];
      const decision = gateSummaryDetail(row.body, row.evidence);
      expect({ caption: row.caption, summary: decision.summary }).toEqual({ caption: row.caption, summary: null });
      expect(decision.violations).toContain("too-few-facts");
      // The ADAAAA-8687 bars are untouched: the body is NOT refused for restating.
      expect(decision.violations).not.toContain("restates-caption");
    }
  });

  it("still refuses a body that answers each caption with a copy", () => {
    for (const row of shipped) {
      const decision = gateSummaryDetail(`${row.caption} ${row.caption}`, row.evidence);
      expect({ caption: row.caption, restates: decision.violations.includes("restates-caption") }).toEqual({
        caption: row.caption,
        restates: true,
      });
      expect(decision.summary).toBeNull();
    }
  });

  // QA-C (ADAAAA-8683 comment on ADAAAA-8687) measured the same 0/4 refusal on the
  // VOD rail. The band differs (floor 30 / target 40-90 / hard 120 words, 700
  // chars) but R1-R3 must judge novelty identically, so a VOD-length elaboration
  // of the same short captions has to pass — a fix that only relaxes the live bar
  // would leave AC1-VOD at 0% coverage.
  it("accepts a VOD-length faithful body for the same captions (AC1-VOD)", () => {
    const vodBodies = [
      "The crowd erupts as the ball shoots through midfield in the opening exchanges. " +
        "A short burst of noise around 0:12 marks the move that briefly lifts the ground. " +
        "Play resumes quickly with both sides still holding their shape through the next few passes.",
      "The audio feed carries a loud call near 1:42 and the crowd answers it at once. " +
        "Both benches are up and the near touchline fills with movement. " +
        "No scoreboard read inside the window backs the moment up, so the clip stays a celebration.",
      "The scoreboard flips from 2-1 to 2-2 at 2:40 into the clip. " +
        "The scoreline reads 2-2 as the passage of play continues toward the edge of the box. " +
        "The clock runs past 2:41 with the score still level at 2-2. " +
        "The clip closes on the same 2-2 scoreline with the clock near 2:38.",
    ];
    shipped.forEach((row, i) => {
      // AC9: a row attesting only the clock cannot carry a compliant VOD body either.
      if (NO_FACT_ROWS.includes(i)) return;
      const evidence: SummaryEvidence = { ...row.evidence, rail: "vod" };
      const decision = gateSummaryDetail(vodBodies[i], evidence);
      expect({ caption: row.caption, violations: decision.violations }).toEqual({ caption: row.caption, violations: [] });
      expect(decision.summary).toBe(vodBodies[i]);
      expect(decision.words).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.targetMinWords);
      expect(decision.words).toBeLessThanOrEqual(SUMMARY_VOD_BAND.targetMaxWords);
      expect(decision.sentences).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.minSentences);
      expect(decision.sentences).toBeLessThanOrEqual(SUMMARY_VOD_BAND.maxSentences);
      expect(vodBodies[i].length).toBeLessThanOrEqual(SUMMARY_VOD_BAND.hardMaxChars);
    });
    // AC9 on the VOD rail too: a clock-only row's VOD body is refused for fact
    // density, not for length or novelty.
    for (const i of NO_FACT_ROWS) {
      const clockOnly = gateSummaryDetail(vodBodies[i], { ...shipped[i].evidence, rail: "vod" });
      expect(clockOnly.violations).toContain("too-few-facts");
      expect(clockOnly.violations).not.toContain("restates-caption");
    }
    // R4 on the VOD rail: the confirmed-GOAL body reuses the caption's own
    // `scoreboard` / `2-2` tokens (coverage sits AT the retired 0.5 bar) and is
    // still stored — overlap is an observation, never a drop reason.
    const goalDecision = gateSummaryDetail(vodBodies[2], { ...shipped[2].evidence, rail: "vod" });
    expect(goalDecision.captionOverlap).toBeGreaterThanOrEqual(0.5);
    expect(goalDecision.violations).not.toContain("restates-caption");
    expect(goalDecision.summary).not.toBeNull();
  });

  it("keeps the enum-labels bar while letting the prose nouns through (ADAAAA-8687)", () => {
    // The reply the served build ACTUALLY refused on 6d6090a: `internal-token`
    // fired on the ordinary word `goal`.
    const served = shipped[2].evidence;
    const reply =
      "The midfielder finds the back of the net to level the score at 2-2. " +
      "This goal occurs at the 2:40 mark of the match.";
    const decision = gateSummaryDetail(reply, served);
    // ADAAAA-8910 (defect 2): `mark of the match` is no longer accepted copy — the
    // offset is a clip offset, so the gate renames the frame before judging and
    // the row still serves (`neutralised`, not dropped).
    expect(decision.violations).toEqual([]);
    expect(decision.gate).toBe("neutralised");
    // AC10 (rev 3): `the midfielder` is a role claim the row's evidence does not
    // attest (postTitle/reason/caption are copy, not evidence), so the gate
    // neutralises the subject and still serves the body.
    expect(decision.summary).toBe(
      reply.replace("The midfielder", "The shot").replace("mark of the match", "mark of the clip")
    );
    // … and the match-time frame never reaches the served copy.
    expect(clockFrameClaims(decision.summary ?? "")).toEqual([]);
    // The pipeline's snake_case enum shape is still refused outright …
    const enumBody =
      "The move ends as a scoring_play in the second half. The crowd answers it around 2:40 at the near post.";
    expect(gateSummaryDetail(enumBody, live()).violations).toContain("internal-token");
    // … and an uppercase / snake_case marker is STRIPPED (never served), never
    // accepted into the stored copy.
    for (const tokenText of ["BIG_PLAY", "scoring_play"]) {
      const body = `The move ends as a ${tokenText} in the second half. The crowd answers it around 2:40 at the near post.`;
      const out = gateSummaryDetail(body, live()).summary ?? "";
      expect({ token: tokenText, served: out.includes(tokenText) }).toEqual({ token: tokenText, served: false });
    }
  });

  it("refuses a label in a LABEL POSITION and serves the same words as prose (ADAAAA-8691)", () => {
    // QA-E's bounded VOD job `572f1ec7` on `c76ab91` refused a grounded GOAL
    // body for the ordinary phrase `scoring play`: the window scan below ran
    // over the whole body, so `This scoring play follows a period of intense
    // competition …` read as the pipeline's `scoring_play`. 1 of the 2 promotable
    // VOD rows went unserved on that alone.
    expect(internalLabelPhrases("Real Madrid takes the lead as the scoreboard updates to 2-1.")).toEqual([]);
    for (const prose of [
      "This scoring play follows a period of intense competition between the two sides.",
      "The move ends as a big play in the second half and the crowd answers it at the near post.",
      "The keeper is beaten by a near miss off the far post and the ball runs wide.",
    ]) {
      expect({ prose, hits: internalLabelPhrases(prose) }).toEqual({ prose, hits: [] });
    }
    // The label POSITIONS are still refused: the body IS the label, and a
    // delimited chunk that IS the label (`label: …`, `verdict — label`).
    expect(internalLabelPhrases("scoring_play")).toEqual(["scoring play"]);
    expect(internalLabelPhrases("big play: The ball shoots in midfield.")).toEqual(["big play"]);
    expect(internalLabelPhrases("The row reads near miss — the ball goes wide of the post.")).toEqual(["near miss"]);
    // … and the enum SHAPE is refused wherever it sits, prose or not.
    const enumBody =
      "The move ends as a scoring_play in the second half. The crowd answers it around 2:40 at the near post.";
    expect(gateSummaryDetail(enumBody, live()).violations).toContain("internal-token");
    const labelFirstBody = "big play: The move ends in the second half and the crowd answers it at the near post.";
    expect(gateSummaryDetail(labelFirstBody, live()).violations).toContain("internal-token");
  });

  it("tells a celebration row not to touch the score, and offers it no score fact", () => {
    // The served probe's second refusal was a celebration body that said "the
    // current score remains unchanged" — the shared claim lexicon reads
    // `score`/`scoring` as a claim, so the prompt must not steer a non-scoring row
    // there. Snapshot the branch so a prompt edit is a reviewed change.
    const celebration = buildSummaryPrompt({ ...shipped[0].evidence, postTitle: null });
    expect(celebration).toContain("This is NOT a scoring play");
    expect(celebration).toContain("Carry at least TWO different facts from the evidence, not just the clock");
    expect(celebration).toMatchSnapshot();
    const scoring = buildSummaryPrompt({ ...shipped[2].evidence, postTitle: "Midfielder scores" });
    expect(scoring).toContain("the score line, the clock or spell");
    expect(scoring).not.toContain("This is NOT a scoring play");
  });

  it("still reports the refused reply verbatim in `decision.raw` (ADAAAA-8687 item 3)", () => {
    const row = shipped[2];
    const reply = `  T+160 s — ${row.caption} ${row.caption}  `;
    const decision = gateSummaryDetail(reply, row.evidence);
    expect(decision.summary).toBeNull();
    // The clock prefix and the surrounding whitespace are stripped; the body is kept.
    expect(decision.raw).toBe(`${row.caption} ${row.caption}`);
    expect(decision.raw.length).toBeLessThanOrEqual(SUMMARY_RAW_MAX_CHARS);
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
    expect(prompt).toContain("Rail: vod. Write 3-5 sentences, 45-55 words.");
    expect(prompt).toContain("Match context:\n(none)");
    expect(prompt).toContain("ASR transcript: (none)");
    expect(prompt).toMatchSnapshot();
  });
});

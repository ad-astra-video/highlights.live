// ADAAAA-8914 (AC14 — no filler depth): the rev-7 served bodies replayed at $0.
//
// Found by the PO in the AC7 read off the rev-7 round (ADAAAA-8837). Build
// `sha256:6426d6bf…19e4` / HEAD `77215b5` cleared every standing bar and still
// read as filler:
//
//   * AC8 compares only the FIRST FOUR WORDS, so the per-job sentence template
//     (`This pivotal moment occurs at the … mark of the match.`) repeated on all
//     three live bodies at 0.965-0.982 pairwise similarity — ~11 of each body's
//     30-32 words — and was never seen;
//   * the depth bars were BODY bars, so a 46-word VOD body carrying one fact
//     served `The crowd erupts in celebration`, `the atmosphere in the stadium is
//     electric`, `secures a vital point` — none attested;
//   * a clock clause was only reconciled against the CLIP anchor, so the offset
//     could be called match time while the row's own `matchClock.token` said
//     something else.
//
// Every body and every evidence field below is the row's own stored value from
// the round bundle (`02-live/leg8837-live-bundle/per-row.txt` + `jobs.jsonl`,
// `03-vod/leg8871-vod-bundle/per-row.txt`). No model call, no GPU, no DB write.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_CALL_TIMEOUT_MS,
  SUMMARY_FEE_RATIO,
  SUMMARY_LIVE_BAND,
  SUMMARY_MAX_CALLS_PER_ROW,
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
  SUMMARY_VOD_BAND,
  attestedMatchClockToken,
  buildSummaryPrompt,
  clockTokensOf,
  closestSentencePair,
  dropFillerSentences,
  gateSummaryDetail,
  internalSentenceRepeats,
  matchClockFrameClaims,
  repeatedSentences,
  resolveSummaryFee,
  sentenceFactKinds,
  sentenceSimilarity,
  summaryClockReport,
  summaryFacts,
  summarySentenceFacts,
  summarySentencesOf,
  summaryViolations,
  summaryWordCount,
  unattestedAtmosphereClaims,
  unattestedSentences,
  type SummaryEvidence,
} from "../src/highlight-summary.js";

/** Live job `9bed3bd7`: `{sport, teams[1 Barcelona], trail[Real Madrid], ambiguous}`
 *  — no competition key, no venue key, job-wide. */
const LIVE_CONTEXT = {
  sport: "soccer",
  teams: [{ name: "Barcelona", side: "away", kitColors: [], confidence: 0.5 }],
  inferredAt: "2026-11-13T06:12:29.808402Z",
  resolverVersion: 1,
  ambiguous: true,
  trail: [
    { at: "2026-11-13T06:08:30.057Z", names: [{ side: "away", name: "Barcelona", confidence: 0.5 }] },
    { at: "2026-11-13T06:09:32.884Z", names: [{ side: "home", name: "Real Madrid", confidence: 0.5 }] },
  ],
};

const liveRow = (
  windowTs: number,
  from: string,
  to: string,
  caption: string,
  matchClock: { token: string; seconds: number; ts: number }
): SummaryEvidence => ({
  rail: "live",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason: `Scoreboard changes from ${from} to ${to} at t=0.0s; scoreboard score change confirmed`,
  caption,
  postTitle: null,
  windowTs,
  windowDurationS: 15,
  scoreTransition: { from, to },
  matchContext: LIVE_CONTEXT,
  transcript: null,
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: true },
  matchClock: { token: matchClock.token, seconds: matchClock.seconds, period: null, legible: true },
});

/** Row `aed6c4a4` — GOAL, 1-1 -> 2-1, window 95.67 s, attested match clock 18:13. */
const ROW_AED6 = liveRow(95.67, "1-1", "2-1", "Scoreboard changes to 2-1.", { token: "18:13", seconds: 1093, ts: 102.67 });
/** Row `dc96ed06` — GOAL, 2-1 -> 2-2, window 155.003 s, attested match clock 22:19. */
const ROW_DC96 = liveRow(155.003, "2-1", "2-2", "Scoreboard changes to 2-2.", { token: "22:19", seconds: 1339, ts: 162.003 });
/** Row `7574cba1` — GOAL, 1-1 -> 2-1, window 395.57 s, attested match clock 18:13. */
const ROW_7574 = liveRow(395.57, "1-1", "2-1", "Scoreboard changes to 2-1.", { token: "18:13", seconds: 1093, ts: 402.57 });

const vodRow = (windowTs: number, from: string, to: string, caption: string): SummaryEvidence => ({
  rail: "vod",
  verdict: "scoring_play",
  eventType: "GOAL",
  // The VOD rail persists its reason with the scorebug's MATCH clock (18:06 /
  // 22:13) and NO `matchClock` reading, so the row cannot attest a match stamp.
  reason: `The scoreboard changes from ${from} to ${to} at 18:06, and the ASR confirms the goal.; scoreboard score change confirmed`,
  caption,
  postTitle: caption.replace("Goal at", "GOAL ·"),
  windowTs,
  windowDurationS: 15,
  scoreTransition: { from, to },
  matchContext: LIVE_CONTEXT,
  transcript: null,
  matchClock: null,
});

/** Row `1a5878b2` — GOAL, 1-1 -> 2-1, clip offset 0:27, no persisted match clock. */
const ROW_1A58 = vodRow(27, "1-1", "2-1", "Goal at 0:27.");
/** Row `532204a9` — GOAL, 2-1 -> 2-2, clip offset 1:24, no persisted match clock. */
const ROW_5322 = vodRow(84, "2-1", "2-2", "Goal at 1:24.");

/** The five bodies the rev-7 build SERVED, verbatim from the bundle. */
const SERVED_AED6 =
  "Real Madrid takes the lead to make the score 2-1. This pivotal moment occurs at the 1:42 mark of the match. The team continues to press for dominance in this high-stakes competition.";
const SERVED_DC96 =
  "Real Madrid levels the score to 2-2. This pivotal moment occurs at the 2:46 mark of the match. The team maintains their momentum against their opponent to secure the tie.";
const SERVED_7574 =
  "Barcelona takes the lead as the scoreboard updates to 2-1. This pivotal moment occurs at the 6:42 mark of the match. The team maintains their momentum in this intense competition.";
const SERVED_1A58 =
  "Real Madrid takes the lead as the scoreboard changes from 1-1 to 2-1 at the 0:27 mark. Barcelona players react to the sudden shift in momentum during this high-stakes match. The score transition confirms a pivotal moment in the game as the teams battle for control.";
const SERVED_5322 =
  "Barcelona finds the equalizer to level the score at 2-2. The crowd erupts in celebration as the team secures a vital point in this intense match. This scoring play shifts the momentum during the game. The atmosphere in the stadium is electric following this dramatic turn of events.";

const SERVED: { id: string; evidence: SummaryEvidence; body: string; words: number }[] = [
  { id: "aed6c4a4", evidence: ROW_AED6, body: SERVED_AED6, words: 32 },
  { id: "dc96ed06", evidence: ROW_DC96, body: SERVED_DC96, words: 30 },
  { id: "7574cba1", evidence: ROW_7574, body: SERVED_7574, words: 30 },
  { id: "1a5878b2", evidence: ROW_1A58, body: SERVED_1A58, words: 46 },
  { id: "532204a9", evidence: ROW_5322, body: SERVED_5322, words: 48 },
];

// --- AC14.1 + AC14.2: every sentence carries a fact, no atmosphere filler ------

describe("AC14.1/AC14.2 — the served bodies' filler sentences are unattested", () => {
  it("reports the sentence count, the facts per sentence and the unattested sentences", () => {
    // The report a `$0` census reads per body: sentence count, the fact kinds each
    // sentence credits, and which sentences assert nothing (AC14.1's own shape).
    for (const row of SERVED) {
      const reports = summarySentenceFacts(row.body, row.evidence);
      expect(reports.length).toBe(summarySentencesOf(row.body).length);
      const unattested = unattestedSentences(row.body, row.evidence);
      // Every rev-7 body carried at least one filler sentence; the VOD pair carried
      // 2-3 of them. That is the defect, measured.
      expect({ id: row.id, unattested: unattested.length > 0 }).toEqual({ id: row.id, unattested: true });
      for (const report of unattested) {
        expect(report.facts.length === 0 || report.claims.length > 0).toBe(true);
      }
    }
  });

  it("names the atmosphere / reaction clause in each of the four measured examples", () => {
    const cases: [string, string][] = [
      ["the crowd erupts in celebration", "the crowd"],
      ["the atmosphere in the stadium is electric", "atmosphere"],
      ["barcelona players react", "players react"],
      ["battle for control", "battle for control"],
    ];
    for (const [clause, expected] of cases) {
      const hits = unattestedAtmosphereClaims(clause);
      expect({ clause, hit: hits.includes(expected) }).toEqual({ clause, hit: true });
    }
  });

  it("refuses every one of the five served bodies, and never serves the filler", () => {
    for (const row of SERVED) {
      const decision = gateSummaryDetail(row.body, row.evidence);
      expect({ id: row.id, summary: decision.summary }).toEqual({ id: row.id, summary: null });
      // The clause repair deleted at least one sentence on every body — the gate
      // repairs by DELETE, so no painted-over claim can reach the card.
      expect(decision.droppedClauses.length).toBeGreaterThan(0);
    }
  });

  it("drops the live template sentence and reports the value vocabulary", () => {
    const decision = gateSummaryDetail(SERVED_7574, ROW_7574);
    expect(decision.droppedClauses).toContain("This pivotal moment occurs at the 6:42 mark of the clip.");
    expect(decision.clauseClaims).toContain("pivotal moment");
    // ADAAAA-8934: the deletion alone left the row's one fact sentence (25 words
    // against the live floor of 18), so the repair SUBSTITUTES a fact-bearing
    // sentence from the row's own score transition instead of starving the card
    // (the AC1 half of the same defect).
    expect(decision.substitutedClauses.length).toBeGreaterThan(0);
    expect(decision.repairedWords).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.floorWords);
    // … and the row still refuses on its OWN compliance bars (the venue and the
    // atmosphere prose it wrote), which is the correct drop.
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("unattested-atmosphere");
  });

  it("keeps a repaired, fact-per-sentence body on the same evidence", () => {
    // The tightening is not a trade: a body that says the same facts in every
    // sentence serves (AC6 — the standing bars keep passing on the same rows).
    // ADAAAA-8934: the second fact in each sentence is a BOUNDED act by a named
    // attested actor. The rev-8 shape ("keeps possession", "presses high",
    // "carries the ball forward") is a sustained STATE, which no channel on the
    // row measures — it is deleted, so it can no longer stand in for a fact.
    const repaired = [
      "The scoreboard moves to 2-1 at the 1:35 mark of this clip. Real Madrid intercepts the ball near the box at the 1:35 mark of this clip.",
      "The scoreboard moves to 2-2 at the 2:35 mark of this clip. Barcelona recovers the ball near the wing and counters at the 2:35 mark of this clip.",
      "The scoreboard moves to 2-1 at the 6:35 mark of this clip. Real Madrid threads a pass to the left flank at the 6:35 mark of this clip.",
    ];
    const rows = [ROW_AED6, ROW_DC96, ROW_7574];
    rows.forEach((evidence, i) => {
      const decision = gateSummaryDetail(repaired[i], evidence);
      expect({ i, violations: decision.violations }).toEqual({ i, violations: [] });
      expect(decision.summary).toBe(repaired[i]);
      expect(decision.words).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.floorWords);
      expect(summaryViolations(repaired[i], evidence)).toEqual([]);
    });
  });

  it("keeps a repaired VOD body in the target band on the same evidence", () => {
    // ADAAAA-8934: bounded acts, not sustained state (see the live fixtures above).
    const repaired = [
      "Real Madrid intercepts the ball near the box and counters at 0:27 into the clip. " +
        "Barcelona recovers the ball near the wing and threads a pass to the left flank at 0:27 of the clip. " +
        "The scoreboard moves from 1-1 to 2-1 at the 0:27 mark and holds there as the clip closes out.",
      "Barcelona recovers the ball near the wing and threads a pass to the left flank at 1:24 into the clip. " +
        "Real Madrid intercepts the ball near the box and counters at 1:24 of the clip. " +
        "The scoreboard moves from 2-1 to 2-2 at the 1:24 mark and holds there as the clip closes out.",
    ];
    const rows = [ROW_1A58, ROW_5322];
    rows.forEach((evidence, i) => {
      const decision = gateSummaryDetail(repaired[i], evidence);
      expect({ i, violations: decision.violations }).toEqual({ i, violations: [] });
      expect(decision.words).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
      expect(decision.words).toBeLessThanOrEqual(SUMMARY_VOD_BAND.targetMaxWords);
      expect(decision.droppedClauses).toEqual([]);
    });
  });
});

// --- AC14.3: no two bodies share a sentence at >= 0.80 ------------------------

describe("AC14.3 — the per-job sentence template is detected", () => {
  it("scores the three live template sentences above the bar", () => {
    const templates = SERVED.filter((r) => r.evidence.rail === "live").map((r) => summarySentencesOf(r.body)[1]);
    for (const a of templates) {
      for (const b of templates) {
        if (a === b) continue;
        expect(sentenceSimilarity(a, b)).toBeGreaterThanOrEqual(SUMMARY_SENTENCE_REPEAT_THRESHOLD);
      }
    }
    expect(SUMMARY_SENTENCE_REPEAT_THRESHOLD).toBe(0.8);
  });

  it("reports the closest pair and its similarity, passing or not", () => {
    const bodies = SERVED.filter((r) => r.evidence.rail === "live").map((r) => r.body);
    const closest = closestSentencePair(bodies);
    expect(closest).not.toBeNull();
    expect(closest!.similarity).toBeGreaterThanOrEqual(0.8);
    expect(closest!.passes).toBe(false);
    // A clean set still REPORTS its closest pair, so a pass is evidence and not an
    // absence.
    const clean = closestSentencePair([
      "The scoreboard moves to 2-1 at the 1:35 mark of this clip.",
      "Barcelona presses high to force a turnover near the wing.",
    ]);
    expect(clean).not.toBeNull();
    expect(clean!.passes).toBe(true);
    expect(clean!.similarity).toBeLessThan(0.8);
  });

  it("flags a body that repeats a sentence already served in the job", () => {
    const servedSentences = summarySentencesOf(SERVED_AED6);
    const repeats = repeatedSentences(SERVED_DC96, servedSentences);
    expect(repeats.length).toBeGreaterThan(0);
    expect(repeats[0].similarity).toBeGreaterThanOrEqual(0.8);
    // An honest body shares nothing at the bar.
    expect(
      repeatedSentences("Barcelona presses high to force a turnover near the wing.", servedSentences)
    ).toEqual([]);
  });

  it("flags a body that recites its own sentence", () => {
    expect(internalSentenceRepeats("Barcelona presses high near the wing. Barcelona presses high near the wing.")).toHaveLength(1);
    expect(internalSentenceRepeats(SERVED_AED6)).toEqual([]);
  });
});

// --- AC14.4: the clock clause must serve the row's match clock ----------------

describe("AC14.4 — clockToken(body) vs matchClock.token", () => {
  it("reports both tokens per served row", () => {
    const report = summaryClockReport(SERVED_AED6, ROW_AED6);
    expect(report.tokens).toEqual(["1:42"]);
    expect(report.matchClockToken).toBe("18:13");
    expect(report.servesMatchClock).toBe(false);
    // The frame is the ADAAAA-8910 defect: the clip offset called match time.
    expect(report.frames).toContain("mark of the match");
    // On a row with no persisted reading there is nothing to compare.
    expect(summaryClockReport(SERVED_1A58, ROW_1A58).matchClockToken).toBeNull();
    expect(summaryClockReport(SERVED_1A58, ROW_1A58).servesMatchClock).toBeNull();
  });

  it("refuses a match-framed clock that is not the attested token, and the gate renames it", () => {
    // The 8910 repair renames the frame, so the bar behind it only fires on the
    // RAW bytes — which is exactly what a replay/census reads.
    expect(matchClockFrameClaims(SERVED_AED6, ROW_AED6)).toContain("mark of the match");
    const decision = gateSummaryDetail(SERVED_AED6, ROW_AED6);
    expect(decision.summary).toBeNull();
    // A body that DOES serve the attested stamp has nothing to refuse.
    const honest = "Real Madrid keeps possession and works the ball forward through midfield at 18:13 of the match.";
    expect(matchClockFrameClaims(honest, ROW_AED6)).toEqual([]);
    expect(summaryClockReport(honest, ROW_AED6).servesMatchClock).toBe(true);
  });

  it("extends the rule to the VOD rail: no match clock, no match-time frame", () => {
    // VOD row `1a5878b2` serves "at the 0:27 mark" while its own stored reason
    // reads 18:06 — a match stamp the row does not persist.
    expect(attestedMatchClockToken(ROW_1A58)).toBeNull();
    const framesOnOffset = "The scoreboard changes from 1-1 to 2-1 at the 0:27 mark of the match.";
    expect(matchClockFrameClaims(framesOnOffset, ROW_1A58)).toContain("mark of the match");
    expect(clockTokensOf(SERVED_1A58)).toEqual(["0:27"]);
    // The gate repairs it to the clip frame before judging.
    const neutralised = gateSummaryDetail(framesOnOffset, ROW_1A58);
    expect(neutralised.summary ?? "").not.toContain("of the match");
  });
});

// --- AC14.5: repair once, drop with the named reason, no fee change ----------

describe("AC14.5 — the refusal path stays cheap", () => {
  it("drops the offending clauses extractively and reports the survivors' words", () => {
    const drop = dropFillerSentences(SERVED_5322, ROW_5322);
    expect(drop.dropped).toHaveLength(3);
    expect(drop.claims).toContain("momentum");
    expect(drop.claims).toContain("atmosphere");
    // ADAAAA-8934: the deleted clauses are replaced with facts the row attests,
    // in the slots they left, so the surviving sentence keeps its position.
    expect(drop.text.startsWith("Barcelona finds the equalizer to level the score at 2-2.")).toBe(true);
    expect(drop.substituted.length).toBeGreaterThan(0);
    for (const sentence of drop.substituted) {
      expect(sentenceFactKinds(sentence, ROW_5322).length).toBeGreaterThan(0);
      expect(unattestedSentences(sentence, ROW_5322)).toEqual([]);
    }
    // ADAAAA-8934: the repair may substitute at most as many sentences as the draft
    // itself kept, so a draft that grounded ONE sentence is not rebuilt into repair
    // prose. This row therefore stays short and drops honestly (the rev-8 shape with
    // 2-3 survivors is the case the substitution serves).
    expect(drop.substituted.length).toBeLessThanOrEqual(2);
    expect(summaryWordCount(drop.text)).toBeLessThan(SUMMARY_VOD_BAND.floorWords);
  });

  it("substitutes into the deleted slots, and may never become the body", () => {
    // ADAAAA-8934: the repair now REPLACES deleted filler with attested facts. It is
    // capped at the number of sentences the draft itself grounded, so a draft that
    // kept one sentence of twelve words stays under the VOD floor and drops on depth
    // — serving it would mean the repair wrote the card, not the model.
    const decision = gateSummaryDetail(SERVED_5322, ROW_5322);
    expect(decision.summary).toBeNull();
    expect(decision.droppedClauses).toHaveLength(3);
    expect(decision.substitutedClauses.length).toBeGreaterThan(0);
    expect(decision.substitutedClauses.length).toBeLessThanOrEqual(2);
    expect(decision.violations).toContain("too-few-words");
    expect(decision.violations).toContain("unattested-atmosphere");
    expect(decision.repairedWords).toBeGreaterThan(0);
  });

  it("falls under the floor only when the row attests no fact to substitute", () => {
    // The repair cannot invent: a row with no score transition and no clip anchor
    // offers an empty pool, so the deletion's shortfall stands and the depth bar
    // names it.
    const barren: SummaryEvidence = {
      ...ROW_5322,
      windowTs: null,
      scoreTransition: null,
    };
    const decision = gateSummaryDetail(SERVED_5322, barren);
    expect(decision.summary).toBeNull();
    expect(decision.substitutedClauses).toEqual([]);
    expect(decision.repairedWords).toBeLessThan(SUMMARY_VOD_BAND.floorWords);
    expect(decision.violations).toContain("too-few-words");
  });

  it("keeps the fee class and the call bound", () => {
    // AC14 is a gate/prompt tightening, never a fee-class change: the same one
    // retry slot, the same <= 1.5x DECIDE_FEE ceiling, the same per-call timeout.
    expect(SUMMARY_MAX_CALLS_PER_ROW).toBe(2);
    expect(SUMMARY_FEE_RATIO).toBe(1.5);
    expect(resolveSummaryFee(0.01)).toBeCloseTo(0.015, 6);
    expect(SUMMARY_CALL_TIMEOUT_MS).toBe(2500);
  });
});

// --- the prompt asks for facts per sentence, on both rails -------------------

describe("prompt — every rail asks for a fact per sentence", () => {
  it("carries the three AC14 rules on the live and VOD prompts", () => {
    for (const rail of ["live", "vod"] as const) {
      const prompt = buildSummaryPrompt({ ...ROW_AED6, rail });
      expect(prompt).toContain("Every sentence must carry at least one fact from the evidence");
      expect(prompt).toContain("Never describe the atmosphere, the crowd, the fans, a celebration, a reaction, momentum");
      expect(prompt).toContain("Do not reuse a sentence shape from another card in this job");
    }
  });

  it("hands the model the row's attested match clock when it carries one", () => {
    expect(buildSummaryPrompt(ROW_AED6)).toContain("The row's attested MATCH clock is 18:13.");
    // No persisted reading => no match-clock line (nothing to quote).
    expect(buildSummaryPrompt({ ...ROW_AED6, matchClock: null })).not.toContain("attested MATCH clock");
  });

  it("shows the job's served sentences and names the offending one on the retry", () => {
    const prompt = buildSummaryPrompt({
      ...ROW_DC96,
      avoidSentences: summarySentencesOf(SERVED_AED6),
      retry: { words: 30, sentences: 3, violations: ["repeat-sentence", "unattested-atmosphere"] },
    });
    expect(prompt).toContain("Do not reuse a sentence already served on another card in this job");
    expect(prompt).toContain("The previous draft repeated a sentence another card in this job already carries.");
    expect(prompt).toContain("The previous draft spent sentences on atmosphere, a crowd, a reaction");
  });

  it("no longer offers the crowd or a reaction as substitute copy", () => {
    // ADAAAA-8806's ball-outcome line used to end "Describe the move, the
    // reaction, the crowd or the team's play instead." — the prompt itself asked
    // for the filler AC14.2 refuses.
    const noBall = buildSummaryPrompt({ ...ROW_AED6, attestation: { ballOutcome: null, goalCrossed: false } });
    expect(noBall).not.toContain("Describe the move, the reaction, the crowd");
    expect(noBall).toContain("Do not describe the crowd, the atmosphere, a celebration or a player's reaction");
  });
});

// --- AC6: the bars already standing do not move ------------------------------

describe("AC6 — the standing bars read the same facts", () => {
  it("credits the same score / clock / action kinds on the repaired rows", () => {
    expect(summaryFacts("The scoreboard moves to 2-1 at the 1:35 mark of this clip.").map((f) => f.kind)).toEqual([
      "score",
      "clock",
    ]);
    expect(attestedMatchClockToken(ROW_AED6)).toBe("18:13");
    for (const row of SERVED) {
      const report = summarySentenceFacts(row.body, row.evidence);
      // AC8's opening run, AC9's fact kinds, AC10's role neutralisation and the
      // AC13 token scan are untouched: the bars still run, they just no longer
      // bless a sentence with no fact in it.
      expect(report.every((s) => s.words > 0)).toBe(true);
    }
  });
});

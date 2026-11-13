// ADAAAA-8910 — the live copy seam, replayed at $0 from the rev-7 grade's round
// bundle (ADAAAA-8837, live job `9bed3bd7-0741-4e6a-bb32-63955f158096`, served
// build `6426d6bf`).
//
// Four served-copy defects that the round's ACs cannot catch, one lane:
//
//   1. `postTitle` served 0/5 `refused:unattested-actor` on a job whose own
//      match context attests TWO teams. The FAST prompt asked for "WHO + VERB",
//      the 8831 actor bar refuses every role noun — the two halves of one
//      contract contradicted, so a title that asserted nothing was dropped as if
//      it had asserted something. The title is now the NON-ASSERTING EVENT LABEL
//      and the card composes the clip clock itself (`GOAL · 1:42`).
//   2. Bodies printed the clip offset as MATCH time ("at the 1:42 mark of the
//      match" on a 102.67 s window whose attested match clock is 18:13).
//   3. Bodies asserted a competition/venue the match context does not carry.
//   4. Two rows of ONE transition credited opposite sides as the scorer.
//
// Every fixture string below is the row's own served copy or its own evidence.
import { describe, expect, it } from "vitest";
import {
  composePostTitle,
  deterministicPostTitle,
  gatePostTitleDetail,
  isBareLabelTitle,
  postTitleLabel,
  projectPostTitle,
  storedLabelTitle,
  uniquePostTitle,
  type PostTitleRow,
} from "../src/post-title.js";
import {
  buildSummaryPrompt,
  clockFrameClaims,
  gateSummaryDetail,
  neutraliseMatchClockFrame,
  summaryViolations,
  unattestedSideClaims,
  unattestedVenueClaims,
  type SummaryEvidence,
} from "../src/highlight-summary.js";

/** The job's persisted `matchContext` on `9bed3bd7`: keys are
 *  `{sport, teams, inferredAt, resolverVersion, ambiguous, trail}` — Barcelona is
 *  resolved into `teams`, Real Madrid is attested by the trail, and there is NO
 *  competition key and NO venue key job-wide. */
const JOB_CONTEXT = {
  sport: "soccer",
  teams: [{ name: "Barcelona", side: "away", confidence: 0.5 }],
  ambiguous: true,
  inferredAt: "2026-11-13T05:34:12.306Z",
  resolverVersion: 3,
  trail: [
    { at: "2026-11-13T05:34:19.899Z", names: [{ name: "Barcelona", side: "away", confidence: 0.5 }] },
    { at: "2026-11-13T05:35:23.344Z", names: [{ name: "Real Madrid", side: "home", confidence: 0.5 }] },
  ],
};

/** The prompt the write seam rendered for those rows (both teams, the score). */
const JOB_PROMPT = "Teams: Barcelona\nReal Madrid\nscore 2-1";

// --- defect 1: the title is a NON-ASSERTING label ---------------------------

describe("ADAAAA-8910 defect 1 — a claim-shaped title refusal degrades to the label", () => {
  const ctx = { verdict: "scoring_play", promptText: JOB_PROMPT, ownCopy: "Scoreboard changes to 2-1." };

  it("keeps the label the row's own outcome names", () => {
    expect(postTitleLabel("GOAL", "scoring_play")).toBe("GOAL");
    expect(postTitleLabel("BIG PLAY", "big_play")).toBe("BIG PLAY");
  });

  it("serves `GOAL` for a role-noun headline instead of dropping the card's title", () => {
    // Rows 1-3 of the measured job: the FAST prompt's own WHO+VERB shape.
    const decision = gatePostTitleDetail("Midfielder scores", ctx, { label: "GOAL" });
    expect(decision.title).toBe("GOAL");
    expect(decision.gate).toBe("label:unattested-actor");
    // The bar still names WHY the candidate was refused — the label is the served
    // value, not a silent acceptance of the prose.
    expect(decision.violations).toContain("unattested-actor");
    expect(isBareLabelTitle(decision.title)).toBe(true);
  });

  it("keeps the refusal when the caller supplies no label (the VOD write seam's shape)", () => {
    const decision = gatePostTitleDetail("Midfielder scores", ctx);
    expect(decision.title).toBeNull();
    expect(decision.gate).toContain("refused:unattested-actor");
  });

  it("never degrades a candidate refused by a SHAPE bar", () => {
    // A place chain asserts a zone the row did not attest; the label cannot stand
    // in for a claim the sentence still makes.
    const decision = gatePostTitleDetail("Midfielder scores in the box", ctx, { label: "GOAL" });
    expect(decision.title).toBeNull();
    expect(decision.gate).toContain("refused:");
    expect(decision.violations).toContain("place-chain");
  });

  it("composes the row's own clip clock onto the label", () => {
    expect(composePostTitle({ label: "GOAL", windowTs: 102.67000002361023 })).toBe("GOAL · 1:42");
    // The deterministic projection and the compose agree (one shape, one caller).
    expect(deterministicPostTitle({ eventType: "GOAL", outcome: "scoring_play", windowTs: 102.67 })).toBe("GOAL · 1:42");
  });

  it("stores the composed form and checks uniqueness on it, not on the cleaned value", () => {
    // The write seam's own helper: a bare label would collide on three rows of one
    // job, and `uniquePostTitle` would hand back a bare `1:42` if its return were
    // stored (cleaning deletes both the label and the clock).
    expect(storedLabelTitle({ label: "GOAL", windowTs: 102.67 })).toEqual({
      title: "GOAL · 1:42",
      composed: "GOAL · 1:42",
      duplicate: false,
    });
    const first = storedLabelTitle({ label: "GOAL", windowTs: 102.67 });
    expect(storedLabelTitle({ label: "GOAL", windowTs: 102.67, used: [first.title] })).toEqual({
      title: null,
      composed: "GOAL · 1:42",
      duplicate: true,
    });
    // A second row's own instant is not a duplicate even with the same transition.
    expect(storedLabelTitle({ label: "GOAL", windowTs: 402.94, used: [first.title] }).title).toBe("GOAL · 6:42");
    // A subject the row's copy names keeps the title distinct as well.
    expect(storedLabelTitle({ label: "GOAL", windowTs: 102.67, subject: "Barcelona", used: [first.title] }).title).toBe(
      "GOAL · 1:42 · Barcelona"
    );
  });

  it("serves a stored bare label as `LABEL · m:ss` at the read seam", () => {
    const row: PostTitleRow = { postTitle: "GOAL", caption: "Scoreboard changes to 2-1.", reason: null, eventType: "GOAL", outcome: "scoring_play", localizedTs: 166.94 };
    expect(projectPostTitle(row)).toBe("GOAL · 2:46");
  });

  it("keeps the label distinct per row, so the duplicate guard never eats a card", () => {
    // Two promoted rows of the measured job with the SAME transition still carry
    // different clip instants; a bare `GOAL` on both would collide and the second
    // row would store nothing (`refused:duplicate`).
    const first = composePostTitle({ label: "GOAL", windowTs: 102.67 });
    const second = composePostTitle({ label: "GOAL", windowTs: 402.94 });
    expect(first).not.toBe(second);
    // `uniquePostTitle` answers the duplicate QUESTION and returns the cleaned
    // value, which for this shape is the clock alone — so the write seam stores
    // the composed form and uses this only as the check.
    expect(uniquePostTitle(first, [first])).toBeNull();
    expect(uniquePostTitle(second, [first])).not.toBeNull();
  });

  it("is the shape the two-team job's five rows serve", () => {
    // Five rows of `9bed3bd7`, all refused at the write seam on the served build.
    const rows: { label: string; ts: number }[] = [
      { label: "GOAL", ts: 102.67000002361023 },
      { label: "GOAL", ts: 166.94000003598235 },
      { label: "GOAL", ts: 402.94000002310984 },
      { label: "BIG PLAY", ts: 214.18 },
      { label: "BIG PLAY", ts: 311.42 },
    ];
    const served = rows.map((r) => composePostTitle({ label: r.label, windowTs: r.ts }));
    expect(served).toEqual(["GOAL · 1:42", "GOAL · 2:46", "GOAL · 6:42", "BIG PLAY · 3:34", "BIG PLAY · 5:11"]);
    // Never a refusal token, never an actor, never a score.
    for (const title of served) {
      expect(title).not.toMatch(/refused|:\s|\d-\d/i);
      expect(projectPostTitle({ postTitle: title, caption: null, reason: null, eventType: "GOAL", outcome: "scoring_play" })).toBe(title);
    }
  });
});

// --- defect 2: the clip offset is not match time ----------------------------

/** Row `aed6c4a4`: 102.67 s clip offset, attested match clock `18:13`. */
const ROW_AED6: SummaryEvidence = {
  rail: "live",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason: "Scoreboard changes to 2-1 at 18:13.",
  caption: "Scoreboard changes to 2-1.",
  postTitle: null,
  windowTs: 102.67000002361023,
  scoreTransition: { from: "1-1", to: "2-1" },
  matchContext: JOB_CONTEXT,
  transcript: null,
};

describe("ADAAAA-8910 defect 2 — the offset's frame is the CLIP, never the match", () => {
  it("detects the served phrase, at every row of the leg", () => {
    expect(clockFrameClaims("Real Madrid moves the ball at the 1:42 mark of the match.")).toEqual([
      "mark of the match",
    ]);
    expect(clockFrameClaims("The scoreboard moves to 2-1 at the 2:46 mark of the match.")).toEqual(["mark of the match"]);
    expect(clockFrameClaims("The move happens 18:13 into the match.")).toEqual(["into the match"]);
    // A frame BEFORE the clock is the same claim.
    expect(clockFrameClaims("In match time this lands at 18:13.")).toEqual(["match time"]);
  });

  it("leaves ordinary prose about the match alone", () => {
    expect(clockFrameClaims("Real Madrid moves the ball at 1:42 into the clip.")).toEqual([]);
    expect(clockFrameClaims("This is the best move of the match so far.")).toEqual([]);
    // "of the match" belongs to the sentence, not to the clock: the frame must be
    // ADJACENT to the token (row eaf1da9f of the 8903 census, served after this
    // fix).
    expect(clockFrameClaims("Barcelona maintains control of the match at the 7:57 mark.")).toEqual([]);
  });

  it("renames the frame instead of dropping the row", () => {
    const n = neutraliseMatchClockFrame("Real Madrid moves the ball at the 1:42 mark of the match.");
    expect(n.text).toBe("Real Madrid moves the ball at the 1:42 mark of the clip.");
    expect(n.neutralised).toEqual(["mark of the match"]);
    expect(clockFrameClaims(n.text)).toEqual([]);
  });

  it("serves the repaired body: the row keeps its copy, the false frame is gone", () => {
    // (ADAAAA-8914: this fixture's old second sentence, "The crowd noise builds
    // as the sides reset.", is an atmosphere clause AC14 deletes — an unattested
    // clause is not part of THIS bar's evidence, so the fixture now carries an
    // attested actor's play instead.)
    const draft =
      "Real Madrid moves the ball forward as the scoreboard moves to 2-1 at the 1:42 mark of the match. Real Madrid keeps possession as the sides reset.";
    const decision = gateSummaryDetail(draft, ROW_AED6);
    expect(decision.violations).toEqual([]);
    expect(decision.gate).toBe("neutralised");
    expect(decision.summary).toBe(
      "Real Madrid moves the ball forward as the scoreboard moves to 2-1 at the 1:42 mark of the clip. Real Madrid keeps possession as the sides reset."
    );
    // The served copy can no longer assert a match stamp the row does not carry.
    expect(clockFrameClaims(decision.summary ?? "")).toEqual([]);
  });
});

// --- defect 3: no competition, no venue ------------------------------------

describe("ADAAAA-8910 defect 3 — a competition the match context does not carry is a claim", () => {
  it("refuses the served clauses job-wide", () => {
    for (const body of [
      "Real Madrid moves the ball in this high-stakes competition.",
      "Barcelona presses forward in this intense competition.",
      "The atmosphere in the stadium is electric as the sides reset.",
    ]) {
      expect(unattestedVenueClaims(body, ROW_AED6)).toHaveLength(1);
    }
  });

  it("lets the same clauses through when the match context carries the venue", () => {
    const withVenue: SummaryEvidence = {
      ...ROW_AED6,
      matchContext: { ...JOB_CONTEXT, competition: "La Liga", venue: "Bernabéu" },
    };
    expect(unattestedVenueClaims("The crowd lifts in this competition.", withVenue)).toEqual([]);
  });

  it("refuses a body whose only defect is the venue filler", () => {
    const draft =
      "The crowd noise builds in this intense competition as the scoreboard moves to 2-1 at 1:42 into the clip. Real Madrid holds possession near the touchline.";
    // ADAAAA-8914 (AC14.2): the sentence is ALSO an atmosphere clause ("the crowd
    // noise"), so the one cheap clause repair deletes it before the venue bar can
    // judge it — the body is refused either way, and the raw bar still owns the
    // venue token (asserted below). The repair is not a second venue rule.
    const decision = gateSummaryDetail(draft, ROW_AED6);
    expect(decision.summary).toBeFalsy();
    expect(decision.droppedClauses).toHaveLength(1);
    expect(summaryViolations(draft, ROW_AED6)).toContain("unattested-venue");
  });

  it("tells the retry which clause to delete", () => {
    const retry = buildSummaryPrompt({
      ...ROW_AED6,
      retry: { words: 22, sentences: 2, violations: ["unattested-venue"] },
    });
    expect(retry).toContain("The previous draft named a competition or venue the match context does not carry.");
  });
});

describe("ADAAAA-8910 defect 3 — the prompt stops asking for a fact the row cannot fill", () => {
  it("drops the competition/venue from the fact menu and names the ban", () => {
    const prompt = buildSummaryPrompt(ROW_AED6);
    expect(prompt).not.toContain("the competition or venue, or an attested team's");
    expect(prompt).toContain("the clock or spell, an attested team's or player's action");
    expect(prompt).toContain("The match context carries NO competition and NO venue");
    // The length-band and celebration instructions must not re-offer it either.
    expect(prompt).not.toMatch(/add another fact — the clock, the competition or venue/);
  });

  it("offers it when the match context carries one", () => {
    const prompt = buildSummaryPrompt({
      ...ROW_AED6,
      matchContext: { ...JOB_CONTEXT, competition: "La Liga" },
    });
    expect(prompt).toContain("the clock or spell, the competition or venue, an attested team's or player's action");
    expect(prompt).not.toContain("The match context carries NO competition and NO venue");
  });
});

// --- defect 4: the digits and the names, never the side --------------------

/** Rows 1 and 3 of the leg: the SAME `1-1>2-1` transition, opposite actors. */
const ROW_1_CLAIM = "Real Madrid takes the lead as the scoreboard moves to 2-1 at the 1:42 mark of the match.";
const ROW_3_CLAIM = "Barcelona takes the lead as the scoreboard moves to 2-1 at the 6:42 mark of the match.";

describe("ADAAAA-8910 defect 4 — a direction claim is not attested by the digits", () => {
  it("refuses both sides of the shared transition", () => {
    expect(unattestedSideClaims(ROW_1_CLAIM, ROW_AED6)).toEqual(["takes the lead"]);
    expect(unattestedSideClaims(ROW_3_CLAIM, ROW_AED6)).toEqual(["takes the lead"]);
  });

  it("refuses the whole claim vocabulary on a named actor", () => {
    for (const claim of [
      "Real Madrid levels the score at 2-2.",
      "Barcelona equalises.",
      "Real Madrid goes ahead late.",
      "Barcelona secures a lead.",
      "Real Madrid restores the lead.",
      "Barcelona makes it 2-1.",
    ]) {
      expect({ claim, hits: unattestedSideClaims(claim, ROW_AED6).length }).toEqual({ claim, hits: 1 });
    }
  });

  it("keeps the attested score line and the team's play", () => {
    for (const body of [
      "The scoreboard moves to 2-1 as Real Madrid works the ball forward.",
      "Barcelona presses high and forces a turnover near the touchline.",
    ]) {
      expect(unattestedSideClaims(body, ROW_AED6)).toEqual([]);
    }
  });

  it("does not fire on a sentence that names no attested actor", () => {
    // A subjectless goal claim is the announcer lane's own claim and is gated by
    // `goal-claim`, not by this actor-attribution bar.
    expect(unattestedSideClaims("The equaliser levels it at 2-2.", ROW_AED6)).toEqual([]);
  });

  it("refuses the served row body, and the prompt tells the retry how to restate it", () => {
    const draft =
      "Real Madrid takes the lead as the scoreboard moves to 2-1 at the 1:42 mark of the match in this high-stakes competition.";
    const decision = gateSummaryDetail(draft, ROW_AED6);
    expect(decision.summary).toBeFalsy();
    expect(decision.violations).toContain("unattested-side");
    expect(decision.violations).toContain("unattested-venue");
    const prompt = buildSummaryPrompt({ ...ROW_AED6, retry: decision });
    expect(prompt).toContain("The previous draft said which side scored or took the lead.");
    expect(prompt).toContain("the scoreboard moves to 2-1");
    // The restated body — scoreboard line + the attested team's play — serves.
    // (ADAAAA-8914 replaced its old second sentence, "The crowd answers as the
    // sides reset.", which was itself an atmosphere clause: a fixture of the
    // filler defect, not of this bar.)
    const restated =
      "The scoreboard moves to 2-1 as Real Madrid works the ball forward at 1:42 into the clip. Barcelona presses high to force a turnover.";
    expect(summaryViolations(restated, ROW_AED6)).toEqual([]);
    expect(gateSummaryDetail(restated, ROW_AED6).summary).toBe(restated);
  });

  it("is the direction line that reaches the first pass too", () => {
    const prompt = buildSummaryPrompt(ROW_AED6);
    expect(prompt).toContain("The evidence attests the score CHANGE and the sides' names, never which side scored.");
  });

  it("does not apply to a celebration row", () => {
    const celebration: SummaryEvidence = { ...ROW_AED6, verdict: "big_play", scoreTransition: null };
    expect(buildSummaryPrompt(celebration)).not.toContain("never which side scored");
  });
});

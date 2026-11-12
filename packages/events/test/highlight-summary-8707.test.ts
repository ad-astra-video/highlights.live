// ADAAAA-8707 (spec ADAAAA-8665 rev 3): AC8-AC10 on the caption BODY copy.
//
// These are the bars the ticket names against the MEASURED failing shapes of the
// AC7 sample on `b2912b6`:
//   * 6 of 8 bodies opened "The midfielder...", 5 of 8 shared "drives forward";
//   * 0 of 8 carried a name, 1 of 8 a score line, and "the midfielder" was a
//     role no row in that leg attested.
//
// AC8 is enforced job-scoped in the lane (`services/server/src/summary-lane.ts`);
// this file pins the pure pieces: the normalized opening run, the fact-density
// read, the role-noun attestation/neutralisation, and that rev 3 did not relax a
// single existing grounding bar.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_MIN_FACT_KINDS,
  SUMMARY_OPENING_RUN_WORDS,
  attestedFactKinds,
  attestedRoleNouns,
  attestedSummaryFactKinds,
  buildSummaryPrompt,
  gateSummaryDetail,
  matchContextVenueText,
  neutraliseRoleNouns,
  roleNounClaims,
  summaryOpeningRun,
  unattestedRoleNouns,
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

/** A row that attests the clock and nothing else — the clock-only shape. */
const clockOnly = (extra: Partial<SummaryEvidence> = {}): SummaryEvidence =>
  live({
    matchContext: null,
    transcript: "",
    reason: "",
    scoreTransition: null,
    caption: null,
    postTitle: null,
    ...extra,
  });

describe("AC8 — normalized 4-word opening run", () => {
  it("uses four normalized words and folds case/punctuation", () => {
    expect(SUMMARY_OPENING_RUN_WORDS).toBe(4);
    expect(summaryOpeningRun("The midfielder drives forward with the ball.")).toBe("the midfielder drives forward");
    expect(summaryOpeningRun("the MIDFIELDER drives, forward! then shoots")).toBe("the midfielder drives forward");
  });

  it("collides the measured failing pair and keeps a different opening distinct", () => {
    const a = summaryOpeningRun("The midfielder drives forward into the box and the crowd rises.");
    const b = summaryOpeningRun("The midfielder drives forward again as the move builds on the left.");
    const c = summaryOpeningRun("A low drive from the edge of the box levels it at 2-2.");
    expect(a).toBe(b);
    expect(a).not.toBe("");
    expect(c).not.toBe(a);
  });
});

describe("AC9 — fact density, not filler", () => {
  it("fails a body whose only fact is the clock anchor", () => {
    const body = "The move develops at 2:38 in the second half. The crowd keeps its shape through the next few passes.";
    const decision = gateSummaryDetail(body, clockOnly());
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("too-few-facts");
    expect(attestedSummaryFactKinds(body, clockOnly())).toEqual(["clock"]);
  });

  it("serves a body that relays the clock plus the attested score change", () => {
    const body = "The equaliser levels it at 2-2 in the second half. A low drive from the edge of the box finds the far corner.";
    const ev = live();
    // Rev 4 (ADAAAA-8735): the context names Northbridge/Riverside but the body
    // names nobody, so `action` is NOT credited — the score line plus the clock
    // is what earns this row's place.
    expect(attestedSummaryFactKinds(body, ev)).toEqual(["score", "clock"]);
    expect(attestedSummaryFactKinds(body, ev).length).toBeGreaterThanOrEqual(SUMMARY_MIN_FACT_KINDS);
    expect(gateSummaryDetail(body, ev).summary).toBe(body);
  });

  it("does not count a score line the row does not attest", () => {
    const ev = clockOnly();
    const body = "The equaliser levels it at 2-2 in the second half. A low drive from the edge of the box finds the far corner.";
    expect(attestedFactKinds(ev)).not.toContain("score");
    expect(attestedSummaryFactKinds(body, ev)).not.toContain("score");
    expect(gateSummaryDetail(body, ev).violations).toContain("too-few-facts");
  });

  it("does not count a score line that is not the attested one", () => {
    const body = "The equaliser levels it at 4-0 in the second half. A low drive from the edge of the box finds the far corner.";
    expect(attestedSummaryFactKinds(body, live())).not.toContain("score");
  });

  it("does not count a clock that does not anchor this window", () => {
    const body = "The move develops at 9:12 as a low drive from the edge of the box finds the far corner.";
    expect(attestedSummaryFactKinds(body, live())).not.toContain("clock");
  });

  it("does not count a competition the match context does not carry", () => {
    const ev = live({ matchContext: { teams: [{ name: "Northbridge" }] }, scoreTransition: null });
    const body = "The move develops at 2:38 in the Champions League final. A low drive from the edge of the box finds the far corner.";
    expect(matchContextVenueText(ev.matchContext)).toBe("");
    expect(attestedSummaryFactKinds(body, ev)).not.toContain("venue");
    // Naming a competition the context does not carry is an unattested name too.
    expect(gateSummaryDetail(body, ev).violations).toContain("ungrounded-name");
  });

  it("counts the competition only when the match context carries it", () => {
    const ev = live({ matchContext: { competition: "Champions League" }, scoreTransition: null });
    const body = "The move develops at 2:38 in the Champions League tie. A low drive from the edge of the box finds the far corner.";
    // Rev 4 (ADAAAA-8735): action needs the body to NAME an attested actor, and
    // this body does not — clock + venue are the two facts it carries.
    expect(attestedSummaryFactKinds(body, ev)).toEqual(["clock", "venue"]);
    expect(gateSummaryDetail(body, ev).summary).toBe(body);
  });
});

describe("AC10 — role nouns are attestation claims", () => {
  it("neutralises an unattested role subject and still serves the body", () => {
    const ev = live();
    const body =
      "The midfielder drives forward and the move ends at 2-2 in the second half. The crowd answers it before the restart.";
    expect(unattestedRoleNouns(body, ev).map((c) => c.canonical)).toEqual(["midfielder"]);
    const decision = gateSummaryDetail(body, ev);
    expect(decision.summary).not.toBeNull();
    expect(decision.gate).toBe("neutralised");
    expect(decision.summary).not.toMatch(/midfielder/i);
    expect(decision.summary).toContain("The move drives forward");
    // The model's own words are still recoverable on the decision.
    expect(decision.raw).toBe(body);
  });

  it("uses the shot subject for a shot verb and the play subject otherwise", () => {
    const ev = live();
    expect(neutraliseRoleNouns("The midfielder finds the back of the net at 2:38.", ev).text).toContain("The shot finds");
    expect(neutraliseRoleNouns("The defender stands still as the crowd waits at 2:38.", ev).text).toContain("The play stands");
  });

  it("keeps a role noun the row's roster attests", () => {
    const ev = live({
      matchContext: { teams: [{ name: "Northbridge" }], players: [{ name: "J. Smith", position: "Midfielder" }] },
    });
    expect(attestedRoleNouns(ev).has("midfielder")).toBe(true);
    const body =
      "The midfielder drives forward and the move ends at 2-2 in the second half. The crowd answers it before the restart.";
    const decision = gateSummaryDetail(body, ev);
    expect(decision.gate).toBe("accepted");
    expect(decision.summary).toBe(body);
  });

  it("keeps a role noun the transcript attests", () => {
    const ev = live({ transcript: "the midfielder wins it back and the move builds" });
    const body =
      "The midfielder drives forward at 2-2 in the second half. The crowd answers at once as the move builds on the left.";
    expect(gateSummaryDetail(body, ev).gate).toBe("accepted");
  });

  it("drops a clause whose role noun sits as an object instead of rewriting it", () => {
    const ev = live();
    const body = "The equaliser levels it at 2-2 in the second half. A low drive beats the keeper at the near post.";
    const neutralised = neutraliseRoleNouns(body, ev);
    expect(neutralised.neutralised).toEqual([]);
    expect(neutralised.droppedSentences).toBe(1);
    expect(neutralised.text).toBe("The equaliser levels it at 2-2 in the second half.");
  });

  it("reads role nouns only with a determiner (an adverb 'forward' is not a claim)", () => {
    expect(roleNounClaims("The move drives forward at 2:38.")).toEqual([]);
    expect(roleNounClaims("The striker drives forward.").map((c) => c.canonical)).toEqual(["striker"]);
  });
});

describe("AC8-AC10 do not relax the existing grounding bars", () => {
  it("still refuses a goal claim the verdict does not attest", () => {
    const ev = live({ verdict: "near_miss", eventType: "shot", reason: "The shot goes wide of the far post." });
    const decision = gateSummaryDetail(
      "The equaliser goes in at the near post to level it at 2-2 in the second half. The crowd answers at once.",
      ev
    );
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("goal-claim");
  });

  it("still refuses an unattested name", () => {
    const decision = gateSummaryDetail(
      "Diego Maradona levels it at 2-2 in the second half. A low drive from the edge of the box finds the far corner.",
      live({ transcript: "the equaliser", matchContext: { teams: ["Northbridge", "Riverside"] } })
    );
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("ungrounded-name");
  });

  it("still refuses an internal token / enum label", () => {
    const withToken = gateSummaryDetail(
      "The equaliser is 2-2 in the second half after a scoring_play at the far post. The crowd answers before the restart.",
      live()
    );
    expect(withToken.summary).toBeNull();
    expect(withToken.violations).toContain("internal-token");
  });
});

describe("AC8/AC9/AC10 prompt contract", () => {
  it("asks for two facts, forbids unattested role nouns and varies the opening", () => {
    const prompt = buildSummaryPrompt({
      ...live(),
      postTitle: "GOAL · 2:38",
      avoidOpenings: ["the midfielder drives forward", "the equaliser levels it"],
    });
    expect(prompt).toContain("Carry at least TWO different facts from the evidence, not just the clock");
    expect(prompt).toContain("A body whose only fact is the clock does not count");
    expect(prompt).toContain("is a claim: use it ONLY when the evidence below uses that word");
    expect(prompt).toContain("Do not open with the same words as another card in this job");
    expect(prompt).toContain("'the midfielder drives forward'");
    expect(prompt).toContain("'the equaliser levels it'");
  });

  it("leaves the prompt unchanged when no opening has been served yet", () => {
    expect(buildSummaryPrompt({ ...live(), postTitle: null })).not.toContain("already-served runs");
  });
});

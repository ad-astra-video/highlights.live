// ADAAAA-9031 — the rev-10 VOD grade's three contract defects, pinned at the gate.
//
// Measured on the served build `328bb3b` (jobs `4ad12127`, `76cb4b4b`, `c5dac977`,
// `727655ec`, `11aae5ba`, `ad4dfd77`, 22 promoted rows):
//
//  1. AC14.3 — two served sentence pairs at >= 0.80 whose only difference was the
//     clock (`The clip carries this sequence at 0:24 into the clip.` vs `… at
//     1:21 into the clip.`). The comparator tokenised `0:24` and `1:21` as two
//     DIFFERENT tokens, so the template scored under the bar it exists to enforce.
//  2. AC1-VOD coverage — two promoted `scoring_play` rows were refused
//     `unattested-action` for describing the goal, although their own Stage-2
//     dive recorded `goalConfirmed: confirmed_goal` with 12 frame refs and
//     `corroborated: true`. The gate read only the folded flags
//     (`ballOutcome: null, goalCrossed: false`) and treated a confirmed goal as
//     "nothing measured".
//  3. AC2 — `Manuel Ordoñez` was reported unattested in 7 of 12 served bodies. The
//     row's own `asrTranscript` carries the name ("el centro para Ordoñez …
//     acaba de marcar Manuel Ordoñez, Manu"), so the name gate is CORRECT to
//     serve it; these tests pin both halves (an attested name passes, an invented
//     one is refused) so a later change cannot start refusing attested names or
//     start serving invented ones.
import { describe, expect, it } from "vitest";
import {
  attestedBallActionFrom,
  attestedSummaryFactKinds,
  buildSummaryPrompt,
  dropSentences,
  gateSummaryDetail,
  maskSentenceClocks,
  repeatedSentences,
  sentenceSimilarity,
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
  SUMMARY_VOD_BAND,
  type SummaryEvidence,
} from "@highlights/events";

const GOAL_ASR =
  "Es Carlos Javier quien la pisa, Carlos Javier quien intenta progresar por la banda izquierda, sigue Carlos Javier, el centro para Ordoñez, el remate gol. Acaba de marcar el Real Madrid, acaba de marcar Manuel Ordoñez, Manu, en el minuto.";

/** Row `7ef92cbe` (job `4ad12127`) — a promoted GOAL whose folded attestation
 *  flags read "nothing measured" while its Stage-2 dive recorded the goal. */
const goalEvidence = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "vod",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason: "Goal confirmed by the frame dive.",
  caption: "GOAL · 0:24",
  postTitle: "GOAL · 0:24",
  windowTs: 24,
  windowDurationS: 8,
  scoreTransition: { from: "1-1", to: "2-1" },
  matchContext: { sport: "soccer", teams: [{ name: "Real Madrid", side: "home" }] },
  transcript: GOAL_ASR,
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
  ...over,
});

const goalEvidenceConfirmed = () =>
  goalEvidence({
    attestation: {
      ballOutcome: null,
      goalCrossed: false,
      scoreBoardChanged: false,
      goalConfirmed: "confirmed_goal",
    },
  });

describe("ADAAAA-9031 (AC14.3) — a clock-only difference is not a difference", () => {
  it("scores two template sentences that differ only by the clock at 1.0", () => {
    const a = "The clip carries this sequence at 0:24 into the clip.";
    const b = "The clip carries this sequence at 1:21 into the clip.";
    // The served comparator scored this pair BELOW 0.80 (two distinct clock tokens).
    expect(sentenceSimilarity(a, b)).toBe(1);
    expect(sentenceSimilarity(a, b)).toBeGreaterThanOrEqual(SUMMARY_SENTENCE_REPEAT_THRESHOLD);
  });

  it("masks clock tokens, and only clock tokens", () => {
    expect(maskSentenceClocks("at 0:24 into the clip")).toBe("at clocktime into the clip");
    expect(maskSentenceClocks("the scoreboard moves to 2-1")).toBe("the scoreboard moves to 2-1");
    expect(maskSentenceClocks("Real Madrid 2-1 Barcelona")).toBe("Real Madrid 2-1 Barcelona");
  });

  it("catches the cross-body template pair the rev-10 leg served", () => {
    const repeats = repeatedSentences("The clip carries this sequence at 1:21 into the clip.", [
      "The clip carries this sequence at 0:24 into the clip.",
    ]);
    expect(repeats).toHaveLength(1);
    expect(repeats[0].similarity).toBe(1);
  });

  it("does not mask a score line: the digits stay the fact the copy carries", () => {
    // Clock masking must not touch the score pair. (Whether a score line and its
    // one-digit sibling clear the bar is AC14's own pre-existing reading, not this
    // change's; the pin here is that masking cannot move it.)
    expect(sentenceSimilarity("The scoreboard moves to 2-1.", "The scoreboard moves to 2-2.")).toBe(
      sentenceSimilarity(maskSentenceClocks("The scoreboard moves to 2-1."), maskSentenceClocks("The scoreboard moves to 2-2."))
    );
  });

  it("AC14's repair order has a clause drop: dropSentences removes exactly the named sentences", () => {
    const body = "Real Madrid moves the scoreboard from 1-1 to 2-1 at 0:24 into the clip. The clip carries this sequence at 1:21 into the clip. Carlos Javier threads the pass.";
    expect(dropSentences(body, ["The clip carries this sequence at 1:21 into the clip."])).toBe(
      "Real Madrid moves the scoreboard from 1-1 to 2-1 at 0:24 into the clip. Carlos Javier threads the pass."
    );
    expect(dropSentences(body, [])).toBe(body);
  });

  it("drops a repeated sentence from a served body and keeps it above the VOD floor", () => {
    const body =
      "Real Madrid moves the scoreboard from 1-1 to 2-1 at 0:24 into the clip. Manuel Ordoñez finds the back of the net as the ball crosses the goal line. The clip carries this sequence at 1:21 into the clip. The strike beats the keeper low to his right after Carlos Javier threads the pass through the middle of the pitch.";
    const pruned = dropSentences(body, ["The clip carries this sequence at 1:21 into the clip."]);
    expect(pruned).not.toContain("The clip carries this sequence");
    const decision = gateSummaryDetail(pruned, goalEvidenceConfirmed());
    expect(decision.summary).toBeTruthy();
    expect(decision.words).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
  });
});

describe("ADAAAA-9031 (AC1-VOD coverage) — a confirmed goal is an attested ball outcome", () => {
  it("reads `goalConfirmed: confirmed_goal` as a measured outcome", () => {
    expect(attestedBallActionFrom({ ballOutcome: null, goalCrossed: false })).toBe(false);
    expect(
      attestedBallActionFrom({ ballOutcome: null, goalCrossed: false, goalConfirmed: "confirmed_goal" })
    ).toBe(true);
    // An unconfirmed dive keeps the fail-closed read.
    expect(
      attestedBallActionFrom({ ballOutcome: null, goalCrossed: false, goalConfirmed: "near_miss" })
    ).toBe(false);
  });

  it("serves the goal clause on a confirmed-goal row and refuses it without the dive verdict", () => {
    const body =
      "Manuel Ordoñez finds the back of the net for Real Madrid at 0:24 into the clip. The scoreboard moves from 1-1 to 2-1 as the ball enters the net. Carlos Javier threads the pass that releases Ordoñez through the middle of the pitch, and the strike beats the keeper low to his right.";
    const confirmed = gateSummaryDetail(body, goalEvidenceConfirmed());
    expect(confirmed.violations).not.toContain("unattested-action");
    expect(confirmed.summary).toBeTruthy();
    // The same bytes on a row whose attestation recorded no outcome stay refused.
    const unconfirmed = gateSummaryDetail(body, goalEvidence());
    expect(unconfirmed.violations).toContain("unattested-action");
  });

  it("credits the action fact kind on a confirmed goal, so the two-fact bar is reachable", () => {
    const body = "Manuel Ordoñez finds the back of the net for Real Madrid at 0:24 into the clip.";
    expect(attestedSummaryFactKinds(body, goalEvidenceConfirmed())).toEqual(["clock", "action"]);
  });
});

describe("ADAAAA-9031 (AC2) — name attestation is unchanged: attested passes, invented fails", () => {
  it("serves `Manuel Ordoñez`, which the row's own ASR transcript carries", () => {
    const body =
      "Manuel Ordoñez finds the back of the net for Real Madrid at 0:24 into the clip. The scoreboard moves from 1-1 to 2-1 as the ball enters the net. Carlos Javier threads the pass that releases Ordoñez through the middle of the pitch.";
    const decision = gateSummaryDetail(body, goalEvidenceConfirmed());
    expect(decision.violations).not.toContain("ungrounded-name");
    expect(decision.summary).toContain("Manuel Ordoñez");
  });

  it("refuses a name the row's own evidence does not carry", () => {
    const body =
      "David Saez finds the back of the net for Real Madrid at 0:24 into the clip. The scoreboard moves from 1-1 to 2-1 as the ball enters the net. Carlos Javier threads the pass that releases Ordoñez through the middle of the pitch.";
    const decision = gateSummaryDetail(body, goalEvidenceConfirmed());
    expect(decision.violations).toContain("ungrounded-name");
    expect(decision.summary).toBeNull();
  });
});

describe("ADAAAA-9031 — the prompt states the clock-sentence rule on the FIRST pass", () => {
  it("carries the ban without a retry directive", () => {
    const prompt = buildSummaryPrompt(goalEvidenceConfirmed());
    expect(prompt).toContain("Never spend a whole sentence on the clip clock");
    expect(prompt).toContain("The clip carries this sequence at");
    expect(prompt).toContain("count as the same sentence");
    expect(prompt).not.toContain("RETRY:");
  });
});

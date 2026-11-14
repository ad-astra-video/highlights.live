// ADAAAA-9052 — the AC14 repeat prune's REPAIR, pinned at the contract function.
//
// Measured `$0` on the rev-11 VOD census (22 rows / 6 jobs): AC14's clause drop
// took a fact-bearing draft under the 40-word floor and the lane then discarded
// the ROW. Five rows (`54388ada`, `285ae8d0`, `0b6ee1d8`, `87e616cc`,
// `2646edbb`) dropped as `repeat` with 33-39 words of surviving copy, and one
// more (`8d78c11f`) could not be re-grown at all from its own evidence.
//
// The rule this pins: a pruned body below its band is re-grown to the band with a
// DIFFERENT attested fact, the substitution may not repeat a sentence the job
// already serves, and a row whose evidence offers no admissible fact stays short
// (the repair cannot invent depth).
import { describe, expect, it } from "vitest";
import {
  dropSentences,
  gateSummaryDetail,
  pruneRepeatedSentences,
  sentenceFactKinds,
  summarySentencesOf,
  summaryWordCount,
  SUMMARY_VOD_BAND,
  type SummaryEvidence,
} from "@highlights/events";

const GOAL_ASR =
  "Es Carlos Javier quien la pisa, Carlos Javier quien intenta progresar por la banda izquierda, sigue Carlos Javier, el centro para Ordoñez, el remate gol. Acaba de marcar el Real Madrid, acaba de marcar Manuel Ordoñez, Manu, en el minuto.";

/** Row `54388ada` (job `4ad12127`): a promoted VOD GOAL with a measured score
 *  transition and a named actor — the row class AC14's prune was eating. */
const goalEvidence = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "vod",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason: "Goal confirmed by the frame dive.",
  caption: "GOAL · 0:27",
  postTitle: "GOAL · 0:27",
  windowTs: 27,
  windowDurationS: 8,
  scoreTransition: { from: "1-1", to: "2-1" },
  matchContext: { sport: "soccer", teams: [{ name: "Real Madrid", side: "home" }] },
  transcript: GOAL_ASR,
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false, goalConfirmed: "confirmed_goal" },
  ...over,
});

/** The stored draft of row `54388ada`, verbatim from the census. */
const DRAFT_9052 =
  "Real Madrid scores to move the scoreboard to 2-1. Manuel Ordoñez finds the back of the net for his team. This scoring play occurs at 0:27 into the clip. Carlos Javier is in the sequence as the scoreboard moves from 1-1 to 2-1 at 0:27.";
const REPEATED_9052 = "This scoring play occurs at 0:27 into the clip.";
/** What the job had already served (row `7ef92cbe`'s clock sentence) — the same
 *  template one clock token over, which is why the clause was dropped. */
const SERVED_9052 = "This scoring play occurs at 0:24 into the clip.";

describe("ADAAAA-9052 — a pruned body that still clears its band keeps its own bytes", () => {
  it("does not substitute anything when the remainder is above the floor", () => {
    const body =
      "Real Madrid scores to move the scoreboard to 2-1 at 0:27 into the clip. Manuel Ordoñez finds the back of the net for his team after Carlos Javier threads the pass through the middle of the pitch. This scoring play occurs at 0:28 into the clip. The scoreboard reflects the change from 1-1 to 2-1 during this sequence.";
    const evidence = goalEvidence();
    const drop = summarySentencesOf(body)[2];
    const pruned = pruneRepeatedSentences(body, [drop], evidence);
    expect(pruned.pruned).toBe(true);
    expect(pruned.substituted).toEqual([]);
    expect(pruned.text).toBe(dropSentences(body, [drop]));
    expect(summaryWordCount(pruned.text)).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
  });

  it("returns the input untouched when nothing is flagged", () => {
    const evidence = goalEvidence();
    const pruned = pruneRepeatedSentences(DRAFT_9052, [], evidence);
    expect(pruned.text).toBe(DRAFT_9052);
    expect(pruned.dropped).toEqual([]);
    expect(pruned.pruned).toBe(true);
  });
});

describe("ADAAAA-9052 — the pruned row is re-grown with a DIFFERENT attested fact", () => {
  const pruned = () => pruneRepeatedSentences(DRAFT_9052, [REPEATED_9052], goalEvidence(), [SERVED_9052]);

  it("reaches the VOD floor instead of dropping the row", () => {
    const before = dropSentences(DRAFT_9052, [REPEATED_9052]);
    // The instrument: the plain clause drop is what lost the row.
    expect(summaryWordCount(before)).toBeLessThan(SUMMARY_VOD_BAND.floorWords);
    const after = pruned();
    expect(after.pruned).toBe(false);
    expect(after.substituted.length).toBeGreaterThan(0);
    expect(summaryWordCount(after.text)).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
    expect(after.text).not.toContain(REPEATED_9052);
  });

  it("serves the repaired body through the gate it just failed", () => {
    const decision = gateSummaryDetail(pruned().text, goalEvidence());
    expect(decision.summary).toBeTruthy();
    expect(decision.violations).toEqual([]);
    expect(decision.words).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
  });

  it("substitutes a sentence that carries a fact the row attests", () => {
    const evidence = goalEvidence();
    const substituted = pruned().substituted;
    expect(substituted.length).toBeGreaterThan(0);
    for (const sentence of substituted) {
      expect(sentenceFactKinds(sentence, evidence).length).toBeGreaterThan(0);
    }
  });

  it("never re-serves a sentence the job already carries, even when it is the only pool entry left", () => {
    const evidence = goalEvidence();
    const forbiddenPool = "The scoreboard moves from 1-1 to 2-1 at 0:27 into the clip.";
    const after = pruneRepeatedSentences(DRAFT_9052, [REPEATED_9052], evidence, [forbiddenPool]);
    expect(after.text).not.toContain(forbiddenPool);
    // The rest of the pool is still admissible, so the body still reaches the floor.
    expect(summaryWordCount(after.text)).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
  });

  it("keeps the substitution count at or below the sentences the draft kept", () => {
    const evidence = goalEvidence();
    const after = pruneRepeatedSentences(DRAFT_9052, [REPEATED_9052], evidence, [SERVED_9052]);
    const survivors = summarySentencesOf(dropSentences(DRAFT_9052, [REPEATED_9052])).length;
    expect(after.substituted.length).toBeLessThanOrEqual(survivors);
  });

  it("is deterministic for the same row and the same forbidden set", () => {
    expect(pruned().text).toBe(pruned().text);
  });
});

describe("ADAAAA-9052 — the repair cannot invent depth", () => {
  it("leaves a row short when every fact it attests is already in the body", () => {
    // Row `8d78c11f` (job `c5dac977`): the window attests the clip clock alone, and
    // its four clock templates are already spent. Nothing else may be phrased.
    const evidence = goalEvidence({
      verdict: "big_play",
      eventType: "BIG_PLAY",
      caption: "BIG PLAY · 1:21",
      postTitle: "BIG PLAY · 1:21",
      windowTs: 81,
      scoreTransition: null,
      matchContext: { sport: "soccer", teams: [] },
      // No transcript and no match context: the row's only attestable fact is the
      // clip clock, and those four templates are already spent in the draft.
      transcript: null,
      attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
    });
    const body =
      "Real Madrid is in the passage at 1:21 into the clip. At 1:21 into the clip, the ball crosses the goal line. The clip carries this sequence at 1:21 into the clip. The window runs at 1:21 into the clip.";
    const repeated = "The clip carries this sequence at 1:21 into the clip.";
    const after = pruneRepeatedSentences(body, [repeated], evidence, [
      "Manuel Ordoñez finds the back of the net for Real Madrid.",
      "This scoring play occurs at 0:24 into the clip.",
      "Carlos Javier is in the passage at 0:24 into the clip.",
      "The clip carries this sequence at 0:24 into the clip.",
    ]);
    // The one clock template the draft had not spent brings it to 38 words, not 40:
    // the repair MUST NOT invent a fact to close the last two words.
    expect(after.pruned).toBe(false);
    expect(summaryWordCount(after.text)).toBeLessThan(SUMMARY_VOD_BAND.floorWords);
    // And the gate refuses it, so the lane drops the row with its named reason.
    const decision = gateSummaryDetail(after.text, evidence);
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("too-few-words");
  });
});

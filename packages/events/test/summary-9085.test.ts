// ADAAAA-9085 — the AC14.5 filler repair may not re-serve a sentence the JOB
// already carries.
//
// Measured `$0` on the rev-13 SERVED VOD job `54537ffa` (20 `highlights` rows,
// rev-13 tree `5421ed9f`): 4 rows landed on `summaryGate = dropped:repeat`, and
// three of them died inside the deterministic repair rather than inside the
// writer's copy. `gateSummaryDetail` deletes filler clauses and then SUBSTITUTES a
// fact sentence from `summaryFactCandidates`, a fixed pool. AC14.3 masks every
// clock token before comparing two sentences (ADAAAA-9031), so one clock template
// is the SAME sentence job-wide: once the first rows served, the pool's clock
// templates were consumed and every later clock-only row was repaired with a
// sentence already on another card (`The clip carries this sequence at 11:48 into
// the clip.` sat at similarity 1.000 against a served body). The lane's repeat key
// then flagged the gate's own repair, the AC14 prune undid it, and the row dropped
// as `repeat` with a PRE-repair decision on it.
//
// The rule this pins: the repair's substitution pool is joint-aware — it may not
// re-break AC14.3 through the repair door — and the pool itself keeps the shape it
// had (one actor phrasing off a name THIS WINDOW measured, plus the three fixed
// templates, every pair under the 0.80 bar). Enlarging the pool with one phrasing
// per attested actor was measured and REJECTED: alternate phrasings of one fact are
// padding (`summary-lane-9052`), and a `matchContext` team named in the body credits
// the `action` kind body-wide, which launders a fact-poor body past `too-few-facts`
// (`highlight-summary-8735`).
import { describe, expect, it } from "vitest";
import {
  closestSentencePair,
  dropFillerSentences,
  gateSummaryDetail,
  sentenceFactKinds,
  summaryFactCandidates,
  summarySentencesOf,
  summaryWordCount,
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
  SUMMARY_VOD_BAND,
  type SummaryEvidence,
} from "@highlights/events";

/** A rev-13 VOD row: the clip offset is its clock, and the window's own transcript
 *  names the attested actor (the second fact kind a VOD body needs). */
const clockEvidence = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "vod",
  verdict: null,
  eventType: "GOAL",
  reason: "The frame dive confirmed the goal.",
  caption: null,
  postTitle: "GOAL · 11:48",
  windowTs: 708,
  windowDurationS: 9,
  scoreTransition: null,
  matchContext: {
    sport: "soccer",
    teams: [
      { name: "Real Madrid", side: "home" },
      { name: "Barcelona", side: "away" },
    ],
  },
  transcript: "David Saez drives forward on the left, el remate de David Saez, sigue David Saez en la banda.",
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false, goalConfirmed: "confirmed_goal" },
  ...over,
});

/** The stored draft of rev-13 row `3b8ff4f5`: two factless clauses an honest gate
 *  deletes, and only ~24 words of fact-bearing copy left — so the repair MUST
 *  substitute to reach the 40-word VOD floor. */
const DRAFT_9085 =
  "Real Madrid faces a high-pressure situation during the Antutu Penalty. David Saez drives forward and takes a shot at 11:48 into the clip. David Saez then completes a pass to set up the next sequence. The match features a tense standoff between Real Madrid and Barcelona.";

/** What the job had already served: the templates the pool used to re-insert. */
const SERVED_SENTENCES_9085 = [
  "The ball crosses the goal line into the net at 1:57 into the clip.",
  "David Saez completes a pass to set up the scoring opportunity.",
  "Yojo is in the passage at 1:57 into the clip.",
  "The clip carries this sequence at 11:48 into the clip.",
  "Real Madrid is in the passage at 10:36 into the clip.",
  "This passage sits at 10:48 of the clip.",
  "The window runs at 10:48 into the clip.",
];

const maxSimilarityTo = (body: string, others: readonly string[]): number => {
  let max = 0;
  for (const sentence of summarySentencesOf(body)) {
    for (const other of others) {
      const pair = closestSentencePair([sentence, other]);
      if (pair && pair.similarity > max) max = pair.similarity;
    }
  }
  return max;
};

describe("ADAAAA-9085 — the AC14.5 repair may not re-serve a sentence the job already carries", () => {
  it("substitutes only a sentence the job does not already carry", () => {
    const evidence = clockEvidence();
    // Instrument: without the joint bar the repair reaches a pool template the job
    // already serves — the insert that re-broke AC14.3 on the served build.
    const blind = dropFillerSentences(DRAFT_9085, evidence);
    expect(blind.substituted.length).toBeGreaterThan(0);
    expect(maxSimilarityTo(blind.substituted.join(" "), SERVED_SENTENCES_9085)).toBeGreaterThanOrEqual(
      SUMMARY_SENTENCE_REPEAT_THRESHOLD
    );

    // With the bar, every inserted sentence is clear of the job's served copy, and
    // the first sentence the repair may use is the one phrased off this window's own
    // actor — a name no other card has.
    const joint = dropFillerSentences(DRAFT_9085, evidence, SERVED_SENTENCES_9085);
    expect(joint.substituted.length).toBeGreaterThan(0);
    expect(maxSimilarityTo(joint.substituted.join(" "), SERVED_SENTENCES_9085)).toBeLessThan(
      SUMMARY_SENTENCE_REPEAT_THRESHOLD
    );
    expect(joint.text).toContain("David Saez is in the passage at 11:48 into the clip.");
    // A row whose evidence offers ONE admissible sentence stays short here (the
    // rev-13 residual class): the repair may not pad it to the floor with a second
    // restatement of the same fact, and the gate then refuses it by name.
    expect(summaryWordCount(joint.text)).toBeLessThan(SUMMARY_VOD_BAND.floorWords);
  });

  it("refuses by name instead of padding when no admissible sentence exists", () => {
    const evidence = clockEvidence();
    // Every candidate the row can phrase is already on another card: the honest
    // outcome is a short body refused on its depth, never a re-served template.
    const pool = summaryFactCandidates(evidence).map((candidate) => candidate.sentence);
    const everything = [...SERVED_SENTENCES_9085, ...pool];
    const gated = gateSummaryDetail(DRAFT_9085, evidence, { avoidSentences: everything });
    expect(gated.summary).toBeNull();
    expect(gated.violations).toContain("too-few-words");
    expect(gated.repairedWords).toBeLessThan(SUMMARY_VOD_BAND.floorWords);
  });

  it("keeps the draft's own bytes when the repair is not needed", () => {
    const evidence = clockEvidence();
    const long =
      "David Saez drives forward and takes a shot at 11:48 into the clip. David Saez completes a pass to set up the next sequence at 11:48 into the clip. David Saez is in the passage at 11:50 into the clip. The sequence closes with a clearance at 11:52 into the clip.";
    const gated = gateSummaryDetail(long, evidence, { avoidSentences: SERVED_SENTENCES_9085 });
    expect(gated.summary).toBe(long);
    expect(gated.substitutedClauses).toEqual([]);
  });
});

describe("ADAAAA-9085 — the substitution pool keeps its shape", () => {
  it("phrases the clock off the window's own actor and the three fixed templates", () => {
    const evidence = clockEvidence();
    const clockSentences = summaryFactCandidates(evidence)
      .filter((candidate) => candidate.kinds.includes("clock"))
      .map((candidate) => candidate.sentence);
    expect(clockSentences).toContain("David Saez is in the passage at 11:48 into the clip.");
    expect(clockSentences).toContain("The clip carries this sequence at 11:48 into the clip.");
    expect(clockSentences).toContain("This passage sits at 11:48 of the clip.");
    expect(clockSentences).toContain("The window runs at 11:48 into the clip.");
    // No per-team phrasing: a `matchContext` team named in the body credits the
    // `action` kind body-wide (`highlight-summary-8735`).
    expect(clockSentences.some((sentence) => sentence.includes("Real Madrid"))).toBe(false);
    expect(clockSentences.some((sentence) => sentence.includes("Barcelona"))).toBe(false);
    // One phrasing per fact, never a second syntax of the same one.
    expect(clockSentences.filter((sentence) => sentence.includes("David Saez")).length).toBe(1);
  });

  it("keeps every pair of the pool under the AC14.3 bar", () => {
    const candidates = summaryFactCandidates(clockEvidence());
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const pair = closestSentencePair([candidates[i].sentence, candidates[j].sentence]);
        expect(pair?.similarity ?? 0).toBeLessThan(SUMMARY_SENTENCE_REPEAT_THRESHOLD);
      }
    }
  });

  it("still credits the clock fact on every phrasing", () => {
    const evidence = clockEvidence();
    for (const candidate of summaryFactCandidates(evidence)) {
      expect(sentenceFactKinds(candidate.sentence, evidence).length).toBeGreaterThan(0);
    }
  });
});

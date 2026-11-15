// ADAAAA-9089 — the WRITER lever for the residual repeat class.
//
// Measured `$0` on the rev-13 served VOD job `54537ffa` (job `54537ffa`, rev-13
// tree `5421ed9f`, 20 rows): the 4 rows that landed on `summaryGate =
// dropped:repeat` each re-emitted a sentence another card in the job already
// carries, with the clock swapped. AC14.3 masks clock tokens (ADAAAA-9031), so a
// clock swap is the SAME sentence:
//
//   row        draft sentence                                     served copy it duplicates
//   c1a78055   This scoring sequence occurs at 11:15 … as the ball  e9b8e239 at 5:42
//              crosses the line.
//   b45fc105   This scoring sequence occurs at 12:00 …             e9b8e239 at 5:42
//   3b8ff4f5   <actor> is in the passage at 11:48 …                26c33a12 at 10:36
//   369ff147   The ball crosses the goal line into the net at       dc4c869f at 1:57
//              10:57 …
//
// The lane side is joint-aware (ADAAAA-9085) and refuses to pad
// (`summary-lane-9052`), so it cannot manufacture a distinct body from a clock +
// one-actor evidence set. The lever has to be the prompt. Measured on the SAME
// stored evidence at `$0` (tools/probe9089.ts):
//
//   - before: the first pass stated 2 of the job's 7 shared frame shapes. The two
//     the writer actually re-emitted — `This scoring sequence occurs at …` and
//     `<actor> is in the passage at …` — were stated only as instances of a rule
//     about WHEN-only sentences, and the writer escaped that rule by bolting a
//     clause onto the frame (`… as the ball crosses the line`). The retry named the
//     repeated sentence and said "do not swap only their clock"; the model swapped
//     only the clock anyway.
//   - after: the first pass and the retry both state the shapes as SHAPES (offsets
//     stay `…`, so no banned sentence is rendered filled-in for AC14 to copy),
//     every sentence's SUBJECT has to be an attested actor with the offset riding
//     on that actor's act, and the served-sentence list is framed as shapes to
//     avoid rather than sentences to edit.
//   - achievability (`$0`): a body written the way the new rule says serves on all
//     four rows' real evidence — 41-51 words, no violations, closest sentence
//     against the prior served set 0.41-0.54 (< 0.80). The instruction is winnable
//     on the evidence these rows actually have, which is what the lane-side repair
//     could not be.
//
// This is a PROMPT change, so it must not spend a third call: the retry slot stays
// at `SUMMARY_CALLS_PER_ROW = 2` (the ticket's explicit constraint).
import { describe, expect, it } from "vitest";
import {
  SUMMARY_MAX_CALLS_PER_ROW,
  SUMMARY_VOD_BAND,
  buildSummaryPrompt,
  gateSummaryDetail,
  summarySentencesOf,
  summaryWordCount,
  type SummaryEvidence,
  type SummaryRetryDirective,
} from "@highlights/events";

/** A rev-13 VOD row: the clip offset is its clock and the window's own transcript
 *  names the attested actor — the two fact kinds these four rows carry, and nothing
 *  else (`tools/probe9089.ts` reads `kinds: ["clock","action"]` on all four). */
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

/** The job's served sentences, as the lane hands them over on the first pass. */
const SERVED_9089 = [
  "The clip carries this sequence at 1:57 into the clip.",
  "Yojo is in the passage at 1:57 into the clip.",
  "This scoring sequence occurs at 5:42 into the clip as the ball crosses the line.",
  "This passage sits at 10:00 of the clip.",
  "The window runs at 10:00 into the clip.",
];

const RETRY_9089: SummaryRetryDirective = {
  words: 41,
  sentences: 3,
  violations: [],
  repeatedSentences: ["This scoring sequence occurs at 1:57 into the clip."],
};

/** The shapes the ticket names, plus the three the same job also serves. Every one
 *  is a template another card carries, so the prompt states all of them. */
const TICKET_SHAPES = [
  "The clip carries this sequence at",
  "This passage sits at",
  "The window runs at",
  "This scoring sequence occurs at",
];
const OTHER_SHAPES = ["This scoring play occurs at", "X is in the passage at", "The ball crosses the goal line into the net at"];

/** A `m:ss` stamp rendered INSIDE a stated shape: the one thing AC14 can copy and
 *  serve verbatim, so the shapes are stated with `…` slots only. */
const clockInside = (prompt: string, shape: string): string | null => {
  const at = prompt.indexOf(shape);
  if (at < 0) return null;
  const tail = prompt.slice(at + shape.length, at + shape.length + 24);
  return /\b\d{1,3}:\d{2}\b/.exec(tail)?.[0] ?? null;
};

const FRAME_SHAPE_RE =
  /\bthe clip carries (this|the) sequence\b|\bthis passage sits at\b|\bthe window runs at\b|\bthis scoring sequence occurs at\b|\bthis scoring play occurs at\b|\bis in the passage at\b|\bis in the sequence as\b|\bthe ball crosses the goal line into the net at\b/i;

describe("ADAAAA-9089 — the first pass states the shared frame shapes as SHAPES", () => {
  const prompt = buildSummaryPrompt({ ...clockEvidence(), avoidSentences: SERVED_9089 });

  it("bans every shape the ticket names, on the FIRST pass", () => {
    for (const shape of TICKET_SHAPES) expect(prompt).toContain(shape);
    expect(prompt).toContain("BANNED FRAME SHAPES");
  });

  it("also bans the actor and ball shapes the same job re-emitted", () => {
    for (const shape of OTHER_SHAPES) expect(prompt).toContain(shape);
  });

  it("never renders a banned shape with a clock filled in (AC14 copies a filled sentence)", () => {
    for (const shape of [...TICKET_SHAPES, ...OTHER_SHAPES]) {
      expect(clockInside(prompt, shape)).toBeNull();
    }
  });

  it("says the ban survives a swapped clock, a swapped actor or an appended clause", () => {
    expect(prompt).toContain("Swapping the clock, swapping the actor or appending 'as the ball crosses the line'");
    expect(prompt).toContain("does NOT make it a new sentence");
  });

  it("keeps the WHEN-only rule it extends (it is not a replacement)", () => {
    expect(prompt).toContain("Never spend a whole sentence on the clip clock");
  });
});

describe("ADAAAA-9089 — the actor rule is per SENTENCE, not per body", () => {
  const prompt = buildSummaryPrompt({ ...clockEvidence(), avoidSentences: SERVED_9089 });

  it("requires every sentence to carry an attested actor as its subject", () => {
    expect(prompt).toContain("EVERY sentence must name one of them as its SUBJECT");
    expect(prompt).toContain("every sentence needs its own actor and its own fact about that actor");
  });

  it("forbids the cross-card collapse: the same actor-and-act sentence with only the clock changed", () => {
    expect(prompt).toContain("never write the same actor-and-act sentence you would write on another card with only the clock changed");
    expect(prompt).toContain("two cards that differ only by their clock carry the same sentence");
  });

  it("overrides 'A name is optional' when the row attests actors", () => {
    expect(prompt).toContain("A name is optional");
    expect(prompt).toContain("a name is NOT optional on this row");
  });

  it("puts the clip offset on the act, so each sentence carries its own clock", () => {
    expect(prompt).toContain("with the clip offset riding on that act");
    expect(prompt).toContain("X drives forward at … into the clip");
  });

  it("does not claim the rule on a row that attests nobody", () => {
    const lonely = buildSummaryPrompt({
      ...clockEvidence({ transcript: "gol gol gol", matchContext: null }),
      avoidSentences: SERVED_9089,
    });
    expect(lonely).not.toContain("EVERY sentence must name one of them as its SUBJECT");
  });
});

describe("ADAAAA-9089 — the RETRY says what the replacement has to BE", () => {
  const prompt = buildSummaryPrompt({
    ...clockEvidence(),
    avoidSentences: SERVED_9089,
    retry: RETRY_9089,
  });

  it("still names the repeated sentence (ADAAAA-9052)", () => {
    expect(prompt).toContain("REPEAT a sentence a card in this job already carries");
    expect(prompt).toContain("This scoring sequence occurs at 1:57 into the clip.");
  });

  it("states the shapes on the retry too, so the regenerated sentence has a target", () => {
    for (const shape of TICKET_SHAPES) expect(prompt).toContain(shape);
  });

  it("asks for an actor SUBJECT on every replacement sentence", () => {
    expect(prompt).toContain("Each replacement sentence must name an attested actor as its SUBJECT");
  });

  it("names the frame as the thing being refused, not only the clock swap", () => {
    expect(prompt).toContain("A frame sentence shape ('The clip carries this sequence at …', 'This scoring sequence occurs at …')");
  });
});

describe("ADAAAA-9089 — the served-sentence list is shapes to avoid, not sentences to edit", () => {
  const prompt = buildSummaryPrompt({ ...clockEvidence(), avoidSentences: SERVED_9089 });

  it("keeps the ADAAAA-8914 list and its prompt-first rule", () => {
    expect(prompt).toContain("Do not reuse a sentence already served on another card in this job");
    expect(prompt).toContain("The clip carries this sequence at 1:57 into the clip.");
  });

  it("says a clock/actor/trailing-clause edit still serves the same sentence", () => {
    expect(prompt).toContain("These are shapes to avoid, not sentences to edit");
    expect(prompt).toContain("changing the clock, the actor name or a trailing clause inside one of them still serves the same sentence");
  });
});

describe("ADAAAA-9089 — it is a prompt change, not a third call", () => {
  it("keeps the retry slot at two calls per row", () => {
    expect(SUMMARY_MAX_CALLS_PER_ROW).toBe(2);
  });
});

describe("ADAAAA-9089 — the instruction is WINNABLE on the evidence these rows have", () => {
  /** Written the way the new prompt says to write: the sentence's subject is an
   *  attested actor, the predicate is a bounded act, the clip offset rides on the
   *  act. No frame shape, no atmosphere, no invented fact. */
  const BODY = [
    "David Saez drives forward and wins the ball back at 11:48 into the clip.",
    "Real Madrid completes a pass to move the play forward at 11:48 into the clip.",
    "David Saez tackles and recovers the ball as the sequence closes at 11:48 into the clip.",
  ].join(" ");

  it("clears the VOD floor and the gate on a clock + one-actor row", () => {
    const evidence = clockEvidence();
    const decision = gateSummaryDetail(BODY, evidence);
    expect(decision.violations).toEqual([]);
    expect(decision.summary).not.toBeNull();
    expect(decision.words).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
    expect(decision.sentences).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.minSentences);
    expect(summaryWordCount(BODY)).toBeGreaterThanOrEqual(40);
  });

  it("carries no shared frame shape, and no sentence is a clock-only sentence", () => {
    for (const sentence of summarySentencesOf(BODY)) expect(sentence).not.toMatch(FRAME_SHAPE_RE);
  });

  it("is what the prompt asks for: three sentences, three actors' acts, one offset each", () => {
    const sentences = summarySentencesOf(BODY);
    expect(sentences).toHaveLength(3);
    for (const sentence of sentences) {
      expect(sentence).toMatch(/^[A-Z][^.]* at 11:48 into the clip\.$/);
      expect(sentence).toMatch(/\b(Real Madrid|David Saez)\b/);
    }
  });
});

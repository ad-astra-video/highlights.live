// ADAAAA-9177 (rev-20, writer round 4) — the summary prompt's avoid block now
// carries the served cards' OPENINGS with the rule stated plainly, and
// `summarySpentOpenings` is the one derivation of that list.
//
// Measured on the rev-19 served block (job `798f21c2`): `0901bd41` served the
// opening `portugal dispossesses the ball` and the next three cards all opened on
// that same actor+act. `avoidActs` (ADAAAA-9121) carried the PAIR, but AC8 refuses
// the OPENING, and the prompt never said that sentence 1 is what is compared.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_OPENING_RUN_WORDS,
  buildSummaryPrompt,
  summaryOpeningRun,
  summarySpentOpenings,
  type SummaryEvidence,
} from "@highlights/events";

const live = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "live",
  verdict: "big_play",
  eventType: "BIG_PLAY",
  reason: "Ball shoots in midfield",
  caption: null,
  postTitle: "BIG PLAY · 0:12",
  windowTs: 12,
  windowDurationS: 15,
  matchContext: {
    sport: "soccer",
    teams: [
      { name: "Portugal", side: "away" },
      { name: "Barcelona", side: "away" },
      { name: "Real Madrid", side: "home" },
    ],
  },
  matchClock: { token: "22:13", seconds: 1333, legible: true },
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
  ...over,
});

const SERVED_OPENING = "portugal dispossesses the ball";

describe("ADAAAA-9177 — summarySpentOpenings is the opening list the prompt carries", () => {
  it("takes the masked 4-word run and keeps served order", () => {
    const openings = summarySpentOpenings([
      "Barcelona wins the ball back at 04:38 of the match. Real Madrid then attempts a counter.",
      "Portugal dispossesses the ball at 22:13 of the match. Barcelona then crosses the ball.",
    ]);
    expect(openings).toEqual(["barcelona wins the ball", SERVED_OPENING]);
  });

  it("masks a LEADING clock so the same opening with the clock moved is one entry", () => {
    // The AC8 reader strips a leading clock prefix before taking the run, so these
    // two bodies are the SAME opening to the gate and must collapse here.
    const openings = summarySpentOpenings([
      "At 22:13, Portugal dispossesses the ball and turns the passage into a counter.",
      "Portugal dispossesses the ball at 11:10 into the clip. The scoreboard moves from 2-2 to 2-3.",
    ]);
    expect(openings).toEqual([SERVED_OPENING]);
    expect(summaryOpeningRun("At 22:13, Portugal dispossesses the ball and turns the passage.")).toBe(
      SERVED_OPENING
    );
  });

  it("is empty for an empty body, so the first card of a job carries no line", () => {
    expect(summarySpentOpenings([])).toEqual([]);
    expect(summarySpentOpenings(["", "  "])).toEqual([]);
  });
});

describe("ADAAAA-9177 — the prompt names the FIRST sentence's opening as the compared thing", () => {
  it("renders the served runs and states the rule in words", () => {
    const prompt = buildSummaryPrompt({ ...live(), avoidOpenings: [SERVED_OPENING] });
    // The ADAAAA-8914/9120 line survives verbatim (the prompt-first ask).
    expect(prompt).toContain(`Do not open with any of these already-served runs: '${SERVED_OPENING}'`);
    // ADAAAA-9177: and it now says WHAT is compared, so the list cannot read as
    // vocabulary to avoid anywhere in the body.
    expect(prompt).toContain("These are the OPENINGS of sentence 1 on cards this job already serves");
    expect(prompt).toContain(`it takes your body's first ${SUMMARY_OPENING_RUN_WORDS} words after any leading clock`);
    expect(prompt).toContain("not one of these runs with the clock moved");
  });

  it("keeps the opening list off the first card of a job", () => {
    const prompt = buildSummaryPrompt({ ...live() });
    expect(prompt).not.toContain("already-served runs");
    expect(prompt).not.toContain("These are the OPENINGS of sentence 1");
  });

  it("carries the openings beside the spent pairs, both lists as given", () => {
    const prompt = buildSummaryPrompt({
      ...live(),
      avoidOpenings: [SERVED_OPENING, "barcelona wins the ball"],
      avoidActs: ["Portugal + dispossesses", "Barcelona + wins the ball back"],
    });
    expect(prompt).toContain(`'${SERVED_OPENING}', 'barcelona wins the ball'`);
    expect(prompt).toContain("This job's served cards already spend these actor-and-act pairs: Portugal + dispossesses; Barcelona + wins the ball back.");
  });

  it("truncates at the same 8 runs the lane persists, so the row equals the prompt", () => {
    const many = Array.from({ length: 11 }, (_, i) => `served opening number ${i}`);
    const prompt = buildSummaryPrompt({ ...live(), avoidOpenings: many });
    expect(prompt).toContain("'served opening number 7'");
    expect(prompt).not.toContain("'served opening number 8'");
  });
});

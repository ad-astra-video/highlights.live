// ADAAAA-8735 (spec ADAAAA-8665 rev 4): the two defects QA-F2 measured on the
// rev-3 served build (`3aab6111`), pinned as falsifiers that run RED on that
// build:
//
//  AC8 — the opening run kept a leading clock. On job `9891ff33` six of the ten
//        served bodies opened `At <m:ss>, …`, so the as-built 4-word scan found
//        0 duplicate pairs while a clock-stripped scan finds 18.
//  AC9 — `action` was credited off the sentence-initial capital of the common
//        noun `Ball` and off the evidence renderer's own `Teams:` label, so
//        every served body earned `clock + action` while naming no team/player.
//
// The corpus below is the stored `highlights.summary` of job
// `9891ff33-f6c2-4dad-bcaa-738a12e998e8` (id shortened), read at $0.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_MIN_FACT_KINDS,
  attestedEntityNames,
  attestedFactKinds,
  attestedSummaryFactKinds,
  buildSummaryPrompt,
  gateSummaryDetail,
  summaryOpeningRun,
  summaryWords,
  type SummaryEvidence,
} from "../src/highlight-summary.js";

/** The ten bodies rev 3 SERVED on `9891ff33` (order = window start). */
const SERVED_9891FF33: { id: string; body: string }[] = [
  { id: "1d1a0be5", body: "The ball shoots in midfield at 1:23. This action occurs during the opening minutes of the match as the play develops in the center of the field." },
  { id: "9e1e7e2c", body: "The ball shoots on the right at 2:13. This action occurs during the match as the play develops across the field. The movement follows a sequence of play leading to this specific shot." },
  { id: "0eddffe9", body: "The shot finds the back of the net after a shot directed toward the right side of the goal. This scoring play occurs at the 2:18 mark of the match." },
  { id: "a0f9f311", body: "At 2:53, the ball shoots on the left side of the field. This action occurs during the ongoing match as the play develops toward the wing." },
  { id: "be041aaf", body: "At 3:23, the ball shoots on the right side of the field. This action occurs during the match as the play develops toward the wing." },
  { id: "8b444000", body: "At 3:57, the ball shoots on the right side of the field. This action occurs during the match as the play develops toward the wing." },
  { id: "1b58f14f", body: "At 6:48, the ball shoots in midfield during the match. This action occurs as the play develops across the center of the field." },
  { id: "775498b5", body: "At 8:02, the ball shoots on the left side of the field. This action occurs during the match as the play develops toward the wing." },
  { id: "6e88503d", body: "At 8:24, the ball shoots in midfield during the match. This action occurs as the play develops across the pitch, moving the ball forward into the center of the field." },
  { id: "5c50473d", body: "At 10:07, the ball shoots on the left side of the field. This action occurs during the match as the play develops toward the wing." },
];

/** The rev-3 implementation of the run: no clock strip. Kept in the test so the
 *  0-pair-vs-18-pair contrast is measured, not remembered. */
const asBuiltOpeningRun = (text: string): string => summaryWords(text).slice(0, 4).join(" ");

/** Count unordered pairs that share an opening. */
const duplicatePairs = (openings: string[]): number => {
  const counts = new Map<string, number>();
  for (const opening of openings) counts.set(opening, (counts.get(opening) ?? 0) + 1);
  let pairs = 0;
  for (const count of counts.values()) pairs += (count * (count - 1)) / 2;
  return pairs;
};

const jaccard = (a: string, b: string): number => {
  const left = new Set(summaryWords(a));
  const right = new Set(summaryWords(b));
  const shared = [...left].filter((w) => right.has(w)).length;
  return shared / (left.size + right.size - shared);
};

/** The live rail of `9891ff33`: browser job, NO persisted matchContext, no
 *  transcript. Every stored row's evidence is the gated reason plus the window
 *  anchor — that is the whole point of the defect. */
const liveNoNames = (extra: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "live",
  verdict: "big_play",
  eventType: "BIG_PLAY",
  reason: "Ball shoots on the left.",
  caption: "Ball shoots on the left.",
  postTitle: null,
  windowTs: 173,
  windowDurationS: 8,
  scoreTransition: null,
  matchContext: null,
  transcript: null,
  ...extra,
});

/** A row whose matchContext names a team, and whose body names it. */
const teamContext = (extra: Partial<SummaryEvidence> = {}): SummaryEvidence =>
  liveNoNames({
    reason: "Ball shoots on the right.",
    caption: "Ball shoots on the right.",
    windowTs: 203,
    matchContext: { teams: [{ name: "Northbridge" }, { name: "Riverside" }] },
    transcript: "",
    ...extra,
  });

const TICKET_BODY =
  "At 2:53, the ball shoots on the left side of the field. This action occurs during the match as the play develops toward the wing.";
const DECISIVE_A =
  "At 3:23, the ball shoots on the right side of the field. This action occurs during the match as the play develops toward the wing.";
const DECISIVE_B =
  "At 3:57, the ball shoots on the right side of the field. This action occurs during the match as the play develops toward the wing.";

describe("AC8 — a leading clock is not part of an opening (rev 4)", () => {
  it("collides the decisive pair that differed only by the clock", () => {
    expect(asBuiltOpeningRun(DECISIVE_A)).toBe("at 3 23 the");
    expect(asBuiltOpeningRun(DECISIVE_B)).toBe("at 3 57 the");
    expect(summaryOpeningRun(DECISIVE_A)).toBe("the ball shoots on");
    expect(summaryOpeningRun(DECISIVE_B)).toBe("the ball shoots on");
    // QA-F2's measured pair: Jaccard 0.9091, identical prose, clock only.
    expect(jaccard(DECISIVE_A, DECISIVE_B)).toBeCloseTo(0.9091, 4);
  });

  it("strips every leading clock shape and leaves prose-only openings alone", () => {
    expect(summaryOpeningRun("At 0:12 the move develops through midfield.")).toBe("the move develops through");
    expect(summaryOpeningRun("at the 2:53 mark, the ball shoots on the left.")).toBe("the ball shoots on");
    expect(summaryOpeningRun("3:57 the ball shoots on the right.")).toBe("the ball shoots on");
    expect(summaryOpeningRun("T+3:23 — the ball shoots on the right.")).toBe("the ball shoots on");
    expect(summaryOpeningRun("The midfielder drives forward with the ball.")).toBe("the midfielder drives forward");
    expect(summaryOpeningRun("A low drive from the edge of the box levels it.")).toBe("a low drive from");
  });

  it("does not treat a clock in the MIDDLE of a body as an opening", () => {
    expect(summaryOpeningRun("The ball shoots in midfield at 1:23.")).toBe("the ball shoots in");
    expect(summaryOpeningRun("The shot finds the back at 2:18.")).toBe("the shot finds the");
  });

  it("collapses the job's served corpus from 0 to 18 duplicate pairs", () => {
    const bodies = SERVED_9891FF33.map((row) => row.body);
    expect(duplicatePairs(bodies.map(asBuiltOpeningRun))).toBe(0);
    const fixed = bodies.map((body) => summaryOpeningRun(body));
    expect(duplicatePairs(fixed)).toBe(18);
    // The two collision groups QA-F2 named, plus the third body that joins them.
    expect(fixed.filter((o) => o === "the ball shoots on")).toHaveLength(6);
    expect(fixed.filter((o) => o === "the ball shoots in")).toHaveLength(3);
    // The closest pair is the decisive one: above the ~0.85 Jaccard bar the
    // lane regenerates/drops on.
    const worst = Math.max(
      ...SERVED_9891FF33.flatMap((a, i) =>
        SERVED_9891FF33.slice(i + 1)
          .filter((b) => summaryOpeningRun(a.body) === summaryOpeningRun(b.body))
          .map((b) => jaccard(a.body, b.body))
      )
    );
    expect(worst).toBeCloseTo(0.9091, 4);
  });
});

describe("AC9 — action is credited only off an attested actor (rev 4)", () => {
  it("does not read the sentence-initial capital of a common noun as an entity", () => {
    expect(attestedEntityNames("Ball shoots on the left.")).toEqual([]);
    expect(attestedEntityNames("The ball shoots on the right.\nCrowd erupts.")).toEqual([]);
  });

  it("does not read the evidence renderer's own key label as an entity", () => {
    expect(attestedEntityNames("Teams: Barcelona\nBall")).toEqual(["Barcelona"]);
    expect(attestedEntityNames("Teams: Northbridge vs Riverside\nBall shoots.")).toEqual([
      "Northbridge",
      "Riverside",
    ]);
    expect(attestedEntityNames("Players: J. Smith\nCompetition: Champions League")).toEqual([
      "J. Smith",
      "Champions League",
    ]);
  });

  it("offers the clock and NOT action when the row attests no actor", () => {
    const evidence = liveNoNames();
    expect(attestedFactKinds(evidence)).toEqual(["clock"]);
    expect(attestedFactKinds(evidence)).not.toContain("action");
  });

  it("refuses the ticket's clock-plus-bare-verb body as too-few-facts", () => {
    const evidence = liveNoNames({ windowTs: 173 });
    expect(attestedSummaryFactKinds(TICKET_BODY, evidence)).toEqual(["clock"]);
    expect(attestedSummaryFactKinds(TICKET_BODY, evidence).length).toBeLessThan(SUMMARY_MIN_FACT_KINDS);
    const decision = gateSummaryDetail(TICKET_BODY, evidence);
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("too-few-facts");
  });

  it("credits action when the body NAMES a matchContext team", () => {
    const evidence = teamContext();
    const body =
      "At 3:23, Northbridge shoot on the right side of the field. This action occurs during the match as the play develops toward the wing.";
    expect(attestedFactKinds(evidence)).toEqual(["clock", "action"]);
    expect(attestedSummaryFactKinds(body, evidence)).toEqual(["clock", "action"]);
    expect(gateSummaryDetail(body, evidence).summary).toBe(body);
  });

  it("does NOT credit action when the body names nobody, even though the context does", () => {
    const evidence = teamContext();
    // Same clock, same verb, but the actor is the sport's common noun again.
    expect(attestedSummaryFactKinds(TICKET_BODY, evidence)).toEqual(["clock"]);
    expect(gateSummaryDetail(TICKET_BODY, evidence).violations).toContain("too-few-facts");
  });

  it("credits a name the ASR transcript carries, and not the common noun in it", () => {
    const fromTranscript = teamContext({
      transcript: "Barcelona push forward and the crowd rises",
      matchContext: null,
    });
    expect(attestedFactKinds(fromTranscript)).toContain("action");
    const body =
      "At 3:23, Barcelona shoot on the right side of the field. This action occurs during the match as the play develops toward the wing.";
    expect(attestedSummaryFactKinds(body, fromTranscript)).toEqual(["clock", "action"]);

    const noNames = teamContext({ transcript: "Ball shoots on the left", matchContext: null });
    expect(attestedFactKinds(noNames)).toEqual(["clock"]);
  });

  it("keeps the clock-only refusal, which already worked on rev 3", () => {
    const body =
      "The move develops at 3:20 in the second half. The crowd keeps its shape through the next few passes.";
    const decision = gateSummaryDetail(body, liveNoNames({ windowTs: 200, transcript: "" }));
    expect(decision.violations).toContain("too-few-facts");
    expect(decision.summary).toBeNull();
  });

  it("asks the prompt for a named attested actor, not a bare verb", () => {
    const prompt = buildSummaryPrompt({ ...teamContext(), postTitle: null });
    expect(prompt).toContain("An action fact counts ONLY when you NAME an attested team or player from the evidence");
    expect(prompt).toContain("a bare verb with no named actor is not a fact");
    expect(prompt).toContain("an attested team's or player's action");
  });
});

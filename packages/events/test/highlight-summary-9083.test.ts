// ADAAAA-9083 — AC15: no frame narration on the summary body's lead, both rails.
//
// The defect (board read of the served VOD rail, ADAAAA-8665 comment `96560fed`,
// 2026-11-15T14:27:41Z): every Video Summary body opened on a frame-narration
// formula ("The scene opens …"). The caption channel already banned it; the
// summary channel never did, and the AC14 per-sentence vocabulary (atmosphere /
// reaction / value filler) does not match a frame noun, so such a body carried an
// attested name, earned an AC9 fact and survived.
//
// The pins here are the three halves of the contract:
//   1. the closed AC1 list — every banned opener is stripped (or its lead deleted),
//      by DELETION only, and a concrete factual opening is untouched;
//   2. the write seam — a frame-lead body serves exactly the body it would serve
//      without the lead, on both rails, and never serves a frame opener;
//   3. the backstop — `summaryViolations` still reports `frame-opener` on a shape
//      the strip cannot reach, and the prompt bans it prompt-first on both rails.
import { describe, expect, it } from "vitest";
import {
  buildSummaryPrompt,
  gateSummaryDetail,
  hasFrameOpener,
  stripFrameOpener,
  summaryViolations,
  SUMMARY_VOD_BAND,
  type SummaryEvidence,
} from "@highlights/events";

const GOAL_ASR =
  "Es Carlos Javier quien la pisa, Carlos Javier quien intenta progresar por la banda izquierda, sigue Carlos Javier, el centro para Ordoñez, el remate gol. Acaba de marcar el Real Madrid, acaba de marcar Manuel Ordoñez, Manu, en el minuto.";

const vodEvidence = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
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
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false, goalConfirmed: "confirmed_goal" },
  ...over,
});

/** A fact-dense VOD body the gate SERVES on its own (53 words). ADAAAA-9464 took
 *  it from 43 to 53 by carrying the finish and the closing passage inside the
 *  scoreboard sentences: the VOD serve bar is the band TARGET (45), not the 40-word
 *  floor this fixture was written against. */
const CONCRETE_VOD =
  "Manuel Ordoñez finishes the move at 0:24 into the clip after a scramble in the box. The scoreboard moves from 1-1 to 2-1 at 0:24 into the clip on the Manuel Ordoñez finish. Real Madrid carry the 2-1 scoreboard at 0:24 into the clip as the passage closes out wide. The scoreboard change lands on a Manuel Ordoñez finish at 0:24.";

/** The AC1 closed list: one opener per named shape. */
const CLOSED_LIST_OPENERS = [
  "The scene opens with",
  "The scene begins on",
  "The scene shows",
  "The clip opens with",
  "The video begins with",
  "The footage starts with",
  "The sequence shows",
  "The broadcast cuts to",
  "The window opens on",
  "The clip shows us",
  "In this clip,",
  "In this segment,",
  "In this window,",
  "In this footage,",
  "In this video,",
  "We see",
  "Here we see",
  "The camera follows",
  "This clip opens with",
  "This sequence begins with",
];

/** Every word of `after` is a word of `before` — the strip DELETES, never adds. */
function tokens(word: string): string[] {
  return (word.toLowerCase().match(/[a-zà-ÿ0-9:']+/g) ?? []).filter(Boolean);
}

describe("ADAAAA-9083 (AC15) — the closed opener list is stripped by deletion", () => {
  it.each(CLOSED_LIST_OPENERS)("strips '%s' and keeps the content", (opener) => {
    const body = `${opener} Manuel Ordoñez finishes at 0:24 into the clip.`;
    const strip = stripFrameOpener(body);
    expect(strip.stripped.length).toBeGreaterThan(0);
    expect(strip.text).not.toMatch(/^(?:the scene|the clip|the video|the footage|the sequence|the broadcast|the window|in this|we see|here we see|the camera|this clip|this sequence)/i);
    expect(hasFrameOpener(strip.text)).toBe(false);
    // The concrete content survives: the name, the clock and the act.
    expect(strip.text).toContain("Manuel Ordoñez");
    expect(strip.text).toContain("0:24");
    // Deletion only: no word appears that the writer did not write.
    for (const word of tokens(strip.text)) expect(tokens(body)).toContain(word);
  });

  it("leaves a concrete factual opening byte-identical", () => {
    const concrete = "Barcelona level at 2-2 in the 68th minute. The scoreboard moves from 1-1 to 2-2 at 0:24.";
    const strip = stripFrameOpener(concrete);
    expect(strip.text).toBe(concrete);
    expect(strip.stripped).toEqual([]);
    expect(hasFrameOpener(concrete)).toBe(false);
  });

  it("deletes a lead sentence that was ONLY frame narration", () => {
    const body =
      "The scene opens. Manuel Ordoñez finishes the move. The scoreboard moves from 1-1 to 2-1 at 0:24 into the clip. Real Madrid carry the 2-1 scoreboard at 0:24.";
    const strip = stripFrameOpener(body);
    expect(strip.droppedSentences).toEqual(["The scene opens."]);
    expect(strip.text.startsWith("Manuel Ordoñez finishes the move.")).toBe(true);
    expect(hasFrameOpener(strip.text)).toBe(false);
  });

  it("peels nested openers in one repair", () => {
    const strip = stripFrameOpener("In this clip, we see Barcelona pressing at 1:24 into the clip.");
    expect(strip.stripped.length).toBeGreaterThanOrEqual(2);
    expect(strip.text).toBe("Barcelona pressing at 1:24 into the clip.");
  });

  it("handles a lead whose grammatical subject is the clip", () => {
    // A clip-subject lead with content behind it keeps the content.
    const kept = stripFrameOpener("The clip's opening shows a move at 0:24. Real Madrid carry the 1-1 scoreboard at 0:24.");
    expect(kept.text.startsWith("A move at 0:24.")).toBe(true);
    expect(hasFrameOpener(kept.text)).toBe(false);
    // A clip-subject lead whose tail cannot stand alone is deleted with the lead.
    const dropped = stripFrameOpener("The clip's angle is unavailable from this view. Real Madrid carry the 1-1 scoreboard at 0:24.");
    expect(dropped.text.startsWith("Real Madrid carry")).toBe(true);
    expect(dropped.droppedSentences).toEqual(["The clip's angle is unavailable from this view."]);
  });
});

describe("ADAAAA-9083 (AC15) — the write seam strips before the depth floor", () => {
  it("serves the SAME body whether or not the writer opened on the frame (VOD)", () => {
    const bare = gateSummaryDetail(CONCRETE_VOD, vodEvidence());
    expect(bare.summary).not.toBeNull();
    expect(bare.gate).toBe("accepted");
    const framed = gateSummaryDetail(`The scene opens with ${CONCRETE_VOD.charAt(0).toLowerCase()}${CONCRETE_VOD.slice(1)}`, vodEvidence());
    // Same served bytes, same word count: the lead was narration, not content.
    expect(framed.summary).toBe(bare.summary);
    expect(framed.words).toBe(bare.words);
    expect(framed.gate).toBe("neutralised");
    expect(framed.frameOpeners).toEqual(["The scene opens with"]);
    // AC15's served bar.
    expect(hasFrameOpener(framed.summary ?? "")).toBe(false);
  });

  it("serves the SAME body whether or not the writer opened on the frame (live)", () => {
    const live = vodEvidence({
      rail: "live",
      scoreTransition: { from: "0-0", to: "1-1" },
      matchContext: { sport: "soccer", teams: [{ name: "Barcelona", side: "home" }] },
      transcript: "Barcelona press, el centro para Ordoñez",
    });
    const body =
      "Barcelona press the move at 0:12 into the clip. The scoreboard moves from 0-0 to 1-1 at 0:12 into the clip. Ordoñez carries the ball at 0:12 into the clip.";
    const bare = gateSummaryDetail(body, live);
    const framed = gateSummaryDetail(`In this clip, ${body.charAt(0).toLowerCase()}${body.slice(1)}`, live);
    expect(framed.summary).toBe(bare.summary);
    expect(framed.frameOpeners).toEqual(["In this clip,"]);
    expect(hasFrameOpener(framed.summary ?? "")).toBe(false);
  });

  it("keeps the AC14 refusal vocabulary intact on a stripped body (no relaxed bar)", () => {
    // A frame lead is stripped, and the atmosphere clause behind it is still
    // refused by the AC14 sentence facts — the AC15 repair is additive, never a
    // way past another bar.
    const decision = gateSummaryDetail(
      "The clip shows Barcelona pressing in the second half. The crowd erupts as the atmosphere in the stadium turns electric.",
      vodEvidence()
    );
    expect(decision.summary).toBeNull();
    expect(decision.frameOpeners).toEqual(["The clip shows"]);
    expect(decision.violations).toContain("too-few-words");
  });
});

describe("ADAAAA-9083 (AC15) — prompt-first and the violation backstop", () => {
  it("bans the frame lead on both rails", () => {
    const vod = buildSummaryPrompt({ ...vodEvidence() });
    const live = buildSummaryPrompt({ ...vodEvidence({ rail: "live" }) });
    for (const prompt of [vod, live]) {
      expect(prompt).toContain("Never open on the frame");
      expect(prompt).toContain("'The scene opens with");
      expect(prompt).toContain("'In this clip");
      expect(prompt).toContain("'The camera");
    }
    // The rail is rendered, and the line itself names both rails.
    expect(vod).toContain("Rail: vod");
    expect(live).toContain("Rail: live");
    expect(vod).toContain("live and VOD");
  });

  it("reports `frame-opener` on a lead the strip cannot repair", () => {
    const violations = summaryViolations("The clip shows Barcelona pressing at 0:24.", vodEvidence());
    expect(violations).toContain("frame-opener");
    // ...and a concrete lead earns no such token.
    expect(summaryViolations(CONCRETE_VOD, vodEvidence())).not.toContain("frame-opener");
  });

  it("keeps the VOD band untouched by the strip", () => {
    const framed = "The scene opens with " + CONCRETE_VOD.charAt(0).toLowerCase() + CONCRETE_VOD.slice(1);
    expect(gateSummaryDetail(framed, vodEvidence()).words).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
  });
});

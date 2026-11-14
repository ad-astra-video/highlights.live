// ADAAAA-8941 — the four delivery defects the rev-8 LIVE leg (`e4c2fe29`) measured.
//
// Served build `sha256:603797d3…` / HEAD `0149022`, job
// `e4c2fe29-68fe-472c-91da-b96d1dd8ca93` (`file-sim`, `/data/clips/kids300_7935.mp4`,
// 1200 s content, 379 decides, 19 promoted rows). Served bytes only:
//
//   promoted rows 19 | `summaryGate: accepted` 3 | `dropped:repeat` 16
//   `postTitle` served 0/19 | `postTitleGate: absent` 19/19
//
// Every row fixture below is a row's own stored value from that leg
// (`evals/adaaa_8941/live-rail-e4c2fe29.json`). No model call, no GPU, no DB write:
// this file is the `$0` guard on the gate, the clock clause, the repeat key and the
// title lane, so the shape cannot come back without a served leg to find it.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
  gateSummaryDetail,
  neutraliseMatchClockFrame,
  repeatedSentences,
  sentenceSimilarity,
  serveAttestedMatchClock,
  summaryClockReport,
  summarySentenceFacts,
  summaryViolations,
  unattestedAtmosphereClaims,
  unattestedSentences,
  type SummaryEvidence,
} from "../src/highlight-summary.js";
import { gatePostTitleDetail } from "../src/post-title.js";
import type { CaptionGroundingContext } from "../src/caption-grounding.js";

/** The job's persisted matchContext: one resolved team, scorebug OCR evidence. */
const LIVE_CONTEXT = {
  sport: "soccer",
  teams: [
    {
      name: "Barcelona",
      side: "away",
      kitColors: [],
      confidence: 0.85,
      evidence: [{ source: "scorebug_ocr", snippet: "25:20 RMA2-2 BAR" }],
    },
  ],
};

/** One promoted row of the leg: the scoreboard never moved, no ball outcome was
 *  measured, the scorebug reading was legible. */
const liveRow = (
  id: string,
  windowTs: number,
  token: string,
  seconds: number,
  opts?: { caption?: string | null; ballOutcome?: string | null }
): { id: string; evidence: SummaryEvidence } => ({
  id,
  evidence: {
    rail: "live",
    verdict: "big_play",
    eventType: "BIG_PLAY",
    reason: null,
    caption: opts?.caption ?? null,
    postTitle: null,
    windowTs,
    windowDurationS: 15,
    scoreTransition: null,
    matchContext: LIVE_CONTEXT,
    transcript: null,
    attestation: { ballOutcome: opts?.ballOutcome ?? null, goalCrossed: false, scoreBoardChanged: false },
    matchClock: { token, seconds, period: null, legible: true },
  },
});

/** The three rows the leg SERVED, verbatim. */
const ROW_23F9 = liveRow("23f9b28e", 102.66666666666666, "18:12", 1092, { caption: "Scoreboard changes to RMA 2-1." });
const ROW_F4C7 = liveRow("f4c74519", 160, "22:13", 1333, { caption: "Scoreboard changes to 2-2." });
const ROW_5A7F = liveRow("5a7faaf8", 312.66666666666663, "11:33", 693, { caption: null });

const SERVED_23F9 =
  "Barcelona maintains possession and works the ball forward during this sequence. At 1:42 into the clip, the team continues their sustained play.";
const SERVED_F4C7 =
  "Barcelona works the ball forward during this sequence. At 2:40 into the clip, the team maintains possession to continue their sustained play.";
const SERVED_5A7F =
  "Barcelona maintains control of the ball during this sequence. At 5:12 into the clip, the team continues their sustained play to move the ball forward.";

const SERVED: { id: string; evidence: SummaryEvidence; body: string }[] = [
  { ...ROW_23F9, body: SERVED_23F9 },
  { ...ROW_F4C7, body: SERVED_F4C7 },
  { ...ROW_5A7F, body: SERVED_5A7F },
];

// --- Defect 1: the gate accepts unattested atmosphere filler -------------------

describe("ADAAAA-8941 defect 1 — a possession / ball-forward / sustained-play clause is not a fact", () => {
  it("refuses all three served bodies and names the tactical clause", () => {
    for (const row of SERVED) {
      const decision = gateSummaryDetail(row.body, row.evidence);
      expect({ id: row.id, summary: decision.summary }).toEqual({ id: row.id, summary: null });
      expect(decision.violations).toContain("unattested-atmosphere");
      const tactical = unattestedAtmosphereClaims(row.body, row.evidence);
      expect(tactical.length).toBeGreaterThan(0);
      expect(tactical.join(" | ")).toMatch(/possession|works the ball|sustained play|control/);
      // Not one sentence of the served bodies carries a fact beyond the team name
      // and the clip offset: 0 of 6 sentences earned a second fact kind.
      for (const report of summarySentenceFacts(row.body, row.evidence)) {
        expect(report.facts.filter((k) => k !== "clock")).toEqual([]);
      }
    }
  });

  it("reports every sentence of those bodies as unattested", () => {
    for (const row of SERVED) {
      expect(unattestedSentences(row.body, row.evidence)).toHaveLength(2);
    }
  });

  it("still serves a body on the SAME evidence that carries an attested action", () => {
    // The refusal is the prose, not the row: Barcelona is an attested actor and the
    // board's own `matchClock.token` is a fact, so a body naming both serves.
    const honest =
      "Barcelona passes wide at the 18:12 mark of the match. Barcelona completes the move down the wing at the 18:12 mark.";
    const decision = gateSummaryDetail(honest, ROW_23F9.evidence);
    expect(decision.violations).toEqual([]);
    expect(decision.summary).toBe(honest);
    expect(summaryViolations(honest, ROW_23F9.evidence)).toEqual([]);
  });

  it("keeps the sustained-play credit on a row that DID measure a ball outcome", () => {
    // ADAAAA-8903/8773/8806 keep their contract: the credit is evidence-gated, not
    // deleted. On a row whose attestation records an outcome, a possession clause
    // naming the attested actor is still the vocabulary it always was.
    const measured = liveRow("f4c74519", 160, "22:13", 1333, { ballOutcome: "shot" });
    expect(unattestedAtmosphereClaims(SERVED_F4C7, measured.evidence)).toEqual([]);
    // ADAAAA-8934 (in the served tree, merged here after this branch was cut)
    // SUPERSEDES the `action` half of the 8903 credit: a SUSTAINED STATE is not an
    // event, so no row — outcome or not — earns an `action` fact from possession
    // vocabulary. The atmosphere refusal above is the 8941 half and still holds;
    // the credit was never the gate's contract on the served tree.
    expect(attestedActionKinds(SERVED_F4C7, measured.evidence)).toBe(false);
  });
});

/** The `action` kind is credited somewhere in this body's sentence reports. */
function attestedActionKinds(body: string, evidence: SummaryEvidence): boolean {
  return summarySentenceFacts(body, evidence).some((report) => report.facts.includes("action"));
}

// --- Defect 2: the clock clause serves the clip offset -------------------------

describe("ADAAAA-8941 defect 2 — the served body prints the row's OWN match clock", () => {
  it("swaps the clip offset for `matchClock.token` and renames the clip frame", () => {
    const body =
      "Barcelona passes wide at 1:42 into the clip. Barcelona completes the move down the wing at 1:42 into the clip.";
    const served = serveAttestedMatchClock(body, ROW_23F9.evidence);
    expect(served.token).toBe("18:12");
    expect(served.served).toEqual(["1:42"]);
    expect(served.text).not.toContain("1:42");
    expect(served.text).not.toContain("clip");
    expect(served.text).toContain("18:12");
    expect(served.text).toContain("of the match");
  });

  it("serves that clock through the gate, so a census reads `servesMatchClock: true`", () => {
    const body =
      "Barcelona passes wide at 1:42 into the clip. Barcelona completes the move down the wing at 1:42 into the clip.";
    const decision = gateSummaryDetail(body, ROW_23F9.evidence);
    expect(decision.summary).not.toBeNull();
    const report = summaryClockReport(decision.summary as string, ROW_23F9.evidence);
    expect(report.tokens).toEqual(["18:12"]);
    expect(report.servesMatchClock).toBe(true);
    // The offset the writer printed is gone from the served bytes.
    expect(decision.summary).not.toContain("1:42");
  });

  it("leaves a body that already prints the attested token byte-identical", () => {
    const honest =
      "Barcelona passes wide at the 18:12 mark of the match. Barcelona completes the move down the wing at the 18:12 mark.";
    expect(serveAttestedMatchClock(honest, ROW_23F9.evidence).served).toEqual([]);
    expect(neutraliseMatchClockFrame(honest, ROW_23F9.evidence).text).toBe(honest);
    expect(gateSummaryDetail(honest, ROW_23F9.evidence).summary).toBe(honest);
  });

  it("still neutralises a match frame on a stamp that is NOT the row's reading", () => {
    // ADAAAA-8910's repair is unchanged where the stamp really is a clip offset.
    const wrong = "Barcelona passes wide at the 1:42 mark of the match.";
    expect(neutraliseMatchClockFrame(wrong, ROW_23F9.evidence).text).toBe(
      "Barcelona passes wide at the 1:42 mark of the clip."
    );
  });

  it("leaves a fabricated stamp for the clock bars (no fabrication by the repair)", () => {
    // `9:59` is neither the row's match clock nor anchored by its 102.7 s window.
    const fabricated = "Barcelona passes wide at the 9:59 mark of the match.";
    expect(serveAttestedMatchClock(fabricated, ROW_23F9.evidence).served).toEqual([]);
  });
});


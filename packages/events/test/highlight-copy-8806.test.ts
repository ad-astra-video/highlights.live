// ADAAAA-8806 — the two served rows of live job `3740585f` (served build
// `cdf6445`), replayed through the copy contract with NO model call and NO GPU.
//
// Every fixture string below is the row's own stored evidence, copied verbatim
// from `highlights.record` on the box:
//
//   row `2d8e9521` caption "No measured scoreboard change yet."
//     → `attestationDetailCopy` split the PROVISIONAL-goal marker tail at its em
//       dash and served the refusal fragment as copy.
//   row `6ff00ac9` caption "The ball shoots on the right."
//     → `quietStoredCopy` deleted the net-crossing claim and substituted its own
//       shot verb, on a row whose attestation records `ballOutcome: none` /
//       `goalCrossed: false`.
//
// The bar: neither string can ever be a served caption, and the entity-bearing
// summary body is not refused for "restating" a caption that carries no fact.
import { describe, expect, it } from "vitest";
import {
  attestationDetailCopy,
  captionSourceText,
  groundCaption,
  quietStoredCopy,
  stripInternalTokens,
} from "../src/caption-grounding.js";
import {
  buildSummaryPrompt,
  captionRestatesSummary,
  gateSummaryDetail,
  summaryRestatement,
  summaryViolations,
} from "../src/highlight-summary.js";

/** The job's `matchContext` (every row of the leg carries it). */
const MATCH_CONTEXT = {
  sport: "soccer",
  teams: [
    {
      name: "Barcelona",
      side: "away",
      evidence: [{ source: "scorebug_ocr", snippet: "19.42 RMA-2-1 BAR" }],
      kitColors: [],
      confidence: 0.5,
    },
  ],
  ambiguous: true,
};

const ROW_1 = {
  id: "2d8e9521",
  windowTs: 15.306,
  reason:
    "ASR confirms goal at t=-2.7s and scoreboard changes to 2-1 | provisional goal: asr_goal_call in the judged window, no measured scoreboard change yet — the row is a celebration until a later score read measures the transition (then it becomes the confirmed GOAL). | live scoring lane: the span's score transition was already credited to an earlier overlapping window (one transition, one scoring row) (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none scoreReads=0 need=2)",
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
  summaryRaw:
    "At 0:25, the action intensifies as the players compete for possession. This sequence captures a significant moment of play during the match as both teams fight for control.",
};

const ROW_2 = {
  id: "6ff00ac9",
  windowTs: 83.619,
  reason:
    "The ball enters the net at t=-2.0s, confirmed by scoreboard change to 2-2. | live scoring lane: no scoreboard change was measured and no goal-line / net signal or corroborated confirm landed (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none scoreReads=24 preSamples=24 postSamples=0 need=2); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL",
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
  summaryRaw:
    "At 1:34, the ball shoots on the right during the match involving Barcelona. This action occurs as the team moves toward the opponent's side of the pitch.",
};

const groundingFor = (row: typeof ROW_1, place: string) => ({
  verdict: "big_play",
  corroborated: false,
  place,
  promptText: null as string | null,
  attestedBallAction: false,
});

const evidenceFor = (row: typeof ROW_1, caption: string | null) => ({
  rail: "live" as const,
  verdict: "big_play",
  reason: caption,
  caption,
  postTitle: null,
  windowTs: row.windowTs,
  windowDurationS: 5,
  scoreTransition: null,
  matchContext: MATCH_CONTEXT,
  transcript: null,
  adjacentScoreCue: null,
  attestation: row.attestation,
});

describe("ADAAAA-8806 — the diagnostic tail is never caption copy", () => {
  it("keeps the provisional-goal marker on the audit reason (ADAAAA-8139)", () => {
    // The strip is CAPTION-only: the stored reason keeps the marker so a reader
    // of `reason_raw` learns why the row is provisional.
    expect(stripInternalTokens(ROW_1.reason)).toContain("provisional goal:");
  });

  it("removes the marker from every caption source", () => {
    const src = captionSourceText(ROW_1.reason);
    expect(src).not.toContain("provisional goal:");
    expect(src).not.toContain("No measured scoreboard change yet");
  });

  it("no longer derives the refusal fragment as a caption", () => {
    expect(attestationDetailCopy(ROW_1.reason, groundingFor(ROW_1, ""))).not.toBe(
      "No measured scoreboard change yet."
    );
    expect(quietStoredCopy(ROW_1.reason, groundingFor(ROW_1, ""))).not.toContain(
      "No measured scoreboard change yet"
    );
  });

  it("serves the row's own attested score line instead (the 44c552ca precedent)", () => {
    // With the prompt corroborating the scorebug read ("19.42 RMA-2-1 BAR"), the
    // row's own sentence still holds the legitimate fact; with no prompt at all
    // the scoreline is a claim and the row serves nothing — either way the
    // diagnostic is gone.
    const withPrompt = attestationDetailCopy(ROW_1.reason, {
      ...groundingFor(ROW_1, ""),
      promptText: "Scoreboard read: 19.42 RMA-2-1 BAR",
    } as any);
    expect(withPrompt).toBe("Scoreboard changes to 2-1.");
    expect(attestationDetailCopy(ROW_1.reason, groundingFor(ROW_1, ""))).toBe("");
  });
});

describe("ADAAAA-8806 — no ball outcome the attestation does not record", () => {
  it("refuses the substituted shot verb on a row with no measured outcome", () => {
    expect(groundCaption(ROW_2.reason, groundingFor(ROW_2, "on the right"))).not.toBe("The ball shoots on the right.");
    expect(quietStoredCopy(ROW_2.reason, groundingFor(ROW_2, "on the right"))).toBe("");
  });

  it("keeps the same line when the attestation DOES record an outcome", () => {
    // A measured outcome is the row's own fact: the claim rewrite may name it.
    const attested = {
      ...groundingFor(ROW_2, "on the right"),
      attestedBallAction: true,
    };
    expect(quietStoredCopy(ROW_2.reason, attested)).toContain("shoots");
  });

  it("is byte-identical when the surface carries no attestation (VOD / legacy)", () => {
    const legacy = { ...groundingFor(ROW_2, "on the right"), attestedBallAction: null };
    expect(quietStoredCopy(ROW_2.reason, legacy)).toBe("The ball shoots on the right.");
  });
});

describe("ADAAAA-8806 — the entity-bearing body survives the gate", () => {
  it("does not refuse a body that names the attested team the caption lacks", () => {
    const evidence = evidenceFor(ROW_2, "The ball shoots on the right.");
    // The raw restatement measure DOES fire (that is what dropped the body), and
    // the evidence-aware bar exempts it because the body names the entity the
    // caption lacks.
    expect(summaryRestatement(ROW_2.summaryRaw, evidence.caption).restates).toBe(true);
    expect(captionRestatesSummary(ROW_2.summaryRaw, evidence.caption, evidence)).toBe(false);
  });

  it("accepts the body once the refusal verb is not asserted", () => {
    const clean =
      "At 1:34, Barcelona drives forward as the team moves toward the opponent's side of the pitch. The crowd stays loud during the sequence.";
    const evidence = evidenceFor(ROW_2, null);
    const decision = gateSummaryDetail(clean, evidence);
    expect(decision.violations).toEqual([]);
    expect(decision.summary).toBeTruthy();
  });

  it("refuses a body that asserts a ball outcome the row did not measure", () => {
    const evidence = evidenceFor(ROW_2, null);
    expect(summaryViolations(ROW_2.summaryRaw, evidence)).toContain("unattested-action");
  });
});

describe("ADAAAA-8806 — the prompt names the attested actors", () => {
  it("lists the actors the row's evidence attests", () => {
    const prompt = buildSummaryPrompt(evidenceFor(ROW_1, null));
    expect(prompt).toContain("The evidence attests these actors: Barcelona");
  });

  it("forbids ball-outcome claims when nothing was measured", () => {
    const prompt = buildSummaryPrompt(evidenceFor(ROW_1, null));
    expect(prompt).toContain("No ball outcome was measured in this window");
  });

  it("turns a fact-poor retry into a repair instruction naming the actor", () => {
    const prompt = buildSummaryPrompt({
      ...evidenceFor(ROW_1, null),
      retry: { words: 28, sentences: 2, violations: ["too-few-facts"] },
    });
    expect(prompt).toContain("previous draft was fact-poor");
    expect(prompt).toContain("NAME Barcelona");
  });
});

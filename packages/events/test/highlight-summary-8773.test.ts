// ADAAAA-8773 (rev-4 VOD summary bodies): the clock the body states must be the
// CLIP offset, and a deterministic refusal must not buy a second call.
//
// Measured defect (QA on ADAAAA-8762, job `70400b1d`, 95 s source
// `/data/clips/kids95_8483.mp4`, 2 promoted rows, 0 served bodies):
//
//   row `5f32f6f4` — evidence carries `clock, action`, its decide reason said
//                   "the ball entering the net at t=18:02" for a 24 s window.
//   row `995cd9b5` — evidence carries `clock, score, action`, its reason said
//                   "the scoreboard changes from 1-1 to 2-1 at 18:06" for a
//                   27 s window.
//
// Both model replies repeated the MATCH clock from the reason. `clockFactGrounded`
// reconciles a body `m:ss` against `windowTs` inside
// `SUMMARY_CLOCK_ANCHOR_TOLERANCE_S` (90 s), so 18:02 / 18:06 earned nothing and
// each body fell to ONE credited kind — under `SUMMARY_MIN_FACT_KINDS` — on both
// samples. The lane's retry cannot fix a clock-anchoring error, so the row also
// billed 2 calls (2.0x DECIDE_FEE, over the AC5 1.5x envelope).
//
// The corpus below is the stored row evidence and the stored `summaryRaw` of
// `70400b1d`, read at $0 from the QA verdict on ADAAAA-8762.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_CLOCK_ANCHOR_TOLERANCE_S,
  SUMMARY_FEE_RATIO,
  SUMMARY_MIN_FACT_KINDS,
  attestedFactKinds,
  attestedSummaryFactKinds,
  bodyNamesAttestedActor,
  buildSummaryPrompt,
  gateSummaryDetail,
  redactUngroundedPromptClocks,
  summaryFacts,
  type SummaryEvidence,
} from "../src/highlight-summary.js";

/** Row `5f32f6f4`: frame+ASR authority, no score transition, 24 s window. */
const ROW_5F32F6F4: SummaryEvidence = {
  rail: "vod",
  verdict: "scoring_play",
  eventType: "GOAL",
  // Verbatim from the stored row: the decide reason runs on the scorebug's match
  // clock, which is NOT this clip's offset.
  reason:
    "The ASR commentary explicitly states 'el remate gol' at the end of the sequence, and the visual evidence shows the ball entering the net at t=18:02, followed by a celebration by the player in the blue kit.; confirmation pass: goal confirmed (deep frame dive); The visual evidence clearly shows the ball entering the net at t=18:02, followed by a celebration by the player in the blue kit.",
  caption: null,
  postTitle: null,
  windowTs: 24,
  windowDurationS: 15,
  scoreTransition: null,
  matchContext: { teams: [{ name: "Barcelona" }] },
  transcript:
    "Es Carlos Javier quien la pisa, Carlos Javier quien intenta progresar por la banda izquierda, sigue Carlos Javier, el centro para Ordoñez, el remate gol.  Acaba de marcar el Real Madrid, acaba de marcar Manuel Ordoñez, Manu, en el minuto.",
};

/** Row `995cd9b5`: scoreboard authority, `1-1 -> 2-1`, 27 s window. */
const ROW_995CD9B5: SummaryEvidence = {
  rail: "vod",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason:
    "The ASR confirms a goal ('Acaba de marcar el Real Madrid'), the scoreboard changes from 1-1 to 2-1 at 18:06, and the frames show the white-shirted team celebrating.; scoreboard score change confirmed",
  caption: null,
  postTitle: null,
  windowTs: 27,
  windowDurationS: 15,
  scoreTransition: { from: "1-1", to: "2-1" },
  matchContext: { teams: [{ name: "Barcelona" }] },
  transcript: null,
};

/** The stored `summaryRaw` of `5f32f6f4` — refused `too-few-facts` on both calls. */
const STORED_RAW_5F32F6F4 =
  "Manuel Ordoñez finds the back of the net for Real Madrid to secure the scoring play. The goal occurs at the 18:02 mark following a cross into the box. After the ball enters the net, the player in the blue kit celebrates the successful strike. This sequence follows a move by Carlos Javier down the left wing.";

/** The same body with the CLIP offset the prompt actually shows (0:24). */
const CLIP_ANCHORED_5F32F6F4 = STORED_RAW_5F32F6F4.replace("at the 18:02 mark", "at the 0:24 mark");

/** The stored `summaryRaw` of `995cd9b5` — also refused `too-few-facts`. The
 *  fourth sentence carries the clip offset (ADAAAA-8791: the VOD floor is the
 *  40-word target, and the served 36-word shape can no longer be accepted). */
const STORED_RAW_995CD9B5 =
  "Real Madrid takes the lead after a successful scoring play. The scoreboard updates from 1-1 to 2-1 at the 18:06 mark. Players from the white-shirted team are seen celebrating the goal during the match against Barcelona. The scoreboard holds at 2-1 as the match restarts around the 18:06 mark.";

const CLIP_ANCHORED_995CD9B5 = STORED_RAW_995CD9B5.replace("at the 18:06 mark", "at the 0:27 mark");

/** Every `m:ss` the prompt hands the model. */
const promptClocks = (prompt: string): string[] => prompt.match(/\b\d{1,3}:\d{2}\b/g) ?? [];

describe("prompt — the model is handed the clip offset and nothing that cannot be earned", () => {
  it("never shows the match clock the decide reason carried (falsifier on the served build)", () => {
    const frameRow = buildSummaryPrompt(ROW_5F32F6F4);
    expect(frameRow).not.toContain("18:02");
    // The reason's prose survives; only the ungrounded stamp is replaced.
    expect(frameRow).toContain("shows the ball entering the net at the window moment");

    const scoreboardRow = buildSummaryPrompt(ROW_995CD9B5);
    expect(scoreboardRow).not.toContain("18:06");
    expect(scoreboardRow).toContain("the scoreboard changes from 1-1 to 2-1 at the window moment");
  });

  it("labels the window as the clip offset and forbids restating any other clock", () => {
    const prompt = buildSummaryPrompt(ROW_5F32F6F4);
    expect(prompt).toContain("Window: 0:24 — clip offset");
    expect(prompt).toContain("The clock fact is the `Window:` label only");
    expect(prompt).toContain("never restate one as the body's clock");
    expect(buildSummaryPrompt(ROW_995CD9B5)).toContain("Window: 0:27 — clip offset");
  });

  it("leaves every clock it DOES show inside the gate's anchor tolerance", () => {
    // The invariant that makes the prompt and the gate agree: a stamp the model
    // can read is a stamp the row can earn.
    for (const row of [ROW_5F32F6F4, ROW_995CD9B5]) {
      const clocks = promptClocks(buildSummaryPrompt(row));
      expect(clocks.length).toBeGreaterThan(0);
      for (const clock of clocks) {
        const [m, s] = clock.split(":").map(Number);
        expect(Math.abs(m * 60 + s - (row.windowTs as number))).toBeLessThanOrEqual(
          SUMMARY_CLOCK_ANCHOR_TOLERANCE_S
        );
      }
    }
  });

  it("redacts stamps outside the band, keeps in-band stamps and the `t=` form", () => {
    expect(redactUngroundedPromptClocks("net at t=18:02", 24)).toBe("net at the window moment");
    expect(redactUngroundedPromptClocks("net at 18:02", 24)).toBe("net at the window moment");
    // 0:31 is 7 s from a 24 s window: the same moment, so it survives.
    expect(redactUngroundedPromptClocks("net at 0:31", 24)).toBe("net at 0:31");
    // An unknown window attests no clock at all, so none is offered.
    expect(redactUngroundedPromptClocks("net at 0:24", null)).toBe("net at the window moment");
    expect(redactUngroundedPromptClocks(null, 24)).toBe("");
  });

  it("does not render the duration suffix the model copied into prose", () => {
    // Served probe: the pre-8773 window line `0:24 (+15 s)` came back as "at the
    // 0:24 (+15 s) mark", a broken-looking timestamp on a card.
    const prompt = buildSummaryPrompt({ ...ROW_5F32F6F4, windowDurationS: 15 });
    expect(prompt).not.toContain("+15 s");
    expect(prompt).toContain("Window: 0:24 — clip offset");
  });

  it("keeps the score line, which is a DIFFERENT fact and stays grounded", () => {
    const prompt = buildSummaryPrompt(ROW_995CD9B5);
    expect(prompt).toContain("Score transition: 1-1 -> 2-1");
  });
});

describe("gate — the clock is what starved the row (replayed on the stored bodies)", () => {
  it("refuses the match-clock body `too-few-facts`, exactly as served", () => {
    const decision = gateSummaryDetail(STORED_RAW_5F32F6F4, ROW_5F32F6F4);
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("too-few-facts");
    expect(attestedSummaryFactKinds(STORED_RAW_5F32F6F4, ROW_5F32F6F4)).toEqual(["action"]);
  });

  it("accepts the same body on the clip offset, with two credited kinds", () => {
    const body = CLIP_ANCHORED_5F32F6F4;
    const kinds = attestedSummaryFactKinds(body, ROW_5F32F6F4);
    expect(kinds).toContain("clock");
    expect(kinds).toContain("action");
    expect(kinds.length).toBeGreaterThanOrEqual(SUMMARY_MIN_FACT_KINDS);
    const decision = gateSummaryDetail(body, ROW_5F32F6F4);
    expect(decision.summary).toBe(body);
    expect(decision.violations).toEqual([]);
  });

  it("does the same for the scoreboard row: score alone was under the bar", () => {
    expect(attestedSummaryFactKinds(STORED_RAW_995CD9B5, ROW_995CD9B5)).toEqual(["score"]);
    expect(gateSummaryDetail(STORED_RAW_995CD9B5, ROW_995CD9B5).violations).toContain("too-few-facts");

    const kinds = attestedSummaryFactKinds(CLIP_ANCHORED_995CD9B5, ROW_995CD9B5);
    expect(kinds.sort()).toEqual(["clock", "score"]);
    const decision = gateSummaryDetail(CLIP_ANCHORED_995CD9B5, ROW_995CD9B5);
    expect(decision.summary).toBe(CLIP_ANCHORED_995CD9B5);
  });

  it("serves the AC11-VOD value bar on both clip-anchored rows", () => {
    // spec §13.4: a VOD body that clears `too-few-facts` by dropping its clock and
    // still reads "the ball shoots..." is not value. Both repaired bodies name an
    // attested actor (Ordoñez / Real Madrid, from the row's ASR transcript) and the
    // scoreboard row also carries its grounded 1-1 -> 2-1 line.
    const frameBody = CLIP_ANCHORED_5F32F6F4;
    const frameDecision = gateSummaryDetail(frameBody, ROW_5F32F6F4);
    expect(frameDecision.summary).not.toBeNull();
    expect(bodyNamesAttestedActor(frameBody, ROW_5F32F6F4)).toBe(true);

    const scoreBody = CLIP_ANCHORED_995CD9B5;
    const scoreKinds = attestedSummaryFactKinds(scoreBody, ROW_995CD9B5);
    expect(bodyNamesAttestedActor(scoreBody, ROW_995CD9B5) || scoreKinds.includes("score")).toBe(true);
  });

  it("serves a body that names the VOD rail's matchContext team (Barcelona)", () => {
    // QA-F4's `$0` replay clause: "a body naming an attested team (e.g. Barcelona
    // from matchContext.teams) serves". The team is the only entity the VOD rail
    // attests on row 5f32f6f4 besides the ASR names, so it must carry the copy.
    const body =
      "Barcelona work the ball down the left at the 0:24 mark of this clip. A low cross is cut out at the near post and cleared away. The loose ball is recycled back into the box under pressure.";
    const decision = gateSummaryDetail(body, ROW_5F32F6F4);
    expect(decision.violations).toEqual([]);
    expect(decision.summary).toBe(body);
    expect(bodyNamesAttestedActor(body, ROW_5F32F6F4)).toBe(true);
    expect(attestedSummaryFactKinds(body, ROW_5F32F6F4).length).toBeGreaterThanOrEqual(SUMMARY_MIN_FACT_KINDS);
  });

  it("still refuses a `Ball`-shaped body with no attested actor", () => {
    // AC9/AC11: a bare verb with no named actor is not a fact, and the clock alone
    // is under the density bar — the gate must not be loosened into passing it.
    const body = "The ball shoots on the left and is saved at the 0:24 mark of this clip.";
    const decision = gateSummaryDetail(body, ROW_5F32F6F4);
    expect(decision.summary).toBeNull();
    expect(bodyNamesAttestedActor(body, ROW_5F32F6F4)).toBe(false);
    expect(attestedSummaryFactKinds(body, ROW_5F32F6F4)).not.toContain("action");
  });

  it("does NOT widen grounding: a match clock stays ungrounded even though the reason carries it", () => {
    // Fix shape 2 (accept a match clock reconciled against the row's own
    // attestation) was deliberately NOT taken: the reason is decide prose, not an
    // attestation the served card can be held to. Pinned so widening it later is
    // a reviewed decision, not a silent drift.
    expect(summaryFacts(STORED_RAW_5F32F6F4).some((f) => f.kind === "clock")).toBe(true);
    expect(attestedSummaryFactKinds(STORED_RAW_5F32F6F4, ROW_5F32F6F4)).not.toContain("clock");
    expect(attestedFactKinds(ROW_5F32F6F4)).toContain("clock");
  });
});

describe("fee — the row ceiling is per ROW, not per call", () => {
  it("keeps the AC5 bound at 1.5x DECIDE_FEE", () => {
    expect(SUMMARY_FEE_RATIO).toBe(1.5);
    const decideFee = 0.0033;
    // One call at the ceiling is the whole row budget; two calls were 2.0x.
    expect(decideFee * SUMMARY_FEE_RATIO).toBeCloseTo(0.00495, 6);
    expect(decideFee * SUMMARY_FEE_RATIO * 2).toBeCloseTo(0.0099, 6);
  });
});

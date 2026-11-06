// ADAAAA-8216 — the WRITE-SEAM proof that a demoted (gated) celebration row
// persists the copy the store seam serves for its own sentence.
//
// Residual source: the ADAAAA-8194 Q1 forward window on build `1d49b02`
// (job `8b2dc0d4`, row `f0ffe7c4`, repeated as `9f56e509` on `e4bea0fa`).
// `storedSurfaceFor` over that row's own sentence + prompt returns
//
//     Scoreboard changes to 1-1.      (at-t-free, 4 words, 0 violations)
//
// yet the persisted row had `reason: null` and only `reason_raw` — the shape the
// code produces when the copy gate cannot corroborate the row's measured
// transition, because the prompt the window was judged with never reached the
// seam. The prompt is a property of the WINDOW (the decide reply carries it as
// `analysis.prompt` and as the audit descriptor's `promptText`) while the verdict
// object is transformed on its way to the seam (confirm reconcile, scoring-lane
// demotion, recognition rewrites), and the seam read only `analysis.prompt`.
//
// These tests pin the writer: with the window's capture, with only the decide
// audit descriptor, and with no prompt at all. The accept lane is driven end to
// end (`acceptVideoDecision` + `LiveRunShared`) so the assertion is about the
// RECORD that gets persisted, not about a helper's return value.
import { describe, expect, it } from "vitest";
import type { HighlightRecord } from "@highlights/events";
import { captionLead, QUIET_MAX_WORDS, storedReasonViolations, wholeStoredSentence } from "@highlights/events";
import {
  LiveRunShared,
  acceptVideoDecision,
  captionGroundingForWindow,
  decisionPromptText,
  storedSurfaceFor,
  type AnalyzerConfig,
  type CandidateSignal,
  type DecisionResult,
} from "../src/analyzer.js";

/** The model's sentence for the row: both ends of the transition, its own
 *  window-relative instant, and the unmeasured play clause. */
const CLEAN_REASON = "Scoreboard changes from 2-2 to 1-1 at t=-3.0s and ball enters net.";

/** The LIVE scoring lane's refusal tail the demotion appends (audit, not copy). */
const LANE_TAIL =
  "live scoring lane: no measured attestation in this window (scoreBoardChanged=true goalCrossed=false " +
  "ballOutcome=none corroborated=false goalConfirmed=none scoreReads=9 preSamples=6 postSamples=3 need=2); " +
  "audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL";

/** The row's own persisted `reason_raw` (sentence + audit tail, verbatim from
 *  the measured row `f0ffe7c4`). */
const ROW_REASON_RAW = `${CLEAN_REASON} | ${LANE_TAIL}`;

/** The row's own prompt: both ends of the transition measured in this window
 *  (`2-2` at -10…-6 s, `1-1` at -4…-2 s on the ADAAAA-8194 forward window). */
const WINDOW_PROMPT = [
  '-10.0s tracks=3 objects=player,soccer ball ocr="Art Soccer|28.57 FMA 2-2 BARGOLDCAR" poss=none',
  '-6.0s  tracks=3 objects=player,soccer ball ocr="Art Soccer|29114 EMA 2-2 BARAszende" poss=none',
  '-4.0s  tracks=3 objects=player,soccer ball ocr="Art Soccer|FMA 1-1-BARAszendeAsAsze" poss=none',
  '-2.0s  tracks=3 objects=player,soccer ball ocr="Art Soccer|FINAL 1-1-BARAzende3Asce" poss=none',
  "  - score: 2-2 (last score at 175.0s)",
].join("\n");

/** The DELIVERED row shape, as persisted (already carries the demotion's tail). */
const DEMOTED_ROW: DecisionResult = {
  isHighlight: true,
  score: 85,
  outcome: "big_play",
  eventType: "BIG_PLAY",
  reason: ROW_REASON_RAW,
} as DecisionResult;

/** The pre-demotion verdict the accept receives (clean sentence; the demotion
 *  appends the tail itself). */
const SCORING_READ: DecisionResult = {
  isHighlight: true,
  score: 85,
  outcome: "scoring_play",
  eventType: "GOAL",
  reason: CLEAN_REASON,
} as DecisionResult;

/** The candidate that produced it: a `score_change` trigger whose only score
 *  step is a BACKWARD `2-2 -> 1-1` read, which attests nothing. */
const CANDIDATE: CandidateSignal = {
  eventType: "AUDIO_BURST",
  timestamp: 305,
  scoreBoardChanged: true,
  scoreBoardDelta: { pre: [2, 2], post: [1, 1], preTs: 302, postTs: 305.5, deltaTs: 305.5, preSamples: 6, postSamples: 3 },
  scoreReads: { scoreReads: 9, preSamples: 6, postSamples: 3, need: 2 },
} as CandidateSignal;

function liveCfg(over: Partial<AnalyzerConfig> = {}): AnalyzerConfig {
  return {
    jobId: "job-8216-copy",
    gameHint: "soccer",
    clipBeforeS: 7,
    clipAfterS: 8,
    clipWindowMinSec: 15,
    preferLabels: [],
    confirmEnabled: false,
    liveObserveLoop: true,
    captionGrounding: true,
    preWindowS: 10,
    postWindowS: 5,
    sampleFps: 1,
    analysisFps: 1,
    // No running story: `windowPlace` resolves nothing, so the row's only honest
    // copy is its own measured transition — the residual's exact shape.
    getRunningSummary: () => "",
    ...over,
  } as AnalyzerConfig;
}

/** The write seam's own grounding derivation over a bare run (no tracks, no
 *  place, no prior highlights) — the window state the residual was written in. */
function windowGrounding(decision: DecisionResult) {
  const run = new LiveRunShared({ audioRetainS: 400 });
  return captionGroundingForWindow(decision, run, CANDIDATE.timestamp, liveCfg(), false, [], {
    ballOutcome: null,
    goalCrossed: false,
  });
}

const leadWords = (text: string): number => captionLead(text).split(/\s+/).filter(Boolean).length;

/** The acceptance bar for this row: copy is owed, and it must be honest. */
function expectOwedCopy(surface: { reason?: string }) {
  expect(surface.reason).toBe("Scoreboard changes to 1-1.");
  const reason = surface.reason as string;
  expect(reason).not.toMatch(/\bat\s+t=-?[\d.]+\s*s\b/i);
  expect(leadWords(reason)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
  expect(storedReasonViolations(reason, [wholeStoredSentence(ROW_REASON_RAW)])).toEqual([]);
}

/** Drive the accept lane and return the record it persisted. */
async function acceptOnce(decision: DecisionResult): Promise<HighlightRecord> {
  const run = new LiveRunShared({ audioRetainS: 400 });
  const cut = async (ts: number) => ({ clipId: `clip-${ts.toFixed(3)}`, clipUri: `file://clip-${ts.toFixed(3)}.mp4` });
  const client = { decide: async () => ({}) as any, confirm: async () => ({}) as any } as any;
  await acceptVideoDecision(
    client,
    run,
    cut,
    liveCfg(),
    () => {},
    { seq: 1525, timestamp: CANDIDATE.timestamp },
    CANDIDATE,
    decision,
    undefined,
    undefined,
    undefined,
    { lo: 295, hi: 305 }
  );
  const rows = run.highlights;
  return rows[rows.length - 1] as HighlightRecord;
}

describe("ADAAAA-8216 — the write seam carries the window's prompt into the copy gate", () => {
  it("serves the measured transition when the window's capture reaches the seam", () => {
    const decision = { ...DEMOTED_ROW, analysis: { prompt: WINDOW_PROMPT } as any } as DecisionResult;
    const surface = storedSurfaceFor(decision, windowGrounding(decision));
    expectOwedCopy(surface);
    // Clause 2 unchanged: a claim card is earned only by corroboration.
    expect(surface.caption).toBeUndefined();
    expect(surface.cardTitles).toBeUndefined();
    // The audit tail is never copy; the raw sentence stays as the audit record.
    expect(surface.reason_raw).toBe(ROW_REASON_RAW);
  });

  it("recovers the prompt from the decide audit descriptor when `analysis` is absent", () => {
    const decision = { ...DEMOTED_ROW, audit: { promptText: WINDOW_PROMPT } } as DecisionResult;
    expect(decisionPromptText(decision)).toBe(WINDOW_PROMPT);
    expectOwedCopy(storedSurfaceFor(decision, windowGrounding(decision)));
  });

  it("prefers the capture when both carriers are present", () => {
    const decision = {
      ...DEMOTED_ROW,
      analysis: { prompt: WINDOW_PROMPT } as any,
      audit: { promptText: "a stale descriptor prompt with no reads" },
    } as DecisionResult;
    expect(decisionPromptText(decision)).toBe(WINDOW_PROMPT);
  });

  it("stores no copy (and keeps the raw) when the window carries no prompt at all", () => {
    const surface = storedSurfaceFor(DEMOTED_ROW, windowGrounding(DEMOTED_ROW));
    // Clause 3: no honest sentence can be certified without the window's own
    // reads, so the row keeps the audit line and stores no customer copy.
    expect(surface.reason).toBeUndefined();
    expect(surface.caption).toBeUndefined();
    expect(surface.reason_raw).toBe(ROW_REASON_RAW);
  });

  it("persists the copy on the ACCEPT lane when the demoted verdict arrives without `analysis`", async () => {
    // This is the writer that dropped `f0ffe7c4`: the seam had the sentence but
    // not the window's prompt, so the store-time gate refused it and the quiet
    // fallback could not corroborate the transition.
    const rec = await acceptOnce({ ...SCORING_READ, audit: { promptText: WINDOW_PROMPT } } as DecisionResult);
    // The scoring lane refused the backward read, so the delivered row is the
    // celebration — and it now CARRIES its measured transition.
    expect(rec.eventType).toBe("BIG_PLAY");
    expect(rec.outcome).toBe("big_play");
    expect(rec.reason).toBe("Scoreboard changes to 1-1.");
    expect(rec.caption).toBeUndefined();
    expect(rec.cardTitles).toBeUndefined();
    expect(rec.reason_raw).toBe(ROW_REASON_RAW);
    // The demotion disclosure still names what the gate read.
    expect(rec.attestationUsed?.scoreBoardChanged).toBe(true);
    expect(rec.attestationUsed?.scoreReads).toBe(9);
  });

  it("persists the copy on the ACCEPT lane when only the window capture is present", async () => {
    const rec = await acceptOnce({ ...SCORING_READ, analysis: { prompt: WINDOW_PROMPT } as any } as DecisionResult);
    expect(rec.reason).toBe("Scoreboard changes to 1-1.");
    expect(rec.caption).toBeUndefined();
  });

  it("keeps the static-form refusal: a post-only read stores nothing (762d8a89)", () => {
    // The recorded ruling: a sentence with no `from X to Y` serves nothing, and
    // QA grades those exempt. Only a `1-1` read exists in this window's prompt.
    const raw = "Scoreboard changes to 2-1 at t=-2.0s and ASR confirms Manuel Ordoño's goal.";
    const decision = {
      ...DEMOTED_ROW,
      reason: raw,
      audit: { promptText: 'ocr="Art Soccer|11:32 FMA1-1-BAR12Art So"' },
    } as DecisionResult;
    const surface = storedSurfaceFor(decision, windowGrounding(decision));
    expect(surface.reason).toBeUndefined();
    expect(surface.reason_raw).toBe(raw);
  });
});

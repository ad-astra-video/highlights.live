// ADAAAA-8903 — the live summary lane's coverage gap (AC1-live) and §15.4.
//
// Measured on live job `9bed3bd7` (served build `6426d6bf`, HEAD `77215b5`): 5
// promoted rows, AC1-live 3/5 = 60 % against a 95 % bar. Both misses are
// BIG_PLAY rows whose own evidence offers `clock + action`
// (`attestedFactKinds(evidence).length >= SUMMARY_MIN_FACT_KINDS`) and which
// served NOTHING — `summaryGate: dropped:gate`, 2 calls, 1 dropped. The replies
// were the copy the prompt itself demands on such a row: the window measured no
// ball outcome (`attestationUsed.ballOutcome: null`, `goalCrossed: false`), so
// every shot/save/head verb is an `unattested-action` refusal and the only legal
// action prose is sustained play ("maintains possession", "works the ball",
// "pressure the opposition") — which the fact extractor had no verb for, so
// `too-few-facts` refused a body that named the attested actor and carried the
// window clock. The lane asked for prose its own gate could never credit.
//
// §15.4: both rows stored `summaryDroppedByReason: {gate: 1}` only, an aggregate
// counter, so a `too-few-words` (depth-threshold) refusal could not be told from
// a `too-few-facts` / `ungrounded-name` (compliance) refusal without a replay.
//
// ADAAAA-8941 (defect 1) SUPERSEDES this ticket's resolution: the sustained-play
// credit below is refused on a row that measured no ball outcome, so these two
// census rows are dry rather than served. The §15.4 half of this file (the
// per-row refusal detail) is unaffected and still graded.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_LIVE_BAND,
  SUMMARY_MIN_FACT_KINDS,
  attestedFactKinds,
  attestedSummaryFactKinds,
  gateSummaryDetail,
  summaryFacts,
} from "@highlights/events";
import { runSummaryForRow, summaryEvidenceForRow, type SummaryLaneStore } from "../src/summary-lane.js";

/** The job's persisted `matchContext` (read off the box, verbatim). */
const MATCH_CONTEXT = {
  sport: "soccer",
  teams: [
    {
      name: "Barcelona",
      side: "away",
      evidence: [{ source: "scorebug_ocr", snippet: "26:17 RMA2-2 BAR" }],
      kitColors: [],
      confidence: 0.5,
    },
  ],
  trail: [
    { at: "2026-11-13T06:08:30.057600Z", names: [{ name: "Barcelona", side: "away", confidence: 0.5 }], action: ["no change"], progressPct: 0 },
    { at: "2026-11-13T06:09:32.884876Z", names: [{ name: "Real Madrid", side: "home", confidence: 0.5 }], action: ["no change"], progressPct: 25 },
    { at: "2026-11-13T06:10:33.172470Z", names: [], action: ["no evidence"], progressPct: 50 },
    { at: "2026-11-13T06:12:29.808362Z", names: [{ name: "Barcelona", side: "away", confidence: 0.5 }], action: ["flipped unknown -> Barcelona at away"], progressPct: 100 },
  ],
  ambiguous: true,
  inferredAt: "2026-11-13T06:12:29.808402Z",
  resolverVersion: 1,
};

/** Row `c3257097`: BIG_PLAY at 448.003 s, window anchor 461.003 s (`7:41`). */
const ROW_C3257097 = {
  id: "c3257097-39ed-4fdf-b402-1c3f5aaa8007",
  eventType: "BIG_PLAY",
  outcome: "big_play",
  start: 448.00300002098083,
  end: 463.00300002098083,
  caption: null,
  postTitle: null,
  trigger: { kind: "motion", timestamp: 461.00300002098083, eventType: "SPORTING_EVENT" },
  attestationUsed: { scoreBoardChanged: false, goalCrossed: false, ballOutcome: null, authority: "none" },
  matchContext: MATCH_CONTEXT,
};

/** Row `eaf1da9f`: BIG_PLAY at 464.237 s, window anchor 477.237 s (`7:57`). */
const ROW_EAF1DA9F = {
  id: "eaf1da9f-91e0-42f4-829d-74e36c0c0c00",
  eventType: "BIG_PLAY",
  outcome: "big_play",
  start: 464.2369999885559,
  end: 479.2369999885559,
  caption: null,
  postTitle: null,
  trigger: { kind: "motion", timestamp: 477.2369999885559, eventType: "SPORTING_EVENT" },
  attestationUsed: { scoreBoardChanged: false, goalCrossed: false, ballOutcome: null, authority: "none" },
  matchContext: MATCH_CONTEXT,
};

/** The exact `summaryRaw` the lane stored on row `c3257097`. */
// ADAAAA-8914 (AC14.1): the body names Barcelona in BOTH sentences. The old
// second sentence ("The team works the ball across the pitch …") credited no
// action because an action fact needs a NAMED attested actor, so the clause repair
// deleted it and the row fell under the live floor — the AC14 prompt asks for the
// name in every sentence for exactly this reason.
const STORED_RAW_C3257097 =
  "Barcelona maintains possession during this sequence at the 7:41 mark. Barcelona works the ball across the pitch to set up their offensive play.";

/** The exact `summaryRaw` the lane stored on row `eaf1da9f`. */
const STORED_RAW_EAF1DA9F =
  "Barcelona maintains control of the match at the 7:57 mark. Barcelona continues to pressure the opposition through the next passage of play.";

const evidenceFor = (row: Record<string, unknown>) =>
  summaryEvidenceForRow({ ...(row as any), matchContext: MATCH_CONTEXT }, "live", null);

function stubStore() {
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  const store: SummaryLaneStore = {
    async patchHighlightSummary(id, patch) {
      patches.push({ id, patch });
      return {};
    },
  };
  return { store, patches };
}

function stubFetch(summaries: string[]) {
  let i = 0;
  const fn = (async (_url: string, init: any) => {
    void init;
    const summary = summaries[Math.min(i, summaries.length - 1)];
    i++;
    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls: () => i };
}

const cfg = (over: Record<string, unknown> = {}) => ({
  decideUrl: "http://decide.test",
  decideFee: 0.0033,
  ...over,
});

// ---------------------------------------------------------------------------
// 1. AC1-live: the two census bodies are ATMOSPHERE, not facts.
//
// ADAAAA-8941 (defect 1, AC14.1/AC14.2) supersedes this ticket's resolution.
// The live leg `e4c2fe29` served exactly this shape on 3 of 3 accepted rows —
// "Barcelona maintains possession … the team continues their sustained play" —
// and the rev-8 grade read it as filler, because a row that recorded no ball
// outcome (`attestation.ballOutcome: null`) measured no possession, no pressure
// and no ball-forward. AC14 credits an **attested** actor action, so the
// sustained-play vocabulary is refused on those rows (`sustainedFactUnattested`).
//
// The row is therefore DRY, and that is the honest outcome: the lane may not
// serve a body whose only fact is the clock. What stays asserted here is the
// instrument's side — the row's fact MENU still offers `clock` + `action` (an
// attested name exists), so the lane still asks for two kinds; the gate simply
// may not invent one.
// ---------------------------------------------------------------------------
describe("ADAAAA-8903 / ADAAAA-8941 — sustained play is not a fact on a no-outcome row", () => {
  it("refuses sustained play as a fact kind (row c3257097)", () => {
    const evidence = evidenceFor(ROW_C3257097);
    // The row's own menu offers two kinds — eligibility is the instrument's rule.
    expect(attestedFactKinds(evidence).length).toBeGreaterThanOrEqual(SUMMARY_MIN_FACT_KINDS);
    expect(attestedFactKinds(evidence)).toEqual(["clock", "action"]);
    // But the BODY cannot earn `action` from possession vocabulary: `summaryFacts`
    // sees it, the attestation filter does not credit it.
    expect(summaryFacts(STORED_RAW_C3257097).map((f) => f.kind)).toEqual(expect.arrayContaining(["action"]));
    expect(attestedSummaryFactKinds(STORED_RAW_C3257097, evidence)).toEqual(["clock"]);
    const decision = gateSummaryDetail(STORED_RAW_C3257097, evidence);
    expect(decision.summary).toBeNull();
    expect(decision.violations).toEqual(expect.arrayContaining(["unattested-sentence", "too-few-facts"]));
  });

  it("refuses sustained play as a fact kind (row eaf1da9f)", () => {
    const evidence = evidenceFor(ROW_EAF1DA9F);
    expect(attestedFactKinds(evidence)).toEqual(["clock", "action"]);
    expect(attestedSummaryFactKinds(STORED_RAW_EAF1DA9F, evidence)).toEqual(["clock"]);
    const decision = gateSummaryDetail(STORED_RAW_EAF1DA9F, evidence);
    expect(decision.summary).toBeNull();
    expect(decision.violations).toEqual(expect.arrayContaining(["unattested-sentence", "too-few-facts"]));
  });

  it("serves nothing on the row, keeps the raw, and never stores a bare clock card", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([STORED_RAW_C3257097]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }) as any, {
      jobId: "9bed3bd7",
      highlightId: ROW_C3257097.id,
      evidence: evidenceFor(ROW_C3257097),
    });
    // The menu names two kinds, so the refusal is repairable and earns the one
    // regeneration — but the same filler cannot clear it, so the row serves no copy.
    expect(result.outcome).toBe("dropped");
    expect(f.calls()).toBe(2);
    const patch = patches.at(-1)?.patch as Record<string, unknown>;
    expect(patch.summary).toBeUndefined();
    expect(patch.summaryRaw).toBe(STORED_RAW_C3257097);
    expect(patch.summaryGate).toMatch(/^dropped:/);
  });

  it("does not open the ball-outcome lane the prompt closes", () => {
    // `ballOutcome: null` + a shot verb is still an `unattested-action` refusal:
    // the widening is a SUSTAINED-PLAY class, not a ball-outcome one.
    const evidence = evidenceFor(ROW_C3257097);
    const body =
      "Barcelona shoots at the 7:41 mark and the ball is saved at the near post. The crowd reacts as the move breaks down.";
    const decision = gateSummaryDetail(body, evidence);
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("unattested-action");
  });

  it("still refuses sustained play with no named attested actor", () => {
    // AC9/AC11: the action kind is credited only with an ATTESTED name, so the
    // sustained class cannot carry a body that names nobody.
    const evidence = evidenceFor(ROW_C3257097);
    const body =
      "The team keeps possession at the 7:41 mark and builds up patiently. Pressure mounts across the pitch as the sequence develops.";
    expect(attestedSummaryFactKinds(body, evidence)).not.toContain("action");
    const decision = gateSummaryDetail(body, evidence);
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("too-few-facts");
  });
});

// ---------------------------------------------------------------------------
// 2. §15.4: the refusal verdict is persisted PER ROW.
// ---------------------------------------------------------------------------
describe("ADAAAA-8903 — §15.4 refusal detail on the row", () => {
  const THIN =
    "At 0:25, the action intensifies as the players compete for possession. This sequence captures a significant moment of play as both teams fight for control.";

  it("writes the violation list and the judged word count with the band on a drop", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([THIN, THIN]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f.fn }) as any, {
      jobId: "9bed3bd7",
      highlightId: "h-8903-drop",
      evidence: evidenceFor(ROW_C3257097),
    });
    expect(result.outcome).toBe("dropped");
    const patch = patches.at(-1)!.patch;
    // ADAAAA-8914 (AC14.5): both sentences are unattested filler, so the clause
    // repair empties the body and the drop is named `filler` (the repair, not a
    // compliance bar, is what dropped it).
    expect(patch.summaryDroppedByReason).toEqual({ filler: 1 });
    // … and the DETAIL rides the row so the next census needs no replay.
    // ADAAAA-8914: neither sentence carries a fact, so the repair empties the body;
    // the detail keeps the fact-density token (the writer's defect) and the
    // unattested-sentence token, and `summaryRepairedWords` records that nothing
    // survived.
    expect(patch.summaryViolations).toEqual(expect.arrayContaining(["too-few-facts", "unattested-sentence"]));
    expect(patch.summaryRepairedWords).toBe(0);
    expect(patch.summaryWordCount).toBeGreaterThan(0);
    expect(patch.summaryFloorWords).toBe(SUMMARY_LIVE_BAND.floorWords);
    expect(patch.summaryTargetMinWords).toBe(SUMMARY_LIVE_BAND.targetMinWords);
    expect(patch.summaryDroppedSentences).toBe(0);
  });

  it("separates a depth-threshold refusal from a compliance refusal by the row alone", async () => {
    const evidence = evidenceFor(ROW_C3257097);
    // A short, grounded body: the writer was THIN (a threshold question).
    const short = "Barcelona keeps possession at the 7:41 mark of the clip.";
    const shortDecision = gateSummaryDetail(short, evidence);
    expect(shortDecision.summary).toBeNull();
    expect(shortDecision.violations).toContain("too-few-words");
    expect(shortDecision.words).toBeLessThan(SUMMARY_LIVE_BAND.floorWords);

    // A grounded-length body naming an entity the row does not attest: this is a
    // COMPLIANCE refusal, and its word count sits above the floor.
    const ungrounded =
      "Chelsea keeps possession at the 7:41 mark of the clip and builds up patiently. Barcelona keeps possession as the sequence develops across the pitch.";
    const ungroundedDecision = gateSummaryDetail(ungrounded, evidence);
    expect(ungroundedDecision.summary).toBeNull();
    expect(ungroundedDecision.violations).toContain("ungrounded-name");
    expect(ungroundedDecision.violations).not.toContain("too-few-words");
    expect(ungroundedDecision.words).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.floorWords);
  });

  it("persists the detail through the row schema (zod strips undeclared fields)", async () => {
    const { Store } = await import("../src/store.js");
    const { HighlightRecordSchema } = await import("@highlights/events");
    const row = HighlightRecordSchema.parse({
      id: "h-8903-persist",
      jobId: "9bed3bd7",
      clipUri: "/clips/big-play.mp4",
      start: 448.003,
      end: 463.003,
      localizedTs: 461.003,
      localizeSignal: "peak_frame",
      clipWindowBeforeS: 7,
      clipWindowAfterS: 8,
      clipWindowSec: 15,
      eventType: "BIG_PLAY",
      score: 85,
      outcome: "big_play",
      corroborated: false,
      status: "accepted",
      caption: "Barcelona keeps the ball",
      createdAt: "2026-11-13T06:16:00.000Z",
    });
    const store = new Store(null);
    await store.addHighlight(row);
    const next = await store.patchHighlightSummary("h-8903-persist", {
      summaryGate: "dropped:gate",
      summaryRaw: "At the 7:41 mark the players compete for the ball.",
      summaryCalls: 2,
      summaryDropped: 1,
      summaryDroppedByReason: { gate: 1 },
      summaryViolations: ["too-few-facts"],
      summaryWordCount: 24,
      summaryFloorWords: 18,
      summaryTargetMinWords: 25,
      summaryDroppedSentences: 0,
    });
    // The SQL projection a census reads (`record::jsonb->…`) is this serialisation.
    const projected = JSON.parse(JSON.stringify(next));
    expect(projected.summaryViolations).toEqual(["too-few-facts"]);
    expect(projected.summaryWordCount).toBe(24);
    expect(projected.summaryFloorWords).toBe(18);
    expect(projected.summaryTargetMinWords).toBe(25);
    expect(projected.summaryDroppedSentences).toBe(0);
    // A served row keeps carrying `summary` and no refusal detail.
    expect(projected.summary).toBeUndefined();
  });

  it("does not invent a refusal detail when no gate verdict exists", async () => {
    // Transport-shaped drops have no judged text: nothing is stored as if it had
    // been judged (§15.4 grades the GATE, not a network failure).
    const { store, patches } = stubStore();
    const f = (async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const result = await runSummaryForRow(store, cfg({ fetchImpl: f }) as any, {
      jobId: "9bed3bd7",
      highlightId: "h-8903-timeout",
      evidence: evidenceFor(ROW_C3257097),
    });
    expect(result.outcome).toBe("dropped");
    expect(result.reason).toBe("timeout");
    const patch = patches.at(-1)!.patch;
    expect(patch.summaryDroppedByReason).toEqual({ timeout: 1 });
    expect(patch.summaryViolations).toBeUndefined();
    expect(patch.summaryWordCount).toBeUndefined();
  });
});

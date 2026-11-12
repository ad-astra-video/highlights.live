// ADAAAA-8212: a promoted GOAL must serve the copy the RESOLVING verdict
// produced, and name the MEASURED attestation that resolved it.
//
// Regression source: the QA leg `c084bf83` (1 stream, `file-sim` of
// `kids300_7935.mp4`, GT goal @159 s). Row `766dadb9` was promoted in place by
// the @165 s GOAL accept and ended `outcome=scoring_play, eventType=GOAL` with
// `deferredAttestation {deltaTs:161, readAt:165, pre:[2,1], post:[2,2]}` — but it
// still served the celebration copy ("Ball shoots in midfield." for `reason`,
// `caption` and `cardTitles`) and the PRE-promotion acceptance
// (`scoreBoardChanged:false, postSamples:0`) as `attestationUsed`, while
// `reason_raw` held the goal line. A confirmed GOAL card explained itself as a
// midfield celebration, certified by an attestation that measured nothing.
//
// The deferred entry's own surface cannot fix that on its own: it was gated for a
// window that had NOT measured a score change, so the copy gate could only
// certify a quiet shot line. The resolving verdict's copy has to replace it.
import { describe, expect, it, vi } from "vitest";
import {
  LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S,
  LiveRunShared,
  applyDeferredGoalAttestations,
  attestationUsedForDeferredResolution,
  type DeferredGoalAttestationUpgrade,
  type LiveGoalAttestationUsed,
  type StoredSurfaceFields,
} from "../src/analyzer.js";
import { attestDeferredGoalHighlight, type LiveHighlightPersistence } from "../src/api.js";
import { Store } from "../src/store.js";
import { isPostableHighlight } from "../src/highlight-postable.js";
import type { HighlightRecord } from "@highlights/events";

const JOB = "c084bf83-661c-4ee0-bc74-387b5313e309";

/** What the demoted row actually stored: the copy gate's quiet line, produced
 *  while the score change was still unmeasured, plus the un-measuring
 *  acceptance. This is the state measured on `766dadb9`. */
const CELEBRATION_COPY = "Ball shoots in midfield.";
const DEMOTED_ATTESTATION_USED: LiveGoalAttestationUsed = {
  scoreBoardChanged: false,
  goalCrossed: false,
  ballOutcome: null,
  corroborated: false,
  goalConfirmed: null,
  scoreReads: 14,
  preSamples: 14,
  postSamples: 0,
  need: 2,
};

/** What the @165 s GOAL accept's write seam produced, with the transition
 *  measured: the scoring-lane line the suppressed second row would have carried. */
const RESOLVED_COPY: StoredSurfaceFields = {
  reason: "Scoreboard changes from 2-1 to 2-2 at t=-4.0s and ASR confirms goal.",
  caption: "Scoreboard changes from 2-1 to 2-2 at t=-4.0s and ASR confirms goal.",
  cardTitles: ["Scoreboard changes from 2-1 to 2-2 at t=-4.0s and ASR confirms goal."],
  reason_raw: "Scoreboard changes from 2-1 to 2-2 at t=-4.0s and ASR confirms goal.; scoreboard score change confirmed",
};

/** The measured attestation of the accept that resolved the transition. */
const RESOLVING_ATTESTATION_USED: LiveGoalAttestationUsed = {
  scoreBoardChanged: true,
  goalCrossed: false,
  ballOutcome: null,
  corroborated: false,
  goalConfirmed: null,
  scoreReads: 10,
  preSamples: 8,
  postSamples: 2,
  need: 2,
  transitionKey: "2-1>2-2",
};

function demotedGoalRow(overrides: Partial<HighlightRecord> = {}): HighlightRecord {
  return {
    id: "766dadb9",
    jobId: JOB,
    clipUri: "/clips/c084bf83-766dadb9.mp4",
    start: 150,
    end: 165,
    localizedTs: 161.7,
    localizeSignal: "trigger",
    eventType: "BIG_PLAY",
    score: 85,
    outcome: "big_play",
    reason: CELEBRATION_COPY,
    caption: CELEBRATION_COPY,
    cardTitles: [CELEBRATION_COPY],
    reason_raw: "Ball enters net at t=0.0s, confirmed by ASR 'gol' and crowd eruption.",
    attestationUsed: DEMOTED_ATTESTATION_USED,
    provisionalGoal: {
      status: "provisional",
      cues: ["asr_goal_call"],
      declaredTs: 160,
      note: "provisional goal: asr_goal_call in the judged window, no measured scoreboard change yet",
    },
    status: "accepted",
    createdAt: "2026-11-06T13:54:15.591Z",
    ...overrides,
  };
}

function promotion(overrides: Partial<DeferredGoalAttestationUpgrade> = {}): DeferredGoalAttestationUpgrade {
  const run = new LiveRunShared();
  run.noteDeferredGoalAttestation({
    highlightId: "766dadb9",
    jobId: JOB,
    lo: 150,
    hi: 160,
    anchorTs: 161.7,
    triggerKind: "score_change",
    reason: CELEBRATION_COPY,
    caption: CELEBRATION_COPY,
    cardTitles: [CELEBRATION_COPY],
    reasonRaw: "Ball enters net at t=0.0s, confirmed by ASR 'gol' and crowd eruption.",
  });
  const up = run.promoteDeferredGoalForAccept({
    delta: { pre: [2, 1], post: [2, 2], preTs: 159, postTs: 161, deltaTs: 161, preSamples: 3, postSamples: 2 },
    readAt: 165,
  });
  if (!up) throw new Error("promotion did not resolve");
  return { ...up, ...overrides } as DeferredGoalAttestationUpgrade;
}

describe("promoted GOAL copy + attestation (ADAAAA-8212)", () => {
  it("serves the resolving verdict's copy instead of the celebration copy", async () => {
    const store = new Store(null);
    await store.addHighlight(demotedGoalRow());
    expect(isPostableHighlight(store.getHighlight("766dadb9")!)).toBe(false);

    const up = promotion({ resolvedSurface: RESOLVED_COPY, attestationUsed: RESOLVING_ATTESTATION_USED });
    const persisted = await attestDeferredGoalHighlight({ store } as unknown as LiveHighlightPersistence, up);

    expect(persisted).not.toBeNull();
    const row = store.getHighlight("766dadb9")!;
    // The row/badge contract 8199 closed stays untouched: same id, same instant,
    // scoring lane, marker cleared, one postable row.
    expect(row.id).toBe("766dadb9");
    expect(row.localizedTs).toBe(161.7);
    expect(row.outcome).toBe("scoring_play");
    expect(row.eventType).toBe("GOAL");
    expect(row.provisionalGoal).toBeUndefined();
    expect(store.highlightsForJob(JOB).map((r) => r.id)).toEqual(["766dadb9"]);

    // Copy: the WHOLE surface is the resolving verdict's — reason, caption,
    // cardTitles, reason_raw move as one set, and no celebration copy survives.
    expect(row.reason).toBe(RESOLVED_COPY.reason);
    expect(row.caption).toBe(RESOLVED_COPY.caption);
    expect(row.cardTitles).toEqual(RESOLVED_COPY.cardTitles);
    expect(row.reason_raw).toBe(RESOLVED_COPY.reason_raw);
    expect(row.reason).not.toBe(CELEBRATION_COPY);
    expect(row.caption).not.toBe(CELEBRATION_COPY);
    expect((row.cardTitles ?? []).join(" ")).not.toContain("midfield");

    // Attestation: the MEASURED one that resolved the transition, not the
    // pre-promotion acceptance that measured nothing.
    expect(row.attestationUsed).toMatchObject({
      scoreBoardChanged: true,
      preSamples: 8,
      postSamples: 2,
      need: 2,
    });
    expect(row.attestationUsed).not.toEqual(DEMOTED_ATTESTATION_USED);
    // AUDIT: the read itself still rides the row.
    expect(row.deferredAttestation).toEqual({
      deltaTs: 161,
      readAt: 165,
      windowLo: 150,
      windowHi: 160,
      pre: [2, 1],
      post: [2, 2],
    });
    expect(up.lookaheadS).toBe(LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S);
    // Read side unchanged: the promoted row is the one postable GOAL.
    expect(isPostableHighlight(row)).toBe(true);
  });

  it("keeps the entry's scoring-lane copy when no resolving surface was derived", async () => {
    const store = new Store(null);
    await store.addHighlight(demotedGoalRow());
    const entryCopy = "ASR confirms 'remate gol' at t=0.0s.";
    const up = promotion({ reason: entryCopy, caption: undefined, cardTitles: undefined, attestationUsed: RESOLVING_ATTESTATION_USED });
    const persisted = await attestDeferredGoalHighlight({ store } as unknown as LiveHighlightPersistence, up);
    expect(persisted).not.toBeNull();
    const row = store.getHighlight("766dadb9")!;
    expect(row.reason).toBe(entryCopy);
    // The celebration card is CLEARED with the decision: a GOAL row never keeps
    // copy derived from the celebration verdict just because it has no new card.
    expect(row.caption).toBeUndefined();
    expect(row.cardTitles).toBeUndefined();
    expect(row.attestationUsed).toMatchObject({ scoreBoardChanged: true, postSamples: 2 });
  });

  it("never mixes surfaces: a resolved surface without a served line is ignored whole", async () => {
    const store = new Store(null);
    await store.addHighlight(demotedGoalRow());
    // A card-only derivation cannot be served as copy (no line), so the entry's
    // surface is used as ONE set — the stray card must not ride a GOAL row whose
    // served line came from another verdict.
    const entryLine = "ASR confirms 'remate gol' at t=0.0s.";
    const up = promotion({
      reason: entryLine,
      caption: entryLine,
      cardTitles: [entryLine],
      resolvedSurface: { caption: CELEBRATION_COPY, cardTitles: [CELEBRATION_COPY] },
      attestationUsed: RESOLVING_ATTESTATION_USED,
    });
    await attestDeferredGoalHighlight({ store } as unknown as LiveHighlightPersistence, up);
    const row = store.getHighlight("766dadb9")!;
    expect(row.reason).toBe(entryLine);
    expect(row.caption).toBe(entryLine);
    expect(row.cardTitles).toEqual([entryLine]);
  });

  it("does not delete the demoted disclosure when a promotion carries no attestation", async () => {
    const store = new Store(null);
    await store.addHighlight(demotedGoalRow());
    await attestDeferredGoalHighlight({ store } as unknown as LiveHighlightPersistence, promotion());
    const row = store.getHighlight("766dadb9")!;
    expect(row.outcome).toBe("scoring_play");
    expect(row.attestationUsed).toEqual(DEMOTED_ATTESTATION_USED);
  });
});

// ---------------------------------------------------------------------------
// The deferred (ADAAAA-8006) lane resolves on a later window's scoreboard read
// and has no accepting verdict, so copy stays the entry's gated surface (the copy
// contract owns servability). What it must refresh is the MEASUREMENT: a resolved
// GOAL otherwise keeps the demoted acceptance that measured nothing.
// ---------------------------------------------------------------------------

const DEFERRED_DELTA = {
  pre: [2, 1] as [number, number],
  post: [2, 2] as [number, number],
  preTs: 158,
  postTs: 158.667,
  deltaTs: 158.667,
  preSamples: 4,
  postSamples: 2,
};

function deferredEntry() {
  return {
    highlightId: "hl-8212",
    jobId: JOB,
    lo: 149,
    hi: 159,
    anchorTs: 159,
    triggerKind: "score_change",
    reason: CELEBRATION_COPY,
    caption: CELEBRATION_COPY,
    cardTitles: [CELEBRATION_COPY],
    reasonRaw: "Ball enters net at t=0.0s, confirmed by ASR 'gol' and crowd eruption.",
    scoreReads: { scoreReads: 14, preSamples: 14, postSamples: 0, need: 2 },
  };
}

describe("deferred-lane resolution attestation (ADAAAA-8212)", () => {
  it("stamps the measured attestation on the resolving read (never invents a channel)", () => {
    const used = attestationUsedForDeferredResolution({
      delta: DEFERRED_DELTA,
      scoreReads: { scoreReads: 14, preSamples: 14, postSamples: 0, need: 2 },
    });
    expect(used).toEqual({
      scoreBoardChanged: true,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
      // ADAAAA-8728 (R7): the resolving delta IS a measured scoreboard authority.
      authority: "scoreboard",
      scoreReads: 14,
      preSamples: 4,
      postSamples: 2,
      need: 2,
      transitionKey: "2-1>2-2",
      // ADAAAA-8663: the credited transition's own states ride beside the key, so
      // the promoted row is gradable from the stored record alone.
      transitionScore: { pre: [2, 1], post: [2, 2] },
    });
    // The measured side is the delta's; nothing about a ball line or the Stage-2
    // confirm dive is claimed.
    expect(used.postSamples).toBe(DEFERRED_DELTA.postSamples);
    expect(used.goalCrossed).toBe(false);
    expect(used.corroborated).toBe(false);
  });

  it("hands the persist hook the measured attestation and keeps the entry's gated copy", async () => {
    const store = new Store(null);
    await store.addHighlight({
      id: "hl-8212",
      jobId: JOB,
      clipUri: "/clips/c084bf83-hl-8212.mp4",
      start: 150,
      end: 165,
      localizedTs: 159,
      eventType: "BIG_PLAY",
      score: 85,
      outcome: "big_play",
      reason: CELEBRATION_COPY,
      caption: CELEBRATION_COPY,
      cardTitles: [CELEBRATION_COPY],
      attestationUsed: DEMOTED_ATTESTATION_USED,
      status: "accepted",
      createdAt: "2026-11-06T13:54:15.591Z",
    } as HighlightRecord);
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(deferredEntry());
    const seen: DeferredGoalAttestationUpgrade[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const count = applyDeferredGoalAttestations(
      run,
      {
        jobId: JOB,
        onDeferredGoalAttested: (up) => {
          seen.push(up);
          void attestDeferredGoalHighlight({ store } as unknown as LiveHighlightPersistence, up);
        },
      },
      { readAt: 162, delta: DEFERRED_DELTA }
    );
    spy.mockRestore();
    await new Promise((r) => setTimeout(r, 0));

    expect(count).toBe(1);
    expect(seen).toHaveLength(1);
    // No accepting verdict exists on this lane, and the copy contract
    // (ADAAAA-8027/8125/8209) owns servability: the seam does not re-derive copy.
    expect(seen[0].resolvedSurface).toBeUndefined();
    expect(seen[0].attestationUsed).toMatchObject({ scoreBoardChanged: true, postSamples: 2 });
    const row = store.getHighlight("hl-8212")!;
    expect(row.outcome).toBe("scoring_play");
    expect(row.reason).toBe(CELEBRATION_COPY);
    // The measurement the row discloses is the resolving one, not the demoted
    // acceptance that measured nothing.
    expect(row.attestationUsed).toMatchObject({ scoreBoardChanged: true, postSamples: 2, preSamples: 4 });
    expect(row.deferredAttestation).toMatchObject({ deltaTs: 158.667, readAt: 162, pre: [2, 1], post: [2, 2] });
  });
});

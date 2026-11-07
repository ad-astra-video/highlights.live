// ADAAAA-8239 (AV6 falsifier, ADAAAA-8236): a dive verdict must not promote a
// row on frame/vision corroboration alone when the SAME window's measured lane
// read no score transition.
//
// The measured failure this pins (job `8dd6a383`, build `8f10156`):
//   - a provisional celebration at content 29.4-44.4 s was accepted with
//     `scoreBoardChanged=false` and `postSamples 0` of `need 2` in its own
//     attestation;
//   - the async dive answered `confirmed_goal` / `corroborated=true` /
//     `corroborationSource=frame_attestation` with every non-visual signal
//     degraded (frames were the only witness) and `confirmDiveAdoption` promoted
//     it in place to a postable GOAL;
//   - the segment held exactly ONE goal (1-1 -> 2-1 at content ~93 s, score
//     attested). The prompt's own OCR reads `1-1` through 18.04 and `2-1` first
//     at 18.11, so a goal at 13:53 is impossible.
//
// The rule below keeps AV10 (same row, in-place patch, six attestation keys, one
// postable GOAL per transition) and AV11 (promotion debit 0) untouched: this
// ticket only decides WHICH lane a verdict may move a row into.
import { describe, expect, it } from "vitest";
import {
  NON_SCORE_CORROBORATION_SOURCES,
  confirmDiveAdoption,
  describeRowMeasurement,
  frameOnlyCorroborationNeedsTransition,
  rowMeasuredScoreTransition,
  type ConfirmDiveVerdict,
  type DegradedSignal,
} from "../src/live-confirm-async.js";
import { Store } from "../src/store.js";

const meta = {
  diveAt: "2026-11-06T21:20:11.263Z",
  diveLatencyMs: 42_000,
  // The falsifier's real context: every non-visual signal degraded, frames only.
  contextDegraded: ["motion_trajectories", "optical_flow", "audio_clip", "audio_levels"] as DegradedSignal[],
};

/** The accept-time attestation the falsifier row carried at accept. The five
 *  ADAAAA-8071 keys are required by the record schema; the ADAAAA-8134 counts are
 *  the ones the gate reads. */
const UNMEASURED = {
  scoreBoardChanged: false,
  goalCrossed: false,
  ballOutcome: null,
  corroborated: false,
  goalConfirmed: null,
  postSamples: 0,
  need: 2,
};
/** A window whose score read DID measure the transition. */
const MEASURED = {
  scoreBoardChanged: true,
  goalCrossed: false,
  ballOutcome: null,
  corroborated: false,
  goalConfirmed: null,
  postSamples: 2,
  need: 2,
};

const PROVISIONAL = {
  status: "provisional" as const,
  cues: ["asr_goal_call" as const],
  declaredTs: 36.9,
  note: "provisional goal: asr_goal_call in the judged window, no measured scoreboard change yet",
};

function frameVerdict(over: Partial<ConfirmDiveVerdict> = {}): ConfirmDiveVerdict {
  return { goalConfirmed: "confirmed_goal", corroborated: true, corroborationSource: "frame_attestation", ...over };
}

function provisionalRow(over: Record<string, unknown> = {}) {
  return {
    outcome: "big_play",
    eventType: "BIG_PLAY",
    provisionalGoal: { ...PROVISIONAL },
    attestationUsed: { ...UNMEASURED },
    ...over,
  };
}

describe("rowMeasuredScoreTransition — only a measurement counts", () => {
  it("accepts a scoreboard change read at accept time", () => {
    expect(rowMeasuredScoreTransition({ attestationUsed: MEASURED })).toBe(true);
  });

  it("accepts a deferred score read that recorded a real pre -> post delta", () => {
    expect(
      rowMeasuredScoreTransition({
        deferredAttestation: { deltaTs: 93.4, pre: [1, 1], post: [2, 1] },
      })
    ).toBe(true);
  });

  it("refuses a deferred attestation whose two sides are the same score", () => {
    expect(
      rowMeasuredScoreTransition({
        deferredAttestation: { deltaTs: 93.4, pre: [1, 1], post: [1, 1] },
      })
    ).toBe(false);
  });

  it("refuses a deferred attestation with no legible delta instant", () => {
    expect(rowMeasuredScoreTransition({ deferredAttestation: { pre: [1, 1], post: [2, 1] } as any })).toBe(false);
  });

  it("treats an absent attestation as unmeasured (absent evidence is never credited)", () => {
    expect(rowMeasuredScoreTransition({})).toBe(false);
    expect(rowMeasuredScoreTransition({ attestationUsed: { scoreBoardChanged: false, postSamples: 0, need: 2 } })).toBe(false);
  });
});

describe("frameOnlyCorroborationNeedsTransition — non-score sources only", () => {
  it("covers exactly the two non-score sources", () => {
    expect([...NON_SCORE_CORROBORATION_SOURCES]).toEqual(["frame_attestation", "audio_text"]);
  });

  it("requires a measurement for frame_attestation and audio_text", () => {
    expect(frameOnlyCorroborationNeedsTransition(provisionalRow(), frameVerdict())).toBe(true);
    expect(
      frameOnlyCorroborationNeedsTransition(provisionalRow(), frameVerdict({ corroborationSource: "audio_text" }))
    ).toBe(true);
  });

  it("never requires one for a scoreboard corroboration (the dive measured the score)", () => {
    expect(
      frameOnlyCorroborationNeedsTransition(provisionalRow(), frameVerdict({ corroborationSource: "scoreboard" }))
    ).toBe(false);
  });

  it("never fires on an uncorroborated verdict", () => {
    expect(
      frameOnlyCorroborationNeedsTransition(provisionalRow(), frameVerdict({ corroborated: false }))
    ).toBe(false);
  });
});

describe("confirmDiveAdoption — the AV6 falsifier case is NOT promoted", () => {
  it("holds a frame-only confirmed_goal over a window that measured no transition", () => {
    const a = confirmDiveAdoption(provisionalRow(), frameVerdict(), meta);
    expect(a.kind).toBe("refuted");
    // The row never enters the scoring lane -> never postable.
    expect(a.patch.outcome).toBeUndefined();
    expect(a.patch.eventType).toBeUndefined();
    // The badge the CEO sees is kept, and says WHY it is still provisional.
    expect(a.patch.provisionalGoal).toMatchObject({ status: "provisional", refuted: true });
    expect((a.patch.provisionalGoal as any).note).toMatch(/no score transition/i);
    expect((a.patch.provisionalGoal as any).note).toMatch(/postSamples=0/);
    expect(a.reason).toMatch(/no measured score transition/i);
    // The attempt stays observable and the descriptor is settled (no re-dive).
    expect(a.patch.pendingConfirmDive).toBeUndefined();
    expect(a.patch.confirmAttestation).toMatchObject({
      goalConfirmed: "confirmed_goal",
      corroborated: true,
      corroborationSource: "frame_attestation",
    });
  });

  it("holds an audio_text corroboration the same way", () => {
    const a = confirmDiveAdoption(provisionalRow(), frameVerdict({ corroborationSource: "audio_text" }), meta);
    expect(a.kind).toBe("refuted");
    expect(a.patch.outcome).toBeUndefined();
    expect((a.patch.confirmAttestation as any).corroborationSource).toBe("audio_text");
  });

  it("keeps the six AV10 attestation keys and touches no billing/quota field", () => {
    const a = confirmDiveAdoption(provisionalRow(), frameVerdict(), meta);
    expect(Object.keys(a.patch.confirmAttestation as object).sort()).toEqual(
      ["contextDegraded", "corroborated", "corroborationSource", "diveAt", "diveLatencyMs", "goalConfirmed"].sort()
    );
    // AV11: a promotion/refusal never bills. No quota/billing key may appear.
    for (const k of ["costUsd", "quota", "moment", "billing", "chargedDeferred", "confirmCalls"]) {
      expect(a.patch).not.toHaveProperty(k);
    }
  });

  it("HOLDS instead of promoting even when the rows' postSamples met the legibility bar", () => {
    // Legible reads on both sides that saw no change are a measured
    // NON-transition: still not promotable on frames alone.
    const a = confirmDiveAdoption(
      provisionalRow({ attestationUsed: { scoreBoardChanged: false, postSamples: 2, need: 2 } }),
      frameVerdict(),
      meta
    );
    expect(a.kind).toBe("refuted");
    expect(a.patch.outcome).toBeUndefined();
  });

  it("leaves the row a celebration when it carries no provisional marker", () => {
    const row = { outcome: "big_play", eventType: "BIG_PLAY", attestationUsed: { ...UNMEASURED } };
    const a = confirmDiveAdoption(row, frameVerdict(), meta);
    expect(a.kind).toBe("unchanged");
    expect(a.patch.outcome).toBeUndefined();
    expect(a.patch.provisionalGoal).toBeUndefined(); // never fabricate a marker to refute
    expect(a.reason).toMatch(/held/i);
  });
});

describe("confirmDiveAdoption — a MEASURED transition still promotes in place", () => {
  it("promotes on the same row when the accept already measured the change", () => {
    const a = confirmDiveAdoption(provisionalRow({ attestationUsed: { ...MEASURED } }), frameVerdict(), meta);
    expect(a.kind).toBe("promoted");
    expect(a.patch).toMatchObject({
      outcome: "scoring_play",
      eventType: "GOAL",
      provisionalGoal: undefined,
      pendingConfirmDive: undefined,
    });
    // Never an insert: the patch carries no row identity.
    expect(a.patch.id).toBeUndefined();
    expect(a.patch.jobId).toBeUndefined();
  });

  it("promotes when a deferred score read recorded the transition", () => {
    const a = confirmDiveAdoption(
      provisionalRow({ deferredAttestation: { deltaTs: 93.4, readAt: 96, windowLo: 90, windowHi: 100, pre: [1, 1], post: [2, 1] } }),
      frameVerdict(),
      meta
    );
    expect(a.kind).toBe("promoted");
    expect(a.patch.outcome).toBe("scoring_play");
  });

  it("leaves the scoreboard-corroborated path byte-identical (no new proof needed)", () => {
    const a = confirmDiveAdoption(
      provisionalRow({ attestationUsed: { ...UNMEASURED } }),
      frameVerdict({ corroborationSource: "scoreboard" }),
      meta
    );
    expect(a.kind).toBe("promoted");
    expect(a.patch.outcome).toBe("scoring_play");
  });
});

describe("Store — the held row keeps its clip and never becomes postable (AV10/AV11)", () => {
  async function seededStore() {
    const store = new Store();
    const job = await store.createJob({ source: "file", sourceUrl: "/tmp/live-8239.mp4", gameHint: "soccer" });
    await store.addHighlight({
      id: "h-8239",
      jobId: job.id,
      clipUri: "/clips/h-8239.mp4",
      start: 24,
      end: 54,
      status: "accepted",
      score: 84,
      outcome: "big_play",
      eventType: "BIG_PLAY",
      reason: "the players celebrate with arms raised | provisional goal: asr_goal_call",
      provisionalGoal: { ...PROVISIONAL },
      attestationUsed: { ...UNMEASURED },
      createdAt: new Date().toISOString(),
    } as any);
    return { store, job };
  }

  it("keeps the falsifier row a celebration with its clip, and leaves the row count unchanged", async () => {
    const { store, job } = await seededStore();
    const before = store.highlightsForJob(job.id).length;

    const adoption = confirmDiveAdoption(store.getHighlight("h-8239") as any, frameVerdict(), meta);
    const moved = await store.attestDeferredGoal("h-8239", adoption.patch as any);

    expect(moved.id).toBe("h-8239");
    expect(moved.outcome).toBe("big_play");
    expect(moved.eventType).toBe("BIG_PLAY");
    expect(moved.clipUri).toBe("/clips/h-8239.mp4");
    expect(moved.provisionalGoal?.status).toBe("provisional");
    expect(moved.provisionalGoal?.refuted).toBe(true);
    expect(moved.confirmAttestation?.corroborationSource).toBe("frame_attestation");
    expect(moved.pendingConfirmDive).toBeUndefined();
    expect(store.highlightsForJob(job.id).length).toBe(before);
  });

  it("still promotes the SAME row when the window measured the transition", async () => {
    const { store, job } = await seededStore();
    await store.attestDeferredGoal("h-8239", { attestationUsed: { ...MEASURED } } as any);
    const before = store.highlightsForJob(job.id).length;

    const adoption = confirmDiveAdoption(store.getHighlight("h-8239") as any, frameVerdict(), meta);
    const moved = await store.attestDeferredGoal("h-8239", adoption.patch as any);

    expect(adoption.kind).toBe("promoted");
    expect(moved.id).toBe("h-8239");
    expect(moved.outcome).toBe("scoring_play");
    expect(moved.eventType).toBe("GOAL");
    expect(moved.provisionalGoal).toBeUndefined();
    expect(store.highlightsForJob(job.id).length).toBe(before);
  });
});

describe("describeRowMeasurement — the hold reason is gradable from the reason alone", () => {
  it("renders the falsifier row's own attestation", () => {
    expect(describeRowMeasurement({ attestationUsed: { ...UNMEASURED } })).toBe(
      "scoreBoardChanged=false, postSamples=0, need=2"
    );
  });

  it("names an absent attestation instead of implying a measurement", () => {
    expect(describeRowMeasurement({})).toBe("scoreBoardChanged=false, postSamples=absent, need=absent");
  });
});

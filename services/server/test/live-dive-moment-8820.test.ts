// ADAAAA-8820 (D2/AC2.1, AC2.2, AC2.4) — the Stage-2 dive NAMES THE CLIP MOMENT
// and the deferred cut re-anchors on it.
//
// The approved spec (§4/§5) asks for three things this file pins at the contract
// seam, so a live grade is reading a real mechanism rather than prose:
//
//   1. `/confirm` carries `momentTs` (nullable) + `momentConfidence` on every
//      verdict, and the dive is SENT a labelled frame grid (frames[].ts) to name
//      a moment against — an unlabelled request can name nothing;
//   2. the verdict's moment is stamped on the row (`confirmAttestation.momentTs`)
//      so the deferred cut and a grader both read it off the row, INCLUDING
//      through the zod parse that has silently stripped new keys before
//      (ADAAAA-8242/8647 class);
//   3. the re-anchor gate is ONE function (`diveReanchorDecision`) shared by the
//      browser re-cut, the ingest deferred cut and the fixture harness: only a
//      `confirmed_goal`, only a real drift >= 1 s, and never a celebration-tail
//      card (ADAAAA-8714 keeps the cue at the end).
import { describe, expect, it } from "vitest";
import { ConfirmRecordSchema, HighlightRecordSchema } from "@highlights/events";
import { Store } from "../src/store";
import {
  DIVE_REANCHOR_MIN_DRIFT_S,
  buildPersistedConfirmContext,
  confirmDiveAdoption,
  diveReanchorDecision,
  momentOf,
} from "../src/live-confirm-async";

/** A permissive row for the adoption writer: promoted celebration + measured
 *  attestation, so a corroborated confirmed_goal promotes through the normal arm. */
function row(over: Record<string, unknown> = {}) {
  return {
    outcome: "big_play",
    eventType: "CELEBRATION",
    start: 40,
    end: 55,
    provisionalGoal: { status: "provisional" },
    attestationUsed: { scoreBoardChanged: true },
    ...over,
  };
}

function verdict(over: Record<string, unknown> = {}) {
  return {
    goalConfirmed: "confirmed_goal" as const,
    corroborated: true,
    corroborationSource: "scoreboard" as const,
    momentTs: 47.5,
    momentConfidence: 0.82,
    ...over,
  };
}

const META = { diveAt: "2026-11-12T00:00:00.000Z", diveLatencyMs: 2100, contextDegraded: [] as string[] };

// --- (1) the contract -------------------------------------------------------

describe("momentOf — a nullable moment is never invented", () => {
  it("carries a finite, non-negative instant", () => {
    expect(momentOf({ momentTs: 47.5 })).toBe(47.5);
    expect(momentOf({ momentTs: 0 })).toBe(0);
  });

  it("treats null / absent / nonsense as 'no moment named'", () => {
    expect(momentOf({ momentTs: null })).toBeNull();
    expect(momentOf({})).toBeNull();
    expect(momentOf({ momentTs: Number.NaN })).toBeNull();
    expect(momentOf({ momentTs: -1 })).toBeNull();
    expect(momentOf(undefined)).toBeNull();
  });
});

describe("the dive is sent a labelled frame grid", () => {
  it("labels every sampled frame with its content instant", () => {
    const frames = [
      { seq: 1, ts: 40.0, base64: "a" },
      { seq: 2, ts: 40.75, base64: "b" },
      { seq: 3, ts: 41.5, base64: "c" },
      { seq: 4, ts: 42.25, base64: "d" },
    ];
    const ctx = buildPersistedConfirmContext({ frames, eventTs: 41.5, maxFrames: 12 });
    expect(ctx.frames.length).toBeGreaterThan(0);
    for (const f of ctx.frames) {
      expect(typeof f.ts).toBe("number");
      expect(f.ts).toBeGreaterThan(0);
    }
    // the grid is the inventory the dive was shown — not a re-derivation
    const sent = new Set(ctx.frames.map((f) => f.ts));
    for (const f of ctx.frameWindow) expect(sent.has(f.ts)).toBe(true);
  });
});

// --- (2) the verdict stamps the moment on the row ---------------------------

describe("confirmDiveAdoption stamps the dive moment", () => {
  it("records momentTs + momentConfidence on a promoted row", () => {
    const adoption = confirmDiveAdoption(row() as any, verdict() as any, META);
    expect(adoption.kind).toBe("promoted");
    expect((adoption.patch.confirmAttestation as any).momentTs).toBe(47.5);
    expect((adoption.patch.confirmAttestation as any).momentConfidence).toBe(0.82);
  });

  it("omits the moment when the dive named none", () => {
    const adoption = confirmDiveAdoption(row() as any, verdict({ momentTs: null, momentConfidence: 0 }) as any, META);
    const att = adoption.patch.confirmAttestation as any;
    expect(att.momentTs).toBeUndefined();
    expect(att.momentConfidence).toBeUndefined();
  });

  it("keeps the moment on a refutation (the contract carries it on every verdict)", () => {
    const adoption = confirmDiveAdoption(
      row() as any,
      verdict({ goalConfirmed: "near_miss", corroborated: false, momentTs: 44.0 }) as any,
      META
    );
    expect(adoption.kind).toBe("refuted");
    expect((adoption.patch.confirmAttestation as any).momentTs).toBe(44.0);
  });

  it("clamps a nonsense confidence instead of persisting it", () => {
    const adoption = confirmDiveAdoption(row() as any, verdict({ momentConfidence: 3 }) as any, META);
    expect((adoption.patch.confirmAttestation as any).momentConfidence).toBe(1);
  });
});

// --- the zod-strip guard (ADAAAA-8242/8647 class) ---------------------------

describe("the row schema keeps the moment and the anchor source", () => {
  const base = {
    id: "hl-8820",
    ownerId: "owner",
    jobId: "job",
    start: 40,
    end: 55,
    clipUri: "/clips/job-400.mp4",
    eventType: "GOAL",
    score: 88,
    reason: "a striker finishes low past the keeper",
    outcome: "scoring_play",
    status: "accepted",
    createdAt: "2026-11-12T00:00:00.000Z",
  };

  it("keeps confirmAttestation.momentTs / momentConfidence through the parse", () => {
    const rec = HighlightRecordSchema.parse({
      ...base,
      confirmAttestation: {
        goalConfirmed: "confirmed_goal",
        corroborated: true,
        corroborationSource: "scoreboard",
        diveAt: "2026-11-12T00:00:00.000Z",
        diveLatencyMs: 2100,
        contextDegraded: [],
        momentTs: 47.5,
        momentConfidence: 0.82,
      },
    });
    expect((rec.confirmAttestation as any)?.momentTs).toBe(47.5);
    expect((rec.confirmAttestation as any)?.momentConfidence).toBe(0.82);
  });

  it("keeps the dive anchor audit fields through the parse", () => {
    const rec = HighlightRecordSchema.parse({
      ...base,
      clipAnchorSource: "dive",
      clipAnchorDiveMomentTs: 47.5,
      clipAnchorDiveLagSec: -2.125,
      clipAnchorDiveConfidence: 0.82,
    });
    expect(rec.clipAnchorSource).toBe("dive");
    expect(rec.clipAnchorDiveMomentTs).toBe(47.5);
    expect(rec.clipAnchorDiveLagSec).toBeCloseTo(-2.125, 6);
    expect(rec.clipAnchorDiveConfidence).toBe(0.82);
  });

  it("keeps the moment on the stored confirm-audit verdict", () => {
    const rec = ConfirmRecordSchema.parse({
      request: { prompt: "p" },
      decision: { goalConfirmed: "confirmed_goal", momentTs: 47.5, momentConfidence: 0.82 },
    });
    expect((rec.decision as any).momentTs).toBe(47.5);
    expect((rec.decision as any).momentConfidence).toBe(0.82);
  });
});

describe("the write path persists the dive anchor (not just the builder)", () => {
  it("patches clipAnchorSource + the dive moment onto the stored row", async () => {
    const store = new Store();
    const rec = HighlightRecordSchema.parse({
      id: "hl-8820-store",
      ownerId: "owner",
      jobId: "job",
      start: 40,
      end: 55,
      clipUri: "/clips/job-400.mp4",
      eventType: "GOAL",
      score: 88,
      reason: "a striker finishes low past the keeper",
      outcome: "scoring_play",
      status: "accepted",
      createdAt: "2026-11-12T00:00:00.000Z",
    });
    await store.addHighlight(rec);
    const patched = await store.patchHighlight(rec.id, {
      clipAnchorSource: "dive",
      clipAnchorDiveMomentTs: 47.5,
      clipAnchorDiveLagSec: -2.125,
      clipAnchorDiveConfidence: 0.82,
      clipAnchorMethod: "frame_match",
      clipAnchorEvidenceTs: 47.5,
    } as any);
    expect(patched.clipAnchorSource).toBe("dive");
    expect(patched.clipAnchorDiveMomentTs).toBe(47.5);
    expect(patched.clipAnchorDiveLagSec).toBeCloseTo(-2.125, 6);
    // persisted, not just returned: a re-read carries the same fields.
    const again = store.getHighlight(rec.id);
    expect(again?.clipAnchorSource).toBe("dive");
  });
});

// --- (3) the re-anchor gate -------------------------------------------------

describe("diveReanchorDecision — when may a dive move the clip anchor", () => {
  it("moves it on a confirmed_goal whose moment drifted >= 1 s", () => {
    const d = diveReanchorDecision({ goalConfirmed: "confirmed_goal", momentTs: 47.5, acceptTs: 45.0 });
    expect(d.apply).toBe(true);
    expect(d.driftSec).toBeCloseTo(2.5, 6);
  });

  it("also moves it when the drift is negative (the dive is earlier than the accept)", () => {
    const d = diveReanchorDecision({ goalConfirmed: "confirmed_goal", momentTs: 43.0, acceptTs: 45.0 });
    expect(d.apply).toBe(true);
    expect(d.driftSec).toBeCloseTo(-2.0, 6);
  });

  it("refuses a drift under the bar (the accept anchor is already good enough)", () => {
    const d = diveReanchorDecision({
      goalConfirmed: "confirmed_goal",
      momentTs: 45.5,
      acceptTs: 45.0,
    });
    expect(d.apply).toBe(false);
    expect(Math.abs(d.driftSec as number)).toBeLessThan(DIVE_REANCHOR_MIN_DRIFT_S);
  });

  it("re-anchors exactly at the bar, never below it", () => {
    expect(diveReanchorDecision({ goalConfirmed: "confirmed_goal", momentTs: 46, acceptTs: 45 }).apply).toBe(true);
    expect(diveReanchorDecision({ goalConfirmed: "confirmed_goal", momentTs: 45.99, acceptTs: 45 }).apply).toBe(false);
  });

  it("never moves a card that is not a confirmed goal", () => {
    for (const g of ["near_miss", "not_goal", null, undefined]) {
      expect(diveReanchorDecision({ goalConfirmed: g as any, momentTs: 47.5, acceptTs: 45 }).apply).toBe(false);
    }
  });

  it("never moves a celebration-tail card (the cue stays the card's end)", () => {
    const d = diveReanchorDecision({ goalConfirmed: "confirmed_goal", momentTs: 47.5, acceptTs: 45, cueTail: true });
    expect(d.apply).toBe(false);
  });

  it("moves it when there is no accept anchor to compare against, and says the drift is unknown", () => {
    const d = diveReanchorDecision({ goalConfirmed: "confirmed_goal", momentTs: 47.5, acceptTs: null });
    expect(d.apply).toBe(true);
    expect(d.driftSec).toBeNull();
  });

  it("refuses when the dive named no moment", () => {
    expect(diveReanchorDecision({ goalConfirmed: "confirmed_goal", momentTs: null, acceptTs: 45 }).apply).toBe(false);
  });
});

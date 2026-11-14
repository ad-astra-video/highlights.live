// ADAAAA-8965 (D4-live, increment 1) — the LIVE half of D4, on stored state only.
//
// Three things this increment owns, and each is pinned below with zero decide
// calls, zero GPU and zero deploy:
//
//   (1) TRIGGER, LIVE ARM. A promoted row whose goal already carries a MEASURED
//       attestation enters the dive lane on the live rail. Before D4 the live arm
//       of `shouldRunConfirm()` returned false for exactly that row (census
//       ADAAAA-8892: 5/5 un-dived promoted rows were `measured_attestation`, and
//       the live share was 1/2 and 3/5 on the newest live legs). The VOD arm is
//       untouched here — ADAAAA-8966 owns it.
//   (2) SKIP REASON ON EVERY CARD WITH NO VERDICT. `not_promoted`,
//       `merged_duplicate` and `alternative_not_highlight` are the three ways a
//       SERVED row can carry no verdict at all; each now publishes a reason
//       instead of shipping no `confirmation` block, so the AC4.1 census has no
//       indistinguishable "we forgot" row.
//   (3) PRECISION GUARD, READ SIDE. On a measured row the dive may add the moment
//       only: it may not move the lane off `measured` and may not invent a skip
//       reason for a dive that actually ran (`laneKeptByMeasurement`).
import { describe, expect, it } from "vitest";
import {
  ConfirmationSkipReasonSchema,
  HighlightConfirmationSchema,
  JobCandidateSchema,
  type JobCandidate,
  type WindowAnalysis,
} from "@highlights/events";
import { shouldRunConfirm, type AnalyzerConfig, type DecisionResult } from "../src/analyzer";
import { confirmationForHighlightRow, noVerdictConfirmation } from "../src/confirmation-lane";

/** A promoted, goal-shaped, MEASURED accept: the population D4-live adds. */
const MEASURED_GOAL: DecisionResult = {
  isHighlight: true,
  score: 88,
  eventType: "GOAL",
  outcome: "scoring_play",
  reason: "scoreboard went 1-0 between the posts",
};

/** The accept gate saw the scoreboard change itself (the D1 row-gate shape). */
const MEASURED_CANDIDATE = {
  eventType: "GOAL",
  goalCrossed: true,
  scoreBoardChanged: true,
  ballOutcome: "goal",
  timestamp: 40,
};

function liveCfg(): AnalyzerConfig {
  return { confirmEnabled: true, liveObserveLoop: true } as unknown as AnalyzerConfig;
}
function vodCfg(): AnalyzerConfig {
  return { confirmEnabled: true, decideWindowN: 3 } as unknown as AnalyzerConfig;
}

function cand(over: Partial<Omit<JobCandidate, "jobId" | "createdAt">> & { timestamp: number }): JobCandidate {
  return JobCandidateSchema.parse({
    id: `c-${over.timestamp}`,
    jobId: "job-1",
    seq: 0,
    eventType: "GOAL",
    score: 90,
    isHighlight: true,
    status: "accepted",
    createdAt: "2026-11-13T00:00:00.000Z",
    ...over,
  });
}

function analysisWith(criteria: Record<string, boolean | null>): WindowAnalysis {
  return {
    prompt: "p",
    dataItems: [],
    frames: [],
    images: [],
    response: { isHighlight: true, score: 85, outcome: "scoring_play", verdict: { criteria } },
  } as unknown as WindowAnalysis;
}

describe("D4-live (1) — the live trigger no longer skips a measured row", () => {
  it("a measured promoted row DIVES on the live rail", () => {
    expect(shouldRunConfirm(liveCfg(), MEASURED_CANDIDATE, MEASURED_GOAL)).toBe(true);
  });

  it("the VOD arm rides the SAME predicate — it dives too, which is why ADAAAA-8966 replays it", () => {
    // D4 landed as ONE predicate for both rails (analyzer.ts `shouldRunConfirm`:
    // "One predicate for the live and VOD rails, so the two do not diverge again").
    // This increment owns only the LIVE proof; the VOD replay is ADAAAA-8966.
    expect(shouldRunConfirm(vodCfg(), MEASURED_CANDIDATE, MEASURED_GOAL)).toBe(true);
  });

  it("a promoted row that measured NOTHING still dives on both rails (D1 unchanged)", () => {
    const bare = { eventType: "GOAL", timestamp: 12 };
    expect(shouldRunConfirm(liveCfg(), bare, MEASURED_GOAL)).toBe(true);
    expect(shouldRunConfirm(vodCfg(), bare, MEASURED_GOAL)).toBe(true);
  });

  it("confirm disabled is still a strict no-op", () => {
    const off = { ...liveCfg(), confirmEnabled: false } as AnalyzerConfig;
    expect(shouldRunConfirm(off, MEASURED_CANDIDATE, MEASURED_GOAL)).toBe(false);
  });
});

describe("D4-live (2) — a card with no verdict NAMES its reason", () => {
  it("the contract accepts the three no-verdict reasons", () => {
    for (const reason of ["not_promoted", "merged_duplicate", "alternative_not_highlight"] as const) {
      expect(ConfirmationSkipReasonSchema.parse(reason)).toBe(reason);
      expect(HighlightConfirmationSchema.parse(noVerdictConfirmation(reason)).skipReason).toBe(reason);
    }
  });

  it("a served card ALWAYS names a reason — the AC4.1 property, every status × candidate pair", () => {
    const withTrigger = cand({ timestamp: 40, trigger: { kind: "score_change", eventType: "AUDIO_BURST", timestamp: 40, scoreBoardChanged: true } as never });
    const bare = cand({ timestamp: 41 });
    for (const status of ["accepted", "pending", "rejected"] as const) {
      for (const candidate of [withTrigger, bare, undefined]) {
        const conf = confirmationForHighlightRow({ status, trigger: candidate?.trigger }, candidate, { confirmEnabled: true });
        expect(conf, `${status}/${candidate ? "candidate" : "no candidate"}`).toBeDefined();
        expect(typeof conf?.skipReason === "string" && conf.skipReason.length > 0).toBe(true);
      }
    }
  });

  it("a rejected card carrying a goal-shaped candidate states its own reason, never silence", () => {
    const bare = cand({ timestamp: 40 });
    const conf = confirmationForHighlightRow({ status: "rejected", trigger: bare.trigger }, bare, { confirmEnabled: true });
    expect(conf?.lane).toBe("unconfirmed");
    // The derivation reaches the evidence-free `not_goal_shaped` sentence; the
    // point of the AC is that a reason EXISTS, not which of the named ones wins.
    expect(conf?.skipReason).toBe("not_goal_shaped");
  });

  it("a merged duplicate with no derivable lane states merged_duplicate", () => {
    const conf = confirmationForHighlightRow({ status: "rejected" }, undefined, {
      confirmEnabled: true,
      cardKind: "merged_duplicate",
    });
    expect(conf?.lane).toBe("unconfirmed");
    expect(conf?.skipReason).toBe("merged_duplicate");
  });

  it("a row that never became a card states not_promoted", () => {
    const conf = confirmationForHighlightRow({ status: "rejected" }, undefined, { confirmEnabled: true });
    expect(conf?.lane).toBe("unconfirmed");
    expect(conf?.skipReason).toBe("not_promoted");
  });

  it("a row served as its moment's alternative states alternative_not_highlight", () => {
    const conf = confirmationForHighlightRow({ status: "rejected" }, undefined, {
      confirmEnabled: true,
      cardKind: "alternative_not_highlight",
    });
    expect(conf?.lane).toBe("unconfirmed");
    expect(conf?.skipReason).toBe("alternative_not_highlight");
  });
});

describe("D4-live (3) — the precision guard keeps a measured row's lane", () => {
  it("a measured row dived by D4 serves lane measured, adds the moment, and claims no skip", () => {
    const measured = cand({ timestamp: 50, analysis: analysisWith({ scoreboardChanged: true }) });
    const conf = confirmationForHighlightRow(
      {
        status: "accepted",
        trigger: measured.trigger,
        confirmAttestation: {
          goalConfirmed: "near_miss",
          corroborated: false,
          laneKeptByMeasurement: true,
          momentTs: 51.5,
        },
      },
      measured,
      { confirmEnabled: true }
    );
    expect(conf?.lane).toBe("measured");
    // the dive RAN on this row — a skip reason would be a false claim
    expect(conf).not.toHaveProperty("skipReason");
  });

  it("the same row WITHOUT the guard flag keeps the D3 precedence byte-identically", () => {
    const measured = cand({ timestamp: 60, analysis: analysisWith({ scoreboardChanged: true }) });
    const conf = confirmationForHighlightRow(
      { status: "accepted", trigger: measured.trigger, confirmAttestation: { goalConfirmed: "near_miss", corroborated: false } },
      measured,
      { confirmEnabled: true }
    );
    expect(conf?.lane).toBe("dive_disagreed");
  });
});

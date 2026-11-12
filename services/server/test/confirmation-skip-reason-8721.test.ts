// ADAAAA-8721 (D3) — a served card that carries no dive badge now NAMES why the
// Stage-2 dive did not run. Before this, four different honest cases all read as
// "confirmation did not happen" to the operator:
//
//   measured_attestation  the window measured its own evidence, so
//                         `shouldRunConfirm()` deliberately skipped the dive
//   not_goal_shaped       the read was not a goal (or a requested near-miss /
//                         big-play highlight), so no dive was ever requested
//   dive_disabled         the lane is off in config (`cfg.confirmEnabled`)
//   dropped:<cause>       a dive WAS requested and dropped fail-closed, and the
//                         row stores the cause on `confirmAttestation.dropReason`
//
// Every case below is derived from ALREADY-PERSISTED state: no decide call, no
// embedding, no GPU (AC3.1's "$0" bar), and no field invented when the reader has
// no config at hand.
import { describe, expect, it } from "vitest";
import { HighlightConfirmationSchema, JobCandidateSchema, type JobCandidate, type WindowAnalysis } from "@highlights/events";
import {
  confirmationForHighlightRow,
  deriveConfirmation,
  servedConfirmation,
} from "../src/confirmation-lane";

function cand(over: Partial<Omit<JobCandidate, "jobId" | "createdAt">> & { timestamp: number }): JobCandidate {
  return JobCandidateSchema.parse({
    id: `c-${over.timestamp}`,
    jobId: "job-1",
    seq: 0,
    eventType: "GOAL",
    score: 90,
    isHighlight: true,
    status: "accepted",
    createdAt: "2026-11-10T00:00:00.000Z",
    ...over,
  });
}

/** A stored Stage-1 verdict carrying the measured criteria block. */
function analysisWith(criteria: Record<string, boolean | null>): WindowAnalysis {
  return {
    prompt: "p",
    dataItems: [],
    frames: [],
    images: [],
    response: {
      isHighlight: true,
      score: 85,
      outcome: "scoring_play",
      verdict: { criteria },
    },
  } as unknown as WindowAnalysis;
}

const MEASURED = cand({ timestamp: 10, analysis: analysisWith({ scoreboardChanged: true }) });
const BARE = cand({ timestamp: 40 });

describe("D3 — the skip reason names WHY no dive ran (0 decide calls, 0 GPU)", () => {
  it("a measured window names measured_attestation", () => {
    const conf = confirmationForHighlightRow({ status: "accepted", trigger: MEASURED.trigger }, MEASURED, {
      confirmEnabled: true,
    });
    expect(conf?.lane).toBe("measured");
    expect(conf?.skipReason).toBe("measured_attestation");
  });

  it("a lane that is off in config names dive_disabled", () => {
    const conf = confirmationForHighlightRow({ status: "accepted", trigger: BARE.trigger }, BARE, {
      confirmEnabled: false,
    });
    expect(conf?.lane).toBe("unconfirmed");
    expect(conf?.skipReason).toBe("dive_disabled");
  });

  it("an enabled lane on an unmeasured, un-dived window names not_goal_shaped", () => {
    const conf = confirmationForHighlightRow({ status: "accepted", trigger: BARE.trigger }, BARE, {
      confirmEnabled: true,
    });
    expect(conf?.lane).toBe("unconfirmed");
    expect(conf?.skipReason).toBe("not_goal_shaped");
  });

  it("a stored drop cause wins over every other reason", () => {
    const row = {
      status: "accepted" as const,
      confirmAttestation: { goalConfirmed: "dropped", corroborated: false, dropReason: "pool_busy" },
    };
    const conf = confirmationForHighlightRow(row, BARE, { confirmEnabled: true });
    expect(conf?.lane).toBe("unconfirmed");
    expect(conf?.skipReason).toBe("dropped:pool_busy");
  });

  it("normalises a dropped cause that still carries a :detail suffix", () => {
    const row = {
      status: "accepted" as const,
      confirmAttestation: { goalConfirmed: "dropped", corroborated: false, dropReason: "timeout:waited=12s" },
    };
    expect(confirmationForHighlightRow(row, BARE)?.skipReason).toBe("dropped:timeout");
  });

  it("omits the reason (never guesses) when the reader has no config at hand", () => {
    const conf = confirmationForHighlightRow({ status: "accepted", trigger: BARE.trigger }, BARE);
    expect(conf?.lane).toBe("unconfirmed");
    expect(conf).not.toHaveProperty("skipReason");
  });

  it("a pending (unapproved) card still states its lane AND its skip reason", () => {
    const conf = confirmationForHighlightRow({ status: "pending", trigger: BARE.trigger } as any, BARE, {
      confirmEnabled: false,
    });
    expect(conf?.lane).toBe("unconfirmed");
    expect(conf?.skipReason).toBe("dive_disabled");
  });
});

describe("D3 — a dive that RAN is its own answer (no skip reason)", () => {
  const dive = (goalConfirmed: "confirmed_goal" | "near_miss") =>
    ({
      request: { prompt: "p", dataItems: [], frames: [], keyframes: [], trajectories: [], audioLevels: [] },
      decision: {
        enabled: true,
        goalConfirmed,
        confidence: 0.8,
        reason: "r",
        evidence: { ballInNet: true, audioErupted: true, scoreboardChanged: true, sustainedScoringMotion: true, ballTrajectoryCrossedLine: true },
        stage1Disagreed: false,
      },
    }) as any;

  it("a corroborated dive carries no skip reason", () => {
    const c = cand({ timestamp: 20, analysis: analysisWith({}), confirm: dive("confirmed_goal") });
    const conf = confirmationForHighlightRow({ status: "accepted", trigger: c.trigger }, c, { confirmEnabled: true });
    expect(conf?.lane).toBe("dive");
    expect(conf).not.toHaveProperty("skipReason");
  });

  it("a disagreeing dive carries no skip reason", () => {
    const c = cand({ timestamp: 30, analysis: analysisWith({}), confirm: dive("near_miss") });
    const conf = confirmationForHighlightRow({ status: "accepted", trigger: c.trigger }, c, { confirmEnabled: true });
    expect(conf?.lane).toBe("dive_disagreed");
    expect(conf).not.toHaveProperty("skipReason");
  });

  it("a HELD row carries no skip reason", () => {
    const conf = confirmationForHighlightRow(
      { status: "accepted", provisionalGoal: { held: true } } as any,
      BARE,
      { confirmEnabled: true }
    );
    expect(conf?.lane).toBe("dive_held");
    expect(conf).not.toHaveProperty("skipReason");
  });
});

describe("D3 — the served projection carries the reason and still leaks no inspector state", () => {
  it("servedConfirmation keeps lane + label + skipReason and drops flags/dive", () => {
    const note = deriveConfirmation({ ...MEASURED, confirmEnabled: true } as any)!;
    expect(note.flags).toBeDefined();
    const served = servedConfirmation(note)!;
    expect(served).toEqual({ lane: "measured", label: note.label, skipReason: "measured_attestation" });
    expect(JSON.stringify(served)).not.toContain("corroborated");
  });

  it("the served shape validates against the published contract", () => {
    const conf = confirmationForHighlightRow({ status: "accepted", trigger: BARE.trigger }, BARE, {
      confirmEnabled: true,
    });
    expect(HighlightConfirmationSchema.parse(conf)).toEqual(conf);
  });

  it("the contract refuses a free-text skip reason", () => {
    expect(() => HighlightConfirmationSchema.parse({ lane: "unconfirmed", label: "x", skipReason: "because" })).toThrow();
    expect(() =>
      HighlightConfirmationSchema.parse({ lane: "unconfirmed", label: "x", skipReason: "dropped:pool_busy" })
    ).not.toThrow();
  });
});

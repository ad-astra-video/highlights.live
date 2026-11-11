import { describe, expect, it } from "vitest";
import { DecideNoteSchema, JobCandidateSchema, type ConfirmRecord, type JobCandidate, type WindowAnalysis } from "@highlights/events";
import { deriveConfirmation, confirmationForHighlightRow, diveVerdictFromAttestation, scoreTransitionDetail } from "../src/confirmation-lane";
import { buildSections, stripWindowInspection, type Section } from "../src/job-detail";

// ADAAAA-8287: the row must state WHICH lane confirmed a highlight — a measured
// attestation (lane 1, which stores no confirm record by design) or the Stage-2
// deep dive (lane 2, the only lane that writes a confirm block). Grade the
// derivation and the strip gate over stored shapes, not over narratives.

function cand(over: Partial<Omit<JobCandidate, "jobId" | "createdAt">> & { timestamp: number }): JobCandidate {
  return JobCandidateSchema.parse({
    id: `c-${over.timestamp}`,
    jobId: "job-1",
    seq: 0,
    eventType: "GOAL",
    score: 90,
    isHighlight: true,
    status: "accepted",
    createdAt: "2026-11-07T14:33:33.408Z",
    ...over,
  });
}

/** A stored per-window analysis whose Stage-1 verdict carries the measured
 *  criteria block (the decide layer's I1 rationale) + the cited attestation. */
function analysisWith(
  criteria: Partial<Record<"ballCrossedLineBetweenPosts" | "ballInNet" | "scoreboardChanged" | "crowdErupted", boolean | null>>,
  evidenceAttested: string[] = []
): WindowAnalysis {
  return {
    prompt: "You are a sports highlight judge",
    dataItems: [{ type: "scoreboard", label: "Scoreboard score change", value: "yes" }],
    frames: [],
    images: [],
    response: {
      isHighlight: true,
      score: 85,
      outcome: "scoring_play",
      evidenceAttested,
      verdict: {
        criteria: {
          ballCrossedLineBetweenPosts: null,
          ballInNet: null,
          scoreboardChanged: null,
          crowdErupted: null,
          ...criteria,
        },
        hypothesis: "SPORTING_EVENT",
        independentlyObserved: null,
        contradictedBy: null,
      },
    },
  };
}

const confirmedDive = (
  over: { goalConfirmed?: "confirmed_goal" | "near_miss" | "not_goal"; outcome?: ConfirmRecord["decision"]["outcome"] } = {}
): ConfirmRecord => ({
  request: {
    prompt: "You are a sports highlight CONFIRMATION judge",
    dataItems: [],
    frames: [],
    keyframes: [],
    trajectories: [],
    audioLevels: [],
  },
  decision: {
    enabled: true,
    goalConfirmed: over.goalConfirmed ?? "confirmed_goal",
    confidence: 1,
    reason: "ball in the net + scoreboard update",
    evidence: {
      ballInNet: true,
      audioErupted: true,
      scoreboardChanged: true,
      sustainedScoringMotion: true,
      ballTrajectoryCrossedLine: true,
    },
    stage1Disagreed: false,
    outcome: over.outcome ?? "scoring_play",
  },
});

describe("deriveConfirmation — lane 1 (measured attestation)", () => {
  it("names the measured score transition the row cites, with no confirm record (AC1)", () => {
    const c = cand({
      timestamp: 120,
      trigger: { kind: "score_change", timestamp: 120, eventType: "GOAL", scoreBoardChanged: true },
      analysis: analysisWith({ scoreboardChanged: true, crowdErupted: true }, ["Scoreboard change 0-0 to 0-1 at 04:47"]),
    });
    const lane = deriveConfirmation(c)!;
    expect(lane.lane).toBe("measured");
    expect(lane.measurement).toBe("score");
    expect(lane.label).toBe("Confirmed by measured score: 0-0 → 0-1 at 04:47");
    expect(lane.flags).toEqual({
      scoreboardChanged: true,
      ballCrossedLineBetweenPosts: null,
      ballInNet: null,
      crowdErupted: true,
    });
    expect(lane.flagsSource).toBe("stage1_verdict");
    // lane 1 stores NO dive → no confirm block → no confirm panel (AC4 gate).
    expect(c.confirm).toBeUndefined();
    expect(lane.dive).toBeUndefined();
  });

  it("names the goal line and ball-in-net channels", () => {
    const line = deriveConfirmation(cand({ timestamp: 351, trigger: { kind: "goal_line", timestamp: 351, eventType: "GOAL", goalCrossed: true } }))!;
    expect(line.lane).toBe("measured");
    expect(line.measurement).toBe("goal_line");
    expect(line.label).toContain("ball crossed the line between posts");

    const net = deriveConfirmation(cand({ timestamp: 352, analysis: analysisWith({ ballInNet: true }) }))!;
    expect(net.measurement).toBe("ball_in_net");
    expect(net.label).toBe("Confirmed by ball in net");
  });

  it("falls back to a plain score-change sentence when the store cites no transition", () => {
    const lane = deriveConfirmation(cand({ timestamp: 130, trigger: { kind: "score_change", timestamp: 130, eventType: "GOAL", scoreBoardChanged: true } }))!;
    expect(lane.label).toBe("Confirmed by measured score change");
    expect(lane.detail).toBeUndefined();
  });

  it("does not invent a transition from unrelated prose", () => {
    expect(
      scoreTransitionDetail(analysisWith({ scoreboardChanged: true }, ["the crowd surged", "a goal was scored"]))
    ).toBeUndefined();
  });
});

describe("deriveConfirmation — lane 2 (Stage-2 dive)", () => {
  it("reads 'Confirmed by deep dive (Stage-2)' and carries the dive verdict + evidence flags", () => {
    const lane = deriveConfirmation(
      cand({ timestamp: 117, trigger: { kind: "motion", timestamp: 117, eventType: "SPORTING_EVENT" }, confirm: confirmedDive() })
    )!;
    expect(lane.lane).toBe("dive");
    expect(lane.label).toBe("Confirmed by deep dive (Stage-2)");
    expect(lane.measurement).toBe("dive");
    expect(lane.dive).toMatchObject({ goalConfirmed: "confirmed_goal", confidence: 1, stage1Disagreed: false, corroborated: true });
    expect(lane.flags).toEqual({
      scoreboardChanged: true,
      ballCrossedLineBetweenPosts: true,
      ballInNet: true,
      crowdErupted: true,
    });
    expect(lane.flagsSource).toBe("dive_evidence");
  });
});

describe("deriveConfirmation — demotions never read as confirmed (AC2)", () => {
  it("a disagreeing dive reads 'dive did not corroborate' and never a lane-1 label", () => {
    const lane = deriveConfirmation(
      cand({
        timestamp: 200,
        status: "rejected",
        outcome: "near_miss",
        isHighlight: false,
        analysis: analysisWith({ scoreboardChanged: true }),
        confirm: confirmedDive({ goalConfirmed: "not_goal", outcome: "near_miss" }),
      })
    )!;
    expect(lane.lane).toBe("dive_disagreed");
    expect(lane.label).toBe("dive did not corroborate");
    expect(lane.label).not.toMatch(/Confirmed by/);
    expect(lane.dive).toMatchObject({ goalConfirmed: "not_goal", corroborated: false });
  });

  it("the disagreeing dive wins over a measured signal on the same row", () => {
    const lane = deriveConfirmation(
      cand({
        timestamp: 201,
        status: "rejected",
        outcome: "near_miss",
        trigger: { kind: "score_change", timestamp: 201, eventType: "GOAL", scoreBoardChanged: true },
        confirm: confirmedDive({ goalConfirmed: "near_miss", outcome: "near_miss" }),
      })
    )!;
    expect(lane.lane).toBe("dive_disagreed");
    expect(lane.measurement).toBe("none");
  });

  it("a plain near-miss with no dive gets no confirmation block at all", () => {
    expect(deriveConfirmation(cand({ timestamp: 210, status: "rejected", outcome: "near_miss", isHighlight: false }))).toBeUndefined();
  });
});

describe("deriveConfirmation — accepted with neither lane", () => {
  it("says so honestly instead of claiming a lane", () => {
    const withCapture = deriveConfirmation(
      cand({
        timestamp: 300,
        eventType: "BIG_PLAY",
        outcome: "big_play",
        analysis: analysisWith({ scoreboardChanged: false, ballInNet: false, crowdErupted: true }),
      })
    )!;
    expect(withCapture.lane).toBe("unconfirmed");
    expect(withCapture.label).toBe("Accepted without corroboration — no measurement and no dive");

    const legacy = deriveConfirmation(cand({ timestamp: 301, eventType: "BIG_PLAY", outcome: "big_play" }))!;
    expect(legacy.lane).toBe("unconfirmed");
    expect(legacy.label).toContain("lane not recorded");
  });
});

describe("buildSections + stripWindowInspection (AC1 / AC3 / AC4)", () => {
  // The reference shape of a real VOD job: 12 lane-1 accepts (score-attested,
  // no dive) + 12 dive-confirmed accepts + 2 demotions from a disagreeing dive.
  const candidates: JobCandidate[] = [
    ...Array.from({ length: 12 }, (_, i) =>
      cand({
        timestamp: 120 + i * 30,
        trigger: { kind: "score_change", timestamp: 120 + i * 30, eventType: "GOAL", scoreBoardChanged: true },
        analysis: analysisWith({ scoreboardChanged: true }, [`Scoreboard change ${i}-0 to ${i + 1}-0 at 04:4${i % 10}`]),
      })
    ),
    ...Array.from({ length: 12 }, (_, i) =>
      cand({
        timestamp: 600 + i * 30,
        trigger: { kind: "motion", timestamp: 600 + i * 30, eventType: "SPORTING_EVENT" },
        confirm: confirmedDive(),
      })
    ),
    cand({
      timestamp: 900,
      status: "rejected",
      outcome: "near_miss",
      isHighlight: false,
      confirm: confirmedDive({ goalConfirmed: "not_goal", outcome: "near_miss" }),
    }),
    cand({
      timestamp: 930,
      status: "rejected",
      outcome: "near_miss",
      isHighlight: false,
      confirm: confirmedDive({ goalConfirmed: "near_miss", outcome: "near_miss" }),
    }),
  ];

  it("labels EVERY accepted row exactly once, and the label count equals the accepted count (AC1)", () => {
    const notes = buildSections([], candidates, "job-1").flatMap((s) => s.decideNotes);
    const accepted = notes.filter((n) => n.status === "accepted");
    const labelled = accepted.filter((n) => typeof n.confirmation?.label === "string" && n.confirmation.label.trim().length > 0);
    expect(accepted).toHaveLength(24);
    expect(labelled).toHaveLength(accepted.length);
    // every accepted row states exactly ONE lane, and lane 1 vs lane 2 are distinguishable
    const lanes = accepted.map((n) => n.confirmation!.lane);
    expect(new Set(lanes)).toEqual(new Set(["measured", "dive"]));
    expect(lanes.filter((l) => l === "measured")).toHaveLength(12);
    expect(lanes.filter((l) => l === "dive")).toHaveLength(12);
  });

  it("demotions read 'dive did not corroborate' and never a lane-1 label (AC2)", () => {
    const notes = buildSections([], candidates, "job-1").flatMap((s) => s.decideNotes);
    const demotions = notes.filter((n) => n.status === "rejected" && n.confirmation);
    expect(demotions).toHaveLength(2);
    for (const n of demotions) {
      expect(n.confirmation!.lane).toBe("dive_disagreed");
      expect(n.confirmation!.label).toBe("dive did not corroborate");
    }
  });

  it("keeps the lane on the row-level payload and gates only the raw attestation (AC3)", () => {
    const full = buildSections([], candidates, "job-1");
    const stripped = stripWindowInspection(full);
    const fullNotes = full.flatMap((s) => s.decideNotes);
    const strippedNotes = stripped.flatMap((s) => s.decideNotes);
    expect(fullNotes).toHaveLength(strippedNotes.length);
    strippedNotes.forEach((n, i) => {
      // row-level half survives the gate
      expect(n.confirmation?.lane).toBe(fullNotes[i].confirmation?.lane);
      expect(n.confirmation?.label).toBe(fullNotes[i].confirmation?.label);
      // inspector half is gated exactly like analysis/confirm
      expect(n.confirmation?.flags).toBeUndefined();
      expect(n.confirmation?.dive).toBeUndefined();
      expect(n.analysis).toBeUndefined();
      expect(n.confirm).toBeUndefined();
    });
    // the lane-1 notes carry flags only on the inspect payload
    expect(fullNotes[0].confirmation?.flags?.scoreboardChanged).toBe(true);
  });

  it("never synthesizes a confirm block for a lane-1 row (AC4 — panel stays dive-only)", () => {
    const notes = buildSections([], candidates, "job-1").flatMap((s) => s.decideNotes);
    const lane1 = notes.filter((n) => n.confirmation?.lane === "measured");
    expect(lane1.length).toBeGreaterThan(0);
    for (const n of lane1) expect(n.confirm).toBeUndefined();
    const dive = notes.filter((n) => n.confirmation?.lane === "dive");
    for (const n of dive) expect(n.confirm).toBeDefined();
  });

  it("survives the job-detail contract parse (the schema must not strip the label)", () => {
    const notes = buildSections([], candidates, "job-1").flatMap((s) => s.decideNotes);
    // NOTE: type the parse through THIS worktree's Section (the shared
    // `node_modules/@highlights/events` symlink points at a peer worktree's
    // packages copy, so tsc sees a pre-8287 DecideNote type while vitest resolves
    // the local src — the runtime assertion is the one that matters).
    const parsed: Section["decideNotes"][number] = DecideNoteSchema.parse(notes[0]);
    expect(parsed.confirmation?.lane).toBe("measured");
    expect(parsed.confirmation?.label).toBe(notes[0].confirmation?.label);
  });
});

// ADAAAA-8647: the dive verdict is stamped on the HIGHLIGHT row
// (`confirmAttestation`) while `job_candidates` stores NO confirm record
// (`has_confirm=false` on the graded job f02ec0bf). The served derivation must
// read the row's own attestation, or a dive-refuted row falls through to the
// candidate's measured lane and serves the same CONFIRMED badge as an attested
// row — the measured defect on row 85a89562.
describe("confirmationForHighlightRow — the row's own stored dive (ADAAAA-8647)", () => {
  /** The candidate of the refuted row: accepted, with a measured score
   *  attestation but NO confirm record (the real stored shape). */
  const measuredCandidate = () =>
    cand({
      timestamp: 100.533,
      trigger: { kind: "score_change", timestamp: 100.533, eventType: "GOAL", scoreBoardChanged: true },
      analysis: analysisWith({ scoreboardChanged: true, crowdErupted: true }, ["Scoreboard change 1-1 to 2-1 at 01:40"]),
    });

  it("serves dive_disagreed on a scoring row whose stored dive refuted it (the pre-fix lane was measured)", () => {
    const candidate = measuredCandidate();
    // Pre-fix read: the candidate alone has no dive, so lane 1 wins.
    expect(deriveConfirmation(candidate)?.lane).toBe("measured");
    const served = confirmationForHighlightRow(
      {
        status: "accepted",
        confirmAttestation: { goalConfirmed: "not_goal", corroborated: false },
      },
      candidate
    );
    expect(served?.lane).toBe("dive_disagreed");
    expect(served?.label).toBe("dive did not corroborate");
    // The projection carries lane + label only (no inspector half).
    expect(Object.keys(served ?? {}).sort()).toEqual(["label", "lane"]);
  });

  it("serves dive_disagreed for a `confirmed_goal` the dive could NOT corroborate", () => {
    expect(
      confirmationForHighlightRow(
        { status: "accepted", confirmAttestation: { goalConfirmed: "confirmed_goal", corroborated: false } },
        measuredCandidate()
      )?.lane
    ).toBe("dive_disagreed");
  });

  it("a HELD row still serves dive_held even when its attestation corroborated", () => {
    const held = confirmationForHighlightRow(
      {
        status: "accepted",
        provisionalGoal: { held: true, refuted: false },
        confirmAttestation: { goalConfirmed: "confirmed_goal", corroborated: true },
      },
      undefined
    );
    expect(held?.lane).toBe("dive_held");
  });

  it("a corroborated dive serves lane 2 (dive), never lane 1", () => {
    const served = confirmationForHighlightRow(
      { status: "accepted", confirmAttestation: { goalConfirmed: "confirmed_goal", corroborated: true } },
      measuredCandidate()
    );
    expect(served?.lane).toBe("dive");
    expect(served?.label).toBe("Confirmed by deep dive (Stage-2)");
  });

  it("a DROPPED dive (no verdict) does not refute: the measured lane stands", () => {
    for (const goalConfirmed of ["dropped", "passthrough"]) {
      const served = confirmationForHighlightRow(
        { status: "accepted", confirmAttestation: { goalConfirmed, corroborated: false } },
        measuredCandidate()
      );
      expect(served?.lane).toBe("measured");
    }
    expect(diveVerdictFromAttestation({ goalConfirmed: "dropped", corroborated: false })).toBeUndefined();
    expect(diveVerdictFromAttestation(null)).toBeUndefined();
  });

  it("a row with no stored dive keeps its candidate-derived lane (no regression)", () => {
    expect(confirmationForHighlightRow({ status: "accepted" }, measuredCandidate())?.lane).toBe("measured");
  });
});

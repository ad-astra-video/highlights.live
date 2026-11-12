// ADAAAA-8831 (AC9/AC10): a served `postTitle` may not assert an action with no
// attested actor.
//
// Found on live leg `27bd816f` (served build `fedc717f`, 2 promoted rows, both
// GOAL): the card's headline read `Midfielder scores` / `Defender scores` while
// the rows' attested evidence was `[clock, score, action]` with
// `actors=["Barcelona"]` and `bodyNamesAttestedActor=false`. A role noun is not a
// name, so the write seam's name gate had nothing to refuse and the read seam's
// S3 had nothing to contradict — the headline credited a score to nobody, twice.
//
// The bar added here is the same at both seams (`postTitleViolations` and
// `servedPostTitleViolations`, which `projectPostTitle` uses), and the fallback is
// the deterministic non-asserting title the contract already defines.
import { describe, expect, it } from "vitest";
import {
  deterministicPostTitle,
  gatePostTitleDetail,
  postTitleActorMissing,
  projectPostTitle,
  servedPostTitleViolations,
  type PostTitleRow,
} from "../src/post-title";

/** The job's persisted matchContext: the resolver folded Barcelona into `teams`
 *  and left Real Madrid in the attribution trail (scorebug `RMA2-2 BAR`). */
const JOB_CONTEXT = {
  sport: "soccer",
  teams: [{ name: "Barcelona", side: "away", confidence: 0.5 }],
  trail: [
    { names: [{ name: "Barcelona", side: "away", confidence: 0.5 }] },
    { names: [{ name: "Real Madrid", side: "home", confidence: 0.5 }] },
  ],
};

/** Row `8d521507` of job `27bd816f`, rebuilt from its stored record. */
const ROW_8D52: PostTitleRow = {
  postTitle: "Midfielder scores",
  caption: "The scoreboard changes to 2-1 at t=0.0 and ASR confirms a goal.",
  reason: "The scoreboard changes to 2-1 at t=0.0 and ASR confirms a goal.",
  eventType: "GOAL",
  outcome: "scoring_play",
  localizedTs: 102.59500002861023,
};

/** Row `a4827973` of the same job. */
const ROW_A482: PostTitleRow = {
  postTitle: "Defender scores",
  caption: "Ball enters net at t=-1.0s, scoreboard changes to 2-2, and crowd erupts.",
  reason: "Ball enters net at t=-1.0s, scoreboard changes to 2-2, and crowd erupts.",
  eventType: "GOAL",
  outcome: "scoring_play",
  localizedTs: 163.12599992752075,
};

describe("ADAAAA-8831 AC10 — a role-noun subject is never a served title", () => {
  it("refuses `Midfielder scores` on the served row and serves `GOAL · 1:42`", () => {
    expect(postTitleActorMissing("Midfielder scores")).toBe(true);
    expect(servedPostTitleViolations("Midfielder scores", ROW_8D52)).toContain("unattested-actor");
    // The row's own copy names no team, so the deterministic title carries none.
    expect(projectPostTitle(ROW_8D52)).toBe("GOAL · 1:42");
  });

  it("refuses `Defender scores` on the second served row", () => {
    expect(postTitleActorMissing("Defender scores")).toBe(true);
    expect(servedPostTitleViolations("Defender scores", ROW_A482)).toContain("unattested-actor");
    expect(projectPostTitle(ROW_A482)).toBe("GOAL · 2:43");
  });

  it("refuses a determiner role subject with a non-claim verb too", () => {
    expect(postTitleActorMissing("The defender clears it")).toBe(true);
    expect(postTitleActorMissing("Goalkeeper holds ball")).toBe(true);
  });

  it("is the WRITE seam's bar as well, so the row lands on the fallback", () => {
    // An empty prompt also fails the goal-claim gate closed (no attestation), so
    // the union names both; the actor bar is the new one.
    const decision = gatePostTitleDetail("Midfielder scores", { promptText: "" });
    expect(decision.title).toBeNull();
    expect(decision.violations).toContain("unattested-actor");
    expect(decision.gate).toContain("refused:unattested-actor");
  });
});

describe("ADAAAA-8831 AC9 — a claim needs the actor it credits", () => {
  it("documents the boundary: a subjectless claim is not this bar", () => {
    // The bar is the measured SHAPE (a role-noun subject). A claim with no
    // subject ("Scores from close range") is left to the shipped name gate, which
    // reads a sentence-initial capital as a possible proper name; catching that
    // class needs a product decision, not a second lexicon.
    expect(postTitleActorMissing("Scores from close range")).toBe(false);
    expect(postTitleActorMissing("Equaliser for the home side")).toBe(false);
  });

  it("keeps a jersey number: it IS the actor (no regression on the 8405 bar)", () => {
    expect(postTitleActorMissing("No. 7 scores")).toBe(false);
    const row: PostTitleRow = { ...ROW_8D52, postTitle: "No. 7 scores", caption: "No. 7 scores at the far post." };
    expect(servedPostTitleViolations("No. 7 scores", row)).toEqual([]);
    expect(projectPostTitle(row)).toBe("No. 7 scores");
  });

  it("keeps a named actor even when a role noun also appears", () => {
    const row: PostTitleRow = {
      ...ROW_8D52,
      postTitle: "Barcelona midfielder scores",
      caption: "Barcelona midfielder scores after the scoreboard changes.",
    };
    expect(postTitleActorMissing("Barcelona midfielder scores")).toBe(false);
    // The name still has to clear the provenance gate (S3) — unchanged here.
    expect(servedPostTitleViolations("Barcelona midfielder scores", row)).toEqual([]);
    expect(projectPostTitle(row)).toBe("Barcelona midfielder scores");
  });

  it("never touches copy that asserts no action", () => {
    expect(postTitleActorMissing("Crowd erupts")).toBe(false);
    expect(postTitleActorMissing("Player falls in box")).toBe(false);
  });

  it("does not refuse the deterministic LABEL · m:ss title", () => {
    // The fallback never passes through the violation gate, but if a row stores
    // one this bar must not be what re-derives it.
    expect(postTitleActorMissing("GOAL · 1:42")).toBe(false);
    expect(postTitleActorMissing("BIG PLAY · 4:21")).toBe(false);
  });

  it("names the attested team in the fallback when the row's copy names exactly one", () => {
    const row: PostTitleRow = { ...ROW_8D52, postTitle: "Midfielder scores", caption: "Barcelona score from the corner." };
    expect(projectPostTitle(row, { subject: "Barcelona" })).toBe(
      deterministicPostTitle({ eventType: "GOAL", outcome: "scoring_play", windowTs: 102.59500002861023, subject: "Barcelona" })
    );
    expect(projectPostTitle(row, { subject: "Barcelona" })).toBe("GOAL · 1:42 · Barcelona");
  });
});

describe("ADAAAA-8831 — a trail-named team is a name the gate can ground", () => {
  it("accepts a title that names a team the match context trail measured", () => {
    // `Real Madrid` is in the trail but never in `teams`; the prompt carries it.
    const decision = gatePostTitleDetail("Real Madrid midfielder scores", {
      verdict: "scoring_play",
      promptText: "Teams: Barcelona\nReal Madrid\nscore 2-1",
    });
    expect(decision.title).toBe("Real Madrid midfielder scores");
    expect(decision.violations).toEqual([]);
  });
});

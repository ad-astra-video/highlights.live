// ADAAAA-8318 (ADAAAA-8302 Option 2): the post-title contract.
//
// AC9 says the deterministic function is unit-tested and re-rendering the same
// stored row yields a byte-identical title. The cases below are the contract's
// own bars (<= 60 target / 70 hard reject / <= 10 words, one clause, no place
// chain, no clock prefix, no trailing period) plus the grounding refusals the
// write seam applies to a model title.
import { describe, it, expect } from "vitest";
import {
  POST_TITLE_HARD_MAX_CHARS,
  POST_TITLE_MAX_WORDS,
  POST_TITLE_TARGET_CHARS,
  FALLBACK_TITLE_MAX_CHARS,
  cleanPostTitle,
  deterministicPostTitle,
  gatePostTitleValue,
  postTitleClock,
  postTitleLabel,
  postTitleShapeViolations,
  postTitleTeamSubject,
  projectPostTitle,
} from "../src/post-title";

describe("deterministicPostTitle (the legacy / fallback title)", () => {
  it("builds LABEL · m:ss · subject from stored facts", () => {
    expect(
      deterministicPostTitle({ eventType: "GOAL", windowTs: 72, subject: "Real Madrid" })
    ).toBe("GOAL · 1:12 · Real Madrid");
    expect(deterministicPostTitle({ eventType: "SHOT", windowTs: 109 })).toBe("SHOT · 1:49");
    expect(deterministicPostTitle({ eventType: "BIG_PLAY", windowTs: 261 })).toBe("BIG PLAY · 4:21");
  });

  it("is pure: the same row renders byte-identically every time (AC9)", () => {
    const row = { eventType: "NEAR_MISS", outcome: "near_miss", localizedTs: 109.9, start: 100 };
    const a = projectPostTitle(row);
    const b = projectPostTitle({ ...row });
    const c = projectPostTitle(row, { subject: "Ordoñez" });
    expect(a).toBe(b);
    expect(a).toBe("NEAR MISS · 1:49");
    expect(c).toBe("NEAR MISS · 1:49 · Ordoñez");
  });

  it("never returns an empty title, even with no stored facts at all", () => {
    const title = deterministicPostTitle({});
    expect(title.length).toBeGreaterThan(0);
    expect(title).toBe("HIGHLIGHT");
  });

  it("drops an over-long subject whole instead of cutting mid-word", () => {
    const title = deterministicPostTitle({
      eventType: "GOAL",
      windowTs: 72,
      subject: "Club Atletico River Plate Reserves",
    });
    expect(title).toBe("GOAL · 1:12");
    expect(title.length).toBeLessThanOrEqual(FALLBACK_TITLE_MAX_CHARS);
  });

  it("stays <= 40 chars for every label/clock/subject combination", () => {
    const labels = ["GOAL", "SHOT", "BIG_PLAY", "NEAR_MISS", "SPORTING_EVENT", "CELEBRATION"];
    for (const eventType of labels) {
      for (const windowTs of [0, 4, 72, 109, 261, 3600]) {
        for (const subject of [null, "Real Madrid", "Ordoñez", "Bayern Munich II"]) {
          const title = deterministicPostTitle({ eventType, windowTs, subject });
          expect(title.length).toBeGreaterThan(0);
          expect(title.length).toBeLessThanOrEqual(FALLBACK_TITLE_MAX_CHARS);
          expect(title).toBe(title.trim());
          expect(title).not.toMatch(/[.!?]$/);
        }
      }
    }
  });

  it("labels from the verdict taxonomy when the event type is a code", () => {
    expect(postTitleLabel("SPORTING_EVENT")).toBe("BIG PLAY");
    expect(postTitleLabel(undefined, "scoring_play")).toBe("GOAL");
    expect(postTitleLabel(undefined, "near_miss")).toBe("NEAR MISS");
    expect(postTitleLabel("UNKNOWN_ENUM")).toBe("UNKNOWN ENUM");
    expect(postTitleLabel(undefined, undefined)).toBe("HIGHLIGHT");
  });

  it("formats the window clock as m:ss and refuses a bad ts", () => {
    expect(postTitleClock(72)).toBe("1:12");
    expect(postTitleClock(4.8)).toBe("0:04");
    expect(postTitleClock(null)).toBe("");
    expect(postTitleClock(-3)).toBe("");
  });
});

describe("postTitle shape bar (AC2)", () => {
  it("accepts a clean one-clause title", () => {
    for (const title of [
      "Ordoñez strikes early",
      "No. 9 heads it wide",
      "Real Madrid double their lead",
    ]) {
      expect(postTitleShapeViolations(title)).toEqual([]);
    }
  });

  it("refuses a second clause / em-dash continuation", () => {
    expect(postTitleShapeViolations("Ordoñez shoots — the crowd erupts")).toContain("second-clause");
    expect(postTitleShapeViolations("The No. 9 drives forward; the bench rises")).toContain("second-clause");
  });

  it("refuses a place chain", () => {
    expect(postTitleShapeViolations("Ordoñez shoots in the penalty area")).toContain("place-chain");
    expect(postTitleShapeViolations("The winger breaks on the right")).toContain("place-chain");
  });

  it("refuses a clock prefix", () => {
    expect(cleanPostTitle("T+72s — Real Madrid score")).toBe("Real Madrid score");
    expect(cleanPostTitle("T+ 1:12 — Real Madrid score")).toBe("Real Madrid score");
  });

  it("strips a trailing period and internal tokens but keeps the words", () => {
    expect(cleanPostTitle("Ordoñez strikes early.")).toBe("Ordoñez strikes early");
    expect(cleanPostTitle("Real Madrid [scoreboard 2-1] double their lead")).toBe(
      "Real Madrid double their lead"
    );
  });

  it("refuses over-long and over-worded titles", () => {
    const long = "a".repeat(POST_TITLE_HARD_MAX_CHARS + 1);
    expect(postTitleShapeViolations(long)).toContain("too-long");
    expect(postTitleShapeViolations("one two three four five six seven eight nine ten eleven")).toContain(
      "too-many-words"
    );
    // the target is 60 but 61..70 is still served (hard reject is >70)
    const atTarget = "x".repeat(POST_TITLE_TARGET_CHARS);
    expect(postTitleShapeViolations(atTarget)).toEqual([]);
    expect(atTarget.split(/\s+/).length).toBeLessThanOrEqual(POST_TITLE_MAX_WORDS);
  });
});

describe("gatePostTitleValue (the write seam)", () => {
  const ctx = { verdict: "big_play", promptText: "Real Madrid vs Barcelona, Ordoñez on the ball" };

  it("keeps a grounded, shape-clean model title", () => {
    expect(gatePostTitleValue("Ordoñez strikes early", ctx)).toBe("Ordoñez strikes early");
  });

  it("refuses a goal claim on a non-scoring verdict", () => {
    expect(gatePostTitleValue("Ordoñez scores the opener", ctx)).toBeNull();
  });

  it("refuses an invented name", () => {
    expect(gatePostTitleValue("Mbappé strikes from close range", ctx)).toBeNull();
  });

  // ADAAAA-8356 SUPERSEDES the 8318 expectation here: a shape violation is now
  // repaired by DELETION (a trailing place phrase / a second clause), and the
  // repaired form must still pass every evidence gate. The bar this test holds is
  // the one that matters: nothing is served that the raw title was refused for.
  it("repairs a shape violation by deletion, never by rewriting", () => {
    expect(gatePostTitleValue("Ordoñez shoots in the penalty area", ctx)).toBe("Ordoñez shoots");
    // a trim that cannot clear the bars still refuses (the card falls back)
    expect(gatePostTitleValue("Mbappé scores in the penalty area", ctx)).toBeNull();
    expect(gatePostTitleValue("Player carries ball in midfield", ctx)).toBe("Player carries ball");
    expect(gatePostTitleValue("", ctx)).toBeNull();
  });

  it("allows a goal claim when the verdict is a confirmed goal", () => {
    const goalCtx = {
      verdict: "scoring_play",
      corroborated: true,
      promptText: "Real Madrid vs Barcelona, Ordoñez on the ball, GOL",
    };
    expect(gatePostTitleValue("Ordoñez scores the opener", goalCtx)).toBe("Ordoñez scores the opener");
  });
});

describe("projectPostTitle (read-time projection)", () => {
  it("serves a stored clean title byte-for-byte", () => {
    expect(
      projectPostTitle({ postTitle: "Ordoñez strikes early", eventType: "GOAL", localizedTs: 72 })
    ).toBe("Ordoñez strikes early");
  });

  it("falls back deterministically for a legacy row with no title", () => {
    const row = {
      eventType: "GOAL",
      outcome: "scoring_play",
      localizedTs: 72,
      caption: "Real Madrid double their lead.",
      start: 65,
    };
    expect(projectPostTitle(row)).toBe("GOAL · 1:12");
    expect(projectPostTitle(row, { subject: "Real Madrid" })).toBe("GOAL · 1:12 · Real Madrid");
  });

  it("falls back for a stored title that fails the shape bar", () => {
    expect(
      projectPostTitle({
        postTitle: "Ordoñez shoots in the penalty area",
        eventType: "SHOT",
        localizedTs: 109,
      })
    ).toBe("SHOT · 1:49");
    expect(projectPostTitle({ postTitle: "   ", eventType: "GOAL", start: 261 })).toBe("GOAL · 4:21");
  });

  it("uses the window instant (localizedTs) before the clip start", () => {
    expect(projectPostTitle({ eventType: "GOAL", localizedTs: 109, start: 100 })).toBe("GOAL · 1:49");
    expect(projectPostTitle({ eventType: "GOAL", start: 100 })).toBe("GOAL · 1:40");
  });
});

describe("postTitleTeamSubject (names only from stored facts, AC5)", () => {
  const ctx = { teams: [{ name: "Real Madrid" }, { name: "Barcelona" }] };

  it("returns the one team the row's own copy names", () => {
    expect(postTitleTeamSubject({ caption: "Real Madrid double their lead." }, ctx)).toBe("Real Madrid");
    expect(postTitleTeamSubject({ reason: "Barça press high", caption: "Barcelona press high." }, ctx)).toBe(
      "Barcelona"
    );
  });

  it("returns nothing when the copy names no team, both teams, or the context is absent", () => {
    expect(postTitleTeamSubject({ caption: "The No. 9 heads it wide." }, ctx)).toBe("");
    expect(postTitleTeamSubject({ caption: "Real Madrid counter Barcelona" }, ctx)).toBe("");
    expect(postTitleTeamSubject({ caption: "Real Madrid score" }, { teams: [{ name: "Real Madrid" }] })).toBe(
      "Real Madrid"
    );
    expect(postTitleTeamSubject({ caption: "Real Madrid score" }, null)).toBe("");
  });
});

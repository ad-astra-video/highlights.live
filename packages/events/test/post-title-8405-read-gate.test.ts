// ADAAAA-8405 (PO ship bar S1-S3/S5): the READ-SEAM gate on a stored title.
//
// The write seam refuses a title it cannot gate, but rows written BEFORE that
// gate existed still carry one. Measured on the 13 post-deploy highlight rows:
// three served `David Saez scores` where the row's own copy names "Carlos
// Javier"/"No. 22", i.e. an invented name on the customer surface.
//
// `projectPostTitle` now re-checks the stored value against the facts the row
// itself carries — shape (place chain / length / T+), a claim on a non-scoring
// verdict, and whole-phrase name provenance against `postTitle`/`caption`/
// `reason`/`reasonRaw`. A failing title serves the deterministic `LABEL · m:ss`
// fallback. This is a TIGHTENING: nothing the write gate accepts is refused here.
import { describe, expect, it } from "vitest";
import {
  deterministicPostTitle,
  projectPostTitle,
  servedPostTitleViolations,
  type PostTitleRow,
} from "../src/post-title";

const row = (over: Partial<PostTitleRow>): PostTitleRow => ({
  eventType: "GOAL",
  outcome: "scoring_play",
  localizedTs: 74,
  ...over,
});

describe("ADAAAA-8405 S1 — a place chain never serves", () => {
  it("refuses a stored title carrying a zone and serves LABEL · m:ss", () => {
    const r = row({ postTitle: "Player falls in box", caption: "Player falls in box." });
    expect(servedPostTitleViolations("Player falls in box", r)).toContain("place-chain");
    expect(projectPostTitle(r)).toBe(
      deterministicPostTitle({ eventType: "GOAL", outcome: "scoring_play", windowTs: 74 })
    );
  });
});

describe("ADAAAA-8405 S2 — no claim on a non-scoring row", () => {
  it("refuses `scores` when the stored verdict is big_play", () => {
    const r = row({
      postTitle: "Manuel Ordoñez scores",
      eventType: "AUDIO_BURST",
      outcome: "big_play",
      caption: "Manuel Ordoñez scores — Real Madrid takes the lead.",
    });
    expect(servedPostTitleViolations("Manuel Ordoñez scores", r)).toContain("goal-claim");
    expect(projectPostTitle(r)).toBe(
      deterministicPostTitle({ eventType: "AUDIO_BURST", outcome: "big_play", windowTs: 74 })
    );
  });

  it("still serves a claim on a corroborated scoring row (nothing is loosened OR over-tightened)", () => {
    const r = row({ postTitle: "No. 7 scores", caption: "No. 7 scores at the far post." });
    expect(servedPostTitleViolations("No. 7 scores", r)).toEqual([]);
    expect(projectPostTitle(r)).toBe("No. 7 scores");
  });
});

describe("ADAAAA-8405 S3 — every name must be in the row's own copy, as a whole phrase", () => {
  it("refuses `David Saez` when the copy names Carlos Javier", () => {
    const r = row({
      postTitle: "David Saez scores",
      caption: "Carlos Javier carries the ball.",
      reason: "Carlos Javier carries the ball.",
    });
    expect(servedPostTitleViolations("David Saez scores", r)).toContain("ungrounded-name");
    expect(projectPostTitle(r)).not.toContain("David Saez");
  });

  it("refuses a FIRST NAME invented onto a surname the copy does read", () => {
    // the measured 3/255 class: copy says "Ordoñez scores", the title said
    // "Manuel Ordoñez scores". Provenance is the WHOLE phrase (ADAAAA-7962).
    const r = row({
      postTitle: "Manuel Ordoñez scores",
      caption: "Ordoñez scores at the far post.",
      reason: "Ordoñez scores at the far post.",
    });
    expect(servedPostTitleViolations("Manuel Ordoñez scores", r)).toContain("ungrounded-name");
  });

  it("serves a name the row's own copy carries", () => {
    const r = row({
      postTitle: "Ordoñez scores",
      caption: "Ordoñez scores at the far post.",
      reason: "Ordoñez scores at the far post.",
    });
    expect(servedPostTitleViolations("Ordoñez scores", r)).toEqual([]);
    expect(projectPostTitle(r)).toBe("Ordoñez scores");
  });

  it("grounds on the audit copy too (`reason_raw`)", () => {
    const r = row({ postTitle: "Diego Aguado clears", reasonRaw: "Diego Aguado clears the ball." });
    expect(servedPostTitleViolations("Diego Aguado clears", r)).toEqual([]);
  });
});

describe("ADAAAA-8405 S5 — shape bar on the served value", () => {
  it("refuses a T+ prefix, an over-long title and an 11-word title", () => {
    const r = row({ postTitle: null });
    expect(servedPostTitleViolations("T+12s Player carries ball", r)).toContain("clock-prefix");
    expect(servedPostTitleViolations("Player carries the ball down the left and crosses it in", r).length).toBeGreaterThan(0);
    expect(servedPostTitleViolations("No 9 carries the ball up the pitch and then he shoots it in", r)).toContain("too-many-words");
  });

  it("never empties a card: an absent title serves the deterministic fallback", () => {
    expect(projectPostTitle(row({ postTitle: null }))).toMatch(/^GOAL · \d+:\d{2}/);
  });
});

describe("ADAAAA-8405 — no copy is not evidence against the title", () => {
  it("serves a stored title when the row carries no other text (write gate already grounded it)", () => {
    const r = row({ postTitle: "Ordoñez strikes early" });
    expect(projectPostTitle(r)).toBe("Ordoñez strikes early");
  });
});

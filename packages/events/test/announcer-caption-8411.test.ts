// ADAAAA-8411 — AC4 residual: the announcer caption may never degrade to the card
// title when the gated copy is empty.
//
// Phase D (ADAAAA-8406) graded the served build and FAILED AC4 on ONE card:
// row f4407757 on job 755fd1f5 (`GOAL · 2:38`). The row's only model sentence was
// a clock-bracketed attestation line —
//
//     Scoreboard changes to 2-2 at t=-3.3s and ASR confirms 'il gol!'
//
// — so `storedSurfaceFor` stored NO `reason` and NO `caption`, and the detail
// route served the deterministic post TITLE as the announcer line: the card's
// "What happened" line was byte-identical to its headline.
//
// These fixtures replay that row's own stored evidence ($0, no decide call, no
// GPU) and hold the two surfaces to the required bar:
//
//   1. the WRITE seam derives an honest fact sentence from the row's own
//      sentence (`storedSurfaceFor` in live-deferred-goal-attestation-8006 style),
//   2. the READ seam serves a non-degrade caption from stored fields alone, and
//   3. the title fallback is UNREACHABLE for a postable row — a scoring row, a
//      notable row, and a row with no copy at all each serve detail copy.
import { describe, expect, it } from "vitest";

import {
  attestationDetailCopy,
  projectAnnouncerCaption,
  projectPostTitle,
  storedFactAnnouncerCopy,
  type PostTitleRow,
} from "@highlights/events";

/** The window's own stored prompt lines (verbatim from decide_audit g54, job
 *  755fd1f5 — the scoreboard-change read, the ASR call and the two OCR taps that
 *  carry the post score). Trimmed to the evidence the gate reads: no model call. */
const G54_PROMPT = [
  "- scoreboard score change observed during window: yes",
  "- audio commentary transcript (ASR):",
  "-   la mania è mal, la mania è parada vizia e da vizia è che può  diacerla la selina, il gol!",
  '-  -3.3s tracks=3 vel=0.05 objects=player,soccer ball ocr="Art Soccer\\|22:113 EMA 2-2 BARAszend" poss=none',
  '-  -1.3s tracks=3 vel=0.07 objects=player,soccer ball ocr="4DAVID SAEZGOLES 1Art Sa\\|22411 EMA 2-2 BAR4DAVID " poss=t1794146718652-1',
].join("\n");

/** The stored `raw_reply.reason` of row f4407757 (the audit line the write seam kept). */
const G54_REASON = "Scoreboard changes to 2-2 at t=-3.3s and ASR confirms 'il gol!'";

const G54_WRITE_CTX = {
  verdict: "scoring_play",
  eventType: "GOAL",
  promptText: G54_PROMPT,
  corroborated: true,
};

/** The row as the detail route reads it back: NO caption, NO reason, audit line only. */
const G54_STORED_ROW: PostTitleRow = {
  postTitle: "David Saez scores",
  caption: null,
  reason: null,
  reasonRaw: G54_REASON,
  eventType: "GOAL",
  outcome: "scoring_play",
  localizedTs: 158.666,
  start: 151.666,
};

describe("ADAAAA-8411 write seam: the clock-bracketed attestation sentence", () => {
  it("stores the row's own ledger fact as the caption", () => {
    expect(attestationDetailCopy(G54_REASON, G54_WRITE_CTX)).toBe("Scoreboard changes to 2-2.");
  });

  it("drops the attestation clause and the window marker — deletion only", () => {
    const fact = attestationDetailCopy(G54_REASON, G54_WRITE_CTX);
    expect(fact).not.toMatch(/ASR|confirms|il gol/i);
    expect(fact).not.toMatch(/t=/);
    expect(fact).toMatch(/^Scoreboard changes to 2-2\.$/);
  });

  it("is not the title, and is a sentence (shape bar)", () => {
    const fact = attestationDetailCopy(G54_REASON, G54_WRITE_CTX);
    const title = projectPostTitle(G54_STORED_ROW, {});
    expect(fact).toBeTruthy();
    expect(fact).not.toBe(title);
    expect(fact.endsWith(".")).toBe(true);
  });

  it("refuses the scoreline without prompt corroboration (fails closed)", () => {
    // An empty prompt is evidence of nothing: an unmeasured scoreline is a claim.
    expect(attestationDetailCopy(G54_REASON, { ...G54_WRITE_CTX, promptText: "" })).toBe("");
    // … and a prompt that does not carry the post score refuses it too.
    expect(attestationDetailCopy(G54_REASON, { ...G54_WRITE_CTX, promptText: "- scoreboard score change observed during window: yes" })).toBe("");
  });

  it("refuses a scoreline on a NON-scoring verdict when there is no prompt to consult", () => {
    expect(attestationDetailCopy(G54_REASON, { verdict: "big_play", eventType: "GOAL" })).toBe("");
    expect(attestationDetailCopy(G54_REASON, { verdict: "scoring_play", eventType: "GOAL" })).toBe("Scoreboard changes to 2-2.");
  });

  it("leaves a sentence with no window marker to the card gate", () => {
    expect(attestationDetailCopy("Ball shoots on the right.", G54_WRITE_CTX)).toBe("");
  });

  it("refuses a sentence whose only residue is the attestation itself", () => {
    expect(
      attestationDetailCopy("ASR confirms 'il gol!' at t=-0.3s", G54_WRITE_CTX)
    ).toBe("");
  });
});

describe("ADAAAA-8411 read path: the served caption never degrades to the title", () => {
  it("serves the row's own fact sentence for the Phase D holdout row", () => {
    const title = projectPostTitle(G54_STORED_ROW, {});
    const caption = projectAnnouncerCaption(G54_STORED_ROW, title);
    expect(title).toBe("GOAL · 2:38");
    expect(caption).toBe("Scoreboard changes to 2-2.");
    expect(caption).not.toBe(title);
  });

  it("serves a fact sentence from stored facts when the row has NO copy at all", () => {
    const row: PostTitleRow = { ...G54_STORED_ROW, postTitle: null, reasonRaw: null };
    const title = projectPostTitle(row, {});
    const caption = projectAnnouncerCaption(row, title);
    expect(caption).not.toBe(title);
    expect(caption).toBe("Goal at 2:38.");
  });

  it("never asserts a goal on a demoted (non-scoring) row", () => {
    const row: PostTitleRow = {
      postTitle: null,
      caption: null,
      reason: null,
      reasonRaw: null,
      eventType: "GOAL",
      outcome: "big_play",
      localizedTs: 100.666,
    };
    const title = projectPostTitle(row, {});
    const caption = projectAnnouncerCaption(row, title);
    // The caption is honest even though the row's stored eventType still says GOAL
    // (the deterministic TITLE keeps that taxonomy — a separate, pre-existing
    // surface this ticket does not touch): a demoted row never asserts a goal.
    expect(caption).toBe("Big play at 1:40.");
    expect(caption).not.toMatch(/goal/i);
    expect(caption).not.toBe(title);
  });

  it("keeps a stored caption and a gated reason byte-for-byte (no re-derivation)", () => {
    const title = projectPostTitle(G54_STORED_ROW, {});
    expect(projectAnnouncerCaption({ ...G54_STORED_ROW, caption: "Ball enters the net." }, title)).toBe("Ball enters the net.");
    expect(projectAnnouncerCaption({ ...G54_STORED_ROW, reason: "Ball enters the net." }, title)).toBe("Ball enters the net.");
  });

  it("the deterministic fact sentence is only a fallback — never the title", () => {
    // A scoring row: "Goal at …"; the title carries the label + clock + subject.
    const title = "GOAL · 2:38 · Real Madrid";
    expect(storedFactAnnouncerCopy({ outcome: "scoring_play", eventType: "GOAL", localizedTs: 158.666 }, title)).toBe("Goal at 2:38.");
    // No instant -> nothing is invented; the caller keeps the title.
    expect(storedFactAnnouncerCopy({ outcome: "scoring_play", eventType: "GOAL" }, title)).toBe("");
  });
});

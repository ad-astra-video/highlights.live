// ADAAAA-8040 (§2 residual, residual of ADAAAA-8013 on build `a408584`): the
// claim-suppression path excised a post-dash CLAIM clause and served the
// pre-dash lead with no terminal punctuation. Four stored rows on the graded
// build carried the same class (`GET /jobs/:id/detail` ->
// `summaryLadder.chapters[].entries[].text`, re-derived on read):
//
//   job 3d8a5a82 seq 18  `A player shoots from the penalty area`
//                        for `A player shoots from the penalty area — the ball
//                        misses the goal.`
//   job a1f30ed1 seq 7   `Player in white takes a shot from the penalty area`
//                        for `… — misses the target. Real Madrid scores 2-1.`
//   job a1f30ed1 seq 34  `The player in white takes a shot from the penalty area`
//                        for `… — goal 22:15`
//   job 228462b5 seq 15  `Players move in the center`
//                        for `Players move in the center and defensive areas.`
//
// Two independent blind spots let them through, and each has its own arm below:
//
//   1. the SERVED post-condition compared a row only with the LEAD of its stored
//      sentence (`captionLead`, everything before the em dash). When the claim
//      gate had removed the post-dash clause, the served prefix compared EQUAL to
//      its own source, so `prefix-cut`/`open-clause` could never fire;
//   2. the WRITE seam dropped the claim clause (and `repairDanglingTail` dropped
//      `and defensive areas.`) without restoring the sentence's own full stop.
//
// Fix: the comparison source keeps a non-colour dash clause (`wholeStoredSentence`),
// a served row is closed with its sentence end (`restoreTerminalPunctuation`), and
// a row that IS the sentence's own lead — the sanctioned "claim suppressed INSIDE
// the sentence" shape — is served as that whole clause, never as a cut.
import { describe, it, expect } from "vitest";
import {
  captionLead,
  gateGoalClaims,
  groundSummaryText,
  repairDanglingTail,
  restoreTerminalPunctuation,
  servedShape,
  servedShapeViolations,
  wholeStoredSentence,
} from "@highlights/events";

/** The four stored rows of the graded build, verbatim. */
const STORED = [
  {
    job: "3d8a5a82",
    seq: 18,
    gated: "A player shoots from the penalty area",
    raw: "A player shoots from the penalty area — the ball misses the goal.",
    served: "A player shoots from the penalty area.",
    quiet: true,
  },
  {
    job: "a1f30ed1",
    seq: 7,
    gated: "Player in white takes a shot from the penalty area",
    raw: "Player in white takes a shot from the penalty area — misses the target. Real Madrid scores 2-1.",
    served: "Player in white takes a shot from the penalty area.",
    quiet: false,
  },
  {
    job: "a1f30ed1",
    seq: 34,
    gated: "The player in white takes a shot from the penalty area",
    raw: "The player in white takes a shot from the penalty area — goal 22:15",
    served: "The player in white takes a shot from the penalty area.",
    quiet: false,
  },
  {
    job: "228462b5",
    seq: 15,
    gated: "Players move in the center",
    raw: "Players move in the center and defensive areas.",
    // ADAAAA-8059 (PO ruling): the store is the contract, so the row is served as
    // the stored sentence, closed — the raw's coordinate phrase is a clause the
    // write seam dropped and the read path may not restore it.
    served: "Players move in the center.",
    quiet: true,
  },
] as const;

const serve = (row: (typeof STORED)[number]) =>
  servedShape({
    candidate: row.gated,
    storedGated: row.gated,
    storedRaw: row.raw,
    quiet: row.quiet,
  });

describe("ADAAAA-8040 §2 residual — a claim-suppressed row is a WHOLE sentence (AC1)", () => {
  it("serves each stored row whole, with a sentence end", () => {
    for (const row of STORED) {
      const out = serve(row);
      expect(out.text, `${row.job} seq ${row.seq}`).toBe(row.served);
      expect(out.violations).toEqual([]);
    }
  });

  it("never serves the punctuation-less prefix the graded build shipped", () => {
    for (const row of STORED) {
      const out = serve(row);
      expect(out.text).not.toBe(row.gated);
      expect(out.text.trim().endsWith(".")).toBe(true);
    }
  });

  it("a claim row keeps its actor, action and place (extractive only)", () => {
    for (const row of STORED.filter((r) => r.raw.includes("—"))) {
      const out = serve(row).text.toLowerCase();
      for (const word of captionLead(row.raw).toLowerCase().split(/\s+/).filter(Boolean)) {
        // the sentence is the stored lead, closed: every word is the model's own
        expect(out).toContain(word.replace(/[.,;:]$/, ""));
      }
    }
  });

  it("quiet rows stay inside the 8-word budget", () => {
    for (const row of STORED.filter((r) => r.quiet)) {
      expect(serve(row).text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(8);
    }
  });
});

describe("ADAAAA-8040 — the two blind spots (negative arm: without the fix the cut reproduces)", () => {
  it("comparing only the LEAD of the stored sentence cannot see the cut", () => {
    const row = STORED[0];
    // The pre-fix source list (lead only) and the pre-fix candidate (no sentence
    // end): the cut is invisible, which is exactly how it shipped.
    const preFixSources = [captionLead(row.gated), captionLead(row.raw)];
    expect(servedShapeViolations(row.gated, preFixSources)).toEqual([]);
    expect(preFixSources[1]).toBe(row.gated);
  });

  it("comparing the stored SENTENCE sees the same string as a prefix cut", () => {
    const row = STORED[0];
    const sources = [wholeStoredSentence(row.gated), wholeStoredSentence(row.raw)];
    // The claim was suppressed INSIDE the sentence and the row kept no sentence
    // end: that is the open-clause shape the graded build served.
    expect(servedShapeViolations(row.gated, sources)).toEqual(["open-clause"]);
    // A cut that stops inside the lead (not at the dash boundary) is a prefix cut.
    expect(
      servedShapeViolations("A player shoots", [wholeStoredSentence(row.raw)])
    ).toContain("prefix-cut");
  });

  it("repairDanglingTail no longer deletes a whole coordinate phrase (seq 15)", () => {
    const row = STORED[3];
    expect(repairDanglingTail(row.raw)).toBe(row.raw);
    expect(repairDanglingTail("A child stands in the foreground while players")).toBe(
      "A child stands in the foreground"
    );
  });
});

describe("ADAAAA-8040 — terminal punctuation is restored on a claim-suppressed line (positive arm)", () => {
  it("gateGoalClaims closes the sentence it shortened", () => {
    for (const row of STORED.slice(0, 3)) {
      const gated = gateGoalClaims(row.raw, { verdict: "not_highlight" } as never);
      expect(gated.endsWith("."), `${row.job}: ${gated}`).toBe(true);
      expect(gated).not.toBe(row.raw);
    }
  });

  it("groundSummaryText stores a whole sentence for every stored raw row", () => {
    for (const row of STORED.slice(0, 3)) {
      const stored = groundSummaryText(row.raw, { verdict: "not_highlight" } as never);
      expect(stored.endsWith("."), `${row.job}: ${stored}`).toBe(true);
    }
  });

  it("restoreTerminalPunctuation adds one full stop and never touches a closed line", () => {
    expect(restoreTerminalPunctuation("A player shoots from the penalty area")).toBe(
      "A player shoots from the penalty area."
    );
    expect(restoreTerminalPunctuation("A player shoots.")).toBe("A player shoots.");
    expect(restoreTerminalPunctuation("No goals in the second half!")).toBe("No goals in the second half!");
    expect(restoreTerminalPunctuation("")).toBe("");
  });

  it("a row the model wrote without a full stop is served closed", () => {
    const out = servedShape({
      candidate: "Player in purple dribbles in the center circle",
      storedGated: "Player in purple dribbles in the center circle",
      storedRaw: "",
    });
    expect(out.text).toBe("Player in purple dribbles in the center circle.");
    expect(out.violations).toEqual([]);
  });
});

describe("ADAAAA-8040 — the sanctioned shapes are not refused", () => {
  it("serves a quiet row whose stored sentence is the whole beat (8 words or less)", () => {
    const out = serve(STORED[3]);
    // ADAAAA-8059 (PO ruling): the stored sentence is the beat; the raw's
    // coordinate phrase is the clause the seam dropped, not a repair.
    expect(out.text).toBe("Players move in the center.");
  });

  it("serves a row that keeps a colour beat after its sentence (loud window)", () => {
    const line = "The player in blue attempts a shot from the penalty area — noise spikes over the play";
    const out = servedShape({ candidate: line, storedGated: line, storedRaw: line });
    expect(out.text).toBe(`${line}.`);
  });

  it("does not re-serve a goal clause that was suppressed inside the sentence", () => {
    for (const row of STORED.slice(0, 3)) {
      expect(serve(row).text).not.toMatch(/\b(?:goal|scores?|scored|net)\b/i);
    }
  });
});

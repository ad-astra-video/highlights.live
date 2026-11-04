// ADAAAA-8022 (§2, residual of the ADAAAA-8015 re-grade on build `d6c9a9f`):
// a served ladder row may lose its PREDICATE without losing its length. The two
// rows below are the exact served strings of job 34f9f2d1-dba7-4c39-97c1-eaec9e9066fc
// (`GET /jobs/:id/detail` -> `summaryLadder.chapters[].entries[].text`): each is a
// complete-looking sentence of 5/8 words with the verb deleted, so the old
// `words.length <= 2` fragment rule let both through and `servedShape()` returned
// the stored gated line unchanged — the raw-sentence + reduction fallback at
// :1516 was never reached. These cases drive the fix:
//
//   - `servedShapeViolations` refuses a verbless line of ANY length when a stored
//     source carries a verb;
//   - `servedShape` therefore runs the whole-sentence reduction path, which already
//     produced clean forms for both rows (kit-colour deletion, then the contract's
//     compressed place).
import { describe, it, expect } from "vitest";
import { captionLead, servedShape, servedShapeViolations } from "@highlights/events";

/** seq 32 / windowTs 303: predicate `dribbles` deleted. */
const SEQ_32 = {
  candidate: "A player in the midfield.",
  storedGated: "A player in the midfield.",
  storedRaw: "A player in a purple kit dribbles in the midfield.",
};

/** seq 56 / windowTs 684: verb `contests` deleted, determiner `the` dropped. */
const SEQ_56 = {
  candidate: "A player for the ball in center circle.",
  storedGated: "A player for the ball in center circle.",
  storedRaw: "A player in a blue kit contests for the ball in the center circle.",
};

const sourcesOf = (row: { storedGated: string; storedRaw: string }) => [
  captionLead(row.storedGated),
  captionLead(row.storedRaw),
];

describe("servedShapeViolations — a verbless line of any length (ADAAAA-8022)", () => {
  it("refuses seq 32 even though it is five words long", () => {
    expect(servedShapeViolations(SEQ_32.candidate, sourcesOf(SEQ_32))).toContain("verbless");
  });

  it("refuses seq 56 even though it is eight words long", () => {
    expect(servedShapeViolations(SEQ_56.candidate, sourcesOf(SEQ_56))).toContain("verbless");
  });

  it("does not refuse a line that carries its own verb", () => {
    expect(servedShapeViolations("A player dribbles in the midfield.", sourcesOf(SEQ_32))).toEqual([]);
  });

  it("serves a stored line that has no verb in either source (nothing was deleted)", () => {
    const row = "No goals in the second half.";
    expect(servedShapeViolations(row, [row])).toEqual([]);
    const out = servedShape({ candidate: row, storedRaw: row, storedGated: row, quiet: true });
    expect(out.text).toBe(row);
    expect(out.replaced).toBe(false);
  });
});

describe("servedShape — the reduction path runs before a stored gated line is accepted", () => {
  it("re-serves seq 32 from the stored raw sentence (kit colour deleted)", () => {
    const out = servedShape({ ...SEQ_32, quiet: true });
    expect(out.text).toBe("A player dribbles in the midfield.");
    expect(out.replaced).toBe(true);
    expect(out.text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(8);
    expect(servedShapeViolations(out.text, sourcesOf(SEQ_32))).toEqual([]);
  });

  it("re-serves seq 56 from the stored raw sentence (colour, compressed place)", () => {
    // NOTE: the ticket wrote this form as "8 words"; the string is 9 tokens
    // (`for the ball` survives), so the quiet row would breach the 8-word budget.
    // The `center circle -> center` compression keeps the transitive verb's OBJECT
    // and lands on 8: `A player contests for the ball in center.`
    const out = servedShape({ ...SEQ_56, quiet: true });
    expect(out.text).toBe("A player contests for the ball in center.");
    expect(out.replaced).toBe(true);
    expect(out.text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(8);
    expect(servedShapeViolations(out.text, sourcesOf(SEQ_56))).toEqual([]);
  });

  it("never falls back to the mangled stored gated line", () => {
    for (const row of [SEQ_32, SEQ_56]) {
      const out = servedShape({ ...row, quiet: true });
      expect(out.text).not.toBe(row.candidate);
    }
  });

  it("serves the whole raw sentence when the row is not quiet", () => {
    const out = servedShape({ ...SEQ_56, quiet: false });
    expect(out.text).toBe("A player in a blue kit contests for the ball in the center circle.");
    expect(out.replaced).toBe(true);
  });

  it("keeps a verbless row only when no stored source had a verb to lose", () => {
    const out = servedShape({ candidate: "No goals in the second half.", quiet: true });
    expect(out.text).toBe("No goals in the second half.");
    expect(out.replaced).toBe(false);
  });
});

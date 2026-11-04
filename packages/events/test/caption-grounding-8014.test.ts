// ADAAAA-8014 (§2, follow-up of the ADAAAA-8010 served re-grade): a served
// ladder line may not stop mid-phrase. The five strings below are the exact rows
// the re-grade found on build `eba8e7c` (jobs 3d8a5a82 / 973fae84,
// `GET /jobs/:id/detail` -> `summaryLadder.chapters[].entries[].text`).
import { describe, it, expect } from "vitest";
import {
  captionLead,
  completeQuietSentence,
  gateGoalClaims,
  groundCaption,
  groundSummaryText,
  quietShape,
  servedShape,
  servedShapeViolations,
  wholeFirstSentence,
} from "@highlights/events";

const ctx = (verdict: string, place: string | null = null) =>
  ({ verdict, place, promptText: "", corroborated: false }) as any;

describe("servedShapeViolations — the three §2 rules", () => {
  it("refuses a line that ends on a copula / function word", () => {
    expect(servedShapeViolations("A player and a player are.", [])).toContain("function-tail");
    expect(servedShapeViolations("A player takes in the box.", [])).toContain("object-missing");
    for (const tail of ["in", "of", "to", "with", "from", "the", "and", "are", "was", "has"]) {
      expect(servedShapeViolations(`A player moves ${tail}`, [])).toContain("function-tail");
    }
  });

  it("refuses a transitive verb whose object was cut", () => {
    expect(servedShapeViolations("A player takes in midfield", [])).toContain("object-missing");
    expect(servedShapeViolations("The side sends on the right", [])).toContain("object-missing");
    // an intransitive verb with a place is a whole beat
    expect(servedShapeViolations("A player shoots in midfield", [])).toEqual([]);
  });

  it("refuses a prefix cut of the stored sentence", () => {
    const stored = "Players compete for the ball in the center of the pitch.";
    expect(servedShapeViolations("Players compete for the ball in the center.", [stored])).toContain(
      "prefix-cut"
    );
    expect(
      servedShapeViolations("The broadcast shows a replay.", ["The broadcast shows a replay of Saez's goal."])
    ).toContain("prefix-cut");
    // the WHOLE stored sentence is not a cut of itself
    expect(servedShapeViolations(stored, [stored])).toEqual([]);
  });

  it("refuses a cut that ends inside a clause (no terminal punctuation)", () => {
    expect(servedShapeViolations("Players compete for the ball in the center", [
      "Players compete for the ball in the center of the pitch.",
    ])).toEqual(expect.arrayContaining(["prefix-cut", "open-clause"]));
  });

  it("refuses a two-word fragment with no verb (`The side.`)", () => {
    expect(servedShapeViolations("The side.", ["The side. 9 shoots on the right"])).toEqual(
      expect.arrayContaining(["fragment", "prefix-cut"])
    );
  });
});

describe("servedShape — fallback order (whole sentence, never the trimmed candidate)", () => {
  it("replaces the copula tail with the spot's own whole clause", () => {
    const raw = "A player in blue and a player in white are in the center of the field.";
    const out = servedShape({ candidate: "A player and a player are.", storedRaw: raw, quiet: true });
    expect(out.text).toBe("A player and a player are in center.");
    expect(out.text.split(/\s+/).length).toBeLessThanOrEqual(8);
    expect(servedShapeViolations(out.text, [captionLead(raw)])).toEqual([]);
  });

  it("keeps the whole stored sentence when it is the honest beat", () => {
    const raw = "Players compete for the ball in the center of the pitch.";
    const out = servedShape({ candidate: "Players compete for the ball in the center.", storedRaw: raw, quiet: true });
    expect(out.text).toBe("Players compete for the ball in center.");
    expect(servedShapeViolations(out.text, [captionLead(raw)])).toEqual([]);
  });

  it("re-gates the fallback sentence for an uncorroborated window", () => {
    const raw = "The broadcast shows a replay of Saez's goal.";
    const out = servedShape({
      candidate: "The broadcast shows a replay.",
      storedRaw: raw,
      quiet: true,
      regate: (s) => gateGoalClaims(s, { corroborated: false }),
    });
    expect(out.text).toBe("The broadcast shows a replay of Saez's shot.");
    expect(servedShapeViolations(out.text, [captionLead(raw)])).toEqual([]);
  });

  it("never falls back to the candidate that was refused", () => {
    const raw = "The broadcast shows a replay of Saez's goal.";
    const out = servedShape({ candidate: "The broadcast shows a replay.", storedRaw: raw, quiet: true });
    expect(out.text).not.toBe("The broadcast shows a replay.");
    expect(out.replaced).toBe(true);
  });

  it("drops the row when nothing honest passes", () => {
    const out = servedShape({ candidate: "A player takes in midfield", quiet: true });
    expect(out.text).toBe("");
    expect(out.replaced).toBe(true);
    expect(out.violations.length).toBeGreaterThan(0);
  });

  it("passes a whole row through byte-identically", () => {
    const row = "A defender blocks a ball in the box.";
    const out = servedShape({ candidate: row, storedRaw: row, storedGated: row, quiet: true });
    expect(out.text).toBe(row);
    expect(out.replaced).toBe(false);
  });
});

describe("completeQuietSentence — deletion only, never a tail cut", () => {
  it("deletes an interior adjunct phrase and keeps the sentence's own ending", () => {
    expect(completeQuietSentence("Players compete for the ball in the center of the pitch.")).toBe(
      "Players compete in the center of the pitch."
    );
  });

  it("returns \"\" when no interior deletion fits (caller drops, never cuts)", () => {
    expect(completeQuietSentence("A player takes a shot from the penalty area that misses the goal.", 8)).toBe("");
  });
});

describe("quietShape keeps the transitive verb's object (root cause of `A player takes in midfield`)", () => {
  it("condenses to actor + verb + object + place", () => {
    const out = groundSummaryText("A player takes a shot from the penalty area that misses the goal.", {
      verdict: "not_highlight",
      place: "in midfield",
      promptText: "",
      corroborated: false,
    } as any);
    expect(out).toBe("A player takes a shot in midfield");
    expect(servedShapeViolations(out, [])).toEqual([]);
    expect(quietShape("A player takes a shot from the penalty area that misses the goal")).not.toMatch(/\btakes$/);
  });
});

describe("groundNames does not absorb a jersey abbreviation into a name run", () => {
  it("keeps `No. 9` after the club is anonymised (no `The side. 9`)", () => {
    const out = groundCaption("Real Madrid's No. 9 scores — crowd erupts", ctx("big_play", "on the right"));
    expect(out).not.toMatch(/The side\./);
    expect(out).toMatch(/9/);
  });
});

describe("wholeFirstSentence", () => {
  it("returns the whole first sentence, colour clause excluded", () => {
    expect(wholeFirstSentence("A player shoots from the penalty area — the ball misses the goal.")).toBe(
      "A player shoots from the penalty area"
    );
  });
});

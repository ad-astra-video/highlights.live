// ADAAAA-8356 (ADAAAA-8302 Phase B FAIL) — the write seam's two shape guards.
//
// The prompt contract now asks for a headline (WHO + VERB + WHAT, no place, no
// second beat, no claim unless the row's own verdict says scoring_play), but a
// model reply still occasionally carries an ANDROID shape: a place chain
// ("Player carries ball in midfield") or a second beat ("rejected shot leads to
// a corner"). On leg 23bb0a61 that refused 46 of 54 rows, so 20 of 25 served
// cards fell back to the deterministic title.
//
// These are DELETION-ONLY repairs: `trimPostTitleShape` removes a trailing place
// phrase and a second clause and the result must pass every bar the raw title is
// held to (shape AND the evidence gates). `uniquePostTitle` drops a title that
// already appears on the job's cards, because a repeat is not copy (AC1/AC6).
import { describe, expect, it } from "vitest";
import {
  gatePostTitleValue,
  trimPostTitleShape,
  uniquePostTitle,
  type CaptionGroundingContext,
} from "../src/index.js";

const PROMPT = 'ocr="scoreboard 1-1" | Ordoñez is on the ball | Real Madrid counter';

function ctx(verdict: CaptionGroundingContext["verdict"]): CaptionGroundingContext {
  return { verdict, promptText: PROMPT } as CaptionGroundingContext;
}

describe("trimPostTitleShape — extractive place/second-beat repair", () => {
  it("drops a trailing place chain, keeping the subject + verb", () => {
    expect(trimPostTitleShape("Player carries ball in midfield")).toBe("Player carries ball");
    expect(trimPostTitleShape("Build up in the penalty area")).toBe("Build up");
    expect(trimPostTitleShape("Player falls in the middle third")).toBe("Player falls");
    expect(trimPostTitleShape("Referee stands in center")).toBe("Referee stands");
  });

  it("drops a second beat after a dash, a semicolon or a sentence break", () => {
    expect(trimPostTitleShape("Ordoñez shoots — the crowd erupts")).toBe("Ordoñez shoots");
    expect(trimPostTitleShape("The No. 9 drives forward; the bench rises")).toBe("The No. 9 drives forward");
    expect(trimPostTitleShape("Player clears ball. Restart after goal")).toBe("Player clears ball");
  });

  it("never invents or lengthens: the trim is a prefix deletion of its own input", () => {
    for (const raw of [
      "Player carries ball in midfield",
      "Ordoñez shoots in the penalty area — noise spikes",
      "Goalkeeper holds ball",
    ]) {
      const out = trimPostTitleShape(raw);
      expect(raw.toLowerCase().startsWith(out.toLowerCase())).toBe(true);
      expect(out.length).toBeLessThanOrEqual(raw.length);
    }
  });

  it("leaves a clean title byte-identical", () => {
    expect(trimPostTitleShape("Defender clears ball")).toBe("Defender clears ball");
    expect(trimPostTitleShape("  ")).toBe("");
  });
});

describe("gatePostTitleValue — the trimmed form must still pass every bar", () => {
  it("accepts a place-chained title by deletion (AC4: the card keeps model copy)", () => {
    expect(gatePostTitleValue("Player carries ball in midfield", ctx("not_highlight"))).toBe(
      "Player carries ball"
    );
  });

  it("refuses when the deletion leaves a claim on a non-scoring verdict", () => {
    // the place goes, the claim survives -> still refused, the card falls back
    expect(gatePostTitleValue("Ordoñez scores in the penalty area", ctx("not_highlight"))).toBeNull();
  });

  it("refuses when the deletion leaves an unsourced name", () => {
    expect(gatePostTitleValue("Manuel Ordoñez clears ball in the box", ctx("not_highlight"))).toBeNull();
  });

  it("keeps a grounded name (the window's own prompt reads it)", () => {
    const out = gatePostTitleValue("Ordoñez carries ball in midfield", ctx("not_highlight"));
    expect(out).toBe("Ordoñez carries ball");
  });

  it("still accepts a plain clean title and an empty string stays absent", () => {
    expect(gatePostTitleValue("Goalkeeper holds ball", ctx("not_highlight"))).toBe("Goalkeeper holds ball");
    expect(gatePostTitleValue("", ctx("not_highlight"))).toBeNull();
    expect(gatePostTitleValue(undefined, ctx("not_highlight"))).toBeNull();
  });
});

describe("uniquePostTitle — a repeat on the same job is not copy (AC6)", () => {
  it("accepts the first use and drops the repeat", () => {
    const used = ["David Saez equalizes"];
    expect(uniquePostTitle("David Saez equalizes", used)).toBeNull();
    expect(uniquePostTitle("David Saez slots home", used)).toBe("David Saez slots home");
  });

  it("compares on the cleaned form, case-insensitively", () => {
    expect(uniquePostTitle("  Player carries ball. ", ["player carries ball"])).toBeNull();
  });

  it("an empty title is absent, never a duplicate", () => {
    expect(uniquePostTitle("", ["anything"])).toBeNull();
  });

  it("a run of three identical model titles yields ONE card copy", () => {
    const used: string[] = [];
    const accepted: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = uniquePostTitle("David Saez equalizes", used);
      if (t) {
        accepted.push(t);
        used.push(t);
      }
    }
    expect(accepted).toEqual(["David Saez equalizes"]);
  });
});

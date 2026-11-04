// ADAAAA-7961: served-reading residuals after the ADAAAA-7960 QA pass.
//
// The QA read the SERVED build (box deploy-master = f12a1f3) and found five
// strings that stopped mid-phrase plus a display gate that re-created duplicate
// story lines:
//
//   `A child stands in the foreground while players`                      (cut)
//   `Player in possession in center circle. No. 10 strikes ball`          (cut)
//   `The ball stays out and the scoreboard updates from 2-1 to`           (cut)
//   `The No. 9 scores — crowd erupts as score becomes`                    (cut)
//   `Player in possession in center circle. No. 10 strikes ball into net`
//        in one 15 s row                                                  (two beats)
//
// These tests pin the entrance/exit of every one of them, at the seam that
// produces the string (write) and at the seam that renders it (read).
import { describe, expect, it } from "vitest";
import {
  captionBeats,
  cardTitlesFor,
  captionForStoredLine,
  dedupeGatedLines,
  gateQuietWindow,
  groundCaption,
  repairDanglingTail,
  trimQuietLine,
} from "../src/caption-grounding";

/** The words a delivered line may not end on (a cut mid-phrase). */
const DANGLING_TAIL =
  /\s+\b(?:in|at|on|of|to|with|and|but|as|while|when|from|by|for|into|the|a|an|becomes?|reads?)\s*$/i;

describe("repairDanglingTail — a delivered line never stops mid-phrase", () => {
  it("drops an unfinished subordinated clause", () => {
    // QA: job 5518518b row T+258, served verbatim in the page MATCH SUMMARY
    // bullet and as the Lull chapter narrative `4:18–4:21`.
    const line = "A child stands in the foreground while players";
    expect(repairDanglingTail(line)).toBe("A child stands in the foreground");
    expect(DANGLING_TAIL.test(repairDanglingTail(line))).toBe(false);
  });

  it("drops a score span whose preposition outlived it", () => {
    // QA: job 5518518b caption-card alternative at T+113–128.
    expect(repairDanglingTail("The ball stays out and the scoreboard updates from 2-1 to")).toBe(
      "The ball stays out and the scoreboard updates"
    );
  });

  it("drops the score frame that outlived the scoreline", () => {
    // QA: job 14067ece stored row T+162 — the scoreline went, `as score becomes` stayed.
    expect(repairDanglingTail("The No. 9 scores — crowd erupts as score becomes")).toBe(
      "The No. 9 scores — crowd erupts"
    );
  });

  it("keeps a whole clause after a conjunction (never over-trims)", () => {
    for (const line of [
      "No. 3 drives into the box and shoots",
      "Player in blue and yellow kit shoots",
      "No. 6 strikes the ball into the net — crowd energy rises",
      "No. 9 controls the ball in the box.",
    ]) {
      expect(repairDanglingTail(line)).toBe(line);
    }
  });

  it("is idempotent and never blanks a caption", () => {
    const repaired = repairDanglingTail("A child stands in the foreground while players");
    expect(repairDanglingTail(repaired)).toBe(repaired);
    // A one-token line has nothing to repair — it is returned untouched.
    expect(repairDanglingTail("Shot")).toBe("Shot");
  });

  it("is applied to the caption and card a stored line renders as", () => {
    // Legacy rows keep the broken string in the log; the READ surface repairs it.
    const stored = "A child stands in the foreground while players";
    expect(captionForStoredLine(stored)).toBe("A child stands in the foreground");
    expect(cardTitlesFor(stored, "Shot")).toEqual([
      "A child stands in the foreground",
      "Shot: A child stands in the foreground",
      "Shot",
    ]);
  });
});

describe("captionBeats — one 15 s row carries one beat", () => {
  it("splits a two-sentence row into two beats", () => {
    // QA: job 14067ece T+288 shipped both sentences in one row.
    expect(captionBeats("Player in possession in center circle. No. 10 strikes ball into net")).toEqual([
      "Player in possession in center circle.",
      "No. 10 strikes ball into net",
    ]);
  });

  it("splits one beat per line of a multi-line pass", () => {
    expect(captionBeats("Kickoff at center circle.\nPlayer in blue dribbles.")).toEqual([
      "Kickoff at center circle.",
      "Player in blue dribbles.",
    ]);
  });

  it("never splits a jersey number, an initial or a decimal", () => {
    expect(captionBeats("No. 10 moves into the penalty area.")).toEqual([
      "No. 10 moves into the penalty area.",
    ]);
    expect(captionBeats("The No. 9 stands in the center circle.")).toEqual([
      "The No. 9 stands in the center circle.",
    ]);
    expect(captionBeats("Player 11.6 covers the box.")).toEqual(["Player 11.6 covers the box."]);
  });
});

describe("trimQuietLine — a blunt quiet line ends on a whole clause", () => {
  it("keeps the first beat instead of cutting through the second", () => {
    // QA: the served card rendered `… No. 10` from this row.
    expect(trimQuietLine("Player in possession in center circle. No. 10 strikes ball into net")).toBe(
      "Player in possession in center circle."
    );
  });

  it("cuts at a clause boundary, not at the 8-word boundary", () => {
    const long = "A child stands in the foreground while players move in the center circle";
    const out = trimQuietLine(long);
    expect(out.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(8);
    expect(DANGLING_TAIL.test(out)).toBe(false);
    expect(out).not.toContain("while players");
  });

  it("still trims the measured quiet shapes unchanged (no regression)", () => {
    expect(trimQuietLine("Player in blue and yellow kit dribbles in penalty area")).toBe(
      "Player in blue kit dribbles in box"
    );
    expect(trimQuietLine("The No. 9 controls the ball in the penalty area.")).toBe(
      "No. 9 controls the ball in the box."
    );
  });

  it("reaches the shipped strings through the quiet gate", () => {
    const out = gateQuietWindow("A child stands in the foreground while players", {
      verdict: "not_highlight",
    });
    expect(DANGLING_TAIL.test(out)).toBe(false);
    expect(out).toBe("A child stands in the foreground");
  });
});

describe("score removal leaves no dangling frame", () => {
  it("drops `as score becomes` when the scoreline is uncorroborated", () => {
    const out = groundCaption("The No. 9 scores — crowd erupts as score becomes 2-2", {
      verdict: "scoring_play",
      promptText: "",
    });
    expect(out).not.toMatch(/score\s+becomes|score\s+reads|scoreboard\s+updates/i);
    expect(DANGLING_TAIL.test(out)).toBe(false);
  });

  it("keeps the sentence when the score pair is stripped", () => {
    const out = groundCaption("The ball enters the net and the scoreboard updates from 2-1 to 2-2.", {
      verdict: "scoring_play",
      promptText: "",
    });
    expect(DANGLING_TAIL.test(out)).toBe(false);
    expect(out).toBe("The ball enters the net and the scoreboard updates.");
  });
});

describe("dedupeGatedLines — the display gate never introduces a repeat", () => {
  it("drops a rewritten line that a stored row already states", () => {
    const kept = dedupeGatedLines([
      { text: "Player in blue and yellow kit shoots", rewritten: true },
      { text: "Player in blue and yellow kit shoots", rewritten: false },
      { text: "Yamal strikes the ball wide", rewritten: true },
      { text: "Yamal strikes the ball wide", rewritten: false },
    ]);
    expect(kept.map((l) => l.text)).toEqual([
      "Player in blue and yellow kit shoots",
      "Yamal strikes the ball wide",
    ]);
    expect(kept.every((l) => l.rewritten === false)).toBe(true);
  });

  it("keeps untouched repeats at the contract cap and collapses rewritten twins", () => {
    const kept = dedupeGatedLines([
      { text: "Player in white moves in center circle.", rewritten: false },
      { text: "Player in white moves in center circle.", rewritten: false },
      { text: "No. 9 shoots", rewritten: true },
      { text: "No. 9 shoots", rewritten: true },
    ]);
    expect(kept.map((l) => l.text)).toEqual([
      "Player in white moves in center circle.",
      "Player in white moves in center circle.",
      "No. 9 shoots",
    ]);
  });

  it("is deterministic", () => {
    const lines = [
      { text: "No. 8 shoots", rewritten: true },
      { text: "No. 8 shoots", rewritten: false },
    ];
    expect(dedupeGatedLines(lines)).toEqual(dedupeGatedLines(lines));
  });
});

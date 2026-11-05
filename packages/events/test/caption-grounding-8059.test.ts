// ADAAAA-8059 (Inc 12, PO ruling 2026-11-05) — the three vectors, at the shared
// caption gate:
//
//   1. the SCORELINE fact gate runs at the WRITE seam (`suppressScoreClaims`), so the
//      string `summaryLog.text` stores is already the suppressed string and the read
//      path never has to rewrite a served row for byte-parity (AC3b/AC10);
//   2. the READ path may DELETE but never RESTORE a clause: a `text_raw` clause the
//      seam refused (`— ball goes wide` on a window whose verdict says no shot was
//      taken) is neither a comparison source nor a fallback;
//   3. a row whose stored line is already well-formed is served from the store, never
//      traded away for a dedupe or a repair.
import { describe, it, expect } from "vitest";
import { servedShape, suppressScoreClaims } from "@highlights/events";

describe("lever 3 — the scoreline fact gate runs at the write seam (ADAAAA-8059)", () => {
  it("suppresses an uncorroborated scoreline from the stored string", () => {
    expect(suppressScoreClaims("Manuel Ordonez shoots to put Real Madrid up 2-1 in midfield.")).toBe(
      "Manuel Ordonez shoots to put Real Madrid up in midfield."
    );
    expect(suppressScoreClaims("David Saez shoots to level the game 2-2 in midfield.")).toBe(
      "David Saez shoots to level the game in midfield."
    );
    expect(suppressScoreClaims("The match is locked in a 0-0 stalemate as the attack builds")).toBe(
      "The match is locked in a stalemate as the attack builds"
    );
    expect(suppressScoreClaims("The side takes a 2-1 lead in the final third")).toBe(
      "The side takes the lead in the final third"
    );
  });

  it("leaves a clock alone (M:SS is a timestamp, never a scoreline)", () => {
    expect(suppressScoreClaims("A player shoots at 1:15 in the box.")).toBe(
      "A player shoots at 1:15 in the box."
    );
    expect(suppressScoreClaims("Nothing happens between 0:31 and 1:02.")).toBe(
      "Nothing happens between 0:31 and 1:02."
    );
  });

  it("is pure and idempotent — a stored row replays byte-for-byte", () => {
    const lines = [
      "Manuel Ordonez shoots to put Real Madrid up 2-1 in midfield.",
      "A player kicks the ball into the center.",
      "The scoreboard flashes to 0-1 after the strike",
      "A player attempts a header from the box.",
    ];
    for (const line of lines) {
      const once = suppressScoreClaims(line);
      expect(suppressScoreClaims(once)).toBe(once);
      expect(suppressScoreClaims(line)).toBe(once);
    }
  });

  it("is empty-safe", () => {
    expect(suppressScoreClaims("")).toBe("");
  });
});

describe("lever 1 — the read path deletes but never restores a clause (ADAAAA-8059)", () => {
  const gated = "A player attempts a header from the box.";
  const raw = "A player attempts a header from the box — ball goes wide";

  it("serves the stored line, not the clause text_raw carries", () => {
    const out = servedShape({
      candidate: gated,
      storedGated: gated,
      storedRaw: raw,
      quiet: true,
      regate: (s) => s,
    });
    expect(out.text).toBe(gated);
    expect(out.text).not.toContain("ball goes wide");
    expect(out.replaced).toBe(false);
  });

  it("never falls back to a raw line whose clause is an absence claim", () => {
    // A deliberately malformed candidate forces the fallback path; the raw may repair
    // content loss but may not re-introduce the refused absence claim.
    const out = servedShape({
      candidate: "A player from the box.",
      storedGated: "A player from the box.",
      storedRaw: "A player from the box — ball goes wide",
      quiet: true,
      regate: (s) => s,
    });
    expect(out.text).not.toContain("ball goes wide");
  });

  it("does not restore a goal claim the store refused, even to keep the row", () => {
    const storedGated = "The broadcast shows a replay.";
    const out = servedShape({
      candidate: storedGated,
      storedGated,
      storedRaw: "The broadcast shows a replay of Saez's goal.",
      quiet: true,
      regate: (s) => s,
    });
    expect(out.text).toBe(storedGated);
  });
});

describe("lever 2 — a stored row is never traded for a repair (ADAAAA-8059)", () => {
  it("accepts a stored line that is only a prefix of text_raw", () => {
    // seq 22 of the graded job: the served key collided only after a repair, so the
    // row was dropped. Its stored line is a complete sentence.
    const gated = "A player kicks the ball into the center.";
    const out = servedShape({
      candidate: gated,
      storedGated: gated,
      storedRaw: "A player kicks the ball into the center of the pitch.",
      quiet: true,
      regate: (s) => s,
    });
    expect(out.text).toBe(gated);
    expect(out.violations).toEqual([]);
  });
});

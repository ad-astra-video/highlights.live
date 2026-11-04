// ADAAAA-7995 — the residuals the ADAAAA-7980 served-reading QA measured on the
// v3 build (`334fe57`), replayed against the STORED log of the five fresh jobs it
// graded. The fixture is QA's own per-row table (`ad7980_rows.csv`, 142 rows):
// each row's delivered `summaryLog.text`, its audit-only `text_raw`, its stored
// verdict and its window timestamp, so these cases assert the ladder on the jobs
// the defects were found on — not on synthetic prose.
//
// Defects pinned here:
//   AC1/AC2  byte-equal pairs in the rendered ladder (34 rows / 28 distinct on
//            `47d8e506`, 36/29, 35/29, 30/25, 7/5) including the pairs the WRITE
//            seam itself created: two distinct goal claims gated to the same
//            non-goal beat, persisted twice with `text_raw` on both rows.
//   §2       MATCH SUMMARY bullets cut the chapter digest mid-phrase and inside
//            the goal count (`… 3 accepted goals (0…`).
//   AC4      `— noise spikes over the play` on a `not_highlight` row, and those
//            rows at 12-14 words (bar <= 8).
import { describe, it, expect } from "vitest";
import {
  captionBeats,
  captionColour,
  captionLineKey,
  dropColourClause,
  isQuietVerdict,
  QUIET_MAX_WORDS,
  repairDanglingTail,
} from "@highlights/events";
import { MAX_MATCH_SUMMARY_CHARS, buildSummaryLadder, gateNarrative } from "../src/summary-ladder";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "ad7980-rows.json"), "utf8")) as {
  jobs: Record<string, Array<{ seq: number; windowTs: number; verdict: string; text: string; text_raw?: string }>>;
};

const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** The ladder exactly as GET /jobs/:id/detail derives it (fast rail, stored rows). */
function ladderFor(job: string, highlights: any[] = []) {
  const entries = fixture.jobs[job].map((e, i) => ({ ...e, ts: `2026-11-04T00:00:${String(i).padStart(2, "0")}.000Z` }));
  return buildSummaryLadder({ summaryLog: entries as any, highlights, gameHint: "Fixture", fastRail: true });
}

const emittedRows = (job: string, highlights: any[] = []) =>
  ladderFor(job, highlights).chapters.flatMap((c) => c.entries.map((e) => e.text));

const JOBS = Object.keys(fixture.jobs);

describe("ADAAAA-7995 AC1 — the rendered ladder is DISTINCT on every graded job", () => {
  for (const job of JOBS) {
    it(`${job}: distinct == rows, first 20 all distinct`, () => {
      const rows = emittedRows(job);
      const keys = rows.map((t) => captionLineKey(t));
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.length - new Set(keys).size).toBe(0);
      const first20 = keys.slice(0, Math.min(20, keys.length));
      expect(new Set(first20).size).toBe(first20.length);
    });
  }

  it("no row is dropped for a NON-duplicate reason (AC3)", () => {
    for (const job of JOBS) {
      const stored = fixture.jobs[job];
      const rows = emittedRows(job);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(stored.length);
      // The ONLY step that removes a distinct row is the display cap, and it drops
      // a row only when its beat (after the read transforms: quiet colour strip,
      // first whole beat, tail repair) is already kept.
      const keptKeys = new Set(rows.map((t) => captionLineKey(t)));
      // Canonical form = the read transforms the ladder applies BEFORE the cap:
      // stock-opener/score gate, quiet colour strip, one whole beat, tail repair.
      const canonical = (e: { text: string; verdict?: string }) => {
        const gated = gateNarrative(e.text);
        const lead =
          isQuietVerdict(e.verdict) && captionColour(gated)
            ? dropColourClause(gated).replace(/[\s,;:—–-]+$/, "")
            : gated;
        return captionLineKey(repairDanglingTail(captionBeats(lead)[0] ?? lead));
      };
      const dropped = stored.filter((e) => !keptKeys.has(canonical(e)));
      const storedKeyCounts = new Map<string, number>();
      for (const e of stored) storedKeyCounts.set(canonical(e), (storedKeyCounts.get(canonical(e)) ?? 0) + 1);
      for (const e of dropped) {
        const key = canonical(e);
        // A dropped row is ALWAYS a duplicate: its canonical beat is shared with
        // another stored row (which is the one that renders).
        expect(storedKeyCounts.get(key) ?? 0).toBeGreaterThan(1);
      }
    }
  });
});

describe("ADAAAA-7995 AC2 — the gate-created pairs the WRITE seam persisted are gone", () => {
  // Every stored row that carries `text_raw` is one the write-seam gate changed.
  // Where two such rows delivered the SAME beat, the gate collapsed two distinct
  // claims (e.g. `7dbe…: No. 7 strikes the ball into the net …` and
  // `Yamal scores — …` both -> `… shoots in midfield`), and the page must render
  // that beat once. This is the whole AC2 list from the ADAAAA-7980 evidence,
  // derived from the fixture instead of hand-copied strings.
  for (const job of JOBS) {
    it(`${job}: every gate-created beat renders once, however many stored rows share it`, () => {
      const stored = fixture.jobs[job];
      const gateProduced = stored.filter((e) => (e.text_raw ?? "").trim() !== "");
      expect(gateProduced.length).toBeGreaterThan(0);
      const byBeat = new Map<string, number>();
      for (const e of gateProduced) {
        const key = captionLineKey(e.text);
        byBeat.set(key, (byBeat.get(key) ?? 0) + 1);
      }
      const rows = emittedRows(job);
      for (const [key, storedCount] of byBeat) {
        const rendered = rows.filter((t) => captionLineKey(t) === key).length;
        if (storedCount > 1) {
          // The cluster AC2 grades: two or more stored rows delivered this beat.
          expect(rendered).toBe(1);
        } else {
          // A single gate-produced row may still yield to a verbatim row that
          // states the same beat (the §3.6 display rule), so never more than one.
          expect(rendered).toBeLessThanOrEqual(1);
        }
      }
    });
  }

  it("the measured multi-row groups really are in the fixture (no vacuous pass)", () => {
    const multi = JOBS.filter((job) => {
      const byBeat = new Map<string, number>();
      for (const e of fixture.jobs[job].filter((r) => (r.text_raw ?? "").trim() !== "")) {
        const key = captionLineKey(e.text);
        byBeat.set(key, (byBeat.get(key) ?? 0) + 1);
      }
      return [...byBeat.values()].some((n) => n > 1);
    });
    // 47d8e506, 6fe19ac5, f3cf8f59 and b9275e33 each shipped a gate-created pair
    // (f705c0ee carries one quiet-colour pair as well).
    expect(multi.sort()).toEqual(["47d8e506", "6fe19ac5", "b9275e33", "f3cf8f59", "f705c0ee"]);
  });
});

describe("ADAAAA-7995 AC4 — no colour on a quiet row, and the 8-word bar holds", () => {
  for (const job of JOBS) {
    it(`${job}: no not_highlight row carries a colour clause and every one is <= 8 words`, () => {
      const stored = fixture.jobs[job];
      const rows = emittedRows(job);
      const quietTexts = new Set(stored.filter((e) => e.verdict === "not_highlight").map((e) => captionLineKey(e.text)));
      // Rows the page renders that came from a quiet stored row (key match on the
      // stored delivery, or on its colour-stripped lead).
      const quietRendered = rows.filter(
        (t) => quietTexts.has(captionLineKey(t)) || quietTexts.has(captionLineKey(t.replace(/\s*[—–]\s*$/, "")))
      );
      // A quiet row that survives the colour strip shares its lead with the stored
      // row, so match on the lead as well as the stored delivery.
      const quietLeads = new Set(
        stored
          .filter((e) => e.verdict === "not_highlight")
          .map((e) => captionLineKey(dropColourClause(e.text)))
      );
      const quietRows = rows.filter((t) => quietTexts.has(captionLineKey(t)) || quietLeads.has(captionLineKey(t)));
      expect(quietRows.length).toBeGreaterThan(0);
      for (const t of quietRows) {
        // No colour clause on a quiet row (the measured `— noise spikes over the
        // play`) and the 8-word bar.
        expect(captionColour(t)).toBe("");
        expect(wordCount(t)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
      }
      // (A LOUD row may carry the derived beat — that is the v5 channel. A row that
      // is ONLY the beat can no longer be produced: see the write-seam case in
      // packages/events/test/caption-grounding-7995.test.ts. Rows already stored
      // that way are not rewritten here — the store is append-only.)
    });
  }
});

describe("ADAAAA-7995 §2/§3 — the MATCH SUMMARY never cuts the goal count mid-phrase", () => {
  // The served bullets were `- Phase · 0:00–6:26: Player in blue jersey dribbles in
  // center field. 3 accepted goals (0…` — excerpt(c.summary, 80|56|44|32) cut
  // inside the goal-count sentence.
  const log = [
    { seq: 1, ts: "t", windowTs: 0, text: "Player in blue jersey dribbles in center field." },
    { seq: 2, ts: "t", windowTs: 383, text: "Player in white moves ball in center circle." },
  ];
  const goals = [100, 200, 300].map((ts, i) => ({
    id: `g${i}`,
    eventType: "GOAL",
    status: "accepted",
    start: ts,
    corroborated: false,
  }));

  it("keeps `N accepted goals (K corroborated).` intact in every bullet", () => {
    const l = buildSummaryLadder({ summaryLog: log as any, highlights: goals as any, gameHint: "Fixture", fastRail: true });
    expect(l.matchSummary.goalCount).toBe(3);
    const bullets = l.matchSummary.text.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets.length).toBeGreaterThan(0);
    const withGoals = bullets.filter((b) => /\d+ accepted goal/.test(b));
    expect(withGoals.length).toBeGreaterThan(0);
    for (const b of withGoals) {
      // The suffix is a whole sentence: never `(0…`, never a bare `(`.
      expect(b).toMatch(/\d+ accepted goals? \(\d+ corroborated\)\.$/);
      expect(b).not.toMatch(/\(\d*$/);
    }
  });

  it("no bullet ends mid-phrase (no ellipsis, no trailing function word)", () => {
    const l = buildSummaryLadder({ summaryLog: log as any, highlights: goals as any, gameHint: "Fixture", fastRail: true });
    expect(l.matchSummary.text.length).toBeLessThanOrEqual(MAX_MATCH_SUMMARY_CHARS);
    const bullets = l.matchSummary.text.split("\n").filter((line) => line.startsWith("- "));
    for (const b of bullets) {
      expect(b.endsWith("…")).toBe(false);
      expect(b).not.toMatch(/\b(?:in|at|on|of|to|with|and|as|while|from|the|a|an)$/i);
    }
  });

  it("a digest with goals reads `<lead sentence>. <n> accepted goals (<k> corroborated).`", () => {
    const l = buildSummaryLadder({ summaryLog: log as any, highlights: goals as any, gameHint: "Fixture", fastRail: true });
    for (const c of l.chapters) {
      if (c.goalCount === 0) continue;
      expect(c.summary).toMatch(new RegExp(`\\. ${c.goalCount} accepted goals? \\(\\d+ corroborated\\)\\.$`));
    }
  });
});

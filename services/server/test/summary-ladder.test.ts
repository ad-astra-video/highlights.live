// ADAAAA-7623: match summary ladder (chapters + match rollup + fact gate),
// derived from STORED data only. The regression fixture is the REAL stored
// payload of VOD job d61e52f6 (kids-soccer, 780 s, 260 windows, 24 accepted
// GOALs) captured read-only from the live server, so the acceptance criteria
// are asserted against the job the review found the defects on, not a synthetic
// log:
//   - <= 10 chapters + exactly one match summary,
//   - 0 uncorroborated score strings in the emitted text,
//   - a monotonic goal count,
//   - template-opener share below 10 % of emitted window narratives,
//   - zero extra decide calls (the derivation is a pure function of stored data).
import { describe, it, expect } from "vitest";
import { JobDetailSchema } from "@highlights/events";
import {
  MAX_MATCH_SUMMARY_CHARS,
  buildSummaryLadder,
  factGateScores,
  findScoreClaims,
  gateNarrative,
  hasScoreClaim,
  hasStockOpener,
  stripStockOpener,
} from "../src/summary-ladder";
import { buildPostableHighlights } from "../src/highlight-postable";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// resolveJsonModule is off in this project, so load the golden fixture directly.
const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "summary-ladder-d61e52f6.json"), "utf8")
);

const stored = fixture as any;
const log = stored.job.summaryLog as Array<{ seq: number; ts: string; windowTs: number; text: string }>;
const rawHighlights = stored.highlights as any[];
// Mirror GET /jobs/:id/detail: the ladder derives from the POSTABLE list that
// ADAAAA-7621's precision gate produces (rejected / self-contradicting clipped
// rows are excluded, overlapping windows are merged).
const postable = buildPostableHighlights(rawHighlights as any).highlights;
const ladder = buildSummaryLadder({
  summaryLog: log as any,
  highlights: postable as any,
  gameHint: stored.job.gameHint,
});

describe("fact gate (ADAAAA-7623)", () => {
  it("finds score-shaped claims", () => {
    expect(findScoreClaims("The match is locked at 0-0 as the shot goes wide")).toEqual(["0-0"]);
    expect(findScoreClaims("scoreboard flashes to 0-1")).toEqual(["0-1"]);
    expect(findScoreClaims("a 5-4 thriller")).toEqual(["5-4"]);
    expect(findScoreClaims("no score here, just 2 players and 3 passes")).toEqual([]);
  });

  it("suppresses score strings and keeps the sentence readable", () => {
    expect(factGateScores("The match is locked in a 0-0 stalemate as the attack builds")).toBe(
      "The match is locked in a stalemate as the attack builds"
    );
    expect(factGateScores("The scoreboard flashes to 0-1 after the strike")).toBe(
      "The scoreboard updates after the strike"
    );
    expect(factGateScores("The side takes a 2-1 lead in the final third")).toBe(
      "The side takes the lead in the final third"
    );
    expect(factGateScores("The home side leads 3-1 with ten minutes left")).toBe(
      "The home side leads with ten minutes left"
    );
    for (const raw of ["0-0", "0-1", "5-4", "4-6", "4-4", "2-2"]) {
      expect(hasScoreClaim(factGateScores(`The match reads ${raw} here`))).toBe(false);
    }
  });

  it("strips stock template openers by deletion, keeping the concrete content", () => {
    const cases: Array<[string, string]> = [
      [
        "The action intensifies as the blue-jerseyed attacker moves into the final third.",
        "The blue-jerseyed attacker moves into the final third.",
      ],
      [
        "The scene opens on a group of young children dressed in full Barcelona kits.",
        "A group of young children dressed in full Barcelona kits.",
      ],
      [
        "The pressure mounts as the keeper is tested from a corner.",
        "The keeper is tested from a corner.",
      ],
      [
        "The match is locked in a 0-0 stalemate as the shot goes wide.",
        "The shot goes wide.",
      ],
      [
        "The atmosphere is building as the teams walk out.",
        "The teams walk out.",
      ],
    ];
    for (const [input, expected] of cases) {
      expect(hasStockOpener(input)).toBe(true);
      expect(stripStockOpener(input)).toBe(expected);
      expect(hasStockOpener(gateNarrative(input))).toBe(false);
    }
    // Content-bearing openers are untouched.
    const concrete = "A shot from the left channel is parried by the keeper.";
    expect(hasStockOpener(concrete)).toBe(false);
    expect(stripStockOpener(concrete)).toBe("");
    expect(gateNarrative(concrete)).toBe(concrete);
  });
});

describe("summary ladder on the real d61e52f6 payload (ADAAAA-7623)", () => {
  it("renders <= 10 chapters and exactly one match summary", () => {
    expect(ladder.chapters.length).toBeGreaterThan(0);
    expect(ladder.chapters.length).toBeLessThanOrEqual(10);
    expect(ladder.matchSummary.chapterCount).toBe(ladder.chapters.length);
    expect(ladder.matchSummary.text.length).toBeGreaterThan(0);
    expect(ladder.matchSummary.text.length).toBeLessThanOrEqual(MAX_MATCH_SUMMARY_CHARS);
    // Chapter titles are unique and time-ordered (no two chapters claim the same span).
    const titles = ladder.chapters.map((c) => c.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (let i = 1; i < ladder.chapters.length; i += 1) {
      expect(ladder.chapters[i].startS).toBeGreaterThanOrEqual(ladder.chapters[i - 1].endS);
    }
  });

  it("emits 0 uncorroborated score strings anywhere in the ladder", () => {
    expect(hasScoreClaim(ladder.matchSummary.text)).toBe(false);
    expect(findScoreClaims(ladder.matchSummary.text)).toEqual([]);
    for (const chapter of ladder.chapters) {
      expect(hasScoreClaim(chapter.summary)).toBe(false);
      for (const entry of chapter.entries) {
        expect(hasScoreClaim(entry.text)).toBe(false);
      }
    }
    // The gate actually fired on the stored narrative (the review found 0-0/0-1
    // inside one 3 s window, plus invented 5-4 / 4-6 / 4-4), and nothing it
    // refused survives in the emitted text.
    expect(ladder.matchSummary.refusedScoreClaims.length).toBeGreaterThan(0);
    for (const claim of ladder.matchSummary.refusedScoreClaims) {
      expect(ladder.matchSummary.text).not.toContain(claim);
    }
  });

  it("enforces a monotonic goal count", () => {
    const timeline = ladder.matchSummary.goalTimeline;
    expect(timeline.length).toBe(ladder.matchSummary.goalCount);
    timeline.forEach((goal, i) => expect(goal.index).toBe(i + 1));
    // Non-decreasing in time.
    for (let i = 1; i < timeline.length; i += 1) {
      expect(timeline[i].ts).toBeGreaterThanOrEqual(timeline[i - 1].ts);
    }
    // Every chapter carries a subset of the match timeline with the SAME index.
    const byIndex = new Map(timeline.map((g) => [g.index, g.ts]));
    for (const chapter of ladder.chapters) {
      expect(chapter.goalCount).toBe(chapter.goals.length);
      for (const goal of chapter.goals) {
        expect(byIndex.get(goal.index)).toBe(goal.ts);
        // A chapter never claims a goal outside its own span (a goal that falls
        // on the boundary belongs to the window that CONTAINS it).
        expect(goal.ts).toBeGreaterThanOrEqual(chapter.startS);
        expect(goal.ts).toBeLessThan(chapter.endS);
      }
    }
    // The count is never allowed to regress: sum of chapter goals == timeline.
    const summed = ladder.chapters.reduce((n, c) => n + c.goalCount, 0);
    expect(summed).toBe(timeline.length);
    expect(ladder.matchSummary.verifiedGoalCount).toBeLessThanOrEqual(ladder.matchSummary.goalCount);
  });

  it("drops the template-opener share below 10 % of emitted window narratives", () => {
    const entries = ladder.chapters.flatMap((c) => c.entries);
    expect(entries.length).toBe(log.length);
    const templated = entries.filter((e) => hasStockOpener(e.text)).length;
    const share = templated / entries.length;
    // Stored narrative: 99/260 stock openers (38 %). Emitted ladder: < 10 %.
    const storedTemplated = log.filter((e) => hasStockOpener(e.text)).length;
    expect(storedTemplated / log.length).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.1);
    expect(templated).toBe(0);
  });

  it("never opens a chapter rollup with a stock template phrase", () => {
    for (const chapter of ladder.chapters) {
      expect(hasStockOpener(chapter.summary)).toBe(false);
    }
  });

  it("covers every stored window exactly once (detail-on-demand integrity)", () => {
    const seqs = ladder.chapters.flatMap((c) => c.entries.map((e) => e.seq));
    expect(seqs).toEqual(log.map((e) => e.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (const chapter of ladder.chapters) {
      expect(chapter.seqFrom).toBe(chapter.entries[0].seq);
      expect(chapter.seqTo).toBe(chapter.entries[chapter.entries.length - 1].seq);
      expect(chapter.entries.length).toBe(chapter.seqTo - chapter.seqFrom + 1);
    }
  });

  it("is derived from stored data only (zero decide calls / GPU seconds)", () => {
    expect(ladder.derivedFrom.summaryLogEntries).toBe(log.length);
    expect(ladder.derivedFrom.acceptedHighlights).toBe(postable.length);
    // Pure + deterministic: the same stored payload always yields the same ladder.
    const again = buildSummaryLadder({
      summaryLog: log as any,
      highlights: postable as any,
      gameHint: stored.job.gameHint,
    });
    expect(again).toEqual(ladder);
  });

  it("keeps the detail contract in sync (JobDetailSchema accepts the ladder)", () => {
    const parsed = JobDetailSchema.parse({
      job: {
        id: stored.job.id,
        source: "file",
        status: stored.job.status,
        createdAt: "2026-10-31T14:15:52.494Z",
        summaryLog: log,
      },
      highlights: [],
      traces: [],
      sections: [],
      maxTraces: 8,
      summaryLadder: ladder,
    });
    expect(parsed.summaryLadder?.chapters.length).toBe(ladder.chapters.length);
    expect(parsed.summaryLadder?.matchSummary.refusedScoreClaims).toEqual(
      ladder.matchSummary.refusedScoreClaims
    );
  });
});

describe("summary ladder edge cases (ADAAAA-7623)", () => {
  it("handles a job with no summary log", () => {
    const empty = buildSummaryLadder({ summaryLog: [], highlights: [], gameHint: "Soccer" });
    expect(empty.chapters).toEqual([]);
    expect(empty.matchSummary.chapterCount).toBe(0);
    expect(empty.matchSummary.goalCount).toBe(0);
    expect(empty.matchSummary.text.length).toBeLessThanOrEqual(MAX_MATCH_SUMMARY_CHARS);
  });

  it("derives the timeline from accepted GOALs only, in time order", () => {
    const out = buildSummaryLadder({
      summaryLog: [{ seq: 1, ts: "t", windowTs: 0, text: "A goal arrives as the shot is taken." }],
      highlights: [
        { id: "b", start: 40, eventType: "GOAL", status: "accepted", corroborated: false },
        { id: "a", start: 10, eventType: "GOAL", status: "accepted", corroborated: true },
        { id: "c", start: 20, eventType: "GOAL", status: "rejected" },
        { id: "d", start: 30, eventType: "SPORTING_EVENT", status: "accepted" },
      ] as any,
      gameHint: "Soccer",
    });
    expect(out.matchSummary.goalTimeline.map((g) => g.index)).toEqual([1, 2]);
    expect(out.matchSummary.goalTimeline.map((g) => g.ts)).toEqual([10, 40]);
    expect(out.matchSummary.goalCount).toBe(2);
    expect(out.matchSummary.verifiedGoalCount).toBe(1);
    expect(out.matchSummary.text).toContain("#1 0:10");
    expect(out.matchSummary.text).toContain("#2 0:40 (never corroborated)");
  });

  it("caps the rollup at 1500 chars even for a very long match", () => {
    const longLog = Array.from({ length: 400 }, (_, i) => ({
      seq: i + 1,
      ts: "t",
      windowTs: i * 3,
      text: `The action intensifies as the move builds down the left and a shot is taken from range at window ${i}.`,
    }));
    const out = buildSummaryLadder({ summaryLog: longLog as any, highlights: [], gameHint: "Soccer" });
    expect(out.chapters.length).toBeLessThanOrEqual(10);
    expect(out.matchSummary.text.length).toBeLessThanOrEqual(MAX_MATCH_SUMMARY_CHARS);
    expect(out.matchSummary.charCount).toBe(out.matchSummary.text.length);
  });
});

// ---------------------------------------------------------------------------
// ADAAAA-7958 (contract v3 §3.4 + §3.6): the SURFACE pass on the ladder.
// QA measured (job 9fecca77) a Lull chapter titled with a goal claim
// ("Lull · 5:03–5:06: Player in blue jersey shoots into the net — crowd reacts")
// while the banner said those goals were "counted, never asserted as scored".
// ---------------------------------------------------------------------------
const GOAL_CLAIM = /\b(?:goal|goals|scores?|scored|scoring|in the net|into the net)\b/i;

function ladderLog(seq: number, windowTs: number, text: string) {
  return { seq, ts: "2026-11-04T00:00:00Z", windowTs, text };
}

describe("corroboration propagation on the ladder (ADAAAA-7958 §3.4)", () => {
  const log = [
    ladderLog(1, 0, "Crowd roars as the ball is in the net"),
    ladderLog(2, 5, "Players line up for the anthem"),
  ];
  const uncorroborated = [
    { id: "h1", jobId: "j", clipUri: "/c.mp4", start: 0, end: 8, eventType: "GOAL", status: "accepted", corroborated: false, score: 90 },
  ] as any;

  it("never titles or leads a Lull chapter with a scoring claim", () => {
    const l = buildSummaryLadder({ summaryLog: log as any, highlights: uncorroborated, gameHint: "Soccer", fastRail: true });
    const lull = l.chapters.find((c) => c.kind === "lull");
    expect(lull).toBeTruthy();
    expect(lull!.title).not.toMatch(GOAL_CLAIM);
    // The rollup still COUNTS the goal ("1 accepted goal (0 corroborated)." — the
    // banner's wording); only the narrative beat may not assert it as scored.
    const lead = lull!.summary.replace(/ \d+ accepted goals? \(\d+ corroborated\)\.$/, "");
    expect(lead).not.toMatch(GOAL_CLAIM);
    // The banner and the page agree: the goal is still COUNTED, just not asserted.
    expect(l.matchSummary.goalCount).toBe(1);
    expect(l.matchSummary.verifiedGoalCount).toBe(0);
    expect(l.matchSummary.text).not.toMatch(/in the net|into the net/i);
  });

  it("keeps a corroborated goal's chapter lead byte-identical", () => {
    const corroborated = [{ ...uncorroborated[0], corroborated: true }];
    const l = buildSummaryLadder({ summaryLog: log as any, highlights: corroborated as any, gameHint: "Soccer", fastRail: true });
    expect(l.chapters[0].summary).toContain("in the net");
    // A single goal keeps the chapter's content kind (not a goal cluster).
    expect(l.chapters[0].title).toMatch(/^Lull/);
  });

  it("a goal-cluster title needs a corroborated goal; counted-only clusters degrade", () => {
    const clusterLog = [
      ladderLog(1, 0, "The blue shirt drives into the box"),
      ladderLog(2, 30, "The white shirt clears the ball wide"),
      ladderLog(3, 60, "The blue shirt drives into the box again"),
    ];
    const goals = [
      { id: "g1", jobId: "j", clipUri: "/a.mp4", start: 10, end: 20, eventType: "GOAL", status: "accepted", corroborated: false, score: 90 },
      { id: "g2", jobId: "j", clipUri: "/b.mp4", start: 40, end: 50, eventType: "GOAL", status: "accepted", corroborated: false, score: 90 },
    ] as any;
    const l = buildSummaryLadder({ summaryLog: clusterLog as any, highlights: goals, gameHint: "Soccer", fastRail: true });
    const cluster = l.chapters.find((c) => c.goals.length >= 2);
    expect(cluster).toBeTruthy();
    expect(cluster!.title).not.toMatch(/goal/i);
    expect(cluster!.goalCount).toBe(2);
    expect(cluster!.summary).toContain("2 accepted goals (0 corroborated)");

    const withOne = [{ ...goals[0], corroborated: true }, goals[1]];
    const l2 = buildSummaryLadder({ summaryLog: clusterLog as any, highlights: withOne as any, gameHint: "Soccer", fastRail: true });
    expect(l2.chapters.find((c) => c.goals.length >= 2)!.title).toMatch(/^Goal cluster \(2\)/);
  });
});

describe("emission dedupe on the ladder (ADAAAA-7958 §3.6 / AC3b)", () => {
  const repeated = [
    ladderLog(1, 0, "Player in white moves in center circle."),
    ladderLog(2, 5, "Player in white moves in center circle."),
    ladderLog(3, 10, "Player in white moves in center circle."),
    ladderLog(4, 15, "Player in blue jersey dribbles in center field"),
  ];

  it("keeps an identical window line at most twice and drops later occurrences", () => {
    const l = buildSummaryLadder({ summaryLog: repeated as any, highlights: [], fastRail: true });
    const emitted = l.chapters.flatMap((c) => c.entries.map((e) => e.text));
    const repeats = emitted.filter((t) => /center circle/i.test(t));
    expect(repeats.length).toBe(2);
    expect(emitted).toContain("Player in blue jersey dribbles in center field");
  });

  it("VOD (fastRail false / absent) is untouched — AC8", () => {
    const fast = buildSummaryLadder({ summaryLog: repeated as any, highlights: [], fastRail: false });
    const legacy = buildSummaryLadder({ summaryLog: repeated as any, highlights: [] });
    expect(fast).toEqual(legacy);
    expect(fast.chapters.flatMap((c) => c.entries)).toHaveLength(4);
  });
});

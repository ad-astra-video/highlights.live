// ADAAAA-9177 — `$0` replay of the rev-19 SERVED block through the rev-20 lane.
//
// Reads the stored bytes the grade on ADAAAA-9126 quoted (job `798f21c2`, the
// `file-sim` leg) — no DB, no model, no GPU, no decide service: the lane is fed
// each stored body as if the writer had just replied with it, in the order the
// lane log shows, and the real `runSummaryForRow` decides.
//
//   row order (lane log order, served cards first):
//     8abf948e, dd30bde1, df285a29, 0901bd41   served on rev-19
//     f7f62ed8                                 dropped (repeat), never stored
//     d9dc73b6                                 dropped (repeat), stored as a meter row
//     03cdc053                                 served on rev-19 (opening still repeated)
//
// What it measures:
//   AC2  a card whose opening repeats a served opening either serves with a
//        DIFFERENT opening or refuses with a persisted `summaryViolations` entry;
//   AC4  `summaryCalls / rows` on the same rail does not rise above rev-19's read
//        (per-row 1.000, job 1.167) — the fix bills no second call;
//   AC1  every row after the first carries `summaryPromptAvoid` = the avoid block
//        its prompt actually rendered.
import {
  gateSummaryDetail,
  summaryOpeningRun,
  summarySentencesOf,
  type SummaryEvidence,
} from "../packages/events/src/highlight-summary.js";
import { newSummaryJobState, runSummaryForRow, type SummaryLaneStore } from "../services/server/src/summary-lane.js";

const teams = [
  { name: "Portugal", side: "away" as const },
  { name: "Barcelona", side: "away" as const },
  { name: "Real Madrid", side: "home" as const },
];

const evidenceFor = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "live",
  verdict: "big_play",
  eventType: "BIG_PLAY",
  reason: "Ball shoots in midfield",
  caption: null,
  postTitle: null,
  windowTs: 278,
  windowDurationS: 15,
  matchContext: { sport: "soccer", teams },
  matchClock: { token: "04:38", seconds: 278, legible: true },
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
  ...over,
});

interface ReplayRow {
  hid: string;
  body: string;
  evidence: SummaryEvidence;
  /** What rev-19 did with this body, from the grade artifact. */
  rev19: "served" | "dropped";
}

// The stored bytes, verbatim from `ad9126-rev19-served-grade.json`.
const ROWS: ReplayRow[] = [
  {
    hid: "8abf948e",
    body: "Barcelona wins the ball back at 04:38 of the match. Real Madrid then attempts a counter as the match clock reaches 04:38.",
    evidence: evidenceFor(),
    rev19: "served",
  },
  {
    hid: "dd30bde1",
    body: "Real Madrid threads a pass at 06:16 of the match. Barcelona then counters to maintain their offensive position.",
    evidence: evidenceFor({ windowTs: 376, matchClock: { token: "06:16", seconds: 376, legible: true } }),
    rev19: "served",
  },
  {
    hid: "df285a29",
    body: "Portugal recovers the ball at 18:11 of the match to initiate a transition. Barcelona then crosses the ball to maintain their offensive presence during the play.",
    evidence: evidenceFor({ windowTs: 1091, matchClock: { token: "18:11", seconds: 1091, legible: true } }),
    rev19: "served",
  },
  {
    hid: "0901bd41",
    body: "Portugal dispossesses the ball at 22:13 of the match. Barcelona then crosses the ball to initiate a transition.",
    evidence: evidenceFor({ windowTs: 1333, matchClock: { token: "22:13", seconds: 1333, legible: true } }),
    rev19: "served",
  },
  {
    hid: "f7f62ed8",
    body: "Portugal dispossesses the ball at 10:57 into the clip. The scoreboard moves from 1-2 to 2-2 as Barcelona passes.",
    evidence: evidenceFor({ windowTs: 657, matchClock: null, scoreTransition: { from: "1-2", to: "2-2" } }),
    rev19: "dropped",
  },
  {
    hid: "d9dc73b6",
    body: "Portugal dispossesses the ball at 11:10 into the clip. The scoreboard moves from 2-2 to 2-3 as Barcelona passes.",
    evidence: evidenceFor({
      windowTs: 670,
      matchClock: null,
      scoreTransition: { from: "2-2", to: "2-3" },
      verdict: null,
      eventType: "GOAL",
    }),
    rev19: "dropped",
  },
  {
    hid: "03cdc053",
    body: "Portugal dispossesses the ball at 11:55 into the clip. The clip carries this sequence at 11:55 into the clip.",
    evidence: evidenceFor({ windowTs: 715, matchClock: { token: "11:55", seconds: 715, legible: true } }),
    rev19: "served",
  },
];

async function main(): Promise<void> {
  const state = newSummaryJobState();
  const patches: { id: string; patch: Record<string, any> }[] = [];
  const lines: string[] = [];
  const store: SummaryLaneStore = {
    async patchHighlightSummary(id, patch) {
      patches.push({ id, patch: patch as Record<string, any> });
      return {};
    },
  };
  let index = 0;
  const fetchImpl = (async () => {
    const row = ROWS[Math.min(index, ROWS.length - 1)];
    index += 1;
    return new Response(JSON.stringify({ summary: row.body }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  }) as unknown as typeof fetch;

  const cfg = {
    decideUrl: "http://decide.invalid",
    decideFee: 0.0033,
    fetchImpl,
    log: (line: string) => lines.push(line),
  };

  const perRow: any[] = [];
  for (const row of ROWS) {
    const result = await runSummaryForRow(
      store,
      cfg,
      { jobId: "798f21c2", highlightId: row.hid, evidence: row.evidence },
      state
    );
    const patch = patches.at(-1)!.patch;
    perRow.push({
      hid: row.hid,
      rev19: row.rev19,
      rev20Outcome: result.outcome,
      rev20Reason: result.reason ?? null,
      calls: result.calls,
      servedOpening: patch.summary ? summaryOpeningRun(String(patch.summary)) : null,
      servedWords: patch.summary ? gateSummaryDetail(String(patch.summary), row.evidence).words : 0,
      dram: patch.summary ? summarySentencesOf(String(patch.summary)).length : 0,
      summaryGate: patch.summaryGate,
      summaryRetryReason: patch.summaryRetryReason ?? null,
      summaryRepairRefused: patch.summaryRepairRefused ?? null,
      summaryViolations: patch.summaryViolations ?? null,
      summaryWordCount: patch.summaryWordCount ?? null,
      summaryRepairDroppedSentences: patch.summaryRepairDroppedSentences ?? null,
      promptAvoid: patch.summaryPromptAvoid ?? null,
      body: patch.summary ?? null,
      raw: patch.summaryRaw ?? null,
    });
  }

  const served = perRow.filter((row) => row.rev20Outcome === "stored");
  const openings = served.map((row) => row.servedOpening);
  const duplicateOpenings = openings.filter((run, i) => openings.indexOf(run) !== i);
  const calls = perRow.reduce((sum, row) => sum + row.calls, 0);
  const droppedRepeat = perRow.filter((row) => row.summaryGate === "dropped:repeat").length;
  const repeatClass = perRow.filter((row) => row.rev19 === "dropped" || row.summaryRetryReason === "repeat-opening");
  const ac2 = repeatClass.map((row) => ({
    hid: row.hid,
    verdict: row.rev20Outcome === "stored"
      ? `served with a DIFFERENT opening (${row.servedOpening})`
      : `refused ${row.summaryGate} with summaryViolations ${JSON.stringify(row.summaryViolations)}`,
    attributable: row.rev20Outcome === "stored" || (row.summaryViolations ?? []).length > 0 || Boolean(row.summaryRepairRefused),
  }));

  console.log(
    JSON.stringify(
      {
        ticket: "ADAAAA-9177",
        job: "798f21c2-648b-44a8-a5ff-2ad2ad8e41ee",
        rail: "file-sim",
        cost: "$0 — stored bytes replayed through the real lane, no model call",
        perRow,
        served: served.length,
        total: perRow.length,
        openings,
        duplicateOpenings,
        calls,
        callsOverRows: calls / perRow.length,
        ac4: {
          rev19PerRow: 1.0,
          rev19Job: 7 / 6,
          rev20Calls: calls,
          rev20CallsOverRows: calls / perRow.length,
          secondCalls: perRow.filter((row) => row.calls > 1).length,
        },
        ac2,
        ac1: perRow.map((row, i) => ({
          hid: row.hid,
          position: i + 1,
          promptAvoid: row.promptAvoid,
          // The openings listed must be the ones the earlier cards actually served.
          matchesEarlierServed: row.promptAvoid
            ? row.promptAvoid.openings.every((run: string) => openings.slice(0, i).includes(run))
            : i === 0,
        })),
        droppedRepeat,
        laneLog: lines,
      },
      null,
      1
    )
  );
}

void main();

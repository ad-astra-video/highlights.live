/**
 * ADAAAA-9464 `$0` replay: what the writer-round-4 change does to the STORED bodies.
 *
 * No model call, no GPU, no DB write, no deploy. The corpus is the served bytes of
 * ADAAAA-9178's rev-19 block (job `798f21c2`, 5 bodies) plus the two `a200d2bd`
 * fixtures the ADAAAA-8791/8803 tests carry (the VOD row `0526c296` at 36 words and
 * the compliant 44-word body on `48fe4280`), judged by the SERVED seam's own
 * exports.
 *
 * What it reports per row: `words / sentences / gate / calls`, the padding the seam
 * sees (`purpose tails`, `restating sentences`), the opening run (for the
 * duplicate-opening count) and whether the body clears the band TARGET.
 *
 * The 9178 corpus carries served BYTES only (no per-row reason/transcript/
 * matchContext/attestation), so those five rows are judged on the evidence-free
 * predicates the seam exports: the depth bar (`summaryWordCount`), the padding
 * predicates (`stripPurposeTails`, `summaryRestatedSentences`) and the opening run.
 * The `a200d2bd` rows DO carry evidence in the test fixtures, so they go through
 * the full `gateSummaryDetail`.
 *
 * Usage:
 *   npx tsx evals/adaaa_9464/replay9464.ts [--json=<out.json>]
 */
import { writeFileSync } from "node:fs";
import {
  dropSentences,
  SUMMARY_LIVE_BAND,
  SUMMARY_VOD_BAND,
  gateSummaryDetail,
  stripPurposeTails,
  summaryOpeningRun,
  summaryRestatedSentences,
  summarySentenceCount,
  summarySentenceAsk,
  summaryServeWordBar,
  summaryWordCount,
  type SummaryEvidence,
} from "../../packages/events/src/index.js";

const arg = (name: string): string | null => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

interface ServedCard {
  hid: string;
  hid8: string;
  gate: string;
  words: number;
  body: string;
  summaryCalls: number;
}

interface Corpus {
  job: string;
  label: string;
  rows: ServedCard[];
}

// The rev-19 served block, verbatim (ADAAAA-9178's corpus, kept in the 9178 eval so
// the two replays read the same bytes).
const REV19: Corpus = JSON.parse(
  JSON.stringify({
    job: "798f21c2-648b-44a8-a5ff-2ad2ad8e41ee",
    label: "rev-19 served block (job 798f21c2, 5 served bodies)",
    rows: [
      {
        hid: "df285a29-e7d5-4dcf-ad76-abe117868d25",
        hid8: "df285a29",
        gate: "neutralised",
        words: 26,
        body: "Portugal recovers the ball at 18:11 of the match to initiate a transition. Barcelona then crosses the ball to maintain their offensive presence during the play.",
        summaryCalls: 1,
      },
      {
        hid: "8abf948e-504d-4811-9c84-b533bed87c51",
        hid8: "8abf948e",
        gate: "neutralised",
        words: 22,
        body: "Barcelona wins the ball back at 04:38 of the match. Real Madrid then attempts a counter as the match clock reaches 04:38.",
        summaryCalls: 1,
      },
      {
        hid: "03cdc053-0f2d-4d9d-ae2c-03300e2e3b5e",
        hid8: "03cdc053",
        gate: "accepted",
        words: 19,
        body: "Portugal dispossesses the ball at 11:55 into the clip. The clip carries this sequence at 11:55 into the clip.",
        summaryCalls: 1,
      },
      {
        hid: "dd30bde1-7758-4213-87ac-0995c3417fd4",
        hid8: "dd30bde1",
        gate: "neutralised",
        words: 18,
        body: "Real Madrid threads a pass at 06:16 of the match. Barcelona then counters to maintain their offensive position.",
        summaryCalls: 1,
      },
      {
        hid: "0901bd41-b266-4b52-88bd-3c02f710fbe9",
        hid8: "0901bd41",
        gate: "neutralised",
        words: 18,
        body: "Portugal dispossesses the ball at 22:13 of the match. Barcelona then crosses the ball to initiate a transition.",
        summaryCalls: 1,
      },
    ],
  })
);

// The `a200d2bd` fixtures, with the evidence the ADAAAA-8791/8803 tests carry.
const A200D2BD: { hid8: string; label: string; body: string; evidence: SummaryEvidence }[] = [
  {
    hid8: "0526c296",
    label: "stored 36-word VOD body (job a200d2bd)",
    body: "Barcelona finds the back of the net to level the score at 2-2. The crowd erupts in celebration as the scoreboard updates during this scoring play. This goal occurs at the 1:27 mark of the clip.",
    evidence: {
      rail: "vod",
      verdict: "scoring_play",
      eventType: "GOAL",
      reason:
        "The scoreboard changes from 1-1 to 2-1 at 18:06, and the ASR confirms 'Acaba de marcar el Real Madrid' while the frames show a player in a white kit (Real Madrid) celebrating.; scoreboard score change confirmed",
      caption: null,
      postTitle: null,
      windowTs: 87,
      windowDurationS: 15,
      scoreTransition: { from: "2-1", to: "2-2" },
      matchContext: { teams: [{ name: "Barcelona", side: "away" }] },
      transcript: null,
    },
  },
  {
    hid8: "48fe4280",
    label: "compliant 44-word VOD body on the same job (48fe4280)",
    body:
      "Barcelona works the ball through the middle as the scoreboard moves to 2-1 at 0:27 into the clip. " +
      "Real Madrid intercepts the ball near the touchline and counters at 0:31 of the clip. " +
      "Barcelona recovers the ball and threads a pass to the far side. " +
      "The scoreboard reads 2-1 as the clip runs past 0:27.",
    evidence: {
      rail: "vod",
      verdict: "scoring_play",
      eventType: "GOAL",
      reason: "Goal confirmed by the frame dive.",
      caption: "GOAL · 0:27",
      postTitle: "GOAL · 0:27",
      windowTs: 27,
      windowDurationS: 15,
      scoreTransition: { from: "1-1", to: "2-1" },
      matchContext: { teams: [{ name: "Barcelona", side: "away" }, { name: "Real Madrid", side: "home" }] },
      transcript: null,
    },
  },
];

const quantile = (xs: number[], q: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

// --- corpus A: the 5 stored rev-19 bodies (evidence-free predicates) ----------
interface Rev19Row {
  hid8: string;
  /** Words AFTER the seam's own deletions (the body the gate judges). */
  words: number;
  rawWords: number;
  rawSentences: number;
  sentences: number;
  bar: number;
  gate: string;
  calls: number;
  clearsTarget: boolean;
  purposeTails: number;
  purposeTailAffordable: boolean;
  restated: number;
  opening: string;
  servedWords: number | null;
}

const rev19: Rev19Row[] = REV19.rows.map((row) => {
  const words = summaryWordCount(row.body);
  const sentences = summarySentenceCount(row.body);
  const bar = SUMMARY_LIVE_BAND.targetMinWords;
  // The SEAM's own deletions, evidence-free by construction: `stripPurposeTails` is a
  // closed vocabulary of non-facts, and the rev-19 block is a `clock` + `action`
  // block (three attested actors), so every row's serve bar is the target and the
  // gate deletes a tail outright instead of keeping it for the floor (ADAAAA-9464).
  const purpose = stripPurposeTails(row.body);
  const restated = summaryRestatedSentences(purpose.text).filter((report) => report.restated);
  const restatedText = restated.length > 0 ? dropSentences(purpose.text, restated.map((r) => r.sentence)) : purpose.text;
  const judgedWords = summaryWordCount(restatedText);
  const judgedSentences = summarySentenceCount(restatedText);
  const clearsTarget = judgedWords >= bar;
  // Projection, not a measured lane call: a body at or above the target on the SEAM'S
  // OWN bytes serves on ONE call; a body under it takes the single AC5 retry (2
  // calls) and then serves at the FLOOR (>= 18) or drops. The corpus has no second
  // sample, so the post-retry state is the floor accept at the SEAM'S judged words.
  const calls = clearsTarget ? 1 : 2;
  const servedWords = clearsTarget ? judgedWords : judgedWords >= SUMMARY_LIVE_BAND.floorWords ? judgedWords : null;
  return {
    hid8: row.hid8,
    words: judgedWords,
    sentences: judgedSentences,
    rawWords: words,
    rawSentences: sentences,
    bar,
    gate: clearsTarget ? "served:>=target" : servedWords === null ? "refused:too-few-words" : "refused->floor-accept",
    calls,
    clearsTarget,
    purposeTails: purpose.stripped.length,
    purposeTailAffordable: summaryWordCount(purpose.text) >= SUMMARY_LIVE_BAND.floorWords,
    restated: restated.length,
    opening: summaryOpeningRun(row.body),
    servedWords,
  };
});

// --- corpus B: the a200d2bd fixtures (full gate, with evidence) ---------------
interface VodRow {
  hid8: string;
  label: string;
  words: number;
  sentences: number;
  bar: number;
  budget: number;
  gate: string;
  calls: number;
  violations: string[];
  servedWords: number | null;
}

const a200: VodRow[] = A200D2BD.map((row) => {
  const decision = gateSummaryDetail(row.body, row.evidence);
  const words = summaryWordCount(row.body);
  const served = decision.summary ? summaryWordCount(decision.summary) : null;
  const clears = decision.summary !== null;
  const aboveFloor = served !== null && served >= SUMMARY_VOD_BAND.floorWords;
  const calls = clears ? 1 : aboveFloor ? 2 : 2;
  return {
    hid8: row.hid8,
    label: row.label,
    words,
    sentences: summarySentenceCount(row.body),
    bar: summaryServeWordBar(row.evidence),
    budget: summarySentenceAsk(row.evidence).budgetWords,
    gate: clears ? `served:${decision.gate}` : `refused:${decision.violations.join(",")}`,
    calls,
    violations: decision.violations,
    servedWords: served,
  };
});

// --- report ------------------------------------------------------------------
const pad = (v: string | number, n: number) => String(v).padStart(n);
const rpad = (v: string | number, n: number) => String(v).padEnd(n);

const revWords = rev19.map((r) => r.rawWords);
const seamWords = rev19.map((r) => r.words);
const servedWords = rev19.map((r) => r.servedWords).filter((n): n is number => typeof n === "number");

console.log(`job=${REV19.job} corpus="${REV19.label}"`);
console.log("");
console.log("## AC3 — the 5 stored rev-19 bodies through the target bar");
console.log("| row | stored words | seam words | sentences | gate | calls | served words | >= target? |");
console.log("| --- | ---: | ---: | ---: | --- | ---: | ---: | --- |");
for (const r of rev19) {
  console.log(
    `| \`${r.hid8}\` | ${r.rawWords} | ${r.words} | ${r.sentences} | ${r.gate} | ${r.calls} | ${r.servedWords ?? "—"} | ${r.clearsTarget ? "yes" : "no"} |`
  );
}
console.log("");
console.log(
  `stored n=${rev19.length} min=${Math.min(...revWords)} p10=${quantile(revWords, 0.1)} p50=${quantile(revWords, 0.5)} max=${Math.max(...revWords)}`
);
const storedClears = rev19.filter((r) => r.rawWords >= SUMMARY_LIVE_BAND.targetMinWords).length;
console.log(
  `rows that clear a ${SUMMARY_LIVE_BAND.targetMinWords}-word budget: ${storedClears}/${rev19.length} as written; ${rev19.filter((r) => r.clearsTarget).length}/${rev19.length} once the seam deletes the bytes that carry no fact (seam p50 ${quantile(seamWords, 0.5)})`
);
console.log(
  `projected calls: ${rev19.reduce((n, r) => n + r.calls, 0)} across ${rev19.length} rows (${rev19.filter((r) => r.calls === 2).length} take the one AC5 retry) — the stored block billed ${REV19.rows.length}`
);
console.log(
  `projected SERVED words if the retry re-lands the same bytes: n=${servedWords.length} p50=${quantile(servedWords, 0.5)} — this is the FLOOR-ACCEPT projection, not a claim about the next sample`
);
console.log("");

const tailRows = rev19.filter((r) => r.purposeTails > 0);
const restatedRows = rev19.filter((r) => r.restated > 0);
const openings = rev19.map((r) => r.opening);
const dupOpenings = openings.length - new Set(openings).size;
console.log("## AC3 — padding and repetition on the same bytes");
console.log(
  `purpose/manner tails the seam SEES: ${rev19.reduce((n, r) => n + r.purposeTails, 0)} across ${tailRows.length}/${rev19.length} bodies (affordable to delete without falling under the ${SUMMARY_LIVE_BAND.floorWords}-word floor: ${tailRows.filter((r) => r.purposeTailAffordable).length})`
);
console.log(
  `sentences that restate the body's own facts: ${rev19.reduce((n, r) => n + r.restated, 0)} across ${restatedRows.length}/${rev19.length} bodies`
);
console.log(`duplicate opening runs across the block: ${dupOpenings}`);
console.log(
  `served bodies that would carry a tail after the gate: ${rev19.filter((r) => r.servedWords !== null && r.purposeTails > 0 && !r.purposeTailAffordable).length} (those rows are refused at the target, so 0 tails reach a card)`
);
console.log("");

console.log("## AC3 — the `a200d2bd` fixtures through the full gate (VOD band untouched)");
console.log("| row | words | sentences | serve bar | ask budget | gate | calls | served |");
console.log("| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |");
for (const r of a200) {
  console.log(
    `| \`${r.hid8}\` | ${r.words} | ${r.sentences} | ${r.bar} | ${r.budget} | ${r.gate} | ${r.calls} | ${r.servedWords ?? "—"} |`
  );
}
console.log("");
console.log(
  `VOD band unchanged: floor ${SUMMARY_VOD_BAND.floorWords} / target ${SUMMARY_VOD_BAND.targetMinWords}. The stored 36-word body ${a200[0].gate.startsWith("served") ? "serves" : "is refused"} and the compliant fixture serves at ${a200[1].servedWords ?? "—"} words after the restating sentence is dropped — the target bar is 45 and the floor (40) is the drop threshold.`
);

const out = arg("json");
if (out) {
  writeFileSync(out, JSON.stringify({ rev19, a200d2bd: a200 }, null, 1));
  console.log(`\nwrote ${out}`);
}

void pad;
void rpad;

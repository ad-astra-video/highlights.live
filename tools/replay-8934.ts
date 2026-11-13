// ADAAAA-8934/8968 — $0 replay of the 13 stored rev-8 VOD rows through the gate
// AND through the retry lane's billing policy.
//
// Reads the row dump (no DB, no model, no GPU) and reports, per row:
//   served/dropped, words, sentences, substituted clauses, and the number of
//   served sentences that carry NO attested fact (AC14's own measure);
//   plus the LANE's call count for that row and the drop reason the lane names.
//
// ADAAAA-8968 (AC5): the corpus carries ONE body per row (the served body on a
// served row, the last refused reply on a dropped one), so the replay cannot
// sample the model twice. What it CAN do is apply the lane's own policy to that
// body: a row the gate serves (accepted or repaired) bills ONE call; a row the
// gate refuses bills the single retry the lane spends when the refusal is
// repairable, and a deterministic refusal (`too-few-facts` on a row whose own
// evidence cannot nourish two fact kinds, an invented name, an internal token)
// bills ONE call and drops, exactly as `runSummaryForRow` does. No row can bill
// a third call: `SUMMARY_MAX_CALLS_PER_ROW` is the loop bound and the replay
// fails if any row exceeds it. `callsPerRow` here is therefore the lane's POLICY
// count on stored bytes — the rev-9 leg (ADAAAA-8938) is the funded measurement
// of two real samples. The stored rev-8 measurement is printed beside it.
//
// Bars (exit 1 on a miss, so the tool doubles as a `$0` gate):
//   1. callsPerRow <= AC5_CALLS_PER_ROW_BAR (1.5)
//   2. factlessSentencesInServedBodies == 0
//   3. targetFillerSentencesSurviving == 0
//   4. no row bills more than SUMMARY_MAX_CALLS_PER_ROW calls
import { readFileSync } from "node:fs";
import {
  SUMMARY_MAX_CALLS_PER_ROW,
  SUMMARY_VOD_BAND,
  gateSummaryDetail,
  summaryRefusalIsRepairable,
  summarySentencesOf,
  unattestedSentences,
  summaryViolations,
  sentenceSimilarity,
} from "../packages/events/src/highlight-summary.js";
import { summaryEvidenceForRow } from "../services/server/src/summary-lane.js";

/** AC5's stored-corpus bar: 25 calls / 13 rows = 1.92 before this lane change. */
const AC5_CALLS_PER_ROW_BAR = 1.5;

const rows = JSON.parse(readFileSync(process.argv[2], "utf8")) as any[];
const TARGETS = [
  "Barcelona maintains possession while moving the ball toward the goal.",
  "Barcelona maintains possession to advance the play and move the ball toward the goal.",
  "Barcelona continues to press for control.",
  "Barcelona works the ball forward as the play develops.",
  "Barcelona works the ball forward as the score changes.",
  "Barcelona works the ball forward to create a scoring opportunity.",
];

let served = 0;
let factlessServed = 0;
let targetSurvived = 0;
let laneCalls = 0;
let storedCalls = 0;
let rowsRetried = 0;
let rowsDroppedAfterRetry = 0;
const failures: string[] = [];
const lines: string[] = [];
for (const row of rows) {
  const evidence = summaryEvidenceForRow(
    {
      verdict: row.verdict,
      eventType: row.eventType,
      outcome: row.outcome,
      reason: row.reason,
      caption: row.caption,
      postTitle: row.postTitle,
      trigger: { timestamp: row.triggerTs, durationS: row.triggerDur },
      start: row.start,
      end: row.end,
      matchClock: row.matchClock,
      deferredAttestation: row.deferredAttestation,
      attestationUsed: row.attestationUsed,
      asrTranscript: row.asrTranscript,
      matchContext: row.matchContext,
    },
    "vod"
  );
  const raw: string = row.summaryRaw ?? row.summary ?? "";
  const decision = gateSummaryDetail(raw, evidence);
  const body = decision.summary ?? "";
  const sentences = body ? summarySentencesOf(body) : [];
  const factless = body ? unattestedSentences(body, evidence).length : 0;
  const survived = TARGETS.filter((t) => body.includes(t));
  // ADAAAA-8934: the worst pairwise similarity INSIDE one served body (a body
  // that restates one fact three times scores high here even when every sentence
  // carries an attested kind).
  let intraRepeat = 0;
  for (let a = 0; a < sentences.length; a += 1) {
    for (let b = a + 1; b < sentences.length; b += 1) {
      intraRepeat = Math.max(intraRepeat, sentenceSimilarity(sentences[a], sentences[b]));
    }
  }
  // --- ADAAAA-8968: the retry lane's policy on this stored body -------------
  // `runSummaryForRow` drops a deterministic refusal on ONE call; every other
  // refusal earns the one retry inside `SUMMARY_MAX_CALLS_PER_ROW`.
  const deterministic = decision.violations.some((v) => !summaryRefusalIsRepairable(v, evidence));
  const calls = decision.summary ? 1 : deterministic ? 1 : 2;
  const fillerDrop =
    !decision.summary &&
    !deterministic &&
    decision.droppedClauses.length > 0 &&
    decision.repairedWords < SUMMARY_VOD_BAND.floorWords;
  const dropReason = decision.summary ? null : fillerDrop ? "filler" : "gate";
  if (calls > 1) rowsRetried += 1;
  if (calls > 1 && !decision.summary) rowsDroppedAfterRetry += 1;
  if (calls > SUMMARY_MAX_CALLS_PER_ROW) {
    failures.push(`${row.id.slice(0, 8)}: billed ${calls} calls, above SUMMARY_MAX_CALLS_PER_ROW`);
  }
  laneCalls += calls;
  storedCalls += typeof row.summaryCalls === "number" ? row.summaryCalls : 0;
  if (decision.summary) served += 1;
  factlessServed += factless;
  targetSurvived += survived.length;
  lines.push(
    JSON.stringify({
      id: row.id.slice(0, 8),
      rail: "vod",
      gate: decision.gate,
      served: Boolean(decision.summary),
      words: decision.words,
      sentences: decision.sentences,
      floor: SUMMARY_VOD_BAND.floorWords,
      repairedWords: decision.repairedWords,
      droppedClauses: decision.droppedClauses,
      substitutedClauses: decision.substitutedClauses,
      violations: decision.violations.length > 0 ? decision.violations : summaryViolations(raw, evidence),
      factlessSentencesInServedBody: factless,
      intraRepeat: body ? Number(intraRepeat.toFixed(2)) : null,
      targetFillerSurvived: survived,
      // ADAAAA-8968 (AC5): the lane's call count and drop reason for this row.
      deterministicRefusal: deterministic,
      laneCalls: calls,
      dropReason,
      servedBody: body,
    })
  );
}
console.log(lines.join("\n"));
const callsPerRow = laneCalls / rows.length;
const result = {
  total: rows.length,
  served,
  dropped: rows.length - served,
  coverage: served / rows.length,
  factlessSentencesInServedBodies: factlessServed,
  targetFillerSentencesSurviving: targetSurvived,
  summaryCalls: laneCalls,
  callsPerRow: Number(callsPerRow.toFixed(3)),
  rowsRetried,
  rowsDroppedAfterRetry,
  storedRev8SummaryCalls: storedCalls,
  storedRev8CallsPerRow: Number((storedCalls / rows.length).toFixed(3)),
  bar: AC5_CALLS_PER_ROW_BAR,
};
console.log(JSON.stringify(result));

if (callsPerRow > AC5_CALLS_PER_ROW_BAR) failures.push(`callsPerRow ${callsPerRow.toFixed(3)} > ${AC5_CALLS_PER_ROW_BAR}`);
if (factlessServed !== 0) failures.push(`factlessSentencesInServedBodies ${factlessServed} != 0`);
if (targetSurvived !== 0) failures.push(`targetFillerSentencesSurviving ${targetSurvived} != 0`);
if (failures.length > 0) {
  console.error(`RESULT: FAIL (${failures.length})`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(
  `RESULT: PASS — coverage ${result.coverage.toFixed(3)}, callsPerRow ${result.callsPerRow} <= ${AC5_CALLS_PER_ROW_BAR}, factless 0, target filler 0, max ${SUMMARY_MAX_CALLS_PER_ROW} calls/row`
);

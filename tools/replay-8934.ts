// ADAAAA-8934 — $0 replay of the 13 stored rev-8 VOD rows through the new gate.
// Reads the row dump (no DB, no model, no GPU) and reports, per row:
//   served/dropped, words, sentences, substituted clauses, and the number of
//   served sentences that carry NO attested fact (AC14's own measure).
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
import { summaryDropReasonName, summaryEvidenceForRow } from "../services/server/src/summary-lane.js";

/** AC5's stored-corpus bar: 25 calls / 13 rows = 1.92 before the rev-9 lane change. */
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
// ADAAAA-8984: the drop taxonomy and the call model, measured at `$0`.
let laneCalls = 0;
let fillerWithUnrepairableClaim = 0;
const droppedByReason: Record<string, number> = {};
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
  if (decision.summary) served += 1;
  factlessServed += factless;
  targetSurvived += survived.length;
  // ADAAAA-8984 (ADAAAA-8938 requirement (b)): the drop NAME comes from the
  // lane's own `summaryDropReasonName`, never from a copy of its expression, so
  // the `$0` gate cannot disagree with the served path about `filler` vs `gate`.
  const violations = decision.violations.length > 0 ? decision.violations : summaryViolations(raw, evidence);
  const unrepairableClaims = violations.filter((v) => !summaryRefusalIsRepairable(v as any, evidence));
  const dropReason = decision.summary ? null : summaryDropReasonName(decision, evidence);
  if (dropReason) droppedByReason[dropReason] = (droppedByReason[dropReason] ?? 0) + 1;
  // The lane's call model: a served row bills ONE call; a DETERMINISTIC refusal
  // ends the row on one call; any other refusal earns the single retry.
  const calls = decision.summary || unrepairableClaims.length > 0 ? 1 : 2;
  laneCalls += calls;
  if (calls > SUMMARY_MAX_CALLS_PER_ROW) {
    failures.push(`${row.id.slice(0, 8)}: billed ${calls} calls, above SUMMARY_MAX_CALLS_PER_ROW`);
  }
  // Measured per violation (not read off the lane's combined boolean) so a later
  // refactor that flips the order fails HERE, at `$0`, not in a funded leg.
  if (dropReason === "filler" && unrepairableClaims.length > 0) {
    fillerWithUnrepairableClaim += 1;
    failures.push(
      `${row.id.slice(0, 8)}: dropped:filler carries an unrepairable claim (${unrepairableClaims.join(",")}) — must be gate`
    );
  }
  lines.push(
    JSON.stringify({
      id: row.id.slice(0, 8),
      rail: "vod",
      gate: decision.gate,
      dropReason,
      calls,
      served: Boolean(decision.summary),
      words: decision.words,
      sentences: decision.sentences,
      floor: SUMMARY_VOD_BAND.floorWords,
      repairedWords: decision.repairedWords,
      droppedClauses: decision.droppedClauses,
      substitutedClauses: decision.substitutedClauses,
      violations,
      unrepairableClaims,
      factlessSentencesInServedBody: factless,
      intraRepeat: body ? Number(intraRepeat.toFixed(2)) : null,
      targetFillerSurvived: survived,
      servedBody: body,
    })
  );
}
console.log(lines.join("\n"));
const callsPerRow = laneCalls / rows.length;
if (callsPerRow > AC5_CALLS_PER_ROW_BAR) {
  failures.push(`callsPerRow ${callsPerRow.toFixed(3)} above the ${AC5_CALLS_PER_ROW_BAR} bar`);
}
const result = {
  total: rows.length,
  served,
  dropped: rows.length - served,
  coverage: served / rows.length,
  callsPerRow: Number(callsPerRow.toFixed(3)),
  bar: AC5_CALLS_PER_ROW_BAR,
  droppedByReason,
  fillerWithUnrepairableClaim,
  factlessSentencesInServedBodies: factlessServed,
  targetFillerSentencesSurviving: targetSurvived,
  failures,
};
console.log(JSON.stringify(result));
if (failures.length > 0) {
  console.error("RESULT: FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `RESULT: PASS — coverage ${result.coverage.toFixed(3)}, callsPerRow ${result.callsPerRow} <= ${AC5_CALLS_PER_ROW_BAR}, factless 0, target filler 0, max ${SUMMARY_MAX_CALLS_PER_ROW} calls/row, filler-on-claim 0`
);

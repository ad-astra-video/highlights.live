// ADAAAA-8934 — $0 replay of the 13 stored rev-8 VOD rows through the new gate.
// Reads the row dump (no DB, no model, no GPU) and reports, per row:
//   served/dropped, words, sentences, substituted clauses, and the number of
//   served sentences that carry NO attested fact (AC14's own measure).
import { readFileSync } from "node:fs";
import {
  SUMMARY_VOD_BAND,
  gateSummaryDetail,
  summarySentencesOf,
  unattestedSentences,
  summaryViolations,
  sentenceSimilarity,
} from "../packages/events/src/highlight-summary.js";
import { summaryEvidenceForRow } from "../services/server/src/summary-lane.js";

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
      servedBody: body,
    })
  );
}
console.log(lines.join("\n"));
console.log(
  JSON.stringify({
    total: rows.length,
    served,
    dropped: rows.length - served,
    coverage: served / rows.length,
    factlessSentencesInServedBodies: factlessServed,
    targetFillerSentencesSurviving: targetSurvived,
  })
);

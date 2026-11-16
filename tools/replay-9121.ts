// ADAAAA-9121 — `$0` census of job `1e0d7187` (the rev-17 served block's
// repeat-retry leg). No model call, no GPU, no DB write: it rebuilds every stored
// row's evidence from the row dump, then measures THREE things.
//
//  1. the STORED drafts through the served gate + the AC14.3 cross-card bar
//     (reproduces 2/7 served, 5/5 repeat-retry rows dry);
//  2. drafts that follow the writer-round-3 rotation rule, in the lane's row
//     order (the lever's projection: 7/7 served, every body >= the floor, every
//     sentence pair under the bar);
//  3. the PROMPT the lane now composes for each card: the spent actor-and-act
//     pairs must appear on card 2..n, and the banned substance shapes on all.
//
// Usage: npx tsx tools/replay-9121.ts [rowDump.json] [compliant-drafts.json]
import { readFileSync } from "node:fs";
import {
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
  attestedActorNames,
  attestedFactKinds,
  buildSummaryPrompt,
  gateSummaryDetail,
  sentenceSimilarity,
  summaryBand,
  summaryFactMenu,
  summarySentencesOf,
  summarySpentActPairs,
  summaryWordCount,
  type SummaryEvidence,
} from "../packages/events/src/highlight-summary.js";
import { summaryEvidenceForRow } from "../services/server/src/summary-lane.js";

const ROWS = process.argv[2] ?? "evals/adaaa_9121/job-1e0d7187-rows.json";
const COMPLIANT = process.argv[3] ?? "evals/adaaa_9121/compliant-drafts.json";
const bundle = JSON.parse(readFileSync(ROWS, "utf8")) as { job: any; rows: any[] };
const compliant = JSON.parse(readFileSync(COMPLIANT, "utf8")) as Record<string, string>;
const band = summaryBand("live");
const hid = (row: any) => String(row.id).slice(0, 8);

const evidenceFor = (row: any): SummaryEvidence =>
  summaryEvidenceForRow(
    {
      verdict: row.verdict ?? row.outcome,
      eventType: row.eventType,
      outcome: row.outcome,
      reason: row.reason_raw,
      caption: row.caption,
      postTitle: row.postTitle,
      trigger: row.trigger,
      start: row.start,
      end: row.end,
      matchClock: row.matchClock,
      attestationUsed: row.attestationUsed,
      goalConfirmed: row.confirmAttestation?.goalConfirmed ?? null,
      confirmAttestation: row.confirmAttestation,
      asrTranscript: row.asrTranscript,
      matchContext: bundle.job.matchContext,
    },
    "live"
  );

type RowResult = {
  hid: string;
  retry: string | null;
  storedGate: string;
  storedWords: number;
  storedServed: boolean;
  projectionGate: string;
  projectionWords: number;
  projectionServed: boolean;
  worstAgainstServed: number;
  spentPairs: string[];
  promptHasSpentPairs: boolean;
  promptHasBannedShapes: boolean;
};

const storedRows: RowResult[] = [];
const servedStored: string[] = [];
const servedProjection: string[] = [];
let worstStored = 0;
let worstProjection = 0;
let spentPairs: string[] = [];

for (const row of bundle.rows) {
  const evidence = evidenceFor(row);
  const actors = attestedActorNames(evidence);
  const stored = String(row.summaryRaw ?? row.summary ?? "").trim();

  // (3) the prompt the lane composes for THIS card, with the job state it would
  // carry at this point in the row order (prompt-first rotation).
  const prompt = buildSummaryPrompt({ ...evidence, ...(spentPairs.length > 0 ? { avoidActs: [...spentPairs] } : {}) });

  const storedDecision = gateSummaryDetail(stored, evidence, servedStored.length > 0 ? { avoidSentences: servedStored } : undefined);
  const storedSentences = storedDecision.summary ? summarySentencesOf(storedDecision.summary) : [];
  let storedWorst = 0;
  for (const sentence of storedSentences) for (const other of servedStored) storedWorst = Math.max(storedWorst, sentenceSimilarity(sentence, other));
  const storedServed = Boolean(storedDecision.summary) && storedWorst < SUMMARY_SENTENCE_REPEAT_THRESHOLD;
  worstStored = Math.max(worstStored, storedWorst);
  if (storedServed && storedDecision.summary) servedStored.push(...summarySentencesOf(storedDecision.summary));

  const projection = compliant[hid(row)] ?? "";
  const projectionDecision = gateSummaryDetail(projection, evidence, servedProjection.length > 0 ? { avoidSentences: servedProjection } : undefined);
  const projectionSentences = projectionDecision.summary ? summarySentencesOf(projectionDecision.summary) : [];
  let projectionWorst = 0;
  for (const sentence of projectionSentences) for (const other of servedProjection) projectionWorst = Math.max(projectionWorst, sentenceSimilarity(sentence, other));
  const projectionServed = Boolean(projectionDecision.summary) && projectionWorst < SUMMARY_SENTENCE_REPEAT_THRESHOLD;
  worstProjection = Math.max(worstProjection, projectionWorst);
  if (projectionServed && projectionDecision.summary) servedProjection.push(...summarySentencesOf(projectionDecision.summary));

  storedRows.push({
    hid: hid(row),
    retry: row.summaryRetryReason ?? null,
    storedGate: !storedDecision.summary
      ? `refused:${storedDecision.violations.join(",")} ${storedDecision.words}w`
      : storedServed
        ? `served ${storedDecision.words}w`
        : `AC14 repeat ${storedWorst.toFixed(3)} ${storedDecision.words}w`,
    storedWords: storedDecision.words,
    storedServed,
    projectionGate: projectionDecision.summary ? `served ${projectionDecision.words}w` : `refused:${projectionDecision.violations.join(",")} ${projectionDecision.words}w`,
    projectionWords: projectionDecision.words,
    projectionServed,
    worstAgainstServed: Number((projectionServed ? projectionWorst : storedWorst).toFixed(3)),
    spentPairs: summarySpentActPairs([projection], actors),
    promptHasSpentPairs: prompt.includes("already spend these actor-and-act pairs"),
    promptHasBannedShapes: prompt.includes("BANNED SUBSTANCE SHAPES"),
  });

  // The lane only spends a pair once the body SERVES, so the projection's pairs
  // are the state the next card sees.
  if (projectionServed) spentPairs.push(...summarySpentActPairs([projection], actors));
}

const repeatRetry = storedRows.filter((row) => row.retry && row.retry.startsWith("repeat-"));
const census = {
  issue: "ADAAAA-9121",
  job: bundle.job.id,
  band,
  rows: storedRows,
  stored: {
    served: storedRows.filter((row) => row.storedServed).map((row) => row.hid),
    servedCount: storedRows.filter((row) => row.storedServed).length,
    total: storedRows.length,
    repeatRetryRows: repeatRetry.map((row) => row.hid),
    repeatRetryServed: repeatRetry.filter((row) => row.storedServed).length,
    worstPair: Number(worstStored.toFixed(3)),
    droppedRepeat: bundle.rows.filter((row) => row.summaryGate === "dropped:repeat").length,
  },
  projection: {
    served: storedRows.filter((row) => row.projectionServed).map((row) => row.hid),
    servedCount: storedRows.filter((row) => row.projectionServed).length,
    total: storedRows.length,
    repeatRetryServed: repeatRetry.filter((row) => row.projectionServed).length,
    worstPair: Number(worstProjection.toFixed(3)),
    minWords: Math.min(...storedRows.map((row) => row.projectionWords)),
    words: storedRows.map((row) => row.projectionWords),
  },
  prompt: {
    cardsWithSpentPairs: storedRows.filter((row) => row.promptHasSpentPairs).map((row) => row.hid),
    cardsWithBannedShapes: storedRows.filter((row) => row.promptHasBannedShapes).length,
    uniqueSpentPairs: new Set(storedRows.flatMap((row) => row.spentPairs)).size,
  },
  summaryCalls: "by construction 1/row on the projection (no retry of any kind)",
};

console.log(`band(live) ${band.minSentences}-${band.maxSentences} sentences, floor ${band.floorWords}, target ${band.targetMinWords}-${band.targetMaxWords}`);
console.log(`\nrow       retry           STORED                          PROJECTION                      worst   pairs`);
for (const row of storedRows) {
  console.log(
    `${row.hid}  ${String(row.retry ?? "-").padEnd(15)} ${row.storedGate.padEnd(31)} ${row.projectionGate.padEnd(31)} ${String(row.worstAgainstServed).padEnd(7)} ${row.spentPairs.join(" | ")}`
  );
}
console.log(`\nSTORED:     ${census.stored.servedCount}/${census.stored.total} served (repeat-retry ${census.stored.repeatRetryServed}/${repeatRetry.length}), worst pair ${census.stored.worstPair}, dropped:repeat ${census.stored.droppedRepeat}`);
console.log(`PROJECTION: ${census.projection.servedCount}/${census.projection.total} served (repeat-retry ${census.projection.repeatRetryServed}/${repeatRetry.length}), worst pair ${census.projection.worstPair}, words ${census.projection.words.join("/")} (floor ${band.floorWords})`);
console.log(`PROMPT:     spent-pair line on ${census.prompt.cardsWithSpentPairs.length}/${storedRows.length} cards (${census.prompt.cardsWithSpentPairs.join(",")}), banned substance shapes on ${census.prompt.cardsWithBannedShapes}/${storedRows.length}, ${census.prompt.uniqueSpentPairs} unique pairs spent`);
console.log(`CALLS:      ${census.summaryCalls}`);
console.log(`\nfacts per row: ${bundle.rows.map((row, i) => `${hid(row)}=[${attestedFactKinds(evidenceFor(row)).join(",")}]`).join(" ")}`);
console.log(`menu sample: ${JSON.stringify(summaryFactMenu(evidenceFor(bundle.rows[0])))}`);
console.log(`\n${JSON.stringify(census, null, 1)}`);

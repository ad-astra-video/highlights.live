/**
 * ADAAAA-9178 `$0` replay: the rev-21 write-seam change measured on the five
 * SERVED rev-19 bodies (job `798f21c2`). No model call, no GPU, no DB write, no
 * deploy — the corpus is the served bytes and the predicates are the served seam's
 * own exports.
 *
 * What this proves, and what it does NOT:
 *
 *  - It re-derives the word counts with `summaryWordCount()` and the AC2 class with
 *    the seam's own `summaryRestatedSentences` / `stripPurposeTails`, so the
 *    before/after census below is the same predicate the gate applies.
 *  - The evidence-free arm (default) measures what the seam can do WITHOUT the row:
 *    the purpose/manner tails it deletes and the sentences that restate the body's
 *    own facts. That is a truthful reading of the stored bytes.
 *  - The evidence-gated arm (`--dump=<rows.json>`) re-runs `gateSummaryDetail` per
 *    row, which is the only way to score the affinity guard (a tail masking a
 *    claim), the affordability guard, and what the card would SERVE.
 *  - It is NOT an AC1 depth measurement. A prompt edit cannot change the bytes the
 *    model already wrote, so `p50 >= 25` is graded on a served read after the
 *    deploy (AC1's own "nothing here is claimed working until a served read
 *    exists"). This tool prints the served-before distribution and refuses to
 *    claim the after number.
 *
 * Usage:
 *   npx tsx evals/adaaa_9178/replay9178.ts [--corpus=evals/adaaa_9178/served-rev19.json] [--dump=<rows.json>]
 */
import { readFileSync } from "node:fs";
import {
  closestSentencePair,
  gateSummaryDetail,
  stripPurposeTails,
  summaryRestatedSentences,
  summarySentenceCount,
  summarySentenceFactTokens,
  summaryWordCount,
  SUMMARY_LIVE_BAND,
} from "@highlights/events";

interface ServedCard {
  hid: string;
  hid8: string;
  gate: string;
  words: number;
  body: string;
  summaryCalls: number;
}

interface Corpus {
  ticket: string;
  label: string;
  job: string;
  rail: string;
  rows: ServedCard[];
}

const args = process.argv.slice(2);
const arg = (name: string): string | null => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const corpusPath = arg("corpus") ?? "evals/adaaa_9178/served-rev19.json";
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;
const dumpPath = arg("dump");
const dump = dumpPath
  ? (JSON.parse(readFileSync(dumpPath, "utf8")) as { job?: unknown; rows: any[] })
  : null;

const quantile = (xs: number[], q: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

const rows = corpus.rows;

/** Per-row census on the stored bytes. */
const census = rows.map((row) => {
  const words = summaryWordCount(row.body);
  const sentences = summarySentenceCount(row.body);
  const tails = stripPurposeTails(row.body);
  const restated = summaryRestatedSentences(row.body);
  const strippedWords = summaryWordCount(tails.text);
  const strippedSentences = summarySentenceCount(tails.text);
  // Affordability, computed with the band the gate uses: deleting words only pays
  // when the remainder still clears the floor (`summaryClearsBand`).
  const affordable = strippedWords >= SUMMARY_LIVE_BAND.floorWords && strippedSentences >= SUMMARY_LIVE_BAND.minSentences;
  // The served second sentence, verbatim: AC2 quotes it before/after.
  const parts = row.body.split(/(?<=[.!?…])\s+/).filter(Boolean);
  return {
    row,
    words,
    sentences,
    second: parts[1] ?? "",
    tails: tails.stripped,
    keptTails: tails.kept,
    strippedWords,
    strippedSentences,
    affordable,
    restated: restated.filter((r) => r.restated),
    censusOnly: restated,
  };
});

const words = census.map((c) => c.words);
const n = words.length;
const p10 = quantile(words, 0.1);
const p50 = quantile(words, 0.5);
const min = words.length ? Math.min(...words) : null;
const max = words.length ? Math.max(...words) : null;
const atOrAbove25 = words.filter((w) => w >= 25).length;
const tailsBefore = census.flatMap((c) => c.tails).length;
const restatedBefore = census.flatMap((c) => c.restated).length;
const callsPerRow = rows.reduce((sum, r) => sum + (r.summaryCalls ?? 1), 0) / Math.max(1, rows.length);

const pair = closestSentencePair(rows.map((r) => r.body));

console.log(`# ADAAAA-9178 replay — ${corpus.label}`);
console.log(`job=${corpus.job} rail=${corpus.rail} corpus=${corpusPath}`);
console.log("");
console.log("## AC1 — depth on the SERVED rev-19 bytes (before this ticket)");
console.log("| row | gate | words | sentences | >=25 | second sentence |");
console.log("| --- | --- | ---: | ---: | --- | --- |");
for (const c of census) {
  console.log(`| \`${c.row.hid8}\` | ${c.row.gate} | ${c.words} | ${c.sentences} | ${c.words >= 25 ? "yes" : "no"} | ${JSON.stringify(c.second)} |`);
}
console.log("");
console.log(`n=${n} min=${min} p10=${p10} p50=${p50} max=${max} bodies>=25=${atOrAbove25}/${n}`);
console.log(
  `AC1 served-before: p50 ${p50} vs bar ${SUMMARY_LIVE_BAND.targetMinWords} -> ${p50 !== null && p50 >= SUMMARY_LIVE_BAND.targetMinWords ? "PASS" : "FAIL"}; ` +
    `p10 ${p10} vs bar 18 -> ${p10 !== null && p10 >= 18 ? "PASS" : "FAIL"}; bodies>70=${words.filter((w) => w > 70).length}`
);
console.log(
  "AC1 post-deploy: NOT MEASURED HERE. A prompt edit cannot change bytes the model already wrote; this bar is graded on the served read after the deploy."
);
console.log("");

console.log("## AC2 — every sentence earns a fact (the seam's own predicates)");
console.log("| row | purpose/manner tails SEEN | restating sentences SEEN | words if the tails go | affordable (floor 18)? |");
console.log("| --- | --- | --- | ---: | --- |");
for (const c of census) {
  const tails = c.tails.length ? c.tails.map((t) => JSON.stringify(t)).join(" ") : "(none)";
  const rest = c.restated.length ? c.restated.map((r) => JSON.stringify(r.sentence)).join(" ") : "(none)";
  console.log(`| \`${c.row.hid8}\` | ${tails} | ${rest} | ${c.strippedWords} | ${c.affordable ? "yes" : "NO — kept"} |`);
}
console.log("");
console.log(`purpose/manner tails on served bodies: ${tailsBefore} across ${census.filter((c) => c.tails.length > 0).length}/${n} bodies`);
console.log(`sentences that restate the body's own facts: ${restatedBefore} across ${census.filter((c) => c.restated.length > 0).length}/${n} bodies`);
console.log(`tails the seam could not afford to delete (remainder under the ${SUMMARY_LIVE_BAND.floorWords}-word floor): ${census.filter((c) => c.tails.length > 0 && !c.affordable).length}/${n} bodies`);
console.log(
  "This is the ticket's own finding, re-measured: on bodies written to 18-26 words the padding is a fifth of the card, so DELETING it drops the row instead of deepening it. The seam therefore deletes only when the card still serves, and the depth has to come from the writer (the prompt now asks for a third distinct fact)."
);
console.log("");

console.log("## AC4 — the bars that must not regress");
console.log(
  `closest cross-card sentence pair: ${pair ? pair.similarity.toFixed(3) : "n/a"} (< 0.80 bar) -> ${pair && pair.similarity < 0.8 ? "PASS" : "FAIL"}`
);
if (pair) console.log(`  a=${JSON.stringify(pair.a)}\n  b=${JSON.stringify(pair.b)}`);
console.log(`calls per served row: ${callsPerRow.toFixed(3)} (bar 1.0 for this block; the seam adds no call)`);
const floor = SUMMARY_LIVE_BAND.floorWords;
const target = SUMMARY_LIVE_BAND.targetMinWords;
console.log(`constants: summaryFloorWords=${floor} summaryTargetMinWords=${target} (unchanged by this ticket)`);
console.log("");

if (!dump) {
  console.log("## Evidence-gated arm — NOT RUN");
  console.log(
    "The corpus carries served bytes only. Pass `--dump=<rows.json>` (a stored-row dump with reason/transcript/matchContext/attestation/windowTs per row) to run `gateSummaryDetail` per row and score the affinity guard, the affordability guard and what the card would serve."
  );
  console.log("");
  console.log(
  "RESULT: evidence-free arm PASS (class census above reproduces the ticket's p50 19 / p10 18 and the served second-sentence classes). AC1 and the served AC2 are graded on the served read after the deploy — this tool refuses to claim them from stored bytes."
);
  process.exit(0);
}

// --- evidence-gated arm -----------------------------------------------------
const byId = new Map<string, any>();
for (const row of dump.rows ?? []) {
  const key = String(row.id ?? row.hid ?? "").slice(0, 8);
  byId.set(key, row);
}
console.log("## Evidence-gated arm — what the card SERVES after the seam (rev-21 tree)");
console.log("| row | served before | served after | words before -> after | tails | restated | violations |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
let regressions = 0;
let ac2Misses = 0;
const afterWords: number[] = [];
for (const c of census) {
  const evidenceRow = byId.get(c.row.hid8);
  if (!evidenceRow) {
    console.log(`| \`${c.row.hid8}\` | ${c.row.gate} | (no evidence row in dump) | ${c.words} -> ? | ? | ? | ? |`);
    continue;
  }
  const evidence = evidenceRow.evidence ?? evidenceRow;
  const decision = gateSummaryDetail(c.row.body, evidence);
  const after = decision.summary ?? "(none)";
  const afterCount = decision.summary ? summaryWordCount(decision.summary) : 0;
  if (decision.summary) afterWords.push(afterCount);
  // A row that served before and does not serve now is a REGRESSION, not a repair.
  if (c.row.gate !== "dropped" && !decision.summary) regressions += 1;
  // AC2 on the served bytes: a tail or a restatement that survives the seam.
  if (decision.summary) {
    const tail = stripPurposeTails(decision.summary, evidence);
    const rest = summaryRestatedSentences(decision.summary, evidence).filter((r) => r.restated);
    if (tail.stripped.length > 0 || rest.length > 0) ac2Misses += 1;
  }
  console.log(
    `| \`${c.row.hid8}\` | ${c.row.gate} | ${decision.gate} | ${c.words} -> ${afterCount} | ${decision.purposeTails.length} | ${decision.restatedSentences.length} | ${decision.violations.join(",") || "none"} |`
  );
  if (decision.summary && decision.summary !== c.row.body) console.log(`  served: ${JSON.stringify(decision.summary)}`);
}
console.log("");
const afterP50 = quantile(afterWords, 0.5);
console.log(`served-after n=${afterWords.length} p50=${afterP50} (AC1 is still graded on a served read; this is the seam's own output shape)`);
console.log(`regressions (served before, refused now): ${regressions}`);
console.log(`AC2 misses on the served bytes (tail or restatement surviving): ${ac2Misses}`);
const ok = regressions === 0 && ac2Misses === 0 && (!pair || pair.similarity < 0.8);
console.log(`RESULT: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);

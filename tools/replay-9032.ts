/**
 * ADAAAA-9032 $0 replay: the rev-10 live job `771f42de` read back through the
 * served lane's own contract functions. No model call, no DB write, no GPU.
 *
 * For every promoted row it prints the row's OWN evidence (the fact kinds the
 * row can attest), the fact menu the prompt offers, the stored refused draft
 * (`summaryRaw`) judged by `gateSummaryDetail`, the drop name `summaryDropReasonName`
 * computes, whether the second sample was justified, and the substituted /
 * repaired words.
 *
 * Run: npx tsx tools/replay-9032.ts /tmp/hl9032_dump.json
 */
import { readFileSync } from "node:fs";
import {
  attestedFactKinds,
  attestedSummaryFactKinds,
  gateSummaryDetail,
  summaryBand,
  summaryFactMenu,
  summaryRefusalIsRepairable,
  summarySentenceFacts,
  summaryWordCount,
  SUMMARY_MIN_FACT_KINDS,
} from "@highlights/events";
import { summaryDropReasonName, summaryEvidenceForRow } from "../services/server/src/summary-lane.js";

const dump = JSON.parse(readFileSync(process.argv[2] ?? "/tmp/hl9032_dump.json", "utf8")) as {
  job: any;
  rows: any[];
};

const job = dump.job;
const mc = job.matchContext ?? null;
const rows = dump.rows;

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const quant = (xs: number[], q: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
};

/** The SUPERSEDED ADAAAA-8806 rule: a two-kind menu was enough to earn the retry,
 *  so `summaryDropReasonName` fell through to its word-shortfall test and named a
 *  row `filler` (depth) even when the only missing kind was a team NAME on a row
 *  that measured no outcome. Column `dropOld` prints what the rev-10 build produced. */
const dropNameOldRule = (decision: any, evidence: any): "gate" | "filler" => {
  const claim = decision.violations.some((v: string) =>
    v === "too-few-facts"
      ? attestedFactKinds(evidence).length < SUMMARY_MIN_FACT_KINDS
      : !summaryRefusalIsRepairable(v as any, evidence)
  );
  if (claim) return "gate";
  const floor = summaryBand(evidence.rail).floorWords;
  const filler = decision.droppedClauses.length > 0 && (decision.repairedWords ?? 0) < floor;
  return filler ? "filler" : "gate";
};

type Line = Record<string, any>;
const lines: Line[] = [];
let served = 0;
let callsOneCall = 0;
let callsMeasured = 0;

for (const row of rows) {
  const evidence = summaryEvidenceForRow(
    { ...row, reason: row.reason_raw ?? row.reason ?? null },
    "live"
  );
  evidence.matchContext = mc;
  const kinds = attestedFactKinds(evidence);
  const menu = summaryFactMenu(evidence);
  const raw = (row.summaryRaw ?? "").trim();
  const decision = raw ? gateSummaryDetail(raw, evidence) : null;
  const dropName = decision ? summaryDropReasonName(decision, evidence) : null;
  const unrepairable = decision ? decision.violations.filter((v) => !summaryRefusalIsRepairable(v, evidence)) : [];
  const retryJustified = decision ? unrepairable.length === 0 && !decision.summary : false;
  const body = row.summary || "";
  const bodyKinds = body ? attestedSummaryFactKinds(body, evidence) : [];
  if (body) served += 1;
  callsMeasured += Number(row.summaryCalls ?? 0);
  // The measured build retried every repairable refusal (2 calls); a one-call
  // policy bills 1 for every row this job served or refused deterministically.
  callsOneCall += 1;
  lines.push({
    hid: String(row._hid ?? row.id).slice(0, 8),
    eventType: row.eventType,
    clockToken: row.matchClock?.token ?? null,
    offered: kinds.join("+") || "(none)",
    eligible: kinds.length >= SUMMARY_MIN_FACT_KINDS,
    menu: menu.length,
    gate: row.summaryGate,
    storedCalls: row.summaryCalls,
    rawWords: raw ? summaryWordCount(raw) : 0,
    violations: decision ? decision.violations.join(",") : "",
    unrepairable: unrepairable.join(","),
    retryJustified,
    dropName,
    dropNameOld: decision ? dropNameOldRule(decision, evidence) : null,
    droppedClauses: decision ? decision.droppedClauses.length : 0,
    substituted: decision ? decision.substitutedClauses.length : 0,
    repairedWords: decision ? decision.repairedWords : null,
    servedWords: body ? summaryWordCount(body) : 0,
    bodyKinds: bodyKinds.join("+"),
    band: `${summaryBand("live").floorWords}/${summaryBand("live").minSentences}-${summaryBand("live").maxSentences}`,
  });
}

console.log("== per-row ==");
for (const l of lines) {
  console.log(
    [
      l.hid,
      l.eventType,
      `clock=${l.clockToken}`,
      `gate=${l.gate}`,
      `offered=${l.offered}`,
      `eligible=${l.eligible}`,
      `menu=${l.menu}`,
      `storedCalls=${l.storedCalls}`,
      `rawWords=${l.rawWords}`,
      `viol=[${l.violations}]`,
      `unrepairable=[${l.unrepairable}]`,
      `retryJustified=${l.retryJustified}`,
      `drop=${l.dropName}`,
      `dropOld=${l.dropNameOld}`,
      `droppedClauses=${l.droppedClauses}`,
      `substituted=${l.substituted}`,
      `repairedWords=${l.repairedWords}`,
      `served=${l.servedWords}w(${l.bodyKinds})`,
    ].join(" ")
  );
}

const servedWords = lines.filter((l) => l.servedWords > 0).map((l) => l.servedWords);
const eligible = lines.filter((l) => l.eligible);
const servedEligible = eligible.filter((l) => l.servedWords > 0);
// AC12's `dry` test is the ANALYZER's usable-confidence test (scorebug >= 0.60,
// ASR chars > 0). It is not reproducible from the stored row bytes alone, so this
// tool does not print a dry number — the grade's 11/14 = 78.6 % is the AC12 read,
// and the PO ruled it supply-bound with ADAAAA-9038 as the lever.
const flips = lines.filter((l) => l.dropNameOld && l.dropName && l.dropNameOld !== l.dropName);

console.log("\n== census ==");
console.log(`promoted rows            ${lines.length}`);
console.log(`served                   ${served} (${pct(served, lines.length)})`);
console.log(`eligible (evidence)      ${eligible.length} / ${lines.length}; served ${servedEligible.length} (${pct(servedEligible.length, eligible.length)})`);
for (const name of ["gate", "filler"]) {
  const old = lines.filter((l) => l.dropNameOld === name).length;
  const now = lines.filter((l) => l.dropName === name).length;
  console.log(`drop name ${name} ${" ".repeat(12 - name.length)} rev-10 rule ${old}, this tree ${now}`);
}
console.log(`attribution flips        ${flips.length} (${flips.map((l) => `${l.hid}:${l.dropNameOld}->${l.dropName}`).join(", ") || "none"})`);
console.log(`served words             [${servedWords.join(", ")}] p50=${quant(servedWords, 0.5)} p10=${quant(servedWords, 0.1)}`);
console.log(`calls measured           ${callsMeasured} / ${lines.length} = ${(callsMeasured / lines.length).toFixed(3)} per row`);
console.log(`calls one-call policy    ${callsOneCall} / ${lines.length} = ${(callsOneCall / lines.length).toFixed(3)} per row`);
console.log(`\n== sentence reports for refused drafts (first 3) ==`);
for (const row of rows.slice(0, 3)) {
  const evidence = summaryEvidenceForRow({ ...row, reason: row.reason_raw ?? null }, "live");
  evidence.matchContext = mc;
  const raw = (row.summaryRaw ?? "").trim();
  if (!raw) continue;
  console.log(`-- ${String(row._hid).slice(0, 8)}`);
  for (const r of summarySentenceFacts(raw, evidence)) {
    console.log(`   facts=[${r.facts.join(",")}] claims=[${r.claims.join(",")}] words=${r.words} :: ${r.sentence}`);
  }
}

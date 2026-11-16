/**
 * ADAAAA-9124 probe — measure the AC14 "drop the offending sentence, then re-judge"
 * repair's headroom on STORED rows, `$0`.
 *
 * The served gate already runs the clause repair before judging (`dropFillerSentences`
 * inside `gateSummaryDetail`), so a body that still refuses `unattested-sentence`
 * carries a sentence the repair could not isolate. This probe asks a narrower
 * question: if the lane dropped EXACTLY the sentences the gate names as unattested
 * (`unattestedSentences`) and re-judged the remainder — the AC14.3 order, "drop the
 * offending clause" — how many more stored rows serve, and does the remainder stay
 * inside the depth band?
 *
 * Nothing here is a contract change: it grades bytes a served build already wrote.
 *
 * Run: npx tsx evals/adaaa_9124/probe-drop-sentences-9124.ts <corpus.json>...
 */
import { readFileSync } from "node:fs";
import {
  dropSentences,
  gateSummaryDetail,
  unattestedSentences,
  SUMMARY_MIN_FACT_KINDS,
  attestedFactKinds,
  summaryBand,
  summaryWordCount,
  summarySentenceCount,
} from "../../packages/events/src/highlight-summary.js";
import { summaryEvidenceForRow } from "../../services/server/src/summary-lane.js";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error("usage: probe-drop-sentences-9124.ts <corpus.json>...");
  process.exit(2);
}

for (const file of files) {
  const dump = JSON.parse(readFileSync(file, "utf8"));
  const contextByLeg: Record<string, unknown> = dump.matchContextByLeg ?? {};
  let baseServed = 0;
  let repairedServed = 0;
  let rows = 0;
  let eligible = 0;
  const gained: string[] = [];

  for (const row of dump.rows) {
    rows += 1;
    if (!row.body) continue;
    const evidence = summaryEvidenceForRow(
      {
        verdict: null,
        outcome: row.outcome ?? null,
        eventType: row.eventType ?? null,
        reason: row.reason ?? null,
        caption: row.caption ?? null,
        postTitle: row.postTitle ?? null,
        trigger: row.trigger ?? null,
        start: row.start,
        end: row.end,
        matchClock: row.matchClock ?? null,
        deferredAttestation: row.deferredAttestation ?? null,
        attestationUsed: row.attestationUsed ?? null,
        goalConfirmed: row.goalConfirmed ?? null,
        confirmAttestation: row.confirmAttestation ?? null,
        asrTranscript: row.asrTranscript ?? null,
        matchContext: contextByLeg[row.jobId] ?? null,
      },
      "live"
    );
    const kinds = attestedFactKinds(evidence);
    if (kinds.length >= SUMMARY_MIN_FACT_KINDS) eligible += 1;

    const base = gateSummaryDetail(row.body, evidence);
    if (base.summary !== null) {
      baseServed += 1;
      repairedServed += 1;
      continue;
    }
    const offending = unattestedSentences(row.body, evidence).map((s) => s.sentence);
    if (offending.length === 0) continue;
    const pruned = dropSentences(row.body.trim(), offending);
    const band = summaryBand("live");
    const words = summaryWordCount(pruned);
    const sentences = summarySentenceCount(pruned);
    if (words < band.minSentences || words < band.floorWords || sentences < band.minSentences) continue;
    const again = gateSummaryDetail(pruned, evidence);
    if (again.summary !== null) {
      repairedServed += 1;
      gained.push(`${String(row.id).slice(0, 8)} words=${words} dropped=${offending.length}`);
    }
  }
  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
  console.log(`# ${file} (${dump.sourceUrl})`);
  console.log(`rows=${rows} eligible=${eligible} (${pct(eligible, rows)})`);
  console.log(`served now=${baseServed} (${pct(baseServed, rows)})  after sentence drop=${repairedServed} (${pct(repairedServed, rows)})`);
  console.log(`gained by repair: ${gained.length}`);
  for (const g of gained) console.log(`  + ${g}`);
  console.log("");
}

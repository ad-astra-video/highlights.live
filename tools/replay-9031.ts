/**
 * ADAAAA-9031 $0 replay — the rev-10 VOD leg's 22 stored rows, read back through
 * the lane's own contract functions. No model call, no DB write, no GPU.
 *
 * For every promoted row it prints the row's OWN fact menu, the stored body (or
 * the refused `summaryRaw`), the gate's decision on those exact bytes, the drop
 * name the lane computes, whether the second call the served build billed would
 * still be permitted under spec §13.2 (AC8 repeat path / AC14 filler repair), and
 * the AC14.3 sentence pairs with the clock-masked comparator.
 *
 * Run: npx tsx tools/replay-9031.ts /tmp/hl9031_dump.jsonl [--json]
 */
import { readFileSync } from "node:fs";
import {
  summaryRefusalIsRepairable,
  dropSentences,
  closestSentencePair,
  gateSummaryDetail,
  sentenceSimilarity,
  summarySentencesOf,
  summaryWordCount,
  attestedFactKinds,
  SUMMARY_MIN_FACT_KINDS,
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
  maskSentenceClocks,
} from "@highlights/events";
import {
  summaryDropReasonName,
  summaryEvidenceForRow,
  summaryRepeatKey,
  type SummaryServedBody,
} from "../services/server/src/summary-lane.js";

interface DumpRow {
  jobId: string;
  matchContext: unknown;
  row: Record<string, any>;
}

const path = process.argv[2] ?? "/tmp/hl9031_dump.jsonl";
const asJson = process.argv.includes("--json");
/** ADAAAA-9031 A/B: `--no-goal-attestation` hides the row's Stage-2 dive verdict
 *  (the served build's read), `--legacy-similarity` compares sentences without the
 *  clock mask (the served build's comparator). Both are evidence switches only —
 *  the fix itself is in `highlight-summary.ts`. */
const noGoalAttestation = process.argv.includes("--no-goal-attestation");
const legacySimilarity = process.argv.includes("--legacy-similarity");

/** The SERVED comparator: the same Jaccard over token SETS, without the clock
 *  mask (what 328bb3b ran). Used only to print the before/after pair count. */
const unmaskedSimilarity = (a: string, b: string): number => {
  const tokens = (t: string) =>
    new Set((t ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9]+(?:[':][a-z0-9]+)*/g) ?? []);
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
};
const simBefore = (a: string, b: string) => (legacySimilarity ? unmaskedSimilarity(a, b) : sentenceSimilarity(a, b));
const dump: DumpRow[] = readFileSync(path, "utf8")
  .split("\n")
  .filter((l) => l.trim().startsWith("{"))
  .map((l) => JSON.parse(l));

const byJob = new Map<string, DumpRow[]>();
for (const entry of dump) {
  const list = byJob.get(entry.jobId) ?? [];
  list.push(entry);
  byJob.set(entry.jobId, list);
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const lines: Record<string, any>[] = [];
let served = 0;
let eligible = 0;
let gateOnStoredBytesServed = 0;
let projectedServed = 0;
let callsBilled = 0;
let callsPermitted = 0;
const callReasons: Record<string, number> = {};

for (const [jobId, entries] of byJob) {
  const matchContext = entries[0].matchContext ?? null;
  const servedBodies: SummaryServedBody[] = [];
  for (const { row } of entries) {
    const evidence = summaryEvidenceForRow(
      noGoalAttestation ? { ...row, matchContext, goalConfirmed: null, confirmAttestation: null } : { ...row, matchContext },
      "vod"
    );
    const kinds = attestedFactKinds(evidence);
    const isEligible = kinds.length >= SUMMARY_MIN_FACT_KINDS;
    if (isEligible) eligible += 1;
    const body = typeof row.summary === "string" ? row.summary : "";
    const raw = typeof row.summaryRaw === "string" ? row.summaryRaw : "";
    const storedGate: string = row.summaryGate ?? "";
    const billed = Number(row.summaryCalls ?? 0);
    callsBilled += billed;

    // The gate decision on the bytes that were judged (body if served, else the
    // refused reply). This is what the fix changes: the same bytes, the new gate.
    const judged = body || raw;
    const decision = judged ? gateSummaryDetail(judged, evidence) : null;
    const dropName = decision ? summaryDropReasonName(decision, evidence) : null;
    if (decision?.summary && !body) gateOnStoredBytesServed += 1;
    // AC14.3 repair projection: a refused row the gate now accepts still has to
    // pass the repeat key. Apply the contract's clause drop (regenerate is not
    // available at $0) and keep the row only if the pruned body still gates.
    let projectedSummary: string | null = null;
    if (decision?.summary && !body) {
      const repeat = summaryRepeatKey(decision.summary, evidence, servedBodies);
      if (repeat.key === "sentence" && repeat.repeatedSentences.length > 0) {
        const pruned = gateSummaryDetail(dropSentences(decision.summary, repeat.repeatedSentences), evidence);
        projectedSummary = pruned.summary ?? null;
      } else if (repeat.key === null) {
        projectedSummary = decision.summary;
      }
      if (projectedSummary) projectedServed += 1;
    }

    // §13.2: which second calls the contract permits. A 2-call row is permitted
    // only when the first refusal/detection was a repeat (AC8/AC14) or the AC14
    // filler repair (`droppedClauses` > 0).
    let permittedReason: string | null = null;
    if (billed > 1) {
      // The lane breaks on an unrepairable refusal BEFORE it considers a retry,
      // so such a row is one call under the fix.
      const unrepairable =
        decision !== null && decision.summary === null
          ? decision.violations.includes("too-few-facts") ||
            decision.violations.some((v) => !summaryRefusalIsRepairable(v, evidence))
          : false;
      const repeat = summaryRepeatKey(judged, evidence, servedBodies);
      if (unrepairable) permittedReason = null;
      else if (repeat.key === "opening") permittedReason = "repeat-opening";
      else if (repeat.key === "sentence") permittedReason = "repeat-sentence";
      else if (decision && decision.droppedClauses.length > 0) permittedReason = "filler-repair";
      if (permittedReason) callsPermitted += 1;
      callReasons[permittedReason ?? "not-permitted"] = (callReasons[permittedReason ?? "not-permitted"] ?? 0) + 1;
    }

    if (body) {
      served += 1;
      servedBodies.push({
        highlightId: row.id,
        windowTs: evidence.windowTs ?? null,
        windowDurationS: evidence.windowDurationS ?? null,
        clockToken: evidence.matchClock?.token ?? null,
        body,
        opening: null,
      });
    }
    lines.push({
      job: jobId.slice(0, 8),
      row: String(row.id ?? "").slice(0, 8),
      eventType: row.eventType,
      offered: kinds.join("+") || "(none)",
      eligible: isEligible,
      storedGate,
      billedCalls: billed,
      permittedSecondCall: permittedReason,
      newGate: decision ? (decision.summary ? decision.gate : `refused:${decision.violations.join(",")}`) : "(no bytes)",
      newDropName: dropName,
      newWords: decision?.words ?? 0,
      servedNow: Boolean(body),
      keepsBody: decision?.summary ? decision.summary : null,
      projectedAfterPrune: projectedSummary,
    });
  }
}

// AC14.3 on the served bytes, with the clock-masked comparator.
const pairs: { job: string; a: string; b: string; similarity: number }[] = [];
for (const [jobId, entries] of byJob) {
  const bodies = entries.map((e) => e.row.summary).filter((s: unknown): s is string => typeof s === "string" && s.length > 0);
  if (bodies.length < 2) continue;
  const sentences: string[] = [];
  for (const b of bodies) for (const s of summarySentencesOf(b)) sentences.push(s);
  for (let i = 0; i < sentences.length; i++) {
    for (let j = i + 1; j < sentences.length; j++) {
      const similarity = simBefore(sentences[i], sentences[j]);
      if (similarity >= SUMMARY_SENTENCE_REPEAT_THRESHOLD) {
        pairs.push({ job: jobId.slice(0, 8), a: sentences[i], b: sentences[j], similarity });
      }
    }
  }
}

const summary = {
  rows: dump.length,
  eligible,
  servedOnStoredBuild: served,
  coverageOnStoredBuild: pct(served, eligible),
  /** Rows whose REFUSED `summaryRaw` the fix now serves (the gate over-refusal). */
  gateOnStoredBytesRecovered: gateOnStoredBytesServed,
  servedProjectedByGate: served + gateOnStoredBytesServed,
  coverageProjectedByGate: pct(served + gateOnStoredBytesServed, eligible),
  /** The honest projection: gate-recovered rows that ALSO survive the AC14.3
   *  repeat-prune (no second sample available at $0). */
  projectedServedAfterRepeatPrune: served + projectedServed,
  coverageAfterRepeatPrune: pct(served + projectedServed, eligible),
  callsBilled,
  callsPerRow: (callsBilled / dump.length).toFixed(2),
  secondCallsPermitted: callsPermitted,
  secondCallsByReason: callReasons,
  ac14_pairs_atOrAbove_080: pairs.length,
  closestPair: closestSentencePair(
    [...byJob.values()].flatMap((es) => es.map((e) => e.row.summary).filter((s) => typeof s === "string" && s.length > 0))
  ),
};

if (asJson) {
  console.log(JSON.stringify({ summary, rows: lines, pairs }, null, 2));
} else {
  for (const line of lines) console.log(JSON.stringify(line));
  for (const p of pairs) console.log(`PAIR ${p.job} ${p.similarity.toFixed(3)} | ${p.a} <> ${p.b}`);
  console.log(JSON.stringify(summary, null, 2));
}

void maskSentenceClocks;
void summaryWordCount;

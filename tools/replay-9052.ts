/**
 * ADAAAA-9052 $0 replay — the rev-11 VOD census (22 stored rows / 6 jobs) read
 * back through the FIXED lane's own contract functions. No model call, no DB
 * write, no GPU.
 *
 * This is a LANE replay, not a stored-row census: every row's stored bytes are
 * the writer's draft (a served body, or the refused reply kept as `summaryRaw`),
 * and the rows are replayed IN CENSUS ORDER through the decision the fixed build
 * makes — gate, then the AC8/AC14 repeat key against the bodies THIS replay has
 * already served, then AC14's clause drop, then ADAAAA-9052's repair when the drop
 * took the body under its band floor.
 *
 * Read it as a projection, not a served leg: the bodies are stored drafts from
 * the rev-11 build, and the "regenerate once" half of AC14's order has no second
 * sample at $0. A row whose draft repeats is repaired deterministically or
 * dropped; the model's would-be regeneration is not measured here.
 *
 * Run: npx tsx tools/replay-9052.ts /tmp/hl9031_dump.jsonl [--json]
 */
import { readFileSync } from "node:fs";
import {
  summaryRefusalIsRepairable,
  closestSentencePair,
  gateSummaryDetail,
  pruneRepeatedSentences,
  summarySentencesOf,
  summaryWordCount,
  attestedFactKinds,
  attestedSummaryFactKinds,
  bodyNamesAttestedActor,
  SUMMARY_MIN_FACT_KINDS,
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
  type SummaryDropReason,
} from "@highlights/events";
import {
  summaryDropReasonName,
  summaryEvidenceForRow,
  summaryRepeatKey,
  type SummaryRetryReason,
  type SummaryServedBody,
} from "../services/server/src/summary-lane.js";

interface DumpRow {
  jobId: string;
  matchContext: unknown;
  row: Record<string, any>;
}

const path = process.argv[2] ?? "/tmp/hl9031_dump.jsonl";
const asJson = process.argv.includes("--json");
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
const id8 = (value: unknown) => String(value ?? "").slice(0, 8);

interface RowLine {
  job: string;
  row: string;
  eventType: string;
  offered: string;
  eligible: boolean;
  storedGate: string;
  storedCalls: number;
  storedRetryReason: string | null;
  draft: "served" | "refused" | "none";
  outcome: "served" | "dropped";
  reason: string | null;
  words: number;
  sentences: number;
  repeatKey: string | null;
  droppedRepeated: number;
  repairedSentences: number;
  servedBody: string | null;
  /** The call count the fixed lane would bill for THIS row's class (see notes). */
  fixedCalls: number;
  fixedRetryReason: SummaryRetryReason | null;
  /** AC9 read: the DISTINCT attested fact kinds the served body relays. */
  factKinds: string[];
  /** AC11-VOD read: the body names a team/player the row attests. */
  namesAttestedActor: boolean;
}

const rows: RowLine[] = [];
let eligible = 0;
const servedBodies: SummaryServedBody[] = [];
const perJobServed = new Map<string, string[]>();

for (const [jobId, entries] of byJob) {
  const matchContext = entries[0].matchContext ?? null;
  const jobServed: SummaryServedBody[] = [];
  const jobSentences: string[] = [];
  for (const entry of entries) {
    const row = entry.row;
    const evidence = summaryEvidenceForRow({ ...row, matchContext }, "vod");
    const kinds = attestedFactKinds(evidence);
    const isEligible = kinds.length >= SUMMARY_MIN_FACT_KINDS;
    if (isEligible) eligible += 1;
    const storedBody = typeof row.summary === "string" ? row.summary : "";
    const storedRaw = typeof row.summaryRaw === "string" ? row.summaryRaw : "";
    const draft = storedBody || storedRaw;
    const arrivedServed = Boolean(storedBody);
    const line: RowLine = {
      job: id8(jobId),
      row: id8(row.id),
      eventType: row.eventType,
      offered: kinds.join("+") || "(none)",
      eligible: isEligible,
      storedGate: row.summaryGate ?? "",
      storedCalls: Number(row.summaryCalls ?? 0),
      storedRetryReason: row.summaryRetryReason ?? null,
      draft: arrivedServed ? "served" : storedRaw ? "refused" : "none",
      outcome: "dropped",
      reason: null,
      words: 0,
      sentences: 0,
      repeatKey: null,
      droppedRepeated: 0,
      repairedSentences: 0,
      servedBody: null,
      fixedCalls: 0,
      fixedRetryReason: null,
      factKinds: [],
      namesAttestedActor: false,
    };
    if (!draft) {
      line.reason = row.summaryGate?.replace(/^dropped:/, "") ?? "no-bytes";
      line.fixedCalls = 0;
      rows.push(line);
      continue;
    }
    const decision = gateSummaryDetail(draft, evidence);
    line.fixedCalls = 1;
    if (!decision.summary) {
      line.reason = summaryDropReasonName(decision, evidence);
      // The fixed lane's own §13.2 rule: a deterministic refusal ends the row on ONE
      // call; only the AC14 filler repair regenerates.
      line.fixedCalls =
        decision.droppedClauses.length > 0 && !decision.violations.includes("too-few-facts") ? 2 : 1;
      line.fixedRetryReason = line.fixedCalls === 2 ? "filler-repair" : null;
      rows.push(line);
      continue;
    }
    const repeat = summaryRepeatKey(decision.summary, evidence, jobServed);
    line.repeatKey = repeat.key;
    let served: string | null = decision.summary;
    if (repeat.key === "sentence" && repeat.repeatedSentences.length > 0) {
      // AC14's order: regenerate once (no second sample at $0), then drop the
      // offending clause; ADAAAA-9052 repairs a body the drop took under the band.
      line.fixedCalls = 2;
      line.fixedRetryReason = "repeat-sentence";
      const prune = pruneRepeatedSentences(decision.summary, repeat.repeatedSentences, evidence, jobSentences);
      const prunedDecision = gateSummaryDetail(prune.text, evidence);
      line.droppedRepeated = prune.dropped.length;
      line.repairedSentences = prune.substituted.length;
      served = prunedDecision.summary ? prunedDecision.summary : null;
      if (!served) line.reason = "repeat";
    } else if (repeat.key === "opening") {
      // AC8 has no clause repair: the opening is the card's first sentence, so the
      // only $0 outcome is the drop the served build already applied / the regen.
      line.fixedCalls = 2;
      line.fixedRetryReason = "repeat-opening";
      served = null;
      line.reason = "repeat";
    }
    if (served) {
      line.outcome = "served";
      line.servedBody = served;
      line.words = summaryWordCount(served);
      line.sentences = summarySentencesOf(served).length;
      line.factKinds = attestedSummaryFactKinds(served, evidence);
      line.namesAttestedActor = bodyNamesAttestedActor(served, evidence);
      const opening = summarySentencesOf(served)[0] ?? null;
      for (const sentence of summarySentencesOf(served)) jobSentences.push(sentence);
      jobServed.push({
        highlightId: row.id,
        windowTs: evidence.windowTs ?? null,
        windowDurationS: evidence.windowDurationS ?? null,
        clockToken: evidence.matchClock?.token ?? null,
        body: served,
        opening,
      });
      const list = perJobServed.get(id8(jobId)) ?? [];
      list.push(served);
      perJobServed.set(id8(jobId), list);
    }
    rows.push(line);
  }
  servedBodies.push(...jobServed);
}

const served = rows.filter((r) => r.outcome === "served");
const words = served.map((r) => r.words).sort((a, b) => a - b);
const median = (values: number[]) =>
  values.length === 0 ? 0 : values.length % 2 === 1 ? values[values.length - 1 >> 1] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;

/** AC14.3 on the bodies THIS replay serves, clock-masked, job-scoped. */
const pairs: { job: string; a: string; b: string; similarity: number }[] = [];
for (const [job, bodies] of perJobServed) {
  const sentences: string[] = [];
  for (const body of bodies) for (const sentence of summarySentencesOf(body)) sentences.push(sentence);
  for (let i = 0; i < sentences.length; i++) {
    for (let j = i + 1; j < sentences.length; j++) {
      const pair = closestSentencePair([sentences[i], sentences[j]]);
      if (pair && pair.similarity >= SUMMARY_SENTENCE_REPEAT_THRESHOLD) {
        pairs.push({ job, a: sentences[i], b: sentences[j], similarity: pair.similarity });
      }
    }
  }
}

/** AC5: the second calls the census billed, split by the reason §13.2 permits. */
const storedCalls = rows.reduce((sum, r) => sum + r.storedCalls, 0);
const secondCallRows = rows.filter((r) => r.storedCalls > 1);
const permittedSecond = secondCallRows.filter((r) => r.fixedRetryReason !== null);
const unpermittedSecond = secondCallRows.filter((r) => r.fixedRetryReason === null);
/** The call count the fixed lane models for this class: one per row, plus the
 *  AC8/AC14 regeneration and the AC14 filler repair (never a depth re-sample). */
const projectedCalls = rows.reduce((sum, r) => sum + r.fixedCalls, 0);
const floorWords = 40;
const underFloor = served.filter((r) => r.words < floorWords);

const summary = {
  rows: rows.length,
  jobs: byJob.size,
  eligible,
  servedAfterFix: served.length,
  coverageAfterFix: pct(served.length, eligible),
  servedBefore: rows.filter((r) => r.draft === "served").length,
  coverageBefore: pct(rows.filter((r) => r.draft === "served").length, eligible),
  repairedRows: rows.filter((r) => r.repairedSentences > 0).length,
  droppedRows: rows.filter((r) => r.outcome === "dropped").length,
  droppedByReason: rows
    .filter((r) => r.outcome === "dropped")
    .reduce<Record<string, number>>((acc, r) => {
      const key = r.reason ?? "unknown";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  wordsP50: median(words),
  wordsMin: words[0] ?? 0,
  wordsMax: words[words.length - 1] ?? 0,
  underFloorRows: underFloor.map((r) => r.row),
  ac14PairsAtOrAbove080: pairs.length,
  callsStored: storedCalls,
  callsPerRowStored: (storedCalls / rows.length).toFixed(2),
  callsProjected: projectedCalls,
  callsPerRowProjected: (projectedCalls / rows.length).toFixed(2),
  secondCallsStored: secondCallRows.length,
  secondCallsPermitted: permittedSecond.length,
  secondCallsUnpermitted: unpermittedSecond.map((r) => r.row),
  secondCallsWithoutReason: secondCallRows.filter((r) => r.storedRetryReason === null).length,
  secondCallsWithProjectedReason: permittedSecond.length,
  /** AC9: served bodies relaying >= 2 attested fact kinds (the serve predicate). */
  servedWithTwoPlusKinds: served.filter((r) => r.factKinds.length >= SUMMARY_MIN_FACT_KINDS).length,
  /** AC12: served bodies relaying ONE kind (dry) — the rev-11 read was 0 of 12. */
  dryServed: served.filter((r) => r.factKinds.length < SUMMARY_MIN_FACT_KINDS).length,
  /** AC11-VOD: served bodies naming an attested entity. */
  servedNamingAttestedActor: served.filter((r) => r.namesAttestedActor).length,
  /** AC2 R3: every census row carries its headline (unchanged by this ticket). */
  rowsWithPostTitle: dump.filter((entry) => Boolean(entry.row.postTitle)).length,
  ac14PairsByJob: pairs.reduce<Record<string, number>>((acc, pair) => {
    acc[pair.job] = (acc[pair.job] ?? 0) + 1;
    return acc;
  }, {}),
  /** The CLOSEST within-job pair in the served set, printed even when it passes:
   *  AC14.3 counts a pass as evidence, not as the absence of a number. */
  closestPairWithinJob: pairs.length > 0
    ? pairs.reduce((a, b) => (b.similarity > a.similarity ? b : a))
    : perJobClosestPass(),
};

/** The closest within-job sentence pair when NO pair reaches the bar: the number
 *  AC3 is graded on, reported even on a clean census. */
function perJobClosestPass(): { job: string; a: string; b: string; similarity: number } | null {
  let best: { job: string; a: string; b: string; similarity: number } | null = null;
  for (const [job, bodies] of perJobServed) {
    const sentences: string[] = [];
    for (const body of bodies) for (const sentence of summarySentencesOf(body)) sentences.push(sentence);
    for (let i = 0; i < sentences.length; i++) {
      for (let j = i + 1; j < sentences.length; j++) {
        const pair = closestSentencePair([sentences[i], sentences[j]]);
        if (pair && (!best || pair.similarity > best.similarity)) {
          best = { job, a: sentences[i], b: sentences[j], similarity: pair.similarity };
        }
      }
    }
  }
  return best;
}

if (asJson) {
  console.log(JSON.stringify({ summary, rows, pairs }, null, 2));
} else {
  for (const line of rows) {
    console.log(
      [
        line.job,
        line.row,
        line.eventType,
        line.eligible ? "elig" : "no  ",
        `${line.outcome}${line.reason ? `:${line.reason}` : ""}`.padEnd(16),
        `w=${String(line.words).padStart(3)}`,
        `calls=${line.storedCalls}`,
        `key=${line.repeatKey ?? "none"}`,
        `dropped=${line.droppedRepeated}`,
        `repaired=${line.repairedSentences}`,
      ].join(" ")
    );
  }
  for (const pair of pairs) console.log(`PAIR ${pair.job} ${pair.similarity.toFixed(3)} | ${pair.a} <> ${pair.b}`);
  console.log(JSON.stringify(summary, null, 2));
}

void summaryRefusalIsRepairable;
void (null as unknown as SummaryDropReason);

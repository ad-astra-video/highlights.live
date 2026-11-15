/**
 * ADAAAA-9085 $0 replay — the rev-13 served VOD job `54537ffa` read back through
 * the served lane's own contract functions, before and after the ADAAAA-9085
 * repair. No model call, no DB write, no GPU, no leg.
 *
 * Instrument, not a served leg. The corpus is the job's OWN stored bytes, pulled
 * read-only from the box DB (`highlights` rows for job `54537ffa…`):
 *  - the 8 rows the served build actually served seed the job-scoped
 *    `servedBodies` from their stored `summary` (taken as given — the served build
 *    accepted them; re-gating another build's accepted copy is not what V-1a
 *    measures);
 *  - the 4 rows the served build dropped as `dropped:repeat` are replayed from
 *    their stored `summaryRaw` (the refused draft) with the row's own stored
 *    evidence, so the repeat key, the clause repair and the re-gate all run on the
 *    real bytes.
 *
 * It prints, per row: the repeat key the contract computes, the closest sentence,
 * what the SERVED build (5421ed9f) did, and what the ADAAAA-9085 repairs do
 * (a joint-aware gate repair, a clause drop on every repeat key, and the repair's
 * own refusal persisted on the row).
 *
 * Run: npx tsx tools/replay-9085.ts <corpus.json>
 */
import { readFileSync } from "node:fs";
import {
  gateSummaryDetail,
  pruneRepeatedSentences,
  summaryBand,
  summaryFactCandidates,
  summaryOpeningRun,
  sentenceSimilarity,
  summarySentencesOf,
  summaryWordCount,
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
} from "@highlights/events";
import {
  summaryDropReasonName,
  summaryEvidenceForRow,
  summaryRepeatKey,
  type SummaryServedBody,
} from "../services/server/src/summary-lane.js";

interface Corpus {
  jobId: string;
  matchContext: unknown;
  served: { hid: string; gate: string; retry: string | null; body: string; ts: number }[];
  repeatRows: {
    hid: string;
    gate: string;
    retry: string | null;
    repairedWords: string;
    violations: string[];
    rawBody: string;
    ev: Record<string, any>;
  }[];
}

const corpus = JSON.parse(readFileSync(process.argv[2] ?? "corpus.json", "utf8")) as Corpus;
const num = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** The row-shape `summaryEvidenceForRow` reads, off the stored record. */
function evidenceOf(ev: Record<string, any>) {
  const trigger = ev.trigger && typeof ev.trigger === "object" ? ev.trigger : null;
  return summaryEvidenceForRow(
    {
      verdict: ev.verdict ?? null,
      eventType: ev.eventType ?? null,
      outcome: ev.outcome ?? null,
      reason: ev.reason ?? null,
      caption: ev.caption ?? null,
      postTitle: ev.postTitle ?? null,
      trigger: trigger ? { timestamp: num(trigger.timestamp), durationS: num(trigger.durationS) } : null,
      start: num(ev.start),
      end: num(ev.end),
      matchClock: ev.matchClock ?? null,
      deferredAttestation: ev.deferredAttestation ?? null,
      attestationUsed: ev.attestationUsed ?? null,
      goalConfirmed: ev.goalConfirmed ?? null,
      confirmAttestation: ev.confirmAttestation ?? null,
      asrTranscript: ev.asrTranscript ?? null,
      matchContext: corpus.matchContext ?? null,
    },
    "vod"
  );
}

// The job-scoped served set, in the order the lane would have served it.
const servedBodies: SummaryServedBody[] = corpus.served
  .slice()
  .sort((a, b) => a.ts - b.ts)
  .map((row) => ({
    highlightId: row.hid,
    windowTs: row.ts,
    windowDurationS: null,
    clockToken: null,
    body: row.body,
    opening: summaryOpeningRun(row.body),
  }));

/** A repeat row only ever sees the bodies served BEFORE it. */
const before = (ts: number): SummaryServedBody[] => servedBodies.filter((row) => (row.windowTs ?? 0) < ts);
const sentencesBefore = (ts: number): string[] => before(ts).flatMap((row) => summarySentencesOf(row.body));

interface Outcome {
  served: boolean;
  body: string | null;
  words: number;
  violations: string[];
  refusal: string | null;
  repairRefused: string | null;
  repairDropped: number;
  repairSubstituted: number;
}

const out: Record<string, unknown>[] = [];
for (const row of corpus.repeatRows.slice().sort((a, b) => num(a.ev?.start)! - num(b.ev?.start)!)) {
  const evidence = evidenceOf(row.ev);
  const draft = row.rawBody;
  const ts = evidence.windowTs ?? 0;
  const priorBodies = before(ts);
  const priorSentences = sentencesBefore(ts);
  const band = summaryBand("vod");

  // --- the SERVED build (5421ed9f) ------------------------------------------
  const servedGate = gateSummaryDetail(draft, evidence);
  const servedJudged = servedGate.summary ?? draft;
  const servedRepeat = summaryRepeatKey(servedJudged, evidence, priorBodies);
  const servedOutcome: Outcome = {
    served: false,
    body: null,
    words: summaryWordCount(servedJudged),
    violations: servedGate.violations,
    refusal: null,
    repairRefused: null,
    repairDropped: 0,
    repairSubstituted: 0,
  };
  if (servedGate.summary) {
    if (servedRepeat.key === "sentence" && servedRepeat.repeatedSentences.length > 0) {
      const prune = pruneRepeatedSentences(servedJudged, servedRepeat.repeatedSentences, evidence, priorSentences);
      const pruned = gateSummaryDetail(prune.text, evidence);
      if (pruned.summary) {
        servedOutcome.served = true;
        servedOutcome.body = pruned.summary;
        servedOutcome.words = summaryWordCount(pruned.summary);
      } else {
        // The served lane discarded the prune's own re-gate: the row keeps the
        // PRE-prune decision (`summaryViolations: []`, pre-prune word count).
        servedOutcome.refusal = summaryDropReasonName(pruned, evidence);
        servedOutcome.words = servedGate.words;
      }
      servedOutcome.repairDropped = prune.dropped.length;
      servedOutcome.repairSubstituted = prune.substituted.length;
    } else if (servedRepeat.key === "opening") {
      // `key === "sentence"` gates the repair, so an opening repeat drops here.
      servedOutcome.refusal = "repeat";
    } else {
      servedOutcome.served = true;
      servedOutcome.body = servedGate.summary;
    }
  } else {
    servedOutcome.refusal = summaryDropReasonName(servedGate, evidence);
  }

  // --- the ADAAAA-9085 lane -------------------------------------------------
  const options = { avoidSentences: priorSentences };
  const gate = gateSummaryDetail(draft, evidence, options);
  const judged = gate.summary ?? draft;
  const repeat = summaryRepeatKey(judged, evidence, priorBodies);
  const fixed: Outcome = {
    served: false,
    body: null,
    words: summaryWordCount(judged),
    violations: gate.violations,
    refusal: null,
    repairRefused: null,
    repairDropped: 0,
    repairSubstituted: 0,
  };
  if (!gate.summary) {
    fixed.refusal = summaryDropReasonName(gate, evidence);
  } else if (repeat.repeatedSentences.length > 0) {
    // The clause drop is reachable on EVERY repeat key.
    const prune = pruneRepeatedSentences(judged, repeat.repeatedSentences, evidence, priorSentences);
    const pruned = gateSummaryDetail(prune.text, evidence, options);
    fixed.repairDropped = prune.dropped.length;
    fixed.repairSubstituted = prune.substituted.length;
    if (pruned.summary) {
      fixed.served = true;
      fixed.body = pruned.summary;
      fixed.words = summaryWordCount(pruned.summary);
    } else {
      const depthOnly = pruned.violations.length > 0 && pruned.violations.every((v) => v === "too-few-words" || v === "too-few-sentences");
      const repairName = depthOnly ? "filler" : summaryDropReasonName(pruned, evidence);
      fixed.refusal = repairName;
      fixed.repairRefused = `prune:${repairName}`;
      fixed.violations = pruned.violations;
      fixed.words = pruned.words;
    }
  } else {
    fixed.served = true;
    fixed.body = judged;
  }

  const pairwise = (body: string | null): { max: number; pair: [string, string] | null } => {
    if (!body) return { max: 0, pair: null };
    let best: { max: number; pair: [string, string] | null } = { max: 0, pair: null };
    for (const sentence of summarySentencesOf(body)) {
      for (const other of priorSentences) {
        const similarity = sentenceSimilarity(sentence, other);
        if (similarity > best.max) best = { max: Number(similarity.toFixed(3)), pair: [sentence, other] };
      }
    }
    return best;
  };
  const ac14 = pairwise(fixed.body);

  out.push({
    hid: row.hid,
    storedGate: row.gate,
    storedRetry: row.retry,
    draftWords: summaryWordCount(draft),
    draftSentences: summarySentencesOf(draft).length,
    band: `${band.minSentences}-${band.maxSentences}s ${band.floorWords}-${band.targetMaxWords}w`,
    servedBefore: priorBodies.length,
    servedBuild: {
      gateAccepted: Boolean(servedGate.summary),
      key: servedRepeat.key,
      closestSentence: servedRepeat.sentence ? Number(servedRepeat.sentence.similarity.toFixed(3)) : null,
      repeatedSentences: servedRepeat.repeatedSentences,
      outcome: servedOutcome.served ? "served" : "dropped",
      refusal: servedOutcome.refusal,
      persistedViolations: servedGate.violations,
      persistedWords: servedOutcome.words,
    },
    fixedBuild: {
      gateAccepted: Boolean(gate.summary),
      key: repeat.key,
      closestSentence: repeat.sentence ? Number(repeat.sentence.similarity.toFixed(3)) : null,
      repeatedSentences: repeat.repeatedSentences,
      outcome: fixed.served ? "served" : "dropped",
      refusal: fixed.refusal,
      repairRefused: fixed.repairRefused,
      droppedSentences: fixed.repairDropped,
      substitutedSentences: fixed.repairSubstituted,
      persistedViolations: fixed.violations,
      persistedWords: fixed.words,
      body: fixed.body,
      ac14MaxAgainstServed: ac14.max,
      ac14Pair: ac14.pair,
      ac14Clear: ac14.max < SUMMARY_SENTENCE_REPEAT_THRESHOLD,
      candidates: summaryFactCandidates(evidence).map((candidate) => ({
        sentence: candidate.sentence,
        kinds: candidate.kinds,
        blockedByServedAt: priorSentences.some((s) => sentenceSimilarity(s, candidate.sentence) >= SUMMARY_SENTENCE_REPEAT_THRESHOLD)
          ? Number(Math.max(...priorSentences.map((s) => sentenceSimilarity(s, candidate.sentence))).toFixed(3))
          : null,
      })),
    },
  });
}

const rows = out as any[];
const tally = (pick: (row: any) => string) =>
  rows.reduce<Record<string, number>>((acc, row) => {
    const key = pick(row);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

console.log(
  JSON.stringify(
    {
      job: corpus.jobId,
      rows: rows.length,
      servedBuild: {
        served: rows.filter((row) => row.servedBuild.outcome === "served").length,
        refusals: tally((row) => row.servedBuild.refusal ?? "served"),
        atDroppedRepeat: rows.filter((row) => row.servedBuild.outcome === "dropped" && row.servedBuild.refusal === "repeat").length,
      },
      fixedBuild: {
        served: rows.filter((row) => row.fixedBuild.outcome === "served").length,
        refusals: tally((row) => row.fixedBuild.refusal ?? "served"),
        atDroppedRepeat: rows.filter((row) => row.fixedBuild.outcome === "dropped" && row.fixedBuild.refusal === "repeat").length,
        withRepairRefusedToken: rows.filter((row) => row.fixedBuild.repairRefused).length,
        ac14Violations: rows.filter((row) => row.fixedBuild.body && !row.fixedBuild.ac14Clear).length,
      },
      perRow: rows.map((row) => ({
        hid: row.hid,
        stored: `${row.storedGate}/${row.storedRetry ?? "-"}`,
        servedBuild: `${row.servedBuild.outcome}:${row.servedBuild.refusal ?? "served"}`,
        fixedBuild: `${row.fixedBuild.outcome}:${row.fixedBuild.refusal ?? "served"}${row.fixedBuild.repairRefused ? `(${row.fixedBuild.repairRefused})` : ""}`,
        fixedWords: row.fixedBuild.persistedWords,
        violations: row.fixedBuild.persistedViolations,
        ac14Max: row.fixedBuild.ac14MaxAgainstServed,
      })),
    },
    null,
    1
  )
);
console.log(JSON.stringify(out));

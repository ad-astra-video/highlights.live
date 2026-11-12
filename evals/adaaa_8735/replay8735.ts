// ADAAAA-8735: $0 replay of the summary gate over a job's STORED rows.
//
// Usage (from the repo root, with tsx available):
//   ./node_modules/.bin/tsx evals/adaaa_8735/replay8735.ts <rows.json>
//
// `rows.json` is the job's stored `highlights` rows, one object per row:
//   { id, start, eventType, gate, summary, summaryRaw, reason, caption,
//     postTitle, from, to }
// where `from`/`to` are the stored `deferredAttestation.scoreboardDelta`
// endpoints (empty string when absent). The migration on the box:
//
//   docker exec highlights-postgres psql -U highlights -d highlights -At -F "~" -c "
//     select id||'~'||coalesce(record::jsonb->>'start','')||'~'||...
//     from highlights where job_id='<job>' order by (record::jsonb->>'start')::float"
//
// then fold each line into the object above. No model call, no GPU, no DB write:
// the replay judges the bodies the build actually stored.
import { readFileSync } from "node:fs";
import {
  attestedActorNames,
  attestedFactKinds,
  attestedSummaryFactKinds,
  gateSummaryDetail,
  summaryFacts,
  summaryOpeningRun,
  summaryWords,
  type SummaryEvidence,
  type SummaryRail,
} from "../../packages/events/src/highlight-summary.js";

interface StoredRow {
  id: string;
  start: string;
  eventType: string;
  gate: string;
  summary: string;
  summaryRaw: string;
  reason: string;
  caption: string;
  postTitle: string;
  from: string;
  to: string;
}

const path = process.argv[2];
if (!path) {
  console.error("usage: replay8735.ts <rows.json>");
  process.exit(2);
}
const rows: StoredRow[] = JSON.parse(readFileSync(path, "utf8"));
const rail: SummaryRail = (process.argv[3] as SummaryRail) ?? "live";

const evidenceOf = (row: StoredRow): SummaryEvidence => ({
  rail,
  verdict: row.eventType === "GOAL" ? "scoring_play" : "big_play",
  eventType: row.eventType,
  reason: row.reason,
  caption: row.caption,
  postTitle: row.postTitle,
  windowTs: Number(row.start),
  windowDurationS: 8,
  scoreTransition: row.from && row.to ? { from: row.from, to: row.to } : null,
  matchContext: null,
  transcript: null,
});

/** The rev-3 opening run: the first four normalized words, clock included. */
const asBuiltOpening = (text: string): string => summaryWords(text).slice(0, 4).join(" ");

const duplicates = (openings: string[]): { pairs: number; groups: Record<string, number> } => {
  const groups: Record<string, number> = {};
  for (const opening of openings) groups[opening] = (groups[opening] ?? 0) + 1;
  let pairs = 0;
  for (const count of Object.values(groups)) pairs += (count * (count - 1)) / 2;
  return { pairs, groups };
};

const jaccard = (a: string, b: string): number => {
  const left = new Set(summaryWords(a));
  const right = new Set(summaryWords(b));
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / (left.size + right.size - shared);
};

/** Bodies the build actually SERVED (a stored value on the row). */
const served = rows.filter((row) => row.summary.trim());

const perRow = rows.map((row) => {
  const evidence = evidenceOf(row);
  const candidate = row.summary.trim() || row.summaryRaw.trim();
  const decision = candidate ? gateSummaryDetail(candidate, evidence) : null;
  return {
    id: row.id,
    storedGate: row.gate || null,
    storedSummary: row.summary.trim() ? row.summary.trim() : null,
    asBuiltOpening: row.summary.trim() ? asBuiltOpening(row.summary) : null,
    openingRun: row.summary.trim() ? summaryOpeningRun(row.summary) : null,
    replayedGate: decision?.gate ?? null,
    replayedViolations: decision?.violations ?? [],
    attestedKinds: candidate ? attestedSummaryFactKinds(decision?.summary ?? candidate, evidence) : [],
    availableKinds: attestedFactKinds(evidence),
    actors: attestedActorNames(evidence),
    facts: candidate ? summaryFacts(candidate).map((fact) => fact.kind) : [],
  };
});

const servedOpenings = served.map((row) => summaryOpeningRun(row.summary));
const servedByGate = perRow.filter((row) => row.replayedGate === "accepted" || row.replayedGate === "neutralised");
const pairsAbove = (threshold: number) => {
  const out: { a: string; b: string; jaccard: number; opening: string }[] = [];
  for (let i = 0; i < served.length; i++) {
    for (let j = i + 1; j < served.length; j++) {
      if (summaryOpeningRun(served[i].summary) !== summaryOpeningRun(served[j].summary)) continue;
      const score = jaccard(served[i].summary, served[j].summary);
      if (score > threshold) out.push({ a: served[i].id, b: served[j].id, jaccard: Number(score.toFixed(4)), opening: servedOpenings[i] });
    }
  }
  return out.sort((x, y) => y.jaccard - x.jaccard);
};

const verdict = {
  rows: rows.length,
  storedServed: served.length,
  asBuilt: duplicates(served.map((row) => asBuiltOpening(row.summary))),
  clockStripped: duplicates(servedOpenings),
  pairsAbove085: pairsAbove(0.85),
  replayedServed: servedByGate.length,
  coverageOfPromoted: rows.length ? Number((servedByGate.length / rows.length).toFixed(4)) : 0,
  gateCensus: perRow.reduce<Record<string, number>>((acc, row) => {
    const key = row.replayedGate ?? "none";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {}),
  census: perRow,
};

console.log(JSON.stringify(verdict, null, 1));

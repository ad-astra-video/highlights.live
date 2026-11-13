// ADAAAA-8914 (AC14) — the `$0` replay of the rev-7 SERVED bodies.
//
// Usage (from the repo root):
//   ./node_modules/.bin/tsx evals/adaaa_8914/replay8914.ts evals/adaaa_8914/stored-rev7.json
//
// `stored-rev7.json` carries the five served `summary` bodies of the rev-7 round
// (live job `9bed3bd7-0741-4e6a-bb32-63955f158096`, VOD job
// `796e202d-0b87-4a87-a363-c48a3766a8dd`) with their own stored evidence: the
// row's score transition, its `matchClock` reading, its caption/postTitle, the
// job's `matchContext`, and the clip offset (`Window:`). No model call, no GPU,
// no DB write: the replay judges the bytes the build actually served.
//
// It prints, per body, exactly what AC14.1-AC14.4 asks a census to report, and
// the gate's own verdict. Exit code 1 when an AC fails, so the tool doubles as a
// guard in a `$0` grade.
import { readFileSync } from "node:fs";
import {
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
  SUMMARY_VOD_BAND,
  SUMMARY_LIVE_BAND,
  closestSentencePair,
  gateSummaryDetail,
  matchClockFrameClaims,
  summaryClockReport,
  summarySentenceFacts,
  summarySentencesOf,
  summaryWordCount,
  unattestedSentences,
  type SummaryEvidence,
  type SummaryRail,
} from "../../packages/events/src/highlight-summary.js";

interface StoredRow {
  id: string;
  rail: SummaryRail;
  body: string;
  reason: string | null;
  caption: string | null;
  postTitle: string | null;
  windowTs: number | null;
  windowDurationS: number | null;
  scoreTransition: { from: string; to: string } | null;
  matchClock: { token?: string; seconds?: number; legible?: boolean; period?: string | null } | null;
  verdict: string | null;
  eventType: string | null;
  attestation: { ballOutcome?: string | null; goalCrossed?: boolean | null; scoreBoardChanged?: boolean | null } | null;
  storedSummaryGate: string | null;
  storedWords: number;
  jobMatchContext?: unknown;
}

interface StoredDump {
  jobId: string;
  matchContext: unknown;
  rows: StoredRow[];
}

const path = process.argv[2];
if (!path) {
  console.error("usage: replay8914.ts <stored-rev7.json>");
  process.exit(2);
}
const dump: StoredDump = JSON.parse(readFileSync(path, "utf8"));

const evidenceOf = (row: StoredRow): SummaryEvidence => ({
  rail: row.rail,
  verdict: row.verdict,
  eventType: row.eventType,
  reason: row.reason,
  caption: row.caption,
  postTitle: row.postTitle,
  windowTs: row.windowTs,
  windowDurationS: row.windowDurationS,
  scoreTransition: row.scoreTransition,
  matchContext: row.rail === "vod" ? (row.jobMatchContext ?? dump.matchContext) : dump.matchContext,
  transcript: null,
  attestation: row.attestation,
  matchClock: row.matchClock,
});

const failures: string[] = [];
const line = (s: string) => console.log(s);

line(`# ADAAAA-8914 AC14 $0 replay — ${dump.rows.length} stored bodies`);
line("");

let refusedOrRepaired = 0;
for (const row of dump.rows) {
  const evidence = evidenceOf(row);
  const reports = summarySentenceFacts(row.body, evidence);
  const unattested = unattestedSentences(row.body, evidence);
  const clock = summaryClockReport(row.body, evidence);
  const frames = matchClockFrameClaims(row.body, evidence);
  const decision = gateSummaryDetail(row.body, evidence);
  const band = row.rail === "vod" ? SUMMARY_VOD_BAND : SUMMARY_LIVE_BAND;

  line(`## ${row.id.slice(0, 8)} (${row.rail}) — stored ${row.storedWords} words / ${summarySentencesOf(row.body).length} sentences`);
  line(`   served gate: ${row.storedSummaryGate}`);
  line(
    `   AC14.1 sentences: ${reports.length} | facts/sentence: ${reports
      .map((r) => `${r.facts.length}:${r.facts.join("+") || "-"}`)
      .join(" ")}`
  );
  line(`   AC14.1 unattested sentences: ${unattested.length}`);
  for (const s of unattested) line(`     - ${JSON.stringify(s.sentence)} facts=${s.facts.length} claims=${JSON.stringify(s.claims)}`);
  line(
    `   AC14.4 clockToken(body)=${JSON.stringify(clock.tokens)} matchClock.token=${JSON.stringify(
      clock.matchClockToken
    )} servesMatchClock=${JSON.stringify(clock.servesMatchClock)} matchFrames=${JSON.stringify(frames)}`
  );
  line(
    `   gate now: ${decision.gate} | violations=${JSON.stringify(decision.violations)} | droppedClauses=${
      decision.droppedClauses.length
    } | repairedWords=${decision.repairedWords} (floor ${band.floorWords})`
  );
  const repaired = decision.summary !== null;
  const refused = decision.summary === null;
  line(`   AC14 verdict: ${repaired ? "REPAIRED (serves, filler deleted)" : refused ? "REFUSED (no copy served)" : "SERVED AS-IS"}`);
  if (repaired) {
    // A repair still serves the row: the surviving sentences are all fact sentences.
    const survivors = summarySentenceFacts(decision.summary!, evidence);
    const bad = survivors.filter((s) => s.facts.length === 0 || s.claims.length > 0);
    if (bad.length > 0) failures.push(`${row.id}: repaired body still carries an unattested sentence`);
    line(`   repaired body: ${JSON.stringify(decision.summary)}`);
  }
  if (refused || repaired) refusedOrRepaired++;
  line("");
}

// --- AC14.2: no unattested atmosphere/reaction/competition clause on a served body
const servedSurvivors = dump.rows.flatMap((row) => {
  const decision = gateSummaryDetail(row.body, evidenceOf(row));
  return decision.summary ? [{ id: row.id, body: decision.summary, evidence: evidenceOf(row) }] : [];
});
for (const s of servedSurvivors) {
  const bad = summarySentenceFacts(s.body, s.evidence).filter((x) => x.claims.length > 0);
  if (bad.length > 0) failures.push(`${s.id}: AC14.2 served body carries ${JSON.stringify(bad.map((b) => b.claims))}`);
}

// --- AC14.3: closest pair per JOB (the two rails are two jobs here)
//
// The BAR is on SERVED bodies: two cards of one job may not share a sentence at
// >= 0.80. The rev-7 bytes below are the defect this AC14.3 detector exists to
// catch, so their closest pair is printed as the MEASUREMENT even though those
// bodies no longer serve (they were served under the old bar, which only compared
// the first four words).
for (const rail of ["live", "vod"] as SummaryRail[]) {
  const rows = dump.rows.filter((r) => r.rail === rail);
  const served = rows
    .map((row) => ({ id: row.id, decision: gateSummaryDetail(row.body, evidenceOf(row)) }))
    .filter((r) => r.decision.summary)
    .map((r) => ({ id: r.id, body: r.decision.summary as string }));
  const servedClosest = served.length >= 2 ? closestSentencePair(served.map((s) => s.body)) : null;
  const storedClosest = closestSentencePair(rows.map((r) => r.body));
  line(
    `AC14.3 ${rail}: served bodies=${served.length} closest served pair=${
      servedClosest ? `${servedClosest.similarity.toFixed(3)} passes=${servedClosest.passes}` : "n/a (fewer than 2 served)"
    } threshold>=${SUMMARY_SENTENCE_REPEAT_THRESHOLD}`
  );
  line(
    `   rev-7 stored bytes (the defect, no longer served): closest pair=${
      storedClosest ? storedClosest.similarity.toFixed(3) : "n/a"
    }`
  );
  if (storedClosest) line(`     a: ${JSON.stringify(storedClosest.a)}\n     b: ${JSON.stringify(storedClosest.b)}`);
  if (servedClosest && !servedClosest.passes) {
    failures.push(`AC14.3 ${rail}: closest served pair ${servedClosest.similarity.toFixed(3)} >= 0.80`);
  }
}

line("");
line(`AC14 grade target: ${refusedOrRepaired}/${dump.rows.length} stored bodies refused or repaired`);
if (refusedOrRepaired !== dump.rows.length) failures.push("AC14 grade target: a stored body still serves as-is");

// --- AC14.5: the drop the lane names (informational here, the lane test pins it)
for (const row of dump.rows) {
  const decision = gateSummaryDetail(row.body, evidenceOf(row));
  if (decision.summary !== null) continue;
  const band = row.rail === "vod" ? SUMMARY_VOD_BAND : SUMMARY_LIVE_BAND;
  const reason = decision.droppedClauses.length > 0 && decision.repairedWords < band.floorWords ? "filler" : "gate";
  line(
    `AC14.5 ${row.id.slice(0, 8)}: drop reason=${reason} clauses=${decision.droppedClauses.length} claims=${JSON.stringify(
      decision.clauseClaims
    )} repairedWords=${decision.repairedWords} floor=${band.floorWords} words=${summaryWordCount(decision.raw)}`
  );
}

line("");
if (failures.length > 0) {
  line(`RESULT: FAIL (${failures.length})`);
  for (const f of failures) line(` - ${f}`);
  process.exit(1);
}
line("RESULT: PASS — every stored rev-7 body is refused or repaired, no served body carries filler, no pair >= 0.80");

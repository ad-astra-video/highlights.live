/**
 * ADAAAA-9106 `$0` census: the writer round 2 shape measured on the STORED rows of
 * the served block `68aa5f97` (job `06aabcd9`). No model call, no DB write, no GPU.
 *
 * What this proves and what it does not:
 *
 *  - It reads every stored row through the served lane's own evidence mapping
 *    (`summaryEvidenceForRow`) and the gate's own contract functions, so the fact
 *    menu, the fact credit, the serve verdict and the job-level similarity it
 *    prints are the ones the lane computes.
 *  - For each row it composes the body shape THIS ticket's prompt asks for:
 *    `ceil(targetMin/minSentences) + SUMMARY_WRITER_SENTENCE_MARGIN_WORDS` words
 *    per sentence (15 live -> 30 words on two sentences), and, when the row
 *    measured a score change, the score line packed into the sentence that names
 *    an attested actor's act.
 *  - It also composes the PRE-FIX shape (the old `ceil(25/2)=13`-word arithmetic,
 *    the score line only offered) so the delta is a number and not an argument,
 *    and it prints the STORED served words the QA grade measured.
 *  - It is a COPY-SHAPE census, NOT an AC1 depth measurement. AC1 grades what a
 *    served leg actually serves; a stored-row replay cannot buy that number, which
 *    is why the grade stays a separate QA ticket on a served job.
 *
 * Run: npx tsx tools/x9106-census.ts /tmp/x9051dump.json
 */
import { readFileSync } from "node:fs";
import {
  attestedActorNames,
  attestedFactKinds,
  attestedMatchClockToken,
  attestedSummaryFactKinds,
  clockLabel,
  gateSummaryDetail,
  summaryFactMenu,
  summaryFactMenuDetail,
  summaryOpeningRun,
  summaryWordCount,
  SUMMARY_WRITER_SENTENCE_MARGIN_WORDS,
} from "@highlights/events";
import { summaryEvidenceForRow, summaryRepeatKey } from "../services/server/src/summary-lane.js";

const dump = JSON.parse(readFileSync(process.argv[2] ?? "/tmp/x9051dump.json", "utf8")) as { job: any; rows: any[] };
const job = dump.job;
const rows = [...dump.rows].sort((a, b) => (a.windowTs ?? a.localizedTs ?? 0) - (b.windowTs ?? b.localizedTs ?? 0));

const quantile = (xs: number[], q: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

/** Act clauses, one per row, so the census measures cross-card distinctness too.
 *  None of them is a ball outcome (`BALL_OUTCOME_ASSERTION` names the shot/save/
 *  net verbs), so a row that measured `ballOutcome: null` may use them. */
const ACTS = [
  "completes a pass to move the ball toward the opposing side",
  "drives forward through the middle before the defence can reset",
  "wins the ball back with a challenge on the halfway line",
  "recovers the second ball and starts the counter down the flank",
  "dispossesses the runner and turns the move around before midfield",
  "threads a pass between the lines and keeps the move advancing",
  "crosses early toward the far side of the area",
  "tackles back on the edge of the area before the move develops",
  "intercepts the return pass and steps forward into the space",
  "wins the second ball after the challenge in midfield",
  "recovers position and threads the counter pass through the middle",
  "passes out of the challenge and keeps the move moving forward",
  "counters on the turnover with a short pass into the channel",
  "intercepts a loose pass near the halfway line and drives forward",
];
/** The act clauses the rev-12 served bodies actually used (short), for the
 *  PRE-FIX projection only. */
const ACTS_SHORT = ["completes a pass", "drives forward", "wins the ball back", "recovers the second ball"];
/** The SECOND sentence rotates per row: the depth the prompt asks for must not be
 *  bought by repeating one tail across the job (AC14). */
const TAILS = [
  "wins the ball back near the halfway line and turns the move toward the far side",
  "dispossesses the runner on the edge of the area and threads a pass between the lines",
  "intercepts a loose pass in midfield and counters on the turnover with a short pass",
  "tackles the runner before the move reaches midfield and recovers the second ball",
];

interface RowResult {
  id: string;
  kinds: string[];
  storedWords: number | null;
  storedGate: string;
  preBody: string;
  preWords: number | null;
  preGate: string;
  postBody: string;
  postWords: number | null;
  postGate: string;
  violations: string[];
  bodyKinds: string[];
  scoreInBody: boolean;
  scoreMeasured: boolean;
  teamNamed: boolean;
  similarity: number;
}

const servedSoFar: {
  highlightId: string;
  body: string;
  opening: string | null;
  windowTs: number | null;
  windowDurationS: number | null;
  clockToken: string | null;
}[] = [];

const table: RowResult[] = [];

for (const [index, row] of rows.entries()) {
  const evidence = summaryEvidenceForRow({ ...row, reason: row.reason_raw ?? row.reason ?? null }, "live");
  evidence.matchContext = job.matchContext;
  const kinds = attestedFactKinds(evidence);
  const actors = attestedActorNames(evidence);
  const A = actors[0] ?? "the home side";
  const B = actors[1] ?? actors[0] ?? "the away side";
  const clip = typeof evidence.windowTs === "number" ? clockLabel(evidence.windowTs) : null;
  const from = (evidence.scoreTransition?.from ?? "").trim();
  const to = (evidence.scoreTransition?.to ?? "").trim();
  const act = ACTS[index % ACTS.length];
  const tail = TAILS[index % TAILS.length];
  const at = clip ? ` at ${clip} into the clip` : "";

  // PRE-FIX shape: the old arithmetic asks 13 words per sentence on two sentences
  // and the score line is only OFFERED, never required. Composed with the same
  // short act clauses the rev-12 served copy answered with, so this projects the
  // 22 / 24 / 26 the block actually served.
  const preBody = `${A} ${ACTS_SHORT[index % ACTS_SHORT.length]}${at} to move the ball forward. ${B} recovers the ball to initiate a counter.`.replace(/\s+/g, " ").trim();
  // POST-FIX shape: >= 15 words per sentence on two sentences, the clip offset
  // riding on the actor's act, and — when the row measured a change — the score
  // line packed into that same sentence.
  const first = from && to
    ? `${A} ${act} as the scoreboard moves from ${from} to ${to}${at}`
    : `${A} ${act}${at}`;
  const postBody = `${first.replace(/\.$/, "")}. ${B} ${tail}.`.replace(/\s+/g, " ").trim();

  const preDecision = gateSummaryDetail(preBody, evidence);
  const postDecision = gateSummaryDetail(postBody, evidence);
  const served = postDecision.summary ?? "";
  const repeat = summaryRepeatKey(served, evidence, servedSoFar);
  const bodyKinds = served ? attestedSummaryFactKinds(served, evidence) : [];
  if (postDecision.summary !== null) {
    servedSoFar.push({
      highlightId: row.id,
      body: postDecision.summary,
      opening: summaryOpeningRun(postDecision.summary),
      windowTs: typeof evidence.windowTs === "number" ? evidence.windowTs : null,
      windowDurationS: typeof evidence.windowDurationS === "number" ? evidence.windowDurationS : null,
      clockToken: attestedMatchClockToken(evidence),
    });
  }
  table.push({
    id: String(row.id).slice(0, 8),
    kinds,
    storedWords: row.summary ? summaryWordCount(row.summary) : null,
    storedGate: row.summaryGate ?? "(none)",
    preBody,
    preWords: preDecision.summary ? summaryWordCount(preDecision.summary) : null,
    preGate: preDecision.gate,
    postBody: served,
    postWords: served ? summaryWordCount(served) : null,
    postGate: postDecision.gate,
    violations: postDecision.violations,
    bodyKinds,
    scoreInBody: Boolean(served) && /\d+\s*[-–]\s*\d+/.test(served),
    scoreMeasured: kinds.includes("score"),
    teamNamed: Boolean(served) && actors.some((name: string) => Boolean(name) && served.includes(name)),
    similarity: repeat.bodySimilarity,
  });
}

const laneServes = (gate: string) => gate === "accepted" || gate === "trimmed" || gate === "neutralised";

console.log(`job ${String(job.id).slice(0, 8)} rows=${rows.length}  (writer sentence margin +${SUMMARY_WRITER_SENTENCE_MARGIN_WORDS} w/sentence)`);
console.log("");
for (const r of table) {
  console.log(
    [
      r.id,
      `kinds=${r.kinds.join("+")}`,
      `stored=${r.storedWords ?? "-"}w/${r.storedGate}`,
      `pre=${r.preWords ?? "-"}w/${r.preGate}`,
      `post=${r.postWords ?? "-"}w/${r.postGate}${r.violations.length > 0 ? `(${r.violations.join(",")})` : ""}`,
      `bodyKinds=${r.bodyKinds.join("+") || "none"}`,
      `score=${r.scoreMeasured ? (r.scoreInBody ? "relayed" : "MISSING") : "n/a"}`,
      `team=${r.teamNamed ? "yes" : "NO"}`,
      `sim=${r.similarity.toFixed(3)}`,
    ].join(" ")
  );
  console.log(`   pre : ${r.preBody}`);
  console.log(`   post: ${r.postBody}`);
}

const evidenceFor = (shortId: string) => {
  const row = rows.find((r) => String(r.id).slice(0, 8) === shortId);
  const evidence = summaryEvidenceForRow({ ...row, reason: row.reason_raw ?? row.reason ?? null }, "live");
  evidence.matchContext = job.matchContext;
  return evidence;
};
for (const r of table) {
  console.log(`   ${r.id} menu=${summaryFactMenu(evidenceFor(r.id)).join(" | ")}`);
  for (const line of summaryFactMenuDetail(evidenceFor(r.id))) console.log(`        - ${line}`);
}

const served = table.filter((r) => laneServes(r.postGate));
const postWords = served.map((r) => r.postWords).filter((n): n is number => typeof n === "number");
const preWords = table.map((r) => r.preWords).filter((n): n is number => typeof n === "number");
const storedWords = table.map((r) => r.storedWords).filter((n): n is number => typeof n === "number");
const scored = table.filter((r) => r.scoreMeasured);
const maxSim = table.reduce((m, r) => Math.max(m, r.similarity), 0);

console.log("");
console.log(`STORED served (what QA measured on 68aa5f97): p50=${quantile(storedWords, 0.5)} p10=${quantile(storedWords, 0.1)} n=${storedWords.length} rows=[${storedWords.join(", ")}]`);
console.log(`PRE-FIX projection (old 13-w/sentence ask): served=${table.filter((r) => laneServes(r.preGate)).length}/${rows.length} p50=${quantile(preWords, 0.5)} p10=${quantile(preWords, 0.1)} rows=[${preWords.join(", ")}]`);
console.log(`POST-FIX shape (new 15-w/sentence ask): served=${served.length}/${rows.length} p50=${quantile(postWords, 0.5)} p10=${quantile(postWords, 0.1)} min=${Math.min(...postWords)} max=${Math.max(...postWords)} rows=[${postWords.join(", ")}]`);
console.log(`AC11 score relay: ${scored.filter((r) => r.scoreInBody).length}/${scored.length} measured-score rows carry the score line (${scored.map((r) => `${r.id}=${r.scoreInBody ? "yes" : "MISSING"}`).join(", ")})`);
console.log(`AC9 two-kind: ${served.filter((r) => r.bodyKinds.length >= 2).length}/${served.length} served bodies carry >= 2 fact kinds`);
console.log(`AC11 team named: ${served.filter((r) => r.teamNamed).length}/${served.length} served bodies name an attested team`);
console.log(`AC14 max pairwise body similarity in the job=${maxSim.toFixed(3)} (bar < 0.8; rev-12 served 0.481)`);
console.log(`summaryCalls by construction=1/row (first pass; no depth retry, no retry of any kind)`);
console.log(`copy-shape census only — AC1 depth is graded on a SERVED job, not here`);

/**
 * ADAAAA-9047 `$0` census: the LIVE writer round measured on the stored rows of
 * the rev-10 natural job `771f42de`. No model call, no DB write, no GPU.
 *
 * What this proves and what it does not:
 *
 *  - It reads every stored promoted row through the served lane's own evidence
 *    mapping (`summaryEvidenceForRow`) and the gate's own contract functions, so
 *    the fact menu, the fact credit and the serve verdict it prints are the ones
 *    the lane would compute.
 *  - For each row it composes a WRITER-SHAPED body — two or three sentences of
 *    the length the first-pass prompt now asks for, built ONLY from the row's own
 *    attested values (clock, score line, named actors, the bounded-act vocabulary
 *    the prompt hands the writer) — and reports whether the gate serves it, in how
 *    many words, and how similar it is to the bodies already served in the job.
 *  - It is a COPY-SHAPE census, not a model simulation and NOT an AC1 depth
 *    measurement. AC1 grades what a served leg actually serves; a stored-row
 *    replay cannot buy that number, which is why the ticket stays blocked on the
 *    leg until one runs.
 *
 * Run: npx tsx tools/replay-9047.ts /tmp/hl9032_dump.json
 */
import { readFileSync } from "node:fs";
import {
  attestedActorNames,
  attestedFactKinds,
  attestedMatchClockToken,
  clockLabel,
  gateSummaryDetail,
  summaryFactMenu,
  summaryFactMenuDetail,
  summaryOpeningRun,
  summaryWordCount,
} from "@highlights/events";
import { summaryEvidenceForRow, summaryRepeatKey } from "../services/server/src/summary-lane.js";

const dump = JSON.parse(readFileSync(process.argv[2] ?? "/tmp/hl9032_dump.json", "utf8")) as {
  job: any;
  rows: any[];
};

const job = dump.job;
const rows = [...dump.rows].sort((a, b) => (a.windowTs ?? a.localizedTs ?? 0) - (b.windowTs ?? b.localizedTs ?? 0));

const quantile = (xs: number[], q: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

/** Act clauses that carry NO ball outcome, so a row that measured none may use
 *  them (`BALL_OUTCOME_ASSERTION` names the shot/save/net verbs; none is here).
 *  Each row takes a different pair, so the census also measures cross-card
 *  distinctness instead of repeating one template fourteen times. */
const ACTS: readonly string[] = [
  "intercepts a loose pass near the halfway line",
  "tackles the runner before the move reaches midfield",
  "wins the ball back with a challenge on the halfway line",
  "recovers the second ball and starts the counter",
  "dispossesses the runner and turns the move around",
  "threads a pass between the lines",
  "crosses early toward the far side of the area",
  "drives forward through the middle of the pitch",
  "counters on the turnover with a short pass",
  "passes out of the challenge and keeps the move moving forward",
  "tackles back on the edge of the area",
  "intercepts the return pass and steps forward",
  "wins the second ball after the challenge",
  "recovers position and threads the counter pass",
];

interface Line {
  row: string;
  kinds: string[];
  menu: string[];
  detail: string[];
  storedGate: string;
  storedWords: number | null;
  corpus: string;
  corpusWords: number;
  gate: string;
  violations: string[];
  repeated: string | null;
  similarity: number;
}

const lines: Line[] = [];
const served: {
  highlightId: string;
  body: string;
  opening: string | null;
  windowTs: number | null;
  windowDurationS: number | null;
  clockToken: string | null;
}[] = [];

for (const [index, row] of rows.entries()) {
  const evidence = summaryEvidenceForRow({ ...row, reason: row.reason_raw ?? row.reason ?? null }, "live");
  evidence.matchContext = job.matchContext;
  const kinds = attestedFactKinds(evidence);
  const actors = attestedActorNames(evidence).filter((name: string) => /Liverpool|Chelsea/.test(name));
  const A = actors[0] ?? "the home side";
  const B = actors[1] ?? actors[0] ?? "the away side";
  const clip = typeof evidence.windowTs === "number" ? clockLabel(evidence.windowTs) : null;
  const from = (evidence.scoreTransition?.from ?? "").trim();
  const to = (evidence.scoreTransition?.to ?? "").trim();

  const first = ACTS[index % ACTS.length];
  const second = ACTS[(index + 5) % ACTS.length];
  const third = ACTS[(index + 9) % ACTS.length];
  // The prompt tells the writer to vary its opening four words (AC8) and never to
  // share a sentence shape across cards (AC14.3), so the corpus rotates both the
  // clock clause position and the closing clause. A census that used one shape
  // fourteen times would measure its own template, not the writer's diversity.
  const TAILS = [
    `and the ${A} back line answers inside the ${B} half`,
    `with the ${B} midfield still turned back toward its own half`,
    `before the ${A} defence can reset and mark the runner`,
  ];
  const tail = TAILS[index % TAILS.length];
  const clockFirst = [
    `At ${clip} into the clip ${A} ${first}`,
    `${A} ${first} at ${clip} into the clip`,
    `With the clip at ${clip}, ${A} ${first}`,
    `${A} ${first}, ${clip} into the clip,`,
  ];
  const sentences: string[] = [];
  if (kinds.includes("score") && clip && from && to) {
    // Three attested kinds -> three sentences, the score line and the clip offset
    // PACKED into the first sentence (the depth lever the prompt now names).
    sentences.push(`${clockFirst[index % clockFirst.length]} as the scoreboard moves from ${from} to ${to}`);
    sentences.push(`${B} ${second}`);
    sentences.push(`${A} ${third}`);
  } else if (clip) {
    sentences.push(clockFirst[index % clockFirst.length]);
    sentences.push(`${B} ${second} ${tail}`);
  } else {
    sentences.push(`${A} ${first}`);
    sentences.push(`${B} ${second} ${tail}`);
  }
  const corpus = sentences.map((s) => (/[.!?]$/.test(s) ? s : `${s}.`)).join(" ");

  const decision = gateSummaryDetail(corpus, evidence);
  const repeat = summaryRepeatKey(corpus, evidence, served);
  const line: Line = {
    row: row.id.slice(0, 8),
    kinds,
    menu: summaryFactMenu(evidence),
    detail: summaryFactMenuDetail(evidence),
    storedGate: row.summaryGate ?? "(none)",
    storedWords: typeof row.summaryWordCount === "number" ? row.summaryWordCount : null,
    corpus,
    corpusWords: summaryWordCount(corpus),
    gate: decision.gate,
    violations: decision.violations,
    repeated: repeat.key,
    similarity: repeat.bodySimilarity,
  };
  lines.push(line);
  if (decision.summary !== null) {
    served.push({
      highlightId: row.id,
      body: decision.summary,
      opening: summaryOpeningRun(decision.summary),
      windowTs: typeof evidence.windowTs === "number" ? evidence.windowTs : null,
      windowDurationS: typeof evidence.windowDurationS === "number" ? evidence.windowDurationS : null,
      clockToken: attestedMatchClockToken(evidence),
    });
  }
}

for (const line of lines) {
  console.log(
    [
      line.row,
      `kinds=${line.kinds.join("+") || "none"}`,
      `stored=${line.storedGate}${line.storedWords !== null ? `/${line.storedWords}w` : ""}`,
      `corpus=${line.corpusWords}w`,
      `gate=${line.gate}`,
      line.violations.length > 0 ? `viol=${line.violations.join(",")}` : "",
      `repeat=${line.repeated ?? "none"}/${line.similarity.toFixed(3)}`,
      `:: ${line.corpus}`,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

const serving = lines.filter((line) => laneServes(line.gate));
const words = serving.map((line) => line.corpusWords);
const storedWords = lines.map((line) => line.storedWords).filter((n): n is number => typeof n === "number");
const maxSimilarity = lines.reduce((max, line) => Math.max(max, line.similarity), 0);

console.log("");
console.log(`job ${String(job.id).slice(0, 8)} rows=${rows.length}`);
console.log(`corpus bodies served=${serving.length}/${rows.length}`);
console.log(`corpus words p50=${quantile(words, 0.5)} p10=${quantile(words, 0.1)} min=${Math.min(...words)} max=${Math.max(...words)}`);
console.log(`stored draft words p50=${quantile(storedWords, 0.5)} n=${storedWords.length}`);
console.log(`max body similarity against a body already served in the job=${maxSimilarity.toFixed(3)}`);
console.log(`summaryCalls by construction=1/row (the first pass; no depth retry)`);
console.log(`fact menu contract rows=${lines.filter((line) => line.menu.length > 0).length}/${rows.length}, fact-detail rows=${lines.filter((line) => line.detail.length > 0).length}/${rows.length}`);

function laneServes(gate: string): boolean {
  return gate === "accepted" || gate === "trimmed" || gate === "neutralised";
}

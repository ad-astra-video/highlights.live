// ADAAAA-8969 (increment 2) — the `$0` replay of the rev-8 LIVE rail's 19 stored rows.
//
// Usage (from the repo root):
//   ./node_modules/.bin/tsx evals/adaaa_8969/replay8969.ts evals/adaaa_8969/live-rail-e4c2fe29.json
//
// Same fixture as increment 1 (`evals/adaaa_8941/live-rail-e4c2fe29.json`): the 19
// promoted rows of live job `e4c2fe29-68fe-472c-91da-b96d1dd8ca93` (`file-sim`,
// `/data/clips/kids300_7935.mp4`, 1200 s, 379 decides) with the exact bytes the
// rev-8 served build put on the card. No model call, no GPU, no deploy.
//
// It grades increment 2's two defects, with the lane's own key functions:
//
//   Lens A — rev-8 BASELINE reconstruction. The old job-wide key (opening-run
//     equality OR any sentence >= 0.80 similarity) over the same served set, with
//     the gate neutralised exactly as rev-8 was (it accepted every one of these
//     bodies — that is how 16 of them reached the repeat key). Must reproduce the
//     stored census: 3 accepted / 16 `dropped:repeat`.
//   Lens B — CONTRACT KEY (AC8 + AC14, job scope). `summaryRepeatKey` from
//     `services/server/src/summary-lane.ts` over the same set. Both bars are
//     graded on the served COPY within one job with NO instant exception, so the
//     stored census (3 servable / 16 `repeat` drops) is the honest reading of
//     these bytes — see Lens D. ADAAAA-8969 increment 2 briefly exempted rows on
//     different windows; ADAAAA-8941 reverted that as a bar change.
//   Lens C — INTEGRATED: increment 1's attested-fact gate first, then the contract
//     key. Reported, not graded: the gate refuses these filler bodies by design.
//   Lens D — NO INSTANT EXCEPTION: a shared opening / shared sentence on a
//     DIFFERENT window and a DIFFERENT clock token still drops. This is the
//     proof that the key did not quietly trade AC8/AC14 for coverage.
//   Defect 4 — `postTitle`/`postTitleGate` per row through the fixed
//     `gatePostTitleDetail(..., { label })`: an empty candidate degrades to the
//     row's own non-asserting label instead of storing `null`/`absent`.
//
// Exit code 1 when a graded AC fails on this stored row set. The defect-3 COVERAGE
// bar (>= 10 servable) is graded as `known-unreachable` on these bytes: they are
// one decide template, and the fix is upstream body diversity (ADAAAA-8928), not a
// looser key. A key change that clears 10 here would be a bar change and Lens D
// fails on it.
import { readFileSync } from "node:fs";
import {
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
  gatePostTitleDetail,
  gateSummaryDetail,
  postTitleLabel,
  sentenceSimilarity,
  storedLabelTitle,
  summaryOpeningRun,
  summarySentencesOf,
  type SummaryEvidence,
} from "../../packages/events/src/index.js";
import { summaryRepeatKey, type SummaryServedBody } from "../../services/server/src/summary-lane.js";

interface StoredRow {
  id: string;
  rail: SummaryEvidence["rail"];
  body: string | null;
  raw: string | null;
  caption: string | null;
  postTitle: string | null;
  postTitleGate: string | null;
  windowTs: number | null;
  windowDurationS: number | null;
  scoreTransition: { from: string; to: string } | null;
  matchClock: { token?: string | null; seconds?: number | null; legible?: boolean | null } | null;
  verdict: string | null;
  eventType: string | null;
  attestation: {
    ballOutcome?: string | null;
    goalCrossed?: boolean | null;
    scoreBoardChanged?: boolean | null;
  } | null;
  storedSummaryGate: string | null;
  storedWords: number;
  createdAt: string;
}

interface StoredDump {
  jobId: string;
  source: string;
  matchContext: unknown;
  rows: StoredRow[];
}

const path = process.argv[2];
if (!path) {
  console.error("usage: replay8969.ts <live-rail-e4c2fe29.json>");
  process.exit(2);
}
const dump: StoredDump = JSON.parse(readFileSync(path, "utf8"));

const evidenceOf = (row: StoredRow): SummaryEvidence => ({
  rail: row.rail,
  verdict: row.verdict,
  eventType: row.eventType,
  reason: null,
  caption: row.caption,
  postTitle: row.postTitle,
  windowTs: row.windowTs,
  windowDurationS: row.windowDurationS,
  scoreTransition: row.scoreTransition,
  matchContext: dump.matchContext,
  transcript: null,
  attestation: row.attestation,
  matchClock: row.matchClock,
});

/** The bytes the row actually had when it reached the repeat key: a repeat-drop
 *  row stored its candidate as `summaryRaw`. */
const storedBody = (row: StoredRow): string => (row.body ?? row.raw ?? "").trim();

const rows = [...dump.rows].sort((a, b) => (a.windowTs ?? 0) - (b.windowTs ?? 0));
const line = (s: string) => console.log(s);
const failures: string[] = [];

line(`# ADAAAA-8969 increment-2 $0 replay — job ${dump.jobId} (${dump.source})`);
line(`rows=${rows.length}`);
line(`stored census: ${JSON.stringify(countBy(rows, (r) => r.storedSummaryGate ?? "null"))}`);

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
}

/** One served body, in the shape both keys read. */
function servedStateOf(row: StoredRow, body: string): SummaryServedBody {
  return {
    highlightId: row.id,
    windowTs: row.windowTs,
    windowDurationS: row.windowDurationS,
    clockToken: row.matchClock?.token ?? null,
    body,
    opening: summaryOpeningRun(body),
  };
}

/** The rev-8 key, verbatim: a shared opening run, or one sentence at the bar. */
function rev8RepeatKey(
  row: StoredRow,
  body: string,
  served: readonly SummaryServedBody[]
): { repeated: boolean; reason: string; inputs: string } {
  const opening = summaryOpeningRun(body);
  const sentences = summarySentencesOf(body);
  const token = row.matchClock?.token ?? null;
  let best: { id: string; similarity: number; sameClock: boolean; overlapS: number | null } | null = null;
  for (const other of served) {
    const similarity = sentenceSimilarity(body, other.body);
    const overlapS =
      row.windowTs !== null && other.windowTs !== null ? Math.abs(row.windowTs - other.windowTs) : null;
    const sameClock = token !== null && other.clockToken !== null && token === other.clockToken;
    if (!best || similarity > best.similarity) best = { id: other.highlightId, similarity, sameClock, overlapS };
  }
  let bestSentence: { id: string; a: string; similarity: number } | null = null;
  for (const sentence of sentences) {
    for (const other of served) {
      for (const otherSentence of summarySentencesOf(other.body)) {
        const similarity = sentenceSimilarity(sentence, otherSentence);
        if (similarity >= SUMMARY_SENTENCE_REPEAT_THRESHOLD && (!bestSentence || similarity > bestSentence.similarity)) {
          bestSentence = { id: other.highlightId, a: sentence, similarity };
        }
      }
    }
  }
  const openingRepeat = opening !== null && served.some((s) => s.opening === opening);
  const inputs =
    `opening=${JSON.stringify(opening)} openingRepeat=${openingRepeat} clockToken=${JSON.stringify(token)} ` +
    `closestServed=${JSON.stringify(best?.id.slice(0, 8) ?? null)} bodySimilarity=${best ? best.similarity.toFixed(3) : "n/a"} ` +
    `sameClock=${JSON.stringify(best?.sameClock ?? false)} windowOverlapS=${best?.overlapS ?? "n/a"} ` +
    `sentenceRepeat=${bestSentence ? `${bestSentence.similarity.toFixed(3)} ${JSON.stringify(bestSentence.a.slice(0, 60))}` : "none"}`;
  if (openingRepeat) return { repeated: true, reason: "repeat:opening-run", inputs };
  if (bestSentence) return { repeated: true, reason: "repeat:sentence", inputs };
  return { repeated: false, reason: "accepted", inputs };
}

// --- Lens A: the rev-8 baseline (gate neutralised) ---------------------------
line("");
line("## Lens A — rev-8 baseline reconstruction (old job-wide key, gate accepted)");
{
  const served: SummaryServedBody[] = [];
  let accepted = 0;
  const drops: Record<string, number> = {};
  for (const row of rows) {
    const body = storedBody(row);
    if (!body) {
      line(`- ${row.id.slice(0, 8)}: NO BYTES (body=null raw=null)`);
      continue;
    }
    const verdict = rev8RepeatKey(row, body, served);
    if (verdict.repeated) {
      drops[verdict.reason] = (drops[verdict.reason] ?? 0) + 1;
      line(`- ${row.id.slice(0, 8)} stored=${JSON.stringify(row.storedSummaryGate)} -> ${verdict.reason}`);
      line(`  ${verdict.inputs}`);
    } else {
      accepted += 1;
      line(`- ${row.id.slice(0, 8)} stored=${JSON.stringify(row.storedSummaryGate)} -> accepted`);
      served.push(servedStateOf(row, body));
    }
  }
  line(`A: accepted=${accepted} repeat-drops=${rows.length - accepted} drops-by-reason=${JSON.stringify(drops)}`);
  const storedRepeat = rows.filter((r) => r.storedSummaryGate === "dropped:repeat").length;
  if (rows.length - accepted !== storedRepeat) {
    failures.push(`Lens A does not reproduce the stored census: reconstructed ${rows.length - accepted} repeat drops vs ${storedRepeat} stored`);
  }
}

// --- Lens B: the scoped key (defect 3 pass bar) -------------------------------
line("");
line("## Lens B — scoped repeat key (increment 2), gate neutralised");
let servableB = 0;
{
  const served: SummaryServedBody[] = [];
  const drops: Record<string, number> = {};
  for (const row of rows) {
    const body = storedBody(row);
    if (!body) continue;
    const verdict = summaryRepeatKey(body, evidenceOf(row), served);
    const inputs =
      `opening=${JSON.stringify(summaryOpeningRun(body))} openingRepeat=${JSON.stringify(verdict.openingRepeat)} ` +
      `clockToken=${JSON.stringify(row.matchClock?.token ?? null)} against=${JSON.stringify(verdict.against?.slice(0, 8) ?? null)} ` +
      `bodySimilarity=${verdict.bodySimilarity.toFixed(3)} sameClock=${JSON.stringify(verdict.sameClock)} ` +
      `windowOverlapS=${verdict.windowOverlapS ?? "n/a"} ` +
      `sentenceRepeat=${verdict.sentence ? `${verdict.sentence.similarity.toFixed(3)} ${JSON.stringify(verdict.sentence.a.slice(0, 60))}` : "none"}`;
    if (verdict.key !== null) {
      const reason = `repeat:${verdict.key}`;
      drops[reason] = (drops[reason] ?? 0) + 1;
      line(`- ${row.id.slice(0, 8)} -> ${reason}`);
      line(`  ${inputs}`);
      continue;
    }
    servableB += 1;
    line(`- ${row.id.slice(0, 8)} -> accepted (distinct promotion)`);
    line(`  ${inputs}`);
    served.push(servedStateOf(row, body));
  }
  line(`B: servable=${servableB}/${rows.length} repeat-drops=${rows.length - servableB - countBlank(rows)} drops-by-reason=${JSON.stringify(drops)}`);
}

function countBlank(items: readonly StoredRow[]): number {
  return items.filter((r) => !storedBody(r)).length;
}

// --- Lens C: integrated (increment-1 gate, then scoped key) ------------------
line("");
line("## Lens C — integrated: increment-1 gate, then scoped key");
{
  const served: SummaryServedBody[] = [];
  let gateAccepted = 0;
  let servableC = 0;
  const drops: Record<string, number> = {};
  for (const row of rows) {
    const body = storedBody(row);
    if (!body) continue;
    const decision = gateSummaryDetail(body, evidenceOf(row));
    if (!decision.summary) {
      const reason = `gate:${decision.violations.join(",")}`;
      drops[reason] = (drops[reason] ?? 0) + 1;
      continue;
    }
    gateAccepted += 1;
    const verdict = summaryRepeatKey(decision.summary, evidenceOf(row), served);
    if (verdict.key !== null) {
      const reason = `repeat:${verdict.key}`;
      drops[reason] = (drops[reason] ?? 0) + 1;
      continue;
    }
    servableC += 1;
    served.push(servedStateOf(row, decision.summary));
  }
  line(`C: gate-accepted=${gateAccepted} servable=${servableC} drops=${JSON.stringify(drops)}`);
}

// --- Defect 4: postTitle through the fixed gate ------------------------------
line("");
line("## Defect 4 — postTitle / postTitleGate per row (fixed gate, stored candidate)");
let titledRows = 0;
let absentRows = 0;
const gateCensus: Record<string, number> = {};
{
  const used: string[] = [];
  for (const row of rows) {
    const label = postTitleLabel(row.eventType, row.verdict);
    // The stored candidate IS what the lane gated: these rows stored
    // `postTitle: null`, i.e. the model emitted no title at all.
    const decision = gatePostTitleDetail(row.postTitle, undefined, { label });
    const composed = decision.title
      ? storedLabelTitle({ label: decision.title, windowTs: row.windowTs ?? 0, subject: null, used })
      : null;
    const stored = composed ? composed.title : null;
    if (stored) {
      titledRows += 1;
      used.push(stored);
    }
    if (decision.gate === "absent") absentRows += 1;
    gateCensus[decision.gate] = (gateCensus[decision.gate] ?? 0) + 1;
    line(
      `- ${row.id.slice(0, 8)} stored=postTitle:${JSON.stringify(row.postTitle)} gate:${JSON.stringify(row.postTitleGate)} ` +
        `-> label=${JSON.stringify(label)} gate=${JSON.stringify(decision.gate)} postTitle=${JSON.stringify(stored)}`
    );
  }
}

// --- Lens D: the contract has NO instant exception (AC8 + AC14) --------------
line("");
line("## Lens D — the contract key drops a shared opening / sentence on a DIFFERENT instant");
{
  const servedA: SummaryServedBody = {
    highlightId: "lena0001",
    windowTs: 100,
    windowDurationS: 15,
    clockToken: "18:12",
    body:
      "The scoreboard changes from 2-1 to 2-2 at the 18:12 mark of the match. " +
      "Barcelona turns the play over near the byline and drives the ball up the touchline.",
    opening: summaryOpeningRun(
      "The scoreboard changes from 2-1 to 2-2 at the 18:12 mark of the match. Barcelona turns the play over near the byline and drives the ball up the touchline."
    ),
  };
  const ev = { rail: "live", attestation: { ballOutcome: null }, matchClock: { token: "22:13", seconds: 1333, legible: true } } as unknown as SummaryEvidence;
  // Different window (132 s apart), different attested clock token, and the copy
  // is the previous card's with only the digits changed — the measured rev-8 shape.
  const sameCopyLater =
    "The scoreboard changes from 2-1 to 2-2 at the 22:13 mark of the match. " +
    "Barcelona turns the play over near the byline and drives the ball up the touchline.";
  const verdict = summaryRepeatKey(sameCopyLater, ev, [servedA]);
  line(
    `- shared copy on a later instant -> key=${JSON.stringify(verdict.key)} ` +
      `openingRepeat=${JSON.stringify(verdict.openingRepeat)} ` +
      `sentence=${verdict.sentence ? verdict.sentence.similarity.toFixed(3) : "none"} ` +
      `windowOverlapS=${verdict.windowOverlapS ?? "n/a"} sameClock=${JSON.stringify(verdict.sameClock)}`
  );
  if (verdict.key === null) {
    failures.push("Lens D: a shared opening/sentence on a different instant SERVED — AC8/AC14 have no instant exception");
  }
}

// --- Verdict -----------------------------------------------------------------
line("");
line("---");
line(`defect 3: rev-8 servable=3 (stored accepted count ${JSON.stringify(countBy(rows, (r) => r.storedSummaryGate ?? "null").accepted ?? 0)}) -> contract-key servable=${servableB}/${rows.length}`);
line(`defect 4: postTitle served=${titledRows}/${rows.length} gate=${JSON.stringify(gateCensus)}`);
if (servableB >= 10) {
  line(`defect 3 pass bar (>= 10 servable): MET at contract key = ${servableB}`);
} else {
  line(
    `defect 3 pass bar (>= 10 servable): KNOWN-UNREACHABLE on these stored bytes — contract-key servable=${servableB}. ` +
      "All 19 bodies are one decide template, and AC8/AC14 are copy bars with no instant exception, so the deck bar is " +
      "owned upstream (ADAAAA-8928 prompt parity) and is proven on a funded leg with regenerated bodies."
  );
}
if (titledRows < 1) failures.push("defect 4 pass bar: postTitle non-null on 0 rows");
if (absentRows > 0) failures.push(`defect 4 pass bar: postTitleGate names "absent" on ${absentRows} row(s)`);

line("");
if (failures.length > 0) {
  line(`RESULT: FAIL (${failures.length})`);
  for (const failure of failures) line(` - ${failure}`);
  process.exit(1);
}
line("RESULT: PASS — the contract key keeps AC8/AC14 with no instant exception, and every row names its title");

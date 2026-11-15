/**
 * ADAAAA-9089 $0 writer-lever probe — the rev-13 served VOD job `54537ffa`'s
 * stored bytes, read through the WRITER's own contract functions. No model call,
 * no DB write, no GPU, no leg.
 *
 * The ticket's acceptance (a natural VOD job after the deploy, graded on
 * ADAAAA-9088) cannot be measured here: a prompt change does not move stored
 * drafts. What this probe CAN measure, and does:
 *
 *  1. FACTS — per repeat row, the fact kinds / actors / clock / score transition
 *     `summaryEvidenceForRow` attests, so the prompt instruction is checked
 *     against material the row actually has.
 *  2. FRAME CENSUS — which stored sentences (8 served bodies + 4 refused drafts)
 *     re-emit one of the shared frame shapes. This is the size of the class the
 *     prompt has to stop.
 *  3. PROMPT — whether the ticket's four banned shapes are stated, on the first
 *     pass and on the retry, and whether any stated shape is FILLED IN with a
 *     real clock (AC14 copies a filled example; a `…` slot cannot be served).
 *  4. ACHIEVABILITY — a body written by the NEW rule (each sentence names an
 *     attested actor as its subject and carries the clip offset on the act),
 *     gated through the served lane's own `gateSummaryDetail` + `summaryRepeatKey`
 *     against the job's prior served sentences. If such a body cannot serve, the
 *     prompt instruction is not winnable on this evidence and the lever is wrong.
 *  5. CLOSEST PAIR — the within-job sentence similarity after (4), i.e. the
 *     side-bar the acceptance grades (`< 0.80`).
 *
 * Run: npx tsx tools/probe9089.ts <corpus.json>
 */
import { readFileSync } from "node:fs";
import {
  attestedActorNames,
  attestedFactKinds,
  buildSummaryPrompt,
  gateSummaryDetail,
  sentenceSimilarity,
  summaryBand,
  summaryFactMenuDetail,
  summarySentencesOf,
  summaryWordCount,
  SUMMARY_MAX_CALLS_PER_ROW,
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
  type SummaryRetryDirective,
} from "@highlights/events";
import { summaryEvidenceForRow, summaryRepeatKey, type SummaryServedBody } from "../services/server/src/summary-lane.js";

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

const num = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
};

const corpus = JSON.parse(readFileSync(process.argv[2] ?? "corpus.json", "utf8")) as Corpus;

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

/** The shared frame shapes. Each is the part another card can already carry; the
 *  clock, the actor and any trailing clause are the slots. Matching is on the
 *  mask-stripped sentence so a clock swap is the same shape (AC14.3, ADAAAA-9031). */
const FRAME_SHAPES: { name: string; re: RegExp }[] = [
  { name: "clip-carries-this-sequence", re: /\bthe clip carries (this|the) sequence\b/i },
  { name: "passage-sits-at", re: /\bthis passage sits at\b/i },
  { name: "window-runs-at", re: /\bthe window runs at\b/i },
  { name: "scoring-sequence-occurs-at", re: /\bthis scoring sequence occurs at\b/i },
  { name: "scoring-play-occurs-at", re: /\bthis scoring play occurs at\b/i },
  { name: "actor-in-the-passage", re: /\bis in the passage at\b/i },
  { name: "actor-in-the-sequence", re: /\bis in the sequence as\b/i },
  { name: "ball-crosses-at-clock", re: /\bthe ball crosses the goal line into the net at\b/i },
  { name: "this-action-occurs-at", re: /\bthis action occurs at\b/i },
];

const frameShapeOf = (sentence: string): string | null =>
  FRAME_SHAPES.find((shape) => shape.re.test(sentence))?.name ?? null;

const servedBodies: SummaryServedBody[] = corpus.served
  .slice()
  .sort((a, b) => a.ts - b.ts)
  .map((row) => ({
    highlightId: row.hid,
    windowTs: row.ts,
    windowDurationS: null,
    clockToken: null,
    body: row.body,
    opening: summarySentencesOf(row.body)[0] ?? "",
  }));
const before = (ts: number): SummaryServedBody[] => servedBodies.filter((row) => (row.windowTs ?? 0) < ts);
const sentencesBefore = (ts: number): string[] => before(ts).flatMap((row) => summarySentencesOf(row.body));

// --- 2. FRAME CENSUS -------------------------------------------------------
const census: Record<string, number> = {};
let censusRows = 0;
const countFrames = (where: string, hid: string, text: string): void => {
  const frames = summarySentencesOf(text)
    .map((sentence) => frameShapeOf(sentence))
    .filter((name): name is string => Boolean(name));
  if (frames.length > 0) censusRows += 1;
  for (const name of frames) census[`${where}:${name}`] = (census[`${where}:${name}`] ?? 0) + 1;
};
for (const row of corpus.served) countFrames("served", row.hid, row.body);
for (const row of corpus.repeatRows) countFrames("draft", row.hid, row.rawBody);

// --- 3. PROMPT -------------------------------------------------------------
const RETRY_SHAPE = (hid: string): SummaryRetryDirective => ({
  words: 0,
  sentences: 0,
  violations: [],
  repeatedSentences: ["The clip carries this sequence at 1:57 into the clip."],
});

const TICKET_SHAPES = [
  "The clip carries this sequence at",
  "This passage sits at",
  "The window runs at",
  "This scoring sequence occurs at",
];
const CLOCK_STAMP = /\b\d{1,3}:\d{2}\b/;

interface RowReport {
  hid: string;
  stored: string;
  kinds: string[];
  actors: string[];
  clock: number | null;
  score: string;
  factValues: number;
  firstPass: { shapesPresent: string[]; shapesFilled: string[]; chars: number };
  retryPass: { shapesPresent: string[]; shapesFilled: string[]; chars: number; namesRepeat: boolean; actorRule: boolean };
  prototype: { text: string | null; words: number; violations: string[]; repeatKey: string; closest: number };
}

const rows: RowReport[] = [];
for (const row of corpus.repeatRows.slice().sort((a, b) => num(a.ev?.start)! - num(b.ev?.start)!)) {
  const evidence = evidenceOf(row.ev);
  const priorSentences = sentencesBefore(evidence.windowTs ?? 0);
  const priorBodies = before(evidence.windowTs ?? 0);
  const actors = attestedActorNames(evidence);

  const first = buildSummaryPrompt({ ...evidence, avoidSentences: priorSentences });
  const retryPrompt = buildSummaryPrompt({
    ...evidence,
    avoidSentences: priorSentences,
    retry: { ...RETRY_SHAPE(row.hid), violations: row.violations },
  });

  const state = (prompt: string) => {
    const present = TICKET_SHAPES.filter((shape) => prompt.includes(shape));
    const filled = TICKET_SHAPES.filter((shape) => {
      const at = prompt.indexOf(shape);
      if (at < 0) return false;
      return CLOCK_STAMP.test(prompt.slice(at, at + shape.length + 30));
    });
    return { shapesPresent: present, shapesFilled: filled, chars: prompt.length };
  };

  // --- 4. ACHIEVABILITY: a body written by the NEW rule --------------------
  // Each sentence: attested actor as SUBJECT + a bounded act + the clip offset.
  // No frame shape, no frame subject, no appended clause on a frame.
  const clock = typeof evidence.windowTs === "number" ? evidence.windowTs : null;
  const clockLabel = clock === null ? null : `${Math.floor(clock / 60)}:${String(Math.round(clock % 60)).padStart(2, "0")}`;
  const acts = ["drives forward", "completes a pass", "wins the ball back", "recovers", "tackles"];
  const prototypeText =
    actors.length > 0 && clockLabel
      ? actors
          .slice(0, 2)
          .map((actor, index) => `${actor} ${acts[index % acts.length]} at ${clockLabel} into the clip.`)
          .join(" ")
      : null;
  const decision = prototypeText ? gateSummaryDetail(prototypeText, evidence) : null;
  const judged: string = decision?.summary ?? prototypeText ?? "";
  const repeat = judged ? summaryRepeatKey(judged, evidence, priorBodies) : { key: "none" as const };
  const closest = judged
    ? summarySentencesOf(judged).reduce((max, sentence) => {
        const local = priorSentences.reduce((m, other) => Math.max(m, sentenceSimilarity(other, sentence)), 0);
        return Math.max(max, local);
      }, 0)
    : 0;

  rows.push({
    hid: row.hid,
    stored: `${row.gate}/${row.retry}`,
    kinds: attestedFactKinds(evidence),
    actors,
    clock,
    score: `${evidence.scoreTransition?.from ?? "-"} -> ${evidence.scoreTransition?.to ?? "-"}`,
    factValues: summaryFactMenuDetail(evidence).length,
    firstPass: state(first),
    retryPass: {
      ...state(retryPrompt),
      namesRepeat: retryPrompt.includes("REPEAT a sentence a card in this job already carries"),
      actorRule: retryPrompt.includes("EVERY sentence must name one of them as its SUBJECT"),
    },
    prototype: {
      text: decision?.summary ?? null,
      words: summaryWordCount(judged),
      violations: decision?.violations ?? ["(no prototype: row attests no actor + clock)"],
      repeatKey: repeat.key,
      closest: Number(closest.toFixed(3)),
    },
  });
}

const report = {
  job: corpus.jobId,
  callsPerRowContract: SUMMARY_MAX_CALLS_PER_ROW,
  repeatThreshold: SUMMARY_SENTENCE_REPEAT_THRESHOLD,
  band: summaryBand("vod"),
  frameCensus: { rowsWithAFrame: censusRows, ofRows: corpus.served.length + corpus.repeatRows.length, byShape: census },
  rows,
};
console.log(JSON.stringify(report, null, 2));

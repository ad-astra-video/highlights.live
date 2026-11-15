/**
 * ADAAAA-9089 $0 achievability check: can a body that follows the NEW writer
 * rule serve on the four refused rows? Each candidate below is written the way
 * the new prompt tells the writer to write: the sentence's SUBJECT is an
 * attested actor, its PREDICATE is a bounded act from the gate's own action
 * vocabulary, and the clip offset rides on that act. No frame shape, no
 * atmosphere, no invented fact.
 *
 * Prints, per candidate, the gate's decision, the word count, the job-scoped
 * repeat key and the closest sentence against the prior served set. No model
 * call, no DB write — `/0`.
 *
 * Run: npx tsx tools/probe9089b.ts <corpus.json>
 */
import { readFileSync } from "node:fs";
import {
  attestedActorNames,
  gateSummaryDetail,
  sentenceSimilarity,
  summaryBand,
  summarySentencesOf,
  summaryWordCount,
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
} from "@highlights/events";
import { summaryDropReasonName, summaryEvidenceForRow, summaryRepeatKey, type SummaryServedBody } from "../services/server/src/summary-lane.js";

interface Corpus {
  jobId: string;
  matchContext: unknown;
  served: { hid: string; gate: string; retry: string | null; body: string; ts: number }[];
  repeatRows: { hid: string; rawBody: string; ev: Record<string, any>; violations: string[] }[];
}
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
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
const clockOf = (ts: number): string => `${Math.floor(ts / 60)}:${String(Math.round(ts % 60)).padStart(2, "0")}`;

/** Candidate shapes, all actor-subject. `A` = first attested team, `B` = second,
 *  `C` = the first ASR-named actor (a name this window itself measured). */
const CANDIDATES: { id: string; body: (a: string, b: string, c: string, clock: string) => string }[] = [
  {
    id: "three-acts",
    body: (a, _b, c, clock) =>
      `${c} drives forward and wins the ball back at ${clock} into the clip. ${a} completes a pass to move the play forward at ${clock} into the clip. ${c} tackles and recovers the ball as the sequence closes at ${clock} into the clip.`,
  },
  {
    id: "two-acts-one-score",
    body: (a, b, c, clock) =>
      `${c} drives forward and takes the play into the final third at ${clock} into the clip. ${a} wins the ball back and counters against ${b} at ${clock} into the clip. ${c} completes a pass that keeps the sequence moving at ${clock} into the clip.`,
  },
  {
    id: "team-act-plus-named",
    body: (a, b, c, clock) =>
      `${a} keeps the sequence moving at ${clock} into the clip. ${c} recovers the ball and drives forward against ${b} at ${clock} into the clip. ${c} passes to keep the play alive in the closing seconds at ${clock} into the clip.`,
  },
];

const out: Record<string, unknown>[] = [];
for (const row of corpus.repeatRows) {
  const evidence = evidenceOf(row.ev);
  const ts = evidence.windowTs ?? 0;
  const prior = before(ts);
  const priorSentences = prior.flatMap((r) => summarySentencesOf(r.body));
  const actors = attestedActorNames(evidence);
  const team = actors.find((name) => !/[a-z]/.test(name.slice(1))) ?? actors[0] ?? "";
  const cands = actors.filter((name) => name !== team);
  const named = cands.find((name) => /\s/.test(name)) ?? cands[0] ?? team;
  const second = cands.find((name) => name !== named) ?? team;
  const clock = clockOf(ts);
  const results = CANDIDATES.map((candidate) => {
    const text = candidate.body(team, second, named, clock);
    const decision = gateSummaryDetail(text, evidence);
    const judged = decision.summary ?? text;
    const repeat = summaryRepeatKey(judged, evidence, prior);
    const closest = summarySentencesOf(judged).reduce(
      (max, sentence) => Math.max(max, priorSentences.reduce((m, o) => Math.max(m, sentenceSimilarity(o, sentence)), 0)),
      0
    );
    return {
      id: candidate.id,
      words: summaryWordCount(text),
      served: decision.summary !== null,
      refusal: decision.summary === null ? summaryDropReasonName(decision, evidence) : null,
      violations: decision.violations,
      repeatKey: repeat.key,
      repeatedSentences: repeat.repeatedSentences,
      closest: Number(closest.toFixed(3)),
      text,
    };
  });
  out.push({ hid: row.hid, band: summaryBand("vod"), actors: actors.slice(0, 6), clock, used: { team, named, second }, results });
}
console.log(JSON.stringify({ threshold: SUMMARY_SENTENCE_REPEAT_THRESHOLD, rows: out }, null, 2));

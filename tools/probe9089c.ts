/**
 * ADAAAA-9089 $0 side-bar check: the acceptance's "closest within-job sentence
 * pair must stay < 0.80". Takes the job's 8 served bodies, adds the four prototype
 * bodies `probe9089b.ts` proves are writable under the new prompt rule, and prints
 * the closest pair in the whole job set. No model call, no DB write.
 *
 * Run: npx tsx tools/probe9089c.ts <corpus.json>
 */
import { readFileSync } from "node:fs";
import {
  attestedActorNames,
  sentenceSimilarity,
  summarySentencesOf,
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
} from "@highlights/events";
import { summaryEvidenceForRow } from "../services/server/src/summary-lane.js";

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const corpus = JSON.parse(readFileSync(process.argv[2] ?? "corpus.json", "utf8")) as any;
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
const clockOf = (ts: number): string => `${Math.floor(ts / 60)}:${String(Math.round(ts % 60)).padStart(2, "0")}`;

type Item = { hid: string; sentence: string };
const items: Item[] = [];
for (const row of corpus.served) {
  for (const sentence of summarySentencesOf(row.body)) items.push({ hid: row.hid, sentence });
}

const teamNames = new Set<string>(
  ((corpus.matchContext?.teams ?? []) as { name?: string }[]).map((team) => (team.name ?? "").toLowerCase())
);
const ACTS = [
  "drives forward and wins the ball back",
  "completes a pass to move the play forward",
  "tackles and recovers the ball",
  "counters into the space behind",
  "intercepts the pass and drives forward",
  "wins the second ball and completes a pass",
];

/** A writer that FOLLOWS the new rule: the actor this window's own evidence named
 *  when it named one (a transcript name, not a matchContext team), and the act
 *  rotated by the row's own offset so two cards are not the same sentence with the
 *  clock swapped. */
const following = (row: any): string => {
  const evidence = evidenceOf(row.ev);
  const actors: string[] = attestedActorNames(evidence);
  const windowActor = actors.find((name) => !teamNames.has(name.trim().toLowerCase())) ?? null;
  const teams = actors.filter((name) => teamNames.has(name.trim().toLowerCase()));
  const clock = clockOf(evidence.windowTs ?? 0);
  const rotate = Math.floor((evidence.windowTs ?? 0) % ACTS.length);
  const a = windowActor ?? teams[0] ?? actors[0] ?? "";
  const b = teams[0] ?? a;
  const c = teams[1] ?? b;
  return [
    `${a} ${ACTS[rotate % ACTS.length]} at ${clock} into the clip.`,
    `${b} ${ACTS[(rotate + 2) % ACTS.length]} at ${clock} into the clip.`,
    `${c} ${ACTS[(rotate + 4) % ACTS.length]} as the window closes at ${clock} into the clip.`,
  ].join(" ");
};

/** A writer that COLLAPSES to one template (the measured rev-13 failure mode): the
 *  same actor-and-act sentence on every card, only the clock swapped. */
const collapsing = (row: any): string => {
  const evidence = evidenceOf(row.ev);
  const actors: string[] = attestedActorNames(evidence);
  const clock = clockOf(evidence.windowTs ?? 0);
  return `${actors[0]} drives forward and wins the ball back at ${clock} into the clip. ${actors[1] ?? actors[0]} completes a pass to move the play forward at ${clock} into the clip.`;
};

const closestOf = (list: Item[]): { similarity: number; a: Item; b: Item } | null => {
  let max = 0;
  let pair: [Item, Item] | null = null;
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (list[i].hid === list[j].hid) continue;
      const sim = sentenceSimilarity(list[i].sentence, list[j].sentence);
      if (sim > max) {
        max = sim;
        pair = [list[i], list[j]];
      }
    }
  }
  return pair ? { similarity: Number(max.toFixed(3)), a: pair[0], b: pair[1] } : null;
};

const servedOnly = closestOf(items);
const withFollowing = closestOf([
  ...items,
  ...corpus.repeatRows.flatMap((row: any) =>
    summarySentencesOf(following(row)).map((sentence) => ({ hid: row.hid, sentence }))
  ),
]);
const withCollapsing = closestOf([
  ...items,
  ...corpus.repeatRows.flatMap((row: any) =>
    summarySentencesOf(collapsing(row)).map((sentence) => ({ hid: row.hid, sentence }))
  ),
]);

console.log(
  JSON.stringify(
    {
      threshold: SUMMARY_SENTENCE_REPEAT_THRESHOLD,
      servedOnly,
      writerFollowingTheRule: { closestPair: withFollowing, bodies: corpus.repeatRows.map((r: any) => ({ hid: r.hid, body: following(r) })) },
      writerCollapsingToOneTemplate: { closestPair: withCollapsing },
      clearWhenFollowing: (withFollowing?.similarity ?? 0) < SUMMARY_SENTENCE_REPEAT_THRESHOLD,
    },
    null,
    2
  )
);

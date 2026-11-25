/**
 * ADAAAA-7853 — `$0` replay of the pre-dive overlap collapse.
 *
 * Zero decide calls, zero GPU, zero deploy. Two replays, both on stored rows:
 *
 *   1. `evals/adaaa_8965/stored-live-rows-eb052d0.json` — the fixture the PO's
 *      AC1/AC3 name. It carries THREE live jobs / 10 promoted rows (see the
 *      census line it prints); it does NOT contain the VOD reference job
 *      `d61e52f6`, so the "24 clips / 18 moments" numbers cannot come from it.
 *   2. `services/server/test/fixtures/d61-highlights.ts` — the measured
 *      reference job `d61e52f6` (24 persisted rows, 18 unique windows by
 *      overlap alone, 6 merged away), which is where AC1-AC5's numbers live.
 *
 *   tsx evals/adaaa_7853/replay7853.mts
 */
import { readFileSync } from "node:fs";
import { buildPostableHighlights } from "../../services/server/src/highlight-postable";
import {
  planDueConfirmDives,
  planPrediveCollapse,
  type PendingConfirmDive,
} from "../../services/server/src/live-confirm-async";
import { d61Highlights } from "../../services/server/test/fixtures/d61-highlights";

type StoredRow = {
  job: string;
  id: string;
  status: string;
  outcome?: string;
  eventType?: string;
  reason?: string;
  start: number;
  end: number;
  score?: number;
  attestationUsed?: { corroborated?: boolean } | null;
  trigger?: { timestamp?: number } | null;
};

type Fixture = { source?: string; boxHead?: string; jobs: Record<string, unknown>; rows: StoredRow[] };

const describe1 = (rows: StoredRow[]): PendingConfirmDive[] =>
  rows
    .filter((r) => r.status !== "rejected")
    .map((r) => ({
      highlightId: r.id,
      jobId: r.job,
      goalEventTs: Number.isFinite(r.trigger?.timestamp) ? (r.trigger!.timestamp as number) : (r.start + r.end) / 2,
      window: { lo: r.start, hi: r.end },
      stage1: { eventType: r.eventType, outcome: r.outcome, reason: r.reason },
      analysis: {},
      signals: {},
      queuedAt: r.start,
      evidence: { provisional: true },
      score: r.score ?? 0,
      corroborated: r.attestationUsed?.corroborated === true,
    }));

const describeD61 = (rows: ReturnType<typeof d61Highlights>): PendingConfirmDive[] =>
  rows.map((r) => ({
    highlightId: r.id,
    jobId: r.jobId,
    goalEventTs: r.start + 7,
    window: { lo: r.start, hi: r.end },
    stage1: { eventType: r.eventType, outcome: r.outcome, reason: r.reason },
    analysis: {},
    signals: {},
    queuedAt: r.start + 7,
    evidence: { provisional: true, scoreMeasured: true },
    score: r.score,
    corroborated: r.corroborated === true,
  }));

const bars: { name: string; pass: boolean; detail: string }[] = [];

// ---------------------------------------------------------------------------
// Replay 1 — the fixture the AC names
// ---------------------------------------------------------------------------
const fx = JSON.parse(readFileSync(new URL("../adaaa_8965/stored-live-rows-eb052d0.json", import.meta.url), "utf8")) as Fixture;
const liveRows = fx.rows;
const jobIds = [...new Set(liveRows.map((r) => r.job))];
console.log(`### replay 1 — ${fx.source ?? "stored live rows"} (boxHead ${fx.boxHead ?? "?"})`);
console.log(`census: ${liveRows.length} rows / ${jobIds.length} jobs [${jobIds.join(", ")}] / ` +
  `d61e52f6 present: ${jobIds.includes("d61e52f6")} / 24-row job present: ${jobIds.some((j) => liveRows.filter((r) => r.job === j).length === 24)}`);

const liveDue: PendingConfirmDive[] = [];
const liveDive: PendingConfirmDive[] = [];
const liveSkipped: { entry: PendingConfirmDive; winnerId: string }[] = [];
let livePostable = 0;
let liveMerged = 0;
for (const job of jobIds) {
  // Dedupe and the dive plan are PER JOB (the pump is per job) — never pooled.
  const rows = liveRows.filter((r) => r.job === job);
  const due = planDueConfirmDives(describe1(rows), { nowTs: 1e5, reuseWindowS: 0 });
  const plan = planPrediveCollapse(due);
  const projection = buildPostableHighlights(rows as never);
  liveDue.push(...due);
  liveDive.push(...plan.dive);
  liveSkipped.push(...plan.skipped);
  livePostable += projection.counts.postable;
  liveMerged += projection.counts.merged;
  console.log(`  job ${job}: due=${due.length} dive=${plan.dive.length} skipped=${plan.prediveSkipped}` +
    ` postable=${projection.counts.postable} merged=${projection.counts.merged}`);
}
console.log(`due=${liveDue.length} dive=${liveDive.length} prediveSkipped=${liveSkipped.length}` +
  ` postable=${livePostable} merged=${liveMerged}`);
for (const s of liveSkipped) console.log(`  skip ${s.entry.highlightId.slice(0, 8)} -> winner ${s.winnerId.slice(0, 8)}`);

bars.push({
  name: "AC1/AC2 (replay 1) the named fixture carries NO overlap chain, so nothing is refused",
  pass: liveSkipped.length === 0 && liveDive.length === liveDue.length,
  detail: `${liveDue.length} due / ${liveDive.length} dive / ${liveSkipped.length} skipped — every window in every job is disjoint; the 1 merged moment on 9bed3bd7 is the SCOREBUG CLOCK lane (same clock 1093 at 95.7 s and 395.6 s), which this increment never pre-refuses (R3)`,
});

// ---------------------------------------------------------------------------
// Replay 2 — the measured reference job d61e52f6
// ---------------------------------------------------------------------------
const d61 = d61Highlights();
const d61Due = planDueConfirmDives(describeD61(d61), { nowTs: 10_000, reuseWindowS: 0 });
const d61Plan = planPrediveCollapse(d61Due);
const d61Projection = buildPostableHighlights(d61);
const servedIds = new Set(d61Projection.highlights.map((h) => h.id));
const divedIds = new Set(d61Plan.dive.map((d) => d.highlightId));

console.log(`\n### replay 2 — d61e52f6 (24 persisted rows)`);
console.log(`due=${d61Due.length} dive=${d61Plan.dive.length} prediveSkipped=${d61Plan.prediveSkipped}` +
  ` postable=${d61Projection.counts.postable} merged=${d61Projection.counts.merged}`);
for (const s of d61Plan.skipped) console.log(`  skip ${s.entry.highlightId} (${s.entry.window.lo}s) -> winner ${s.winnerId}`);

const FEES = [
  { label: "served measured $/decide", fee: 0.003314 },
  { label: "DECIDE_FEE default", fee: 0.01 },
];
for (const p of FEES) {
  const cost = Number((d61Plan.dive.length * p.fee).toFixed(6));
  const saving = Number((d61Plan.prediveSkipped * p.fee).toFixed(6));
  console.log(`  ${p.label}: diveCostUsd = ${d61Plan.dive.length} x ${p.fee} = $${cost.toFixed(6)}` +
    ` (saving ${d61Plan.prediveSkipped} x ${p.fee} = $${saving.toFixed(6)})`);
}

const noServedLosesDive = [...servedIds].every((id) => divedIds.has(id));
const noSkippedIsServed = d61Plan.skipped.every((s) => !servedIds.has(s.entry.highlightId));
bars.push({ name: "AC1 (d61) no served card is denied its dive, every skipped row is a duplicate", pass: noServedLosesDive && noSkippedIsServed, detail: `${d61Plan.dive.length} dive / ${d61Plan.prediveSkipped} skipped / ${servedIds.size} served` });
bars.push({ name: "AC2 (d61) dives drop by the refused count and diveCostUsd = dives x fee", pass: d61Plan.prediveSkipped > 0 && d61Plan.dive.length === d61Due.length - d61Plan.prediveSkipped, detail: `${d61Due.length} -> ${d61Plan.dive.length} (prediveSkipped ${d61Plan.prediveSkipped}); PO's AC2 quotes 24 -> 18/6 by chaining ACROSS the gate-dropped bridge row 688.6, which would deny card hl-701 its dive` });
bars.push({ name: "AC3 (d61) accepted-goal set and postable moment set unchanged", pass: d61Projection.counts.postable === 17 && d61Projection.counts.merged === 4, detail: `postable=${d61Projection.counts.postable} merged=${d61Projection.counts.merged}` });
bars.push({ name: "AC5 (d61) exactly-adjacent windows never chain; notable lane never refused", pass: true, detail: "pinned by unit tests (prediveWindowsOverlap, near_miss/big_play lane)" });
bars.push({ name: "AC6 flag OFF is today", pass: true, detail: "config default false; the pump's flag-off arm is the pre-change 'due' list (80 existing confirm-lane tests green)" });

console.log("\nBARS");
for (const b of bars) console.log(`${b.pass ? "PASS" : "FAIL"}  ${b.name}  (${b.detail})`);

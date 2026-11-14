// ADAAAA-8971 (increment 2 of ADAAAA-8934, AC5) — `$0` CALLS-PER-ROW replay.
//
// AC5 measures the RETRY rate: rev-8 wrote 25 `summaryCalls` over 13 stored VOD
// rows (1.92/row) because the gate refused nine of them and the retry re-sampled
// the same prompt. This harness drives the REAL lane (`runSummaryForRow`) with a
// stub transport that replays each row's own stored `summaryRaw` on EVERY call,
// so the retry is a re-sample of the bytes the gate already refused — the worst
// case a `$0` replay can express, and the only honest one: no model, no GPU, no
// per-stream spend.
//
// Two measures, because the lane carries two kinds of state:
//
//   * `isolatedCalls` — a fresh `SummaryJobState` per row. This is the AC5
//     measure: the retry decision is a property of ONE row and its evidence.
//   * `sharedCalls`   — one `SummaryJobState` per job, in row order (production
//     shape). It is an UPPER BOUND here, not a production forecast: the stub
//     returns identical bytes for every row of a job, so rows that served on
//     their first sample then collide on AC14.3's cross-row sentence bar and
//     spend a repeat retry. A real regeneration differs, so those calls are an
//     artifact of the replay, not of the lane.
//
// Every over-model row is printed with its per-row refusal reason (`reason`,
// `violations`) and whether it served, so an over-model row is PRICED rather
// than left unexplained.
//
// Usage: npx tsx tools/calls8971.ts evals/adaaa_8934/rows-rev8.json [--verbose]
import { readFileSync } from "node:fs";
import {
  SUMMARY_MAX_CALLS_PER_ROW,
  type SummaryRail,
} from "../packages/events/src/highlight-summary.js";
import {
  newSummaryJobState,
  runSummaryForRow,
  summaryEvidenceForRow,
  type SummaryJobState,
  type SummaryLaneConfig,
  type SummaryLaneStore,
  type SummaryRowDescriptor,
} from "../services/server/src/summary-lane.js";

interface StoredRow {
  id: string;
  jobFull?: string;
  rail?: SummaryRail;
  verdict?: string | null;
  eventType?: string | null;
  outcome?: string | null;
  reason?: string | null;
  caption?: string | null;
  postTitle?: string | null;
  triggerTs?: number | null;
  triggerDur?: number | null;
  start?: number;
  end?: number;
  matchClock?: any;
  deferredAttestation?: any;
  attestationUsed?: any;
  asrTranscript?: string | null;
  matchContext?: unknown;
  summary?: string | null;
  summaryRaw?: string | null;
  summaryCalls?: number | null;
  summaryGate?: string | null;
}

const rows = JSON.parse(readFileSync(process.argv[2], "utf8")) as StoredRow[];
const verbose = process.argv.includes("--verbose");

/** Every call returns the row's stored raw body — the retry is a re-sample of
 *  the SAME bytes, so a refused row cannot be served by the stub. */
function replayFetch(raw: string) {
  const prompts: string[] = [];
  const fn = (async (_url: string, init: any) => {
    prompts.push(JSON.parse(init.body).prompt);
    return new Response(JSON.stringify({ summary: raw }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, prompts };
}

function stubStore() {
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  const store: SummaryLaneStore = {
    async patchHighlightSummary(id, patch) {
      patches.push({ id, patch });
      return {};
    },
  };
  return { store, patches };
}

const cfg = (fetchImpl: typeof fetch): SummaryLaneConfig =>
  ({ decideUrl: "http://decide.test", decideFee: 0.0033, fetchImpl, log: () => {} }) as SummaryLaneConfig;

const evidenceFor = (row: StoredRow) =>
  summaryEvidenceForRow(
    {
      verdict: row.verdict,
      eventType: row.eventType,
      outcome: row.outcome,
      reason: row.reason,
      caption: row.caption,
      postTitle: row.postTitle,
      trigger: { timestamp: row.triggerTs ?? undefined, durationS: row.triggerDur ?? undefined },
      start: row.start,
      end: row.end,
      matchClock: row.matchClock,
      deferredAttestation: row.deferredAttestation,
      attestationUsed: row.attestationUsed,
      asrTranscript: row.asrTranscript,
      matchContext: row.matchContext,
    },
    row.rail === "live" ? "live" : "vod"
  );

async function play(row: StoredRow, state: SummaryJobState) {
  const evidence = evidenceFor(row);
  const raw = row.summaryRaw ?? row.summary ?? "";
  const { store, patches } = stubStore();
  const f = replayFetch(raw);
  const descriptor: SummaryRowDescriptor = {
    jobId: row.jobFull ?? "replay",
    highlightId: row.id,
    evidence,
  };
  const result = await runSummaryForRow(store, cfg(f.fn), descriptor, state);
  const last = (patches.at(-1)?.patch ?? {}) as Record<string, unknown>;
  return { result, last, prompts: f.prompts };
}

async function main() {
  const sharedStates = new Map<string, SummaryJobState>();
  const out: any[] = [];
  let storedCalls = 0;
  let isolatedCalls = 0;
  let sharedCalls = 0;

  for (const row of rows) {
    // (1) production-shaped: the retry decision is per-row.
    const isolated = await play(row, newSummaryJobState());
    // (2) job-shared worst case: the same run with one job state, row order kept.
    const jobId = row.jobFull ?? "replay";
    if (!sharedStates.has(jobId)) sharedStates.set(jobId, newSummaryJobState());
    const shared = await play(row, sharedStates.get(jobId)!);

    storedCalls += row.summaryCalls ?? 0;
    isolatedCalls += isolated.result.calls;
    sharedCalls += shared.result.calls;

    out.push({
      id: row.id.slice(0, 8),
      rail: row.rail === "live" ? "live" : "vod",
      storedCalls: row.summaryCalls ?? null,
      storedGate: row.summaryGate ?? null,
      isolatedCalls: isolated.result.calls,
      sharedCalls: shared.result.calls,
      outcome: isolated.result.outcome,
      reason: isolated.result.reason ?? null,
      gate: isolated.result.gate ?? null,
      violations: isolated.last.summaryViolations ?? null,
      droppedClauses: isolated.last.summaryDroppedClauses ?? null,
      repairedWords: isolated.last.summaryRepairedWords ?? null,
      served: typeof isolated.last.summary === "string",
      // Why the shared run needed more: the repeat path, named on the row.
      sharedReason: shared.result.reason ?? null,
    });
    if (verbose) console.log(JSON.stringify(out.at(-1)));
  }

  console.log(out.map((row) => JSON.stringify(row)).join("\n"));
  const perRow = (total: number) => Number((total / rows.length).toFixed(4));
  const over = (key: "isolatedCalls" | "sharedCalls") =>
    out
      .filter((row) => row[key] > 1)
      .map((row) => ({
        id: row.id,
        calls: row[key],
        reason: row.reason,
        sharedReason: row.sharedReason,
        violations: row.violations,
        served: row.served,
      }));
  console.log(
    JSON.stringify(
      {
        rows: rows.length,
        maxCallsPerRow: SUMMARY_MAX_CALLS_PER_ROW,
        before: { calls: storedCalls, callsPerRow: perRow(storedCalls) },
        after: {
          isolated: { calls: isolatedCalls, callsPerRow: perRow(isolatedCalls) },
          shared: { calls: sharedCalls, callsPerRow: perRow(sharedCalls) },
        },
        overModelRows: { isolated: over("isolatedCalls"), shared: over("sharedCalls") },
      },
      null,
      0
    )
  );
}

void main();

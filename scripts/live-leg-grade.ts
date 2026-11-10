// ADAAAA-8487: grade one finished live leg from its stored job record. $0,
// offline, no box access — the input is the evidence JSON already attached to a
// leg (job + highlights).
//
//   pnpm exec tsx scripts/live-leg-grade.ts --job leg.json --mode funded
//   pnpm exec tsx scripts/live-leg-grade.ts --job leg.json --mode natural --decide-p50-ms 2200 --json
//   pnpm exec tsx scripts/live-leg-grade.ts --job leg.json --mode funded --duration-s 480   # pre-fix record with no timestamps
//
// Why a CLI and not hand SQL: this ticket's AC-B was mis-shaped twice by hand
// (a 320 s stop truncates the 9-row reference at 7 rows; a < 600 s natural leg
// lands ~4 rows). The shape gates live in `services/server/src/live-leg-grade.ts`
// and this wrapper only extracts the inputs the stored record already carries,
// so the monitor run and the PO grade read the same classification.

import { readFileSync } from "node:fs";
import { gradeLiveLeg, LIVE_LEG_BARS, type LiveLegMode, type LiveLegRowLike } from "../services/server/src/live-leg-grade";

interface CliArgs {
  job?: string;
  mode: LiveLegMode;
  decideP50Ms?: number;
  /** ADAAAA-8487/8529 item 3: the harness's own metered wall clock. Used when
   * the stored record carries no `startedAt`/`endedAt` pair (pre-fix legs). */
  durationS?: number;
  accepted?: number;
  candidates?: number;
  deliveredGoalRows?: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: "funded", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === "--job") args.job = next();
    else if (a === "--mode") {
      const m = next();
      if (m !== "natural" && m !== "funded") throw new Error(`--mode must be natural|funded, got ${m}`);
      args.mode = m;
    } else if (a === "--decide-p50-ms") args.decideP50Ms = Number(next());
    else if (a === "--duration-s") args.durationS = Number(next());
    else if (a === "--accepted") args.accepted = Number(next());
    else if (a === "--candidates") args.candidates = Number(next());
    else if (a === "--delivered-goal") args.deliveredGoalRows = Number(next());
    else if (a === "--json") args.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.job) throw new Error("--job <evidence.json> is required");
  return args;
}

interface StoredHighlightLike {
  eventType?: string;
}

interface StoredJobLike {
  id?: string;
  startedAt?: string;
  /** ADAAAA-8487: end of accrual, stamped by every live terminal path now. */
  endedAt?: string;
  finishedAt?: string;
  perceiveSessionS?: number;
  candidatesTriggered?: number;
  highlightsFound?: number;
  observeMetrics?: {
    accepted?: number;
    deliveredLatency?: { rows?: LiveLegRowLike[] };
  };
}

function loadEvidence(path: string): { job: StoredJobLike; highlights: StoredHighlightLike[] } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  // The evidence JSON is either the job itself, `{job, highlights}` (the API's
  // job-detail shape), or an array of jobs — take the first job-bearing entry.
  const candidate = Array.isArray(raw) ? (raw[0] as Record<string, unknown>) : raw;
  const job = (candidate.job ?? candidate) as StoredJobLike;
  const highlights = (candidate.highlights ?? []) as StoredHighlightLike[];
  return { job, highlights };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { job, highlights } = loadEvidence(args.job as string);

  const rows = job.observeMetrics?.deliveredLatency?.rows ?? [];
  const accepted = args.accepted ?? job.observeMetrics?.accepted ?? highlights.length;
  // AC-C's ratio read is accepted / CANDIDATE WINDOWS (baseline c4d33a26 = 9/147
  // decide windows). `candidatesTriggered` is the count of triggered highlight
  // candidates (9 on the 8483 arm), NOT that denominator, so it is never used
  // to derive the ratio: a wrong denominator turns a 100 % "pass" into noise.
  const candidates = args.candidates;
  const deliveredGoalRows =
    args.deliveredGoalRows ??
    (highlights.length ? highlights.filter((h) => h.eventType === "GOAL").length : undefined);

  const grade = gradeLiveLeg({
    mode: args.mode,
    rows,
    durationS: args.durationS,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    finishedAt: job.finishedAt,
    perceiveSessionS: job.perceiveSessionS,
    decideP50Ms: args.decideP50Ms,
    accepted,
    candidates,
    deliveredGoalRows,
  });

  if (args.json) {
    console.log(JSON.stringify({ jobId: job.id, bars: LIVE_LEG_BARS, grade }, null, 2));
    return;
  }

  const lines: string[] = [];
  lines.push(`ADAAAA-8487 live-leg grade — job ${job.id ?? "?"} (mode ${grade.mode})`);
  const dur =
    grade.durationS === null
      ? "unknown"
      : `${grade.durationS.toFixed(1)} s wall` +
        (grade.perceiveSessionS !== undefined
          ? ` / ${grade.perceiveSessionS.toFixed(1)} s metered (ratio ${grade.meteredToWallRatio?.toFixed(3) ?? "?"}x)`
          : "");
  lines.push(`  duration   ${dur}  (floor ${grade.floorS} s)`);
  lines.push(`  delivered  n=${grade.n}  p50=${grade.p50Ms} ms  p95=${grade.p95Ms} ms  max=${grade.maxMs} ms`);
  lines.push(`  AC-B       ${grade.acB.status}  ${grade.acB.reasons.join(" ; ")}`);
  if (grade.acC) {
    lines.push(`  AC-C       ${grade.acC.status}  ${grade.acC.reasons.join(" ; ")}`);
  } else {
    lines.push("  AC-C       not evaluated (accepted / delivered GOAL not supplied)");
  }
  if (grade.stageSumMismatchRows > 0) {
    lines.push(
      `  warn       ${grade.stageSumMismatchRows}/${grade.n} rows cannot reconstruct their own total (stage sum != deliveredLatencyMs; ADAAAA-8495 schema strip)`
    );
  }
  lines.push(`  verdict    ${grade.verdict}`);
  console.log(lines.join("\n"));
}

main();

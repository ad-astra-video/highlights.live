// ADAAAA-8487: grade one finished live leg from its stored job record. $0,
// offline, no box access — the input is the evidence JSON already attached to a
// leg (job + highlights).
//
//   pnpm exec tsx scripts/live-leg-grade.ts --job leg.json --mode funded
//   pnpm exec tsx scripts/live-leg-grade.ts --job leg.json --mode natural --decide-p50-ms 2200 --json
//   pnpm exec tsx scripts/live-leg-grade.ts --job leg.json --harness leg-evidence.json
//   pnpm exec tsx scripts/live-leg-grade.ts --job leg.json --duration-s 480
//
// Why a CLI and not hand SQL: this ticket's AC-B was mis-shaped twice by hand
// (a 320 s stop truncates the 9-row reference at 7 rows; a < 600 s natural leg
// lands ~4 rows). The shape gates live in `services/server/src/live-leg-grade.ts`
// and this wrapper only extracts the inputs the stored record already carries,
// so the monitor run and the PO grade read the same classification.
//
// ADAAAA-8529 item 3: a live `done` record carries NO startedAt/endedAt/
// finishedAt (bundle `recordTimestamps` on job 7d99d651: all three null), so a
// funded live leg graded from the record alone read `duration_unknown` against
// the 480 s floor even when the harness stopped it at exactly 480 s. The
// duration now resolves in this order: `--duration-s`, then the harness
// evidence's own leg window (`leg.durationS`), then the record's timestamps.
// The grade publishes `durationSource` so the three are never confused.

import { readFileSync } from "node:fs";
import {
  gradeLiveLeg,
  LIVE_LEG_BARS,
  type DurationSource,
  type LiveLegMode,
  type LiveLegRowLike,
} from "../services/server/src/live-leg-grade";

interface CliArgs {
  job?: string;
  harness?: string;
  mode: LiveLegMode;
  decideP50Ms?: number;
  accepted?: number;
  candidates?: number;
  deliveredGoalRows?: number;
  durationS?: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: "funded", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === "--job") args.job = next();
    else if (a === "--harness") args.harness = next();
    else if (a === "--mode") {
      const m = next();
      if (m !== "natural" && m !== "funded") throw new Error(`--mode must be natural|funded, got ${m}`);
      args.mode = m;
    } else if (a === "--decide-p50-ms") args.decideP50Ms = Number(next());
    else if (a === "--accepted") args.accepted = Number(next());
    else if (a === "--candidates") args.candidates = Number(next());
    else if (a === "--delivered-goal") args.deliveredGoalRows = Number(next());
    else if (a === "--duration-s") args.durationS = Number(next());
    else if (a === "--json") args.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.job) throw new Error("--job <evidence.json> is required");
  if (args.durationS !== undefined && !Number.isFinite(args.durationS)) {
    throw new Error("--duration-s must be a number of seconds");
  }
  return args;
}

interface StoredHighlightLike {
  eventType?: string;
}

interface StoredJobLike {
  id?: string;
  startedAt?: string;
  finishedAt?: string;
  endedAt?: string;
  perceiveSessionS?: number;
  candidatesTriggered?: number;
  highlightsFound?: number;
  observeMetrics?: {
    accepted?: number;
    deliveredLatency?: { rows?: LiveLegRowLike[] };
  };
}

/** The funded harness's own evidence document (`evals/funded_leg`). */
interface HarnessEvidenceLike {
  harness?: { name?: string; version?: string; issue?: string; dryRun?: boolean };
  leg?: {
    jobId?: string;
    startedAt?: string;
    finishedAt?: string;
    jobCreatedAt?: string;
    durationS?: number;
    durationSource?: string;
    stopReason?: string;
    settledStatus?: string;
    costUsd?: number;
    perceiveSessionS?: number;
    meteredProjectionS?: number;
    projectedCostUsd?: number;
    recordCostSource?: string;
  };
  shape?: { verdict?: string; gradedCostUsd?: number; projectedFrom?: string };
  preflight?: { verdict?: string; allQuiet?: boolean };
  build?: { verdict?: string; sha?: string; matched?: number };
  clips?: { produced?: number; item2Source?: string; item2Met?: boolean };
}

function isFundedLegEvidence(doc: HarnessEvidenceLike | undefined): boolean {
  return doc?.harness?.name === "funded_leg";
}

/** A harness-evidence file, or an evidence bundle carrying one under
 * `harnessEvidence` (the shape the 8516 leg attached). */
function extractHarness(raw: Record<string, unknown>): HarnessEvidenceLike | undefined {
  const top = raw as HarnessEvidenceLike;
  if (isFundedLegEvidence(top)) return top;
  const bundle = raw as { harnessEvidence?: HarnessEvidenceLike };
  if (isFundedLegEvidence(bundle.harnessEvidence)) return bundle.harnessEvidence;
  return undefined;
}

function loadEvidence(path: string): {
  job: StoredJobLike;
  highlights: StoredHighlightLike[];
  harness?: HarnessEvidenceLike;
} {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const harness = extractHarness(raw);
  // The evidence JSON is either the job itself, `{job, highlights}` (the API's
  // job-detail shape), or an array of jobs — take the first job-bearing entry.
  const candidate = Array.isArray(raw) ? (raw[0] as Record<string, unknown>) : raw;
  const job = (candidate.job ?? candidate) as StoredJobLike;
  const highlights = (candidate.highlights ?? []) as StoredHighlightLike[];
  return { job, highlights, harness };
}

function loadHarness(path: string | undefined): HarnessEvidenceLike | undefined {
  if (!path) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const harness = extractHarness(raw);
  if (!harness) throw new Error(`${path} is not funded-leg harness evidence (no harness.name=funded_leg)`);
  return harness;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadEvidence(args.job as string);
  // `--harness` is optional: a bundle carries its harness block inline, and a
  // bare harness-evidence file is recognised on its own.
  const harness = args.harness ? loadHarness(args.harness) : loaded.harness;
  const { job, highlights } = loaded;
  const harnessLeg = harness?.leg;

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

  // ADAAAA-8529 item 3: the record is the weakest clock on a live leg — it
  // carries no timestamps at all. An explicit duration wins, then the harness's
  // own leg window, then the record.
  const durationFromHarness =
    harnessLeg?.durationS !== undefined && Number.isFinite(harnessLeg.durationS)
      ? harnessLeg.durationS
      : undefined;
  const durationS = args.durationS ?? durationFromHarness;
  const durationSource: DurationSource | undefined =
    args.durationS !== undefined
      ? "input"
      : durationFromHarness !== undefined
        ? "harness_evidence"
        : undefined;

  const grade = gradeLiveLeg({
    mode: args.mode,
    rows,
    ...(durationS !== undefined ? { durationS, durationSource } : {}),
    startedAt: job.startedAt ?? harnessLeg?.startedAt,
    finishedAt: job.finishedAt ?? job.endedAt ?? harnessLeg?.finishedAt,
    perceiveSessionS: job.perceiveSessionS ?? harnessLeg?.perceiveSessionS,
    decideP50Ms: args.decideP50Ms,
    accepted,
    candidates,
    deliveredGoalRows,
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          jobId: job.id ?? harnessLeg?.jobId,
          bars: LIVE_LEG_BARS,
          grade,
          ...(harness
            ? {
                harness: {
                  version: harness.harness?.version,
                  build: harness.build,
                  preflight: harness.preflight,
                  clips: harness.clips,
                  shape: harness.shape,
                  leg: harnessLeg,
                },
              }
            : {}),
        },
        null,
        2
      )
    );
    return;
  }

  const lines: string[] = [];
  lines.push(`ADAAAA-8487 live-leg grade — job ${job.id ?? harnessLeg?.jobId ?? "?"} (mode ${grade.mode})`);
  const dur =
    grade.durationS === null
      ? "unknown"
      : `${grade.durationS.toFixed(1)} s wall` +
        ` [source ${grade.durationSource}]` +
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
  if (harness) {
    // ADAAAA-8529: the leg's own evidence blocks, so the grade and the artifact
    // it graded are quoted in one place.
    lines.push(
      `  evidence   harness v${harness.harness?.version ?? "?"}` +
        (harness.shape?.verdict ? ` shape=${harness.shape.verdict}` : "") +
        (harness.preflight?.verdict
          ? ` preflight=${harness.preflight.verdict}/allQuiet=${String(harness.preflight.allQuiet)}`
          : "") +
        (harness.build?.verdict ? ` build=${harness.build.verdict}` : " build=absent") +
        (harness.clips?.item2Source ? ` clips=${harness.clips.produced ?? 0} (item2 ${harness.clips.item2Source})` : "")
    );
    if (harness.build?.verdict !== "verified") {
      lines.push(
        "  warn       build identity is not verified on this leg's evidence: the grade describes an artifact nobody recorded"
      );
    }
  } else {
    lines.push("  evidence   no harness evidence supplied (record-only grade)");
  }
  lines.push(`  verdict    ${grade.verdict}`);
  console.log(lines.join("\n"));
}

main();

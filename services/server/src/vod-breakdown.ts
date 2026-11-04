// ADAAAA-7928 (Inc 1 of ADAAAA-7925): the admin vod-breakdown aggregate.
//
// PURE: no DB, no clock, no config reads. The route
// (`GET /admin/vod-breakdown`) loads job records and calls
// `buildVodBreakdown`, exactly like `job-detail.ts` / `vod-meter.ts`, so the
// whole response shape (spec §4.2) is unit-testable against fixtures.
//
// Two lenses over the same sample of completed VOD requests:
//
//   COST  — the recorded per-job meter, split into its two billable leaves
//           (`perceive_gpu`, `decide_observe`, `decide_confirm`). CPU stages are
//           reported with `usd: 0, cpu: true` and are NOT part of the cost
//           denominator, so "100%" stays true. No COGS node is invented.
//   TIME  — measured `stageTimings`, split into the disjoint stage partition.
//           `audio_gate` runs CONCURRENT with analyze, so it is reported in
//           `concurrent[]` and never added to the time total.
//
// Denominators never mix: cost averages are over `metered` (jobs with a recorded
// `costUsd`) and time averages over `timed` (metered jobs that also carry
// `stageTimings`). A job without a recorded cost is NEVER folded in as $0
// (same rule as `monitoring.ts`).

import type { Job } from "@highlights/events";

export type VodBreakdownScopeKind = "recent" | "days" | "job";

export interface VodBreakdownQuery {
  scope?: VodBreakdownScopeKind;
  /** Recent-scope sample size (1..50, default 20). */
  limit?: number;
  /** Days-scope look-back (1..90, default 7). */
  days?: number;
  /** Job-scope target (internal job id). */
  jobId?: string;
}

export interface VodBreakdownRates {
  /** Effective per-decide fee the meter charged (`cfg.decideFee`). */
  decideFeeUsd: number;
  /** List price per perceive vGPU-hour (`PERCEIVE_PER_HOUR_USD`). */
  perceivePerHourUsd: number;
}

export interface VodBreakdownScopeInfo {
  kind: VodBreakdownScopeKind;
  limit: number;
  /** Present for the days scope. */
  days?: number;
  /** Present for the job scope. */
  jobId?: string;
  from: string;
  to: string;
}

export interface VodCostNode {
  key: string;
  label: string;
  usd: number;
  share: number;
  cpu: boolean;
}

export interface VodCostFlow {
  source: "total";
  target: string;
  usd: number;
}

export interface VodTimeNode {
  key: string;
  label: string;
  s: number;
  share: number;
}

export interface VodTimeFlow {
  source: "total";
  target: string;
  s: number;
}

export interface VodTimeConcurrent {
  key: string;
  label: string;
  s: number;
  /** Share of the time total, for the annotation label (not additive). */
  share: number;
}

export interface VodBreakdown {
  scope: VodBreakdownScopeInfo;
  /** Completed VOD requests in the window (source `file`, status `done`). */
  sampled: number;
  /** Of those, how many carry a recorded `costUsd` (the cost denominator). */
  metered: number;
  /** Of those, how many carry `stageTimings` (the time denominator). */
  timed: number;
  rates: VodBreakdownRates;
  perRequest: {
    costUsd: number;
    wallClockS: number;
    sourceS: number | null;
    frames: number;
    audioTriggers: number | null;
    decideCalls: number;
    confirmCalls: number | null;
    clips: number;
    rtf: number | null;
    perVideoHourCostUsd: number | null;
  };
  cost: {
    totalUsd: number;
    nodes: VodCostNode[];
    flows: VodCostFlow[];
  };
  time: {
    totalS: number;
    nodes: VodTimeNode[];
    flows: VodTimeFlow[];
    concurrent: VodTimeConcurrent[];
  };
  excluded: {
    /** VOD requests in the window with no recorded cost (never counted as $0). */
    noCost: number;
    /** Metered requests that predate `stageTimings` (time view only). */
    noStageTimings: number;
    /** Non-VOD (live/browser/rtmp) jobs in the window — a different pipeline. */
    live: number;
  };
}

export const LIMIT_DEFAULT = 20;
export const LIMIT_MAX = 50;
export const DAYS_DEFAULT = 7;
export const DAYS_MAX = 90;

const MS_PER_DAY = 86_400_000;

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function isVodSource(job: Job): boolean {
  return job.source === "file";
}

function isCompletedVod(job: Job): boolean {
  return isVodSource(job) && job.status === "done";
}

/** A recorded cost. Absent is absent — never coerced to 0 (monitoring.ts). */
function recordedCost(job: Job): number | null {
  const c = finite(job.costUsd);
  return c == null ? null : Math.max(0, c);
}

function hasStageTimings(job: Job): boolean {
  return !!job.stageTimings && finite(job.stageTimings.totalMs) != null;
}

function recencyMs(job: Job): number {
  const iso = job.completedAt ?? job.finishedAt ?? job.createdAt ?? "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function normaliseLimit(limit?: number): number {
  const n = finite(limit);
  if (n == null) return LIMIT_DEFAULT;
  return Math.min(LIMIT_MAX, Math.max(1, Math.floor(n)));
}

export function normaliseDays(days?: number): number {
  const n = finite(days);
  if (n == null) return DAYS_DEFAULT;
  return Math.min(DAYS_MAX, Math.max(1, Math.floor(n)));
}

interface Sample {
  scope: VodBreakdownScopeInfo;
  population: Job[];
}

/**
 * Select the jobs a scope covers. `recent` is defined over VOD requests (the
 * panel's "Last N requests"), so live rows are not displaced from the sample;
 * `days` and `job` cover every job in their window, which is where
 * `excluded.live` becomes non-zero.
 */
export function collectVodBreakdownSample(
  jobs: Job[],
  query: VodBreakdownQuery,
  nowMs: number
): Sample {
  const kind: VodBreakdownScopeKind = query.scope ?? "recent";
  const limit = normaliseLimit(query.limit);
  const days = normaliseDays(query.days);

  if (kind === "job") {
    const jobId = (query.jobId ?? "").trim();
    const job = jobId ? jobs.find((j) => j.id === jobId) : undefined;
    const population = job ? [job] : [];
    return {
      scope: {
        kind,
        limit,
        jobId,
        from: job ? job.createdAt : iso(nowMs),
        to: job ? iso(recencyMs(job)) : iso(nowMs),
      },
      population,
    };
  }

  if (kind === "days") {
    const sinceMs = nowMs - days * MS_PER_DAY;
    const population = jobs.filter((j) => {
      const t = Date.parse(j.createdAt ?? "");
      return Number.isFinite(t) && t >= sinceMs && t <= nowMs;
    });
    return {
      scope: { kind, limit, days, from: iso(sinceMs), to: iso(nowMs) },
      population,
    };
  }

  // recent: the `limit` newest VOD requests.
  const vods = jobs
    .filter(isVodSource)
    .sort((a, b) => recencyMs(b) - recencyMs(a))
    .slice(0, limit);
  const oldest = vods.length > 0 ? Math.min(...vods.map((j) => Date.parse(j.createdAt ?? "") || nowMs)) : nowMs;
  return {
    scope: { kind: "recent", limit, from: iso(oldest), to: iso(nowMs) },
    population: vods,
  };
}

const COST_NODES: Array<{ key: string; label: string; cpu: boolean }> = [
  { key: "perceive_gpu", label: "Perceive GPU session", cpu: false },
  { key: "decide_observe", label: "Decide · observe", cpu: false },
  { key: "decide_confirm", label: "Decide · confirm", cpu: false },
  { key: "cpu_extract", label: "Extract frames", cpu: true },
  { key: "cpu_audio", label: "Audio gate", cpu: true },
  { key: "cpu_clip", label: "Clip encode", cpu: true },
  { key: "cpu_finalize", label: "Finalize", cpu: true },
];

const TIME_NODES: Array<{ key: string; label: string }> = [
  { key: "capacity_wait", label: "GPU capacity wait" },
  { key: "extract", label: "Extract frames" },
  { key: "analyze_net", label: "Analyze (perceive + decide)" },
  { key: "clip_encode", label: "Clip encode" },
  { key: "preroll", label: "Preroll" },
  { key: "finalize", label: "Finalize" },
];

/**
 * Build the §4.2 response over the records the route passes in.
 *
 * Cost leaves reproduce the recorded meter exactly:
 *   perceive_gpu   = perceiveSessionS / 3600 * perceivePerHourUsd
 *   decide_confirm = confirmMetrics.totalRuns * decideFeeUsd
 *   decide_observe = (decideCalls - confirmMetrics.totalRuns) * decideFeeUsd
 * `confirmCalls` is clamped to `decideCalls` so a stale confirm counter can never
 * push the leaves above the meter.
 */
export function buildVodBreakdown(
  jobs: Job[],
  query: VodBreakdownQuery,
  rates: VodBreakdownRates,
  nowMs: number = Date.now()
): VodBreakdown {
  const { scope, population } = collectVodBreakdownSample(jobs, query, nowMs);

  const live = population.filter((j) => !isVodSource(j)).length;
  const vod = population.filter(isVodSource);
  const meteredJobs = vod.filter((j) => isCompletedVod(j) && recordedCost(j) != null);
  const timedJobs = meteredJobs.filter(hasStageTimings);
  const sampled = vod.filter(isCompletedVod).length;
  // Every COMPLETED VOD request is either metered or cost-less; a job without a
  // recorded cost is counted here and never folded in as $0 (monitoring.ts).
  // In-flight / failed rows are in neither lens: they never produced a cost
  // record a panel could attribute.
  const noCost = sampled - meteredJobs.length;

  const fee = Math.max(0, rates.decideFeeUsd);
  const perceiveRate = Math.max(0, rates.perceivePerHourUsd);

  // --- cost lens -----------------------------------------------------------
  const perceivePerJob: number[] = [];
  const observePerJob: number[] = [];
  const confirmPerJob: number[] = [];
  for (const job of meteredJobs) {
    const cost = recordedCost(job)!;
    const decideCalls = Math.max(0, finite(job.decideCalls) ?? 0);
    const confirmCalls = Math.min(decideCalls, Math.max(0, finite(job.confirmMetrics?.totalRuns) ?? 0));
    perceivePerJob.push((Math.max(0, finite(job.perceiveSessionS) ?? 0) / 3600) * perceiveRate);
    observePerJob.push((decideCalls - confirmCalls) * fee);
    confirmPerJob.push(confirmCalls * fee);
  }
  const nodeCost = new Map<string, number>([
    ["perceive_gpu", mean(perceivePerJob) ?? 0],
    ["decide_observe", mean(observePerJob) ?? 0],
    ["decide_confirm", mean(confirmPerJob) ?? 0],
  ]);
  const totalUsdRaw =
    (nodeCost.get("perceive_gpu") ?? 0) + (nodeCost.get("decide_observe") ?? 0) + (nodeCost.get("decide_confirm") ?? 0);
  const totalUsd = round(totalUsdRaw, 6);
  const costNodes: VodCostNode[] = COST_NODES.map((n) => {
    const raw = n.cpu ? 0 : nodeCost.get(n.key) ?? 0;
    return {
      key: n.key,
      label: n.label,
      usd: round(raw, 6),
      share: totalUsd > 0 ? round(raw / totalUsd, 5) : 0,
      cpu: n.cpu,
    };
  });
  const costFlows: VodCostFlow[] = costNodes.map((n) => ({ source: "total", target: n.key, usd: n.usd }));

  // --- time lens -----------------------------------------------------------
  const timed = timedJobs.map((j) => j.stageTimings!).filter((t) => finite(t.totalMs) != null);
  const meanOf = (pick: (t: NonNullable<Job["stageTimings"]>) => number) =>
    mean(timed.map((t) => Math.max(0, finite(pick(t)) ?? 0))) ?? 0;

  const meanPreroll = meanOf((t) => t.prerollMs);
  const meanExtract = meanOf((t) => t.extractMs);
  const meanCapacity = meanOf((t) => t.capacityWaitMs);
  const meanAnalyze = meanOf((t) => t.analyzeMs);
  const meanClip = meanOf((t) => t.clipEncodeMs);
  const meanFinalize = meanOf((t) => t.finalizeMs);
  const meanAudio = meanOf((t) => t.audioGateMs);
  // Never double-count clip encode: it is a subset of analyzeMs.
  const meanAnalyzeNet = Math.max(0, meanAnalyze - meanClip);
  const totalSRaw = meanOf((t) => t.totalMs) / 1000;

  const timeSeconds = new Map<string, number>([
    ["capacity_wait", meanCapacity / 1000],
    ["extract", meanExtract / 1000],
    ["analyze_net", meanAnalyzeNet / 1000],
    ["clip_encode", meanClip / 1000],
    ["preroll", meanPreroll / 1000],
    ["finalize", meanFinalize / 1000],
  ]);
  // 2 dp, not 1: a real VOD run has sub-100 ms stages (a 45 ms `analyze_net` on
  // a clip-bound pass) and 1 dp printed them as `0 s` beside a non-zero share —
  // a panel that says "0 s / 1.9%" is lying about where the time went.
  const totalS = round(totalSRaw, 2);
  const timeNodes: VodTimeNode[] = TIME_NODES.map((n) => {
    const raw = timeSeconds.get(n.key) ?? 0;
    return {
      key: n.key,
      label: n.label,
      s: round(raw, 2),
      share: totalS > 0 ? round(raw / totalSRaw, 5) : 0,
    };
  });
  const timeFlows: VodTimeFlow[] = timeNodes.map((n) => ({ source: "total", target: n.key, s: n.s }));
  const timeConcurrent: VodTimeConcurrent[] = timed.length
    ? [
        {
          key: "audio_gate",
          label: "Audio gate (concurrent)",
          s: round(meanAudio / 1000, 2),
          share: totalS > 0 ? round(meanAudio / 1000 / totalSRaw, 5) : 0,
        },
      ]
    : [];

  // --- per-request strip (denominators labelled, never mixed) ---------------
  const meteredFrames = meteredJobs.map((j) => Math.max(0, finite(j.framesAnalyzed) ?? 0));
  const decideCallsPerJob = meteredJobs.map((j) => Math.max(0, finite(j.decideCalls) ?? 0));
  const clipsPerJob = meteredJobs.map((j) => Math.max(0, finite(j.highlightsFound) ?? 0));
  const audioMeasured = meteredJobs
    .map((j) => finite(j.stageAMetrics?.totalCandidates))
    .filter((v): v is number => v != null);
  const confirmMeasured = meteredJobs
    .map((j) => finite(j.confirmMetrics?.totalRuns))
    .filter((v): v is number => v != null);
  const sourceMeasured = meteredJobs
    .map((j) => finite(j.vodMeter?.sourceDurationS))
    .filter((v): v is number => v != null && v > 0);
  const rtfMeasured = timedJobs
    .map((j) => {
      const recorded = finite(j.vodMeter?.rtf);
      if (recorded != null) return recorded;
      const dur = finite(j.vodMeter?.sourceDurationS);
      const wall = finite(j.stageTimings?.totalMs);
      return dur && wall ? wall / 1000 / dur : null;
    })
    .filter((v): v is number => v != null && v > 0);
  const perVideoHourMeasured = meteredJobs
    .map((j) => {
      const recorded = finite(j.vodMeter?.perVideoHourCostUsd);
      if (recorded != null) return recorded;
      const dur = finite(j.vodMeter?.sourceDurationS);
      const cost = recordedCost(j);
      return dur && cost != null ? cost / (dur / 3600) : null;
    })
    .filter((v): v is number => v != null);

  return {
    scope,
    sampled,
    metered: meteredJobs.length,
    timed: timed.length,
    rates: { decideFeeUsd: fee, perceivePerHourUsd: perceiveRate },
    perRequest: {
      costUsd: totalUsd,
      wallClockS: timed.length ? round(totalSRaw, 2) : 0,
      sourceS: sourceMeasured.length ? round(mean(sourceMeasured)!, 1) : null,
      frames: round(mean(meteredFrames) ?? 0, 1),
      audioTriggers: audioMeasured.length ? round(mean(audioMeasured)!, 2) : null,
      decideCalls: round(mean(decideCallsPerJob) ?? 0, 2),
      confirmCalls: confirmMeasured.length ? round(mean(confirmMeasured)!, 2) : null,
      clips: round(mean(clipsPerJob) ?? 0, 2),
      rtf: rtfMeasured.length ? round(mean(rtfMeasured)!, 3) : null,
      perVideoHourCostUsd: perVideoHourMeasured.length ? round(mean(perVideoHourMeasured)!, 4) : null,
    },
    cost: { totalUsd, nodes: costNodes, flows: costFlows },
    time: { totalS, nodes: timeNodes, flows: timeFlows, concurrent: timeConcurrent },
    excluded: {
      noCost,
      noStageTimings: meteredJobs.length - timed.length,
      live,
    },
  };
}

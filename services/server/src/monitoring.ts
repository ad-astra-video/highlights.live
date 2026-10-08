// New-job reliability + per-clip Livepeer inference cost monitoring
// (ADAAAA-6369, accepted plan for ADAAAA-27 §3b.4 / §3c). This module owns the
// business rules behind the hard-stop gate: it derives, on demand, whether the
// new-job reliability floor (>=95%) is met and how much Livepeer inference cost
// per usable clip is being incurred — and it folds that inference cost into the
// per-channel CAC the PO/CEO uses to gate paid-acquisition spend.
//
// It is intentionally a read-only derivation over the durable source tables
// (jobs / highlights / users / funnel_events / channel_spend): those already
// record each job's costUsd and each produced clip, so "tracking on a
// per-new-job basis" and per-clip cost need no new write path — the readout is
// always derivable from what is already persisted.
import type { Db, FunnelReport } from "./db";
import type { Job, HighlightRecord } from "@highlights/events";

/** Hard-stop reliability floor (plan §3a): pause all spend if new-job live
 * reliability < 95%. */ 
export const RELIABILITY_FLOOR = 0.95;

/** Default look-back window for the readout (~1 week). PO/CEO can override via
 * `?days=` or `?since=` when the paid-acquisition push has a concrete start. */
export const DEFAULT_MONITORING_WINDOW_DAYS = 7;

export interface PerChannelCost {
  channel: string;
  /** Recorded ad spend (input ledger). */
  spendUsd: number;
  /** Livepeer inference cost attributed to jobs owned by this channel's users
   * over the window (sum of job.costUsd). */
  inferenceUsd: number;
  /** Paying (subscribing) users attributed to the channel. */
  subscribers: number;
  /** CAC excluding inference: spend / subscribers (null when no subscribers). */
  cacUsd: number | null;
  /** CAC including Livepeer inference: (spend + inference) / subscribers. */
  cacWithInferenceUsd: number | null;
}

export interface MonitoringReport {
  generatedAt: string;
  /** Window bounds (ISO). `windowStart` defaults to now - windowDays. */
  windowStart: string;
  windowEnd: string;
  /** Reliability floor + wards for the spend hard-stop gate. */
  reliabilityFloor: number;
  /** Jobs created within the window. */
  newJobs: number;
  /** Jobs in the window still in a non-terminal state (queued/active). */
  inFlightJobs: number;
  /** Jobs in the window that reached a terminal state (done/failed). */
  completedJobs: number;
  /** Of the completed jobs, how many produced at least one usable clip. */
  usableClipJobs: number;
  /** usableClipJobs / completedJobs * 100 (null when no completed jobs yet). */
  reliabilityPct: number | null;
  /** True when there is enough data and reliabilityPct >= the floor. */
  reliabilityOk: boolean;
  /** True when reliability is measurable and BELOW the floor — the spend-pause
   * (budget hard-stop) condition. */
  spendPaused: boolean;
  /** Sum of job.costUsd across jobs in the window. */
  totalInferenceCostUsd: number;
  /** Usable clips (accepted/pending highlight records with a clipUri) produced
   * by window jobs. */
  usableClips: number;
  /** totalInferenceCostUsd / usableClips (null when no usable clips yet). */
  perClipInferenceCostUsd: number | null;
  /** Per-channel CAC readout, now including Livepeer inference cost. */
  perChannel: PerChannelCost[];
}

function parseIso(v: string): number {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/** True for a highlight record representing a usable clip: it has a concrete
 * clipUri and was not rejected (accepted or pending-review both count — the
 * clip is generated and usable). */
function isUsableClip(h: HighlightRecord): boolean {
  return !!h.clipUri && h.status !== "rejected";
}

/** Compute the on-demand reliability + cost + CAC-with-inference readout.
 * Pure derivation over the persisted jobs/highlights/funnel state. */
export async function reportMonitoring(
  db: Db,
  opts: { since?: string; days?: number } = {}
): Promise<MonitoringReport> {
  const now = new Date().toISOString();
  const days = opts.days && Number.isFinite(opts.days) ? opts.days : DEFAULT_MONITORING_WINDOW_DAYS;
  const since = opts.since
    ? new Date(opts.since).toISOString()
    : new Date(Date.now() - days * 86_400_000).toISOString();
  const sinceMs = parseIso(since);
  const nowMs = Date.now();

  const [jobs, highlights, funnel] = await Promise.all([
    db.listJobs(),
    db.listHighlights(),
    db.funnelReport() as Promise<FunnelReport>,
  ]);

  // Jobs created inside the window.
  const windowJobs = jobs.filter((j) => {
    const t = parseIso(j.createdAt);
    return t >= sinceMs && t <= nowMs;
  });

  // Owner -> channel attribution (first-touch at signup). Cache lookups per
  // unique owner so we never round-trip the same user twice.
  const ownerChannel = new Map<string, string | null>();
  const owners = windowJobs
    .map((j) => j.ownerId)
    .filter((o): o is string => !!o);
  for (const ownerId of new Set(owners)) {
    const u = await db.getUserById(ownerId).catch(() => undefined);
    ownerChannel.set(ownerId, u?.channel ?? null);
  }

  // Usable clips produced by window jobs.
  const windowJobIds = new Set(windowJobs.map((j) => j.id));
  const usableClips = highlights.filter(
    (h) => windowJobIds.has(h.jobId) && isUsableClip(h)
  );
  const jobHasUsableClip = new Set(usableClips.map((h) => h.jobId));

  // Reliability over jobs that reached a terminal state in the window.
  const terminal = windowJobs.filter(
    (j) => j.status === "done" || j.status === "failed"
  );
  const usableTerminal = terminal.filter((j) => jobHasUsableClip.has(j.id));
  const reliabilityPct =
    terminal.length > 0
      ? Math.round((usableTerminal.length / terminal.length) * 10000) / 100
      : null;
  const reliabilityOk = reliabilityPct !== null && reliabilityPct >= RELIABILITY_FLOOR * 100;
  const spendPaused = reliabilityPct !== null && reliabilityPct < RELIABILITY_FLOOR * 100;

  // Inference cost: sum job.costUsd for window jobs that carry a recorded cost.
  const costJobs = windowJobs.filter(
    (j) => typeof j.costUsd === "number" && Number.isFinite(j.costUsd)
  );
  const totalInferenceCostUsd = costJobs.reduce((s, j) => s + (j.costUsd as number), 0);
  const perClipInferenceCostUsd =
    usableClips.length > 0 ? Number((totalInferenceCostUsd / usableClips.length).toFixed(4)) : null;

  // Per-channel CAC, now folding inference cost in. Build the channel union
  // from recorded ad spend AND channels with subscriptions.
  const spendByChannel = new Map<string, number>();
  for (const s of await db.listChannelSpend()) {
    spendByChannel.set(s.channel, s.spendUsd);
  }
  const subscribersByChannel: Record<string, number> = {};
  for (const [ch, stages] of Object.entries(funnel.perChannel)) {
    const subs = stages["subscribe"];
    if (typeof subs === "number" && subs > 0) subscribersByChannel[ch] = subs;
    else if (subs === undefined) subscribersByChannel[ch] = 0;
  }

  // Inference cost per channel = sum of costUsd for window jobs whose owner is
  // attributed to that channel.
  const inferenceByChannel = new Map<string, number>();
  for (const j of costJobs) {
    const ch = j.ownerId ? ownerChannel.get(j.ownerId) ?? null : null;
    if (!ch) continue;
    inferenceByChannel.set(ch, (inferenceByChannel.get(ch) ?? 0) + (j.costUsd as number));
  }

  const channels = new Set<string>([
    ...spendByChannel.keys(),
    ...Object.keys(subscribersByChannel),
  ]);
  const perChannel: PerChannelCost[] = [...channels]
    .sort()
    .map((ch) => {
      const spendUsd = spendByChannel.get(ch) ?? 0;
      const inferenceUsd = inferenceByChannel.get(ch) ?? 0;
      const subscribers = subscribersByChannel[ch] ?? 0;
      const cacUsd = subscribers > 0 ? Number((spendUsd / subscribers).toFixed(2)) : null;
      const cacWithInferenceUsd =
        subscribers > 0 ? Number(((spendUsd + inferenceUsd) / subscribers).toFixed(2)) : null;
      return { channel: ch, spendUsd, inferenceUsd: Number(inferenceUsd.toFixed(4)), subscribers, cacUsd, cacWithInferenceUsd };
    });

  return {
    generatedAt: now,
    windowStart: since,
    windowEnd: now,
    reliabilityFloor: RELIABILITY_FLOOR,
    newJobs: windowJobs.length,
    inFlightJobs: windowJobs.length - terminal.length,
    completedJobs: terminal.length,
    usableClipJobs: usableTerminal.length,
    reliabilityPct,
    reliabilityOk,
    spendPaused,
    totalInferenceCostUsd: Number(totalInferenceCostUsd.toFixed(4)),
    usableClips: usableClips.length,
    perClipInferenceCostUsd,
    perChannel,
  };
}

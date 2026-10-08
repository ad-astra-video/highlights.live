// Conversion funnel + per-channel CAC attribution helpers (ADAAAA-6368,
// plan §3b.2). The DB owns the funnel_events table + readout ([db].funnelReport);
// this module owns the business rules: channel normalization, extracting
// attribution from an inbound request, and recording each stage at its hook.
import type { Db, FunnelStage, Subscription } from "./db";

/** Mapping from common raw acquisition source values to stable channel keys,
 * so CAC can be aggregated per channel regardless of how the marketer labels
 * the UTM. Unmapped values are kept verbatim (lowercased). */
const CHANNEL_ALIASES: Record<string, string> = {
  meta: "meta",
  facebook: "meta",
  instagram: "meta",
  google: "google",
  googleads: "google",
  search: "google",
  referral: "referral",
  organic: "organic",
  direct: "direct",
  invite: "invite",
  email: "email",
  newsletter: "email",
  x: "x",
  twitter: "x",
  tiktok: "tiktok",
  youtube: "youtube",
  content: "content",
};

/** Normalize a raw acquisition channel / utm_source to a stable key for CAC
 * aggregation. `null` when absent. */
export function normalizeChannel(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (CHANNEL_ALIASES[s]) return CHANNEL_ALIASES[s];
  return s;
}

export interface Attribution {
  channel: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
}

/** Extract acquisition attribution from an inbound register/checkout request.
 * Accepts a `channel` and/or raw UTM params from the query string or body
 * (the webapp sends `utm_source`/`utm_campaign` from the landing URL). The
 * `channel` is normalized; the raw UTM values are kept for reporting. */
export function attributionFrom(req: { query?: any; body?: any }): Attribution {
  const q = req.query ?? {};
  const b = req.body ?? {};
  const utmSource = (b.utmSource ?? b.utm_source ?? q.utm_source ?? q.utmSource ?? null) as string | null;
  const utmCampaign = (b.utmCampaign ?? b.utm_campaign ?? q.utm_campaign ?? q.utmCampaign ?? null) as string | null;
  let channel = (b.channel ?? q.channel ?? null) as string | null;
  if (!channel && utmSource) channel = utmSource;
  return { channel: normalizeChannel(channel), utmSource, utmCampaign };
}

/** True when a subscription is a paid, active Pro (CAC-converting) state. */
export function isPaidActive(sub: Subscription): boolean {
  return sub.tier === "pro" && (sub.status === "active" || sub.status === "trialing");
}

/**
 * Record the job-lifecycle funnel stages for a user at the moment a job is
 * created.
 * - `activate` fires on the user's FIRST job (first-touch activation).
 * - `retain` (returning user) fires when a later job is created at least
 *   `retainDays` after the user's first job.
 * `priorJobs` / `firstJobAt` must be read BEFORE the new job is persisted so
 * the new job does not consume the "first job" slot.
 */
export async function recordJobFunnel(
  db: Db,
  userId: string,
  priorJobs: number,
  firstJobAt: string | null,
  retainDays: number
): Promise<void> {
  if (priorJobs === 0) {
    await db.recordFunnelEvent(userId, "activate");
    return;
  }
  if (!firstJobAt) return;
  const first = new Date(firstJobAt).getTime();
  if (Number.isFinite(first) && Date.now() - first >= retainDays * 86_400_000) {
    await db.recordFunnelEvent(userId, "retain");
  }
}

/** Record a `generate` event when a highlight is produced for a user. */
export async function recordGenerateFunnel(db: Db, userId: string): Promise<void> {
  await db.recordFunnelEvent(userId, "generate");
}

/** Record a `subscribe` event when a user becomes a paid, active Pro. */
export async function recordSubscribeFunnel(db: Db, userId: string): Promise<void> {
  await db.recordFunnelEvent(userId, "subscribe");
}

/** Record a `signup` event when a user account is created. */
export async function recordSignupFunnel(db: Db, userId: string): Promise<void> {
  await db.recordFunnelEvent(userId, "signup");
}

export type { FunnelStage };

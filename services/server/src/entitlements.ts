// Per-user entitlement ledger for the beta: a calendar-month clip quota whose
// hard-stop doubles as the control-plane cost stop (no job runs / no Livepeer
// GPU spend past the quota — the same budget hard-stop the pipeline honors).
//
// No billing during the beta: the ledger is purely a quota counter. There is
// no purchase path; an overspend is impossible because the server refuses to
// submit a job (or run a decide) once the month's quota is exhausted, and a
// "clip generated successfully" marks exactly one ledger debits (partial /
// failed generations and in-submission retries never debit).
import type { Db, User } from "./db";
import type { ServerConfig } from "./config";
import { betaQuotaLiftActive } from "./config";

/** Thrown when the current month's clip quota is exhausted. Maps to HTTP 429
 * (assertable) with the remaining (0) so the client can surface it. */
export class QuotaExceededError extends Error {
  readonly statusCode = 429;
  readonly code = "quota_exceeded";
  remaining: number;
  period: string;
  constructor(period: string) {
    super("monthly clip quota used up");
    this.name = "QuotaExceededError";
    this.period = period;
    this.remaining = 0;
  }
}

export class EntitlementsService {
  constructor(private db: Db, private cfg: ServerConfig) {}

  /** Calendar-month period key, e.g. "2026-09". Resetting at the month boundary
   * falls out of this key changing on the 1st — no job is needed. */
  periodKey(now: Date = new Date()): string {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  /** Canonical per-user beta clip quota (10/mo by default) shown to users on
   * published surfaces. NEVER changed by the temporary operator lift
   * (ADAAAA-3577) — the published/canonical number stays put. */
  get displayLimit(): number {
    return this.cfg.betaClipQuota;
  }

  /** Effective quota the ledger HARD-STOPS against. Equal to `displayLimit`
   * unless the operator-controlled lift (BETA_QUOTA_LIFT) is active and (when
   * BETA_QUOTA_LIFT_UNTIL is set) not yet expired. This is the internal testing
   * lift: enforcement is raised so the N=2 real users can drive toward K=100,
   * while the canonical number shown to users stays unchanged. */
  get limit(): number {
    return betaQuotaLiftActive(this.cfg) ? this.cfg.betaQuotaLift! : this.cfg.betaClipQuota;
  }

  /** True while the temporary operator lift is in effect (enforcement limit
   * differs from the canonical). Surfaced on /billing/status + analytics so the
   * PO can read back that the lift is active and whether it has reverted. */
  get liftActive(): boolean {
    return betaQuotaLiftActive(this.cfg);
  }

  /** Clips generated successfully this month. */
  async used(userId: string, now: Date = new Date()): Promise<number> {
    return this.db.getQuota(userId, this.periodKey(now));
  }

  /** Clips remaining this month (>= 0). */
  async remaining(userId: string, now: Date = new Date()): Promise<number> {
    return Math.max(0, this.limit - (await this.used(userId, now)));
  }

  /**
   * Budget hard-stop, enforced at job-submission (and decide) time: throws
   * QuotaExceededError (HTTP 429) as soon as the month's quota is exhausted,
   * before any job is created or any compute (Livepeer GPU) is scheduled. This
   * is what guarantees the "quota overspend never runs a job" invariant.
   */
  async canSubmit(user: User, now: Date = new Date()): Promise<void> {
    if ((await this.used(user.id, now)) >= this.limit) {
      throw new QuotaExceededError(this.periodKey(now));
    }
  }

  /**
   * A "clip generated successfully" debits the ledger exactly once. Call this
   * once per concrete, successfully-generated highlight. Partial/failed
   * generations and retries within the same submission must NOT call this (the
   * caller only invokes it when a highlight record is actually created), so a
   * failed generation never double-debits.
   */
  async onClipGenerated(user: User, now: Date = new Date()): Promise<number> {
    return this.db.incrementQuota(user.id, this.periodKey(now));
  }
}

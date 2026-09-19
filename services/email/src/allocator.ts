// The waitlist->invite allocator (ADAAAA-2555). Replaces enqueue-on-signup
// with a poll-based, admin-gated FIFO model: every `intervalMs` (default 1h)
// it queries the shared DB for NEW waitlist signups and — while the server
// admin's allocation gate is OPEN — claims them OLDEST-first (FIFO), enqueues
// an invite on the `email_sends` queue (so delivery goes through the existing
// queued->sending->sent|failed retry/anti-enumeration lifecycle), and flips
// each to `invited` so it is never allocated twice. When the gate is CLOSED
// ("no new users currently") allocation is suppressed; reopening resumes.
//
// Anti-enumeration is preserved because the allocator is internal: it never
// exposes, over HTTP or otherwise, whether a given signup existed or was
// allocated — it only enqueues mail for signups it claims from the DB.

import type { Db, WaitlistEntry } from "../../server/src/db";
import { composeInviteEmail } from "../../server/src/invites";
import { randomUUID } from "node:crypto";

export interface WaitlistAllocatorOptions {
  db: Db;
  /** Max signups allocated per tick (per poll interval). */
  batchSize: number;
  maxAttempts: number;
  /** Public base URL used to build invite links (from config). */
  publicBaseUrl: string;
  /** Injectable clock (tests). Defaults to Date. */
  now?: () => Date;
}

export class WaitlistAllocator {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private opts: WaitlistAllocatorOptions) {}

  /** One poll: check the gate, then claim + enqueue up to batchSize of the
   * OLDEST waitlisted signups. Returns how many were allocated and (for
   * inspection/tests) the ids of the invite sends created. Gate-closed ticks
   * return immediately with suppressed=true and allocate nothing. */
  async tick(): Promise<{ allocated: number; suppressed: boolean; sendIds: string[] }> {
    const gate = await this.opts.db.getWaitlistGate();
    if (!gate.allocationOpen) return { allocated: 0, suppressed: true, sendIds: [] };

    const now = (this.opts.now ?? (() => new Date()))();
    const claimed = await this.opts.db.claimWaitlistSignups(this.opts.batchSize, now.toISOString());
    if (claimed.length === 0) return { allocated: 0, suppressed: false, sendIds: [] };

    // FIFO: the atomic claim reserved the oldest signups; order the returned
    // rows by signup time (tie-broken by id) so invites go out oldest-first.
    const fifo = [...claimed].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const invite = composeInviteEmail(this.opts.publicBaseUrl);
    const sendIds: string[] = [];
    for (const entry of fifo) {
      const id = randomUUID();
      await this.enqueueOrLog(entry, id, invite.subject, invite.body, now.toISOString());
      sendIds.push(id);
    }
    return { allocated: fifo.length, suppressed: false, sendIds };
  }

  /** Enqueue the invite send for a claimed signup. A failure here is logged and
   * swallowed so one bad insert doesn't strand the rest of the batch; the entry
   * is already claimed (`invited`) so the allocator will not re-allocate it. */
  private async enqueueOrLog(entry: WaitlistEntry, id: string, subject: string, body: string, createdAt: string): Promise<void> {
    try {
      await this.opts.db.enqueueEmailSend({ id, toEmail: entry.email, subject, body, createdAt, maxAttempts: this.opts.maxAttempts });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[email] allocator: failed to enqueue invite for ${entry.email} (${id}): ${String(err instanceof Error ? err.message : err)}`);
    }
  }

  /** Start polling on an interval. Returns this (chainable). */
  start(intervalMs: number): this {
    if (this.timer) return this;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[email] allocator poll error: ${String(err instanceof Error ? err.message : err)}`);
      }
    };
    void loop();
    this.timer = setInterval(loop, intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

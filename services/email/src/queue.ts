// The send worker: the piece of the email sender that actually completes a
// queued send. It claims eligible rows from the shared DB queue
// (`queued -> sending -> sent | failed`), sends via the injected transport,
// and persists the outcome with bounded retry (exponential backoff). The
// worker never touches account state — it only knows (to, subject, body) — so
// delivery failures surface in the queue/logs without leaking anything about
// whether an account exists.

import type { Db, EmailSend } from "../../server/src/db";
import type { MailTransport } from "./transport";

export interface EmailWorkerOptions {
  db: Db;
  transport: MailTransport;
  batchSize: number;
  maxAttempts: number;
  retryBaseMs: number;
  fromEmail: string;
  replyToEmail: string;
  fromName: string;
  /** Injectable clock (tests). Defaults to Date. */
  now?: () => Date;
}

export class EmailWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private opts: EmailWorkerOptions) {}

  /** One poll: claim + deliver up to batchSize sends. Returns the number
   * processed (mainly for tests). Safe to call concurrently from a single
   * worker — claimEmailSends atomically reserves rows. */
  async tick(): Promise<{ processed: number; sent: number; failed: number }> {
    const now = (this.opts.now ?? (() => new Date()))().toISOString();
    const rows = await this.opts.db.claimEmailSends(this.opts.batchSize, now);
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await this.deliver(row);
        sent++;
      } catch (err) {
        // Claim the failure: bump attempts, record the error, and keep the row
        // for retry (backoff) unless it has exhausted maxAttempts.
        const attempts = row.attempts + 1;
        const canRetry = attempts < this.opts.maxAttempts;
        const nextAttemptAt = canRetry ? new Date((this.opts.now ?? (() => new Date()))().getTime() + this.opts.retryBaseMs * 2 ** (attempts - 1)).toISOString() : null;
        await this.opts.db.markEmailFailed(row.id, attempts, String(err instanceof Error ? err.message : err), nextAttemptAt);
        // eslint-disable-next-line no-console
        console.error(`[email] send ${row.id} failed (attempt ${attempts}/${this.opts.maxAttempts}): ${String(err instanceof Error ? err.message : err)}`);
        failed++;
      }
    }
    return { processed: rows.length, sent, failed };
  }

  private async deliver(row: EmailSend): Promise<void> {
    await this.opts.transport.send({
      to: row.toEmail,
      subject: row.subject,
      body: row.body,
      from: this.opts.fromEmail,
      replyTo: this.opts.replyToEmail,
      fromName: this.opts.fromName,
    });
    await this.opts.db.markEmailSent(row.id, new Date().toISOString());
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
        console.error(`[email] poll error: ${String(err instanceof Error ? err.message : err)}`);
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

  async close(): Promise<void> {
    this.stop();
    await this.opts.transport.close?.();
  }
}

/** Exponential backoff for the next retry of a send that failed on `attempt`.
 * `attempt` is 1-based (the attempt that just failed). */
export function nextRetryDelayMs(attempt: number, baseMs: number): number {
  return baseMs * 2 ** (attempt - 1);
}

// Mailer client: the API server's side of the email-sender container. The
// server does NOT send mail itself — it POSTs a message to the email sender's
// queue API (bearer-token authenticated) and the email sender persists it in
// the shared DB and delivers it over SMTP.
//
// Enqueue is best-effort by design: a delivery/transit failure must never turn
// into an account-existence signal. Callers wrap enqueue() and always respond
// innocuously even when the mailer is unreachable.

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface Mailer {
  /** Queue a message for delivery. Resolves with the queue id, or null if the
   * message was deliberately skipped (e.g. no mailer configured). */
  enqueue(msg: EmailMessage): Promise<{ id: string } | null>;
}

/** HTTP client for the email-sender container's POST /emails endpoint. */
export class HttpMailer implements Mailer {
  constructor(
    private baseUrl: string,
    private token: string
  ) {}
  async enqueue(msg: EmailMessage): Promise<{ id: string } | null> {
    const base = this.baseUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/emails`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(msg),
    });
    if (!res.ok) throw new Error(`email enqueue failed: HTTP ${res.status}`);
    const body = (await res.json()) as { id: string };
    return { id: body.id };
  }
}

/** No-op mailer for tests / when the email sender is not configured. Records
 * messages so tests can assert on what would have been sent. */
export class NoopMailer implements Mailer {
  sent: EmailMessage[] = [];
  /** When true, enqueue() rejects — lets tests exercise the failure path. */
  fail = false;
  async enqueue(msg: EmailMessage): Promise<{ id: string } | null> {
    if (this.fail) throw new Error("mailer down");
    this.sent.push(msg);
    return { id: `noop-${this.sent.length}` };
  }
}

/** Construct the configured mailer, or null when no email sender URL is set. */
export function makeMailer(cfg: { emailSenderUrl?: string; mailerToken?: string }): Mailer | null {
  if (!cfg.emailSenderUrl) return null;
  return new HttpMailer(cfg.emailSenderUrl, cfg.mailerToken ?? "");
}

/**
 * Fire-and-forget enqueue that never throws: on any failure it logs and returns
 * null. Ideal for anti-enumeration surfaces (forgot) and admin actions where
 * email delivery is secondary to the HTTP outcome.
 */
export function enqueueBestEffort(mailer: Mailer | null | undefined, msg: EmailMessage): Promise<{ id: string } | null> {
  if (!mailer) return Promise.resolve(null);
  return mailer.enqueue(msg).catch((e: any) => {
    // eslint-disable-next-line no-console
    console.error(`[mailer] enqueue failed (to=${msg.to}): ${String(e?.message ?? e)}`);
    return null;
  });
}

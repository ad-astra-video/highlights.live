// SMTP transport abstraction. A MailTransport has one job: deliver a composed
// message. The real implementation uses nodemailer against the configured SMTP
// server; a log-mode transport stands in when no SMTP is configured (dev/CI)
// so the queue + worker lifecycle can be exercised end to end without real
// mailbox credentials.

export interface MailMessage {
  to: string;
  subject: string;
  body: string;
  from: string;
  replyTo: string;
  fromName: string;
}

export interface MailTransport {
  /** Send a message. Rejects with a descriptive Error on delivery failure. */
  send(mail: MailMessage): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Build the transport for this process. When `SMTP_HOST` is unset (no creds
 * configured) we run in LOG mode: every "send" is a no-op that logs the
 * recipient/subject so the pipeline can be exercised and debugged locally.
 * This is intentionally the dev default — a real deployment always sets SMTP.
 */
export function createTransport(cfg: {
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpRequireTls: boolean;
}): MailTransport {
  if (!cfg.smtpHost) return new LogTransport();
  return new NodemailerTransport(cfg);
}

/** Real SMTP via nodemailer. Credentials come from env (secrets), never code. */
export class NodemailerTransport implements MailTransport {
  private transporter: any;
  constructor(cfg: {
    smtpHost?: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser?: string;
    smtpPass?: string;
    smtpRequireTls: boolean;
  }) {
    // Lazy require so this module also loads in test environments that don't
    // have nodemailer installed / network access.
    const nodemailer = require("nodemailer");
    this.transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpSecure,
      requireTLS: cfg.smtpRequireTls,
      auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
    });
  }
  async send(mail: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: `"${mail.fromName}" <${mail.from}>`,
      replyTo: mail.replyTo,
      to: mail.to,
      subject: mail.subject,
      text: mail.body,
    });
  }
  async close(): Promise<void> {
    try {
      await this.transporter?.close?.();
    } catch {
      /* noop */
    }
  }
}

/** Dev/CI stand-in: logs the would-be send instead of hitting SMTP. */
export class LogTransport implements MailTransport {
  send(mail: MailMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[email:log-mode] to=${mail.to} subject="${mail.subject}" (SMTP not configured)`);
    return Promise.resolve();
  }
}

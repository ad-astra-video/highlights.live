import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteDb, type Db, type EmailSend } from "../../server/src/db";
import { buildEmailApp } from "../src/index";
import { ipInAllowlist } from "../src/allowlist";
import { EmailWorker } from "../src/queue";
import type { MailTransport, MailMessage } from "../src/transport";

async function testDb(): Promise<Db> {
  const dir = mkdtempSync(path.join(tmpdir(), "hl-email-"));
  const db = new SqliteDb(path.join(dir, "test.db"));
  await db.migrate();
  return db;
}

/** Recording transport that can be told to fail. */
class FakeTransport implements MailTransport {
  sent: MailMessage[] = [];
  fail: string | null = null;
  async send(mail: MailMessage): Promise<void> {
    if (this.fail) throw new Error(this.fail);
    this.sent.push(mail);
  }
}

const baseCfg = {
  port: 0,
  databasePath: ":memory:",
  databaseBackupDir: "",
  queueToken: "sekret",
  allowlistIps: [],
  smtpHost: undefined as string | undefined,
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: undefined,
  smtpPass: undefined,
  smtpRequireTls: false,
  fromEmail: "onboarding@highlights.live",
  replyToEmail: "onboarding@highlights.live",
  fromName: "Highlights",
  publicBaseUrl: "http://127.0.0.1:3000",
  pollIntervalMs: 999999,
  batchSize: 10,
  maxAttempts: 3,
  retryBaseMs: 30_000,
  allocatorIntervalMs: 3_600_000,
  allocatorBatchSize: 50,
};

describe("email sender: queue API", () => {
  it("enqueues a send (202, queued), reads status, and rejects bad input / no auth", async () => {
    const db = await testDb();
    const app = buildEmailApp({ cfg: { ...baseCfg }, db });
    await app.ready();

    // No token -> 401.
    const noAuth = await app.inject({ method: "POST", url: "/emails", payload: { to: "a@b.co", subject: "s", body: "b" } });
    expect(noAuth.statusCode).toBe(401);

    // Bad email -> 400.
    const bad = await app.inject({
      method: "POST",
      url: "/emails",
      headers: { authorization: `Bearer ${baseCfg.queueToken}` },
      payload: { to: "nope", subject: "s", body: "b" },
    });
    expect(bad.statusCode).toBe(400);

    // Good -> 202 queued, row persisted.
    const r = await app.inject({
      method: "POST",
      url: "/emails",
      headers: { authorization: `Bearer ${baseCfg.queueToken}` },
      payload: { to: "  Fan@Example.COM ", subject: "Welcome", body: "Hello" },
    });
    expect(r.statusCode).toBe(202);
    const { id, status } = r.json();
    expect(status).toBe("queued");
    const row = (await db.getEmailSend(id))!;
    expect(row.status).toBe("queued");
    expect(row.toEmail).toBe("fan@example.com"); // normalized
    expect(row.attempts).toBe(0);

    // Status read.
    const got = await app.inject({
      method: "GET",
      url: `/emails/${id}`,
      headers: { authorization: `Bearer ${baseCfg.queueToken}` },
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().subject).toBe("Welcome");

    // Unknown id -> 404.
    const missing = await app.inject({
      method: "GET",
      url: "/emails/does-not-exist",
      headers: { authorization: `Bearer ${baseCfg.queueToken}` },
    });
    expect(missing.statusCode).toBe(404);

    await app.close();
  });
});

describe("email sender: security gate (ADAAAA-2475)", () => {
  it("rejects no-secret requests with 401 and out-of-allowlist sources with 403", async () => {
    const db = await testDb();

    // Source outside the allow-list is refused (403) even before the token.
    const locked = buildEmailApp({ cfg: { ...baseCfg, allowlistIps: ["10.0.0.1"] }, db });
    await locked.ready();
    const denied = await locked.inject({
      method: "POST",
      url: "/emails",
      // inject() defaults remoteAddress to 127.0.0.1, which is NOT 10.0.0.1
      headers: { authorization: `Bearer ${baseCfg.queueToken}` },
      payload: { to: "a@b.co", subject: "s", body: "b" },
    });
    expect(denied.statusCode).toBe(403);
    await locked.close();

    // A source on the allow-list with the correct secret is accepted (202),
    // and the same source WITHOUT the secret is rejected (401).
    const open = buildEmailApp({ cfg: { ...baseCfg, allowlistIps: ["127.0.0.1"] }, db });
    await open.ready();
    const noSecret = await open.inject({ method: "POST", url: "/emails", payload: { to: "a@b.co", subject: "s", body: "b" } });
    expect(noSecret.statusCode).toBe(401);
    const ok = await open.inject({
      method: "POST",
      url: "/emails",
      headers: { authorization: `Bearer ${baseCfg.queueToken}` },
      payload: { to: "a@b.co", subject: "s", body: "b" },
    });
    expect(ok.statusCode).toBe(202);
    await open.close();
  });

  it("ipInAllowlist matches exact IPs and CIDRs", () => {
    expect(ipInAllowlist("10.1.2.3", ["10.0.0.0/8", "127.0.0.1"])).toBe(true);
    expect(ipInAllowlist("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
    expect(ipInAllowlist("127.0.0.1", ["127.0.0.1"])).toBe(true);
    expect(ipInAllowlist("8.8.8.8", ["10.0.0.0/8"])).toBe(false);
  });
});

describe("email sender: worker delivers and persists status", () => {
  it("sends claimed rows and marks them sent", async () => {
    const db = await testDb();
    const transport = new FakeTransport();
    const worker = new EmailWorker({ db, transport, ...baseCfg });
    const t = await db.enqueueEmailSend({
      id: "e1",
      toEmail: "a@b.co",
      subject: "Hi",
      body: "Body",
      createdAt: new Date().toISOString(),
      maxAttempts: 3,
    });
    expect(t.status).toBe("queued");
    const res = await worker.tick();
    expect(res.processed).toBe(1);
    expect(res.sent).toBe(1);
    expect(transport.sent.length).toBe(1);
    const row = (await db.getEmailSend("e1"))!;
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(0);
    expect(row.sentAt).toBeTruthy();
    expect(transport.sent[0].from).toBe("onboarding@highlights.live");
    expect(transport.sent[0].to).toBe("a@b.co");
  });

  it("retries a failed send, then marks it failed after maxAttempts", async () => {
    const db = await testDb();
    const transport = new FakeTransport();
    transport.fail = "SMTP 550 rejected";
    const worker = new EmailWorker({ db, transport, ...baseCfg, maxAttempts: 2 });
    await db.enqueueEmailSend({
      id: "e1",
      toEmail: "a@b.co",
      subject: "Hi",
      body: "Body",
      createdAt: new Date().toISOString(),
      maxAttempts: 2,
    });

    // First attempt fails -> attempts=1, still eligible for retry (nextAttemptAt set).
    await worker.tick();
    let row = (await db.getEmailSend("e1"))!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).toBeTruthy();
    expect(row.lastError).toContain("550");

    // Not yet due: retry window in the future -> not claimed.
    const res0 = await worker.tick();
    expect(res0.processed).toBe(0);

    // Advance time past the retry window and backdate next_attempt_at so the
    // second (final, maxAttempts=2) attempt is eligible; it exhausts attempts.
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.markEmailFailed("e1", 1, "SMTP 550 rejected", past);
    const res1 = await worker.tick();
    expect(res1.processed).toBe(1);
    row = (await db.getEmailSend("e1"))!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(2);
    // No retries left -> nextAttemptAt null (permanently failed, not re-claimed).
    expect(row.nextAttemptAt).toBeNull();

    const res2 = await worker.tick();
    expect(res2.processed).toBe(0);
  });

  it("does not claim another worker's in-flight (sending) rows", async () => {
    const db = await testDb();
    await db.enqueueEmailSend({
      id: "e1",
      toEmail: "a@b.co",
      subject: "Hi",
      body: "Body",
      createdAt: new Date().toISOString(),
      maxAttempts: 3,
    });
    // First claim reserves the row as `sending` (delivery is in progress).
    const claimed = await db.claimEmailSends(10, new Date().toISOString());
    expect(claimed.length).toBe(1);
    expect(claimed[0].status).toBe("sending");
    // A second worker's claim must NOT re-reserve the same in-flight row.
    const second = await db.claimEmailSends(10, new Date().toISOString());
    expect(second.length).toBe(0);
  });
});

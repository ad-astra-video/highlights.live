// Auth: users + admin, JWT sessions, Fastify auth middleware.
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db, User } from "./db";
import type { ServerConfig } from "./config";
import { enqueueBestEffort, type Mailer } from "./mailer";

export interface AuthResult {
  token: string;
  user: { id: string; email: string; role: string };
}

/** Thrown when registration cannot pass the invite/beta-gate (no valid invite
 * code and no invited waitlist entry). Maps to HTTP 403 by the route. */
export class BetaGateError extends Error {
  readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = "BetaGateError";
  }
}

export class AuthService {
  constructor(
    private db: Db,
    private cfg: ServerConfig,
    private mailer?: Mailer
  ) {}

  static hash(pw: string): string {
    return bcrypt.hashSync(pw, 10);
  }

  /** Upsert the seeded admin account so the dev/prod admin always exists. */
  async bootstrapAdmin(): Promise<void> {
    const existing = await this.db.getUserByEmail(this.cfg.adminEmail);
    if (existing) return;
    await this.db.createUser({
      id: createHash("sha1").update(this.cfg.adminEmail).digest("hex").slice(0, 16),
      email: this.cfg.adminEmail,
      passwordHash: AuthService.hash(this.cfg.adminPassword),
      role: "admin",
      stripeCustomerId: null,
      betaActivatedAt: new Date().toISOString(), // admins are always activated
    });
  }

  /**
   * Register a beta user. The invite/beta-gate (when `cfg.betaGate` is on) is
   * enforced here — the hard gate that keeps non-invited users off the product:
   *   (a) a valid, unused, un-revoked invite `code` (optionally bound to a
   *       specific email) — claimed atomically (single-use), OR
   *   (b) the email's waitlist entry has been flipped to `invited` by the
   *       cohort owner.
   * Otherwise registration is rejected with BetaGateError (HTTP 403) and the
   * visitor keeps the waitlist confirmation instead of reaching the product.
   */
  async register(email: string, password: string, inviteCode?: string): Promise<AuthResult> {
    const clean = email.trim().toLowerCase();
    if (await this.db.getUserByEmail(clean)) throw new Error("email already registered");
    if (password.length < 8) throw new Error("password must be at least 8 characters");
    const id = randomBytes(8).toString("hex");
    const gateOn = this.cfg.betaGate;
    if (gateOn) {
      let activated = false;
      if (inviteCode) {
        // Bind check BEFORE the atomic claim so a wrong-email attempt does not
        // burn (consume) a valid code.
        const ic = await this.db.getInviteByHash(AuthService.hashInviteCode(inviteCode));
        if (!ic || ic.usedAt || ic.revokedAt) throw new BetaGateError("invalid, used, or revoked invite code");
        if (ic.email && ic.email.toLowerCase() !== clean) {
          throw new BetaGateError("invite code is bound to a different email");
        }
        // Atomic single-use claim: race-safe guard against double redemption.
        const claimed = await this.db.claimInvite(AuthService.hashInviteCode(inviteCode), id);
        if (!claimed) throw new BetaGateError("invalid, used, or revoked invite code");
        activated = true;
      } else {
        const wl = await this.db.getWaitlist(clean);
        activated = wl?.status === "invited";
      }
      if (!activated) throw new BetaGateError("invite required to create an account");
    }
    const user = await this.db.createUser({
      id,
      email: clean,
      passwordHash: AuthService.hash(password),
      role: "user",
      stripeCustomerId: null,
      betaActivatedAt: new Date().toISOString(), // a registered beta user is activated at signup
    });
    return this.issue(user);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const clean = email.trim().toLowerCase();
    const user = await this.db.getUserByEmail(clean);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) throw new Error("invalid email or password");
    // Defense-in-depth: even if an account somehow exists without going through
    // the gate, a non-admin whose email was never invited cannot sign in.
    if (this.cfg.betaGate && user.role !== "admin" && !user.betaActivatedAt) {
      throw new BetaGateError("account not activated — invite required");
    }
    return this.issue(user);
  }

  /**
   * Start a password reset: mint a single-use token, store its SHA-256 hash +
   * expiry on the user, and deliver the reset link by email via the mailer
   * (the email-sender container). Always returns `{ ok: true }` with no token
   * so account existence is never leaked — an unknown email simply gets no
   * email, and the caller's response is identical either way. The inline token
   * return was removed per the mailer scope (ADAAAA-2481): the token travels
   * only inside the emailed reset link.
   */
  async requestPasswordReset(email: string): Promise<{ ok: boolean }> {
    const clean = email.trim().toLowerCase();
    const user = await this.db.getUserByEmail(clean);
    if (!user) return { ok: true };
    const resetToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + this.cfg.resetTokenTtlSec * 1000).toISOString();
    await this.db.setResetToken(user.id, AuthService.hashResetToken(resetToken), expiresAt);
    await enqueueBestEffort(this.mailer, {
      to: clean,
      subject: "Reset your highlights.live password",
      body: `Someone requested a password reset for ${clean}. If that was you, open the link below to set a new password (valid for ${Math.round(this.cfg.resetTokenTtlSec / 60)} minutes):\n\n${this.cfg.publicBaseUrl}/reset?token=${resetToken}\n\nIf you didn't request this, you can safely ignore this email.`,
    });
    return { ok: true };
  }

  /**
   * Redeem a reset token: validate hash + expiry + password strength, then set
   * the new password and invalidate the token (single use).
   */
  async resetPassword(resetToken: string, newPassword: string): Promise<void> {
    if (!resetToken) throw new Error("reset token required");
    if (newPassword.length < 8) throw new Error("password must be at least 8 characters");
    const user = await this.db.getUserByResetToken(AuthService.hashResetToken(resetToken));
    if (!user || !user.resetTokenExpires) throw new Error("invalid or expired reset token");
    if (Date.now() > new Date(user.resetTokenExpires).getTime()) {
      await this.db.clearResetToken(user.id);
      throw new Error("invalid or expired reset token");
    }
    await this.db.updatePassword(user.id, AuthService.hash(newPassword));
    await this.db.clearResetToken(user.id);
  }

  /** SHA-256 hash of a raw token, so the plaintext token is never persisted. */
  static hashResetToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /** SHA-256 hash of a raw invite code; the plaintext code is only ever shown
   * to the cohort owner once at issuance and matched by hash thereafter. */
  static hashInviteCode(code: string): string {
    return createHash("sha256").update(code.trim()).digest("hex");
  }

  private issue(user: User): AuthResult {
    const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, this.cfg.jwtSecret, { expiresIn: "7d" });
    return { token, user: { id: user.id, email: user.email, role: user.role } };
  }

  /** Verify a Bearer token -> the user, or null. */
  async verify(token?: string): Promise<User | null> {
    if (!token) return null;
    try {
      const payload = jwt.verify(token.replace(/^Bearer\s+/i, ""), this.cfg.jwtSecret) as { sub: string };
      return (await this.db.getUserById(payload.sub)) ?? null;
    } catch {
      return null;
    }
  }
}

// --- Fastify middleware factories ---
export function authRequired(auth: AuthService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await auth.verify((req.headers.authorization as string) || "");
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    (req as any).user = user;
  };
}

export function adminRequired(auth: AuthService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await auth.verify((req.headers.authorization as string) || "");
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (user.role !== "admin") return reply.code(403).send({ error: "admin only" });
    (req as any).user = user;
  };
}

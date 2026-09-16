// Auth: users + admin, JWT sessions, Fastify auth middleware.
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db, User } from "./db";
import type { ServerConfig } from "./config";

export interface AuthResult {
  token: string;
  user: { id: string; email: string; role: string };
}

export class AuthService {
  constructor(private db: Db, private cfg: ServerConfig) {}

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
    });
  }

  async register(email: string, password: string): Promise<AuthResult> {
    const clean = email.trim().toLowerCase();
    if (await this.db.getUserByEmail(clean)) throw new Error("email already registered");
    if (password.length < 8) throw new Error("password must be at least 8 characters");
    const user = await this.db.createUser({
      id: randomBytes(8).toString("hex"),
      email: clean,
      passwordHash: AuthService.hash(password),
      role: "user",
      stripeCustomerId: null,
    });
    return this.issue(user);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const clean = email.trim().toLowerCase();
    const user = await this.db.getUserByEmail(clean);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) throw new Error("invalid email or password");
    return this.issue(user);
  }

  /**
   * Start a password reset: mint a single-use token, store its SHA-256 hash +
   * expiry on the user. Returns the raw token so the caller can deliver it.
   *
   * There is no emailer in the repo yet, so delivery is inline for the beta
   * viability loop: `resetToken` is returned for an EXISTING account and null
   * for an unknown email (caller always returns an innocuous "ok" so account
   * existence is not leaked). When a mailer is added, replace the inline return
   * with an email send and always return null.
   */
  async requestPasswordReset(email: string): Promise<{ ok: boolean; resetToken: string | null }> {
    const clean = email.trim().toLowerCase();
    const user = await this.db.getUserByEmail(clean);
    if (!user) return { ok: true, resetToken: null };
    const resetToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + this.cfg.resetTokenTtlSec * 1000).toISOString();
    await this.db.setResetToken(user.id, AuthService.hashResetToken(resetToken), expiresAt);
    return { ok: true, resetToken };
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

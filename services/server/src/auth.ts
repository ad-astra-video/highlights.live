// Auth: users + admin, JWT sessions, Fastify auth middleware.
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SqlDb, User } from "./db";
import type { ServerConfig } from "./config";

export interface AuthResult {
  token: string;
  user: { id: string; email: string; role: string };
}

export class AuthService {
  constructor(private db: SqlDb, private cfg: ServerConfig) {}

  static hash(pw: string): string {
    return bcrypt.hashSync(pw, 10);
  }

  /** Upsert the seeded admin account so the dev/prod admin always exists. */
  bootstrapAdmin(): void {
    const existing = this.db.getUserByEmail(this.cfg.adminEmail);
    if (existing) return;
    this.db.createUser({
      id: createHash("sha1").update(this.cfg.adminEmail).digest("hex").slice(0, 16),
      email: this.cfg.adminEmail,
      passwordHash: AuthService.hash(this.cfg.adminPassword),
      role: "admin",
      stripeCustomerId: null,
    });
  }

  register(email: string, password: string): AuthResult {
    const clean = email.trim().toLowerCase();
    if (this.db.getUserByEmail(clean)) throw new Error("email already registered");
    if (password.length < 8) throw new Error("password must be at least 8 characters");
    const user = this.db.createUser({
      id: randomBytes(8).toString("hex"),
      email: clean,
      passwordHash: AuthService.hash(password),
      role: "user",
      stripeCustomerId: null,
    });
    return this.issue(user);
  }

  login(email: string, password: string): AuthResult {
    const clean = email.trim().toLowerCase();
    const user = this.db.getUserByEmail(clean);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) throw new Error("invalid email or password");
    return this.issue(user);
  }

  private issue(user: User): AuthResult {
    const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, this.cfg.jwtSecret, { expiresIn: "7d" });
    return { token, user: { id: user.id, email: user.email, role: user.role } };
  }

  /** Verify a Bearer token -> the user, or null. */
  verify(token?: string): User | null {
    if (!token) return null;
    try {
      const payload = jwt.verify(token.replace(/^Bearer\s+/i, ""), this.cfg.jwtSecret) as { sub: string };
      return this.db.getUserById(payload.sub) ?? null;
    } catch {
      return null;
    }
  }
}

// --- Fastify middleware factories ---
export function authRequired(auth: AuthService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = auth.verify((req.headers.authorization as string) || "");
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    (req as any).user = user;
  };
}

export function adminRequired(auth: AuthService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = auth.verify((req.headers.authorization as string) || "");
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (user.role !== "admin") return reply.code(403).send({ error: "admin only" });
    (req as any).user = user;
  };
}

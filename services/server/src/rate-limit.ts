// Minimal in-memory fixed-window rate limiter for the public auth endpoints.
//
// This is a per-process limiter (keyed by client IP + route) intended for the
// public-beta viability loop: it stops casual credential stuffing / forgot-password
// spamming without needing a Redis or extra tables. For a multi-instance deploy
// it would need to move to a shared store (e.g. Redis), but for a single
// instance it is sufficient and dependency-free.
import type { FastifyReply, FastifyRequest } from "fastify";

interface Bucket {
  count: number;
  resetAt: number; // epoch ms at which the window resets
}

export interface RateLimitConfig {
  limit: number; // max requests per windowMs
  windowMs: number;
}

export class FixedWindowLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private cfg: RateLimitConfig) {}

  /** Clear all state (used between tests). */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * Record a hit for `key` and return whether it is allowed. When a window has
   * elapsed the bucket resets automatically. Always prunes stale buckets so the
   * map can't grow unboundedly under a varyingly-sourced public IP.
   */
  hit(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const { limit, windowMs } = this.cfg;
    let b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > limit) return { allowed: false, retryAfterMs: b.resetAt - now };
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Remove stale (expired) buckets; callable periodically or on hit. */
  prune(now = Date.now()): void {
    for (const [k, b] of this.buckets) {
      if (now >= b.resetAt) this.buckets.delete(k);
    }
  }
}

/**
 * Fastify preHandler that rate-limits an endpoint by client IP with `limiter`.
 * `bucket` namespaces the route so login/register/forgot/reset don't share one
 * budget. Responds 429 with a Retry-After header when over the limit.
 */
export function rateLimit(limiter: FixedWindowLimiter, bucket: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    limiter.prune();
    const ip = (req.ip ?? "unknown").replace(/^::ffff:/, "");
    const { allowed, retryAfterMs } = limiter.hit(`${bucket}:${ip}`);
    if (!allowed) {
      const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
      reply.header("Retry-After", String(retryAfter));
      return reply.code(429).send({ error: "too many requests; try again shortly" });
    }
  };
}

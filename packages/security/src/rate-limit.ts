/**
 * In-process rate limiting.
 *
 * Scope note: this protects a single node from credential stuffing and runaway
 * agent loops. It is NOT a distributed limit -- behind more than one instance
 * each keeps its own bucket. Phase 2 replaces the store with Redis; the
 * interface below is deliberately the shape that swap will preserve.
 */
import { rateLimited } from "../../shared/src/index.js";

export interface RateLimitPolicy {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Requests permitted per window, per key. */
  limit: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Unix ms at which the current window resets. */
  resetAt: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string, policy?: RateLimitPolicy): RateLimitResult;
  reset(key: string): void;
  clear(): void;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Sweeps expired buckets on a timer so a long-lived process does not
 * accumulate one entry per unique IP forever.
 */
export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const sweep = setInterval(() => {
    const timestamp = now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= timestamp) buckets.delete(key);
    }
  }, 60_000);
  // Never hold the event loop open for a cleanup timer.
  sweep.unref?.();

  return {
    consume(key, policy) {
      const resolved = policy ?? DEFAULT_POLICY;
      const timestamp = now();
      const existing = buckets.get(key);

      if (!existing || existing.resetAt <= timestamp) {
        buckets.set(key, { count: 1, resetAt: timestamp + resolved.windowMs });
        return {
          allowed: true,
          remaining: resolved.limit - 1,
          resetAt: timestamp + resolved.windowMs,
          retryAfterSeconds: Math.ceil(resolved.windowMs / 1000),
        };
      }

      existing.count += 1;
      const remaining = Math.max(0, resolved.limit - existing.count);
      return {
        allowed: existing.count <= resolved.limit,
        remaining,
        resetAt: existing.resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - timestamp) / 1000)),
      };
    },
    reset(key) {
      buckets.delete(key);
    },
    clear() {
      buckets.clear();
    },
  };
}

export const DEFAULT_POLICY: RateLimitPolicy = { windowMs: 60_000, limit: 120 };

/** Credential endpoints: strict, and keyed by IP + submitted identity. */
export const LOGIN_POLICY: RateLimitPolicy = { windowMs: 15 * 60_000, limit: 10 };

/** Agent reasoning is expensive; one long chat must not fan out. */
export const AGENT_RUN_POLICY: RateLimitPolicy = { windowMs: 60_000, limit: 20 };

export function enforceRateLimit(limiter: RateLimiter, key: string, policy: RateLimitPolicy): void {
  const result = limiter.consume(key, policy);
  if (!result.allowed) {
    throw rateLimited(
      `Too many requests. Retry in ${result.retryAfterSeconds}s.`,
      result.retryAfterSeconds,
    );
  }
}

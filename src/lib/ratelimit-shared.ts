import type { RateLimitResult, RateLimitStore } from "./retrieval/ratelimit";

/**
 * Rate limiting backed by a shared store, so the limit holds across instances.
 *
 * NOT in `src/lib/retrieval/`: that directory is air-gap scanned and may not
 * contain network code. This module talks to a Redis-compatible service, so it
 * lives outside and is injected at construction. An air-gapped deployment
 * simply never configures it and keeps the in-process default.
 *
 * Deliberately depends on a tiny CLIENT INTERFACE rather than a specific SDK.
 * Upstash Redis, node-redis, ioredis, and Vercel KV all satisfy it, so the
 * choice of provider is a wiring decision and does not reach this file.
 */

/** The three operations a fixed-window counter needs. */
export interface RedisLikeClient {
  /** Increments the key and returns the new value. Must be atomic. */
  incr(key: string): Promise<number>;
  /** Sets a TTL in milliseconds. */
  pexpire(key: string, ms: number): Promise<unknown>;
  /** Remaining TTL in milliseconds. Negative when unset or missing. */
  pttl(key: string): Promise<number>;
}

export interface SharedRateLimitStoreOptions {
  /** Namespace so several limiters can share one database safely. */
  prefix?: string;
  /**
   * What to do when the store is unreachable. "allow" keeps the product working
   * during a cache outage; "deny" keeps the limit absolute. Defaults to "allow",
   * because a rate limiter that takes the whole API down when Redis blips has
   * caused a worse outage than the abuse it prevents.
   */
  onError?: "allow" | "deny";
  /** Called when the store fails, for logging or alerting. */
  onFailure?: (error: unknown) => void;
}

/**
 * Fixed-window counter in a shared store.
 *
 * INCR is atomic, and the window is established by setting the TTL only on the
 * first increment of a window. Read-then-write would undercount under
 * concurrency, which is exactly the case a distributed limiter exists for.
 */
export class SharedRateLimitStore implements RateLimitStore {
  private readonly prefix: string;
  private readonly onError: "allow" | "deny";
  private readonly onFailure?: (error: unknown) => void;

  constructor(
    private readonly client: RedisLikeClient,
    options: SharedRateLimitStoreOptions = {}
  ) {
    this.prefix = options.prefix ?? "forge:rl";
    this.onError = options.onError ?? "allow";
    this.onFailure = options.onFailure;
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const namespaced = `${this.prefix}:${key}`;

    try {
      const count = await this.client.incr(namespaced);

      // First request of a window: start the clock. Doing this only on the
      // first increment is what makes the window fixed rather than sliding
      // forward on every request, which would never let a client recover.
      if (count === 1) {
        await this.client.pexpire(namespaced, windowMs);
      }

      if (count > limit) {
        const ttl = await this.client.pttl(namespaced);
        // A missing TTL means the key lost its expiry (an eviction, or a crash
        // between INCR and PEXPIRE). Re-arm it so the client is not locked out
        // permanently by a counter that can never expire.
        if (ttl < 0) {
          await this.client.pexpire(namespaced, windowMs);
          return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil(windowMs / 1000) };
        }
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)) };
      }

      return { allowed: true, remaining: Math.max(0, limit - count), retryAfterSeconds: 0 };
    } catch (error) {
      this.onFailure?.(error);
      if (this.onError === "deny") {
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil(windowMs / 1000) };
      }
      // Fail open: the endpoint stays available and falls back to whatever
      // other protection exists. Stated as a deliberate trade, not an accident.
      return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
    }
  }

  /** No-op: a shared store outlives this process and is not ours to clear. */
  reset(): void {}

  /** Not knowable without scanning the keyspace, which is not worth the cost. */
  get size(): number {
    return 0;
  }
}

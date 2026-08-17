// Rate limiting for the public API routes.
//
// Air-gap safety: pure in-memory bookkeeping, no network, no imports that reach the network.
//
// Why this is a security control and not a billing one: `/api/lookup` makes OUTBOUND requests to
// vendor sites on behalf of an anonymous caller. Without a limit, Forge is a traffic amplifier.
// One request in can become a dozen fetches out to ti.com, st.com, and several search engines, so
// an attacker can point our egress at a third party, get our IP blocked by the vendors we depend
// on, or simply exhaust the process. The upload route needs it too, since each call buffers and
// hashes megabytes of PDF.
//
// Fixed-window counter rather than a token bucket: the failure we care about is a burst from one
// source, the window is short, and the simpler structure means less to get wrong.
//
// KNOWN LIMIT, stated plainly: the DEFAULT store is per-process. On a serverless platform each
// instance keeps its own counters, so the effective limit is roughly (limit x instances). That makes
// the default a mitigation, not a guarantee. Per-process still stops the single-client hammering
// case, which is the common one.
//
// Closing that gap is a store swap rather than surgery: `RateLimiter` talks to a `RateLimitStore`
// and `check` is async, so a shared backend (Redis, Vercel KV, or the platform's own edge limiter)
// drops in without touching a route. It would have to live OUTSIDE this module, because everything
// here is reachable in air-gapped mode and may not contain networking code.
//
// NO SUCH STORE EXISTS TODAY, and that is stated rather than implied. One was written on
// 2026-08-15 against a Redis-compatible client interface, carried 9 tests, and nothing in the
// product could construct it: no code read a connection string, so no deployment could ever have
// used it. Deleted on 2026-08-16 for the reason the audit that found it gives: a tested,
// unreachable component reads as protection and is not, which is worse than an absence somebody
// can see. The seam stays because it costs three lines and it is what keeps the sentence above
// true; the implementation gets written against whatever database a real deployment actually has.

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Storage behind a fixed-window counter.
 *
 * `hit` must be atomic per key: it records one request and reports the resulting
 * state. Any implementation that reads and then writes non-atomically will
 * undercount under concurrency, which is the whole failure this guards against.
 */
export interface RateLimitStore {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  reset(): void;
  readonly size: number;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Default store. Single-process, no dependencies, safe in air-gapped mode.
 * Atomic by construction because Node runs this synchronously on one thread.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly maxKeys = 10_000) {}

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || existing.resetAt <= now) {
      this.evictIfNeeded();
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }

    if (existing.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
      };
    }

    existing.count++;
    return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
  }

  // The map is keyed by client-controlled values, so it is itself a memory-exhaustion target: an
  // attacker rotating source addresses would otherwise grow it without bound. Drop expired entries
  // first, and if that is not enough, drop oldest-first.
  private evictIfNeeded(): void {
    if (this.windows.size < this.maxKeys) return;

    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }

    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }

  reset(): void {
    this.windows.clear();
  }

  get size(): number {
    return this.windows.size;
  }
}

export interface RateLimiterOptions {
  /** Defaults to an in-process store. Supply a shared one for a real guarantee. */
  store?: RateLimitStore;
  /** Only used by the default in-memory store. */
  maxKeys?: number;
}

export class RateLimiter {
  private readonly store: RateLimitStore;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    options: RateLimiterOptions | number = {}
  ) {
    // A number keeps the older (limit, windowMs, maxKeys) call shape working.
    const opts = typeof options === "number" ? { maxKeys: options } : options;
    this.store = opts.store ?? new InMemoryRateLimitStore(opts.maxKeys);
  }

  check(key: string): Promise<RateLimitResult> {
    return this.store.hit(key, this.limit, this.windowMs);
  }

  reset(): void {
    this.store.reset();
  }

  get size(): number {
    return this.store.size;
  }
}

// Identifies the caller for rate-limiting purposes.
//
// Proxy headers are attacker-controlled unless a trusted proxy sets them, so this takes the FIRST
// entry of x-forwarded-for (the original client as recorded by the closest trusted hop) rather than
// the last, and falls back to a shared bucket when nothing is available. A shared fallback bucket is
// deliberate: it is better for unidentifiable traffic to contend with itself than for every such
// request to get its own fresh allowance, which would make the limit trivially bypassable by
// stripping headers.
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

// Lookup is the expensive one: it fans out to vendor sites and search engines.
export const lookupLimiter = new RateLimiter(20, 60_000);
// Upload does no egress but buffers and hashes megabytes per call.
export const uploadLimiter = new RateLimiter(30, 60_000);

// Test seam. Production always uses the exported singletons above. Tests can substitute isolated
// instances so a rate-limit assertion in one test file does not consume another file's budget when
// the runner executes files in parallel. Never used outside tests.
let lookupOverride: RateLimiter | null = null;
let uploadOverride: RateLimiter | null = null;

export function __setLimiterOverrides(opts: { lookup?: RateLimiter; upload?: RateLimiter }): void {
  lookupOverride = opts.lookup ?? null;
  uploadOverride = opts.upload ?? null;
}

export function activeLookupLimiter(): RateLimiter {
  return lookupOverride ?? lookupLimiter;
}

export function activeUploadLimiter(): RateLimiter {
  return uploadOverride ?? uploadLimiter;
}

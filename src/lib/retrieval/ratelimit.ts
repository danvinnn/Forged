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
// KNOWN LIMIT, stated plainly: this is per-process. On a serverless platform each instance keeps
// its own counters, so the effective limit is roughly (limit x instances). That makes this a
// mitigation, not a guarantee. A real guarantee needs shared state (Redis, or the platform's own
// edge rate limiting) and should be added before any serious traffic. Per-process still stops the
// single-client hammering case, which is the common one.

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000
  ) {}

  check(key: string): RateLimitResult {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || existing.resetAt <= now) {
      this.evictIfNeeded();
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.limit - 1, retryAfterSeconds: 0 };
    }

    if (existing.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
      };
    }

    existing.count++;
    return { allowed: true, remaining: this.limit - existing.count, retryAfterSeconds: 0 };
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

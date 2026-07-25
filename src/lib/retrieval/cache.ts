// Resolution cache. Keyed by normalized part number plus manufacturer hint, holding the resolved
// DatasheetRef (a hit) or a tombstone (a confirmed miss).
//
// Air-gap safety: pure in-memory bookkeeping, no network, no imports that reach the network.
//
// Why this is a coverage feature and not just a speed feature: our target parts MISS in every
// resolver, and a miss walks the entire chain including the scrape resolver's DuckDuckGo crawl.
// Caching misses means the second person to type VA10820 is told to upload immediately instead of
// waiting out the whole chain again. Caching hits means a repeat lookup costs nothing and does not
// re-hit a vendor host, which also keeps us a polite client of ti.com and st.com.
//
// Deliberately in-process and bounded rather than persistent. A serverless deploy gets a warm cache
// per instance, which is enough to absorb the retry-and-refresh pattern a user actually produces.
// Persisting resolved bytes to disk would raise a controlled-data question we do not want in Layer
// 1: cached PDFs would outlive the request in enterprise deployments. Memory only, and it dies with
// the process.

import type { DatasheetRef } from "./resolver";

// Hits are stable: a datasheet URL for a released part rarely changes within a session.
export const HIT_TTL_MS = 60 * 60 * 1000; // 1 hour
// Misses expire faster. A miss can be caused by a transient vendor outage, and we do not want to
// lock someone out of lookup for an hour because ti.com blipped once.
export const MISS_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_ENTRIES = 500;

interface CacheEntry {
  ref: DatasheetRef | null; // null is a tombstone: a confirmed miss
  expiresAt: number;
}

export function cacheKey(partNumber: string, manufacturer?: string): string {
  const part = partNumber.trim().toUpperCase().replace(/\s+/g, "");
  const mfr = manufacturer?.trim().toLowerCase() ?? "";
  return `${part}|${mfr}`;
}

export class ResolutionCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly hitTtlMs = HIT_TTL_MS,
    private readonly missTtlMs = MISS_TTL_MS,
    private readonly maxEntries = MAX_ENTRIES
  ) {}

  // Returns undefined for "not cached", which is distinct from a cached null meaning
  // "cached, and the answer was definitively no datasheet".
  get(key: string): DatasheetRef | null | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency for the LRU eviction below.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.ref;
  }

  set(key: string, ref: DatasheetRef | null): void {
    const ttl = ref ? this.hitTtlMs : this.missTtlMs;
    this.entries.delete(key);
    this.entries.set(key, { ref, expiresAt: Date.now() + ttl });

    // Bounded so a long-lived process cannot accumulate PDF bytes without limit. Map preserves
    // insertion order, so the first key is the least recently used.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

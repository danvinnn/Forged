// Wraps any DatasheetResolver with the resolution cache.
//
// Lives in the resolver subtree because it only ever wraps network resolvers, though it makes no
// network call itself. Never constructed in air-gapped mode, because no resolver is.
//
// Placed OUTSIDE the composite rather than inside it, so one cache entry covers the whole chain.
// Caching per child would mean a miss still walks every resolver to discover that each one
// individually missed, which defeats the point for our rad-hard parts.
//
// Errors are deliberately NOT cached. A thrown ResolverError means something was broken or
// throttled, not that the part has no datasheet, and caching that would extend an outage past its
// actual duration.

import type { DatasheetRef, DatasheetResolver, ResolveOptions } from "../resolver";
import { ResolutionCache, cacheKey } from "../cache";

export class CachingResolver implements DatasheetResolver {
  readonly name: string;

  // In-flight requests, keyed the same way as the cache. This is single-flight coalescing: if ten
  // users ask for the same part in the same second, the cache cannot help because nothing has
  // finished yet, and without this we would walk the whole chain ten times and hit ti.com ten
  // times. At consumer volume that is both wasteful and the fastest way to get our egress IP
  // throttled by a vendor. They now share one walk.
  private readonly inFlight = new Map<string, Promise<DatasheetRef | null>>();

  constructor(
    private readonly inner: DatasheetResolver,
    private readonly cache: ResolutionCache = new ResolutionCache()
  ) {
    // Transparent in provenance: report the wrapped resolver's name so `resolvedBy` and the audit
    // trail never say "cached", which would tell an auditor nothing about where the PDF came from.
    this.name = inner.name;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  async resolve(partNumber: string, opts?: ResolveOptions): Promise<DatasheetRef | null> {
    const key = cacheKey(partNumber, opts?.manufacturer);

    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.inner
      .resolve(partNumber, opts)
      .then((ref) => {
        this.cache.set(key, ref);
        return ref;
      })
      .finally(() => {
        // Always clear, including on rejection, so a failure does not wedge the key permanently.
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, pending);
    return pending;
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { ResolutionCache, cacheKey } from "../cache";
import { CachingResolver } from "../resolvers/caching";
import { ResolverError } from "../resolvers/errors";
import type { DatasheetRef, DatasheetResolver, ResolveOptions } from "../resolver";

function ref(name: string): DatasheetRef {
  return {
    fileName: `${name}.pdf`,
    pdfUrl: `https://example.test/${name}.pdf`,
    bytes: new ArrayBuffer(8),
    byteLength: 8,
    sha256: "0".repeat(64)
  };
}

// --- key normalization ---
test("cache key normalizes case, whitespace, and the manufacturer hint", () => {
  assert.equal(cacheKey(" lmp7704-sp ", "Texas Instruments"), cacheKey("LMP7704-SP", "texas instruments"));
  // A different hint is a different lookup: it changes which vendor claims the part.
  assert.notEqual(cacheKey("LMP7704-SP", "TI"), cacheKey("LMP7704-SP", "Analog Devices"));
});

// --- cache semantics ---
test("distinguishes not-cached from cached-miss", () => {
  const cache = new ResolutionCache();
  assert.equal(cache.get("absent"), undefined); // never looked up
  cache.set("known-miss", null);
  assert.equal(cache.get("known-miss"), null); // looked up, definitively no datasheet
});

test("hits and misses expire on their own TTLs", () => {
  const cache = new ResolutionCache(1000, 0); // misses expire immediately
  cache.set("hit", ref("a"));
  cache.set("miss", null);
  assert.ok(cache.get("hit"));
  // A miss can be caused by a transient vendor outage, so it must not lock lookup out for long.
  assert.equal(cache.get("miss"), undefined);
});

test("evicts least recently used beyond the bound", () => {
  const cache = new ResolutionCache(60_000, 60_000, 2);
  cache.set("a", ref("a"));
  cache.set("b", ref("b"));
  cache.get("a"); // refresh a, making b the least recently used
  cache.set("c", ref("c"));
  assert.equal(cache.size, 2);
  assert.ok(cache.get("a"), "a was recently used and should survive");
  assert.equal(cache.get("b"), undefined, "b was least recently used and should be evicted");
});

// --- CachingResolver ---
class CountingStub implements DatasheetResolver {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly behavior: () => Promise<DatasheetRef | null>
  ) {}
  isConfigured(): boolean {
    return true;
  }
  resolve(_p: string, _o?: ResolveOptions): Promise<DatasheetRef | null> {
    this.calls++;
    return this.behavior();
  }
}

test("a repeated hit is served from cache without re-calling the resolver", async () => {
  const inner = new CountingStub("composite(manufacturer,scrape)", async () => ref("hit"));
  const resolver = new CachingResolver(inner, new ResolutionCache());
  await resolver.resolve("LMP7704-SP", { manufacturer: "TI" });
  const second = await resolver.resolve("LMP7704-SP", { manufacturer: "TI" });
  assert.equal(second?.fileName, "hit.pdf");
  assert.equal(inner.calls, 1, "second lookup must not hit the network again");
});

test("a repeated MISS is served from cache: the rad-hard case this exists for", async () => {
  // VA10820 misses every resolver, and that walk includes scrape's DuckDuckGo crawl. The second
  // person to type it should be told to upload immediately rather than pay that cost again.
  const inner = new CountingStub("composite(manufacturer,scrape)", async () => null);
  const resolver = new CachingResolver(inner, new ResolutionCache());
  assert.equal(await resolver.resolve("VA10820", { manufacturer: "VORAGO" }), null);
  assert.equal(await resolver.resolve("VA10820", { manufacturer: "VORAGO" }), null);
  assert.equal(inner.calls, 1, "a confirmed miss must not re-walk the whole chain");
});

test("errors are NOT cached, so an outage does not outlive itself", async () => {
  let attempt = 0;
  const inner = new CountingStub("flaky", async () => {
    attempt++;
    if (attempt === 1) throw new ResolverError("transport", "flaky", "boom");
    return ref("recovered");
  });
  const resolver = new CachingResolver(inner, new ResolutionCache());
  await assert.rejects(() => resolver.resolve("LMP7704-SP"));
  // The retry must actually retry. A cached error would extend the outage past its real duration.
  const out = await resolver.resolve("LMP7704-SP");
  assert.equal(out?.fileName, "recovered.pdf");
  assert.equal(inner.calls, 2);
});

test("caching is transparent in provenance: it reports the wrapped resolver's name", () => {
  // The audit trail must say where the PDF came from, never "cached", which tells an auditor
  // nothing about the source.
  const inner = new CountingStub("composite(manufacturer,scrape)", async () => null);
  assert.equal(new CachingResolver(inner).name, "composite(manufacturer,scrape)");
});

test("a different manufacturer hint is a separate cache entry", async () => {
  const inner = new CountingStub("chain", async () => ref("x"));
  const resolver = new CachingResolver(inner, new ResolutionCache());
  await resolver.resolve("AD590", { manufacturer: "Analog Devices" });
  await resolver.resolve("AD590", { manufacturer: "Texas Instruments" });
  assert.equal(inner.calls, 2, "the hint changes which vendor claims the part, so it must not share");
});

// --- Single-flight coalescing -----------------------------------------------------------------
// The cache cannot help concurrent callers, because nothing has finished yet. Without coalescing,
// ten simultaneous lookups of the same part walk the chain ten times and hit the vendor ten times,
// which at consumer volume is the fastest way to get our egress IP throttled.

test("concurrent lookups of the same part share ONE chain walk", async () => {
  let inFlightPeak = 0;
  let active = 0;
  const inner = new CountingStub("chain", async () => {
    active++;
    inFlightPeak = Math.max(inFlightPeak, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return ref("shared");
  });
  const resolver = new CachingResolver(inner, new ResolutionCache());

  const results = await Promise.all(
    Array.from({ length: 10 }, () => resolver.resolve("LMP7704-SP", { manufacturer: "TI" }))
  );

  assert.equal(inner.calls, 1, "ten concurrent callers must produce one chain walk");
  assert.equal(inFlightPeak, 1);
  assert.ok(results.every((r) => r?.fileName === "shared.pdf"), "all callers get the same answer");
});

test("a failed in-flight request does not wedge the key", async () => {
  let attempt = 0;
  const inner = new CountingStub("flaky", async () => {
    attempt++;
    if (attempt === 1) throw new ResolverError("transport", "flaky", "boom");
    return ref("recovered");
  });
  const resolver = new CachingResolver(inner, new ResolutionCache());

  await assert.rejects(() => resolver.resolve("LMP7704-SP"));
  // If the in-flight entry were not cleared on rejection, this would return the same rejection
  // forever and the part would be permanently unlookupable.
  const out = await resolver.resolve("LMP7704-SP");
  assert.equal(out?.fileName, "recovered.pdf");
});

test("different parts are not coalesced together", async () => {
  const inner = new CountingStub("chain", async () => {
    await new Promise((r) => setTimeout(r, 10));
    return ref("x");
  });
  const resolver = new CachingResolver(inner, new ResolutionCache());
  await Promise.all([resolver.resolve("LMP7704-SP"), resolver.resolve("RHF310A")]);
  assert.equal(inner.calls, 2);
});

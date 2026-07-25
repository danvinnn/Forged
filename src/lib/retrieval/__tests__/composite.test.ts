import { test } from "node:test";
import assert from "node:assert/strict";
import { CompositeResolver } from "../resolvers/composite";
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

class Stub implements DatasheetResolver {
  constructor(
    readonly name: string,
    private readonly configured: boolean,
    private readonly behavior: () => Promise<DatasheetRef | null>
  ) {}
  isConfigured(): boolean {
    return this.configured;
  }
  resolve(_partNumber: string, _opts?: ResolveOptions): Promise<DatasheetRef | null> {
    return this.behavior();
  }
}

test("returns the first hit and does not call later resolvers", async () => {
  let secondCalled = false;
  const composite = new CompositeResolver([
    new Stub("first", true, async () => ref("first")),
    new Stub("second", true, async () => {
      secondCalled = true;
      return ref("second");
    })
  ]);
  const out = await composite.resolve("LMP7704-SP");
  assert.equal(out?.fileName, "first.pdf");
  assert.equal(secondCalled, false);
});

test("skips an unconfigured resolver and uses the next", async () => {
  let primaryCalled = false;
  const composite = new CompositeResolver([
    new Stub("primary", false, async () => {
      primaryCalled = true;
      return ref("primary");
    }),
    new Stub("fallback", true, async () => ref("fallback"))
  ]);
  const out = await composite.resolve("LMP7704-SP");
  assert.equal(out?.fileName, "fallback.pdf");
  assert.equal(primaryCalled, false); // never even invoked
});

test("clean nulls from all resolvers return null (caller falls back to upload)", async () => {
  const composite = new CompositeResolver([
    new Stub("a", true, async () => null),
    new Stub("b", true, async () => null)
  ]);
  assert.equal(await composite.resolve("LMP7704-SP"), null);
});

test("a HARD failure with no hit surfaces as an aggregate error", async () => {
  const composite = new CompositeResolver([
    new Stub("primary", true, async () => {
      throw new ResolverError("auth", "primary", "token auth failed: 401");
    }),
    new Stub("scrape", true, async () => null)
  ]);
  await assert.rejects(() => composite.resolve("LMP7704-SP"), /primary: token auth failed: 401/);
});

test("a SOFT failure with no hit returns null so the user can upload", async () => {
  const composite = new CompositeResolver([
    new Stub("primary", true, async () => {
      throw new ResolverError("rate_limit", "primary", "query rate limited: 429");
    }),
    new Stub("scrape", true, async () => null)
  ]);
  // A rate limit or transport blip must never block the fallback to upload.
  assert.equal(await composite.resolve("LMP7704-SP"), null);
});

test("an unexpected (non-ResolverError) throw is treated as hard", async () => {
  const composite = new CompositeResolver([
    new Stub("scrape", true, async () => {
      throw new Error("boom");
    })
  ]);
  await assert.rejects(() => composite.resolve("LMP7704-SP"), /scrape: boom/);
});

test("a failure is ignored when a later resolver still finds a datasheet", async () => {
  const composite = new CompositeResolver([
    new Stub("primary", true, async () => {
      throw new ResolverError("transport", "primary", "boom");
    }),
    new Stub("scrape", true, async () => ref("scrape"))
  ]);
  const out = await composite.resolve("LMP7704-SP");
  assert.equal(out?.fileName, "scrape.pdf");
});

// --- Chain budget -----------------------------------------------------------------------------
// Rad-hard parts miss in every resolver, so the full-chain walk is the common path. The budget
// bounds how long a user waits before being told to upload.

function slowStub(name: string, delayMs: number): DatasheetResolver {
  return {
    name,
    isConfigured: () => true,
    resolve: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return null;
    }
  };
}

test("stops starting resolvers once the chain budget is spent", async () => {
  let thirdCalled = false;
  const composite = new CompositeResolver(
    [
      slowStub("slow-a", 40),
      slowStub("slow-b", 40),
      {
        name: "never",
        isConfigured: () => true,
        resolve: async () => {
          thirdCalled = true;
          return ref("never");
        }
      }
    ],
    { budgetMs: 50 }
  );

  const out = await composite.resolve("VA10820");
  // Budget cutout with no hard failure is a clean null: "upload instead" is the actionable answer.
  assert.equal(out, null);
  assert.equal(thirdCalled, false, "third resolver should be skipped once the budget is spent");
});

test("a generous budget does not interfere with a normal hit", async () => {
  const composite = new CompositeResolver(
    [slowStub("slow", 10), new Stub("hit", true, async () => ref("hit"))],
    { budgetMs: 5_000 }
  );
  const out = await composite.resolve("LMP7704-SP");
  assert.equal(out?.fileName, "hit.pdf");
});

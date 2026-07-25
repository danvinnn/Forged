import { test } from "node:test";
import assert from "node:assert/strict";
import { makeResolver } from "../factory";

test("air-gapped mode never constructs a resolver", async () => {
  assert.equal(await makeResolver("air-gapped"), null);
});

test("commercial mode returns a resolver", async () => {
  const resolver = await makeResolver("commercial");
  assert.ok(resolver);
  // Order is priority: manufacturer (free, deterministic, one GET) runs before scrape (a
  // DuckDuckGo crawl), so the common case never touches a search engine.
  assert.match(resolver!.name, /^composite\(manufacturer,scrape\)$/);
});

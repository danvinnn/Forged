import { test } from "node:test";
import assert from "node:assert/strict";
import { makeResolver } from "../factory";

test("air-gapped mode never constructs a resolver", async () => {
  assert.equal(await makeResolver("air-gapped"), null);
});

test("commercial mode returns a resolver", async () => {
  const resolver = await makeResolver("commercial");
  assert.ok(resolver);
  // Nexar primary, scrape fallback, both present behind the composite.
  assert.match(resolver!.name, /^composite\(nexar,scrape\)$/);
});

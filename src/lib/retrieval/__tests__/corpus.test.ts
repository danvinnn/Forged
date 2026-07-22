import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Merge-blocking gate protecting the air-gap story: no controlled or customer datasheet may live
// in the repo. Every PDF under test-data/ must be an explicitly allowlisted public part.
test("test-data contains only allowlisted public datasheets", () => {
  const dir = join(process.cwd(), "test-data");

  const allowlist = new Set(
    readFileSync(join(dir, "ALLOWLIST.txt"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
  );

  const pdfs = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .map((name) => name.replace(/\.pdf$/i, ""));

  const unlisted = pdfs.filter((base) => !allowlist.has(base));
  assert.deepEqual(
    unlisted,
    [],
    `Unlisted datasheets in test-data/: ${unlisted.join(", ")}. Add the public part to test-data/ALLOWLIST.txt, or remove the file if it is not public.`
  );
});

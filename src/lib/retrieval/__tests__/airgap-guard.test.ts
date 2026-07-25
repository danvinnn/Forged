import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RETRIEVAL_DIR = join(process.cwd(), "src", "lib", "retrieval");

// Strip line and block comments so prose that mentions "fetch()" does not trip the scan.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function code(relativePath: string): string {
  return stripComments(readFileSync(join(RETRIEVAL_DIR, relativePath), "utf8"));
}

// These modules are reachable in air-gapped mode (route -> factory/upload/index -> here).
// None of them may contain networking code. This is the property that makes the air-gap
// guard structural: the code that fetches is not merely uncalled, it is not present in the
// air-gapped module graph.
const AIR_GAP_SAFE = [
  "deployment.ts",
  "resolver.ts",
  "upload.ts",
  "factory.ts",
  "index.ts",
  "contracts.ts",
  "pdf.ts",
  "filename.ts",
  "hash.ts",
  "ref.ts",
  "partnumber.ts",
  "cache.ts",
  "ratelimit.ts"
];

test("air-gap-safe modules contain no fetch call", () => {
  for (const file of AIR_GAP_SAFE) {
    assert.doesNotMatch(code(file), /\bfetch\s*\(/, `${file} must not call fetch`);
  }
});

test("air-gap-safe modules contain no external URL literals", () => {
  for (const file of AIR_GAP_SAFE) {
    assert.doesNotMatch(code(file), /https?:\/\//, `${file} must not contain an external URL`);
  }
});

test("factory reaches the network subtree only through a dynamic import", () => {
  const factory = code("factory.ts");
  // No static import from the resolvers subtree.
  assert.doesNotMatch(factory, /^\s*import\s+[^;]*from\s+["']\.\/resolvers/m, "factory must not statically import resolvers");
  // The only reference to it is a dynamic import.
  assert.match(factory, /await\s+import\(\s*["']\.\/resolvers\/commercial["']\s*\)/, "factory must dynamic-import the commercial subtree");
});

test("the public index does not re-export the network subtree", () => {
  assert.doesNotMatch(code("index.ts"), /from\s+["']\.\/resolvers/, "index must not surface the network resolvers");
});

// --- The scan list must not silently fall out of date -----------------------------------------
// AIR_GAP_SAFE is hand-maintained, which means a new air-gap-reachable module can be added and
// simply never scanned. This catches that: every .ts file directly in the retrieval root (not the
// resolvers/ subtree, which is allowed to fetch, and not tests or benches) must be on the list.
// If this fails, either add the file to AIR_GAP_SAFE or move it under resolvers/ deliberately.
test("every retrieval-root module is accounted for in the air-gap scan", () => {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const present = readdirSync(RETRIEVAL_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));

  const listed = new Set(AIR_GAP_SAFE);
  const missing = present.filter((name) => !listed.has(name));

  assert.deepEqual(
    missing,
    [],
    `these retrieval-root modules are not covered by the air-gap scan: ${missing.join(", ")}. ` +
      `Add each to AIR_GAP_SAFE, or move it under resolvers/ if it is allowed to reach the network.`
  );
});

// The parse route contains the cloud-extractor (Gemini) import. It must reach that import ONLY
// through a dynamic import inside a commercial-mode branch, exactly like the resolver factory, so
// air-gapped mode never loads the cloud module. This asserts the structural property, not just the
// runtime gate the route tests cover.
test("the parse route reaches the cloud extractor only via dynamic import", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const route = stripComments(
    readFileSync(join(process.cwd(), "src", "app", "api", "parse", "route.ts"), "utf8")
  );
  // No static import of the gemini module.
  assert.doesNotMatch(
    route,
    /^\s*import\s+[^;]*from\s+["'][^"']*datasheet-gemini/m,
    "parse route must not statically import the cloud extractor"
  );
  // It is reached through a dynamic import, and that import is inside a commercial-mode gate.
  assert.match(route, /await\s+import\(\s*["'][^"']*datasheet-gemini["']\s*\)/, "must be dynamic-imported");
  assert.match(route, /mode\s*===\s*["']commercial["']/, "the cloud call must be gated on commercial mode");
});

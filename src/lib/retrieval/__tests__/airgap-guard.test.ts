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
  "ref.ts"
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

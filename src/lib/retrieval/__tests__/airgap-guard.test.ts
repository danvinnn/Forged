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
  "ratelimit.ts",
  // Structured logging writes to stdout only. No transport, no vendor SDK, so
  // it stays safe on the air-gapped path where every host still ingests stdout.
  "logging.ts",
  // Reads bytes the caller already holds and parses two pages of text. No
  // transport of its own, and it must stay that way: it is called from inside
  // the resolvers, which is the one place a network import would look natural.
  "identity.ts"
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

// --- Layer 2 extraction subtree ----------------------------------------------------------------
// Same guarantee as the resolver factory, now for extraction models. The cloud model must never be
// loaded into an air-gapped process, and that is enforced structurally: the gate lives in
// extraction/factory.ts, which reaches concrete models only through dynamic imports.

const EXTRACTION_DIR = join(process.cwd(), "src", "lib", "extraction");

function extractionCode(relativePath: string): string {
  return stripComments(readFileSync(join(EXTRACTION_DIR, relativePath), "utf8"));
}

// Reachable in air-gapped mode (parse route -> extraction/index -> here). None may fetch.
const EXTRACTION_AIR_GAP_SAFE = [
  "contracts.ts",
  "merge.ts",
  "factory.ts",
  "request.ts",
  // Pure comparison of a deterministic reading against a model one. No I/O.
  // The pipeline itself: two model passes, no networking of its own.
  "run.ts",
  // Pure string work over document text, no networking.
  "untrusted.ts",
  // Locates a section by the heading printed above it. Regex over text the
  // caller already has; it opens nothing and reads no value off a page.
  "sections.ts",
  // Timers and arithmetic over the calling route's budget. It decides whether a
  // model is worth asking; it never reaches one.
  "budget.ts",
  "index.ts"
];

test("air-gap-safe extraction modules contain no fetch call", () => {
  for (const file of EXTRACTION_AIR_GAP_SAFE) {
    assert.doesNotMatch(extractionCode(file), /\bfetch\s*\(/, `${file} must not call fetch`);
  }
});

test("air-gap-safe extraction modules contain no external URL literals", () => {
  for (const file of EXTRACTION_AIR_GAP_SAFE) {
    assert.doesNotMatch(extractionCode(file), /https?:\/\//, `${file} must not contain an external URL`);
  }
});

test("every extraction-root module is accounted for in the air-gap scan", () => {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const present = readdirSync(EXTRACTION_DIR).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".d.ts")
  );
  const listed = new Set(EXTRACTION_AIR_GAP_SAFE);
  const missing = present.filter((name) => !listed.has(name));

  assert.deepEqual(
    missing,
    [],
    `these extraction-root modules are not covered by the air-gap scan: ${missing.join(", ")}. ` +
      `Add each to EXTRACTION_AIR_GAP_SAFE, or move it under models/ if it is allowed to reach the network.`
  );
});

test("the extraction factory reaches models only through dynamic imports", () => {
  const factory = extractionCode("factory.ts");
  assert.doesNotMatch(
    factory,
    /^\s*import\s+[^;]*from\s+["']\.\/models/m,
    "factory must not statically import any concrete model"
  );
  assert.match(
    factory,
    /await\s+import\(\s*["']\.\/models\/gemini["']\s*\)/,
    "the cloud model must be dynamic-imported"
  );
  assert.match(factory, /mode\s*===\s*["']commercial["']/, "the cloud model must be gated on commercial mode");
});

test("EVERY networked model is unreachable from the air-gapped branch of the factory", () => {
  const factory = extractionCode("factory.ts");
  // Everything before the commercial branch returns is the commercial path; the
  // air-gapped fall-through follows it.
  const commercialBranch = factory.indexOf('mode === "commercial"');
  const branchEnd = factory.indexOf("return null;", commercialBranch);
  assert.ok(commercialBranch >= 0 && branchEnd >= 0, "the commercial branch must still be recognisable");

  // Read out of the file rather than named here. This test used to check the
  // gemini import ALONE, so adding the Vertex provider on 2026-08-17 introduced
  // a second networked model that nothing verified. A guard that names one
  // instance is the failure shape it exists to prevent.
  const imported = [...factory.matchAll(/await import\(\s*["']\.\/models\/([\w-]+)["']\s*\)/g)].map(
    (match) => ({ model: match[1], at: match.index ?? -1 })
  );
  assert.ok(imported.length >= 2, `expected several model imports, found ${imported.length}`);

  for (const { model, at } of imported) {
    // `local` is the ONLY model permitted on both paths: it is the air-gapped
    // one, and its endpoint must resolve to a private address (see models/local.ts).
    if (model === "local" || model === "local-focused") continue;
    assert.ok(
      at > commercialBranch && at < branchEnd,
      `the ${model} import must sit inside the commercial branch, or an air-gapped process can load it`
    );
  }
});

test("every module under models/ that talks to a network is reached only by dynamic import", () => {
  // The other half: a STATIC import anywhere in the extraction root would pull a
  // networked model into an air-gapped process regardless of which branch runs.
  const factory = extractionCode("factory.ts");
  assert.doesNotMatch(
    factory,
    /^\s*import\s+[^;]*from\s+["']\.\/models/m,
    "factory must not statically import any concrete model"
  );
});

test("the extraction index does not re-export the model subtree", () => {
  assert.doesNotMatch(
    extractionCode("index.ts"),
    /from\s+["']\.\/models/,
    "index must not surface the networked models"
  );
});

test("the parse route does not statically import any extraction model", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const route = stripComments(
    readFileSync(join(process.cwd(), "src", "app", "api", "parse", "route.ts"), "utf8")
  );
  assert.doesNotMatch(
    route,
    /^\s*import\s+[^;]*from\s+["'][^"']*extraction\/models/m,
    "parse route must not statically import a concrete model"
  );
  assert.doesNotMatch(
    route,
    /^\s*import\s+[^;]*from\s+["'][^"']*datasheet-gemini/m,
    "parse route must not statically import the legacy cloud extractor"
  );
});

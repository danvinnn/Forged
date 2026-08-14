// Extraction coverage benchmark.
//
// The retrieval benchmark answers "can we FIND the datasheet". This answers the question that
// actually decides whether the product is usable: "once we have it, how much can we READ, and is
// the result good enough to export".
//
// Why this exists: every statement about extraction quality so far has been an impression formed
// from four datasheets. That is exactly the kind of claim that has already been wrong twice in this
// repo. The retrieval benchmark found a substring bug that had survived several passes, and a
// four-vendor spot check found confident wrong answers on ST and ADI. Measure, then decide.
//
// Usage:
//   npm run bench:extraction                     all cached parts, parser only
//   npm run bench:extraction -- --fetch          fetch anything not cached (network, slow)
//   npm run bench:extraction -- --category analog
//
// With the model. Only the first of these can spend money:
//   ... -- --model                               replay cached answers, call live on a miss
//   ... -- --model --offline                     replay only, never call. Iterate here.
//   ... -- --model --estimate                    call nothing, report what a live run would cost
//   ... -- --model --refresh                     ignore the cache and re-ask everything
//   ... -- --model --parts LM358,INA240          just these parts
//
// Model answers are cached under .model-cache/ keyed by the request we would
// send, so a change downstream of the call (merging, the package table, the
// land pattern) re-measures the whole corpus for nothing. See modelcache.ts.
//
// PDFs are cached under .bench-cache/ (gitignored). They are NOT committed: the corpus allowlist
// rule for test-data/ exists so no datasheet is ever committed to a public repo, and a cache of 30+
// vendor PDFs would drive straight through it.
//
// Deliberately a report, not a test. It needs the network on first run and would make CI flaky for
// reasons unrelated to whatever is being reviewed.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BENCH_CORPUS, type BenchCategory, type BenchPart } from "../retrieval/__bench__/corpus";
import { extractPartRecord } from "../datasheet";
import { makeExtractionModel, runExtraction } from "../extraction";
import { resolveForExport, type Extracted, type PartRecord } from "../types";
import { createExportZip, FootprintUnavailableError } from "../exporters";
import {
  PINOUT_ORACLE,
  PACKAGE_ORACLE,
  checkPinNames,
  checkPackageFamily,
  type NameMismatch
} from "./pinout-oracle";
import {
  cachingModel,
  cacheSize,
  formatCacheStats,
  preRunProjection,
  projectCost,
  ModelCacheMiss,
  modelCacheDir,
  type CacheMode,
  type CachingModel
} from "./modelcache";
import { loadBenchEnv } from "./env";
import { getDeploymentMode } from "../retrieval/deployment";

const PINOUT_ORACLE_SIZE = Object.keys(PINOUT_ORACLE).length;

// This is a report read by a human. Resolver events are useful in production and
// noise here, so quiet the logger unless the caller asked for detail.
loadBenchEnv();

if (!process.env.FORGE_LOG_LEVEL) process.env.FORGE_LOG_LEVEL = "warn";

const FETCH = process.argv.includes("--fetch");
/**
 * Run the extraction MODEL as well as the parser. Off by default: it spends
 * money, needs the network, and a run with it on is not comparable to the
 * deterministic figures every doc quotes. On, it answers the only question that
 * matters commercially, which is how much the product reads with everything it
 * has.
 */
const MODEL = process.argv.includes("--model");
const categoryFlag = process.argv.indexOf("--category");
const ONLY_CATEGORY = categoryFlag !== -1 ? (process.argv[categoryFlag + 1] as BenchCategory) : null;

/**
 * How the model response cache behaves. See `modelcache.ts` for why it exists.
 *
 * `--offline` is the one to iterate in: it answers from disk and refuses to
 * spend, so a change to merging or the package table can be measured against
 * the full corpus for nothing.
 */
const CACHE_MODE: CacheMode = process.argv.includes("--refresh")
  ? "refresh"
  : process.argv.includes("--estimate")
    ? "estimate"
    : process.argv.includes("--offline")
      ? "offline"
      : "use";

/**
 * Run a named subset, e.g. `--parts LM358,INA240`.
 *
 * The cheapest lever there is. Chasing one defect does not need the other 43
 * parts, and before this the only choices were one category or everything.
 */
const partsFlag = process.argv.indexOf("--parts");
const ONLY_PARTS: Set<string> | null =
  partsFlag !== -1 && process.argv[partsFlag + 1]
    ? new Set(
        process.argv[partsFlag + 1]
          .split(",")
          .map((p) => p.trim().toUpperCase())
          .filter(Boolean)
      )
    : null;

const CACHE_DIR = join(process.cwd(), ".bench-cache");
const FETCH_DELAY_MS = 1500;

/**
 * The wrapped model, built once and shared, with the part name it is currently
 * working on. The cache only uses the label to name files readably; the request
 * hash alone decides what matches.
 */
let sharedModel: CachingModel | null | undefined;
let currentLabel = "";

async function benchModel(): Promise<CachingModel | null> {
  if (sharedModel !== undefined) return sharedModel;
  // Whichever model the environment says, NOT a hardcoded cloud one.
  //
  // Both benches used to pass "commercial" literally, so `FORGE_DEPLOYMENT_MODE`
  // had no effect here and a run intended for a local model silently went to
  // Gemini and was billed. Measured 2026-08-12: a run launched to test Ollama
  // produced 0 local cache entries and a $0.02 charge.
  let inner = await makeExtractionModel(getDeploymentMode());
  if (!inner && (CACHE_MODE === "offline" || CACHE_MODE === "estimate")) {
    // Replaying costs nothing and needs no credentials, so a run that cannot
    // spend must not require an API key to be present. Without this, iterating
    // offline would still depend on the billing state of an account it never
    // intends to call.
    inner = {
      name: "gemini",
      isConfigured: () => true,
      extract: async () => {
        throw new Error("offline stub model must never be called");
      }
    };
  }
  sharedModel = inner ? cachingModel(inner, CACHE_MODE, () => currentLabel) : null;
  return sharedModel;
}

/** Fields worth scoring. Grouped so the report says WHICH kind of extraction is failing. */
const SCORED = {
  identity: ["partNumber", "manufacturer"],
  package: ["packageType", "pinCount", "pins"],
  geometry: ["dimensions.bodyLengthMm", "dimensions.bodyWidthMm", "dimensions.pitchMm"],
  radiation: ["radiation.tid", "radiation.see", "radiation.sel", "radiation.qmlClass"]
} as const;

type Group = keyof typeof SCORED;

function fieldAt(part: PartRecord, path: string): Extracted<unknown> {
  if (!path.includes(".")) return part[path as "partNumber"];
  const [group, key] = path.split(".") as ["dimensions" | "radiation", string];
  return (part[group] as Record<string, Extracted<unknown>>)[key];
}

interface Row {
  part: BenchPart;
  status: "ok" | "no-pdf" | "error";
  detail: string;
  /** Per-group counts of fields with a non-null value. */
  filled: Record<Group, number>;
  cited: number;
  scored: number;
  pins: number;
  /** Fields are all present. NOT the same as a bundle coming out; see `ships`. */
  exportable: boolean;
  /**
   * A real bundle was produced by the real generator. This is the product
   * working, and it is the number to steer by: `exportable` only asks whether
   * fields are non-null and never calls the generator, which overstated the
   * product by more than 2x for the whole life of this benchmark.
   */
  ships: boolean;
  /** Fields the model filled that the parser could not. Empty unless --model. */
  modelFilled: string[];
  /** Fields the model answered in a shape that could not be trusted. */
  modelRejected: string[];
  /** Why no bundle came out, when the fields were all present. */
  refusedBy: string;
  blockedBy: string;
  /**
   * Packages this datasheet names which WOULD produce a bundle if the caller
   * picked one. Empty when the part already ships or when none of them would.
   *
   * This is the measurement the variant work exists to justify. Multi-package
   * ambiguity blocks more parts than any parsing defect, and every one of those
   * refusals is a document that names its packages and does not say which one is
   * in the caller's hand. The product's input model budgets one click for that,
   * so the number worth knowing is how many parts one click actually unlocks.
   */
  oneClickPackages: string[];
  /**
   * Packages that would produce a bundle once the caller also supplies a value
   * the datasheet cannot carry. Kept separate from `oneClickPackages` because a
   * number is more to ask than a click, and separate from the refusals because
   * this one is answerable at all.
   */
  oneClickPlusInput: string[];
  /**
   * Pin names that disagree with the oracle, which is the only check here that
   * looks at whether a value is RIGHT rather than merely present. Empty both when
   * the part is correct and when there is no oracle entry for it; `namesChecked`
   * separates those.
   */
  nameMismatches: NameMismatch[];
  namesChecked: boolean;
  /** The designator as extracted, for the package-family check. */
  packageType: string;
  /** Wall-clock time for the full text extraction plus deterministic pass, ms. */
  elapsedMs: number;
  pageCount: number;
}

/**
 * Does a real bundle come out?
 *
 * This calls the actual generator rather than asking whether the fields are
 * non-null, and the difference is the whole point. `resolveForExport` checks
 * that pinCount, pins and packageType are present; it never computes a land
 * pattern, so it counted nine parts as ready that the generator refuses. The
 * measured gap on 2026-07-27 was 16 fields-complete against 7 bundles produced.
 *
 * kicad is used because it is the format with no external oracle to build, so
 * this stays runnable anywhere. A part that ships in one format ships in all of
 * them: the generators read one shared geometry and none is derived from another.
 */
async function shipCheck(
  resolved: ReturnType<typeof resolveForExport>
): Promise<{ ships: boolean; refusedBy: string }> {
  if (!resolved.ok) return { ships: false, refusedBy: "" };
  try {
    await createExportZip(resolved.part, "kicad");
    return { ships: true, refusedBy: "" };
  } catch (error) {
    if (error instanceof FootprintUnavailableError) {
      // Two different refusals: one the user can answer, one that is our gap.
      return {
        ships: false,
        refusedBy: error.needs.length > 0 ? `needs ${error.needs.map((need) => need.field).join(",")}` : "no land pattern"
      };
    }
    return { ships: false, refusedBy: error instanceof Error ? error.message.slice(0, 40) : "unknown" };
  }
}

/**
 * Which of the datasheet's own packages would produce a bundle if named.
 *
 * Mirrors what `/api/export` does with a `packageType` override, including
 * dropping the drawing evidence: the outline code and the drawn pitch were read
 * off the one drawing confirmed to match the EXTRACTED designator, so against a
 * different package they describe the wrong part of the document.
 */
async function oneClickCheck(
  record: PartRecord
): Promise<{ oneClickPackages: string[]; oneClickPlusInput: string[] }> {
  const shipped: string[] = [];
  const answerable: string[] = [];

  for (const variant of record.packageVariants) {
    const resolved = resolveForExport({
      ...record,
      packageType: { ...record.packageType, value: variant.designator },
      packageOutlineCode: { value: null, confidence: null, method: null, citation: null },
      dimensions: {
        ...record.dimensions,
        pitchMm: { value: null, confidence: null, method: null, citation: null },
        leadWidthMm: { value: null, confidence: null, method: null, citation: null }
      }
    });
    if (!resolved.ok) continue;
    try {
      await createExportZip(resolved.part, "kicad");
      shipped.push(variant.designator);
    } catch (error) {
      // Two refusals, and the difference decides whose problem it is. `needs`
      // populated means the caller can answer it and get their footprint, which
      // for a ceramic flat pack is the formed lead span their own line trims to.
      // Empty means the package is not characterised, which is ours to fix.
      if (error instanceof FootprintUnavailableError && error.needs.length > 0) {
        answerable.push(`${variant.designator} + ${error.needs.map((need) => need.field).join(",")}`);
      }
    }
  }

  return { oneClickPackages: shipped, oneClickPlusInput: answerable };
}

/**
 * Compares the extracted pin names against the hand-read oracle.
 *
 * This is the only check in this benchmark that asks whether a value is RIGHT
 * rather than whether it is present, and it exists because six shipping parts
 * had wrong names while every number here looked healthy.
 */
function checkNames(
  partNumber: string,
  record: PartRecord
): { nameMismatches: NameMismatch[]; namesChecked: boolean } {
  const entry = PINOUT_ORACLE[partNumber];
  const pins = record.pins.value ?? [];
  if (!entry || pins.length === 0) return { nameMismatches: [], namesChecked: false };
  return { nameMismatches: checkPinNames(entry, pins), namesChecked: true };
}

function cachePath(partNumber: string): string {
  return join(CACHE_DIR, `${partNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetches through the real resolver chain, so the cache reflects what users would actually get. */
async function fetchToCache(part: BenchPart): Promise<boolean> {
  const { makeResolver } = await import("../retrieval/factory");
  const resolver = await makeResolver("commercial");
  if (!resolver) return false;

  try {
    const ref = await resolver.resolve(
      part.partNumber,
      part.manufacturer ? { manufacturer: part.manufacturer } : undefined
    );
    if (!ref) return false;
    writeFileSync(cachePath(part.partNumber), Buffer.from(ref.bytes));
    return true;
  } catch {
    return false;
  }
}

async function scoreRow(part: BenchPart): Promise<Row> {
  const empty: Record<Group, number> = { identity: 0, package: 0, geometry: 0, radiation: 0 };
  const path = cachePath(part.partNumber);

  if (!existsSync(path)) {
    return {
      part,
      status: "no-pdf",
      detail: FETCH ? "not resolvable" : "not cached (run with --fetch)",
      filled: empty,
      cited: 0,
      scored: 0,
      pins: 0,
      exportable: false,
      ships: false,
      modelFilled: [],
      modelRejected: [],
      refusedBy: "",
      blockedBy: "no datasheet",
      oneClickPackages: [],
      oneClickPlusInput: [],
      nameMismatches: [],
      namesChecked: false,
      packageType: "",
      elapsedMs: 0,
      pageCount: 0
    };
  }

  const bytes = readFileSync(path);
  const startedAt = performance.now();
  try {
    const { doc, part: deterministic } = await extractPartRecord(
      `${part.partNumber}.pdf`,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    );

    // The model pass, opt-in and OFF by default. It costs money, needs the
    // network, and would make the default run non-comparable with every number
    // in DEFERRED.md. With --model this reports what the product does when a
    // model is configured; without it, what the parser does alone.
    let record = deterministic;
    let modelFilled: string[] = [];
    let modelRejected: string[] = [];
    if (MODEL) {
      const model = await benchModel();
      if (model) {
        currentLabel = part.partNumber;
        try {
          const outcome = await runExtraction(
            deterministic,
            doc,
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
            model,
            `${part.partNumber}.pdf`
          );
          if (outcome) {
            record = outcome.part;
            modelFilled = outcome.filled;
            modelRejected = outcome.rejected.map((entry) => entry.field);
          }
        } catch (error) {
          // A model failure must not cost the deterministic row, exactly as in
          // the parse route. It is recorded so the run is not silently partial.
          //
          // A cache miss is called out separately from a real failure. It means
          // "this run declined to ask", which says nothing about the extractor
          // and must not be read as one.
          modelRejected = [
            error instanceof ModelCacheMiss
              ? "UNCACHED"
              : `ERROR:${error instanceof Error ? error.name : "unknown"}`
          ];
        }
        // Free-tier rate limits are per minute; without this the run 429s. A
        // replayed answer touched no network, so waiting for it is pure delay:
        // this is what makes a fully cached 44-part run finish in seconds.
        // Pacing lives in `cachingModel` now, against a rolling window that counts
        // retries too. A flat sleep here cannot see them and so could not hold the
        // limit; it is kept only as a floor between parts.
      }
    }

    const filled: Record<Group, number> = { ...empty };
    let cited = 0;
    let scored = 0;

    for (const [group, paths] of Object.entries(SCORED) as Array<[Group, readonly string[]]>) {
      for (const fieldPath of paths) {
        scored++;
        const field = fieldAt(record, fieldPath);
        if (field.value !== null) {
          // The part number is the one scored field whose CORRECTNESS we can
          // check, because the corpus knows what part this is. Everything else
          // is scored as "did we get a value", which is why identity used to
          // read 99% while returning JESD22-C101 for a UCC27524: a JEDEC test
          // standard is a value, it is just not the part. A number that cannot
          // be wrong is not a measurement.
          const correct =
            fieldPath !== "partNumber" ||
            String(field.value).toUpperCase() === part.partNumber.toUpperCase();
          if (correct) {
            filled[group]++;
            if (field.citation) cited++;
          }
        }
      }
    }

    const resolved = resolveForExport(record);
    const shipped = await shipCheck(resolved);
    return {
      part,
      status: "ok",
      detail: "",
      packageType: record.packageType.value ?? "",
      filled,
      cited,
      scored,
      pins: (record.pins.value ?? []).length,
      exportable: resolved.ok,
      modelFilled,
      modelRejected,
      ...shipped,
      // Only asked when the part does not already ship, because that is the only
      // case where naming a package changes the answer.
      ...(shipped.ships
        ? { oneClickPackages: [], oneClickPlusInput: [] }
        : await oneClickCheck(record)),
      ...checkNames(part.partNumber, record),
      blockedBy: resolved.ok
        ? ""
        : resolved.missing.length > 0
          ? `missing ${resolved.missing.join(",")}`
          : `untraceable ${resolved.untraceable?.join(",")}`,
      elapsedMs: performance.now() - startedAt,
      pageCount: doc.pageCount
    };
  } catch (error) {
    return {
      part,
      status: "error",
      detail: error instanceof Error ? error.message.slice(0, 60) : "unknown",
      filled: empty,
      cited: 0,
      scored: 0,
      pins: 0,
      exportable: false,
      ships: false,
      modelFilled: [],
      modelRejected: [],
      refusedBy: "",
      blockedBy: "parse error",
      oneClickPackages: [],
      oneClickPlusInput: [],
      nameMismatches: [],
      namesChecked: false,
      packageType: "",
      elapsedMs: performance.now() - startedAt,
      pageCount: 0
    };
  }
}

/** Percentile from an unsorted sample, nearest-rank. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const pct = (n: number, d: number) => (d === 0 ? "  n/a" : `${String(Math.round((n / d) * 100)).padStart(3)}%`);

async function main() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  const corpus = BENCH_CORPUS.filter(
    (p) =>
      (!ONLY_CATEGORY || p.category === ONLY_CATEGORY) &&
      (!ONLY_PARTS || ONLY_PARTS.has(p.partNumber.toUpperCase()))
  );
  const cachedBefore = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".pdf")).length;

  if (ONLY_PARTS && corpus.length === 0) {
    console.log(`\nNo corpus part matches --parts ${[...ONLY_PARTS].join(",")}\n`);
    return;
  }

  const scope = [ONLY_CATEGORY, ONLY_PARTS ? `${corpus.length} named` : null].filter(Boolean).join(", ");
  console.log(`\nExtraction coverage: ${corpus.length} parts${scope ? ` (${scope})` : ""}`);
  console.log(`Cache: ${CACHE_DIR} (${cachedBefore} PDFs)${FETCH ? ", fetching missing" : ""}`);
  if (MODEL) {
    console.log(
      `Model cache: ${modelCacheDir()} (${cacheSize()} responses), mode ${CACHE_MODE}` +
        (CACHE_MODE === "use" || CACHE_MODE === "refresh" ? " [may spend]" : " [no spend]")
    );
  }
  console.log();

  if (FETCH) {
    let fetched = 0;
    for (const part of corpus) {
      if (existsSync(cachePath(part.partNumber))) continue;
      const ok = await fetchToCache(part);
      if (ok) fetched++;
      process.stdout.write(ok ? "." : "x");
      await sleep(FETCH_DELAY_MS);
    }
    console.log(`\n  fetched ${fetched} new PDFs\n`);
  }

  // What this run is about to cost, before it costs it. Same reasoning as the
  // hold-out bench: the spend ceiling stops a run after the money is gone, and
  // only this can stop one before.
  if (MODEL && (CACHE_MODE === "use" || CACHE_MODE === "refresh")) {
    const model = await benchModel();
    if (model) {
      const willVisit = corpus.filter((part) => existsSync(cachePath(part.partNumber))).length;
      console.log(preRunProjection({ parts: willVisit, callsPerPart: 2, modelName: model.name }));
      console.log();
    }
  }

  const rows: Row[] = [];
  for (const part of corpus) rows.push(await scoreRow(part));

  const withPdf = rows.filter((r) => r.status === "ok");

  // Per-category. The shape matters more than the total: strong identity extraction with zero pin
  // tables is a completely different problem from failing to read the document at all.
  const byCategory = new Map<BenchCategory, Row[]>();
  for (const row of rows) {
    const list = byCategory.get(row.part.category) ?? [];
    list.push(row);
    byCategory.set(row.part.category, list);
  }

  console.log("category              pdf    ident  pkg    geom   rad    cited  fields ships");
  console.log("-".repeat(76));
  for (const [category, list] of byCategory) {
    const ok = list.filter((r) => r.status === "ok");
    const sum = (g: Group) => ok.reduce((acc, r) => acc + r.filled[g], 0);
    const den = (g: Group) => ok.length * SCORED[g].length;
    console.log(
      `${category.padEnd(22)}${String(`${ok.length}/${list.length}`).padEnd(7)}` +
        `${pct(sum("identity"), den("identity")).padEnd(7)}` +
        `${pct(sum("package"), den("package")).padEnd(7)}` +
        `${pct(sum("geometry"), den("geometry")).padEnd(7)}` +
        `${pct(sum("radiation"), den("radiation")).padEnd(7)}` +
        `${pct(ok.reduce((a, r) => a + r.cited, 0), ok.reduce((a, r) => a + r.scored, 0)).padEnd(7)}` +
        `${pct(ok.filter((r) => r.exportable).length, ok.length).padEnd(7)}` +
        `${pct(ok.filter((r) => r.ships).length, ok.length)}`
    );
  }

  const allOk = withPdf;
  const sumAll = (g: Group) => allOk.reduce((acc, r) => acc + r.filled[g], 0);
  const denAll = (g: Group) => allOk.length * SCORED[g].length;
  console.log("-".repeat(76));
  console.log(
    `${"TOTAL".padEnd(22)}${String(`${allOk.length}/${rows.length}`).padEnd(7)}` +
      `${pct(sumAll("identity"), denAll("identity")).padEnd(7)}` +
      `${pct(sumAll("package"), denAll("package")).padEnd(7)}` +
      `${pct(sumAll("geometry"), denAll("geometry")).padEnd(7)}` +
      `${pct(sumAll("radiation"), denAll("radiation")).padEnd(7)}` +
      `${pct(allOk.reduce((a, r) => a + r.cited, 0), allOk.reduce((a, r) => a + r.scored, 0)).padEnd(7)}` +
      `${pct(allOk.filter((r) => r.exportable).length, allOk.length).padEnd(7)}` +
      `${pct(allOk.filter((r) => r.ships).length, allOk.length)}\n`
  );

  // Latency, because "is it correct" and "is it fast enough" are different
  // questions and only one of them was ever being measured. The parse budget is
  // 20s and the route's maxDuration is 30s, so p95 is the number that decides
  // whether real datasheets time out in production.
  const timed = withPdf.filter((r) => r.elapsedMs > 0);
  if (timed.length > 0) {
    const times = timed.map((r) => r.elapsedMs);
    const slowest = [...timed].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 3);
    console.log(
      `Parse latency over ${times.length} parts: ` +
        `p50 ${Math.round(percentile(times, 50))}ms, ` +
        `p95 ${Math.round(percentile(times, 95))}ms, ` +
        `max ${Math.round(Math.max(...times))}ms`
    );
    console.log(
      `Slowest: ${slowest.map((r) => `${r.part.partNumber} ${Math.round(r.elapsedMs)}ms/${r.pageCount}p`).join(", ")}\n`
    );
  }

  // The number that decides whether the product is usable end to end, and it is
  // the SECOND one. Fields being present is not a bundle: the generator refuses
  // packages it has no land pattern for, and asks for the values no datasheet
  // carries. Reporting only the first overstated the product by more than 2x.
  const exportable = allOk.filter((r) => r.exportable).length;
  const ships = allOk.filter((r) => r.ships).length;
  console.log(
    `Fields complete:  ${exportable}/${allOk.length} parsed parts (${pct(exportable, allOk.length).trim()})`
  );
  console.log(
    `SHIPS A BUNDLE:   ${ships}/${allOk.length} parsed parts (${pct(ships, allOk.length).trim()})   <- the product` +
      `\n${allOk.length}/${rows.length} of the corpus had a datasheet at all.\n`
  );

  // Parts whose fields are all present and which still produce nothing. This is
  // the actionable list that the old report could not see at all.
  const refused = allOk.filter((r) => r.exportable && !r.ships);
  if (refused.length > 0) {
    const reasons = new Map<string, string[]>();
    for (const row of refused) {
      reasons.set(row.refusedBy, [...(reasons.get(row.refusedBy) ?? []), row.part.partNumber]);
    }
    console.log("Fields complete but NO bundle:");
    for (const [reason, parts] of [...reasons].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(parts.length).padStart(3)}  ${reason.padEnd(24)} ${parts.join(", ")}`);
    }
    console.log("");
  }

  // Whether the names are RIGHT, which is the one thing here that is not a count.
  // Reported before the coverage lists because a wrong name is worse than a
  // missing one: a symbol wired to `VNCref` is a wrong netlist and it looks
  // exactly as authoritative as a correct one.
  const checked = allOk.filter((r) => r.namesChecked);
  const wrong = checked.filter((r) => r.nameMismatches.length > 0);
  console.log(
    `PIN NAMES:        ${checked.length - wrong.length}/${checked.length} parts match the hand-read oracle` +
      ` (${PINOUT_ORACLE_SIZE} parts have an entry)`
  );
  for (const row of wrong) {
    for (const miss of row.nameMismatches) {
      console.log(`  ${row.part.partNumber.padEnd(18)} pin ${miss.pin.padEnd(3)} got "${miss.got}" want "${miss.want}"`);
    }
  }
  // Whether the package DESIGNATOR is right, which nothing measured before this.
  // The `pkg` column above is a fill rate: it counts non-null fields and cannot
  // tell a right designator from a wrong one. The designator selects the land
  // pattern, so a wrong one does not fail, it produces a plausible footprint with
  // the wrong dimensions.
  const pkgChecked = allOk.filter((r) => PACKAGE_ORACLE[r.part.partNumber] && r.packageType);
  const pkgWrong: string[] = [];
  const pkgCeramicLost: string[] = [];
  for (const row of pkgChecked) {
    const verdict = checkPackageFamily(PACKAGE_ORACLE[row.part.partNumber], row.packageType);
    if (!verdict.ok) pkgWrong.push(`${row.part.partNumber} read "${row.packageType}"`);
    if (verdict.ceramicLost) pkgCeramicLost.push(`${row.part.partNumber} read "${row.packageType}"`);
  }
  console.log(
    `PACKAGE FAMILY:   ${pkgChecked.length - pkgWrong.length}/${pkgChecked.length} designators name a package the datasheet describes` +
      ` (${Object.keys(PACKAGE_ORACLE).length} parts have an entry)`
  );
  for (const line of pkgWrong) console.log(`  WRONG FAMILY   ${line}`);
  // A ceramic part whose designator lost the word is one characterised family
  // away from taking plastic geometry; see the guard in packages.ts.
  for (const line of pkgCeramicLost) console.log(`  CERAMIC LOST   ${line}`);
  console.log("");

  // What ONE CLICK would unlock. Reported next to the shipping figure rather than
  // folded into it: these parts do not ship today and the product does not
  // pretend they do. The point is that the refusal is answerable, and by whom.
  const oneClick = allOk.filter((r) => !r.ships && r.oneClickPackages.length > 0);
  if (oneClick.length > 0) {
    console.log(
      `ONE CLICK AWAY:   ${oneClick.length} more parts ship if the caller names a package ` +
        `(${ships} + ${oneClick.length} = ${ships + oneClick.length}/${allOk.length}, ` +
        `${pct(ships + oneClick.length, allOk.length).trim()})`
    );
    for (const row of oneClick) {
      console.log(`  ${row.part.partNumber.padEnd(18)} ${row.oneClickPackages.join(", ")}`);
    }
    console.log("");
  }

  // And what one click PLUS one number would unlock. Reported as its own line
  // because asking for a number is more than asking for a click, and because the
  // number in question is a property of the caller's own assembly line rather
  // than of the datasheet: a ceramic flat pack ships with straight leads and the
  // assembler chooses the trim, so nobody can read the seated span off the page.
  // A part whose EXTRACTED package already refuses answerably is counted there and
  // not again under its variants, which describe the same need by another name.
  const alreadyAnswerable = allOk.filter((r) => !r.ships && r.refusedBy.startsWith("needs "));
  const plusInput = allOk.filter(
    (r) =>
      !r.ships &&
      r.oneClickPackages.length === 0 &&
      r.oneClickPlusInput.length > 0 &&
      !alreadyAnswerable.includes(r)
  );
  const reachable = ships + oneClick.length + plusInput.length + alreadyAnswerable.length;
  if (plusInput.length > 0 || alreadyAnswerable.length > 0) {
    console.log(
      `PLUS ONE NUMBER:  ${plusInput.length + alreadyAnswerable.length} more ship once the caller supplies a value ` +
        `no datasheet carries (${reachable}/${allOk.length} reachable, ${pct(reachable, allOk.length).trim()})`
    );
    for (const row of alreadyAnswerable) {
      console.log(`  ${row.part.partNumber.padEnd(18)} ${row.refusedBy}`);
    }
    for (const row of plusInput) {
      console.log(`  ${row.part.partNumber.padEnd(18)} ${row.oneClickPlusInput.join(", ")}`);
    }
    console.log("");
  }

  // Why the rest are blocked, which is the actionable list.
  const blocked = allOk.filter((r) => !r.exportable);
  if (blocked.length > 0) {
    const reasons = new Map<string, number>();
    const named = new Map<string, string[]>();
    for (const row of blocked) {
      reasons.set(row.blockedBy, (reasons.get(row.blockedBy) ?? 0) + 1);
      named.set(row.blockedBy, [...(named.get(row.blockedBy) ?? []), row.part.partNumber]);
    }
    console.log("Blocked by:");
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
      // Named, not just counted. A blocker class is only actionable if you can
      // open the documents in it, and these are all tuned-corpus parts, which
      // are the ones it is legitimate to open.
      console.log(`  ${String(count).padStart(3)}  ${reason}: ${(named.get(reason) ?? []).join(", ")}`);
    }
    console.log("");
  }

  // What the model contributed, and what it tried to contribute and was refused.
  // Reported separately from the totals so the parser's own figure stays legible
  // next to it: the point is the DIFFERENCE the model makes, not a blended
  // number nobody can attribute.
  if (MODEL) {
    // What the run cost, before what it found. An uncached count above zero is
    // the load-bearing line in a no-spend run: it says how much of the report
    // below was measured against a model at all.
    const stats = (await benchModel())?.stats;
    if (stats) {
      console.log("Model cache:");
      console.log(formatCacheStats(stats));
      if (stats.skipped > 0) {
        console.log(projectCost(stats.skipped));
        console.log(`  ${stats.skipped} parts above ran WITHOUT a model answer.`);
      }
      console.log("");
    }

    const helped = allOk.filter((r) => r.modelFilled.length > 0);
    const refusedRows = allOk.filter((r) => r.modelRejected.length > 0);
    const perField = new Map<string, number>();
    for (const row of helped) {
      for (const field of row.modelFilled) perField.set(field, (perField.get(field) ?? 0) + 1);
    }
    console.log(`Model pass: filled at least one field on ${helped.length}/${allOk.length} parts.`);
    for (const [field, count] of [...perField].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(3)}  ${field}`);
    }
    if (refusedRows.length > 0) {
      console.log(`\nModel answers DISCARDED as untrustworthy (${refusedRows.length} parts):`);
      for (const row of refusedRows) {
        console.log(`  ${row.part.partNumber.padEnd(18)} ${row.modelRejected.join(",")}`);
      }
    }
    console.log("");
  }

  const errors = rows.filter((r) => r.status === "error");
  if (errors.length > 0) {
    console.log(`Parse errors (${errors.length}):`);
    for (const row of errors) console.log(`  ${row.part.partNumber.padEnd(18)} ${row.detail}`);
    console.log("");
  }

  if (!FETCH && rows.some((r) => r.status === "no-pdf")) {
    console.log("Some parts are not cached. Run with --fetch to populate the cache.\n");
  }
}

main();

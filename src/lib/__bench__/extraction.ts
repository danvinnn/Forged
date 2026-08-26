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
import { checkFetchedDatasheet } from "./fetchcheck";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";
import { extractPartRecord } from "../datasheet";
import { makeExtractionModel, runExtraction } from "../extraction";
import { resolveForExport, type Extracted, type PartRecord } from "../types";
import { packageOptions, recordForPackage } from "../exporters";
import {
  PINOUT_ORACLE,
  entryDescribes,
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
import { DIMENSION_ORACLE } from "./dimension-oracle";
import { sameOutlineCode } from "../packagevariants";
import { loadBenchEnv } from "./env";
import { getDeploymentMode } from "../retrieval/deployment";
import { modelBudgetMs, withDeadline } from "../extraction/budget";

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
  // THE FIELDS THAT ACTUALLY PLACE COPPER.
  //
  // This was body length, body width and pitch. Since 2026-08-12 the pads come
  // off the datasheet's own printed footprint (`landPad*`, `landSpan*`) and are
  // arranged by `leadSides` and `leadForm`, and none of those was scored: the
  // `geom` column, and every "fields complete" figure quoted from this bench,
  // described three numbers that no longer build the footprint. That is verbatim
  // the defect `untraceableDimensions` in types.ts was rewritten to remove,
  // surviving in the instrument that measures the fix.
  geometry: [
    "dimensions.bodyLengthMm",
    "dimensions.bodyWidthMm",
    "dimensions.pitchMm",
    "dimensions.landPadLengthMm",
    "dimensions.landPadWidthMm",
    "dimensions.landSpanMm",
    "dimensions.leadSides",
    "dimensions.leadForm"
  ],
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
  /**
   * A bundle with NOTHING asked: no package picked, no question answered.
   *
   * This was computed and then discarded for the life of this benchmark, which
   * left one headline standing for two very different experiences. `ships`
   * counts a part that needed a package chosen and three numbers typed, and
   * reporting only that reads as "91% of datasheets just work". A user
   * uploading a PDF and pressing export sees THIS number, and on 2026-08-24 a
   * user asked why the product kept failing when the bench said 91%. The
   * distance between the two figures is the answer, so both are printed.
   */
  shipsUnaided: boolean;
  /** Fields the model filled that the parser could not. Empty unless --model. */
  modelFilled: string[];
  /** Fields the model answered in a shape that could not be trusted. */
  modelRejected: string[];
  /** Why no bundle came out, when the fields were all present. */
  refusedBy: string;
  /**
   * The part was asked a question, the answer was supplied, and it STILL did not
   * export - with the reason it gave.
   *
   * `shipOutcome` has computed this since the answered figure existed and
   * nothing printed it, so the one outcome the input model cannot tolerate was
   * the one outcome no run reported. A question that is answered and changes
   * nothing is a refusal wearing the form of a question, and it costs the user
   * more than a plain refusal because they typed first.
   */
  brokeWhenAnswered: string | null;
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
  /** The vendor outline drawing the dimensions were measured from, for the ships list. */
  outlineCode: string | null;
  /** Wall-clock time for the full text extraction plus deterministic pass, ms. */
  elapsedMs: number;
  pageCount: number;
}

/**
 * Does this part ship, by the SAME definition `bench:holdout` uses.
 *
 * This used to be a local `shipCheck` that made one bare `createExportZip` call
 * on the record: no customer settings, no package chooser, no answers. The
 * hold-out applied all three. Both printed their result as "the product" and the
 * two numbers were quoted side by side - 98% and 18% - as though comparable.
 *
 * They were measuring different products, and the stricter one carried the
 * label. Moved to `shipcheck.ts` so there is one answer to the question.
 *
 * EXPECT THIS NUMBER TO RISE, and do not read the rise as progress: nothing in
 * the generator changed on the day it moved. A figure that was answering a
 * harder question than it claimed started answering the one it claimed.
 */

/**
 * Which of the datasheet's own packages would produce a bundle if named.
 *
 * Calls `packageOptions`, which is the function the PRODUCT calls. It used to
 * re-implement the package switch here, and the two had drifted: this copy
 * blanked the outline code, the pitch and the lead width, while `asPackage`
 * blanks every dimension plus the JEDEC outline, the printed land pattern and
 * the thermal pad. So the bench carried one package's body size and land pattern
 * over to another and reported packages as one-click that the product refuses.
 *
 * A second implementation of a rule is a second answer to the same question, and
 * the bench is the place that can least afford one: its whole job is to say what
 * the product does.
 */
async function oneClickCheck(
  record: PartRecord
): Promise<{ oneClickPackages: string[]; oneClickPlusInput: string[] }> {
  const choice = packageOptions(record);
  if (!choice.ok) return { oneClickPackages: [], oneClickPlusInput: [] };

  return {
    oneClickPackages: choice.options
      .filter((option) => option.status === "ships")
      .map((option) => option.designator),
    oneClickPlusInput: choice.options
      .filter((option) => option.status === "needs-input")
      .map((option) => `${option.designator} + ${option.needs.map((need) => need.field).join(",")}`)
  };
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
  record: PartRecord,
  /**
   * The package the bundle was actually built under, where that is not the one
   * the flat record describes.
   *
   * ## Why this argument had to exist
   *
   * This read `record.pins` and nothing else. On a family datasheet that field
   * is empty by design - a part sold in seven packages has no one pinout - and
   * the pins that build the symbol live in `packagesInThisDocument`. So for
   * every such part the check found no pins, reported `namesChecked: false`, and
   * said nothing at all.
   *
   * It said nothing SILENTLY, which is the part that matters: the headline read
   * "23/24 parts match the hand-read oracle" while twenty of the forty-four
   * entries were never compared to anything. A hand-read pin table nobody checks
   * against is a comment.
   *
   * Found 2026-08-25 the moment an LT1013 entry was added. That part ships as
   * the S8 and the product was emitting the N8 PDIP's assignment - every pin
   * wrong, on a package that ships - and this check could not see it.
   *
   * Exactly the defect `bench:dimensions` had until 2026-08-22, on the same
   * cause: the instrument was reading the flat block while the product built
   * from the per-package table. Fixed the same way, through the product's own
   * `recordForPackage`.
   */
  shippedAs: string | null
): { nameMismatches: NameMismatch[]; namesChecked: boolean } {
  const entry = PINOUT_ORACLE[partNumber];
  if (!entry) return { nameMismatches: [], namesChecked: false };
  const built = shippedAs !== null ? recordForPackage(record, shippedAs) : record;
  const pins = built.pins.value ?? record.pins.value ?? [];
  if (pins.length === 0) return { nameMismatches: [], namesChecked: false };
  // AND ONLY WHERE THE ENTRY IS ABOUT THE PACKAGE THAT SHIPPED. See
  // `entryDescribes`: scoring the wrong package manufactures defects rather than
  // finding them, which is how five false failures appeared the moment this
  // check could see per-package pinouts at all.
  if (!entryDescribes(entry, shippedAs, pins.length)) return { nameMismatches: [], namesChecked: false };
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
    // A document for the WRONG DEVICE reads perfectly and scores as a win. See
    // `fetchcheck.ts`; three of these sat in the caches undetected for months.
    const verdict = await checkFetchedDatasheet(ref.bytes as ArrayBuffer, part.partNumber);
    if (!verdict.ok) {
      console.log(`\n  REFUSED ${part.partNumber}: ${verdict.why}`);
      return false;
    }
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
      shipsUnaided: false,
      modelFilled: [],
      modelRejected: [],
      refusedBy: "",
      brokeWhenAnswered: null,
      blockedBy: "no datasheet",
      oneClickPackages: [],
      oneClickPlusInput: [],
      nameMismatches: [],
      namesChecked: false,
      packageType: "",
      outlineCode: null,
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
          const pacedBefore = model.stats.pacedMs;
          const startedAt = Date.now();
          const outcome = await withDeadline(
            runExtraction(
              deterministic,
              doc,
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
              model,
              `${part.partNumber}.pdf`
            ),
            modelBudgetMs(ROUTE_BUDGET_MS, Date.now() - startedAt) + (model.stats.pacedMs - pacedBefore)
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
    const outcome = await shipOutcome(record, BENCH_SETTINGS);
    // `ships` is the zero-friction figure and `shipsAnswered` is what a customer
    // experiences. The headline follows the hold-out and reports the second.
    const shipped = {
      ships: outcome.shipsAnswered,
      shipsUnaided: outcome.ships,
      refusedBy: outcome.why,
      brokeWhenAnswered: outcome.brokeWhenAnswered
    };
    return {
      part,
      status: "ok",
      detail: "",
      packageType: outcome.shippedAs?.designator ?? record.packageType.value ?? "",
      // THE DRAWING THE COPPER CAME FROM, not the one the record resolved to.
      //
      // A part that ships through the package chooser ships as a different
      // package, and `asPackage` nulls the outline code because the record's
      // belongs to another drawing. Printing the record's field beside such a
      // row named the wrong drawing, and named none at all for a package whose
      // code the document prints in its own table - which is most of the
      // "(no outline code read)" rows that made the VERIFIED list unworkable.
      outlineCode: outcome.shippedAs ? outcome.shippedAs.outlineCode : record.packageOutlineCode.value,
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
      ...checkNames(part.partNumber, record, outcome.shippedAs?.designator ?? null),
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
      shipsUnaided: false,
      modelFilled: [],
      modelRejected: [],
      refusedBy: "",
      brokeWhenAnswered: null,
      blockedBy: "parse error",
      oneClickPackages: [],
      oneClickPlusInput: [],
      nameMismatches: [],
      namesChecked: false,
      packageType: "",
      outlineCode: null,
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


/**
 * The deadline the ROUTES enforce, applied here so this bench measures the
 * product rather than a version of it with unlimited time.
 *
 * `/api/parse` and `/api/lookup` both carve the model pass a budget out of
 * `maxDuration`, race it, and DISCARD the whole outcome when it expires. This
 * bench called `runExtraction` bare until 2026-08-21, so every accuracy number
 * this project ever published described a pipeline nobody can actually run.
 *
 * The limiter's sleeps are added back before the race, because pacing belongs to
 * the bench and not to the product: counting it would fail parts for a rolling
 * window that production does not have. See `CacheStats.pacedMs`.
 */
const ROUTE_BUDGET_MS = 150_000;

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
  const unaided = allOk.filter((r) => r.shipsUnaided).length;
  console.log(
    `Fields complete:  ${exportable}/${allOk.length} parsed parts (${pct(exportable, allOk.length).trim()})`
  );
  // BOTH, because they are two different experiences and one headline was
  // standing for both. See `shipsUnaided`.
  console.log(
    `SHIPS UNAIDED:    ${unaided}/${allOk.length} parsed parts (${pct(unaided, allOk.length).trim()})   <- upload, press export, done`
  );
  console.log(
    `SHIPS A BUNDLE:   ${ships}/${allOk.length} parsed parts (${pct(ships, allOk.length).trim()})   <- after choosing a package and answering` +
      `\n${allOk.length}/${rows.length} of the corpus had a datasheet at all.\n`
  );

  // WHICH parts ship, by name and by the drawing their dimensions came from.
  //
  // The count alone cannot be acted on. Every figure in this report except the
  // two oracles counts whether a field is PRESENT, so "ships" means a footprint
  // was produced and not that it is right, and MAX232 sat in this number for a
  // day with another package's land pattern. Verifying that costs a human
  // reading the drawing, and a human cannot start without the list.
  //
  // The outline code is printed beside each because `DIMENSION_ORACLE` is keyed
  // by DRAWING rather than by part, so one hand-read entry covers every part
  // that shares it and this says which ones are already covered.
  const shipping = allOk.filter((r) => r.ships);
  if (shipping.length > 0) {
    // VERIFIED, AND IT IS NOT THE SAME CLAIM AS SHIPS.
    //
    // `SHIPS` says a bundle came out. It says nothing about whether the numbers
    // in it are right, and the two were being read as one figure. They are not:
    // ISL71001M shipped for weeks with a body height of 1.00 mm where its
    // drawing prints 1.20 Max, and every check in this repo was green, because
    // the only instrument that can see a wrong VALUE is a person reading the
    // drawing.
    //
    // So the fraction of shipping parts whose drawing a human has actually read
    // is printed as its own number. It is the one to quote to a customer, and
    // it is much smaller than SHIPS.
    // Matched with `sameOutlineCode`, not by exact key. NCP1200 reads
    // "CASE 751-07" and the oracle is keyed "751-07"; an exact lookup called a
    // hand-read drawing UNCHECKED and undercounted this figure the first time it
    // ran. `bench:dimensions` was already matching it correctly, so the two
    // instruments disagreed about the same part.
    // BY CODE OR BY PART, exactly as `outlineFor` in `dimensions.ts` resolves it.
    //
    // Checking the code alone undercounted this twice. NCP1200 reads
    // "CASE 751-07" against an oracle keyed "751-07", which `sameOutlineCode`
    // settles. TSV321 reads NO code at all - its drawing prints none - and is
    // covered by an entry keyed on a descriptive name with `parts: ["TSV321"]`.
    // Both were hand-read and both were reported UNCHECKED.
    //
    // The rule: this metric must agree with `bench:dimensions` about what is
    // covered, because two instruments disagreeing about one part is how you
    // learn one of them is lying.
    // A CODE THE PART SHIPPED AS BEATS THE PART LIST, INCLUDING WHEN IT MATCHES
    // NOTHING.
    //
    // The part list answers "which drawing does this part read", and it is wrong
    // whenever the datasheet prints several and the part settled on a different
    // one. Since `shipOutcome` reports the package the copper was actually built
    // from, the code is right by construction and the list is a fallback for
    // when no code came back at all.
    //
    // Measured 2026-08-22, the run after the shipped code was wired in: AD8628
    // ships as UJ-5, a 5-lead TSOT, and was reported `checked` against the R-8
    // SOIC entry in the same datasheet, which lists it. `bench:dimensions` had
    // already been corrected for exactly this and the two instruments then
    // disagreed about one part - which this file's own note says is how you
    // learn one of them is lying. It was this one, and it was overstating
    // VERIFIED, the number meant to be quoted to a customer.
    const oraclePart = new Set(Object.values(DIMENSION_ORACLE).flatMap((entry) => entry.parts));
    const oracleCovers = (code: string | null, partNumber: string): boolean =>
      code !== null
        ? Object.keys(DIMENSION_ORACLE).some(
            (key) =>
              sameOutlineCode(key, code) ||
              // An ALIAS counts: one title block can print two codes for one
              // drawing. See `alsoKnownAs`.
              (DIMENSION_ORACLE[key].alsoKnownAs ?? []).some((alias) => sameOutlineCode(alias, code))
          )
        : oraclePart.has(partNumber);
    const verified = shipping.filter((row) => oracleCovers(row.outlineCode ?? null, row.part.partNumber));
    const pct = shipping.length > 0 ? Math.round((verified.length / shipping.length) * 100) : 0;
    console.log(
      `VERIFIED:         ${verified.length}/${shipping.length} shipping parts (${pct}%) have their drawing ` +
        `hand-read in DIMENSION_ORACLE`
    );
    console.log("  shipping parts, and the outline drawing each was measured from:");
    for (const row of shipping) {
      // The DESIGNATOR when the drawing printed no code, because a person has to
      // open the right drawing and "(no outline code read)" does not say which.
      const code = row.outlineCode ?? (row.packageType ? `as ${row.packageType}` : "(no package named)");
      const covered = oracleCovers(row.outlineCode ?? null, row.part.partNumber) ? "checked" : "UNCHECKED";
      console.log(`    ${row.part.partNumber.padEnd(18)} ${code.padEnd(34)} ${covered}`);
    }
    console.log("");
  }

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
  // ANSWERED AND STILL REFUSED. The one outcome the input model cannot tolerate,
  // computed by `shipOutcome` since the answered figure existed and printed by
  // nothing until 2026-08-25. A question the user answers and that changes
  // nothing costs them more than a plain refusal.
  const brokeAnswered = allOk.filter((r) => r.brokeWhenAnswered !== null);
  if (brokeAnswered.length > 0) {
    console.log(`\nANSWERED AND STILL REFUSED (${brokeAnswered.length}):`);
    for (const row of brokeAnswered) {
      console.log(`  ${row.part.partNumber.padEnd(18)} asked ${row.refusedBy}`);
      console.log(`  ${" ".repeat(18)} then ${row.brokeWhenAnswered}`);
    }
    console.log("  A question the user answers must either build the part or stop being asked.");
  }

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

// REPORTED, not swallowed. This ended with a bare `main()`, so a throw anywhere
// outside the two guarded blocks became an unhandled rejection with no summary.
// `coverage.ts` has always caught; the two benches that can spend money did not.
main().catch((error) => {
  console.error("benchmark failed:", error);
  process.exitCode = 1;
});

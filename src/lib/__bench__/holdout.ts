// The HOLD-OUT corpus, and the only number in this project that predicts what a
// stranger's datasheet will do.
//
// ## Why this exists
//
// Every document in `BENCH_CORPUS` has been opened by hand and had reader rules
// fitted to it. Bounds were widened until a specific part read, caption spellings
// were added as they were met, tolerances were chosen by measuring one page. So
// the extraction bench does not measure how good the parser is. It measures how
// well thirty-nine documents were fitted, and it will keep going up as long as
// anyone keeps fitting them. It cannot go down when the parser fails to
// generalise, because nothing in it is unseen.
//
// The parts below were chosen WITHOUT opening their datasheets, across the three
// vendors whose URL patterns resolve, spanning op-amps, data converters,
// regulators, logic, interface, sensors and MCUs, and deliberately mixing modern
// and old document templates.
//
// ## The rule that makes the number mean anything
//
// **Nothing here may ever be tuned against.** Do not open a hold-out datasheet to
// diagnose a failure and then widen a bound so it passes. The moment you do, this
// file becomes a second training set and the project loses the only honest signal
// it has. If a hold-out failure needs diagnosing, the finding is the CLASS of
// failure, not the document: fix the class, re-measure, and if a specific part
// had to be looked at to get there, MOVE it into `BENCH_CORPUS` and add a
// replacement here.
//
// Usage:
//   npm run bench:holdout              measure what is cached
//   npm run bench:holdout -- --fetch   fetch anything missing first (network)
//   npm run bench:holdout -- --model   run the extraction model too (spends money)
//
// PDFs cache under `.holdout-cache/` and are gitignored for the same reason
// `.bench-cache/` is: no vendor datasheet is ever committed to this repo.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extractPartRecord } from "../datasheet";
import { makeExtractionModel, runExtraction } from "../extraction";
import { type PartRecord } from "../types";
import type { DatasheetText } from "../pdftext";
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
import { looksLikeWrongDocument } from "../pdftext";
import { checkFetchedDatasheet } from "./fetchcheck";
import { loadBenchEnv } from "./env";
import { getDeploymentMode } from "../retrieval/deployment";
import { modelBudgetMs, withDeadline } from "../extraction/budget";
import {
  HOLDOUT_CACHE_DIR,
  HOLDOUT_CORPUS,
  holdoutCachePath as cachePath,
  type HoldoutPart
} from "./holdout-corpus";

/** Re-exported so the corpus stays importable from the bench that scores it. */
export { HOLDOUT_CORPUS, type HoldoutPart };

loadBenchEnv();

if (!process.env.FORGE_LOG_LEVEL) process.env.FORGE_LOG_LEVEL = "error";

const FETCH = process.argv.includes("--fetch");
const VERBOSE = process.argv.includes("--verbose");
/**
 * Run the extraction MODEL as well as the parser. Off by default, exactly as in
 * the tuned bench: it spends money and needs the network, and a default run has
 * to stay comparable with every hold-out number recorded so far.
 *
 * This does not weaken the hold-out rule at the top of this file. Measuring a
 * model against unseen documents is the point of the corpus; what is forbidden
 * is looking at one of these datasheets and then fitting a rule to it.
 */
const MODEL = process.argv.includes("--model");
const CACHE_DIR = HOLDOUT_CACHE_DIR;
const FETCH_DELAY_MS = 1200;

/** Model response cache. Same flags and same reasoning as the tuned bench. */
const CACHE_MODE: CacheMode = process.argv.includes("--refresh")
  ? "refresh"
  : process.argv.includes("--estimate")
    ? "estimate"
    : process.argv.includes("--offline")
      ? "offline"
      : "use";

/**
 * There is deliberately no `--parts` here, though the tuned bench has one.
 *
 * The hold-out is worth something only because of the discipline around it: you
 * do not look at one of these datasheets and then fit a rule to it, you promote
 * the part into the tuned corpus and add a blind replacement. A flag that made
 * it easy to run one hold-out part over and over is a flag for doing exactly
 * the forbidden thing, and the cost argument that justifies it elsewhere does
 * not apply: replaying all 38 from cache is free.
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchToCache(part: HoldoutPart): Promise<boolean> {
  const { makeResolver } = await import("../retrieval/factory");
  const resolver = await makeResolver("commercial");
  if (!resolver) return false;
  try {
    const ref = await resolver.resolve(part.partNumber, { manufacturer: part.manufacturer });
    if (!ref) return false;
    // See `fetchcheck.ts`. The hold-out is the number this project quotes as its
    // honest one, so a document for the wrong device is worse here than anywhere.
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

/**
 * Why one part produced no bundle, in a form that GROUPS.
 *
 * The point of the hold-out is not a list of parts to go and fix, it is a
 * histogram of causes. A cause with one part behind it is a document; a cause
 * with nine is a hole in the reader.
 */
function classify(record: PartRecord, doc?: DatasheetText): string {
  const pins = record.pins.value ?? [];
  const count = record.pinCount.value;

  // WHAT WE FETCHED IS NOT ALWAYS A DATASHEET, and that is a different failure.
  //
  // AD8495 resolved to a three-page Soldered Electronics breakout-board product
  // page: 2,318 characters, no pinout, no mechanical section, a shipping weight
  // and an order code. The model correctly refused all 36 fields, including the
  // manufacturer, because none of them is in the document.
  //
  // Counting that as "we could not read the datasheet" is wrong in both
  // directions: it makes extraction look worse than it is, and it hides a
  // retrieval failure that a user would hit exactly as hard. Retrieval is out of
  // scope for this bench, so it is named and set aside rather than scored.
  //
  // The test is deliberately about SIZE and not about content: a document with
  // no pinout section might still be a datasheet whose pinout is a figure, and
  // that is a reading problem. A component datasheet that is three pages long
  // with two thousand characters is not a component datasheet.
  // The rule lives in `pdftext.ts` so the PRODUCT applies the same one. It was
  // duplicated here, which meant the bench could classify a case the product had
  // no way to detect.
  if (doc && looksLikeWrongDocument(doc)) {
    return "NOT A DATASHEET (retrieval fetched the wrong document)";
  }

  // A PINOUT PER PACKAGE IS A PINOUT.
  //
  // A family datasheet whose part number does not name a package gets `pins`
  // null, correctly: the model is told not to pick among several pinouts. It
  // returns them all, labelled, and each is located on a page before it is
  // stored. Counting that as "no pins, no count" is what made twelve of the
  // fifty-one parts with a reading look unreadable when the document had been
  // read fine and the answer was on the record. The package chooser offers
  // exactly these, one option per table.
  //
  // Only tables that were LOCATED count. An entry that matched no page in the
  // document is not evidence, and `resolveForExport` refuses it downstream.
  //
  // AND A PIN COUNT DOES NOT STOP IT BEING ONE. This asked additionally for
  // `count === null`, so a document that named its lead count AND tabulated a
  // pinout per package was filed as "count but no pins" and never offered to
  // the chooser at all: the run stopped one step before the product, for the
  // third time in this file's history. TCA9548A, LD39050 and ADG1211 each carry
  // two or three located per-package tables and were counted as unread.
  const located = (record.packagesInThisDocument ?? []).filter((table) => table.citation).length;
  if (pins.length === 0 && located > 0) {
    return "read (one pinout per package, user picks)";
  }

  if (pins.length === 0 && count === null) return "no pins, no count";
  if (pins.length === 0) return "count but no pins";
  if (count === null) return "pins but no count (nothing corroborates them)";
  return "read";
}


/**
 * The settings a customer has set before their first datasheet.
 *
 * The two forming-die numbers are the ones the settings screen makes mandatory,
 * because no datasheet states them: they are properties of the assembler's
 * bending die. The two that a published standard covers are left BLANK on
 * purpose, so this run measures the defaults a customer who chooses nothing
 * gets, which is the honest floor.
 *
 * The values are the ordinary ones for a small-outline part on a normal line.
 * Nothing here is read from a datasheet and nothing here should be: that is the
 * whole reason these are settings.
 */
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";
import { confirmations, MAX_FLAGGED } from "../confirm";
import { buildFootprintGeometry } from "../exporters";
import { densityOf } from "../settings";



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

async function main(): Promise<void> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`Hold-out corpus: ${HOLDOUT_CORPUS.length} parts never inspected`);
  if (MODEL) {
    console.log(
      `Model cache: ${modelCacheDir()} (${cacheSize()} responses), mode ${CACHE_MODE}` +
        (CACHE_MODE === "use" || CACHE_MODE === "refresh" ? " [may spend]" : " [no spend]")
    );
  }
  console.log();

  if (FETCH) {
    let got = 0;
    for (const part of HOLDOUT_CORPUS) {
      if (existsSync(cachePath(part.partNumber))) { got += 1; continue; }
      const ok = await fetchToCache(part);
      if (ok) got += 1;
      process.stdout.write(ok ? "." : "x");
      await sleep(FETCH_DELAY_MS);
    }
    console.log(`\ncached ${got}/${HOLDOUT_CORPUS.length}\n`);
  }

  // What this run is about to cost, before it costs it. See `preRunProjection`:
  // the spend ceiling is a backstop and saves nothing, this is the part that
  // can. Printed only when the run can actually spend, since `--offline` and
  // `--estimate` cannot.
  if (MODEL && (CACHE_MODE === "use" || CACHE_MODE === "refresh")) {
    const model = await benchModel();
    if (model) {
      const willVisit = HOLDOUT_CORPUS.filter((part) => existsSync(cachePath(part.partNumber))).length;
      console.log(preRunProjection({ parts: willVisit, callsPerPart: 2, modelName: model.name }));
      console.log();
    }
  }

  const reasons = new Map<string, string[]>();
  const byKind = new Map<string, { read: number; total: number }>();
  let cached = 0;
  let read = 0;
  let ships = 0;
  /** Ships once the customer's settings and their answers to our questions are in. */
  let shipsAnswered = 0;
  /**
   * Flagged values per part: how much of each bundle a person has to check.
   *
   * The number the product is judged on now; see `confirm.ts`. Measured on the
   * hold-out because a stranger's datasheet is the only place it means anything.
   * Parts whose bundle only exists once a question is answered are left OUT
   * rather than counted as zero.
   */
  const flagged: number[] = [];
  /** How many questions each answered part actually took, so the friction is visible. */
  const questionsAsked = new Map<string, number>();
  /** Answered every question and still refused: a broken ask, reported by name. */
  const answeredAndStillRefused = new Map<string, string>();
  const shipRefusals = new Map<string, string[]>();
  /** Which fields the model filled that the parser could not, per part. */
  const modelFilled = new Map<string, string[]>();
  /** Fields the model answered in a shape or with a citation that failed the check. */
  const modelRejected = new Map<string, string[]>();

  for (const part of HOLDOUT_CORPUS) {
    const path = cachePath(part.partNumber);
    const kind = byKind.get(part.kind) ?? { read: 0, total: 0 };
    if (!existsSync(path)) {
      byKind.set(part.kind, kind);
      continue;
    }
    cached += 1;
    kind.total += 1;

    const bytes = readFileSync(path);
    let record: PartRecord;
    // Kept outside the try so `classify` can ask what document we actually got.
    let parsed: DatasheetText | null = null;
    try {
      const { doc, part: deterministic } = await extractPartRecord(
        `${part.partNumber}.pdf`,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      );
      record = deterministic;
      parsed = doc;

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
              if (outcome.filled.length > 0) modelFilled.set(part.partNumber, outcome.filled);
              if (outcome.rejected.length > 0) {
                modelRejected.set(part.partNumber, outcome.rejected.map((entry) => entry.field));
              }
            }
          } catch (error) {
            // A model failure must not cost the deterministic row, exactly as in
            // the parse route. Recorded so the run is not silently partial.
            modelRejected.set(part.partNumber, [
              error instanceof ModelCacheMiss
                ? "UNCACHED"
                : `ERROR:${error instanceof Error ? error.name : "unknown"}`
            ]);
          }
          // Free-tier rate limits are per minute; without this the run 429s. A
          // replayed answer touched no network, so it does not need the wait.
          // Pacing lives in `cachingModel` now, against a rolling window that
          // counts retries too. A flat sleep here cannot see them and so could not
          // hold the limit; it is kept only as a floor between parts.
        }
      }
    } catch (error) {
      const reason = `parse threw: ${(error as Error).message.slice(0, 40)}`;
      reasons.set(reason, [...(reasons.get(reason) ?? []), part.partNumber]);
      byKind.set(part.kind, kind);
      continue;
    }

    const reason = classify(record, parsed ?? undefined);
    reasons.set(reason, [...(reasons.get(reason) ?? []), part.partNumber]);
    if (reason.startsWith("read")) {
      read += 1;
      kind.read += 1;
      const outcome = await shipOutcome(record, BENCH_SETTINGS);
      if (outcome.ships) ships += 1;
      else shipRefusals.set(outcome.why, [...(shipRefusals.get(outcome.why) ?? []), part.partNumber]);
      // HOW MUCH DOES THE USER HAVE TO CHECK? See `confirm.ts`. Measured here
      // because a stranger's datasheet is the only place the answer means
      // anything: the tuned corpus has been read, argued with and fixed against
      // for months and this one has never been opened.
      if (outcome.shippedPart) {
        try {
          const geometry = buildFootprintGeometry(
            outcome.shippedPart,
            densityOf(BENCH_SETTINGS),
            BENCH_SETTINGS.formedLeadSpanMm,
            undefined,
            BENCH_SETTINGS.formedLeadContactMm
          );
          flagged.push(confirmations(outcome.shippedPart, geometry, parsed ?? null).flagged.length);
        } catch {
          // A bundle that only exists once a question is answered cannot be
          // rebuilt from the bare record here. Left out of the distribution
          // rather than counted as zero, which would flatter it.
        }
      }
      if (outcome.shipsAnswered) {
        shipsAnswered += 1;
        if (!outcome.ships) questionsAsked.set(part.partNumber, outcome.asked);
      } else if (outcome.brokeWhenAnswered !== null) {
        // Answered and STILL refused. Never folded into a total: it is a defect
        // in the ask, and the ask is the product's promise that a question has
        // an answer.
        answeredAndStillRefused.set(part.partNumber, outcome.brokeWhenAnswered);
      }
    }
    byKind.set(part.kind, kind);
  }

  console.log(`cached:    ${cached}/${HOLDOUT_CORPUS.length}`);
  console.log(`READ:      ${read}/${cached}  (${cached ? Math.round((read / cached) * 100) : 0}%)  <- the number that predicts a stranger's datasheet`);
  const asks = [...questionsAsked.values()].sort((a, b) => a - b);
  const median = asks.length > 0 ? asks[Math.floor(asks.length / 2)] : 0;
  console.log(
    `SHIPS:     ${shipsAnswered}/${cached}  (${cached ? Math.round((shipsAnswered / cached) * 100) : 0}%)` +
      `  <- with the customer's settings and their answers. THE PRODUCT.`
  );
  console.log(
    `  of which ${ships} asked nothing at all, and ${questionsAsked.size} answered ` +
      `${asks.length > 0 ? `a median of ${median}` : "no"} question(s).`
  );
  if (answeredAndStillRefused.size > 0) {
    console.log(`\n  ANSWERED AND STILL REFUSED (${answeredAndStillRefused.size}) - a broken ask, not a hard part:`);
    for (const [partNumber, why] of answeredAndStillRefused) console.log(`    ${partNumber.padEnd(18)} ${why}`);
  }
  if (flagged.length > 0) {
    const total = flagged.reduce((sum, count) => sum + count, 0);
    const clean = flagged.filter((count) => count === 0).length;
    const worst = Math.max(...flagged);
    console.log(
      `TO CHECK:  ${(total / flagged.length).toFixed(2)} values per part on average, ` +
        `${clean}/${flagged.length} parts with nothing, worst ${worst}` +
        `  <- gate: never above ${MAX_FLAGGED}, ${worst <= MAX_FLAGGED ? "MET" : "MISSED"}`
    );
  }
  console.log();

  console.log("Why parts did not read:");
  for (const [reason, parts] of [...reasons].sort((a, b) => b[1].length - a[1].length)) {
    if (reason === "read") continue;
    console.log(`  ${String(parts.length).padStart(3)}  ${reason}`);
    if (VERBOSE) console.log(`       ${parts.join(", ")}`);
  }

  if (shipRefusals.size > 0) {
    console.log("\nRead but no bundle:");
    for (const [why, parts] of [...shipRefusals].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(parts.length).padStart(3)}  ${why}`);
      if (VERBOSE) console.log(`       ${parts.join(", ")}`);
    }
  }

  console.log("\nBy kind:");
  for (const [kind, counts] of [...byKind].sort()) {
    if (counts.total === 0) continue;
    console.log(`  ${kind.padEnd(11)} ${counts.read}/${counts.total}`);
  }

  if (MODEL) {
    const stats = (await benchModel())?.stats;
    if (stats) {
      console.log("\nModel cache:");
      console.log(formatCacheStats(stats));
      if (stats.skipped > 0) {
        console.log(projectCost(stats.skipped));
        console.log(`  ${stats.skipped} parts above ran WITHOUT a model answer.`);
      }
    }

    // Which FIELDS the model reached is the number that decides whether it leads
    // or follows, so it is reported per field rather than only per part.
    const byField = new Map<string, number>();
    for (const fields of modelFilled.values()) {
      for (const field of fields) byField.set(field, (byField.get(field) ?? 0) + 1);
    }
    console.log(`\nMODEL: filled a field on ${modelFilled.size}/${cached} parts`);
    for (const [field, count] of [...byField].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(3)}  ${field}`);
    }
    if (VERBOSE) {
      for (const [partNumber, fields] of modelFilled) console.log(`       ${partNumber}: ${fields.join(", ")}`);
    }
    if (modelRejected.size > 0) {
      console.log(`\nMODEL REJECTED on ${modelRejected.size} parts (bad shape or unverifiable citation)`);
      for (const [partNumber, fields] of modelRejected) console.log(`  ${partNumber}: ${fields.join(", ")}`);
    }
  }
}

// REPORTED, not swallowed. A bare `main()` turned any throw outside the guarded
// blocks into an unhandled rejection: on the PAID run that is money spent and no
// figure printed, which is the same shape as the `shipOutcome` rethrow that
// ended a 56-part run one level down.
main().catch((error) => {
  console.error("hold-out run failed:", error);
  process.exitCode = 1;
});

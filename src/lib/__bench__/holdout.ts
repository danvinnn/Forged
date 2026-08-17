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
import { join } from "node:path";
import { extractPartRecord } from "../datasheet";
import { makeExtractionModel, runExtraction } from "../extraction";
import { resolveForExport, type PartRecord } from "../types";
import { createExportZip, packageOptions, FootprintUnavailableError, type RequiredInput } from "../exporters";
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
const CACHE_DIR = join(process.cwd(), ".holdout-cache");
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

export interface HoldoutPart {
  partNumber: string;
  manufacturer: string;
  /** Rough family, so a failure can be grouped by the kind of part rather than the vendor. */
  kind: "opamp" | "converter" | "power" | "logic" | "interface" | "sensor" | "mcu" | "reference";
}

export const HOLDOUT_CORPUS: HoldoutPart[] = [
  // Texas Instruments
  { partNumber: "OPA192", manufacturer: "Texas Instruments", kind: "opamp" },
  // Replaces OPA2189, promoted into BENCH_CORPUS on 2026-08-12 after its page 5
  // had to be opened to settle a cross-check disagreement. Chosen the same way
  // every part here was: by vendor, kind and document age, WITHOUT opening it.
  { partNumber: "OPA1612", manufacturer: "Texas Instruments", kind: "opamp" },
  { partNumber: "TLV9002", manufacturer: "Texas Instruments", kind: "opamp" },
  { partNumber: "LMV321", manufacturer: "Texas Instruments", kind: "opamp" },
  { partNumber: "INA333", manufacturer: "Texas Instruments", kind: "opamp" },
  { partNumber: "THS3491", manufacturer: "Texas Instruments", kind: "opamp" },
  { partNumber: "INA226", manufacturer: "Texas Instruments", kind: "converter" },
  { partNumber: "ADS1220", manufacturer: "Texas Instruments", kind: "converter" },
  // ADS8688 was PROMOTED into BENCH_CORPUS on 2026-08-02 and ADS1256 replaces it.
  // Diagnosing a hold-out failure means reading the document, and a document that
  // has been read is a tuned document; leaving it here would quietly turn the
  // honest number into the fitted one. Third promotion, after TSV321 -> TSB611
  // and DRV8825 -> TPS61022. The replacement was chosen by part number alone and
  // its datasheet has NOT been opened.
  { partNumber: "ADS1256", manufacturer: "Texas Instruments", kind: "converter" },
  { partNumber: "DAC8552", manufacturer: "Texas Instruments", kind: "converter" },
  { partNumber: "PCM1808", manufacturer: "Texas Instruments", kind: "converter" },
  { partNumber: "TPS62130", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "TPS7A4700", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "TPS54360", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "LM5117", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "LP5907", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "UCC28C43", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "TPS61022", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "SN74HC595", manufacturer: "Texas Instruments", kind: "logic" },
  { partNumber: "SN74LVC245A", manufacturer: "Texas Instruments", kind: "logic" },
  { partNumber: "SN74AUP1G04", manufacturer: "Texas Instruments", kind: "logic" },
  { partNumber: "CD4017B", manufacturer: "Texas Instruments", kind: "logic" },
  { partNumber: "TCA9548A", manufacturer: "Texas Instruments", kind: "interface" },
  { partNumber: "SN65HVD72", manufacturer: "Texas Instruments", kind: "interface" },
  { partNumber: "ISO7841", manufacturer: "Texas Instruments", kind: "interface" },
  { partNumber: "TPD4E1U06", manufacturer: "Texas Instruments", kind: "interface" },
  { partNumber: "TMP117", manufacturer: "Texas Instruments", kind: "sensor" },
  { partNumber: "REF3025", manufacturer: "Texas Instruments", kind: "reference" },
  { partNumber: "TL431", manufacturer: "Texas Instruments", kind: "reference" },
  { partNumber: "MSP430FR2433", manufacturer: "Texas Instruments", kind: "mcu" },

  // STMicroelectronics
  { partNumber: "TS922", manufacturer: "STMicroelectronics", kind: "opamp" },
  { partNumber: "TSZ121", manufacturer: "STMicroelectronics", kind: "opamp" },
  { partNumber: "TSB611", manufacturer: "STMicroelectronics", kind: "opamp" },
  { partNumber: "L7805", manufacturer: "STMicroelectronics", kind: "power" },
  { partNumber: "LD39050", manufacturer: "STMicroelectronics", kind: "power" },
  { partNumber: "ST1S10", manufacturer: "STMicroelectronics", kind: "power" },
  { partNumber: "VIPER22A", manufacturer: "STMicroelectronics", kind: "power" },
  { partNumber: "M24C02", manufacturer: "STMicroelectronics", kind: "interface" },
  // LIS3DH and STM32G071RB were PROMOTED into BENCH_CORPUS on 2026-08-02, one for
  // each of the two gates that account for 16 of the 18 unreadable parts. LPS22HB
  // and STM32F411RE replace them, chosen by part number alone with their
  // datasheets unopened. Fourth and fifth promotions; see the header rule.
  { partNumber: "LPS22HB", manufacturer: "STMicroelectronics", kind: "sensor" },
  { partNumber: "LSM6DSO", manufacturer: "STMicroelectronics", kind: "sensor" },
  { partNumber: "STM32L476RG", manufacturer: "STMicroelectronics", kind: "mcu" },
  { partNumber: "STM32F411RE", manufacturer: "STMicroelectronics", kind: "mcu" },
  { partNumber: "STM32F030C8", manufacturer: "STMicroelectronics", kind: "mcu" },

  // Analog Devices
  { partNumber: "AD620", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "AD8221", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "OP07", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "LT1013", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "ADA4522-2", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "AD7124-8", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "AD7606", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "AD5679R", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "AD9833", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "LTC2400", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "ADG1211", manufacturer: "Analog Devices", kind: "interface" },
  { partNumber: "ADUM1201", manufacturer: "Analog Devices", kind: "interface" },
  { partNumber: "ADM3202", manufacturer: "Analog Devices", kind: "interface" },
  { partNumber: "ADXL345", manufacturer: "Analog Devices", kind: "sensor" },
  { partNumber: "AD8495", manufacturer: "Analog Devices", kind: "sensor" },
  { partNumber: "LTC3105", manufacturer: "Analog Devices", kind: "power" }
];

function cachePath(partNumber: string): string {
  return join(CACHE_DIR, `${partNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchToCache(part: HoldoutPart): Promise<boolean> {
  const { makeResolver } = await import("../retrieval/factory");
  const resolver = await makeResolver("commercial");
  if (!resolver) return false;
  try {
    const ref = await resolver.resolve(part.partNumber, { manufacturer: part.manufacturer });
    if (!ref) return false;
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
function classify(record: PartRecord): string {
  const pins = record.pins.value ?? [];
  const count = record.pinCount.value;

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
  const located = (record.pinTablesByPackage ?? []).filter((table) => table.citation).length;
  if (pins.length === 0 && count === null && located > 0) {
    return "read (one pinout per package, user picks)";
  }

  if (pins.length === 0 && count === null) return "no pins, no count";
  if (pins.length === 0) return "count but no pins";
  if (count === null) return "pins but no count (nothing corroborates them)";
  return "read";
}


/**
 * What the USER would actually be able to get, which is not what this measured
 * before.
 *
 * The bench used to call `createExportZip` on the record and count a success.
 * The product does not do that. It calls `packageOptions`, which runs the real
 * footprint build once per package the document offers, and shows the user a
 * chooser saying which of them work. On a family datasheet those are different
 * questions with different answers: a part whose record resolved to the SOIC can
 * still offer a working QFN, and the old measure could not see it.
 *
 * So SHIPS here is: can the user obtain at least one library without answering a
 * question. Two routes count, and they are the two the product actually offers:
 *
 *   1. the record exports as it stands, which is what happens when the document
 *      names one package and there is no choice to make
 *   2. some offered package exports
 *
 * No model calls. `packageOptions` is pure generation over a record already
 * read, so this costs nothing to re-measure from cache.
 */
async function shipOutcome(record: PartRecord): Promise<{ ships: boolean; why: string }> {
  const resolved = resolveForExport(record);
  if (!resolved.ok) {
    // A part `resolveForExport` declines never reached the exporter, so it was
    // landing in NEITHER bucket: ten parts of one run were invisible, and SHIPS
    // looked like it had regressed when the parts were in fact being HELD. A
    // refusal nobody can see is the one kind mistaken for a coverage loss.
    const why =
      resolved.untraceable && resolved.untraceable.length > 0
        ? `held: uncitable ${[...new Set(resolved.untraceable)].join(",")}`
        : `held: missing ${resolved.missing.join(",")}`;
    return { ships: false, why };
  }

  // ROUTE ONE: the record as it stands, which is what the user gets when the
  // document names one package and there is no choice to make.
  let direct: FootprintUnavailableError | null = null;
  try {
    await createExportZip(resolved.part, "kicad");
    return { ships: true, why: "" };
  } catch (error) {
    if (!(error instanceof FootprintUnavailableError)) throw error;
    direct = error;
  }

  // ROUTE TWO: whatever the chooser offers. Empty when the document names no
  // alternatives, which is why route one's refusal is kept rather than replaced.
  const choice = packageOptions(record);
  if (choice.ok && choice.options.some((option) => option.status === "ships")) {
    return { ships: true, why: "" };
  }

  // The SMALLEST question set across every route, because that is the friction
  // the product actually imposes: the user takes the cheapest path on offer.
  const asks: RequiredInput[][] = choice.ok
    ? choice.options.filter((option) => option.status === "needs-input").map((option) => option.needs)
    : [];
  if (direct.needs.length > 0) asks.push(direct.needs);

  if (asks.length === 0) {
    // Nothing anywhere is answerable. Prefer route one's own words: it is about
    // the package actually read, and an option's reason is about a sibling.
    const unsupported = choice.ok ? choice.options.find((option) => option.status === "unsupported") : undefined;
    return {
      ships: false,
      why: `unsupported: ${(direct.reason ?? unsupported?.reason ?? "no land pattern").slice(0, 60)}`
    };
  }
  const fewest = asks.reduce((best, needs) => (needs.length < best.length ? needs : best));
  return { ships: false, why: `needs ${fewest.map((need) => need.field).join(",")}` };
}

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
    try {
      const { doc, part: deterministic } = await extractPartRecord(
        `${part.partNumber}.pdf`,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      );
      record = deterministic;

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

    const reason = classify(record);
    reasons.set(reason, [...(reasons.get(reason) ?? []), part.partNumber]);
    if (reason.startsWith("read")) {
      read += 1;
      kind.read += 1;
      const outcome = await shipOutcome(record);
      if (outcome.ships) ships += 1;
      else shipRefusals.set(outcome.why, [...(shipRefusals.get(outcome.why) ?? []), part.partNumber]);
    }
    byKind.set(part.kind, kind);
  }

  console.log(`cached:    ${cached}/${HOLDOUT_CORPUS.length}`);
  console.log(`READ:      ${read}/${cached}  (${cached ? Math.round((read / cached) * 100) : 0}%)  <- the number that predicts a stranger's datasheet`);
  console.log(`SHIPS:     ${ships}/${cached}  (${cached ? Math.round((ships / cached) * 100) : 0}%)\n`);

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

main();

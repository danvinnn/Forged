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
import { pinTableFor } from "../packagevariants";
import type { DatasheetText } from "../pdftext";
import {
  createExportZip,
  packageOptions,
  FootprintUnavailableError,
  type OptionAnswers,
  type RequiredInput,
  type SuppliedDimensions
} from "../exporters";
import { densityOf, type ForgeSettings } from "../settings";
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
  // TPS7A4700 removed 2026-08-17 for the same reason: it was in BENCH_CORPUS too.
  { partNumber: "TPS7A4901", manufacturer: "Texas Instruments", kind: "power" },
  // TPS54360 was PROMOTED to the tuned corpus on 2026-08-17: it produced an
  // invalid footprint, and a defect that cannot be opened cannot be fixed.
  // Replaced here so the hold-out keeps its size and its shape.
  { partNumber: "TPS63020", manufacturer: "Texas Instruments", kind: "power" },
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
  // TS922 and TSZ121 were PROMOTED to the tuned corpus on 2026-08-19. Both read
  // every package and every package drawing and returned NO pin table for any of
  // them, and whether their pinouts are printed as text or drawn as artwork
  // could not be established without opening them. Replaced blind below, by
  // vendor and kind, datasheets unopened.
  { partNumber: "TSV991", manufacturer: "STMicroelectronics", kind: "opamp" },
  { partNumber: "TSU101", manufacturer: "STMicroelectronics", kind: "opamp" },
  { partNumber: "TSB611", manufacturer: "STMicroelectronics", kind: "opamp" },
  // L7805 was PROMOTED to the tuned corpus on 2026-08-17: it read no pins and no
  // pin count, and why could not be established without opening it. Replaced
  // blind, by vendor and kind, datasheet unopened.
  { partNumber: "LM317", manufacturer: "STMicroelectronics", kind: "power" },
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
  // LT1013 was PROMOTED to the tuned corpus on 2026-08-17. It was the only part
  // in the corpus reading a pin COUNT but no pins, a category of one, which is
  // exactly the kind that stays unexplained forever unless it is promoted.
  { partNumber: "OP27", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "ADA4522-2", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "AD7124-8", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "AD7606", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "AD5679R", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "AD9833", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "LTC2400", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "ADG1211", manufacturer: "Analog Devices", kind: "interface" },
  { partNumber: "ADUM1201", manufacturer: "Analog Devices", kind: "interface" },
  { partNumber: "ADM3202", manufacturer: "Analog Devices", kind: "interface" },
  // ADXL345 was PROMOTED to the tuned corpus on 2026-08-17, same reason.
  { partNumber: "ADXL362", manufacturer: "Analog Devices", kind: "sensor" },
  { partNumber: "AD8495", manufacturer: "Analog Devices", kind: "sensor" },
  // LTC3105 removed 2026-08-17: it was ALSO in BENCH_CORPUS, so it had been tuned
  // against while counting toward the unseen number. Replaced blind.
  { partNumber: "LT3080", manufacturer: "Analog Devices", kind: "power" }
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
  if (doc && doc.pages.length <= 4) {
    const chars = doc.pages.reduce((sum, page) => sum + page.text.length, 0);
    if (chars < 4000) return "NOT A DATASHEET (retrieval fetched the wrong document)";
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
const BENCH_SETTINGS: ForgeSettings = {
  formedLeadSpanMm: 7.62,
  formedLeadContactMm: 1.4
};

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
 *
 * ## Two numbers, and the second one is the product
 *
 * `ships` is the zero-friction figure: a bundle with nothing asked. It is the
 * one to watch for regressions, because it is the only one that cannot be moved
 * by asking the user more.
 *
 * `shipsAnswered` is what a customer actually experiences, and is the headline.
 * The product's whole input model says that a number no datasheet carries is
 * ASKED rather than invented; a part blocked only on such a question is a part
 * that ships, after a few seconds of typing. Reporting it as a failure measures
 * a product that refuses where this one asks.
 *
 * It is not a free pass. It counts a part only when EVERY remaining blocker is
 * a question the product knows how to ask AND the export really completes when
 * the answers arrive, which is checked here by supplying them. A part blocked by
 * "no land pattern for this package" or by an uncitable dimension is not
 * answerable and does not count, however small the gap looks.
 */
async function shipOutcome(
  record: PartRecord,
  settings: ForgeSettings
): Promise<{ ships: boolean; shipsAnswered: boolean; why: string; asked: number; brokeWhenAnswered: string | null }> {
  const resolved = resolveForExport(record);

  // ROUTE ONE: the record as it stands, which is what the user gets when the
  // document names one package and there is no choice to make.
  let direct: FootprintUnavailableError | null = null;
  // What route one refused with, when it could not even be attempted.
  //
  // A record `resolveForExport` declines used to RETURN here, which put this
  // bench one step ahead of the product in exactly the way `/api/export` was:
  // the chooser has read per-package pin tables since 2026-08-16, and route two
  // below is where that happens, and neither was ever reached. Ten of the
  // fifty-six parts of the 2026-08-17 run were reported `held: missing
  // pinCount,pins` with their pinouts sitting on the record, labelled and
  // located. A bench that stops before the product does measures a product that
  // does not exist.
  //
  // Kept as the fallback reason rather than discarded: where route two offers
  // nothing either, "the reading is missing pins" is still the truest thing to
  // say about the part.
  let held: string | null = null;
  if (!resolved.ok) {
    held =
      resolved.untraceable && resolved.untraceable.length > 0
        ? `held: uncitable ${[...new Set(resolved.untraceable)].join(",")}`
        : `held: missing ${resolved.missing.join(",")}`;
  } else {
    try {
      await createExportZip(resolved.part, "kicad", { densityLevel: densityOf(settings) });
      return { ships: true, shipsAnswered: true, why: "", asked: 0, brokeWhenAnswered: null };
    } catch (error) {
      // ONE PART MUST NEVER KILL THE RUN.
      //
      // This rethrew anything that was not a `FootprintUnavailableError`, and on
      // 2026-08-17 a `FootprintInvalidError` from the output invariant ("the pin
      // table lists pin 9 and no land was placed for it") ended a paid 56-part
      // run partway through. $0.57 of answers were bought and no figure was
      // produced. `shipCheck` in `extraction.ts` has recorded any error as a
      // non-ship for months; this is the same rule with only one of its two
      // copies hardened.
      //
      // An invalid footprint IS a non-ship, and saying so is strictly more
      // informative than a stack trace: it is the output invariant doing its job.
      if (!(error instanceof FootprintUnavailableError)) {
        const why = error instanceof Error ? error.message.split("\n")[0].slice(0, 60) : "unknown";
        return { ships: false, shipsAnswered: false, why: `invalid: ${why}`, asked: 0, brokeWhenAnswered: null };
      }
      direct = error;
    }
  }

  // ROUTE TWO: whatever the chooser offers. Empty when the document names no
  // alternatives, which is why route one's refusal is kept rather than replaced.
  const choice = packageOptions(record, installAnswers(settings));
  if (choice.ok && choice.options.some((option) => option.status === "ships")) {
    return { ships: true, shipsAnswered: true, why: "", asked: 0, brokeWhenAnswered: null };
  }

  // The SMALLEST question set across every route, because that is the friction
  // the product actually imposes: the user takes the cheapest path on offer.
  const asks: Array<{ needs: RequiredInput[]; designator?: string }> = choice.ok
    ? choice.options
        .filter((option) => option.status === "needs-input")
        .map((option) => ({ needs: option.needs, designator: option.designator }))
    : [];
  if (direct && direct.needs.length > 0) asks.push({ needs: direct.needs });

  if (asks.length === 0) {
    // Nothing anywhere is answerable. Prefer route one's own words: it is about
    // the package actually read, and an option's reason is about a sibling.
    const unsupported = choice.ok ? choice.options.find((option) => option.status === "unsupported") : undefined;
    const reason = direct?.reason ?? unsupported?.reason ?? null;
    // The traceability refusal is the truest answer only when nothing else has
    // one: a record with no pins and no offered package really is unread.
    if (reason === null && held !== null) {
      return { ships: false, shipsAnswered: false, why: held, asked: 0, brokeWhenAnswered: null };
    }
    return {
      ships: false,
      shipsAnswered: false,
      why: `unsupported: ${(reason ?? "no land pattern").slice(0, 60)}`,
      asked: 0,
      brokeWhenAnswered: null
    };
  }
  const cheapest = asks.reduce((best, ask) => (ask.needs.length < best.needs.length ? ask : best));
  const fewest = cheapest.needs;

  // NOW ANSWER THEM, because that is what the user does next.
  //
  // Every value here is one a real user reads off the drawing in front of them;
  // the bench derives a self-consistent stand-in so the question under test is
  // "does the pipeline complete once an answer arrives", not "can the bench
  // guess the number". A part that still refuses after being answered is a
  // defect, and is reported by name rather than folded into the total.
  const answered = await exportWithAnswers(record, fewest, settings, cheapest.designator);
  return {
    ships: false,
    shipsAnswered: answered.ok,
    why: `needs ${fewest.map((need) => need.field).join(",")}`,
    asked: answered.ok ? answered.asked : fewest.length,
    brokeWhenAnswered: answered.ok ? null : answered.why
  };
}

/**
 * The settings a customer sets once, as the chooser and the exporter take them.
 *
 * The forming-die numbers are the two fields the settings screen makes
 * mandatory, precisely because no datasheet states them. A bench that leaves
 * them unset measures a product nobody uses: every straight-lead part would ask
 * for a span the customer has already given.
 */
function installAnswers(settings: ForgeSettings): OptionAnswers {
  return {
    ...(settings.formedLeadSpanMm !== undefined ? { formedLeadSpanMm: settings.formedLeadSpanMm } : {}),
    ...(settings.formedLeadContactMm !== undefined ? { formedLeadContactMm: settings.formedLeadContactMm } : {})
  };
}

/**
 * Answer every question the product asked, then try again.
 *
 * ## What this measures, and what it deliberately does not
 *
 * It measures whether the PIPELINE completes once answers arrive: that the
 * route accepts the field, that the generator uses it, and that the output
 * invariants pass on the result. It does NOT measure whether the bench guessed
 * the right number, and it must not be read that way. A real user reads these
 * off the package drawing in front of them.
 *
 * So the stand-ins are derived from the part's own record wherever it carries
 * anything to derive from, and are geometrically self-consistent where it does
 * not. Deriving matters: a land span invented independently of the body size
 * produces pads outside their own courtyard, and the output invariant would
 * then refuse a part for the bench's arithmetic rather than for the product's.
 */
async function exportWithAnswers(
  record: PartRecord,
  needs: RequiredInput[],
  settings: ForgeSettings,
  /** The package whose questions these are, so the answers come from ITS drawings. */
  forPackage?: string
): Promise<{ ok: true; asked: number } | { ok: false; why: string }> {
  const supplied: Record<string, unknown> = {};
  let asked = 0;

  // A QUESTION SET ARRIVES IN ROUNDS, and so does the user's answer.
  //
  // The land pattern and the arrangement are answered by different parts of the
  // generator, so supplying the pad size can reveal that the pitch is missing
  // too. Measured 2026-08-19, three parts hit exactly that: they were reported
  // as "answered and still refused" by a single-round bench, and every one of
  // them ships on the second round. A bench that asks once measures a product
  // that gives up when the user answers.
  //
  // Bounded, and the bound is the finding: a set of questions that keeps
  // growing is a refusal wearing a form, and four rounds is already more
  // friction than the input model allows.
  const MAX_ROUNDS = 4;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const outstanding = round === 0 ? needs : null;
    if (outstanding) for (const need of outstanding) supplied[need.field] = answerFor(need, record, forPackage);
    asked = Object.keys(supplied).length;

    const answers: OptionAnswers = {
      ...installAnswers(settings),
      supplied: supplied as SuppliedDimensions
    };

    // Route one, the record as it stands.
    const resolved = resolveForExport(record);
    if (resolved.ok) {
      try {
        await createExportZip(resolved.part, "kicad", {
          densityLevel: densityOf(settings),
          formedLeadSpanMm: settings.formedLeadSpanMm,
          formedLeadContactMm: settings.formedLeadContactMm,
          supplied: supplied as SuppliedDimensions
        });
        return { ok: true, asked };
      } catch (error) {
        if (error instanceof FootprintUnavailableError && error.needs.length > 0) {
          for (const need of error.needs) supplied[need.field] = answerFor(need, record, forPackage);
        }
      }
    }

    // Route two, whatever the chooser offers once the answers are in hand.
    const choice = packageOptions(record, answers);
    if (choice.ok && choice.options.some((option) => option.status === "ships")) return { ok: true, asked };
    const stillAsking = choice.ok
      ? choice.options.find((option) => option.status === "needs-input")
      : undefined;
    if (stillAsking && stillAsking.status === "needs-input") {
      const fresh = stillAsking.needs.filter((need) => supplied[need.field] === undefined);
      if (fresh.length === 0) {
        return { ok: false, why: `asks for ${stillAsking.needs.map((n) => n.field).join(",")} and refuses the answers` };
      }
      for (const need of fresh) supplied[need.field] = answerFor(need, record, stillAsking.designator);
      continue;
    }
    if (Object.keys(supplied).length === asked) {
      const unsupported = choice.ok ? choice.options.find((option) => option.status === "unsupported") : undefined;
      return { ok: false, why: (unsupported?.reason ?? "refused with no reason given").slice(0, 90) };
    }
  }
  return { ok: false, why: `still asking after ${MAX_ROUNDS} rounds of answers` };
}

/**
 * One stand-in answer, in the units the field is asked in.
 *
 * Every branch prefers a number the document DID supply over one it did not:
 * the questions overlap, and a body width the record carries is a better basis
 * for a land span than any constant. The constants that remain are the ordinary
 * proportions of a small surface-mount package, chosen so that the resulting
 * pads sit inside their own courtyard and clear of each other.
 */
function answerFor(need: RequiredInput, record: PartRecord, designator?: string): number | string {
  // THE CHOSEN PACKAGE'S OWN MEASUREMENTS, not the record's empty flat block.
  //
  // On a document whose part number does not name a package, every dimension
  // lives in `packagesInThisDocument` and `record.dimensions` is entirely null -
  // correctly, because there is no such thing as "the body size" of a part sold
  // in seven packages. Reading the flat block there gave every stand-in its
  // fallback constant, and a 3 mm span invented for a 4 mm VQFN puts the pads
  // inside the body.
  //
  // Measured 2026-08-20: that is the whole of MSP430FR2433's "ANSWERED AND
  // STILL REFUSED". The product asks two answerable questions and SHIPS when
  // they are answered with the package's real numbers. The bench was reporting
  // its own arithmetic as a product defect, which is the one thing this line
  // must never do.
  const perPackage = designator ? pinTableFor(record.packagesInThisDocument, designator)?.dimensions : undefined;
  const dims = { ...record.dimensions, ...(perPackage ?? {}) } as PartRecord["dimensions"];
  const num = (value: unknown): number | null => (typeof value === "number" && value > 0 ? value : null);
  const span = (value: unknown): number | null =>
    value !== null && typeof value === "object" && value !== null
      ? num((value as { nominal?: unknown }).nominal ?? (value as { max?: unknown }).max)
      : num(value);

  const body = num(dims.bodyLengthMm.value) ?? num(dims.bodyWidthMm.value) ?? 3;
  const pitch = num(dims.pitchMm.value) ?? 0.5;
  const pins = num(record.pinCount.value) ?? 8;
  const sides = dims.leadSides.value ?? (pins % 4 === 0 && pins >= 16 ? 4 : 2);

  switch (need.field) {
    case "bodyLengthMm":
      return num(dims.bodyLengthMm.value) ?? span(dims.leadSpanMm.value) ?? body;
    case "bodyWidthMm":
      return num(dims.bodyWidthMm.value) ?? span(dims.leadSpanCrossMm.value) ?? body;
    case "bodyHeightMm":
      return num(dims.bodyHeightMm.value) ?? 1;
    // The pad's radial length and tangential width. A no-lead package's pad is
    // about the lead's own contact length and a little over half the pitch
    // wide, which is what keeps neighbours clear at any pitch.
    case "landPadLengthMm":
      return span(dims.leadContactMm.value) ?? Math.max(0.4, Math.min(1, pitch * 1.2));
    case "landPadWidthMm":
      return Math.max(0.2, pitch * 0.55);
    // The centre-to-centre span across the package. Derived from the body so the
    // pads land under the leads rather than beyond the courtyard.
    case "landSpanMm":
      return span(dims.leadSpanMm.value) ?? body;
    case "landSpanCrossMm":
      return span(dims.leadSpanCrossMm.value) ?? span(dims.leadSpanMm.value) ?? body;
    case "leadDiameterMm":
      return 0.5;
    case "pitchMm":
      return pitch;
    case "thermalPadLengthMm":
      return num(dims.thermalPadLengthMm.value) ?? body * 0.6;
    case "thermalPadWidthMm":
      return num(dims.thermalPadWidthMm.value) ?? body * 0.6;
    case "leadSides":
      return sides;
    case "leadsPerSide": {
      const per = Math.floor(pins / sides);
      return Array.from({ length: sides }, (_, i) => (i === 0 ? pins - per * (sides - 1) : per)).join(",");
    }
    // Which grid position on the short row carries no lead. A package that asks
    // this has one more position than it has leads on that row, so the last one
    // is the answer that is always in range.
    case "vacantLeadSlot":
      return Math.max(1, Math.floor(pins / 2) + 1);
    case "formedLeadSpanMm":
      return span(dims.leadSpanMm.value) ?? body + 1;
    case "formedLeadContactMm":
      return span(dims.leadContactMm.value) ?? 0.6;
  }
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
  /** Ships once the customer's settings and their answers to our questions are in. */
  let shipsAnswered = 0;
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

    const reason = classify(record, parsed ?? undefined);
    reasons.set(reason, [...(reasons.get(reason) ?? []), part.partNumber]);
    if (reason.startsWith("read")) {
      read += 1;
      kind.read += 1;
      const outcome = await shipOutcome(record, BENCH_SETTINGS);
      if (outcome.ships) ships += 1;
      else shipRefusals.set(outcome.why, [...(shipRefusals.get(outcome.why) ?? []), part.partNumber]);
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

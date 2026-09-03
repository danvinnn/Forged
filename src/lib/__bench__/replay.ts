/**
 * Replays real model answers through the generator. Costs nothing.
 *
 * ## Why this exists
 *
 * Every number the generator turns into copper arrives from a model, and until
 * now the only way to see what it does with a real one was to pay for a run.
 * That is a bad position to be in: it makes the cheapest question in the project
 * ("does this record actually produce a footprint?") the most expensive one, and
 * it means generator changes get merged on the strength of fixtures somebody
 * wrote to pass.
 *
 * The cache already holds hundreds of genuine model responses for real
 * datasheets. Even where a prompt change has stranded an entry for CACHING
 * purposes, the answer itself is still a real answer about a real document. Fed
 * straight into the export path it exercises the whole downstream on real data,
 * and it does not care what the model would say today.
 *
 * ## What it does NOT do
 *
 * It does not measure extraction. A cached answer is what the model said, right
 * or wrong, and nothing here checks it against the datasheet. What it measures
 * is everything AFTER the reading: the merge shape, the refusals, the questions,
 * and whether a bundle comes out.
 *
 * It also does not replace the hold-out run. The hold-out measures reading; this
 * measures generating. Confusing the two is how a green suite gets mistaken for
 * a working product.
 *
 * Air-gap safe: reads local files, makes no request.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createExportZip, FootprintUnavailableError } from "../exporters";
import { lastRowIsNumberedThermalPad } from "../extraction/merge";
import { pinTypeFrom, type LeadWidth, type PartRecord, type PinRecord, type ResolvedPart } from "../types";

const CACHE_DIR = join(process.cwd(), ".model-cache");

interface CachedValue {
  value: unknown;
  page: number | null;
}

interface CachedEntry {
  label?: string;
  prompt?: string;
  storedAt?: string;
  result?: { values?: Record<string, CachedValue> };
}

/**
 * Every cached answer for a part, oldest first, merged field by field.
 *
 * ## Order is the whole point
 *
 * This used to iterate `readdirSync` order and let the last file seen win each
 * field. Directory order is not date order and is not stable across machines, so
 * two runs of `bench:copper` on the same cache could build different footprints
 * and neither was reproducible. Sorting by `storedAt` makes "newest wins" true
 * rather than merely claimed, which is what the old comment said and the old
 * code did not do.
 *
 * ## Why answers from OLD prompt versions are still merged in
 *
 * Deliberate, and it is the trade this bench is built on. Restricting to the
 * newest prompt version per part was measured on 2026-08-21: it cut the bench
 * from 59 footprints to 24, because most parts have only a first pass cached
 * under the newest version and the drawing fields live in the second.
 *
 * That trade is acceptable HERE and nowhere else, because this bench does not
 * measure extraction. A record stitched from two prompt versions is still a real
 * record shape for the generator to consume, which is all that is being
 * exercised. Anything asking whether the model READ correctly belongs in
 * `bench:dimensions`, which scores one prompt version against a hand-read
 * drawing and would be meaningless on a stitched record.
 *
 * Within a part, a later pass overwrites an earlier one, which is the precedence
 * `combine` applies in the pipeline: the second pass sees the rendered drawing
 * and the first only saw text.
 */
function cachedAnswers(): Map<string, Record<string, CachedValue>> {
  const entries: CachedEntry[] = [];
  for (const name of readdirSync(CACHE_DIR).sort()) {
    if (!name.endsWith(".json") || name.startsWith("_")) continue;
    try {
      entries.push(JSON.parse(readFileSync(join(CACHE_DIR, name), "utf8")) as CachedEntry);
    } catch {
      continue;
    }
  }
  // Oldest first. The filename tiebreak keeps two answers stored in the same
  // millisecond from depending on directory order, which is the bug being fixed.
  entries.sort((left, right) => (left.storedAt ?? "").localeCompare(right.storedAt ?? ""));

  const byPart = new Map<string, Record<string, CachedValue>>();
  for (const entry of entries) {
    const label = entry.label;
    const values = entry.result?.values;
    if (!label || !values) continue;
    const existing = byPart.get(label) ?? {};
    const versions = STITCHED_FROM.get(label) ?? new Set<string>();
    for (const [field, value] of Object.entries(values)) {
      if (value && value.value !== null && value.value !== undefined) {
        existing[field] = value;
        versions.add(entry.prompt ?? "");
      }
    }
    STITCHED_FROM.set(label, versions);
    byPart.set(label, existing);
  }
  return byPart;
}

/**
 * Which prompt versions each record's surviving fields actually came from.
 *
 * Needed because a stitched record can MANUFACTURE A DEFECT that no run
 * produces. ADXL345 was reported as shipping a wrong land span on 2026-08-22:
 * three cached answers read it correctly at 2.195 and one stale one read 2.29,
 * the stale one was newest, so it won the field. The live pipeline reads that
 * part correctly, and `bench:dimensions` says so.
 *
 * Stitching is still the right trade for exercising the GENERATOR, which is what
 * this bench is for. It is the wrong basis for a claim about what the READER
 * got, so a check that makes one asks this first.
 */
const STITCHED_FROM = new Map<string, Set<string>>();

/** True when this record's fields came from more than one prompt version. */
export function isStitched(partNumber: string): boolean {
  return (STITCHED_FROM.get(partNumber)?.size ?? 0) > 1;
}

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asRange = (value: unknown): LeadWidth | null => {
  if (typeof value !== "object" || value === null) return null;
  const range = value as { minMm?: unknown; maxMm?: unknown };
  return typeof range.minMm === "number" && typeof range.maxMm === "number"
    ? { minMm: range.minMm, maxMm: range.maxMm }
    : null;
};

/**
 * The pin table, coerced the way `merge.ts` coerces it.
 *
 * A model returns pin numbers as integers and the record holds strings, and a
 * non-numeric terminal (`PAD`, `EP`, `Exposed Pad`) is a thermal pad rather than
 * a pin. Both facts are handled in merge; repeated here because this harness
 * deliberately does not run merge, which needs the document.
 */
function pinsFrom(value: unknown): { pins: PinRecord[]; exposedPad: boolean } {
  if (!Array.isArray(value)) return { pins: [], exposedPad: false };
  const pins: PinRecord[] = [];
  let exposedPad = false;
  for (const row of value) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as { number?: unknown; name?: unknown; electricalType?: unknown };
    const number = String(record.number ?? "").trim();
    const name = String(record.name ?? "").trim();
    if (!number || !name) continue;
    if (!/^\d+$/.test(number)) {
      exposedPad = true;
      continue;
    }
    // THE TYPE THE MODEL RETURNED, not a constant. This used to hardcode
    // `unspecified`, so `bench:pintypes` measured 3114 of 3114 pins as carrying
    // no electrical type when 878 cached answers do carry one - and every bench
    // built on this harness, `bench:unchecked` included, was blind to the field.
    pins.push({ number, name, electricalType: pinTypeFrom(record.electricalType) });
  }
  return { pins, exposedPad };
}

/** A ResolvedPart built from what the model said, and from nothing else. */
function partFrom(label: string, values: Record<string, CachedValue>): ResolvedPart | null {
  const at = (field: string) => values[field]?.value;
  const read = pinsFrom(at("pins"));
  let pins = read.pins;
  let exposedPad = read.exposedPad;
  let pinCount = asNumber(at("pinCount")) ?? (pins.length > 0 ? pins.length : null);
  if (pinCount === null || pins.length === 0) return null;

  // AND THE OTHER HALF OF THE SAME RULE, which this file used to be missing.
  //
  // `pinsFrom` recognises a pad by a non-numeric designator, and says in its own
  // comment that it repeats what merge does. It repeated half. A vendor that
  // NUMBERS the pad row - TI's PowerPAD parts do - left the row in the table as
  // an ordinary lead, and this bench built a record the product cannot be in: 25
  // rows against a count of 24 with no exposed pad. The output invariant then
  // refused it, correctly, and this bench reported LTC6563 and TPS54360 REFUSED
  // while the product ships TPS54360 and refuses LTC6563 for something else
  // entirely. Two hours went into a defect that was the instrument's.
  //
  // Called rather than re-derived, so there is one definition of the rule.
  const declaredLeads = asNumber(at("dimensions.leadCount"));
  if (
    lastRowIsNumberedThermalPad({
      pins,
      exposedPad,
      declaredLeads,
      thermalPadLengthMm: asNumber(at("dimensions.thermalPadLengthMm")),
      thermalPadWidthMm: asNumber(at("dimensions.thermalPadWidthMm"))
    }) &&
    declaredLeads !== null
  ) {
    exposedPad = true;
    if (pinCount === pins.length) pinCount = declaredLeads;
    pins = pins.slice(0, -1);
  }

  const leadForm = at("dimensions.leadForm");
  const sides = asNumber(at("dimensions.leadSides"));

  return {
    id: label,
    partNumber: String(at("partNumber") ?? label),
    manufacturer: String(at("manufacturer") ?? "Unknown"),
    packageType: String(at("packageType") ?? "Unknown package"),
    // FROM THE CACHE, which holds it for 667 answers. Hardcoded null until
    // 2026-08-30, alongside `vendorLandPattern` below, and both matter: the
    // outline code is how `findVendorLandPattern` tells one drawing in a family
    // datasheet from another.
    packageOutlineCode: typeof at("packageOutlineCode") === "string" ? (at("packageOutlineCode") as string) : null,
    jedecOutline: typeof at("jedecOutline") === "string" ? (at("jedecOutline") as string) : null,
    // NULL HERE, and filled by `replayRecordsWithDocuments` for the benches that
    // need it. The struct is not a model answer: `withPrintedFootprint` builds
    // it by reading the datasheet's own printed footprint off the page, so it
    // needs the document, and this function is deliberately synchronous.
    vendorLandPattern: null,
    pinCount,
    pins,
    exposedPad,
    dimensions: {
      bodyLengthMm: asNumber(at("dimensions.bodyLengthMm")),
      bodyWidthMm: asNumber(at("dimensions.bodyWidthMm")),
      bodyHeightMm: asNumber(at("dimensions.bodyHeightMm")),
      pitchMm: asNumber(at("dimensions.pitchMm")),
      leadLengthMm: asNumber(at("dimensions.leadLengthMm")),
      leadCount: asNumber(at("dimensions.leadCount")),
      leadWidthMm: asRange(at("dimensions.leadWidthMm")),
      leadSpanMm: asRange(at("dimensions.leadSpanMm")),
      leadSpanCrossMm: asRange(at("dimensions.leadSpanCrossMm")),
      leadContactMm: asRange(at("dimensions.leadContactMm")),
      thermalPadLengthMm: asNumber(at("dimensions.thermalPadLengthMm")),
      thermalPadWidthMm: asNumber(at("dimensions.thermalPadWidthMm")),
      landPadLengthMm: asNumber(at("dimensions.landPadLengthMm")),
      landPadWidthMm: asNumber(at("dimensions.landPadWidthMm")),
      landSpanMm: asNumber(at("dimensions.landSpanMm")),
      // THE CROSS FIELD, not the main one. This read `dimensions.landSpanMm`
      // into the cross span until 2026-08-18, so every part this bench built was
      // a SQUARE quad by construction whatever its document said, and a
      // rectangular package could not be measured here at all.
      landSpanCrossMm: asNumber(at("dimensions.landSpanCrossMm")),
      // 1 is a real answer, and dropping it made every single-row package
      // (TO-220, TO-92, SIP) unbuildable in this bench alone.
      leadSides: sides === 1 || sides === 2 || sides === 4 ? (sides as 1 | 2 | 4) : null,
      leadForm:
        leadForm === "gullwing" || leadForm === "nolead" || leadForm === "straight" ? leadForm : null,
      mounting: at("dimensions.mounting") === "through-hole" ? "through-hole" : at("dimensions.mounting") === "smd" ? "smd" : null,
      leadDiameterMm: asNumber(at("dimensions.leadDiameterMm")),
      holeDiameterMm: asNumber(at("dimensions.holeDiameterMm")),
      vacantLeadSlot: asNumber(at("dimensions.vacantLeadSlot")),
      leadsPerSide: typeof at("dimensions.leadsPerSide") === "string" ? (at("dimensions.leadsPerSide") as string) : null,
      solderMaskExpansionMm: asNumber(at("dimensions.solderMaskExpansionMm")),
      solderMaskDefined:
        at("dimensions.solderMaskDefined") === "solder-mask-defined" ||
        at("dimensions.solderMaskDefined") === "non-solder-mask-defined"
          ? (at("dimensions.solderMaskDefined") as "solder-mask-defined" | "non-solder-mask-defined")
          : null,
      thermalViaDiameterMm: asNumber(at("dimensions.thermalViaDiameterMm")),
      thermalViaPitchMm: asNumber(at("dimensions.thermalViaPitchMm"))
    },
    radiation: {
      tid: typeof at("radiation.tid") === "string" ? (at("radiation.tid") as string) : null,
      see: typeof at("radiation.see") === "string" ? (at("radiation.see") as string) : null,
      sel: typeof at("radiation.sel") === "string" ? (at("radiation.sel") as string) : null,
      qmlClass: typeof at("radiation.qmlClass") === "string" ? (at("radiation.qmlClass") as string) : null
    },
    sourceFileName: `${label}.pdf`,
    notes: []
  };
}

export type ReplayOutcome =
  | { part: string; status: "ships"; files: number }
  | { part: string; status: "asks"; needs: string[] }
  | { part: string; status: "refused"; reason: string }
  | { part: string; status: "no-record"; reason: string };

/**
 * Every cached answer as a record the generator will accept.
 *
 * Split out so a second bench can measure the COPPER these produce without
 * rebuilding the cache reader beside it. Two readers of the same cache would
 * drift, and the one that drifted would be the one making the correctness
 * claim.
 */
export function replayRecords(): ResolvedPart[] {
  const out: ResolvedPart[] = [];
  for (const [label, values] of [...cachedAnswers()].sort()) {
    const part = partFrom(label, values);
    if (part) out.push(part);
  }
  return out;
}

/**
 * The same records, WITH the printed footprint the product repairs onto them.
 *
 * ## Why this had to exist
 *
 * `withPrintedFootprint` is not decoration. It is where the second source for a
 * land pattern comes from, and `confirmPitch`, `confirmThermalPad` and
 * `contradictsPrintedLand` all read the struct it writes. A record that has not
 * been through it carries null, so every check resting on the datasheet's own
 * printed footprint is inert.
 *
 * Measured on 2026-08-30: `bench:unchecked` doubled the pitch of 128 footprints
 * and reported `0 confirmed, 0 caught, 0 still confirmed` - a row of zeros that
 * reads as a clean sheet and is an instrument measuring nothing. The pitch was
 * never CONFIRMED on any part, because confirming it needs the printed
 * footprint, because `replayRecords` set it to null. The same three-zero row sat
 * under `thermalPad x2` and `formed span x0.4`.
 *
 * `readout.ts` names this exact failure for a different bench in its own header.
 * It happened again one level down.
 *
 * Costs a PDF parse per part, which is why it is not what `replayRecords` does.
 */
export async function replayRecordsWithDocuments(): Promise<ResolvedPart[]> {
  const { documentFor } = await import("./oracle-match");
  const { withPrintedFootprint } = await import("../readout");
  const out: ResolvedPart[] = [];
  for (const part of replayRecords()) {
    // The label carries the package after a `#`; the document is filed under the
    // part alone.
    const doc = await documentFor(part.partNumber.split("#")[0]);
    if (!doc) {
      out.push(part);
      continue;
    }
    const repaired = withPrintedFootprint(
      {
        vendorLandPattern: null,
        packageType: { value: part.packageType },
        packageOutlineCode: { value: part.packageOutlineCode }
      } as unknown as PartRecord,
      doc
    );
    out.push(
      repaired.vendorLandPattern && repaired.vendorLandPattern.valuesMm.length > 0
        ? { ...part, vendorLandPattern: repaired.vendorLandPattern }
        : part
    );
  }
  return out;
}

export async function replay(): Promise<ReplayOutcome[]> {
  const outcomes: ReplayOutcome[] = [];
  for (const [label, values] of [...cachedAnswers()].sort()) {
    const part = partFrom(label, values);
    if (!part) {
      outcomes.push({ part: label, status: "no-record", reason: "no pin table or no pin count" });
      continue;
    }
    try {
      const bundle = await createExportZip(part, "kicad");
      outcomes.push({ part: label, status: "ships", files: bundle.files.length });
    } catch (error) {
      if (error instanceof FootprintUnavailableError) {
        outcomes.push(
          error.needs.length > 0
            ? { part: label, status: "asks", needs: error.needs.map((need) => need.field) }
            : { part: label, status: "refused", reason: error.reason }
        );
        continue;
      }
      outcomes.push({
        part: label,
        status: "refused",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return outcomes;
}

async function main() {
  const outcomes = await replay();
  const counts = { ships: 0, asks: 0, refused: 0, "no-record": 0 } as Record<string, number>;
  for (const outcome of outcomes) counts[outcome.status] += 1;

  console.log(`\nReplayed ${outcomes.length} parts from cached model answers. No network, no spend.\n`);
  for (const outcome of outcomes) {
    const detail =
      outcome.status === "asks"
        ? outcome.needs.join(", ")
        : outcome.status === "ships"
          ? `${outcome.files} files`
          : outcome.reason.slice(0, 110);
    console.log(`  ${outcome.status.padEnd(10)} ${outcome.part.padEnd(20)} ${detail}`);
  }

  const total = outcomes.length;
  console.log(
    `\n  SHIPS ${counts.ships}/${total} (${Math.round((counts.ships / total) * 100)}%)` +
      `   ASKS ${counts.asks}   REFUSED ${counts.refused}   NO RECORD ${counts["no-record"]}\n`
  );

  // What the questions actually are, since "asks" is only useful if the same
  // few fields dominate.
  const asked = new Map<string, number>();
  for (const outcome of outcomes) {
    if (outcome.status !== "asks") continue;
    for (const field of outcome.needs) asked.set(field, (asked.get(field) ?? 0) + 1);
  }
  if (asked.size > 0) {
    console.log("  What is asked for, most often first:");
    for (const [field, count] of [...asked].sort((left, right) => right[1] - left[1])) {
      console.log(`    ${String(count).padStart(3)}  ${field}`);
    }
    console.log();
  }
}

if (process.argv[1]?.endsWith("replay.ts")) {
  void main();
}

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
import { createExportZip, FootprintUnavailableError, packageOptions } from "../exporters";
import { resolveForExport, type LeadWidth, type PartRecord, type PinRecord, type ResolvedPart } from "../types";

const CACHE_DIR = join(process.cwd(), ".model-cache");

interface CachedValue {
  value: unknown;
  page: number | null;
}

interface CachedEntry {
  label?: string;
  prompt?: string;
  result?: { values?: Record<string, CachedValue> };
}

/** Every cached answer, newest per part, keyed by the part it was read for. */
function cachedAnswers(): Map<string, Record<string, CachedValue>> {
  const byPart = new Map<string, Record<string, CachedValue>>();
  for (const name of readdirSync(CACHE_DIR)) {
    if (!name.endsWith(".json") || name.startsWith("_")) continue;
    let entry: CachedEntry;
    try {
      entry = JSON.parse(readFileSync(join(CACHE_DIR, name), "utf8")) as CachedEntry;
    } catch {
      continue;
    }
    const label = entry.label;
    const values = entry.result?.values;
    if (!label || !values) continue;
    // Later passes carry more: the second pass of a two-pass run answers the
    // drawing fields the first could not. Merged rather than replaced, the same
    // way `combine` in the extraction pipeline merges them.
    const existing = byPart.get(label) ?? {};
    for (const [field, value] of Object.entries(values)) {
      if (value && value.value !== null && value.value !== undefined) existing[field] = value;
    }
    byPart.set(label, existing);
  }
  return byPart;
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
    const record = row as { number?: unknown; name?: unknown };
    const number = String(record.number ?? "").trim();
    const name = String(record.name ?? "").trim();
    if (!number || !name) continue;
    if (!/^\d+$/.test(number)) {
      exposedPad = true;
      continue;
    }
    pins.push({ number, name, electricalType: "unspecified" });
  }
  return { pins, exposedPad };
}

/** A ResolvedPart built from what the model said, and from nothing else. */
function partFrom(label: string, values: Record<string, CachedValue>): ResolvedPart | null {
  const at = (field: string) => values[field]?.value;
  const { pins, exposedPad } = pinsFrom(at("pins"));
  const pinCount = asNumber(at("pinCount")) ?? (pins.length > 0 ? pins.length : null);
  if (pinCount === null || pins.length === 0) return null;

  const leadForm = at("dimensions.leadForm");
  const sides = asNumber(at("dimensions.leadSides"));

  return {
    id: label,
    partNumber: String(at("partNumber") ?? label),
    manufacturer: String(at("manufacturer") ?? "Unknown"),
    packageType: String(at("packageType") ?? "Unknown package"),
    packageOutlineCode: null,
    jedecOutline: typeof at("jedecOutline") === "string" ? (at("jedecOutline") as string) : null,
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
      leadContactMm: asRange(at("dimensions.leadContactMm")),
      thermalPadLengthMm: asNumber(at("dimensions.thermalPadLengthMm")),
      thermalPadWidthMm: asNumber(at("dimensions.thermalPadWidthMm")),
      landPadLengthMm: asNumber(at("dimensions.landPadLengthMm")),
      landPadWidthMm: asNumber(at("dimensions.landPadWidthMm")),
      landSpanMm: asNumber(at("dimensions.landSpanMm")),
      leadSides: sides === 2 || sides === 4 ? (sides as 2 | 4) : null,
      leadForm:
        leadForm === "gullwing" || leadForm === "nolead" || leadForm === "straight" ? leadForm : null,
      mounting: at("dimensions.mounting") === "through-hole" ? "through-hole" : at("dimensions.mounting") === "smd" ? "smd" : null,
      leadDiameterMm: asNumber(at("dimensions.leadDiameterMm")),
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

export { cachedAnswers, partFrom, packageOptions, resolveForExport, type PartRecord };

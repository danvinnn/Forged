/**
 * Which guards actually fire, and on what. Costs nothing.
 *
 * ## Why this exists
 *
 * Most checks in the footprint path do not refuse. They return null, and the
 * caller then tells the user "no land pattern could be read from this
 * datasheet". That sentence is true of a silent document and false of one whose
 * printed footprint a check rejected, and the two were indistinguishable to
 * everybody: the user, the bench, and anyone asking whether a given check still
 * earns its place.
 *
 * So no guard in this product has ever had to justify itself. A guard is not
 * free: it carries a test, a paragraph of comment claiming protection, and the
 * risk of throwing away the answer the document actually gave. This measures
 * what each one costs and what it catches.
 *
 * ## The rule it obeys
 *
 * TUNED CORPUS ONLY, and this is not a technicality. Deciding a guard's fate
 * from how often it fires on hold-out parts is tuning against the hold-out,
 * which is the one thing that corpus exists to prevent. The hold-out is counted
 * separately and reported below the line, as a CONSEQUENCE of a decision taken
 * on the tuned set, never as the evidence for it.
 *
 * Air-gap safe: reads local files, makes no request.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createExportZip, FootprintUnavailableError } from "../exporters";
import { BENCH_CORPUS } from "../retrieval/__bench__/corpus";
import { type LeadWidth, type PinRecord, type ResolvedPart } from "../types";

const CACHE_DIR = join(process.cwd(), ".model-cache");

const key = (partNumber: string) => partNumber.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const TUNED = new Set(BENCH_CORPUS.map((part) => key(part.partNumber)));

/**
 * The hold-out part numbers, READ OUT OF `holdout.ts` rather than imported.
 *
 * Importing it runs it: the module calls its own `main` on load, so the first
 * version of this bench executed a hold-out measurement as a side effect of
 * asking which parts were in it. Nothing was spent, because that run is cached
 * by default, but a bench that silently starts another bench is exactly the kind
 * of accident this corpus must be insulated from.
 *
 * These names are used ONLY to exclude those parts from the evidence. No
 * hold-out document is opened and no failure of one is diagnosed.
 */
const HOLDOUT = new Set(
  [
    ...readFileSync(join(process.cwd(), "src/lib/__bench__/holdout.ts"), "utf8").matchAll(
      /partNumber:\s*"([^"]+)"/g
    )
  ].map((match) => key(match[1]))
);

interface CachedValue {
  value: unknown;
  page: number | null;
}

/** Every cached answer, merged across passes, keyed by the part it was read for. */
function cachedAnswers(): Map<string, Record<string, CachedValue>> {
  const byPart = new Map<string, Record<string, CachedValue>>();
  for (const name of readdirSync(CACHE_DIR)) {
    if (!name.endsWith(".json") || name.startsWith("_")) continue;
    let entry: { label?: string; result?: { values?: Record<string, CachedValue> } };
    try {
      entry = JSON.parse(readFileSync(join(CACHE_DIR, name), "utf8"));
    } catch {
      continue;
    }
    const label = entry.label;
    const values = entry.result?.values;
    if (!label || !values) continue;
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

function partFrom(label: string, values: Record<string, CachedValue>): ResolvedPart | null {
  const at = (field: string) => values[field]?.value;
  const { pins, exposedPad } = pinsFrom(at("pins"));
  const pinCount = asNumber(at("pinCount")) ?? (pins.length > 0 ? pins.length : null);
  if (pinCount === null || pins.length === 0) return null;

  const leadForm = at("dimensions.leadForm");
  const sides = asNumber(at("dimensions.leadSides"));
  const mounting = at("dimensions.mounting");

  return {
    id: label,
    partNumber: String(at("partNumber") ?? label),
    manufacturer: String(at("manufacturer") ?? "Unknown"),
    packageType: String(at("packageType") ?? "Unknown package"),
    packageOutlineCode: null,
    jedecOutline: null,
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
      mounting: mounting === "through-hole" ? "through-hole" : mounting === "smd" ? "smd" : null,
      leadDiameterMm: asNumber(at("dimensions.leadDiameterMm")),
      vacantLeadSlot: asNumber(at("dimensions.vacantLeadSlot")),
      leadsPerSide:
        typeof at("dimensions.leadsPerSide") === "string" ? (at("dimensions.leadsPerSide") as string) : null,
      solderMaskExpansionMm: asNumber(at("dimensions.solderMaskExpansionMm")),
      solderMaskDefined:
        at("dimensions.solderMaskDefined") === "solder-mask-defined" ||
        at("dimensions.solderMaskDefined") === "non-solder-mask-defined"
          ? (at("dimensions.solderMaskDefined") as "solder-mask-defined" | "non-solder-mask-defined")
          : null,
      thermalViaDiameterMm: asNumber(at("dimensions.thermalViaDiameterMm")),
      thermalViaPitchMm: asNumber(at("dimensions.thermalViaPitchMm"))
    },
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: `${label}.pdf`,
    notes: []
  };
}

/**
 * Which guard a refusal names, collapsed to a stable id.
 *
 * Matched on the phrasing the discard writes, which is the only thing that
 * crosses the boundary. Keyed rather than free text so the count means
 * something.
 */
const GUARDS: Array<{ id: string; where: string; test: RegExp }> = [
  { id: "printed-outside-ipc-band", where: "printedLand -> withinIpcBand", test: /outside what IPC-7351B/ },
  { id: "printed-land-wider-than-pitch", where: "printedLand", test: /would touch its \nneighbour|would touch its neighbour/ },
  { id: "printed-rows-overlap", where: "printedLand", test: /puts the \ntwo rows into each other|puts the two rows into each other/ },
  { id: "lead-too-wide-for-pitch", where: "leadFromDrawing", test: /leaves almost no gap to its neighbour/ },
  { id: "computed-contradicts-printed", where: "contradictsPrintedLand", test: /disagrees with it/ },
  { id: "computed-inconsistent", where: "computeLandPattern", test: /could not be computed from the package drawing/ },
  { id: "package-name-vs-pin-count", where: "buildFootprintGeometry", test: /describe different packages/ }
];

interface Row {
  part: string;
  set: "tuned" | "holdout" | "other";
  outcome: "ships" | "asks" | "refused";
  guards: string[];
  /** True when the document PRINTED a full land pattern and a guard rejected it. */
  hadPrintedPattern: boolean;
  /** The refusal verbatim, so a pattern that matches nothing can be seen to. */
  raw: string;
}

async function main() {
  const rows: Row[] = [];

  for (const [label, values] of [...cachedAnswers()].sort()) {
    const part = partFrom(label, values);
    if (!part) continue;
    const k = key(label);
    const set: Row["set"] = TUNED.has(k) ? "tuned" : HOLDOUT.has(k) ? "holdout" : "other";
    const hadPrintedPattern =
      part.dimensions.landPadLengthMm !== null &&
      part.dimensions.landPadWidthMm !== null &&
      part.dimensions.landSpanMm !== null;

    try {
      await createExportZip(part, "kicad");
      rows.push({ part: label, set, outcome: "ships", guards: [], hadPrintedPattern, raw: "" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const guards = GUARDS.filter((guard) => guard.test.test(message)).map((guard) => guard.id);
      const outcome: Row["outcome"] =
        error instanceof FootprintUnavailableError && error.needs.length > 0 ? "asks" : "refused";
      rows.push({ part: label, set, outcome, guards, hadPrintedPattern, raw: message });
    }
  }

  const report = (set: Row["set"], heading: string) => {
    const scoped = rows.filter((row) => row.set === set);
    if (scoped.length === 0) return;
    console.log(`\n${heading}  (${scoped.length} parts with a cached reading)\n`);

    const fired = new Map<string, string[]>();
    for (const row of scoped) {
      for (const guard of row.guards) fired.set(guard, [...(fired.get(guard) ?? []), row.part]);
    }

    for (const guard of GUARDS) {
      const hits = fired.get(guard.id) ?? [];
      // A guard that costs a part is one that fired on a document which HAD a
      // complete printed pattern: something was thrown away, not merely absent.
      const costly = hits.filter((part) => scoped.find((row) => row.part === part)?.hadPrintedPattern);
      const verdict = hits.length === 0 ? "never fires" : `${costly.length} of ${hits.length} threw away a printed pattern`;
      console.log(`  ${String(hits.length).padStart(3)}  ${guard.id.padEnd(30)} ${verdict}`);
      if (hits.length > 0) console.log(`       ${guard.where}: ${hits.slice(0, 8).join(", ")}${hits.length > 8 ? ", ..." : ""}`);
    }

    const ships = scoped.filter((row) => row.outcome === "ships").length;
    console.log(`\n  SHIPS ${ships}/${scoped.length}`);
  };

  // The raw refusals, so a guard reported as "never fires" can be checked
  // against what the generator actually said rather than against my patterns.
  if (process.argv.includes("--why")) {
    console.log("\nRAW REFUSALS, tuned corpus:\n");
    for (const row of rows.filter((r) => r.set === "tuned" && r.outcome !== "ships")) {
      console.log(`  ${row.part}  [printed pattern on record: ${row.hadPrintedPattern}]`);
      console.log(`    ${row.raw.replace(/\s+/g, " ").slice(0, 220)}\n`);
    }
  }

  report("tuned", "TUNED CORPUS. This is the evidence a guard is judged on.");
  report(
    "holdout",
    "HOLD-OUT, reported only as a consequence. Never the basis for a decision, per RULES.md."
  );
  report("other", "Cached parts in neither corpus.");
  console.log();
}

if (process.argv[1]?.endsWith("guards.ts")) {
  void main();
}

/**
 * CORRUPT EACH VALUE THAT PLACES COPPER. DOES ANYTHING NOTICE?
 *
 * ## The failure this exists to find
 *
 * On 2026-08-28 a straight-lead part was found building its lands from
 * `formedLeadSpanMm`, a settings-screen value, while the check written to catch
 * a span ending inside its own body reads `dimensions.leadSpanMm` - the
 * DRAWING's span, which is null on exactly those packages. The check reported
 * "unavailable" and six of twelve ceramic flat packs built with their leads a
 * third of the way inside the package body.
 *
 * That is a shape, not a bug. The same week: the benches measured a record the
 * product enriches, the review panel read a flat block the product does not
 * build from, and the copper bench compared pads to a record rather than to a
 * drawing. Every time, a check existed and did not look at the value that ships.
 *
 * ## Why this mutates rather than maps
 *
 * The first version carried a hand-written table of which check covers which
 * value, and over-reported badly: it counted only the confidence checks and knew
 * nothing of `validateGeometry` or `confirmations`, so it called 21 values
 * unchecked that the export gate refuses outright. A hand-written map of
 * coverage is exactly the thing most likely to be wrong, and being wrong there
 * makes this bench lie in the direction that feels like diligence.
 *
 * So it asks the question directly. Take a value that places copper, make it
 * WRONG, and see whether anything in the product objects - the export gate, any
 * confidence check, or any confirmation. Nothing objecting means that value can
 * be wrong and ship silently, which is the one outcome the product forbids.
 *
 * Free: cached answers off disk, no network, no spend.
 */

import { buildFootprintGeometry } from "../exporters";
import { replayRecordsWithDocuments } from "./replay";
import { confidenceChecks, validateGeometry } from "../confidence";
import { confirmations } from "../confirm";
import { BENCH_SETTINGS } from "./shipcheck";
import { densityOf } from "../settings";
import type { ResolvedPart } from "../types";

/**
 * The values that decide where copper goes, and a WRONG version of each.
 *
 * Wrong by a lot, deliberately. This is not asking how sensitive the checks are,
 * it is asking whether they exist at all: a value that can be doubled or halved
 * with nothing objecting is a value nothing is looking at.
 */
const MUTATIONS: Array<{
  name: string;
  apply: (part: ResolvedPart) => ResolvedPart | null;
  /** Some values arrive from the settings rather than the record. */
  formedSpan?: number;
  /**
   * The confirmation that vouches for this value.
   *
   * THE INVARIANT defines "ships silently" as "confirmed": a flagged value has
   * been put in front of the user and is not silent, whatever else is wrong with
   * it. So the question this bench asks is exactly - can this value be corrupted
   * while its own confirmation still says confirmed? Anything else is a matter
   * of how loudly we complain, and that is not what is being measured.
   */
  vouchedBy: string;
}> = [
  {
    name: "pitchMm x2",
    vouchedBy: "pitch",
    apply: (p) => (p.dimensions.pitchMm === null ? null : { ...p, dimensions: { ...p.dimensions, pitchMm: p.dimensions.pitchMm * 2 } })
  },
  {
    name: "landSpanMm x0.5",
    vouchedBy: "land-pattern",
    apply: (p) => (p.dimensions.landSpanMm === null ? null : { ...p, dimensions: { ...p.dimensions, landSpanMm: p.dimensions.landSpanMm * 0.5 } })
  },
  {
    name: "landPadLengthMm x3",
    vouchedBy: "land-pattern",
    apply: (p) => (p.dimensions.landPadLengthMm === null ? null : { ...p, dimensions: { ...p.dimensions, landPadLengthMm: p.dimensions.landPadLengthMm * 3 } })
  },
  {
    name: "landPadWidthMm x3",
    vouchedBy: "land-pattern",
    apply: (p) => (p.dimensions.landPadWidthMm === null ? null : { ...p, dimensions: { ...p.dimensions, landPadWidthMm: p.dimensions.landPadWidthMm * 3 } })
  },
  {
    name: "thermalPad x2",
    vouchedBy: "thermal-pad",
    apply: (p) =>
      !p.exposedPad || p.dimensions.thermalPadLengthMm === null || p.dimensions.thermalPadWidthMm === null
        ? null
        : { ...p, dimensions: { ...p.dimensions, thermalPadLengthMm: p.dimensions.thermalPadLengthMm * 2, thermalPadWidthMm: p.dimensions.thermalPadWidthMm * 2 } }
  },
  {
    name: "bodyWidthMm x0.4",
    vouchedBy: "body",
    apply: (p) => (p.dimensions.bodyWidthMm === null ? null : { ...p, dimensions: { ...p.dimensions, bodyWidthMm: p.dimensions.bodyWidthMm * 0.4 } })
  },
  {
    name: "leadSides 2<->4",
    vouchedBy: "arrangement",
    apply: (p) =>
      p.dimensions.leadSides === null ? null : { ...p, dimensions: { ...p.dimensions, leadSides: p.dimensions.leadSides === 4 ? 2 : 4 } }
  },
  {
    // THE ONE THAT STARTED THIS. A settings value, not a record value, so it is
    // mutated through the argument rather than the part.
    name: "formed span x0.4 (setting)",
    vouchedBy: "land-pattern",
    apply: (p) => (p.dimensions.leadForm === "straight" ? p : null),
    formedSpan: (BENCH_SETTINGS.formedLeadSpanMm ?? 7.62) * 0.4
  }
];

/**
 * What the product says about one record: does it build, does the gate pass, and
 * how much is wrong or flagged.
 *
 * Returned as a comparable shape rather than a verdict, because the question is
 * whether the mutation made things WORSE, not whether the part is perfect. The
 * first version demanded a spotless baseline and found none - with no document
 * to corroborate a pinout against, every part carries at least one flag - so it
 * measured zero parts and reported "every corrupted value was objected to by
 * something". A false clean sheet from an instrument measuring nothing, which is
 * the failure this whole file exists to catch, committed by the file itself.
 */
/**
 * Is the value that vouches for this one still saying "confirmed"?
 *
 * Null where the footprint no longer builds at all, which is itself an
 * objection.
 */
function stateOf(part: ResolvedPart, formedSpan: number | undefined, id: string): "confirmed" | "flagged" | null {
  try {
    const geometry = buildFootprintGeometry(
      part,
      densityOf(BENCH_SETTINGS),
      formedSpan ?? BENCH_SETTINGS.formedLeadSpanMm,
      undefined,
      BENCH_SETTINGS.formedLeadContactMm
    );
    try {
      validateGeometry(geometry, part);
    } catch {
      return null;
    }
    if (confidenceChecks(part).some((check) => check.state === "fail")) return null;
    const item = confirmations(
      part,
      geometry,
      null,
      formedSpan ?? BENCH_SETTINGS.formedLeadSpanMm,
      BENCH_SETTINGS.formedLeadContactMm
    ).items.find((entry) => entry.id === id);
    return item?.state ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const silent = new Map<string, string[]>();
  const caught = new Map<string, number>();
  const applicable = new Map<string, number>();
  let base = 0;

  for (const part of await replayRecordsWithDocuments()) {
    base += 1;
    for (const mutation of MUTATIONS) {
      // ONLY WHERE THE PRODUCT CURRENTLY VOUCHES FOR THIS VALUE. A value already
      // flagged is not silent, and corrupting it proves nothing about the
      // invariant.
      if (stateOf(part, undefined, mutation.vouchedBy) !== "confirmed") continue;
      const mutated = mutation.apply(part);
      if (mutated === null) continue;
      applicable.set(mutation.name, (applicable.get(mutation.name) ?? 0) + 1);
      if (stateOf(mutated, mutation.formedSpan, mutation.vouchedBy) === "confirmed") {
        silent.set(mutation.name, [...(silent.get(mutation.name) ?? []), `${part.partNumber} (${String(part.packageType).slice(0, 20)})`]);
      } else {
        caught.set(mutation.name, (caught.get(mutation.name) ?? 0) + 1);
      }
    }
  }

  console.log(`\nCorrupted each copper-placing value on ${base} footprints, wherever the product currently CONFIRMS it. No spend.\n`);
  console.log(`  ${"mutation".padEnd(28)} ${"confirmed".padStart(10)} ${"caught".padStart(7)} ${"STILL CONFIRMED".padStart(16)}`);
  for (const mutation of MUTATIONS) {
    const n = applicable.get(mutation.name) ?? 0;
    const quiet = silent.get(mutation.name)?.length ?? 0;
    // A ROW OF ZEROS IS NOT A PASS. Where the product never CONFIRMS a value on
    // this corpus there is nothing to corrupt, and the row has measured nothing.
    // Three rows read `0 0 0` until 2026-08-30 and were taken for clean sheets.
    console.log(
      `  ${mutation.name.padEnd(28)} ${String(n).padStart(10)} ${String(caught.get(mutation.name) ?? 0).padStart(7)} ${String(quiet).padStart(16)}` +
        (n === 0 ? "  <-- NO DATA, nothing confirmed this value to corrupt" : quiet > 0 ? "  <-- HOLE" : "")
    );
  }
  console.log("");
  for (const [name, parts] of silent) {
    console.log(`  ${name} stays CONFIRMED on ${parts.length}:`);
    console.log(`      ${parts.slice(0, 8).join(", ")}${parts.length > 8 ? " ..." : ""}`);
  }
  if (silent.size === 0) console.log("  Every corrupted value was objected to by something.");
  console.log("");
}

if (process.argv[1]?.endsWith("unchecked.ts")) {
  void main();
}

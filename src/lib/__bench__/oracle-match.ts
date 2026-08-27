/**
 * ONE answer to "which hand-read drawing does this cached part correspond to".
 *
 * ## Why this is its own module
 *
 * `bench:dimensions` grew this matching over several sittings, and every step
 * of it was paid for by a wrong measurement: the height veto came from an
 * ADS1115 reading scored against the wrong one of two drawings in its own
 * datasheet, the `designators` route came from TSZ121's SC70 reading scored
 * against a DFN8, and the shipped-package substitution came from twenty-seven
 * hand-read comparisons that all reported "not read" because the bench was
 * looking at the flat block while the product built from the per-package table.
 *
 * `bench:questions` has to make exactly the same match - a question is false
 * only if the drawing that WOULD have answered it has been read - and this
 * project has now paid three separate times for two benches reimplementing one
 * rule and drifting apart. `shipcheck.ts` exists for the same reason and says
 * so in its own header.
 *
 * So the record building and the drawing match live here once, and both benches
 * import them. Free and offline by construction: the model is a cache reader
 * that throws on a miss.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractPartRecord } from "../datasheet";
import { makeExtractionModel, runExtraction } from "../extraction";
import type { ExtractionModel } from "../extraction/contracts";
import { getDeploymentMode } from "../retrieval/deployment";
import { statedMaxHeightMm } from "../extraction/merge";
import { withPrintedFootprint } from "../readout";
import type { DatasheetText } from "../pdftext";
import type { ExtractionField } from "../extraction/contracts";
import type { PartRecord } from "../types";
import { pinTableFor, sameOutlineCode } from "../packagevariants";
import { DIMENSION_ORACLE } from "./dimension-oracle";
import { cachingModel } from "./modelcache";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";

const CACHE = join(process.cwd(), ".model-cache");

/** The flat map of field name to value-and-page that the comparisons read. */
export type OracleValues = Record<
  string,
  {
    value?: unknown;
    page?: number | null;
    /**
     * The citation's own words, carried so a caller can ask what EVIDENCE a
     * reading rests on and not only whether it is right.
     *
     * The question that needed it: `verifyCitation` accepts a scalar whose
     * string form appears anywhere on the page, so a `landPadLengthMm` of 1.2 is
     * "cited" by the characters `1.2` occurring somewhere on a drawing page - and
     * one of `1` by any page with a digit 1 on it. Whether that shape of evidence
     * correlates with being WRONG is a fact about the product, and it cannot be
     * asked without the snippet.
     */
    snippet?: string | null;
  }
>;

export interface BuiltPart {
  part: string;
  /** The values the PRODUCT would hold, including the per-package substitution. */
  values: OracleValues;
  /** The record itself, for callers that need more than the dimensions. */
  record: PartRecord;
  /**
   * What the merge SAID it threw away, and why.
   *
   * Carried so `bench:discards` can ask the question that matters: is every
   * value the model returned either on the record or accounted for here? A
   * discard the code cannot name is the failure this project has hit six times.
   */
  rejected: Array<{ field: ExtractionField; reason: string }>;
  /** Fields kept on the record with no citation, which the export gate refuses. */
  uncited: ExtractionField[];
  /** The oracle key this part's reading is judged against, or null if unmatched. */
  oracleCode: string | null;
  /**
   * The outline code the record reported, kept even when it matches no entry.
   * Printing it turns "no oracle entry" into a work queue naming the drawing.
   */
  claimedCode: string | null;
}

/** The parsed document for a part, from either cache, or null. Memoised. */
const documents = new Map<string, DatasheetText | null>();
export async function documentFor(part: string): Promise<DatasheetText | null> {
  if (documents.has(part)) return documents.get(part) ?? null;
  let parsed: DatasheetText | null = null;
  for (const dir of [".bench-cache", ".holdout-cache"]) {
    const path = join(process.cwd(), dir, `${part}.pdf`);
    if (!existsSync(path)) continue;
    try {
      const bytes = readFileSync(path);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      ({ doc: parsed } = await extractPartRecord(`${part}.pdf`, buffer));
    } catch {
      parsed = null;
    }
    break;
  }
  documents.set(part, parsed);
  return parsed;
}

/**
 * The values the PRODUCT would hold for this part, built the way it builds them.
 *
 * ## What this replaces, and why it had to go
 *
 * This used to be four lines that walked every cache file for a part, in
 * `readdirSync` order, and kept the first non-null it met for each field. That
 * is a hand-rolled merge, and it disagreed with the real one in three ways at
 * once:
 *
 *   - It mixed PROMPTS. Answers stored months apart under different prompts were
 *     merged into one record, so the bench scored a part nobody could produce.
 *   - It mixed PASSES. Pass 1 reads the text layer and pass 2 reads the rendered
 *     drawing, and where they disagree the drawing is right - which is the whole
 *     reason there are two.
 *   - It ignored everything the merge does BEYOND picking a value: citation
 *     checks, `statedMaxHeightMm`, the per-package join.
 *
 * It reported RHF1201's `leadForm` as `gullwing` on 2026-08-21. The drawing says
 * straight, pass 2 read straight, and the bench took pass 1's text-layer answer
 * off the front page. **A reimplemented merge drifts from the real one; the fix
 * is to delete the reimplementation, not to correct it.**
 *
 * So the record is built by `runExtraction` - the same call the routes and
 * `bench:extraction` make - against the cache in `offline` mode, which throws on
 * a miss and can never reach the network. A part whose answers are not cached
 * under the CURRENT prompt is simply not scored, which is the honest outcome and
 * the one the old code hid by falling back to stale entries.
 */
async function recordValuesFor(
  part: string,
  model: ExtractionModel,
  setLabel: (label: string) => void
): Promise<{
  values: OracleValues;
  record: PartRecord;
  rejected: Array<{ field: ExtractionField; reason: string }>;
  uncited: ExtractionField[];
} | null> {
  for (const dir of [".bench-cache", ".holdout-cache"]) {
    const path = join(process.cwd(), dir, `${part}.pdf`);
    if (!existsSync(path)) continue;
    try {
      const bytes = readFileSync(path);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const { doc, part: deterministic } = await extractPartRecord(`${part}.pdf`, buffer);
      setLabel(part);
      const outcome = await runExtraction(deterministic, doc, buffer, model, `${part}.pdf`, part);
      // THROUGH THE READOUT'S REPAIR, because the product's record has been
      // through it and a bench record that has not is a different record.
      //
      // `vendorLandPattern` is located by `buildReadout`, not by extraction, and
      // it is what `contradictsPrintedLand` and the footprint's corroboration
      // both read. Without this every part measured here reports a land pattern
      // with no second source: 94 of 94 on the first run of `bench:confirm`,
      // which was a fact about this file.
      const record = withPrintedFootprint(outcome?.part ?? deterministic, doc);
      // The citation PAGE comes too, because `outlineFor` disambiguates two
      // drawings in one datasheet by what each states as its own max height and
      // needs to know which page the reading came from.
      const values: OracleValues = {};
      for (const [field, held] of Object.entries(record.dimensions)) {
        const value = held as { value: unknown; citation?: { page?: number; snippet?: string } | null };
        values[`dimensions.${field}`] = {
          value: value.value,
          page: value.citation?.page ?? null,
          snippet: value.citation?.snippet ?? null
        };
      }
      values.packageOutlineCode = { value: record.packageOutlineCode.value };

      // THE PACKAGE THE PART ACTUALLY SHIPS AS, which is often not the one the
      // flat block describes.
      //
      // A family datasheet leaves `record.dimensions` entirely null - correctly,
      // because a part sold in seven packages has no one body size - and states
      // each package's own measurements in `packagesInThisDocument`. The product
      // builds the copper from THOSE, through `asPackage`. This read the flat
      // block, so for every such part it compared a hand-read drawing against a
      // row of nulls and reported "not read".
      //
      // Measured 2026-08-22 on the first three drawings added for the shipping
      // list: AD8628, ADR4525 and AD590 all ship, all build from an R-8 the
      // oracle now records, and all 27 comparisons came back `read null`. The
      // instrument could not see the numbers it exists to check, so reading
      // twenty more drawings would have bought nothing.
      //
      // Substituted the way `asPackage` substitutes - BLANK, then overlay - and
      // not merged over the flat block. That is the product's own rule and its
      // reason holds here: a field the document did not state for THIS package
      // is unknown, and inheriting the sibling's number would score a value the
      // product never emits.
      const shipped = (await shipOutcome(record, BENCH_SETTINGS)).shippedAs;
      // The designator the copper was built under, kept so an entry whose
      // drawing prints no code can be matched by it rather than by a part list
      // that goes wrong the moment the part resolves elsewhere.
      if (shipped) values.__shippedDesignator = { value: shipped.designator };
      if (shipped && shipped.designator !== record.packageType.value) {
        const entry = pinTableFor(record.packagesInThisDocument, shipped.designator);
        if (entry?.dimensions) {
          for (const field of Object.keys(record.dimensions)) {
            values[`dimensions.${field}`] = { value: null, page: null, snippet: null };
          }
          for (const [field, held] of Object.entries(entry.dimensions)) {
            const value = held as { value: unknown; citation?: { page?: number; snippet?: string } | null };
            values[`dimensions.${field}`] = {
              value: value.value,
              page: value.citation?.page ?? null,
              snippet: value.citation?.snippet ?? null
            };
          }
        }
        values.packageOutlineCode = { value: shipped.outlineCode };
      }
      return { values, record, rejected: outcome?.rejected ?? [], uncited: outcome?.uncited ?? [] };
    } catch {
      // A cache miss under the current prompt, or a document that will not
      // parse. Either way there is nothing to score, and inventing something to
      // score is how this got into trouble in the first place.
      return null;
    }
  }
  return null;
}

/** Every oracle key that names this part in its hand-confirmed `parts` list. */
const byPartName = new Map<string, string[]>();
for (const [code, entry] of Object.entries(DIMENSION_ORACLE)) {
  for (const part of entry.parts) byPartName.set(part, [...(byPartName.get(part) ?? []), code]);
}

/**
 * Which of a part's outlines the reading actually came from.
 *
 * Decided by the height the CITED page prints in its own title block, which is
 * the one thing on a drawing that names the drawing unambiguously and is present
 * on both of these. No candidate matches, or several do, and this gives up
 * rather than picking: an unmatched part is reported as unchecked, which is
 * honest, where a guess would be scored as fact.
 */
function outlineFor(codes: string[], stated: number | null): string | null {
  // EVEN ONE CANDIDATE HAS TO SURVIVE THE HEIGHT CHECK.
  //
  // A part list says "this part reads this drawing", and it is wrong whenever
  // the datasheet prints two and the reading came from the other one. Adding
  // `DGS0010A` on 2026-08-20 attributed a 2.0 x 1.5 x 0.4mm reading to a
  // 3 x 3 x 1.1mm VSSOP and reported six WRONG values, none of which was a
  // misread: `ADS1115` is offered in both and the model had read the other.
  //
  // So the cited page's own title block gets a veto here as well as a vote. An
  // unmatched part is reported as unchecked, which is true; a mismatched one is
  // reported as a defect, which is a lie about the product.
  const fitsHeight = (code: string) => {
    const wanted = DIMENSION_ORACLE[code].bodyHeightMaxMm;
    if (wanted === undefined || stated === null) return true;
    return Math.abs(wanted - stated) < 0.02;
  };
  if (codes.length === 1) return fitsHeight(codes[0]) ? codes[0] : null;
  if (stated === null) return null;
  const fits = codes.filter((code) => {
    const wanted = DIMENSION_ORACLE[code].bodyHeightMaxMm;
    return wanted !== undefined && Math.abs(wanted - stated) < 0.02;
  });
  return fits.length === 1 ? fits[0] : null;
}

/** An entry whose drawing prints no code, matched by what the part shipped AS. */
function byDesignator(designator: unknown): string | null {
  if (typeof designator !== "string" || !designator.trim()) return null;
  const key = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const wanted = key(designator);
  return (
    Object.keys(DIMENSION_ORACLE).find((name) =>
      (DIMENSION_ORACLE[name].designators ?? []).some((offered) => key(offered) === wanted)
    ) ?? null
  );
}

/**
 * MATCHED THE WAY THE VERIFIED METRIC MATCHES, which is `sameOutlineCode` and
 * not an exact string compare.
 *
 * An exact lookup here while `bench:extraction` used `sameOutlineCode` made the
 * two instruments disagree about the same part: LTC3105 reports `05-08-1668`
 * and the entry is keyed `05-08-1668 Rev A`, so VERIFIED called it checked and
 * this called it unmatched and scored nothing.
 *
 * An ALIAS counts as the code. One title block can print two - ISL71001M's page
 * 36 is headed both `Q64.10x10J` and `PT0064AA` - and without this the run that
 * reports the second one calls a hand-read drawing UNCHECKED.
 */
function codeFor(want: string): string | null {
  return (
    Object.keys(DIMENSION_ORACLE).find(
      (key) =>
        sameOutlineCode(key, want) ||
        (DIMENSION_ORACLE[key].alsoKnownAs ?? []).some((alias) => sameOutlineCode(alias, want))
    ) ?? null
  );
}

/**
 * The oracle key for one built part, or null when no hand-read drawing covers it.
 *
 * A CODE THE RECORD REPORTS BEATS THE PART LIST, INCLUDING WHEN IT MATCHES
 * NOTHING. The part list says "this part reads this drawing". Since 2026-08-22
 * the code arriving here is the one the part actually SHIPPED as, and where the
 * two disagree the code is right by construction: it came from the package the
 * copper was built from.
 *
 * Falling through to the list when the code is merely UNKNOWN scored a reading
 * against a drawing it did not come from. Measured the day the shipped-package
 * code was wired in: AD8628 ships as UJ-5, a 5-lead TSOT, and was scored against
 * the R-8 SOIC in the same datasheet - seven WRONG values, none of them a
 * misread. NCP1200 ships as CASE 626-05, a DIP, and was scored against the
 * 751-07 SOIC for another five.
 *
 * The height veto in `outlineFor` was supposed to catch exactly this and cannot:
 * it only fires on an entry with `bodyHeightMaxMm`, and an entry recording a
 * max/nom/min range has none.
 */
async function matchOracle(part: string, values: OracleValues): Promise<string | null> {
  // THE CORRECTION THE PRODUCT APPLIES, READ rather than re-applied.
  // `mergeModelValues` already replaces an overall height with the one the
  // drawing states in its own title block, so the record arriving here has been
  // corrected. The value is still needed for `outlineFor`, which tells two
  // drawings in one datasheet apart by what each states as its own max height.
  let statedHeight: number | null = null;
  const height = values["dimensions.bodyHeightMm"];
  if (height && typeof height.value === "number") {
    const doc = await documentFor(part);
    const page = height.page;
    statedHeight = doc ? statedMaxHeightMm(doc, typeof page === "number" ? page : null) : null;
  }

  const claimed = values["packageOutlineCode"]?.value;
  if (typeof claimed === "string" && claimed.trim()) {
    return DIMENSION_ORACLE[claimed] ? claimed : codeFor(claimed);
  }
  return (
    byDesignator(values["__shippedDesignator"]?.value) ??
    outlineFor(
      // AN ENTRY THAT DECLARES ITS DESIGNATORS IS REACHABLE ONLY THROUGH THEM.
      // The part list stays as the fallback for entries that declare none, but
      // it may no longer hand a reading to an entry that says which packages it
      // describes and does not name this one.
      //
      // TSZ121 offers seven packages and settled on the SC70; its SC70 reading
      // was being scored against the DFN8 entry listed under its name, for six
      // WRONG values that were all correct readings of a different package.
      (byPartName.get(part) ?? []).filter((key) => {
        const offered = DIMENSION_ORACLE[key].designators;
        if (!offered || offered.length === 0) return true;
        const shipped = values["__shippedDesignator"]?.value;
        if (typeof shipped !== "string") return true;
        const norm = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
        return offered.some((name) => norm(name) === norm(shipped));
      }),
      statedHeight
    )
  );
}

/** Every part name with answers in the model cache. */
export function cachedPartNames(): string[] {
  const parts = new Set<string>();
  for (const file of readdirSync(CACHE).filter((n) => n.endsWith(".json") && n !== "_billed.json")) {
    parts.add(file.replace(/-[0-9a-f]{16}\.json$/, ""));
  }
  return [...parts];
}

/**
 * Every cached part, rebuilt through the product's own extraction and matched to
 * its hand-read drawing.
 *
 * OFFLINE. A cache miss throws rather than reaching the network, so a caller
 * cannot spend, which is the property that lets these run on every change.
 */
export async function buildCachedParts(): Promise<BuiltPart[] | null> {
  const inner = await makeExtractionModel(getDeploymentMode());
  if (!inner) return null;
  let currentLabel = "";
  const model = cachingModel(inner, "offline", () => currentLabel);

  const built: BuiltPart[] = [];
  for (const part of cachedPartNames()) {
    const made = await recordValuesFor(part, model, (label) => {
      currentLabel = label;
    });
    if (!made) continue;
    const claimed = made.values["packageOutlineCode"]?.value;
    built.push({
      part,
      values: made.values,
      record: made.record,
      rejected: made.rejected,
      uncited: made.uncited,
      oracleCode: await matchOracle(part, made.values),
      claimedCode: typeof claimed === "string" && claimed.trim() ? claimed.trim() : null
    });
  }
  return built;
}

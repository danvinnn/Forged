import { randomUUID } from "node:crypto";
import { extractDatasheetText, type DatasheetText } from "./pdftext";
import { findVendorLandPattern } from "./vendorland";
import { findOrderablePackages, findPackageVariants } from "./packagevariants";
import {
  unknown,
  type LeadWidth,
  type PartRecord,
  type PinRecord
} from "./types";

/**
 * The record a datasheet starts as, before the model reads it.
 *
 * ## What used to be here
 *
 * A 1,850-line deterministic reader, plus `pintable.ts` (3,400 lines),
 * `pinfigure.ts` (1,735) and `drawingdimensions.ts` (355). It read pin tables
 * out of the text layer by geometry, recovered pinouts from four-sided figures,
 * pulled dimensions off drawing callouts, and produced a complete PartRecord on
 * its own. Roughly 7,500 lines.
 *
 * It was deleted on 2026-08-14. The measurement that settled it, run on the 25
 * cached datasheets that have both a parser run and a real model answer on file:
 *
 *   field                       parser only   model only
 *   body length / width / height     0            19 / 19 / 18
 *   lead span                        0            15
 *   lead contact                     0            16
 *   printed land pattern             0             8 (x3 fields)
 *   lead sides                       0            10
 *   pitch                            4            15
 *   lead width                       2            16
 *
 * The parser contributed nothing to the geometry. Not "less than the model":
 * nothing, on eighteen of the twenty-one dimensional fields. Every number that
 * places copper was already coming from the model, and the parser's remaining
 * output was competing with it on the pin table and the package name, where a
 * separate measurement on 56 unseen datasheets had already found the model right
 * eleven times out of eleven wherever the document could settle the argument.
 *
 * ## What survives, and why each one is not the same thing
 *
 * Three readers are kept. None of them reads a dimension, and each has a reason
 * that is not "it might help".
 *
 * `findOrderablePackages` and `findPackageVariants` enumerate the packages a
 * document OFFERS, off the ordering table. Measured at 25 of 25 on the same
 * corpus, which is better than anything else here, and it is what the package
 * chooser is built from. Replacing a reader that works on every document with a
 * model call would be spending tokens to get a worse answer.
 *
 * `findVendorLandPattern` reads the land-pattern callouts a datasheet prints. It
 * is a CHECK rather than a source: `contradictsPrintedLand` refuses a computed
 * pattern the printed page disagrees with, which is how the ADS1115 was caught
 * with correct inputs and the wrong lead form. A check that shares a reader with
 * the thing it checks is not a check.
 *
 * `extractDatasheetText` is what the model reads. It was never part of the
 * parser.
 */

/**
 * Parse resource limits. Layer 1 validates the %PDF magic bytes and the file
 * size but never opens the document, so this is the first point at which a
 * small file that expands catastrophically becomes a denial-of-service vector.
 */
const MAX_PAGES = 400;

/**
 * Wall-clock ceiling for text extraction. Must sit under the route's
 * maxDuration (30s) so the platform does not kill the request first and turn a
 * clean error into a 504.
 */
function parseBudgetMs(): number {
  const raw = Number(process.env.FORGE_PARSE_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

/** Front matter carries the package and ordering information on these datasheets. */
const FRONT_MATTER_PAGES = 3;

/** Character offset at which the front matter ends. */
function frontMatterEnd(doc: DatasheetText): number {
  const boundary = doc.pages.find((page) => page.page === FRONT_MATTER_PAGES + 1);
  return boundary ? boundary.start : doc.text.length;
}

/**
 * What the caller already knows that the document cannot say.
 *
 * Only the package so far, and it is the one that matters: a document offering
 * several packages does say what they are and cannot say which one the user is
 * holding.
 */
export interface ExtractionHints {
  /**
   * The package the user picked, as printed in the document. Recorded with
   * `method: "user"` and NO citation: it is not on the page in the sense a
   * citation claims, and a value the user chose must never be dressed as a value
   * the document stated.
   */
  packageType?: string | null;
}

/** A package designator is a short printed token; anything longer is not one. */
const MAX_PACKAGE_HINT_LENGTH = 64;

/**
 * The starting record: everything unknown, except what is not read from the
 * part's own description.
 *
 * The part number falls back to the FILE NAME, marked `user` rather than read,
 * because that is what it is: the person uploading `lm358.pdf` has told us what
 * they think it is. The model overwrites it when the document says otherwise.
 */
export function buildPartRecord(
  doc: DatasheetText,
  fileName: string,
  sourceUrl?: string,
  hints?: ExtractionHints
): PartRecord {
  const named = fileName.replace(/\.pdf$/i, "").trim();

  // The vendor's own ordering table, where the document has one, REPLACES the
  // prose reader rather than adding to it. It is keyed to the part number, so it
  // is the only source here that can tell this part's packages from its
  // siblings', and the prose reader pools them by construction: an OPA333
  // document describes the OPA2333 too and prose yields seven families where the
  // ordering table yields two.
  //
  // Falling back rather than merging is deliberate. A union would put the
  // siblings straight back in, which is the thing this fixes.
  const orderable = findOrderablePackages(doc.text, named);
  const packageVariants =
    orderable.length > 0 ? orderable : findPackageVariants(doc.text, frontMatterEnd(doc));

  const hinted = hints?.packageType?.trim();
  const packageType =
    hinted && hinted.length > 0 && hinted.length <= MAX_PACKAGE_HINT_LENGTH
      ? { value: hinted, confidence: 1, method: "user" as const, citation: null }
      : unknown<string>();

  // The land pattern the document PRINTS, as bare callouts, for the generator to
  // check a computed pattern against. Read for the package the caller named
  // where they named one; a document that describes several prints several, and
  // comparing against the wrong one would refuse a correct pattern.
  const printed = hinted ? findVendorLandPattern(doc, hinted) : null;

  const notes: string[] = [];
  if (doc.truncated) {
    notes.push(`Only the first ${doc.pages.length} pages were parsed (page cap ${MAX_PAGES}).`);
  }

  return {
    id: randomUUID(),
    partNumber: named
      ? { value: named, confidence: 1, method: "user", citation: null }
      : unknown<string>(),
    manufacturer: unknown<string>(),
    packageType,
    packageOutlineCode: unknown<string>(),
    jedecOutline: unknown<string>(),
    packageVariants,
    vendorLandPattern: printed
      ? { page: printed.page, valuesMm: printed.dimensions.map((dimension) => dimension.valueMm) }
      : null,
    exposedPad: false,
    pinCount: unknown<number>(),
    pins: unknown<PinRecord[]>(),
    dimensions: {
      bodyLengthMm: unknown<number>(),
      bodyWidthMm: unknown<number>(),
      bodyHeightMm: unknown<number>(),
      pitchMm: unknown<number>(),
      leadLengthMm: unknown<number>(),
      leadCount: unknown<number>(),
      leadWidthMm: unknown<LeadWidth>(),
      leadSpanMm: unknown<LeadWidth>(),
      leadSpanCrossMm: unknown<LeadWidth>(),
      leadContactMm: unknown<LeadWidth>(),
      landPadLengthMm: unknown<number>(),
      landPadWidthMm: unknown<number>(),
      landSpanMm: unknown<number>(),
      landSpanCrossMm: unknown<number>(),
      leadSides: unknown<1 | 2 | 4>(),
      leadForm: unknown<"gullwing" | "nolead" | "straight">(),
      mounting: unknown<"smd" | "through-hole">(),
      leadDiameterMm: unknown<number>(),
      vacantLeadSlot: unknown<number>(),
      leadsPerSide: unknown<string>(),
      solderMaskExpansionMm: unknown<number>(),
      solderMaskDefined: unknown<"solder-mask-defined" | "non-solder-mask-defined">(),
      thermalPadLengthMm: unknown<number>(),
      thermalPadWidthMm: unknown<number>(),
      thermalViaDiameterMm: unknown<number>(),
      thermalViaPitchMm: unknown<number>()
    },
    radiation: {
      tid: unknown<string>(),
      see: unknown<string>(),
      sel: unknown<string>(),
      qmlClass: unknown<string>()
    },
    sourceFileName: fileName,
    ...(sourceUrl ? { sourceUrl } : {}),
    notes
  };
}

export async function extractPartRecord(
  fileName: string,
  pdfBuffer: ArrayBuffer,
  sourceUrl?: string,
  hints?: ExtractionHints
): Promise<{ doc: DatasheetText; part: PartRecord }> {
  const doc = await extractDatasheetText(pdfBuffer, {
    maxPages: MAX_PAGES,
    budgetMs: parseBudgetMs()
  });
  return { doc, part: buildPartRecord(doc, fileName, sourceUrl, hints) };
}

export async function parseDatasheetPdf(
  fileName: string,
  pdfBuffer: ArrayBuffer,
  sourceUrl?: string
): Promise<PartRecord> {
  const { part } = await extractPartRecord(fileName, pdfBuffer, sourceUrl);
  return part;
}

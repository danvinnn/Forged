/**
 * Are the dimensions we read RIGHT?
 *
 * Every coverage figure this project has produced counts fields that came back
 * non-null. None of them asked whether a number was correct, and a wrong number
 * places copper exactly as confidently as a right one. This is the first check
 * that asks.
 *
 * Reads the model answer cache and compares it against `DIMENSION_ORACLE`, which
 * is hand-read off the rendered drawings. Free: no network, no spend.
 *
 * Matched by the vendor's package outline code, which is what identifies a
 * drawing. A part whose outline code we never read cannot be checked, and that
 * is reported rather than skipped silently: an unmatched part is a part with no
 * correctness evidence at all, which is the situation this file exists to make
 * visible.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractPartRecord } from "../datasheet";
import { makeExtractionModel, runExtraction } from "../extraction";
import type { ExtractionModel } from "../extraction/contracts";
import { getDeploymentMode } from "../retrieval/deployment";
import { cachingModel } from "./modelcache";
import { loadBenchEnv } from "./env";
import { statedMaxHeightMm } from "../extraction/merge";
import type { DatasheetText } from "../pdftext";
import { DIMENSION_ORACLE, type DimensionOracleEntry, type OracleRange } from "./dimension-oracle";
import { pinTableFor } from "../packagevariants";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";

loadBenchEnv();

const CACHE = join(process.cwd(), ".model-cache");

/**
 * How far a reading may sit from the hand-read value.
 *
 * A drawing prints two decimal places, so anything beyond a hundredth of a
 * millimetre is a different number rather than a rounding difference. Not a
 * tolerance on the PART, which is what the min/max pair already carries.
 */
const EPSILON_MM = 0.005;

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPSILON_MM;
}

function rangeMatches(read: unknown, expected: OracleRange): boolean | null {
  if (read === null || read === undefined) return null;
  if (typeof read !== "object") return false;
  const { minMm, maxMm } = read as { minMm?: unknown; maxMm?: unknown };
  if (typeof minMm !== "number" || typeof maxMm !== "number") return false;
  return near(minMm, expected.minMm) && near(maxMm, expected.maxMm);
}

/**
 * A SCALAR reading against a range the drawing prints.
 *
 * The body size, the seated height and the exposed pad are all dimensioned as
 * min/max on the drawing and stored on the record as one number, because that is
 * what a 3D solid and a paste aperture are built from. Equality is therefore the
 * wrong test and the range is the right one: any value the drawing permits is a
 * correct reading, and one outside it is not.
 *
 * `EPSILON_MM` is applied at both ends, so a reading of exactly the printed
 * maximum is not failed by floating point.
 */
function withinRange(read: unknown, expected: OracleRange): boolean | null {
  if (read === null || read === undefined) return null;
  if (typeof read !== "number") return false;
  return read >= expected.minMm - EPSILON_MM && read <= expected.maxMm + EPSILON_MM;
}

function scalarMatches(read: unknown, expected: number): boolean | null {
  if (read === null || read === undefined) return null;
  if (typeof read !== "number") return false;
  return near(read, expected);
}

interface Row {
  part: string;
  outline: string;
  field: string;
  verdict: "correct" | "WRONG" | "not read";
  read: string;
  expected: string;
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") {
    const r = value as { minMm?: number; maxMm?: number };
    if (typeof r.minMm === "number") return `${r.minMm}-${r.maxMm}`;
  }
  return String(value);
}

/** The parsed document for a part, from either cache, or null. Memoised. */
const documents = new Map<string, DatasheetText | null>();
async function documentFor(part: string): Promise<DatasheetText | null> {
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

function compare(
  part: string,
  outline: string,
  entry: DimensionOracleEntry,
  values: Record<string, { value?: unknown; page?: number | null }>
): Row[] {
  const rows: Row[] = [];
  const add = (field: string, verdict: boolean | null, read: unknown, expected: unknown) => {
    rows.push({
      part,
      outline,
      field,
      verdict: verdict === null ? "not read" : verdict ? "correct" : "WRONG",
      read: show(read),
      expected: show(expected)
    });
  };

  const at = (key: string) => values[key]?.value;

  if (entry.leadSpanMm) add("leadSpanMm", rangeMatches(at("dimensions.leadSpanMm"), entry.leadSpanMm), at("dimensions.leadSpanMm"), entry.leadSpanMm);
  if (entry.leadSpanCrossMm)
    add(
      "leadSpanCrossMm",
      rangeMatches(at("dimensions.leadSpanCrossMm"), entry.leadSpanCrossMm),
      at("dimensions.leadSpanCrossMm"),
      entry.leadSpanCrossMm
    );
  if (entry.leadWidthMm) add("leadWidthMm", rangeMatches(at("dimensions.leadWidthMm"), entry.leadWidthMm), at("dimensions.leadWidthMm"), entry.leadWidthMm);
  if (entry.leadContactMm) add("leadContactMm", rangeMatches(at("dimensions.leadContactMm"), entry.leadContactMm), at("dimensions.leadContactMm"), entry.leadContactMm);
  if (entry.pitchMm !== undefined) add("pitchMm", scalarMatches(at("dimensions.pitchMm"), entry.pitchMm), at("dimensions.pitchMm"), entry.pitchMm);
  if (entry.leadSides !== undefined) {
    const read = at("dimensions.leadSides");
    add("leadSides", read === null || read === undefined ? null : read === entry.leadSides, read, entry.leadSides);
  }
  if (entry.leadForm !== undefined) {
    const read = at("dimensions.leadForm");
    add("leadForm", read === null || read === undefined ? null : read === entry.leadForm, read, entry.leadForm);
  }
  // THE BODY, which the oracle has recorded since it existed and nothing ever
  // compared. A hand-read number nobody checks against is a comment.
  //
  // Checked as a scalar INSIDE the printed range rather than against a midpoint:
  // RULES.md 2 is explicit that choosing the midpoint is an assumption about
  // what an engineer wants, so any value the drawing permits is correct here.
  if (entry.bodyLengthMm) add("bodyLengthMm", withinRange(at("dimensions.bodyLengthMm"), entry.bodyLengthMm), at("dimensions.bodyLengthMm"), entry.bodyLengthMm);
  if (entry.bodyWidthMm) add("bodyWidthMm", withinRange(at("dimensions.bodyWidthMm"), entry.bodyWidthMm), at("dimensions.bodyWidthMm"), entry.bodyWidthMm);
  if (entry.bodyHeightMm) {
    // A max/nom/min drawing. Any value it permits is a correct reading, and the
    // prompt asks for the nominal.
    add("bodyHeightMm", withinRange(at("dimensions.bodyHeightMm"), entry.bodyHeightMm), at("dimensions.bodyHeightMm"), entry.bodyHeightMm);
  } else if (entry.bodyHeightMaxMm !== undefined) {
    // The drawing prints ONE number and calls it MAX, so that is the reading:
    // there is no other stated value for the envelope, and a smaller answer is
    // a different feature of the package rather than a tighter tolerance.
    add("bodyHeightMm", scalarMatches(at("dimensions.bodyHeightMm"), entry.bodyHeightMaxMm), at("dimensions.bodyHeightMm"), entry.bodyHeightMaxMm);
  }
  // THE EXPOSED PAD, and the AXIS as much as the size. It shipped rotated ninety
  // degrees from its own body on 2026-08-16, which still fits between the lead
  // rows and so passes every geometric invariant there is.
  if (entry.thermalPadLengthMm) add("thermalPadLengthMm", withinRange(at("dimensions.thermalPadLengthMm"), entry.thermalPadLengthMm), at("dimensions.thermalPadLengthMm"), entry.thermalPadLengthMm);
  if (entry.thermalPadWidthMm) add("thermalPadWidthMm", withinRange(at("dimensions.thermalPadWidthMm"), entry.thermalPadWidthMm), at("dimensions.thermalPadWidthMm"), entry.thermalPadWidthMm);

  if (entry.land) {
    // WHICH of the drawing's patterns this reading is being judged against.
    //
    // A drawing can print more than one complete footprint for one package -
    // DW0016B prints an IPC nominal and an HV isolation option side by side -
    // and both are the document's own. So the reading is compared against the
    // one it MATCHES rather than against whichever this file happens to list
    // first, and a reading matching none is judged against `land`, which is
    // where the difference is most legible.
    //
    // Matched WHOLE. A pattern assembled from one drawing's pad and another's
    // span appears nowhere on the page, and is exactly the defect this has to
    // be able to see, so a candidate counts only if all of its numbers agree.
    const candidates = [entry.land, ...(entry.landAlternatives ?? [])];
    const matchesWhole = (pattern: (typeof candidates)[number]) =>
      scalarMatches(at("dimensions.landPadLengthMm"), pattern.padLengthMm) === true &&
      scalarMatches(at("dimensions.landPadWidthMm"), pattern.padWidthMm) === true &&
      scalarMatches(at("dimensions.landSpanMm"), pattern.spanMm) === true &&
      (pattern.spanCrossMm === undefined ||
        scalarMatches(at("dimensions.landSpanCrossMm"), pattern.spanCrossMm) === true);
    const against = candidates.find(matchesWhole) ?? entry.land;

    add("landPadLengthMm", scalarMatches(at("dimensions.landPadLengthMm"), against.padLengthMm), at("dimensions.landPadLengthMm"), against.padLengthMm);
    add("landPadWidthMm", scalarMatches(at("dimensions.landPadWidthMm"), against.padWidthMm), at("dimensions.landPadWidthMm"), against.padWidthMm);
    add("landSpanMm", scalarMatches(at("dimensions.landSpanMm"), against.spanMm), at("dimensions.landSpanMm"), against.spanMm);
    if (against.spanCrossMm !== undefined) {
      add(
        "landSpanCrossMm",
        scalarMatches(at("dimensions.landSpanCrossMm"), against.spanCrossMm),
        at("dimensions.landSpanCrossMm"),
        against.spanCrossMm
      );
    }
  }

  // A dimension the drawing does NOT print. Reading one anyway is an invention,
  // and it is the failure the oracle's partial entries exist to catch: absence
  // here means a person looked and the drawing is silent.
  if (!entry.leadContactMm) {
    const read = at("dimensions.leadContactMm");
    if (read !== null && read !== undefined) {
      add("leadContactMm", false, read, "the drawing prints none");
    }
  }

  return rows;
}

/**
 * The values the PRODUCT would hold for this part, built the way it builds them.
 *
 * ## What this replaces, and why it had to go
 *
 * This function used to be four lines that walked every cache file for a part,
 * in `readdirSync` order, and kept the first non-null it met for each field.
 * That is a hand-rolled merge, and it disagreed with the real one in three ways
 * at once:
 *
 *   - It mixed PROMPTS. Answers stored months apart under different prompts were
 *     merged into one record, so the bench scored a part nobody could produce.
 *     `forge-validate-the-instrument` had already recorded "filter cache
 *     measurements to the current prompt" and this file never did.
 *   - It mixed PASSES. Pass 1 reads the text layer and pass 2 reads the rendered
 *     drawing, and where they disagree the drawing is right - which is the whole
 *     reason there are two. Taking whichever the filesystem listed first threw
 *     that precedence away.
 *   - It ignored everything the merge does BEYOND picking a value: citation
 *     checks, `statedMaxHeightMm`, the per-package join.
 *
 * It reported RHF1201's `leadForm` as `gullwing` on 2026-08-21. The drawing says
 * straight, pass 2 read straight, and the bench took pass 1's text-layer answer
 * off the front page. **A reimplemented merge drifts from the real one; the fix
 * is to delete the reimplementation, not to correct it.**
 *
 * So the record is now built by `runExtraction` - the same call the routes and
 * `bench:extraction` make - against the cache in `offline` mode, which throws on
 * a miss and can never reach the network. A part whose answers are not cached
 * under the CURRENT prompt is simply not scored, which is the honest outcome and
 * the one the old code hid by falling back to stale entries.
 */
async function recordValuesFor(
  part: string,
  model: ExtractionModel,
  setLabel: (label: string) => void
): Promise<Record<string, { value?: unknown; page?: number | null }> | null> {
  for (const dir of [".bench-cache", ".holdout-cache"]) {
    const path = join(process.cwd(), dir, `${part}.pdf`);
    if (!existsSync(path)) continue;
    try {
      const bytes = readFileSync(path);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const { doc, part: deterministic } = await extractPartRecord(`${part}.pdf`, buffer);
      setLabel(part);
      const outcome = await runExtraction(deterministic, doc, buffer, model, `${part}.pdf`, part);
      const record = outcome?.part ?? deterministic;
      // The citation PAGE comes too, because `outlineFor` disambiguates two
      // drawings in one datasheet by what each states as its own max height and
      // needs to know which page the reading came from.
      const values: Record<string, { value?: unknown; page?: number | null }> = {};
      for (const [field, held] of Object.entries(record.dimensions)) {
        const value = held as { value: unknown; citation?: { page?: number } | null };
        values[`dimensions.${field}`] = { value: value.value, page: value.citation?.page ?? null };
      }
      values.packageOutlineCode = { value: record.packageOutlineCode.value };

      // THE PACKAGE THE PART ACTUALLY SHIPS AS, which is often not the one the
      // flat block describes.
      //
      // A family datasheet leaves `record.dimensions` entirely null - correctly,
      // because a part sold in seven packages has no one body size - and states
      // each package's own measurements in `packagesInThisDocument`. The product
      // builds the copper from THOSE, through `asPackage`. This bench read the
      // flat block, so for every such part it compared a hand-read drawing
      // against a row of nulls and reported "not read".
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
      if (shipped && shipped.designator !== record.packageType.value) {
        const entry = pinTableFor(record.packagesInThisDocument, shipped.designator);
        if (entry?.dimensions) {
          for (const field of Object.keys(record.dimensions)) values[`dimensions.${field}`] = { value: null, page: null };
          for (const [field, held] of Object.entries(entry.dimensions)) {
            const value = held as { value: unknown; citation?: { page?: number } | null };
            values[`dimensions.${field}`] = { value: value.value, page: value.citation?.page ?? null };
          }
        }
        values.packageOutlineCode = { value: shipped.outlineCode };
      }
      return values;
    } catch {
      // A cache miss under the current prompt, or a document that will not
      // parse. Either way there is nothing to score, and inventing something to
      // score is how this function got into trouble in the first place.
      return null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const inner = await makeExtractionModel(getDeploymentMode());
  if (!inner) {
    console.log("No model configured, so no records can be rebuilt.");
    return;
  }
  let currentLabel = "";
  // OFFLINE. A miss throws rather than reaching the network, so this bench
  // cannot spend, which is the property that lets it run on every change.
  const model = cachingModel(inner, "offline", () => currentLabel);

  const parts = new Set<string>();
  for (const file of readdirSync(CACHE).filter((n) => n.endsWith(".json") && n !== "_billed.json")) {
    parts.add(file.replace(/-[0-9a-f]{16}\.json$/, ""));
  }
  const byPart = new Map<string, Record<string, { value?: unknown; page?: number | null }>>();
  for (const part of parts) {
    const values = await recordValuesFor(part, model, (label) => {
      currentLabel = label;
    });
    if (values) byPart.set(part, values);
  }

  const rows: Row[] = [];
  const unmatched: string[] = [];

  // Outline code first, because it identifies the drawing. Falling back to the
  // hand-confirmed part list, because the code is itself model-read and comes
  // back null for most of the corpus.
  //
  // A LIST per part, not one entry. A datasheet routinely prints two outline
  // drawings and offers the part in both: TPS7A4501-SP is a `U0010A` at 2.03mm
  // max height and an `HKU0010A` at 2.63. This map kept whichever was declared
  // last, so a CORRECT reading of one drawing was scored as a wrong reading of
  // the other and reported under "every WRONG above is a number that would have
  // placed copper". It was the bench that was wrong.
  const byPartName = new Map<string, string[]>();
  for (const [code, entry] of Object.entries(DIMENSION_ORACLE)) {
    for (const part of entry.parts) byPartName.set(part, [...(byPartName.get(part) ?? []), code]);
  }

  /**
   * Which of a part's outlines the reading actually came from.
   *
   * Decided by the height the CITED page prints in its own title block, which
   * is the one thing on a drawing that names the drawing unambiguously and is
   * present on both of these. No candidate matches, or several do, and this
   * gives up rather than picking: an unmatched part is reported as unchecked,
   * which is honest, where a guess would be scored as fact.
   */
  const outlineFor = (codes: string[], stated: number | null): string | null => {
    // EVEN ONE CANDIDATE HAS TO SURVIVE THE HEIGHT CHECK.
    //
    // A part list says "this part reads this drawing", and it is wrong whenever
    // the datasheet prints two and the reading came from the other one. Adding
    // `DGS0010A` on 2026-08-20 attributed a 2.0 x 1.5 x 0.4mm reading to a
    // 3 x 3 x 1.1mm VSSOP and reported six WRONG values, none of which was a
    // misread: `ADS1115` is offered in both and the model had read the other.
    //
    // So the cited page's own title block gets a veto here as well as a vote.
    // An unmatched part is reported as unchecked, which is true; a mismatched
    // one is reported as a defect, which is a lie about the product.
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
  };

  for (const [part, values] of byPart) {
    // THE CORRECTION THE PRODUCT APPLIES, applied here too.
    //
    // This bench reads the model cache, and the record is not the model's
    // answer: `mergeModelValues` replaces an overall height with the one the
    // drawing states in its own title block, because the model answers the body
    // thickness instead on about a fifth of the pages that state it. Measuring
    // the raw answer scores a field the product does not ship, which is the
    // "one step away from the thing it is about" mistake this file has made
    // before. See `statedMaxHeightMm`.
    // READ, NOT APPLIED. `mergeModelValues` already replaces an overall height
    // with the one the drawing states in its own title block, so the record
    // arriving here has been corrected. This used to do the correction a SECOND
    // time, which was harmless while it agreed and is exactly the reimplemented
    // logic that made this bench disagree with the product elsewhere.
    //
    // The value is still needed for `outlineFor`, which tells two drawings in one
    // datasheet apart by what each states as its own max height.
    let statedHeight: number | null = null;
    const height = values["dimensions.bodyHeightMm"];
    if (height && typeof height.value === "number") {
      const doc = await documentFor(part);
      const page = height.page;
      statedHeight = doc ? statedMaxHeightMm(doc, typeof page === "number" ? page : null) : null;
    }
    const claimed = values["packageOutlineCode"]?.value;
    // A CODE THE RECORD REPORTS BEATS THE PART LIST, INCLUDING WHEN IT MATCHES
    // NOTHING.
    //
    // The part list says "this part reads this drawing". Since 2026-08-22 the
    // code arriving here is the one the part actually SHIPPED as, and where the
    // two disagree the code is right by construction: it came from the package
    // the copper was built from.
    //
    // Falling through to the list when the code is merely UNKNOWN scored a
    // reading against a drawing it did not come from. Measured the day the
    // shipped-package code was wired in: AD8628 ships as UJ-5, a 5-lead TSOT,
    // and was scored against the R-8 SOIC in the same datasheet - seven WRONG
    // values, none of them a misread. NCP1200 ships as CASE 626-05, a DIP, and
    // was scored against the 751-07 SOIC for another five.
    //
    // The height veto in `outlineFor` was supposed to catch exactly this and
    // cannot: it only fires on an entry with `bodyHeightMaxMm`, and an entry
    // recording a max/nom/min range has none.
    //
    // So an unmatched code is UNCHECKED, which is true, rather than checked
    // against a sibling, which is a lie about the product.
    const code =
      typeof claimed === "string" && claimed.trim()
        ? (DIMENSION_ORACLE[claimed] ? claimed : null)
        : outlineFor(byPartName.get(part) ?? [], statedHeight);
    if (!code) {
      // NAME THE CODE THE RECORD DID REPORT, not just the part.
      //
      // "94 parts have no oracle entry" is a number nobody can act on: it does
      // not say which DRAWING to go and read. The record usually knows - it
      // reports an outline code that simply has no entry yet - and printing it
      // turns the list into a work queue.
      unmatched.push(typeof claimed === "string" && claimed.trim() ? `${part} [${claimed.trim()}]` : part);
      continue;
    }
    rows.push(...compare(part, code, DIMENSION_ORACLE[code], values));
  }

  const correct = rows.filter((r) => r.verdict === "correct").length;
  const wrong = rows.filter((r) => r.verdict === "WRONG");
  const unread = rows.filter((r) => r.verdict === "not read").length;

  console.log(`\nChecked ${byPart.size} cached parts against ${Object.keys(DIMENSION_ORACLE).length} hand-read drawings.\n`);

  for (const row of rows) {
    const mark = row.verdict === "correct" ? "  ok   " : row.verdict === "WRONG" ? "  WRONG" : "  ---  ";
    console.log(`${mark} ${row.part.padEnd(14)} ${row.outline.padEnd(10)} ${row.field.padEnd(17)} read ${row.read.padEnd(12)} expected ${row.expected}`);
  }

  console.log(`\n  CORRECT ${correct}   WRONG ${wrong.length}   NOT READ ${unread}`);
  console.log(`  ${unmatched.length} cached parts have no oracle entry, so nothing about them is checked.`);
  // ALL of them, not the first twelve. The truncated list was unusable for the
  // one job it has: deciding which drawing to read next. `--verbose` printed
  // nothing extra here, so the remaining names were simply unavailable.
  if (unmatched.length > 0) {
    for (let i = 0; i < unmatched.length; i += 6) {
      console.log(`    ${unmatched.slice(i, i + 6).join(", ")}`);
    }
  }

  if (wrong.length > 0) {
    console.log(`\n  Every WRONG above is a number that would have placed copper.`);
  }
}

main();

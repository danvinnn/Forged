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
import { statedMaxHeightMm } from "../extraction/merge";
import type { DatasheetText } from "../pdftext";
import { DIMENSION_ORACLE, type DimensionOracleEntry, type OracleRange } from "./dimension-oracle";

const CACHE = join(process.cwd(), ".model-cache");

/**
 * How far a reading may sit from the hand-read value.
 *
 * A drawing prints two decimal places, so anything beyond a hundredth of a
 * millimetre is a different number rather than a rounding difference. Not a
 * tolerance on the PART, which is what the min/max pair already carries.
 */
const EPSILON_MM = 0.005;

type Cached = { result?: { values?: Record<string, { value?: unknown; page?: number | null }> } };

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

function compare(part: string, outline: string, entry: DimensionOracleEntry, values: Record<string, { value?: unknown }>): Row[] {
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
    add("landPadLengthMm", scalarMatches(at("dimensions.landPadLengthMm"), entry.land.padLengthMm), at("dimensions.landPadLengthMm"), entry.land.padLengthMm);
    add("landPadWidthMm", scalarMatches(at("dimensions.landPadWidthMm"), entry.land.padWidthMm), at("dimensions.landPadWidthMm"), entry.land.padWidthMm);
    add("landSpanMm", scalarMatches(at("dimensions.landSpanMm"), entry.land.spanMm), at("dimensions.landSpanMm"), entry.land.spanMm);
    if (entry.land.spanCrossMm !== undefined) {
      add(
        "landSpanCrossMm",
        scalarMatches(at("dimensions.landSpanCrossMm"), entry.land.spanCrossMm),
        at("dimensions.landSpanCrossMm"),
        entry.land.spanCrossMm
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

async function main(): Promise<void> {
  const byPart = new Map<string, Record<string, { value?: unknown }>>();
  for (const file of readdirSync(CACHE).filter((n) => n.endsWith(".json") && n !== "_billed.json")) {
    let entry: Cached;
    try {
      entry = JSON.parse(readFileSync(join(CACHE, file), "utf8")) as Cached;
    } catch {
      continue;
    }
    const part = file.replace(/-[0-9a-f]{16}\.json$/, "");
    const merged = byPart.get(part) ?? {};
    for (const [key, value] of Object.entries(entry.result?.values ?? {})) {
      if (!(key in merged) && value?.value !== null && value?.value !== undefined) merged[key] = value;
    }
    byPart.set(part, merged);
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
    /** What the cited drawing calls its own max height, for `outlineFor`. */
    let statedHeight: number | null = null;
    const height = values["dimensions.bodyHeightMm"];
    if (height && typeof height.value === "number") {
      const doc = await documentFor(part);
      const page = (height as { page?: unknown }).page;
      const stated = doc ? statedMaxHeightMm(doc, typeof page === "number" ? page : null) : null;
      if (stated !== null) {
        values["dimensions.bodyHeightMm"] = { ...height, value: stated };
        statedHeight = stated;
      }
    }
    const claimed = values["packageOutlineCode"]?.value;
    const code =
      typeof claimed === "string" && DIMENSION_ORACLE[claimed]
        ? claimed
        : outlineFor(byPartName.get(part) ?? [], statedHeight);
    if (!code) {
      unmatched.push(part);
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
  if (unmatched.length > 0) console.log(`    ${unmatched.slice(0, 12).join(", ")}${unmatched.length > 12 ? ", ..." : ""}`);

  if (wrong.length > 0) {
    console.log(`\n  Every WRONG above is a number that would have placed copper.`);
  }
}

main();

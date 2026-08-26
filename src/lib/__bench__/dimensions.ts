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

import { loadBenchEnv } from "./env";
import { DIMENSION_ORACLE, type DimensionOracleEntry, type OracleRange } from "./dimension-oracle";
import { buildCachedParts } from "./oracle-match";

loadBenchEnv();

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
  else if (entry.leadContactMaxMm !== undefined) {
    // A MAX-ONLY FOOT. The drawing states one bound and no other, so any reading
    // at or below it is correct and the maximum itself is the expected answer -
    // the same treatment `bodyHeightMaxMm` gets, and for the same reason.
    const read = at("dimensions.leadContactMm");
    const maxMm =
      read !== null && typeof read === "object" && read !== null
        ? (read as { maxMm?: unknown }).maxMm
        : read;
    add(
      "leadContactMm",
      typeof maxMm === "number" ? near(maxMm, entry.leadContactMaxMm) : maxMm === undefined || maxMm === null ? null : false,
      at("dimensions.leadContactMm"),
      entry.leadContactMaxMm
    );
  }
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
  if (
    !entry.leadContactMm &&
    entry.leadContactMaxMm === undefined &&
    !(entry.notRecordable ?? []).includes("leadContactMm")
  ) {
    const read = at("dimensions.leadContactMm");
    if (read !== null && read !== undefined) {
      add("leadContactMm", false, read, "the drawing prints none");
    }
  }

  // AND EVERY OTHER FIELD A PERSON CONFIRMED THE DRAWING DOES NOT STATE.
  //
  // `leadContactMm` above has had this check since the oracle existed, and it is
  // the only field that did, because its absence was the only one meant as a
  // claim. `printsNothingFor` lets any field carry the same claim, made
  // explicitly by whoever read the page rather than inferred from a gap.
  //
  // The land pattern is the case that forced it. An entry with no `land` is
  // usually just a footprint page nobody has read, so silence there cannot mean
  // "the datasheet draws none" - but where somebody HAS checked, a land pattern
  // read out of a document that prints none is copper with no source at all.
  for (const field of entry.printsNothingFor ?? []) {
    if (field === "land") {
      for (const part of ["landPadLengthMm", "landPadWidthMm", "landSpanMm", "landSpanCrossMm"] as const) {
        const read = at(`dimensions.${part}`);
        if (read !== null && read !== undefined) {
          add(part, false, read, "this datasheet draws no footprint for this package");
        }
      }
      continue;
    }
    const read = at(`dimensions.${field}`);
    if (read !== null && read !== undefined) {
      add(field, false, read, "the drawing states none");
    }
  }

  return rows;
}


async function main(): Promise<void> {
  // ONE definition of "which drawing did this part read", shared with
  // `bench:questions`. Three separate wrong measurements were paid for while
  // that rule lived in this file alone; see `oracle-match.ts`.
  const built = await buildCachedParts();
  if (!built) {
    console.log("No model configured, so no records can be rebuilt.");
    return;
  }

  const rows: Row[] = [];
  const unmatched: string[] = [];
  for (const entry of built) {
    if (!entry.oracleCode) {
      // NAME THE CODE THE RECORD DID REPORT, not just the part.
      //
      // "94 parts have no oracle entry" is a number nobody can act on: it does
      // not say which DRAWING to go and read. The record usually knows - it
      // reports an outline code that simply has no entry yet - and printing it
      // turns the list into a work queue.
      unmatched.push(entry.claimedCode ? `${entry.part} [${entry.claimedCode}]` : entry.part);
      continue;
    }
    rows.push(...compare(entry.part, entry.oracleCode, DIMENSION_ORACLE[entry.oracleCode], entry.values));
  }

  const correct = rows.filter((r) => r.verdict === "correct").length;
  const wrong = rows.filter((r) => r.verdict === "WRONG");
  const unread = rows.filter((r) => r.verdict === "not read").length;

  console.log(`\nChecked ${built.length} cached parts against ${Object.keys(DIMENSION_ORACLE).length} hand-read drawings.\n`);

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

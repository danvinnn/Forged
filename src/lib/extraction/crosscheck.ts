// Comparing what the code read against what the model read.
//
// Deterministic still wins the RECORD: it is the side measured against the
// hand-read oracles, at 31/31 on pin names and 24/24 on package families, and
// the model's accuracy on those same fields has never been measured. What is new
// is that a model answer about an already-answered field is no longer thrown
// away unexamined. Where the two sides differ, both are kept and a person is
// asked, with the page each side read.
//
// The fields here are the ones that place copper or wire a symbol. A radiation
// rating and a manufacturer string are real data that nothing generated depends
// on, and the budget for interrupting someone is small.
//
// Air-gap safe: pure comparison, no networking.

import type { ExtractionField } from "./contracts";
import type { LeadWidth, PinRecord } from "../types";
import { declaredLeadCount } from "../packagevariants";

/** Fields asked about even when the deterministic pass already answered them. */
export const CROSS_CHECKED_FIELDS: readonly ExtractionField[] = [
  "packageType",
  "pinCount",
  "pins",
  "dimensions.pitchMm",
  "dimensions.leadSpanMm",
  "dimensions.leadWidthMm",
  "dimensions.leadContactMm",
  "dimensions.bodyLengthMm",
  "dimensions.bodyWidthMm",
  // Added 2026-08-11. These three were gap-only, so a wrong deterministic value
  // was never contested and never visible, and `leadCount` reaches the footprint
  // directly. "Only checked where we already doubted ourselves" is not a check.
  "dimensions.bodyHeightMm",
  "dimensions.leadLengthMm",
  "dimensions.leadCount"
];

/**
 * How far two readings of the same millimetre value may differ and still be the
 * same reading.
 *
 * Absolute rather than relative, because the quantities here span two orders of
 * magnitude and the thing being tolerated is the same in each case: one side
 * quoting a nominal where the other quotes a limit. 0.05 mm is below the
 * smallest feature any of these drawings dimension and well under the ~0.12 mm
 * at which a land pattern comparison already calls two patterns different.
 */
export const DIMENSION_TOLERANCE_MM = 0.05;

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= DIMENSION_TOLERANCE_MM;
}

function asRange(value: unknown): LeadWidth | null {
  if (typeof value !== "object" || value === null) return null;
  const range = value as { minMm?: unknown; maxMm?: unknown };
  return typeof range.minMm === "number" && typeof range.maxMm === "number"
    ? { minMm: range.minMm, maxMm: range.maxMm }
    : null;
}

/**
 * Package designators, compared by the count they declare and then by tokens.
 *
 * `8-Pin SOIC`, `SOIC-8` and `SOIC (D) 8` are the same package written three
 * ways, and treating those as a disagreement would bury the real ones. Token
 * containment handles all three.
 *
 * The count comes FIRST because it is printed rather than inferred, and because
 * it is the difference that matters most. Measured on ISO7841, where the code
 * said `DW (16)` and the model said `16-pin SOIC`: those are a wide body and a
 * narrow one, 4.3 mm apart in lead span, and the prose reading would have put
 * every pad about 1.96 mm inboard of the leads. Tokens still separate them, and
 * the comparison must keep reporting it.
 *
 * A family-table lookup used to sit between the two rules, collapsing designators
 * that resolved to the same entry. It went with the table, and it was never the
 * load-bearing part: either side failing to resolve already fell through to
 * tokens, which is now the only path.
 */
function samePackage(left: string, right: string, pinCount?: number | null): boolean {
  // A count printed in the designator itself outranks the record's, and two
  // designators that state DIFFERENT counts disagree whatever they resolve to.
  const leftCount = declaredLeadCount(left);
  const rightCount = declaredLeadCount(right);
  if (leftCount !== null && rightCount !== null && leftCount !== rightCount) return false;

  // A family-table lookup used to run here, treating two designators as the
  // same package when both resolved to the same family entry. It was a
  // refinement rather than the rule: either side failing to resolve fell through
  // to the token comparison below, which is what every designator does now that
  // the table is gone. The declared-count check above is the part that does the
  // work, and it is the part that came off the printed designator rather than
  // off a list of names.

  const tokens = (text: string) =>
    new Set(
      text
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .split(" ")
        .filter((token) => token && token !== "PIN" && token !== "LEAD" && token !== "PINS")
    );
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return false;
  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;
  // Every token of the shorter designator appears in the longer one. `SOIC 8`
  // matches `SOIC D 8`; `SOIC 8` does not match `TSSOP 8`.
  for (const token of smaller) if (!larger.has(token)) return false;
  return true;
}

/**
 * Pin tables, compared on the NAMES at each number.
 *
 * Descriptions and electrical types are prose and routinely differ in wording
 * without differing in meaning. The name is what wires the symbol, so it is the
 * only part where a difference is worth someone's time. A different LENGTH is
 * itself a disagreement, and reported as one.
 */
function samePins(left: PinRecord[], right: PinRecord[]): boolean {
  if (left.length !== right.length) return false;
  const normalise = (name: unknown) => String(name ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Coerced, because the two sides do not agree on the TYPE of a pin number.
  // The record holds `"1"`; a model returns `1`, which is the exact mismatch
  // `normalizeModelPins` exists to repair, and this comparison sees the raw
  // model value before that repair happens. Keyed on the raw integer and looked
  // up with the record's string, every lookup missed and EVERY pin table was
  // reported as a disagreement. Measured on AD620, whose two readings are
  // character-for-character identical and were flagged anyway.
  const key = (pin: PinRecord) => String(pin.number).trim();
  const byNumber = new Map(right.map((pin) => [key(pin), pin]));
  for (const pin of left) {
    const other = byNumber.get(key(pin));
    if (!other) return false;
    if (normalise(pin.name) !== normalise(other.name)) return false;
  }
  return true;
}

/**
 * Whether two readings of a field agree.
 *
 * Unknown shapes agree by default. A comparison that cannot understand what it
 * is looking at must not manufacture a disagreement, because every false one
 * spends the user's attention and teaches them to click past the real ones.
 */
export function valuesAgree(
  field: string,
  deterministic: unknown,
  model: unknown,
  /**
   * The record's pin count, used only to resolve a package designator that does
   * not carry its own. Optional so every existing caller and test keeps its
   * meaning; without it the comparison simply falls back to tokens.
   */
  pinCount?: number | null
): boolean {
  if (deterministic === null || model === null) return true;

  if (field === "pins") {
    return Array.isArray(deterministic) && Array.isArray(model)
      ? samePins(deterministic as PinRecord[], model as PinRecord[])
      : true;
  }

  if (field === "packageType") {
    return typeof deterministic === "string" && typeof model === "string"
      ? samePackage(deterministic, model, pinCount)
      : true;
  }

  if (field === "pinCount") {
    return typeof deterministic === "number" && typeof model === "number"
      ? deterministic === model
      : true;
  }

  const leftRange = asRange(deterministic);
  const rightRange = asRange(model);
  if (leftRange && rightRange) {
    return sameNumber(leftRange.minMm, rightRange.minMm) && sameNumber(leftRange.maxMm, rightRange.maxMm);
  }

  // A range against a single number: the number agrees if it sits inside the
  // range, which is what a nominal quoted against a min/max pair looks like.
  const range = leftRange ?? rightRange;
  const single = typeof deterministic === "number" ? deterministic : typeof model === "number" ? model : null;
  if (range && single !== null) {
    return single >= range.minMm - DIMENSION_TOLERANCE_MM && single <= range.maxMm + DIMENSION_TOLERANCE_MM;
  }

  if (typeof deterministic === "number" && typeof model === "number") {
    return sameNumber(deterministic, model);
  }

  return true;
}

/** Short, human, and never a raw JSON dump. Shared with the review list. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (Array.isArray(value)) {
    const pins = value as PinRecord[];
    const head = pins
      .slice(0, 3)
      .map((pin) => `${pin.number}:${pin.name}`)
      .join(", ");
    return `${pins.length} pins (${head}${pins.length > 3 ? ", ..." : ""})`;
  }
  const range = asRange(value);
  if (range) return `${range.minMm}-${range.maxMm} mm`;
  return String(value);
}

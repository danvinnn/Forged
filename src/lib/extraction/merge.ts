import type { DatasheetText } from "../pdftext";
import { pinElectricalTypes, type Citation, type Extracted, type PartRecord, type PinElectricalType, type PinRecord } from "../types";
import { extractionFields, type ExtractionField, type ExtractionResult, type ModelValue } from "./contracts";

/**
 * Deterministic-first merging, and verification of what the model claims.
 *
 * Air-gap safe: no networking, no external URLs.
 */

/** Reads the Extracted<T> currently at a dotted field path. */
function fieldAt(part: PartRecord, field: ExtractionField): Extracted<unknown> {
  switch (field) {
    case "partNumber":
      return part.partNumber;
    case "manufacturer":
      return part.manufacturer;
    case "packageType":
      return part.packageType;
    case "pinCount":
      return part.pinCount;
    case "pins":
      return part.pins;
    default: {
      const [group, key] = field.split(".") as ["dimensions" | "radiation", string];
      return (part[group] as Record<string, Extracted<unknown>>)[key];
    }
  }
}

function setFieldAt(part: PartRecord, field: ExtractionField, value: Extracted<unknown>): void {
  switch (field) {
    case "partNumber":
      part.partNumber = value as Extracted<string>;
      return;
    case "manufacturer":
      part.manufacturer = value as Extracted<string>;
      return;
    case "packageType":
      part.packageType = value as Extracted<string>;
      return;
    case "pinCount":
      part.pinCount = value as Extracted<number>;
      return;
    case "pins":
      part.pins = value as Extracted<PinRecord[]>;
      return;
    default: {
      const [group, key] = field.split(".") as ["dimensions" | "radiation", string];
      (part[group] as Record<string, Extracted<unknown>>)[key] = value;
    }
  }
}

/** Fields the deterministic pass left unresolved, in a stable order. */
export function unresolvedFields(part: PartRecord): ExtractionField[] {
  return extractionFields.filter((field) => fieldAt(part, field).value === null);
}

/**
 * Coerces a model's pin rows to the record contract, or rejects the table.
 *
 * A model does not answer in our types and there is no reason it should. Gemini
 * returns `{"number": 1}` as an INTEGER where `pinSchema` requires a string, and
 * `"electricalType": null` against an enum with no null member. Both were stored
 * raw, which passed `resolveForExport` in process and then failed
 * `partSchema.safeParse` at `/api/export` with "Invalid part record".
 *
 * That is the whole model path broken end to end: on every part the model
 * actually helped with, the user got a validation error instead of a bundle. It
 * survived because the tests build well-formed `PinRecord`s by hand, so nothing
 * ever exercised the shape a real model returns.
 *
 * Rejecting the table rather than repairing it row by row is deliberate. A row
 * that cannot be read is a row we do not understand, and a pin table with a hole
 * in it is the input that produces a miswired footprint.
 */
function normalizeModelPins(rows: unknown): { ok: true; pins: PinRecord[] } | { ok: false; reason: string } {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, reason: "the pin table was empty" };
  }

  const pins: PinRecord[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") {
      return { ok: false, reason: "a row was not an object" };
    }
    const entry = row as { number?: unknown; name?: unknown; electricalType?: unknown; description?: unknown };

    // The number is the load-bearing field: it is what a pad is built from.
    const raw =
      typeof entry.number === "number" && Number.isInteger(entry.number)
        ? String(entry.number)
        : typeof entry.number === "string" && entry.number.trim()
          ? entry.number.trim()
          : null;
    if (raw === null) return { ok: false, reason: "a row carried no pin number" };

    // A non-numeric designator is almost always the exposed thermal pad
    // (`EP`, `PAD`, `TAB`). It is a real, electrically mandatory feature and
    // `geometry.ts` has no concept of one, so a part that has it cannot be built
    // correctly: emitting the numbered pins alone would produce a footprint
    // missing the pad the part must be soldered by. Refuse, and say why.
    if (!/^\d+$/.test(raw)) {
      return {
        ok: false,
        reason: `the table includes a non-numbered terminal ("${raw}"), which is an exposed thermal pad. Forge cannot generate a footprint for a package with an exposed pad yet, and the numbered pins alone would be a footprint missing a mandatory pad`
      };
    }
    const number = raw;

    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null;
    if (name === null) return { ok: false, reason: `pin ${number} carried no name` };

    // An unrecognised or absent type is recorded as unspecified rather than
    // rejecting the row: the type is metadata on the symbol, not geometry, and
    // no pad moves because of it.
    const electricalType: PinElectricalType =
      typeof entry.electricalType === "string" &&
      (pinElectricalTypes as readonly string[]).includes(entry.electricalType)
        ? (entry.electricalType as PinElectricalType)
        : "unspecified";

    const description = typeof entry.description === "string" ? entry.description : undefined;
    pins.push({ number, name, electricalType, ...(description ? { description } : {}) });
  }

  return { ok: true, pins };
}

/**
 * The same proof the deterministic readers have to pass: exactly 1..N, no gaps,
 * no repeats.
 *
 * Both geometry readers are held to this and a model answer was not, which left
 * the model path the weakest link in a chain built to refuse exactly this. The
 * hazard is not hypothetical: a PCF8574 page draws a 16-pin and a 20-pin variant
 * interleaved, so a model reading it can return entirely real pin NAMES against
 * the other package's NUMBERS, and the name-based citation check passes it at
 * full marks because every name genuinely is on the page.
 */
function isGapFreeSequence(pins: PinRecord[]): boolean {
  const numbers = pins.map((pin) => Number(pin.number));
  if (numbers.some((value) => !Number.isInteger(value) || value < 1)) return false;
  const distinct = new Set(numbers);
  if (distinct.size !== numbers.length) return false;
  return Math.max(...numbers) === numbers.length;
}

/** Normalizes a value to the text an auditor would search the page for. */
function searchableText(value: ModelValue["value"]): string | null {
  if (value === null) return null;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.trim() || null;
  // Arrays are verified structurally instead, see verifyPinTable.
  return null;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

/**
 * Fraction of a pin table's names that must appear on the page it cites for the
 * citation to hold. Not 100%: a real table legitimately renders some names in
 * ways the text layer mangles (rotated headers, glyph-split labels), and
 * demanding perfection would reject correct tables. Not a bare majority either,
 * since that would accept a table mostly invented around a few real names.
 */
const PIN_TABLE_MATCH_THRESHOLD = 0.6;

/** Names too short or too generic to be evidence of anything. */
function isDistinctive(name: string): boolean {
  return name.trim().length >= 2;
}

/**
 * Verifies a pin table by checking its names really are on the page it cites.
 *
 * A pin array has no single quotable string, so the string check cannot judge
 * it, and the previous behavior was to leave it permanently uncited. That was a
 * dead end: a model-supplied pin table could never be traceable, so it could
 * never export, so the model could never help with the one field that blocks
 * almost every part in the corpus. Checking the names individually asks the same
 * question the string check asks, just spread across the rows.
 */
function verifyPinTable(pageText: string, pins: PinRecord[]): boolean {
  const names = pins.map((pin) => pin.name).filter(isDistinctive);
  if (names.length === 0) return false;

  const haystack = normalize(pageText);
  const found = names.filter((name) => haystack.includes(normalize(name))).length;
  return found / names.length >= PIN_TABLE_MATCH_THRESHOLD;
}

/**
 * Turns a model's page CLAIM into a citation, but only if the claim holds.
 *
 * The model is not trusted to say where it read something. If the value does not
 * actually appear on the page it named, no citation is recorded. A citation that
 * does not survive checking is exactly the "hallucinated source" failure the
 * architecture forbids in retrieval, relocated into extraction.
 */
export function verifyCitation(doc: DatasheetText, claimed: ModelValue): Citation | null {
  if (claimed.page === null) return null;
  const page = doc.pages.find((candidate) => candidate.page === claimed.page);
  if (!page) return null;

  // A pin table is judged by whether its rows are on the page, not by matching
  // one string.
  if (Array.isArray(claimed.value)) {
    const pins = claimed.value as PinRecord[];
    if (!verifyPinTable(page.text, pins)) return null;
    return { page: page.page, snippet: `${pins.length}-row pin table`, region: null };
  }

  const needle = searchableText(claimed.value);
  if (needle === null) return null;

  const haystack = normalize(page.text);
  if (!haystack.includes(normalize(needle))) return null;

  return { page: page.page, snippet: needle, region: null };
}

export interface MergeOutcome {
  part: PartRecord;
  /** Fields the model filled that the deterministic pass had left unknown. */
  filled: ExtractionField[];
  /** Fields the model answered but whose page claim did not check out. */
  uncited: ExtractionField[];
  /**
   * Fields the model answered in a shape that could not be trusted at all, and
   * which were therefore discarded rather than recorded. Distinct from
   * `uncited`: that value is kept and flagged, this one never enters the record.
   */
  rejected: Array<{ field: ExtractionField; reason: string }>;
}

/**
 * Applies model output to a deterministic record.
 *
 * Two rules, both structural:
 * 1. A field with a deterministic value is never overwritten. The model fills
 *    gaps; it does not get a vote on what code already read off the page.
 * 2. Every model value is marked `method: "vlm"` and carries a citation only
 *    when the claim was verified against the page.
 */
export function mergeModelValues(
  part: PartRecord,
  doc: DatasheetText,
  result: ExtractionResult,
  modelName: string
): MergeOutcome {
  const merged: PartRecord = JSON.parse(JSON.stringify(part)) as PartRecord;
  const filled: ExtractionField[] = [];
  const uncited: ExtractionField[] = [];
  const rejected: Array<{ field: ExtractionField; reason: string }> = [];

  for (const field of extractionFields) {
    const claimed = result.values[field];
    if (!claimed || claimed.value === null) continue;

    // Rule 1: deterministic wins, always.
    if (fieldAt(merged, field).value !== null) continue;

    // A pin table is coerced to the record contract and held to the same
    // gap-free 1..N proof the deterministic readers must pass. A table that
    // fails either is DROPPED, not stored uncited: unlike a scalar, a pin table
    // is what pads are built from, and the record is better off reporting the
    // gap the deterministic pass already found.
    let value = claimed.value;
    if (field === "pins") {
      const normalized = normalizeModelPins(claimed.value);
      if (!normalized.ok) {
        rejected.push({ field, reason: normalized.reason });
        continue;
      }
      if (!isGapFreeSequence(normalized.pins)) {
        rejected.push({
          field,
          reason: `the rows do not number 1..${normalized.pins.length} without gaps or repeats`
        });
        continue;
      }
      value = normalized.pins;
    }

    const citation = verifyCitation(doc, { ...claimed, value });
    if (!citation) uncited.push(field);

    setFieldAt(merged, field, {
      value,
      // No calibrated confidence exists for a model answer. A verified citation
      // is the only corroboration available, so it is the only thing that
      // separates the two levels, and neither claims to be a probability.
      confidence: citation ? 0.5 : null,
      method: "vlm",
      citation
    });
    filled.push(field);
  }

  if (filled.length > 0) {
    merged.notes = [
      ...merged.notes,
      `${modelName} filled ${filled.length} field(s) the text pass could not resolve: ${filled.join(", ")}.`
    ];
  }
  if (uncited.length > 0) {
    merged.notes = [
      ...merged.notes,
      `${uncited.length} model value(s) could not be located on the page claimed and carry no citation: ${uncited.join(", ")}. These are not traceable for QML sign-off.`
    ];
  }
  if (rejected.length > 0) {
    merged.notes = [
      ...merged.notes,
      ...rejected.map(
        (entry) =>
          `${modelName} answered ${entry.field} but it was discarded, so the field stays honestly unknown: ${entry.reason}.`
      )
    ];
  }
  for (const note of result.notes ?? []) merged.notes.push(`${modelName}: ${note}`);

  return { part: merged, filled, uncited, rejected };
}

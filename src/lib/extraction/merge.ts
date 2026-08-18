import type { DatasheetText } from "../pdftext";
import { pinElectricalTypes, type Citation, type Extracted, type ExtractionMethod, type PartRecord, type PinElectricalType, type PinRecord } from "../types";
import { extractionFields, type ExtractionField, type ExtractionResult, type ModelValue } from "./contracts";
import { citableText, quarantinedRegions } from "./untrusted";

/**
 * MODEL-FIRST merging, and verification of what the model claims.
 *
 * The precedence flipped on 2026-08-11 after cross-checking found three live
 * deterministic defects in two days, all shipping into geometry, all outside the
 * oracles' coverage. What did NOT flip is the evidence rule: a model value still
 * has to carry a verified citation to win, so this is model-first among readings
 * that can both be checked rather than assertion over evidence.
 *
 * Air-gap safe: no networking, no external URLs.
 */

/**
 * The fields a drawing prints as a MIN/MAX PAIR rather than a single number.
 *
 * Exported because it was a list in two places: here, and in the merge test that
 * proves every extraction field can reach the record. Adding a range field and
 * missing one of them makes the test feed a scalar to a range field, which the
 * validation below correctly drops, and the test then reports the merge broken.
 * One list, both readers.
 */
export const RANGE_FIELDS = [
  "dimensions.leadWidthMm",
  "dimensions.leadSpanMm",
  "dimensions.leadSpanCrossMm",
  "dimensions.leadContactMm"
] as const;

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
    case "jedecOutline":
      return part.jedecOutline;
    case "packageOutlineCode":
      return part.packageOutlineCode;
    default: {
      // Guarded because the failure mode is silent and total. A top-level field
      // added to `extractionFields` without a case above falls here, splits to
      // `[name, undefined]`, indexes to `undefined`, and every caller throws on
      // `.value`. That is what `jedecOutline` did on 2026-08-13: it typechecked
      // cleanly and broke 30 tests at runtime.
      const [group, key] = field.split(".") as ["dimensions" | "radiation", string];
      if (key === undefined) throw new Error(`extraction field "${field}" has no case in fieldAt`);
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
    case "jedecOutline":
      part.jedecOutline = value as Extracted<string>;
      return;
    case "packageOutlineCode":
      part.packageOutlineCode = value as Extracted<string>;
      return;
    default: {
      // The SAME guard `fieldAt` carries, and it was missing here until
      // 2026-08-17 while `fieldAt` had it. `packageOutlineCode` was the field
      // that fell through: it split to ["packageOutlineCode"], key came out
      // undefined, and the value was written to a property literally named
      // "undefined" on the Extracted object. The record kept value: null, the
      // model's answer was lost on every part, and the notes still reported the
      // field as filled.
      //
      // Silent and total, exactly as the note in `fieldAt` predicted, and it
      // survived because that fix was applied to one of the two functions.
      const [group, key] = field.split(".") as ["dimensions" | "radiation", string];
      if (key === undefined) throw new Error(`extraction field "${field}" has no case in setFieldAt`);
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
function normalizeModelPins(
  rows: unknown
): { ok: true; pins: PinRecord[]; exposedPad: boolean } | { ok: false; reason: string } {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, reason: "the pin table was empty" };
  }

  const pins: PinRecord[] = [];
  let exposedPad = false;
  // The designators that were NOT pin numbers, kept so a table with none can say
  // what it actually contained instead of blaming the document.
  const skipped: string[] = [];
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
    // (`EP`, `PAD`, `TAB`, `epad`, `Exposed pad`). It is a real, electrically
    // mandatory feature and `geometry.ts` has no concept of one, so no footprint
    // can be built for the part yet.
    //
    // Until 2026-08-10 that refused the WHOLE table, which threw away a pinout
    // the model had read correctly. Measured over the hold-out that cost three
    // parts outright: ADS1220 (16 pins + `Pad`), LD39050 (6 + `Exposed pad`) and
    // ST1S10 (8 + `epad`), every numbered row of all three hand-checked correct.
    //
    // The pad row is now RECORDED rather than fatal. `resolveForExport` carries
    // the flag to `buildFootprintGeometry`, which refuses there. The guarantee
    // that mattered is untouched: no footprint is ever emitted missing a
    // mandatory pad. What changes is that the symbol, the pin list and the
    // review panel no longer die with it.
    if (!/^\d+$/.test(raw)) {
      exposedPad = true;
      skipped.push(raw);
      continue;
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

  // Dropping the pad row must not leave an empty table.
  //
  // But "no numbered rows" is not always a failure to READ, and saying so blamed
  // the document for our own scope. A ball- or land-grid array addresses every
  // terminal by grid position, `A1`, `B2`, `C3`, so a perfectly read BGA pinout
  // arrives here with every row skipped and used to be reported as an unreadable
  // pin table. TXB0104 in the corpus is one.
  //
  // Stated as the SHAPE of the designators rather than as a package name, so it
  // covers any grid-addressed part rather than the one that prompted it: a row
  // letter followed by a column number is the addressing scheme, whatever the
  // vendor calls the package.
  if (pins.length === 0) {
    const grid = skipped.length > 0 && skipped.every((designator) => /^[A-Za-z]{1,2}\d{1,3}$/.test(designator));
    if (grid) {
      return {
        ok: false,
        reason:
          `the pinout was read correctly, but every terminal is addressed by grid position ` +
          `(${skipped.slice(0, 3).join(", ")}), which is a ball- or land-grid array. Forge builds ` +
          `packages with leads on two or four sides and has no grid arrangement, so this pinout ` +
          `cannot be turned into a footprint`
      };
    }
    return {
      ok: false,
      reason:
        skipped.length > 0
          ? `the pin table had no numbered rows, only ${skipped.slice(0, 4).join(", ")}`
          : "the pin table had no numbered rows"
    };
  }

  return { ok: true, pins, exposedPad };
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
  // Arrays and ranges are verified structurally instead; see verifyPinTable and
  // verifyRange.
  return null;
}

/** A min/max pair the model returned for a lead span or lead width. */
function asRange(value: ModelValue["value"]): { minMm: number; maxMm: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { minMm, maxMm } = value as { minMm?: unknown; maxMm?: unknown };
  if (typeof minMm !== "number" || typeof maxMm !== "number") return null;
  if (!Number.isFinite(minMm) || !Number.isFinite(maxMm)) return null;
  // A dimension is positive and a range runs the right way round. Both are
  // cheap and both catch a model that has transposed or hallucinated a pair.
  if (minMm <= 0 || maxMm < minMm) return null;
  return { minMm, maxMm };
}

/**
 * A range citation, when BOTH endpoints are quotable on the page it cites.
 *
 * A drawing normally prints these as labels the text layer does not carry, in
 * which case this fails and the value falls to the weaker drawing citation.
 * That is the intended path, not a shortfall: on a document that DOES tabulate
 * the span, the stronger quotable citation is available and should be used.
 */
function verifyRange(pageText: string, range: { minMm: number; maxMm: number }): boolean {
  const haystack = normalize(pageText);
  return (
    haystack.includes(normalize(String(range.minMm))) &&
    haystack.includes(normalize(String(range.maxMm)))
  );
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
 * The page a pin table actually appears on, or null.
 *
 * Used for the per-package tables, which the model returns without a page claim.
 * Every page is tested with the SAME evidence rule the rest of this module uses:
 * quarantined regions are cut first, so a table planted inside an instruction
 * block cannot be located and therefore cannot be cited.
 */
function locatePinTable(doc: DatasheetText, pins: PinRecord[]): Citation | null {
  for (const page of doc.pages) {
    const evidence = citableText(page.text, quarantinedRegions(page.text));
    if (verifyPinTable(evidence, pins)) {
      return { page: page.page, snippet: `${pins.length}-row pin table`, region: null };
    }
  }
  return null;
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

  // Instructions addressed to a reader of datasheets are not evidence about a
  // component, whatever numbers sit inside them. Cut before anything is matched,
  // so every shape below is protected without having to remember to be.
  //
  // This is the server-side half of the injection defence and the load-bearing
  // one since the model became authoritative: even assuming the injection worked
  // completely and the model returned exactly what the attacker asked for, the
  // claim cannot become a citation, so it cannot become geometry.
  const evidence = citableText(page.text, quarantinedRegions(page.text));

  // A pin table is judged by whether its rows are on the page, not by matching
  // one string.
  if (Array.isArray(claimed.value)) {
    const pins = claimed.value as PinRecord[];
    if (!verifyPinTable(evidence, pins)) return null;
    return { page: page.page, snippet: `${pins.length}-row pin table`, region: null };
  }

  const range = asRange(claimed.value);
  if (range) {
    if (!verifyRange(evidence, range)) return null;
    return { page: page.page, snippet: `${range.minMm}-${range.maxMm} mm`, region: null };
  }

  const needle = searchableText(claimed.value);
  if (needle === null) return null;

  const haystack = normalize(evidence);
  if (!haystack.includes(normalize(needle))) return null;

  return { page: page.page, snippet: needle, region: null };
}

/**
 * Phrases that mark a page as carrying a mechanical drawing.
 *
 * Used only to describe a page in a citation, never to find one, so this list
 * being incomplete costs a sentence of provenance rather than a value.
 */
const DRAWING_CONTEXT = [
  /\b(?:package|mechanical)\s+(?:outline|drawing|information|description|dimensions?)\b/i,
  /\bpackage\s+outline\b/i,
  /\ball\s+dimensions\s+are\s+in\s+(?:millimeters|millimetres|inches)\b/i,
  /\bdimensions?\s+are\s+in\s+(?:millimeters|millimetres|inches)\b/i,
  /\b[A-Z]{1,4}\d{4}[A-Z]\b/,
  /\b(?:JEDEC|MO|MS)-\d{3}\b/i,
  // Pinout pages, added when pin tables became citable from a render. The
  // markers above all name a MECHANICAL drawing, so a page carrying only a
  // pinout figure fell through to the bare "read from the rendered page", which
  // tells a reviewer the page number and nothing about what they are looking
  // for on it. These are the headings vendors actually print above the figure.
  /\bpin\s*(?:connection|description|configuration|assignment|out|function)s?\b/i,
  /\b(?:top|bottom)\s+view\b/i,
  /\bterminal\s+(?:configuration|function)s?\b/i
];

/**
 * A citation for a value read off a RENDERED page rather than out of the text.
 *
 * This exists because the check above cannot be applied to a drawing, and the
 * reason is not a limitation to route around: a dimension printed beside a
 * dimension line genuinely is not in the text layer, so requiring the value to
 * appear there would reject every correct drawing read. That was the measured
 * behaviour of the text-only pass, which reached 0 of 83 parts for body height
 * and lead length.
 *
 * What can still be established, and what this records:
 *  - the page was one WE SENT, so the model cannot cite a page it never saw
 *  - the page was rendered, so a reviewer can be shown exactly what the model saw
 *  - what identifies the page as a drawing, quoted from its own text
 *
 * What it deliberately does NOT do is claim the value was confirmed. A
 * `vlm-drawing` value is an unconfirmed reading with a verifiable location,
 * and the record says so rather than dressing it as a checked one.
 */
export function citeRenderedPage(
  doc: DatasheetText,
  claimed: ModelValue,
  sentPages: readonly number[]
): Citation | null {
  if (claimed.page === null) return null;
  if (!sentPages.includes(claimed.page)) return null;
  const page = doc.pages.find((candidate) => candidate.page === claimed.page);
  if (!page) return null;

  // A PAGE CARRYING AN INJECTION IS NOT EVIDENCE, WHOLE.
  //
  // The text path cuts the quarantined region out and matches against what is
  // left, which is right there: the real occurrence of a value survives the cut
  // and the planted one contributes nothing. That is not available here. A value
  // read off an IMAGE cannot be attributed to a region of it, so there is no way
  // to say the model looked at the drawing rather than at the injected sentence
  // rendered three inches below it. Pixels cannot be cut the way text can.
  //
  // So the whole page is refused. Found by audit on 2026-08-17: this function
  // consulted the quarantine not at all, and `untrusted.ts` claimed that even a
  // fully successful injection "cannot become a citation, so it cannot become
  // geometry". That was true of the text path and false of this one, which is
  // the newer of the two and the one drawings actually go through.
  //
  // The cost is a page with a false positive in it losing its drawing citation.
  // The value is kept and marked untraceable rather than lost, which is the
  // right side to fail on.
  if (quarantinedRegions(page.text).length > 0) return null;

  const marker = DRAWING_CONTEXT.map((pattern) => pattern.exec(page.text)?.[0]).find(Boolean);
  return {
    page: page.page,
    snippet: marker
      ? `read from the rendered page (page identifies as "${marker.trim().slice(0, 60)}")`
      : "read from the rendered page",
    region: null
  };
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
/**
 * Whether a value already on the record is the USER'S, and so not the model's to
 * overwrite.
 *
 * ## What this replaced, and why it shrank to one line
 *
 * There used to be a cross-check here: a 217-line module comparing the
 * deterministic parser's reading of thirteen fields against the model's,
 * recording disagreements as `conflicts`, holding parts for review, and
 * reporting a disagreement count in both benches.
 *
 * It stopped being able to do anything when the parser was deleted. Comparing
 * two readers needs two readers, and `extractPartRecord` now fills exactly two
 * fields: `partNumber` from the file the user named, and `packageType` from the
 * package the user picked. The other eleven cross-checked fields are
 * permanently null, and `valuesAgree` treats a null side as agreement, so the
 * comparison could not fire. It reported "0 disagreements on 0/56 parts", which
 * reads like a pass and means nothing was examined.
 *
 * What was NOT purely reporting, and is kept here, is the precedence: a field
 * that already had a value was only replaced when the model OUTRANKED it, and
 * otherwise the model's reading was dropped. That survives as one line: a value
 * already on the record is not the model's to overwrite.
 *
 * ## One deliberate behaviour change, stated rather than absorbed
 *
 * Under the old rule the model COULD displace a cross-checked field, and
 * `packageType` was cross-checked. The only way `packageType` is non-null now is
 * that the user picked it, so that path meant a model reading could silently
 * replace the package a user chose. It no longer can. The user chose from a list
 * this product generated out of their own document, and that choice is the more
 * authoritative of the two.
 *
 * If a model disagreeing with that choice turns out to be worth surfacing, it is
 * a comparison of two values at one call site, to be written then rather than
 * kept alive as a module against the possibility.
 */
function alreadyAnswered(existing: Extracted<unknown>): boolean {
  return existing.value !== null;
}

export function mergeModelValues(
  part: PartRecord,
  doc: DatasheetText,
  result: ExtractionResult,
  modelName: string,
  /**
   * Pages that were RENDERED and sent as images. Empty means text-only, in
   * which case nothing can earn a drawing citation and this behaves exactly as
   * it did before images existed.
   */
  renderedPages: readonly number[] = []
): MergeOutcome {
  const merged: PartRecord = JSON.parse(JSON.stringify(part)) as PartRecord;
  const filled: ExtractionField[] = [];
  const uncited: ExtractionField[] = [];
  const rejected: Array<{ field: ExtractionField; reason: string }> = [];

  for (const field of extractionFields) {
    const claimed = result.values[field];
    if (!claimed || claimed.value === null) continue;

    // Rule 1: deterministic wins the RECORD, always.
    //
    // MODEL-FIRST, as of 2026-08-11, and the reason is measured rather than
    // stylistic. Cross-checking the two readers found three live deterministic
    // defects in two days, every one of them shipping into geometry and none
    // caught by 690 tests or by the oracles:
    //
    //   INA226/PCM1808  a front-matter millimetre pair read as the body, when it
    //                   is the lead span in one document and width-first in the
    //                   other
    //   LP5907          a pinout scraped off an application circuit in the
    //                   LAYOUT section, pins named `VINCIN`, `GND`, `Enable`
    //   LTC2400         a neighbouring column glued into three pin names,
    //                   `+ 0.3V)GND`, `CSS8 PART MARKING`, `SCKLTC2400IS8`
    //
    // On every disagreement settled by hand the model was right and the code was
    // wrong. The oracles cover 37 parts; the defects live outside them.
    //
    // THE ONE THING PRECEDENCE DOES NOT CHANGE: a model value still has to be
    // CITED. An unverifiable claim does not beat a value read off the page by
    // code, because the whole product rests on a record whose every number can be
    // traced to a page. Model-first means the model wins among readings that can
    // both be checked, not that assertion beats evidence.
    const existing = fieldAt(merged, field);
    // A value already on the record is not the model's to overwrite. See above.
    if (alreadyAnswered(existing)) continue;

    // A pin table is coerced to the record contract and held to the same
    // gap-free 1..N proof the deterministic readers must pass. A table that
    // fails either is DROPPED, not stored uncited: unlike a scalar, a pin table
    // is what pads are built from, and the record is better off reporting the
    // gap the deterministic pass already found.
    let value = claimed.value;

    // A range field is validated before anything else looks at it. An
    // ill-formed pair is DROPPED rather than stored uncited, for the same
    // reason a bad pin table is: these two feed the land pattern directly.
    if ((RANGE_FIELDS as readonly string[]).includes(field)) {
      const range = asRange(value);
      if (!range) {
        rejected.push({ field, reason: "the value was not a positive min/max pair in millimetres" });
        continue;
      }
      value = range;
    }

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
      // Set before the citation checks below, because the pad is a fact about the
      // PACKAGE and stays true whether or not this particular table survives them.
      if (normalized.exposedPad) merged.exposedPad = true;
    }

    // Text first. A value quoted from the page is the strongest evidence
    // available and the only one a reviewer can check by searching.
    let citation = verifyCitation(doc, { ...claimed, value });
    let method: ExtractionMethod = "vlm";

    // Then the render, for any value on a page we actually sent.
    //
    // Pin tables were excluded here until 2026-08-06, and that exclusion was
    // wrong in a way worth recording. The reasoning was that a table is what
    // pads are built from, so it should not rest on weaker evidence. But the
    // evidence is not weaker: a citation reading "page 2, Pin connections (top
    // view)" points a reviewer at something they can SEE. A text-layer citation
    // points at a string that, on these documents, is not on the page at all.
    //
    // What the exclusion actually did was discard information rather than
    // verify it. Measured over the 13 pin failures in the tuned corpus, three
    // are pinouts drawn as vector artwork with no text layer whatsoever, so no
    // reader of any kind can ever cite them from text. LM139AQML-SP's pins were
    // read correctly off the render and thrown away for want of a citation the
    // document cannot supply. That is not a safety property, it is a permanent
    // hole.
    //
    // The shape guard is unchanged and still runs above: `verifyPinTable`
    // rejects a malformed or fabricated-looking table before this point, and a
    // render-cited table lands at confidence 0.4, the review tier.
    if (!citation && renderedPages.length > 0) {
      const drawn = citeRenderedPage(doc, { ...claimed, value }, renderedPages);
      if (drawn) {
        citation = drawn;
        method = "vlm-drawing";
      }
    }

    if (!citation) uncited.push(field);

    setFieldAt(merged, field, {
      value,
      // No calibrated confidence exists for a model answer. Evidence is the only
      // thing that separates these levels, and none of them claims to be a
      // probability: 0.5 for a value quoted from the page, 0.4 for one read off
      // a render we can show but cannot grep, null for one we could not place.
      confidence: citation ? (method === "vlm-drawing" ? 0.4 : 0.5) : null,
      method,
      citation
    });
    filled.push(field);

    // NOTHING IS DISPLACED HERE, so nothing is recorded as a conflict.
    //
    // This carried a paragraph describing a conflict record with a
    // `deterministic` side, a `model` side and a `holding` field. No such record
    // is written and none can be: `alreadyAnswered` above returns early for any
    // field that already has a value, so a model answer never overrules
    // anything, and the only values on the record at this point are the user's.
    // The paragraph was left behind when the cross-check module was deleted and
    // it told a reader that a review signal exists which does not. Deleted
    // rather than softened, per the rule this file already follows twice.
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
  // A THERMAL PAD THE VENDOR NUMBERED AS A PIN.
  //
  // `normalizeModelPins` recognises an exposed pad by its designator being
  // non-numeric (`EP`, `PAD`, `TAB`). Texas Instruments numbers it instead: a
  // PowerPAD SOIC-8 has a NINTH row called `9`. That row is numeric, so it was
  // kept as an ordinary signal pin on an eight-lead package, no land was ever
  // placed for it, and the output invariant refused the whole part with "the pin
  // table lists pin 9 and no land was placed for it".
  //
  // Found 2026-08-17 on TPS54360, promoted out of the hold-out for exactly this.
  // The thermal pad's SIZE had been read correctly (3.1 x 2.41 mm) and sat unused
  // on the record while the part refused, which is the same discard this file
  // already has three comments about.
  //
  // Three conditions, all required, because reclassifying a real signal pin as
  // copper under the body would be far worse than the refusal it replaces:
  //
  //   1. the pin table has EXACTLY one row more than the declared lead count,
  //      so the extra row is unambiguous rather than one of several
  //   2. that extra row is the LAST by number, where a vendor puts the pad
  //   3. the thermal pad's dimensions are on the record, which is the document
  //      stating that this package HAS an exposed pad
  //
  // Condition 3 is the load-bearing one. Without it this would fire on any part
  // whose lead count was misread by one.
  const padPins = merged.pins.value;
  const declaredLeads = merged.dimensions.leadCount.value;
  const padLength = merged.dimensions.thermalPadLengthMm.value;
  const padWidth = merged.dimensions.thermalPadWidthMm.value;
  if (
    !merged.exposedPad &&
    padPins !== null &&
    declaredLeads !== null &&
    padLength !== null &&
    padWidth !== null &&
    padPins.length === declaredLeads + 1
  ) {
    const last = padPins[padPins.length - 1];
    if (last !== undefined && Number(last.number) === padPins.length) {
      merged.exposedPad = true;
      merged.pins = { ...merged.pins, value: padPins.slice(0, -1) };
      // AND THE COUNT, which was left behind until 2026-08-18.
      //
      // A model that read the pad row as a pin usually counted it as one too, so
      // `pinCount` came back 9 on an eight-lead PowerPAD SOIC. The pads are
      // placed from `pinCount`, so removing the row from `pins` alone left the
      // record asking for NINE lead lands on an eight-lead package, and
      // `pins-match-count` reporting a table that disagrees with its own count.
      // Corrected only where the count actually included the row, so a record
      // that already said 8 is untouched.
      if (merged.pinCount.value === padPins.length) {
        merged.pinCount = { ...merged.pinCount, value: declaredLeads };
      }
      merged.notes.push(
        `Pin ${last.number} ("${last.name}") is the exposed thermal pad, not a lead: the package declares ` +
          `${declaredLeads} leads and the table has ${padPins.length} rows, and the document gives a ` +
          `${padLength} x ${padWidth} mm pad. It is built as a thermal land rather than a numbered lead.`
      );
    }
  }

  // What the model LOOKED FOR and did not find, as one line rather than one per
  // field. The distinction it preserves is the whole point: a field the document
  // is silent about is a different situation from a field nobody asked about,
  // and for months those were indistinguishable on this record. `leadForm` came
  // back null for 37 of 81 parts because the prompt offered two of the three
  // values it accepts, and there was no way to see that from here.
  //
  // Summarised, not enumerated per field, because the honest declines are
  // routine: a package with no exposed pad declines both thermal pad dimensions
  // every time, and a note each would bury the interesting ones.
  const declined = result.declined ?? [];
  if (declined.length > 0) {
    merged.notes = [
      ...merged.notes,
      `${modelName} looked for ${declined.length} field(s) and reported the document does not state them: ${declined.join(", ")}.`
    ];
  }

  for (const note of result.notes ?? []) merged.notes.push(`${modelName}: ${note}`);

  // A document that addresses the reader as an agent is reported, whether or not
  // the injection changed any value. Silence here would mean the one case where
  // the defence WORKED looks exactly like an ordinary parse, and a reviewer
  // signing this record deserves to know the source tried.
  const tampered = doc.pages
    .flatMap((page) => quarantinedRegions(page.text).map((region) => ({ page: page.page, region })))
    .slice(0, 3);
  if (tampered.length > 0) {
    merged.notes.push(
      `This document contains text addressed to an automated reader rather than describing the part, ` +
        `on ${tampered.length === 1 ? "page" : "pages"} ${[...new Set(tampered.map((entry) => entry.page))].join(", ")}: ` +
        `"${tampered[0].region.reason}". Those regions were excluded from evidence, so no value was read from them. ` +
        `Treat this datasheet as untrusted and check it by hand before sign-off.`
    );
  }

  // Kept on the record so a package chosen later selects a table that is already
  // in hand. This is the whole reason it is read in the first pass.
  //
  // EACH TABLE IS LOCATED ON A PAGE before it is stored, which is what makes it
  // usable rather than merely present.
  //
  // Measured 2026-08-16: twelve of the fifty-one hold-out parts with a reading
  // carry per-package tables and no single `pins` answer, and every one was
  // reported as "no pins, no count" and blocked before the package chooser ever
  // ran. The pinouts were on the record the whole time. They could not be used
  // because they arrived with no citation and `resolveForExport` refuses an
  // untraceable value, correctly: a pin table nobody can find in the document is
  // not evidence.
  //
  // The contract never asked the model for a page per table, and it does not
  // need to. A pin table either appears on a page of this document or it does
  // not, and `verifyPinTable` is the same check the main table already passes.
  // Searching for the page that holds it invents nothing: an entry that matches
  // no page stays uncited and stays refused.
  //
  // AND EACH ONE PASSES THE SAME PROOF THE MAIN TABLE DOES.
  //
  // These were stored raw until 2026-08-16, which put them past every check
  // `pins` has to satisfy. `coercePinRows` in the model layer even states that
  // the strict reader runs "when one of these is actually selected"; it does
  // not, because `asPackage` and `withPinTable` assign `table.pins` straight
  // into `pins`.
  //
  // Measured by building the footprint a gapped table produces: rows numbered
  // 1-7,9 exported with EIGHT pads, one of them numbered 8 which the document
  // never mentions, and SEVEN symbol pins. `validateGeometry` cannot see it,
  // because the pads run 1..pinCount exactly as it expects. That is the same
  // class as the twenty-pin table under a twenty-eight pin name, on the path
  // opened for twelve hold-out parts the day before.
  //
  // The pad flag is recorded PER TABLE rather than on the record, because an
  // exposed pad belongs to one package of a family and not to its siblings: an
  // SOIC and a QFN of the same part disagree about it, and a single flag has to
  // be wrong for one of them.
  if (result.pinTablesByPackage && result.pinTablesByPackage.length > 0) {
    const usable: NonNullable<PartRecord["pinTablesByPackage"]> = [];
    for (const table of result.pinTablesByPackage) {
      const normalized = normalizeModelPins(table.pins);
      if (!normalized.ok) {
        merged.notes.push(
          `${modelName} returned a ${table.packageType} pin table that was discarded, so that package stays ` +
            `honestly unread: ${normalized.reason}.`
        );
        continue;
      }
      if (!isGapFreeSequence(normalized.pins)) {
        merged.notes.push(
          `${modelName} returned a ${table.packageType} pin table whose rows do not number 1..` +
            `${normalized.pins.length} without gaps or repeats, so it was discarded rather than built from.`
        );
        continue;
      }
      usable.push({
        packageType: table.packageType,
        pins: normalized.pins,
        exposedPad: normalized.exposedPad,
        // Located on the NORMALISED rows, which is what a later package choice
        // actually puts on the record.
        citation: locatePinTable(doc, normalized.pins)
      });
    }
    if (usable.length > 0) merged.pinTablesByPackage = usable;
  }

  // Which packages the document actually DRAWS. Stored unfiltered: it is checked
  // against the caller's chosen package at footprint time, and narrowing it here
  // would only hide why a refusal happened.
  if (result.drawnPackages && result.drawnPackages.length > 0) {
    merged.drawnPackages = result.drawnPackages;
  }

  return { part: merged, filled, uncited, rejected };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { datasheetTextFromPages } from "../../pdftext";
import { buildPartRecord } from "../../datasheet";
import { mergeModelValues } from "../merge";
import type { ExtractionResult } from "../contracts";
import type { PinRecord } from "../../types";

/**
 * A per-package pin table is a pin table, and gets the same proof.
 *
 * ## The defect
 *
 * `pins` is put through `normalizeModelPins` and `isGapFreeSequence` before it
 * reaches the record: a row with no name, a non-numeric terminal, a gap or a
 * repeat either fails the table or is recorded as an exposed pad. Every one of
 * those checks exists because the shape it rejects produces a wrong footprint
 * rather than an absent one.
 *
 * `packagesInThisDocument` was stored raw. `coercePinRows` in the model layer even
 * says the strict reader runs "when one of these is actually selected", and it
 * does not: `asPackage` and `withPinTable` assign `table.pins` straight into
 * `pins`, past every check above.
 *
 * Measured on 2026-08-16 by building the footprint a gapped table produces: a
 * table numbered 1-7,9 exported with EIGHT pads (one of them numbered 8, which
 * the document never mentions) and SEVEN symbol pins. `validateGeometry` cannot
 * see it, because the pads run 1..pinCount exactly as it expects.
 *
 * This is the same class as the twenty-pin table under a twenty-eight pin name,
 * on the path that was opened for twelve hold-out parts a day earlier.
 */

const doc = datasheetTextFromPages([
  "ACME1256 Data Sheet\nAvailable as SSOP-20 and SSOP-28.",
  "Pin Functions, SSOP-20\nAIN0 AIN1 AIN2 AIN3 AIN4 AIN5 AIN6 AIN7 VREF AGND DGND DVDD CLKIN RESET DRDY CS SCLK DIN DOUT AVDD",
  "Thermal pad note: the exposed pad must be soldered to the board."
]);

const rows = (numbers: Array<number | string>): PinRecord[] =>
  numbers.map((number, index) => ({
    number: String(number),
    name: ["AIN0", "AIN1", "AIN2", "AIN3", "AIN4", "AIN5", "AIN6", "AIN7", "VREF", "AGND"][index % 10],
    electricalType: "unspecified" as const
  }));

function mergeWith(tables: ExtractionResult["packagesInThisDocument"]) {
  const record = buildPartRecord(doc, "ACME1256.pdf");
  return mergeModelValues(record, doc, { values: {}, packagesInThisDocument: tables }, "test-model");
}

test("a per-package table with a GAP in its numbering is refused, not stored", () => {
  // 1..7 then 9. Stored raw this becomes a nine-pin part reported as eight, and
  // the generator numbers pads 1..8 from the count.
  const { part } = mergeWith([{ packageType: "SSOP-20", pins: rows([1, 2, 3, 4, 5, 6, 7, 9]) }]);

  assert.equal(
    part.packagesInThisDocument?.length ?? 0,
    0,
    "a table that does not number 1..N without gaps is not a pinout"
  );
  assert.ok(
    part.notes.some((note) => /discarded|gaps|repeats/i.test(note)),
    "and the record says so, rather than the table vanishing silently"
  );
});

test("a per-package table with a REPEATED pin number is refused", () => {
  const { part } = mergeWith([{ packageType: "SSOP-20", pins: rows([1, 2, 3, 4, 5, 6, 7, 7]) }]);
  assert.equal(part.packagesInThisDocument?.length ?? 0, 0);
});

test("an exposed-pad row is recorded ON ITS OWN TABLE, not counted as a pin", () => {
  // `normalizeModelPins` drops the pad row from `pins` and flags it. Done for the
  // main table since 2026-08-10 and never for these, so a table carrying its `EP`
  // row inflated the pin count by one and the part was refused with a message
  // blaming the datasheet for describing a different package.
  const { part } = mergeWith([
    { packageType: "SSOP-20", pins: rows([1, 2, 3, 4, 5, 6, 7, 8, "EP"]) }
  ]);

  const table = part.packagesInThisDocument?.[0];
  assert.ok(table, "the table survives: a pad row is not a reason to throw a pinout away");
  assert.equal(table.pins?.length, 8, "eight pins, not nine");
  assert.ok(!table.pins?.some((pin) => pin.number === "EP"), "the pad is not a numbered pin");
  assert.equal(table.exposedPad, true, "and the pad is recorded against THIS package");
});

test("the exposed pad is per package, so a sibling without one is not given it", () => {
  const { part } = mergeWith([
    { packageType: "SSOP-20", pins: rows([1, 2, 3, 4, 5, 6, 7, 8, "EP"]) },
    { packageType: "SSOP-28", pins: rows([1, 2, 3, 4, 5, 6, 7, 8]) }
  ]);

  const withPad = part.packagesInThisDocument?.find((table) => table.packageType === "SSOP-20");
  const without = part.packagesInThisDocument?.find((table) => table.packageType === "SSOP-28");
  assert.equal(withPad?.exposedPad, true);
  assert.equal(without?.exposedPad, false, "a pad on one package is not a pad on its sibling");
});

test("a well-formed table is still stored and still located on its page", () => {
  // The control. A fix that refuses everything would pass every test above.
  const { part } = mergeWith([{ packageType: "SSOP-20", pins: rows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) }]);
  const table = part.packagesInThisDocument?.[0];
  assert.ok(table, "a good table survives");
  assert.equal(table.pins?.length, 10);
  assert.ok(table.citation, "and keeps the page the merge located it on");
});

// ---------------------------------------------------------------------------
// The other half of a package: its own measurements
// ---------------------------------------------------------------------------

/**
 * A body length, a pitch, a lead span and a printed footprint belong to ONE
 * package, exactly as a pin table does.
 *
 * ## The measurement behind this
 *
 * The pinout was asked per package and everything else was asked once. On a
 * document whose part number does not name a package that question has no
 * answer, and the model said so: measured over the hold-out on 2026-08-18, 27 of
 * 57 parts returned NOT ONE dimension from either pass, with the model's own
 * notes explaining that the part number does not specify a package designator.
 * The 29 that did read say the same thing from the other side: "Selected the
 * 16-pin VQFN (RGT) package option."
 *
 * Half the corpus lost its entire mechanical read to the shape of the question.
 * Every one of those documents prints the drawings.
 *
 * These tests are about the three properties the answer has to have: it is
 * stored, it is held to the same evidence rule as everything else, and it stays
 * attached to the package it was read for.
 */

const dimensionDoc = datasheetTextFromPages([
  "ACME1256 Data Sheet\nAvailable as SSOP-20 and SSOP-28.",
  "PACKAGE OUTLINE SSOP-20\nBody length D 7.20 mm  Pitch e 0.65 mm",
  "PACKAGE OUTLINE SSOP-28\nBody length D 10.20 mm  Pitch e 0.65 mm"
]);

function mergeDimensions(tables: ExtractionResult["packagesInThisDocument"]) {
  const record = buildPartRecord(dimensionDoc, "ACME1256.pdf");
  return mergeModelValues(record, dimensionDoc, { values: {}, packagesInThisDocument: tables }, "test-model");
}

test("a package's own measurements are stored against that package", () => {
  const { part } = mergeDimensions([
    { packageType: "SSOP-20", dimensions: { "dimensions.bodyLengthMm": { value: 7.2, page: 2 } } },
    { packageType: "SSOP-28", dimensions: { "dimensions.bodyLengthMm": { value: 10.2, page: 3 } } }
  ]);

  const twenty = part.packagesInThisDocument?.find((entry) => entry.packageType === "SSOP-20");
  const twentyEight = part.packagesInThisDocument?.find((entry) => entry.packageType === "SSOP-28");
  assert.equal(twenty?.dimensions?.bodyLengthMm?.value, 7.2);
  assert.equal(twentyEight?.dimensions?.bodyLengthMm?.value, 10.2, "and the two do not blur together");
  assert.ok(twenty?.dimensions?.bodyLengthMm?.citation, "located on the page it was read from");
});

test("an entry carrying only measurements survives, because a document draws packages it does not tabulate", () => {
  // The parser used to require rows. A datasheet that prints one pin table and
  // an outline drawing per package is the ordinary case, and every measurement
  // in it was discarded for want of pins nobody asked that entry for.
  const { part } = mergeDimensions([
    { packageType: "SSOP-28", dimensions: { "dimensions.pitchMm": { value: 0.65, page: 3 } } }
  ]);

  assert.equal(part.packagesInThisDocument?.length, 1);
  assert.equal(part.packagesInThisDocument?.[0].pins, undefined, "no rows were claimed and none are invented");
  assert.equal(part.packagesInThisDocument?.[0].dimensions?.pitchMm?.value, 0.65);
});

test("a per-package measurement gets no easier a ride than a flat one", () => {
  // Same three rules the flat block applies, in the same order. These place
  // copper, and arriving by a different route is not a reason to trust them.
  const { part } = mergeDimensions([
    {
      packageType: "SSOP-20",
      dimensions: {
        // Nowhere in the document: stored, but uncited, so `resolveForExport`
        // refuses it downstream exactly as it refuses an uncited flat value.
        "dimensions.bodyWidthMm": { value: 999.5, page: 2 },
        // A range field answered with a bare number is not a range.
        "dimensions.leadSpanMm": { value: 7.4, page: 2 },
        // Not a field at all.
        "dimensions.notAField": { value: 1, page: 2 }
      }
    }
  ]);

  const entry = part.packagesInThisDocument?.[0];
  assert.equal(entry?.dimensions?.bodyWidthMm?.citation, null, "a value nobody can place carries no citation");
  assert.equal(entry?.dimensions?.leadSpanMm, undefined, "a malformed range is dropped, not coerced");
  assert.ok(
    !Object.keys(entry?.dimensions ?? {}).includes("notAField"),
    "a name the contract does not define cannot be written onto the record"
  );
});

test("a package with an unusable pin table keeps the measurements read off its drawing", () => {
  // The two halves are judged separately. A table that fails the numbering proof
  // says nothing about the outline drawing on another page, and discarding the
  // entry whole would throw away a reading that was never in question.
  const { part } = mergeDimensions([
    {
      packageType: "SSOP-20",
      pins: rows([1, 2, 3, 4, 5, 6, 7, 9]),
      dimensions: { "dimensions.pitchMm": { value: 0.65, page: 2 } }
    }
  ]);

  const entry = part.packagesInThisDocument?.[0];
  assert.ok(entry, "the entry survives on the strength of the half that passed");
  assert.equal(entry.pins, undefined, "the gapped table is still refused");
  assert.equal(entry.dimensions?.pitchMm?.value, 0.65, "and the drawing is still read");
});

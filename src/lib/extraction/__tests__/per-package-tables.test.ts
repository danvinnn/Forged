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
 * `pinTablesByPackage` was stored raw. `coercePinRows` in the model layer even
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

function mergeWith(tables: ExtractionResult["pinTablesByPackage"]) {
  const record = buildPartRecord(doc, "ACME1256.pdf");
  return mergeModelValues(record, doc, { values: {}, pinTablesByPackage: tables }, "test-model");
}

test("a per-package table with a GAP in its numbering is refused, not stored", () => {
  // 1..7 then 9. Stored raw this becomes a nine-pin part reported as eight, and
  // the generator numbers pads 1..8 from the count.
  const { part } = mergeWith([{ packageType: "SSOP-20", pins: rows([1, 2, 3, 4, 5, 6, 7, 9]) }]);

  assert.equal(
    part.pinTablesByPackage?.length ?? 0,
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
  assert.equal(part.pinTablesByPackage?.length ?? 0, 0);
});

test("an exposed-pad row is recorded ON ITS OWN TABLE, not counted as a pin", () => {
  // `normalizeModelPins` drops the pad row from `pins` and flags it. Done for the
  // main table since 2026-08-10 and never for these, so a table carrying its `EP`
  // row inflated the pin count by one and the part was refused with a message
  // blaming the datasheet for describing a different package.
  const { part } = mergeWith([
    { packageType: "SSOP-20", pins: rows([1, 2, 3, 4, 5, 6, 7, 8, "EP"]) }
  ]);

  const table = part.pinTablesByPackage?.[0];
  assert.ok(table, "the table survives: a pad row is not a reason to throw a pinout away");
  assert.equal(table.pins.length, 8, "eight pins, not nine");
  assert.ok(!table.pins.some((pin) => pin.number === "EP"), "the pad is not a numbered pin");
  assert.equal(table.exposedPad, true, "and the pad is recorded against THIS package");
});

test("the exposed pad is per package, so a sibling without one is not given it", () => {
  const { part } = mergeWith([
    { packageType: "SSOP-20", pins: rows([1, 2, 3, 4, 5, 6, 7, 8, "EP"]) },
    { packageType: "SSOP-28", pins: rows([1, 2, 3, 4, 5, 6, 7, 8]) }
  ]);

  const withPad = part.pinTablesByPackage?.find((table) => table.packageType === "SSOP-20");
  const without = part.pinTablesByPackage?.find((table) => table.packageType === "SSOP-28");
  assert.equal(withPad?.exposedPad, true);
  assert.equal(without?.exposedPad, false, "a pad on one package is not a pad on its sibling");
});

test("a well-formed table is still stored and still located on its page", () => {
  // The control. A fix that refuses everything would pass every test above.
  const { part } = mergeWith([{ packageType: "SSOP-20", pins: rows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) }]);
  const table = part.pinTablesByPackage?.[0];
  assert.ok(table, "a good table survives");
  assert.equal(table.pins.length, 10);
  assert.ok(table.citation, "and keeps the page the merge located it on");
});

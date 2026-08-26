import { test } from "node:test";
import assert from "node:assert/strict";
import { datasheetTextFromPages } from "../../pdftext";
import { buildPartRecord } from "../../datasheet";
import { mergeModelValues } from "../merge";
import type { ExtractionResult } from "../contracts";

/**
 * A row that is not a numbered pin must not destroy the numbered pins.
 *
 * Reported 2026-08-25 as "why is the read refusing?". An LMP7704-SP came back
 * with all fourteen pins correct, `1:OUT A` through `14:OUT D`, and ALSO with
 * two rows describing the package's thermal pad and its metal lid, both carrying
 * `number: null`. Fourteen hand-checkable pins were thrown away because the
 * model had additionally described a feature that is not a pin.
 *
 * The branch that rescues a pad row whose number is the STRING "PAD" was added
 * on 2026-08-10, and its own comment records that refusing the whole table cost
 * three parts outright. It never reached the row whose number is `null`, because
 * the fatal return sits one line above it. The same bug, in the same function,
 * for the other spelling of "no number".
 */

const doc = datasheetTextFromPages(["A part in a 14-pin ceramic flat pack.", "Pin Functions"]);

function pinsFrom(rows: Array<Record<string, unknown>>) {
  const result = { values: { pins: { value: rows, page: 2 } } } as unknown as ExtractionResult;
  return mergeModelValues(buildPartRecord(doc, "test.pdf"), doc, result, "test-model");
}

test("the thermal pad row that killed a fourteen pin table is skipped, not fatal", () => {
  const rows = [
    ...Array.from({ length: 14 }, (_, index) => ({
      number: String(index + 1),
      name: `P${index + 1}`,
      electricalType: null
    })),
    { number: null, name: "PAD", description: "Backside thermal pad." },
    { number: null, name: "LID", description: "Metal lid of the ceramic flat pack." }
  ];
  const outcome = pinsFrom(rows);
  const pins = outcome.part.pins.value ?? [];
  assert.equal(pins.length, 14, "every numbered pin survives");
  assert.deepEqual(
    pins.map((pin) => pin.number),
    Array.from({ length: 14 }, (_, index) => String(index + 1))
  );
  assert.equal(outcome.part.exposedPad, true, "and the pad it named is recorded");
});

test("a pad row is recorded as a pad and a lid is not", () => {
  // `LID` is the metal lid of a ceramic package. It is not a thermal pad and
  // recording it as one would invent a mandatory copper feature.
  const base = Array.from({ length: 8 }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: null
  }));
  assert.equal(pinsFrom([...base, { number: null, name: "LID" }]).part.exposedPad, false);
  assert.equal(pinsFrom([...base, { number: null, name: "EPAD" }]).part.exposedPad, true);
  assert.equal(pinsFrom([...base, { number: null, name: "Exposed Thermal Pad" }]).part.exposedPad, true);
});

test("a REAL pin that lost its number still refuses the table", () => {
  // This is what makes skipping safe. A pin dropped from anywhere but the end
  // breaks the 1..N sequence, and the whole table is refused rather than a
  // short one being handed back as complete.
  const rows = [
    { number: "1", name: "A" },
    { number: null, name: "VCC" },
    { number: "3", name: "C" },
    { number: "4", name: "D" }
  ];
  assert.equal(pinsFrom(rows).part.pins.value, null, "a gap is still fatal");
});

test("a pin name is never mistaken for a pad", () => {
  const base = [{ number: "1", name: "A" }, { number: "2", name: "B" }];
  for (const name of ["PADDR0", "KEYPAD", "EPROM", "TABLE"]) {
    assert.equal(
      pinsFrom([...base, { number: null, name }]).part.exposedPad,
      false,
      `${name} is not the exposed pad`
    );
  }
});

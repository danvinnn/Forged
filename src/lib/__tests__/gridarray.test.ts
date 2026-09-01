import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFootprintGeometry, FootprintUnavailableError } from "../exporters";
import { geometryViolations, validateGeometry } from "../confidence";
import { gridRowIndex } from "../geometry";
import type { ResolvedPart } from "../types";

/**
 * BALL-, LAND- AND COLUMN-GRID ARRAYS.
 *
 * The fourth arrangement. `assemble` places lands in rows along the sides of a
 * package and everything in it follows from that; a grid has no sides, no
 * opposing rows and no centre span, so it is built separately for the same
 * reason a plated hole is.
 *
 * The grid itself costs nothing to know: the designators state it. `A1` through
 * `C4` is three rows of four, and because the row letters are POSITIONAL a
 * depopulated grid keeps its gaps rather than closing them.
 */

const dims = (over: Record<string, unknown> = {}) =>
  ({
    bodyLengthMm: 3,
    bodyWidthMm: 3,
    bodyHeightMm: 0.6,
    pitchMm: 0.5,
    leadLengthMm: null,
    leadCount: null,
    leadWidthMm: null,
    leadSpanMm: null,
    leadSpanCrossMm: null,
    leadContactMm: null,
    thermalPadLengthMm: null,
    thermalPadWidthMm: null,
    landPadLengthMm: 0.28,
    landPadWidthMm: 0.28,
    landSpanMm: null,
    landSpanCrossMm: null,
    leadSides: null,
    leadForm: null,
    mounting: "smd",
    leadDiameterMm: null,
    vacantLeadSlot: null,
    leadsPerSide: null,
    solderMaskExpansionMm: null,
    solderMaskDefined: null,
    thermalViaDiameterMm: null,
    thermalViaPitchMm: null,
    ...over
  }) as ResolvedPart["dimensions"];

function part(numbers: string[], over: Record<string, unknown> = {}): ResolvedPart {
  return {
    id: "t",
    partNumber: "ACME-BGA",
    manufacturer: "ACME",
    packageType: "DSBGA",
    packageOutlineCode: null,
    jedecOutline: null,
    vendorLandPattern: { page: 12, valuesMm: [] },
    pinCount: numbers.length,
    pins: numbers.map((number) => ({ number, name: `N${number}`, electricalType: "passive" as const })),
    exposedPad: false,
    notes: [],
    ...over,
    // AFTER the spread, so a test overriding one dimension keeps the rest.
    dimensions: dims(over.dimensions as Record<string, unknown> | undefined)
  } as unknown as ResolvedPart;
}

const NINE = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"];

test("a grid array places one land per terminal, on the pitch", () => {
  const geometry = buildFootprintGeometry(part(NINE), "B");

  assert.equal(geometry.pads.length, 9);
  assert.equal(geometry.provenance.arrangement, "grid");
  assert.deepEqual(
    geometry.pads.map((pad) => pad.number).sort(),
    [...NINE].sort(),
    "the lands are named as the datasheet names the terminals"
  );
  for (const pad of geometry.pads) {
    assert.equal(pad.shape, "circle", "a ball lands on a round pad");
    assert.equal(pad.mounting, "smd");
  }
  // Three columns at 0.5 mm, centred: -0.5, 0, +0.5.
  assert.deepEqual([...new Set(geometry.pads.map((pad) => pad.centre.xMm))].sort((a, b) => a - b), [-0.5, 0, 0.5]);
  assert.deepEqual([...new Set(geometry.pads.map((pad) => pad.centre.yMm))].sort((a, b) => a - b), [-0.5, 0, 0.5]);
});

test("A1 is the top-left ball, which is the only thing that says which way round it goes", () => {
  // Every land is hidden under the body once placed and the package is square,
  // so it can be fitted four ways that look identical on the board.
  const geometry = buildFootprintGeometry(part(NINE), "B");
  const a1 = geometry.pads.find((pad) => pad.number === "A1")!;
  const c3 = geometry.pads.find((pad) => pad.number === "C3")!;

  // `+y` is DOWN in this file's footprint convention, so the top is negative.
  assert.ok(a1.centre.xMm < 0 && a1.centre.yMm < 0, "A1 sits top-left");
  assert.ok(c3.centre.xMm > 0 && c3.centre.yMm > 0, "and the far corner is bottom-right");
  assert.ok(geometry.pin1Marker.xMm < 0 && geometry.pin1Marker.yMm < 0, "the marker is at the A1 corner");
});

test("a DEPOPULATED grid keeps its gaps rather than closing them", () => {
  // A BGA routinely leaves balls out of the middle. Ordering the rows a part
  // happens to have would compress the grid and put every ball after the gap a
  // pitch out of place.
  const geometry = buildFootprintGeometry(part(["A1", "A3", "C1", "C3"]), "B");
  assert.equal(geometry.pads.length, 4);
  assert.deepEqual(
    [...new Set(geometry.pads.map((pad) => pad.centre.xMm))].sort((a, b) => a - b),
    [-0.5, 0.5],
    "columns 1 and 3 stay one pitch either side of the empty column 2"
  );
});

test("the JEDEC alphabet is positional, and it skips the ambiguous letters", () => {
  // I reads as 1, O as 0, Q as O, S as 5, X as a cross-hair, Z as 2.
  assert.equal(gridRowIndex("A"), 0);
  assert.equal(gridRowIndex("H"), 7);
  assert.equal(gridRowIndex("J"), 8, "J follows H; there is no row I");
  assert.equal(gridRowIndex("Y"), 19);
  assert.equal(gridRowIndex("AA"), 20, "two-letter rows continue past Y");
  for (const letter of ["I", "O", "Q", "S", "X", "Z"]) {
    assert.equal(gridRowIndex(letter), null, `${letter} is not a row letter`);
  }
});

test("a row letter outside the alphabet is refused, not placed", () => {
  // A ball a pitch out of position is a board that looks correct and does not
  // work, so a designator this cannot place must not be placed at all.
  assert.throws(
    () => buildFootprintGeometry(part(["A1", "A2", "I1", "I2"]), "B"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.match(error.reason, /I1/);
      assert.match(error.reason, /JEDEC/);
      return true;
    }
  );
});

test("no land diameter means one question, not a refusal", () => {
  // IPC-7351B's ball-grid land rules are not transcribed here, so there is no
  // computed alternative and deriving one from a remembered ratio is the
  // reverse-engineered rule this project retired for no-lead packages.
  assert.throws(
    () => buildFootprintGeometry(part(NINE, { dimensions: { landPadLengthMm: null, landPadWidthMm: null } }), "B"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.equal(error.needs.length, 1);
      assert.equal(error.needs[0].field, "landPadLengthMm");
      assert.equal(error.needs[0].page, 12, "and it points at the page that prints it");
      return true;
    }
  );
});

test("the output invariant runs on a grid and passes a correct one", () => {
  const geometry = buildFootprintGeometry(part(NINE), "B");
  assert.deepEqual(geometryViolations(geometry, part(NINE)), []);
  validateGeometry(geometry, part(NINE));
});

test("and it still catches a land for a terminal the part does not have", () => {
  // Proved by adding one, because a check that cannot fail is not a check.
  const geometry = buildFootprintGeometry(part(NINE), "B");
  geometry.pads.push({ ...geometry.pads[0], number: "D9", centre: { xMm: 4, yMm: 4 } });
  const problems = geometryViolations(geometry, part(NINE));
  // Two findings, and both are true: the land belongs to no terminal, and it
  // reaches outside the courtyard. Asserted by content rather than by count, so
  // the test does not go red the day a third correct finding is added.
  assert.ok(problems.some((problem) => /"D9" belongs to no pin/.test(problem)), problems.join(" | "));
});

test("a grid land that overlaps its neighbour is refused", () => {
  // The pitch and the land diameter come from different readings, so a misread
  // decimal point puts copper through copper.
  const tooBig = part(NINE, { dimensions: { landPadLengthMm: 0.6, landPadWidthMm: 0.6 } });
  const geometry = buildFootprintGeometry(tooBig, "B");
  assert.ok(
    geometryViolations(geometry, tooBig).some((problem) => /overlap/i.test(problem)),
    "0.6 mm lands on a 0.5 mm pitch touch"
  );
});

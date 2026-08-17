import { test } from "node:test";
import assert from "node:assert/strict";
import { geometryViolations, validateGeometry, FootprintInvalidError } from "../confidence";
import type { FootprintGeometry, Pad } from "../geometry";
import type { PinRecord, ResolvedPart } from "../types";

/**
 * Every invariant here has to be able to FAIL, on a footprint this generator
 * could really produce. That is the same bar `confidence.test.ts` sets, and it
 * matters more here: these are a GATE, so one that cannot fire is a gate that is
 * always open while looking shut.
 *
 * The footprints below are built by hand rather than generated, deliberately.
 * The point is to drive each violation, and a generator working correctly will
 * not produce any of them.
 */

function pins(count: number): PinRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: "passive" as const
  }));
}

function part(count = 4, over: Partial<ResolvedPart> = {}): ResolvedPart {
  return {
    id: "g",
    partNumber: "ACME",
    manufacturer: "ACME",
    packageType: "SOIC-4",
    packageOutlineCode: null,
    jedecOutline: null,
    vendorLandPattern: null,
    exposedPad: false,
    pinCount: count,
    pins: pins(count),
    dimensions: {} as ResolvedPart["dimensions"],
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: "g.pdf",
    notes: [],
    ...over
  } as ResolvedPart;
}

function land(number: string, xMm: number, yMm: number, over: Partial<Pad> = {}): Pad {
  return {
    number,
    centre: { xMm, yMm },
    widthMm: 1,
    heightMm: 0.5,
    shape: "roundrect",
    mounting: "smd",
    ...over
  } as Pad;
}

/** Four lands in two rows, well clear of each other and inside the courtyard. */
function sound(over: Partial<FootprintGeometry> = {}): FootprintGeometry {
  return {
    name: "acme-soic-4",
    description: "fixture",
    partNumber: "ACME",
    pads: [land("1", -2, -1), land("2", -2, 1), land("3", 2, 1), land("4", 2, -1)],
    body: { halfWidthMm: 1.5, halfHeightMm: 2 },
    courtyard: { halfWidthMm: 3, halfHeightMm: 2.5 },
    pin1Marker: { xMm: -2.6, yMm: -1 },
    thermalVias: [],
    provenance: {} as FootprintGeometry["provenance"],
    ...over
  };
}

test("a sound footprint reports nothing, so the failures below mean something", () => {
  assert.deepEqual(geometryViolations(sound(), part()), []);
});

test("a land for a pin the part does not have is caught", () => {
  const geometry = sound({ pads: [...sound().pads, land("9", 0, 0)] });
  assert.match(geometryViolations(geometry, part()).join("\n"), /land "9" belongs to no pin/);
});

test("a pin with no land is caught, which is a connection that silently does not exist", () => {
  const geometry = sound({ pads: sound().pads.slice(0, 3) });
  assert.match(geometryViolations(geometry, part()).join("\n"), /pin 4 has 0 lands/);
});

test("two lands that overlap are caught, because that is a short", () => {
  // The property a wrong pitch, a wrong span and a wrong side-count all produce.
  const geometry = sound({ pads: [land("1", 0, 0), land("2", 0.2, 0), land("3", 2, 1), land("4", 2, -1)] });
  assert.match(geometryViolations(geometry, part()).join("\n"), /lands 1 and 2 overlap/);
});

test("a courtyard that does not contain its own lands is caught", () => {
  // Worse than no courtyard: the board designer trusts it as the keep-out and
  // places the neighbouring part on top of a pad.
  const geometry = sound({ courtyard: { halfWidthMm: 1, halfHeightMm: 1 } });
  assert.match(geometryViolations(geometry, part()).join("\n"), /reaches outside the courtyard/);
});

test("paste that reaches past its own copper is caught", () => {
  const geometry = sound({
    pads: [
      land("1", -2, -1, { pasteApertures: [{ centre: { xMm: 0.9, yMm: 0 }, widthMm: 0.8, heightMm: 0.3 }] }),
      land("2", -2, 1),
      land("3", 2, 1),
      land("4", 2, -1)
    ]
  });
  assert.match(geometryViolations(geometry, part()).join("\n"), /paste aperture on land 1 reaches past/);
});

test("a plated hole carrying paste is caught", () => {
  const geometry = sound({
    pads: [
      land("1", -2, -1, {
        mounting: "through-hole",
        drillMm: 0.8,
        pasteApertures: [{ centre: { xMm: 0, yMm: 0 }, widthMm: 0.2, heightMm: 0.2 }]
      }),
      land("2", -2, 1),
      land("3", 2, 1),
      land("4", 2, -1)
    ]
  });
  assert.match(geometryViolations(geometry, part()).join("\n"), /plated hole 1 carries paste/);
});

test("a pin-1 marker nearer another land is caught, because a rotated part is a wrong part", () => {
  const geometry = sound({ pin1Marker: { xMm: 2.6, yMm: 1 } });
  assert.match(geometryViolations(geometry, part()).join("\n"), /pin-1 marker sits closer to another land/);
});

test("a hole with no drill size is caught", () => {
  const geometry = sound({
    pads: [land("1", -2, -1, { mounting: "through-hole" }), land("2", -2, 1), land("3", 2, 1), land("4", 2, -1)]
  });
  assert.match(geometryViolations(geometry, part()).join("\n"), /plated hole 1 has no drill size/);
});

test("a non-finite dimension is caught, because KiCad will not open the file", () => {
  const geometry = sound({ pads: [land("1", Number.NaN, -1), land("2", -2, 1), land("3", 2, 1), land("4", 2, -1)] });
  assert.match(geometryViolations(geometry, part()).join("\n"), /non-finite x/);
});

test("validateGeometry throws, and names every violation rather than the first", () => {
  const geometry = sound({ pads: [land("1", 0, 0), land("2", 0.2, 0)] });
  assert.throws(
    () => validateGeometry(geometry, part()),
    (error: unknown) => {
      assert.ok(error instanceof FootprintInvalidError);
      assert.ok(error.violations.length > 1, "a reviewer gets the whole list, not the first line");
      assert.match(
        error.message,
        /misread or this is a defect in Forge/,
        "and it does not assert which of the two, because the geometry cannot tell"
      );
      return true;
    }
  );
});

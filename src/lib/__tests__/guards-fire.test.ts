import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFootprintGeometry } from "../exporters";
import type { ResolvedPart } from "../types";

// PROOF THAT EACH GUARD CAN STILL FIRE.
//
// `bench:guards` reports zero firings for all seven plausibility guards across
// three corpora, and has done for as long as it has existed. That reads as dead
// code, and on 2026-08-21 it nearly got three of them deleted.
//
// They are not dead. Probed with deliberately absurd records, every one of them
// refuses. Zero firings is a statement about the DATA - no printed footprint in
// the corpus is bad enough to trip them - and not about the code.
//
// But a guard that never fires on real input is exactly the guard a refactor can
// disable without anyone noticing, because no bench number moves. So each one
// gets a test that trips it on purpose. That is the only thing standing between
// "no corpus part violates this" and "this check silently stopped working".

function soic8(): ResolvedPart {
  return {
    id: "guard", partNumber: "ACME555", manufacturer: "Test", packageType: "SOIC-8",
    packageOutlineCode: null, jedecOutline: null, vendorLandPattern: null, exposedPad: false,
    pinCount: 8,
    pins: Array.from({ length: 8 }, (_, index) => ({
      number: String(index + 1), name: `P${index + 1}`, electricalType: "unspecified" as const
    })),
    dimensions: {
      bodyLengthMm: 4.9, bodyWidthMm: 3.9, bodyHeightMm: 1.5, pitchMm: 1.27,
      leadLengthMm: 0.6, leadCount: 8,
      leadWidthMm: { minMm: 0.31, maxMm: 0.51 },
      leadSpanMm: { minMm: 5.8, maxMm: 6.2 },
      leadSpanCrossMm: null,
      leadContactMm: { minMm: 0.4, maxMm: 0.625 },
      thermalPadLengthMm: null, thermalPadWidthMm: null,
      landPadLengthMm: null, landPadWidthMm: null, landSpanMm: null, landSpanCrossMm: null,
      leadSides: 2, leadForm: "gullwing", mounting: null, leadDiameterMm: null,
      vacantLeadSlot: null, leadsPerSide: null, solderMaskExpansionMm: null,
      solderMaskDefined: null, thermalViaDiameterMm: null, thermalViaPitchMm: null
    },
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: "test.pdf", notes: []
  };
}

/** A printed pattern that survived is used; one that was refused falls back to IPC. */
function usedThePrintedPattern(part: ResolvedPart): boolean {
  return /printed|recommended/i.test(buildFootprintGeometry(part, "B").provenance.source);
}

test("a good printed pattern IS used, so the tests below mean something", () => {
  const part = soic8();
  part.dimensions.landPadLengthMm = 1.5;
  part.dimensions.landPadWidthMm = 0.6;
  part.dimensions.landSpanMm = 5.4;
  assert.ok(usedThePrintedPattern(part), "a plausible printed land must be taken as printed");
});

test("guard: a land wider than the pitch is refused", () => {
  const part = soic8();
  part.dimensions.landPadLengthMm = 1.5;
  part.dimensions.landPadWidthMm = 1.4; // wider than the 1.27 pitch: it would merge with its neighbour
  part.dimensions.landSpanMm = 5.4;
  assert.ok(!usedThePrintedPattern(part), "a land wider than the pitch must not place copper");
});

test("guard: a printed pattern outside the IPC band is refused", () => {
  const part = soic8();
  part.dimensions.landPadLengthMm = 1.5;
  part.dimensions.landPadWidthMm = 0.6;
  part.dimensions.landSpanMm = 22; // a 6 mm package cannot have a 22 mm centre span
  assert.ok(!usedThePrintedPattern(part), "a span the leads cannot reach must not place copper");
});

test("guard: opposing rows that pass through each other are refused", () => {
  const part = soic8();
  part.dimensions.landPadLengthMm = 4.0;
  part.dimensions.landPadWidthMm = 0.6;
  part.dimensions.landSpanMm = 1.0; // lands longer than the gap between the rows
  assert.ok(!usedThePrintedPattern(part), "overlapping rows must not place copper");
});

test("guard: a lead too wide for its pitch is refused", () => {
  const part = soic8();
  part.dimensions.leadWidthMm = { minMm: 1.1, maxMm: 1.2 }; // on a 1.27 pitch
  assert.throws(() => buildFootprintGeometry(part, "B"), /no gap to its neighbour|lead dimensions were rejected/i);
});

test("guard: a package name contradicting the pin count is refused", () => {
  const part = soic8();
  part.packageType = "SOIC-16"; // sixteen leads, eight rows read
  assert.throws(() => buildFootprintGeometry(part, "B"), /different packages/i);
});

test("guard: lead dimensions that cannot form a land are refused", () => {
  const part = soic8();
  part.dimensions.leadContactMm = { minMm: 4.0, maxMm: 4.5 }; // feet longer than the span allows
  assert.throws(() => buildFootprintGeometry(part, "B"), /could not be computed|no body between opposing feet/i);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { geometryViolations, symbolViolations } from "../confidence";
import type { FootprintGeometry, SymbolGeometry } from "../geometry";
import type { ResolvedPart } from "../types";

/**
 * THE OUTPUT INVARIANTS THE CORPUS CANNOT EXERCISE.
 *
 * `bench:outputs` breaks every value that reaches an emitted file and asks
 * whether the export gate objects. It found two holes on 2026-08-30 - a
 * silkscreen body outside its own courtyard, and a symbol pin with no length -
 * and it could not test a third, because no through-hole footprint in the whole
 * replay corpus builds and validates. 86 of 86 are surface mount, so stripping
 * the drill off a plated hole changed nothing and the bench reported a hole for
 * a mutation that had done nothing at all.
 *
 * A corpus with none of a case is not evidence the case works. These are the
 * fixtures for the parts the corpus cannot supply, plus the two checks the bench
 * found missing, so both stay proven when the corpus changes.
 */

const part = {
  partNumber: "FIXTURE",
  pinCount: 2,
  pins: [
    { number: "1", name: "A", electricalType: "passive" as const },
    { number: "2", name: "B", electricalType: "passive" as const }
  ],
  exposedPad: false,
  dimensions: { leadSides: 2 }
} as unknown as ResolvedPart;

function footprint(overrides: Partial<FootprintGeometry> = {}): FootprintGeometry {
  return {
    name: "FIXTURE",
    description: "",
    partNumber: "FIXTURE",
    pads: [
      { number: "1", centre: { xMm: -2, yMm: 0 }, widthMm: 1, heightMm: 1, shape: "circle", mounting: "through-hole", drillMm: 0.9 },
      { number: "2", centre: { xMm: 2, yMm: 0 }, widthMm: 1, heightMm: 1, shape: "circle", mounting: "through-hole", drillMm: 0.9 }
    ],
    body: { halfWidthMm: 1.5, halfHeightMm: 1 },
    courtyard: { halfWidthMm: 3, halfHeightMm: 2 },
    pin1Marker: { xMm: -2, yMm: -1.2 },
    thermalVias: [],
    provenance: { source: "fixture", family: "fixture" },
    ...overrides
  } as unknown as FootprintGeometry;
}

function symbol(overrides: Partial<SymbolGeometry> = {}): SymbolGeometry {
  return {
    name: "FIXTURE",
    partNumber: "FIXTURE",
    body: { halfWidthMm: 5, halfHeightMm: 5 },
    bodyCentreYMm: 0,
    pins: [
      { number: "1", name: "A", anchor: { xMm: -10.16, yMm: 2.54 }, side: "left", lengthMm: 2.54, electricalType: "passive" },
      { number: "2", name: "B", anchor: { xMm: -10.16, yMm: 0 }, side: "left", lengthMm: 2.54, electricalType: "passive" }
    ],
    ...overrides
  } as unknown as SymbolGeometry;
}

test("the fixtures pass as built, or nothing below means anything", () => {
  assert.deepEqual(geometryViolations(footprint(), part), []);
  assert.deepEqual(symbolViolations(symbol(), part), []);
});

test("a plated hole with no drill is refused", () => {
  // A hole of zero is not a hole. Altium's emitter says so and throws; this is
  // the check on the path both formats share. Untestable from the corpus: no
  // through-hole footprint in it builds.
  const broken = footprint({
    pads: footprint().pads.map((pad, index) => (index === 0 ? { ...pad, drillMm: undefined } : pad))
  });
  const problems = geometryViolations(broken, part);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /drill/i);
});

test("a package body that reaches outside its own courtyard is refused", () => {
  // IPC-7351B: the courtyard is the maximum extent of the land pattern AND the
  // component body. Only the lands were checked until 2026-08-30.
  const problems = geometryViolations(footprint({ body: { halfWidthMm: 9, halfHeightMm: 1 } }), part);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /outside its own courtyard/);
});

test("a body exactly filling its courtyard is not refused", () => {
  // The bound is inclusive: a courtyard sized to the body plus zero excess is a
  // legitimate density-C pattern, and flagging it would refuse correct work.
  assert.deepEqual(geometryViolations(footprint({ body: { halfWidthMm: 3, halfHeightMm: 2 } }), part), []);
});

test("a symbol pin with no length is refused", () => {
  const broken = symbol({ pins: symbol().pins.map((pin, index) => (index === 0 ? { ...pin, lengthMm: 0 } : pin)) });
  const problems = symbolViolations(broken, part);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /nothing to attach a wire to/);
});

test("a symbol pin with a non-finite length is refused", () => {
  // Same reason the land sizes are checked this way: a NaN reaches the file as
  // the characters `NaN`, and one format reads it as zero.
  const broken = symbol({ pins: symbol().pins.map((pin, index) => (index === 1 ? { ...pin, lengthMm: Number.NaN } : pin)) });
  assert.match(symbolViolations(broken, part)[0] ?? "", /nothing to attach a wire to/);
});

test("a thermal via that reaches off its own pad is refused", () => {
  // Nothing in the product looked at a thermal via until 2026-08-30, and only
  // one part in the whole corpus emits any - so the corpus alone cannot hold
  // this check up.
  const withPad = footprint({
    pads: [
      ...footprint().pads,
      // 2 x 2 at the origin, which clears the lead lands at x = +/- 2: they
      // span 1.5 to 2.5, so the gap is half a millimetre.
      { number: "3", centre: { xMm: 0, yMm: 0 }, widthMm: 2, heightMm: 2, shape: "roundrect", mounting: "smd" }
    ],
    thermalVias: [{ centre: { xMm: 0.5, yMm: 0.5 }, drillMm: 0.3, padMm: 0.6 }]
  } as never);
  const withPart = { ...part, pinCount: 2, exposedPad: true } as ResolvedPart;
  assert.deepEqual(geometryViolations(withPad, withPart), [], "a via inside the pad is fine");

  const strayed = { ...withPad, thermalVias: [{ centre: { xMm: 9, yMm: 0 }, drillMm: 0.3, padMm: 0.6 }] };
  const problems = geometryViolations(strayed, withPart);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /thermal via/);
});

test("the pin-1 marker nearer another land than to pin 1 is refused", () => {
  // A part soldered down rotated is a board in the bin, not a value to re-check.
  const problems = geometryViolations(footprint({ pin1Marker: { xMm: 2, yMm: -1.2 } }), part);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pin-1 marker/);
});

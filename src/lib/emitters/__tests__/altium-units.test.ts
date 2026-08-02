import { test } from "node:test";
import assert from "node:assert/strict";
import { AltiumEmitError, fromAltiumUnits, toAltiumUnits, toAltiumY } from "../altium/units";

// The conversion is tested before anything else because getting it wrong produces
// a file that parses cleanly and is wrong by 25.4x. No reader can tell.

test("the worked example from the format record converts exactly", () => {
  // A 1.55 mm land length is 61.0236... mil, so 610236 internal units.
  assert.equal(toAltiumUnits(1.55), 610236);
});

test("one mil is ten thousand internal units", () => {
  assert.equal(toAltiumUnits(0.0254), 10000);
  assert.equal(toAltiumUnits(25.4), 10000000);
});

test("the scale is mils, not millimetres", () => {
  // The failure mode this locks out: writing mm * 10000. One millimetre is
  // 39.3701 mil, so 393701 units, not 10000.
  assert.equal(toAltiumUnits(1), 393701);
  assert.notEqual(toAltiumUnits(1), 10000);
});

test("zero and negatives round-trip", () => {
  assert.equal(toAltiumUnits(0), 0);
  assert.equal(toAltiumUnits(-2.7), -toAltiumUnits(2.7));
  assert.ok(Math.abs(fromAltiumUnits(toAltiumUnits(-3.81)) + 3.81) < 1e-9);
});

test("round-tripping any plausible package dimension stays inside half a quantum", () => {
  // One internal unit is 2.54 nanometres, so the worst rounding error is 1.27 nm.
  for (const mm of [0.05, 0.6, 1.27, 1.55, 2.54, 5.4, 9.9, 23.5, 100]) {
    const back = fromAltiumUnits(toAltiumUnits(mm));
    assert.ok(Math.abs(back - mm) <= 1.27e-6, `${mm} mm round-tripped to ${back} mm`);
  }
});

test("Y is flipped on the way out, because Altium counts up and the geometry counts down", () => {
  assert.equal(toAltiumY(1.27), -toAltiumUnits(1.27));
  assert.equal(toAltiumY(0), 0);
});

test("a coordinate that does not fit the field is refused, not clamped", () => {
  assert.throws(() => toAltiumUnits(Number.NaN), AltiumEmitError);
  assert.throws(() => toAltiumUnits(Number.POSITIVE_INFINITY), AltiumEmitError);
  // int32 tops out at about 5454 mm.
  assert.throws(() => toAltiumUnits(6000), AltiumEmitError);
  assert.throws(() => toAltiumUnits(-6000), AltiumEmitError);
});

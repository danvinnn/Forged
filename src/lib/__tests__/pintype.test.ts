import { test } from "node:test";
import assert from "node:assert/strict";
import { pinTypeFrom } from "../types";

test("the datasheet's own vocabulary maps onto the enum", () => {
  // Sampled off the model cache on 2026-08-28. These are the spellings real
  // datasheets use in their Type column, and every one of them was being
  // discarded.
  assert.equal(pinTypeFrom("I"), "input");
  assert.equal(pinTypeFrom("O"), "output");
  assert.equal(pinTypeFrom("P"), "power");
  assert.equal(pinTypeFrom("G"), "power", "ground is a power connection in every format this emits");
  assert.equal(pinTypeFrom("I/O"), "bidirectional");
  assert.equal(pinTypeFrom("Input"), "input");
  assert.equal(pinTypeFrom("Ground"), "power");
  assert.equal(pinTypeFrom("Input/Output"), "bidirectional");
});

test("our own spellings pass through whatever the case", () => {
  assert.equal(pinTypeFrom("power"), "power");
  assert.equal(pinTypeFrom("Bidirectional"), "bidirectional");
  assert.equal(pinTypeFrom("open_collector"), "open_collector");
  assert.equal(pinTypeFrom("OPEN COLLECTOR"), "open_collector");
});

test("a logic family is not a direction and is not guessed at", () => {
  // UT7R995's Type column says LVTTL and 3-Level. Those describe the electrical
  // standard a pin speaks, not whether it drives or is driven, so they are no
  // evidence about direction.
  assert.equal(pinTypeFrom("LVTTL"), "unspecified");
  assert.equal(pinTypeFrom("3-Level"), "unspecified");
  assert.equal(pinTypeFrom("CMOS"), "unspecified");
});

test("nothing at all stays unspecified", () => {
  assert.equal(pinTypeFrom(undefined), "unspecified");
  assert.equal(pinTypeFrom(null), "unspecified");
  assert.equal(pinTypeFrom(42), "unspecified");
  assert.equal(pinTypeFrom(""), "unspecified");
});

test("a not-connected pin is typed as such rather than left unknown", () => {
  assert.equal(pinTypeFrom("NC"), "nc");
  assert.equal(pinTypeFrom("N/A"), "nc");
  assert.equal(pinTypeFrom("Do Not Connect"), "nc");
});

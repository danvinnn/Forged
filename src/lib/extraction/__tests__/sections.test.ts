import { test } from "node:test";
import assert from "node:assert/strict";
import { LAND_PATTERN_HEADING } from "../sections";

/**
 * The shared heading pattern, and the one thing still worth asserting about it.
 *
 * This file used to test a page selector that added the land-pattern page to
 * every part's render set. That was deleted on 2026-08-17 for being tailored:
 * over 46 datasheets the pattern finds 20 of 21 Texas Instruments documents and
 * 0 of 6 Analog Devices ones. The premise behind it did not survive measurement
 * either. The land page was ALREADY among the pages the model asked for in 49 of
 * 53 cached answers, so "the model was never shown it" explained almost nothing.
 *
 * What remains is one consumer, the focused local model, and one property worth
 * protecting: the pattern lives in exactly one place.
 */

test("the heading pattern is shared, not copied", async () => {
  // The defect shape LEARNINGS.md names first is a value fixed in one place and
  // not the other. The focused local model locates the same section, and a
  // second copy of this pattern would drift from this one silently.
  const { FIELD_GROUPS } = await import("../models/local-focused");
  const landGroup = FIELD_GROUPS.find((group) => group.fields.includes("dimensions.landSpanMm"));
  assert.equal(landGroup?.locate, LAND_PATTERN_HEADING);
});

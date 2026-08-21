import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOutlineCode, sameOutlineCode } from "../../packagevariants";

// Every pair below is one the cached corpus actually produced on 2026-08-20.
test("decoration around one code does not make it a second code", () => {
  assert.ok(sameOutlineCode("751-07", "CASE 751-07"));
  assert.ok(sameOutlineCode("DSJ", "DSJ (R-PVSON-N14)"));
  assert.ok(sameOutlineCode("1L", "1L_LQFP100_ME_V3"));
  assert.ok(sameOutlineCode("5W", "5W_LQFP64_ME_V1"));
  assert.ok(sameOutlineCode("1A", "1A_LQFP144_ME_V2"));
});

test("two different drawings stay apart", () => {
  // Both real: THS3491 and TPD4E1U06 returned these on different runs.
  assert.ok(!sameOutlineCode("DDA0008B", "RGT0016C"));
  assert.ok(!sameOutlineCode("DCK0006A", "DBV0006A"));
});

// THE REASON THE SUFFIX RULE IS A PREFIX-AT-A-SEPARATOR AND NOT A TRUNCATION.
test("codes that differ only in a trailing segment are not merged", () => {
  // ST numbers its drawings this way; LIS3DH's is 7983231_13.
  assert.ok(!sameOutlineCode("7983231_13", "7983231_14"));
  // A revision is a different drawing.
  assert.ok(!sameOutlineCode("DDA0008B", "DDA0008C"));
  // Six leads apart, and both designate "D".
  assert.ok(!sameOutlineCode("D0008A", "D0014A"));
});

test("a missing code never proves identity", () => {
  assert.ok(!sameOutlineCode(null, null));
  assert.ok(!sameOutlineCode("D0008A", null));
  assert.ok(!sameOutlineCode("", "D0008A"));
});

test("normalisation is case and whitespace insensitive", () => {
  assert.equal(normalizeOutlineCode("  d0008a "), "D0008A");
  assert.equal(normalizeOutlineCode("PACKAGE OUTLINE DW0016A"), "DW0016A");
  assert.equal(normalizeOutlineCode(""), null);
  assert.equal(normalizeOutlineCode(undefined), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { datasheetTextFromPages } from "../pdftext";
import { findVendorLandPattern, findUnreadableFootprint } from "../vendorland";


// The vendor prints its own recommended land pattern. Reading it gives a second,
// independent opinion on the footprint we compute, which is worth having because
// a silent disagreement between the two is what ends up on a board.

/** A datasheet offering two packages, each with its own land pattern drawing. */
const twoPackages = datasheetTextFromPages([
  ["ACME27524 Dual Gate Driver"].join("\n"),
  [
    "EXAMPLE BOARD LAYOUT",
    "DSD0008D WSON - 0.8 mm max height",
    "PLASTIC SMALL OUTLINE - NO LEAD",
    "8X (0.6)",
    "8X (0.31)",
    "6X (0.65)",
    "(2.15)",
    "LAND PATTERN EXAMPLE"
  ].join("\n"),
  [
    "EXAMPLE BOARD LAYOUT",
    "PW0008A TSSOP - 1.2 mm max height",
    "SMALL OUTLINE PACKAGE",
    "8X (1.5)",
    "8X (0.45)",
    "6X (0.65)",
    "(5.8)",
    "LAND PATTERN EXAMPLE"
  ].join("\n")
]);

test("the land pattern for the requested family is the one that is read", () => {
  // Without the family filter the first drawing wins, so a TSSOP footprint was
  // compared against the WSON land pattern and reported a disagreement that did
  // not exist. Most datasheets offer several packages, so this is the norm.
  const tssop = findVendorLandPattern(twoPackages, "TSSOP");
  assert.ok(tssop, "the TSSOP drawing must be found");
  assert.ok(
    tssop.dimensions.some((dimension) => dimension.valueMm === 5.8),
    "the 5.8 mm span belongs to the TSSOP drawing"
  );
  assert.ok(
    !tssop.dimensions.some((dimension) => dimension.valueMm === 2.15),
    "the 2.15 mm WSON span must not leak in"
  );
});

test("a package designator carrying regex metacharacters does not crash the reader", () => {
  // The designator arrives from a form field on `/api/parse` and from the
  // model's own answer, and lands inside `new RegExp`. `SOIC[` builds
  // `\bSOIC[\b`, an unterminated character class: the constructor throws, the
  // throw escapes the route handler, and an anonymous caller gets a 500 for a
  // string. The route bounds the designator's LENGTH and names regex
  // construction as the reason, which guards the wrong property.
  const doc = datasheetTextFromPages([
    "EXAMPLE BOARD LAYOUT\nD0008A SOIC\nLAND PATTERN EXAMPLE\n8X (1.5)\n8X (0.45)\n(5.8)"
  ]);
  for (const hostile of ["SOIC[", "SOIC(", "SOIC*", "SOIC+", "SOIC\\", "SOIC{2,}", "(?:)"]) {
    assert.doesNotThrow(
      () => findVendorLandPattern(doc, hostile),
      `a designator of "${hostile}" must not throw`
    );
  }
  // And escaping must not have broken the ordinary case, which is the half a
  // sanitiser usually gets wrong.
  assert.ok(findVendorLandPattern(doc, "SOIC"), "a real designator still finds its drawing");
});

test("a footprint drawing the text layer cannot parse still yields its page", () => {
  // ST prints `Figure 48. LQFP64 - Footprint example` with bare numbers, which
  // the callout reader above cannot parse: it is built on TI's `LAND PATTERN
  // EXAMPLE` heading and parenthesised reference dimensions.
  //
  // `findUnreadableFootprint` exists so the user is never told a datasheet
  // prints no footprint when it prints one on a numbered page. Its only caller
  // was `crossCheckLandPattern`, which nothing in production has called since
  // the family table was deleted, so the promise was never kept: the refusal in
  // `askForLandPattern` says verbatim "This datasheet does not print a
  // recommended footprint for X", which is the exact sentence this prevents.
  //
  // `buildReadout` now calls it, and records the page with NO values, which is
  // what we actually know. Everything reading the callouts guards on a non-empty
  // list, so nothing is vetoed by a drawing we could not read; everything
  // wanting the page gets it.
  const doc = datasheetTextFromPages([
    "Contents\nFigure 48. LQFP64 - Footprint example . . . . . . . . . 71",
    "Some other page of prose about the device.",
    "Figure 48. LQFP64 - Footprint example\n0.30 1.50 0.50 12.00 10.00"
  ]);

  assert.equal(findVendorLandPattern(doc, "LQFP64"), null, "the callout reader cannot read it");
  assert.equal(findUnreadableFootprint(doc, "LQFP64"), 3, "but the page is known, and it is not the contents page");
});

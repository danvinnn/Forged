import { test } from "node:test";
import assert from "node:assert/strict";
import { datasheetTextFromPages } from "../pdftext";
import { findVendorLandPattern, crossCheckLandPattern } from "../vendorland";
import { computeLandPattern } from "../ipc7351";
import { findPackageDefinition } from "../packages";

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

test("a computed TSSOP land agrees with the pattern TI prints", () => {
  const lookup = findPackageDefinition("TSSOP-8", 8);
  assert.equal(lookup.ok, true);
  if (!lookup.ok) return;

  const land = computeLandPattern(lookup.definition.lead);
  const check = crossCheckLandPattern(twoPackages, land, lookup.definition.family);

  assert.equal(check.agreement, "agrees", check.detail);
  assert.match(check.detail, /page 3/, "the comparison cites the page it read");
});

test("a datasheet with no printed land pattern is unavailable, not a disagreement", () => {
  const bare = datasheetTextFromPages([["ACME1 Amplifier", "No drawings here."].join("\n")]);
  const lookup = findPackageDefinition("SOIC-8", 8);
  assert.equal(lookup.ok, true);
  if (!lookup.ok) return;

  const check = crossCheckLandPattern(bare, computeLandPattern(lookup.definition.lead), "SOIC narrow");
  assert.equal(check.agreement, "unavailable");
});

test("a real disagreement is reported rather than hidden", () => {
  // Same drawing, but our computed land is deliberately nothing like it.
  const lookup = findPackageDefinition("TSSOP-8", 8);
  assert.equal(lookup.ok, true);
  if (!lookup.ok) return;

  const wrong = { ...computeLandPattern(lookup.definition.lead), padCentreMm: 12, padLengthMm: 9 };
  const check = crossCheckLandPattern(twoPackages, wrong, "TSSOP");

  assert.equal(check.agreement, "differs");
  assert.match(check.detail, /land length/, "the report names which dimension disagrees");
});

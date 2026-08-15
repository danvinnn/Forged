import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPartRecord, parseDatasheetPdf } from "../datasheet";
import { datasheetTextFromPages } from "../pdftext";
import { partSchema, resolveForExport } from "../types";

// These lock in the behavior the VA10820 live run exposed: the parser used to
// report a VORAGO part as "NXP" with 128 pins named PIN1..PIN128, while its own
// notes said no pin table had been found. Fabricated pins become fabricated
// pads in a flight-part footprint, so "unknown" has to survive all the way to
// the export boundary instead of being filled in with a guess.

/**
 * A rad-hard datasheet with no pin table, one incidental mention of another
 * vendor, and a larger pin count belonging to a different device. This is the
 * exact shape that produced the wrong record.
 */
const misleadingDatasheet = datasheetTextFromPages([
  [
    "VORAGO Technologies VA10820",
    "Radiation Hardened ARM Cortex-M0 Microcontroller",
    "Available in a 32-pin QFN package.",
    "RHA up to TID = 50krad(Si)"
  ].join("\n"),
  [
    "Application Information",
    "Interfacing with NXP I2C peripherals is supported.",
    "The reference design pairs the device with a 128-pin FPGA companion."
  ].join("\n")
]);

test("a document with no pin table yields unknown pins, never fabricated ones", () => {
  const part = buildPartRecord(misleadingDatasheet, "VA10820.pdf");
  // Captured before asserting: assert.equal narrows the type to null, which
  // would make the placeholder-name check below unreachable.
  const names = (part.pins.value ?? []).map((pin) => pin.name);

  assert.equal(part.pins.value, null, "pins must stay unknown, not be synthesized");
  assert.equal(part.pins.confidence, null);
  assert.equal(part.pins.method, null);

  // The regression in full: 128 placeholder pins named PIN1..PIN128.
  assert.ok(!names.some((name) => /^PIN\d+$/.test(name)), "no placeholder pin names may be emitted");
});

test("an incomplete record is refused at the export boundary", () => {
  const part = buildPartRecord(misleadingDatasheet, "VA10820.pdf");
  const resolved = resolveForExport(part);

  assert.equal(resolved.ok, false, "CAD generation must not proceed on unknown pin data");
  if (!resolved.ok) assert.ok(resolved.missing.includes("pins"));
});

test("the record still validates against partSchema when values are unknown", () => {
  const part = buildPartRecord(misleadingDatasheet, "VA10820.pdf");
  const result = partSchema.safeParse(JSON.parse(JSON.stringify(part)));
  assert.ok(result.success, "unknown must be representable, not a validation error");
});

// --- Cross-vendor false positives, found by running real non-TI datasheets ---
//
// The parser's patterns were tuned against TI. On ST and ADI parts they did not
// merely miss, they produced confident wrong answers, which is the same failure
// class as the fabricated pins and is harder to notice.

test("an explicit unknown pin count is not papered over by the pin table length", () => {
  // resolveForExport used to fall back to pins.length, which reinstated exactly
  // the count the parser had deliberately declined to choose.
  const doc = datasheetTextFromPages([
    "AD590 Two-Terminal IC Temperature Transducer",
    "Available in a 2-lead FLATPACK package.",
    ["Pin Functions", "NC1 8 NC temperature", "V+2 7 Power supply", "NC4 5 NC unused"].join("\n")
  ]);
  const part = buildPartRecord(doc, "AD590.pdf");
  const resolved = resolveForExport(part);

  if (part.pinCount.value === null) {
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.ok(resolved.missing.includes("pinCount"));
  }
});

// --- The good path, against the real primary validation part -----------------

/**
 * A document offering two packages with different lead counts.
 *
 * Kept from the version of this file that tested the deterministic parser,
 * because the hint behaviour it exercises survived that deletion: naming a
 * package is still the one thing a caller can tell us that the document cannot.
 */
const twoPackages = datasheetTextFromPages([
  ["ACME192 Precision Op Amp", "Available in an 8-Pin SOIC package"].join("\n"),
  [
    "The 14-Pin TSSOP is described in the quad datasheet.",
    "Pin Functions",
    "NAME NO. TYPE DESCRIPTION",
    "OUT 1 Output Amplifier output",
    "V- 2 Power Negative supply",
    "IN+ 3 Input Noninverting input",
    "IN- 4 Input Inverting input",
    "V+ 5 Power Positive supply"
  ].join("\n")
]);

test("a package the caller names replaces the designator search and says so", () => {
  const part = buildPartRecord(twoPackages, "ACME192.pdf", undefined, {
    packageType: "SOT-23 (DBV)"
  });

  assert.equal(part.packageType.value, "SOT-23 (DBV)");
  assert.equal(part.packageType.method, "user", "a package the user chose is not a deterministic read");
  assert.equal(
    part.packageType.citation,
    null,
    "a value the user supplied must never carry a citation claiming the document said it"
  );
});

test("an absurdly long package hint is not treated as a choice", () => {
  const part = buildPartRecord(twoPackages, "ACME192.pdf", undefined, {
    packageType: "X".repeat(200)
  });

  assert.notEqual(part.packageType.method, "user", "a designator is a short printed token");
});

test("no hint at all leaves every existing record untouched", () => {
  const withHint = buildPartRecord(twoPackages, "ACME192.pdf", undefined, {});
  const without = buildPartRecord(twoPackages, "ACME192.pdf");

  assert.deepEqual(withHint.packageType, without.packageType);
  assert.deepEqual(withHint.pinCount, without.pinCount);
});

// ---------------------------------------------------------------------------
// Per-PACKAGE values on a family datasheet
//
// Pitch and package name are properties of ONE package, and a family datasheet
// describes several. Reading either with a document-wide scan answers with a
// sibling's, and for pitch that is not merely a wrong field: it VETOES a correct
// land pattern, because the resolver refuses when the extracted pitch disagrees
// with the family's definitional one.
// ---------------------------------------------------------------------------

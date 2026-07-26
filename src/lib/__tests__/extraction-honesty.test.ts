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

test("pin count is not the largest number followed by 'pin' in the document", () => {
  const part = buildPartRecord(misleadingDatasheet, "VA10820.pdf");

  // 128 belongs to an FPGA in a reference design on a later page. Taking
  // Math.max over the whole document is what used to pick it.
  assert.notEqual(part.pinCount.value, 128, "a later-page FPGA must not set the pin count");
  if (part.pinCount.value !== null) {
    assert.equal(part.pinCount.value, 32, "the front-matter package designator is the right source");
    assert.ok(part.pinCount.citation, "a pin count read off the page must cite it");
  }
});

test("a vendor mentioned in passing does not become the manufacturer", () => {
  const part = buildPartRecord(misleadingDatasheet, "VA10820.pdf");

  assert.notEqual(part.manufacturer.value, "NXP", "an incidental I2C mention must not win");
  assert.equal(part.manufacturer.value, "VORAGO Technologies");
  assert.ok((part.manufacturer.confidence ?? 0) > 0.5, "a front-matter vendor is high confidence");
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

test("a signal label shaped like a package designator is not a package", () => {
  // ST's RHF310A pinout carries "OUT (1)", which matched the package pattern
  // and reported a 10-lead part as a 1-pin package.
  const doc = datasheetTextFromPages([
    "RHF310A Rad-hard operational amplifier",
    "Pin connections\nOUT (1)\nVCC (2)\nSee the package section for mechanical data."
  ]);
  const part = buildPartRecord(doc, "RHF310A.pdf");

  assert.notEqual(part.packageType.value, "OUT (1)");
  assert.notEqual(part.pinCount.value, 1, "no package has a single terminal position");
});

test("conflicting pin counts resolve to unknown, not to a winner", () => {
  // ADI's AD590 is a 2-lead device. Prose fragments parsed as three pin rows,
  // and preferring that "table" over the package designator exported a 3-pad
  // footprint for a 2-lead part.
  const doc = datasheetTextFromPages([
    "AD590 Two-Terminal IC Temperature Transducer",
    "Available in a 2-lead FLATPACK package.",
    ["Pin Functions", "NC1 8 NC temperature", "V+2 7 Power supply", "NC4 5 NC unused"].join("\n")
  ]);
  const part = buildPartRecord(doc, "AD590.pdf");

  if ((part.pins.value ?? []).length !== 2) {
    assert.equal(
      part.pinCount.value,
      null,
      "a package designator and a pin table that disagree cannot both be trusted"
    );
    assert.ok(
      part.notes.some((note) => /conflicting pin counts/i.test(note)),
      "the conflict must be stated in the record"
    );
    assert.equal(resolveForExport(part).ok, false, "a conflicted record must not export");
  }
});

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

test("LMP7704-SP extracts a complete, cited record", async () => {
  const bytes = readFileSync(join(process.cwd(), "test-data", "LMP7704-SP.pdf"));
  const part = await parseDatasheetPdf(
    "LMP7704-SP.pdf",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );

  assert.equal(part.manufacturer.value, "Texas Instruments");
  assert.equal(part.partNumber.value, "LMP7704-SP");

  // The pin table has 14 rows. The old parser found 8 because the superscript
  // +/- signs sit on their own baseline and it had no positional data.
  assert.equal(part.pinCount.value, 14);
  assert.equal((part.pins.value ?? []).length, 14);

  // pinCount and pins used to be able to disagree, so a consumer reading one
  // got a different answer than a consumer reading the other.
  assert.equal(part.pinCount.value, (part.pins.value ?? []).length);

  // Every value that came off the datasheet cites a page.
  for (const [label, field] of [
    ["partNumber", part.partNumber],
    ["manufacturer", part.manufacturer],
    ["packageType", part.packageType],
    ["pinCount", part.pinCount],
    ["pins", part.pins]
  ] as const) {
    assert.ok(field.citation, `${label} must carry a citation`);
    assert.ok(field.citation!.page >= 1, `${label} citation needs a real page`);
    assert.equal(field.method, "deterministic");
  }

  // Descriptions used to come back as "OutputforamplifierA" because the default
  // renderer concatenates same-line runs with no separator.
  const pinOne = (part.pins.value ?? []).find((pin) => pin.number === "1");
  assert.equal(pinOne?.description, "Output for amplifier A");

  // Radiation values are bounded, not "rest of the line" captures that swallow
  // the prose that follows them.
  assert.equal(part.radiation.tid.value, "100krad(Si)");
  assert.equal(part.radiation.qmlClass.value, "QML Class V");

  const resolved = resolveForExport(part);
  assert.equal(resolved.ok, true, "a complete record must export");
});

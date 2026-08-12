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

test("prose that parses as pin rows never becomes a pin table", () => {
  // ADI's AD590 is a 2-lead device. Prose fragments parsed as three pin rows,
  // and preferring that "table" over the package designator exported a 3-pad
  // footprint for a 2-lead part.
  //
  // This used to resolve to "both suspect, so the count is unknown". It now
  // resolves better: rows numbered 8, 7 and 5 are not a table of anything, so
  // they are refused outright and the 2-lead designator is left standing. The
  // guarantee the test exists for is unchanged and still asserted below, that no
  // 3-pad footprint can come out of this document.
  const doc = datasheetTextFromPages([
    "AD590 Two-Terminal IC Temperature Transducer",
    "Available in a 2-lead FLATPACK package.",
    ["Pin Functions", "NC1 8 NC temperature", "V+2 7 Power supply", "NC4 5 NC unused"].join("\n")
  ]);
  const part = buildPartRecord(doc, "AD590.pdf");

  assert.deepEqual(part.pins.value, null, "a gapped fragment is not a pin table");
  assert.notEqual(part.pinCount.value, 3, "and above all it is not a 3-pin part");
  assert.equal(part.pinCount.value, 2, "the package designator is the surviving signal");
  assert.equal(resolveForExport(part).ok, false, "with no pins it still cannot export");
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

// --- The table of contents is not the pin section ---------------------------
// Measured across the corpus, this was the single largest cause of missing pin
// data: 20 of 24 blocked parts had a real pin section the parser never reached,
// because datasheets name the section in their contents first and the parser
// took the first match. Fixing it moved export-readiness from 8% to 14%.

const tocThenRealSection = datasheetTextFromPages([
  [
    "ACME9000 Precision Amplifier",
    "Table of Contents",
    "5 Specifications ..................................................... 4",
    "6 Pin Configuration and Functions ................................ 5",
    "7 Detailed Description ............................................. 8"
  ].join("\n"),
  [
    "6 Pin Configuration and Functions",
    "Pin Functions",
    "NAME NO. TYPE DESCRIPTION",
    "OUTA 1 Output Output for amplifier A",
    "INA- 2 Input Inverting input",
    "INA+ 3 Input Noninverting input",
    "VCC 4 Power Positive supply"
  ].join("\n")
]);

test("the pin section is found past the table of contents", () => {
  const part = buildPartRecord(tocThenRealSection, "ACME9000.pdf");
  const pins = part.pins.value ?? [];

  assert.equal(pins.length, 4, "the real section on page 2 must be used, not the contents entry");
  assert.deepEqual(
    pins.map((p) => p.name),
    ["OUTA", "INA-", "INA+", "VCC"]
  );
  assert.equal(part.pins.citation?.page, 2, "the citation must point at the real section");
});

test("a contents entry alone still yields no fabricated pins", () => {
  // Only a contents line, no real section anywhere. Honest miss, not a guess.
  const tocOnly = datasheetTextFromPages([
    [
      "ACME9000 Precision Amplifier",
      "Table of Contents",
      "6 Pin Configuration and Functions ................................ 5"
    ].join("\n")
  ]);
  const part = buildPartRecord(tocOnly, "ACME9000.pdf");

  assert.equal(part.pins.value, null, "no rows means unknown, never invented rows");
});

// --- The pinout figure, and when it is allowed to speak -----------------------
// Some datasheets render a pin function table that no regex reads, but draw a
// two-column top view that parses cleanly. That figure is the one pin signal
// that proves itself: left column ascends, right descends, so the two numbers
// on a row always sum to pinCount + 1, and sum - 1 distinct numbers means
// exactly 1..N with no gaps. Six corpus parts are readable only this way.

/** A 10-pin top view, no function table anywhere. */
const diagramOnly = datasheetTextFromPages([
  ["ACME7741 Quad Digital Isolator", "10-Pin SOIC Package"].join("\n"),
  [
    "Figure 4-1. ACME7741 D Package 10-Pin SOIC Top View",
    "VCC1 1 10 VCC2",
    "GND1 2 9 GND2",
    "INA 3 8 OUTA",
    "INB 4 7 OUTB",
    "INC 5 6 OUTC"
  ].join("\n")
]);

test("a two-column pinout figure yields a complete pinout when no table parses", () => {
  const part = buildPartRecord(diagramOnly, "ACME7741.pdf");
  const pins = part.pins.value ?? [];

  assert.equal(pins.length, 10, "both columns of the figure are pins");
  assert.deepEqual(
    pins.map((pin) => pin.number),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
    "numbering must come out gap-free and in order"
  );
  assert.deepEqual(
    pins.map((pin) => pin.name),
    ["VCC1", "GND1", "INA", "INB", "INC", "OUTC", "OUTB", "OUTA", "GND2", "VCC2"],
    "the right column descends, so pin 6 is the last name on the first row read"
  );
  assert.equal(part.pinCount.value, 10);
  assert.ok(part.pins.citation, "a figure read off the page must cite it");
});

test("a figure with a gap in its numbering is refused, not reported", () => {
  // Rows 3 and 4 of the same figure did not survive text extraction. The sum is
  // still consistent, but 6 of 10 positions are unknown, and half a pinout is
  // worse than an honest gap.
  const gapped = datasheetTextFromPages([
    ["ACME7741 Quad Digital Isolator"].join("\n"),
    ["Top View", "VCC1 1 10 VCC2", "GND1 2 9 GND2", "INC 5 6 OUTC"].join("\n")
  ]);
  const part = buildPartRecord(gapped, "ACME7741.pdf");

  assert.equal(part.pins.value, null, "an incomplete figure yields unknown");
});

test("figures that disagree about a position are refused", () => {
  // One datasheet, several variants: ISO7741 draws pin 6 as IND in one figure
  // and OUTD in the other, because the channel direction differs by device.
  // That is a real ambiguity in the source and may not be resolved by guessing.
  const variants = datasheetTextFromPages([
    ["ACME7740 Digital Isolator Family"].join("\n"),
    [
      "Figure 4-1. ACME7740 Top View",
      "VCC1 1 6 VCC2",
      "GND1 2 5 GND2",
      "INA 3 4 OUTA",
      "Figure 4-2. ACME7742 Top View",
      "VCC1 1 6 VCC2",
      "GND1 2 5 GND2",
      "OUTA 3 4 INA"
    ].join("\n")
  ]);
  const part = buildPartRecord(variants, "ACME7740.pdf");

  assert.equal(part.pins.value, null, "conflicting variant figures yield unknown");
});

test("a self-proving figure outranks a package designator that disagrees", () => {
  // The declared count is a regex over front matter, and this corpus has caught
  // it returning 220 for an LD1117 and 883 for an RTAX2000S. The figure carries
  // an internal proof that the designator does not, so it wins, and the
  // discrepancy has to stay visible in the notes.
  const wrongDesignator = datasheetTextFromPages([
    ["ACME7741 Quad Digital Isolator", "Available in a 2-pin SIZE package"].join("\n"),
    [
      "Top View",
      "VCC1 1 10 VCC2",
      "GND1 2 9 GND2",
      "INA 3 8 OUTA",
      "INB 4 7 OUTB",
      "INC 5 6 OUTC"
    ].join("\n")
  ]);
  const part = buildPartRecord(wrongDesignator, "ACME7741.pdf");

  assert.equal(part.pinCount.value, 10, "the proven figure wins over the guessed designator");
  assert.ok(
    part.notes.some((note) => /pinout diagram numbers 1 to 10/.test(note)),
    "the override must be recorded in the notes, not applied silently"
  );
});

test("an unproven pin table still loses to a disagreeing package designator", () => {
  // The AD590 case that the conflict rule was built for: a 2-lead part whose
  // prose parsed as three pin rows. Nothing here proves itself, so the rule is
  // unchanged and both signals are discarded.
  const prosePins = datasheetTextFromPages([
    ["ACME590 Two-Terminal Sensor", "Available in a 2-lead FLATPACK"].join("\n"),
    [
      "Pin Functions",
      "NAME NO. TYPE DESCRIPTION",
      "VOUT 1 Output Sensor output",
      "VIN 2 Input Supply input",
      "GND 3 Power Ground reference"
    ].join("\n")
  ]);
  const part = buildPartRecord(prosePins, "ACME590.pdf");

  assert.equal(part.pinCount.value, null, "unproven disagreement still resolves to unknown");
  assert.ok(
    part.notes.some((note) => /Conflicting pin counts/.test(note)),
    "the conflict must be explained"
  );
});

// --- Radiation qualification, and the two ways a dose figure lies -------------
// Radiation was the worst-covered field in the corpus (3% overall, 13% even on
// rad-hard parts) because every pattern was fitted to one TI phrasing with an
// equals sign. Widening it surfaced two ways a number can be read confidently
// and wrongly, and both are locked in here.

test("radiation data is read from the phrasings vendors actually use", () => {
  const phrasings = datasheetTextFromPages([
    [
      "ACME4913 Rad-Hard Positive Voltage Regulator",
      "Total Ionizing Dose 300 krad(Si)",
      "Single-Event Latch-Up Immunity (SEL) to LET > 117 MeV-cm2/mg",
      "Qml-V qualified, DLA SMD 5962F02534"
    ].join("\n")
  ]);
  const part = buildPartRecord(phrasings, "ACME4913.pdf");

  assert.equal(part.radiation.tid.value, "300 krad(Si)", "no equals sign is required");
  assert.equal(part.radiation.sel.value, "117 MeV-cm2/mg", "hyphenated MeV-cm2/mg is a LET figure");
  assert.equal(part.radiation.qmlClass.value, "QML-V", "the hyphenated short form is canonicalised");
  assert.ok(part.radiation.tid.citation, "a radiation claim must cite its page");
});

test("a dose figure is never read out of the middle of a number", () => {
  // The real UT54LVDS217 line. Taking "6 rad(Si)" out of "1.0E6 rad(Si)" reports
  // a 1 Mrad part as a 6 rad part: wrong by five orders of magnitude, cited, and
  // pointing at a page that appears to confirm it.
  const scientific = datasheetTextFromPages([
    ["ACME217 Rad-Hard Transceiver", "Total Ionizing Dose (TID) 1.0E6 rad(Si)"].join("\n")
  ]);
  const part = buildPartRecord(scientific, "ACME217.pdf");

  assert.notEqual(part.radiation.tid.value, "6 rad(Si)", "a figure may not start mid-number");
  assert.equal(part.radiation.tid.value, null, "unparsed notation is unknown, not a guess");
});

test("a dose rate is not a total dose", () => {
  // Irradiation conditions appear far more often in a radiation report than the
  // qualification level does, and "10 mrad(Si)/s" is a rate, not a dose.
  const rateOnly = datasheetTextFromPages([
    [
      "ACME1001 Rad-Hard Regulator",
      "TID characterization used a low dose rate of 10 mrad(Si)/s throughout.",
      "Post-irradiation drift was measured at 0.55 rad/s."
    ].join("\n")
  ]);
  const part = buildPartRecord(rateOnly, "ACME1001.pdf");

  assert.equal(part.radiation.tid.value, null, "a rate in rad/s must not become the TID");
});

test("the English words 'see' and 'set' do not become single-event data", () => {
  // The single-event patterns are case sensitive for exactly this reason: these
  // sentences appear on nearly every page of every datasheet, and a nearby LET
  // figure is not hard to find on a rad-hard part.
  const prose = datasheetTextFromPages([
    [
      "ACME2000 Rad-Hard FPGA",
      "For ordering information see Table 9, which is set at 117 MeV-cm2/mg margin.",
      "The bias network is set by an external resistor of 120 MeV-cm2/mg equivalent."
    ].join("\n")
  ]);
  const part = buildPartRecord(prose, "ACME2000.pdf");

  assert.equal(part.radiation.see.value, null, "lowercase 'see' is not the SEE acronym");
});

test("a stray two-number line does not veto a real figure", () => {
  // Found by running the app rather than the suite: at full page depth the
  // UCC27524 timing table's "tM 1 2 ns" formed its own trivially complete
  // 2-pin group, which then conflicted with the genuine 8-pin figure and threw
  // both away. A figure is at least two rows.
  const withStrayLine = datasheetTextFromPages([
    ["ACME27524 Dual Gate Driver"].join("\n"),
    [
      "tM 1 2 ns",
      "Figure 6-1. ACME27524 D Package 8-Pin SOIC Top View",
      "ENA 1 8 ENB",
      "INA 2 7 OUTA",
      "GND 3 6 VDD",
      "INB 4 5 OUTB"
    ].join("\n")
  ]);
  const part = buildPartRecord(withStrayLine, "ACME27524.pdf");

  assert.equal(part.pinCount.value, 8, "the real figure must survive the stray line");
  assert.deepEqual(
    (part.pins.value ?? []).map((pin) => pin.name),
    ["ENA", "INA", "GND", "INB", "OUTB", "VDD", "OUTA", "ENB"]
  );
});

// ---------------------------------------------------------------------------
// A package the CALLER named
//
// The one question a datasheet genuinely cannot answer for itself. Every pin
// reader takes the package as an argument and uses it to choose among a
// document's per-package pinouts, so supplying it is worth five parts of
// thirty-eight on unseen datasheets. These lock in what that supply may and may
// not do: it may replace the designator search and silence a count read off a
// DIFFERENT package, and it may never be paired with a count that is not known
// to be about it.
// ---------------------------------------------------------------------------

/**
 * The OPA192 shape: a front matter describing the eight-pin SOIC, and a
 * five-pin pinout for the SOT-23 the caller actually holds.
 *
 * A TABLE rather than a figure on purpose. A figure that proves itself already
 * outranks a disagreeing declared count, so it would pass these whatever the
 * hint did; an unproven table is the case where the declared count still
 * decides, and so the case that isolates what naming a package changes.
 */
const twoPackages = datasheetTextFromPages([
  ["ACME192 Precision Op Amp", "Available in an 8-Pin SOIC package"].join("\n"),
  [
    // A second package with a DIFFERENT count, so no single count is common to
    // everything the document names. Without it `soleDeclaredLeadCount` answers
    // 8 and the front-matter regex under test is never reached, which is not
    // the shape being modelled: a real OPA192 takes its variants from an
    // ordering table whose designators carry outline codes and no counts at all.
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

test("a count from a package the caller did NOT pick cannot veto the one they did", () => {
  // Unaided, the front-matter `8-Pin SOIC` is the declared count, the table
  // reads five, and the disagreement throws the count away. That is right when
  // nobody has said which package this is. Once someone has, the two numbers are
  // about DIFFERENT packages, so the disagreement is not a corroboration failure
  // and refusing on it defeats the point of having asked.
  const unaided = buildPartRecord(twoPackages, "ACME192.pdf");
  assert.equal(unaided.pinCount.value, null, "unaided, the conflict still resolves to unknown");

  const chosen = buildPartRecord(twoPackages, "ACME192.pdf", undefined, {
    packageType: "SOT-23"
  });

  assert.equal(chosen.pins.value?.length, 5, "the pinout is read either way");
  assert.equal(chosen.pinCount.value, 5, "a count about another package may not veto it");
});

test("naming a package the datasheet draws no pinout for yields no count, not another package's", () => {
  // The hazard this closes: the front-matter scan still answers `8`, and pairing
  // that with the package the user named builds an eight-pad land pattern for a
  // package that may have any number of leads. `packageContradicts` cannot catch
  // it either, because a designator like `VSSOP (DGK)` declares no count of its
  // own to contradict. A record with no pins has no symbol to export anyway, so
  // failing closed here costs nothing that was working.
  // `misleadingDatasheet` has no pin table at all and a front matter declaring a
  // 32-pin QFN, which is exactly the pairing to refuse.
  const unaided = buildPartRecord(misleadingDatasheet, "VA10820.pdf");
  assert.equal(unaided.pinCount.value, 32, "unaided, the front matter is the best source there is");

  const noSuchPinout = buildPartRecord(misleadingDatasheet, "VA10820.pdf", undefined, {
    packageType: "VSSOP (DGK)"
  });

  assert.equal(noSuchPinout.pins.value, null, "no pinout is drawn for that package");
  assert.equal(
    noSuchPinout.pinCount.value,
    null,
    "the front-matter count belongs to a different package and may not be paired with this one"
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

test("a pitch is unknown when the document states several", () => {
  // The STM32 shape: a 0.5 mm LQFP part whose own document also describes a
  // 0.4 mm chip-scale package. Taking the first match made it a 0.4 mm part and
  // its correct LQFP land pattern was then refused for disagreeing.
  const family = datasheetTextFromPages([
    ["ACME407 Microcontroller", "Available in LQFP64 and WLCSP64 packages"].join("\n"),
    ["LQFP64: pitch 0.5 mm", "WLCSP64: pitch 0.4 mm"].join("\n")
  ]);
  const part = buildPartRecord(family, "ACME407.pdf");

  assert.equal(part.dimensions.pitchMm.value, null, "two pitches means neither is known to be this one");
});

test("a pitch is still read when the document states only one", () => {
  const single = datasheetTextFromPages([
    ["ACME123 Op Amp", "Available in an 8-Pin SOIC package"].join("\n"),
    ["The pitch is 1.27 mm."].join("\n")
  ]);
  const part = buildPartRecord(single, "ACME123.pdf");

  assert.equal(part.dimensions.pitchMm.value, 1.27);
  assert.ok(part.dimensions.pitchMm.citation, "a value read off the page cites it");
});

test("the settled pin count names the package when exactly one designator fits", () => {
  // `findPackageType` runs before the count exists, so on a family datasheet it
  // sees every package and answers with none. Once the pinout settles at 64,
  // only one of the offered designators declares 64.
  const family = datasheetTextFromPages([
    ["ACME71 Microcontroller", "Available in LQFP32, LQFP48 and LQFP64 packages"].join("\n"),
    [
      "Pin Functions",
      "NAME NO. TYPE DESCRIPTION",
      ...Array.from({ length: 64 }, (_, index) => `P${index + 1} ${index + 1} I/O General purpose`)
    ].join("\n")
  ]);
  const part = buildPartRecord(family, "ACME71.pdf");

  assert.equal(part.pinCount.value, 64);
  assert.equal(part.packageType.value, "LQFP64", "the only designator declaring 64 is this part's");
  assert.ok(part.packageType.citation, "it was located on the page, so it cites it");
});

test("several designators of the same lead count stay unknown", () => {
  // An STM32F103C8 is 48 pins and its document offers LQFP48, VQFN48 and UQFN48.
  // All three declare 48 and they have entirely different land patterns, so this
  // is a question for the user rather than something to deduce.
  const ambiguous = datasheetTextFromPages([
    ["ACME103 Microcontroller", "Available in LQFP48, VQFN48 and UQFN48 packages"].join("\n"),
    [
      "Pin Functions",
      "NAME NO. TYPE DESCRIPTION",
      ...Array.from({ length: 48 }, (_, index) => `P${index + 1} ${index + 1} I/O General purpose`)
    ].join("\n")
  ]);
  const part = buildPartRecord(ambiguous, "ACME103.pdf");

  assert.equal(part.pinCount.value, 48);
  assert.equal(part.packageType.value, null, "three packages of 48 leads is a choice, not a deduction");
});

test("a millimetre pair in a certification clause is not a package body", () => {
  // The ISO7841 defect, and it shipped: `CSA Component Acceptance Notice 5A,
  // IEC 10.30mm x 10.30mm` gave a sixteen-pin SOIC a SQUARE body, which no SOIC
  // is. A pair of millimetre figures means nothing on its own; something nearby
  // has to say it is a package.
  const certified = datasheetTextFromPages([
    ["ACME7841 Digital Isolator", "Available in a 16-pin SOIC package"].join("\n"),
    [
      "Safety and regulatory approvals",
      "CSA Component Acceptance Notice 5A, IEC 10.30mm × 10.30mm creepage"
    ].join("\n")
  ]);
  const part = buildPartRecord(certified, "ACME7841.pdf");

  assert.notEqual(part.dimensions.bodyLengthMm.value, 10.3, "a certification clause is not a body");
});

test("an UNLABELLED millimetre pair is not a body, however close to a package name", () => {
  // This asserted the opposite until 2026-08-11, when cross-checking the
  // deterministic reader against a model caught the pair being wrong in two
  // different ways on two real datasheets:
  //
  //   INA226   "PACKAGE SIZE     VSSOP (10)  3.00mm x 4.90mm"
  //            4.90 is the LEAD SPAN; the body is 3.0 x 3.0 (DGS0010A, p37).
  //   PCM1808  "BODY SIZE (NOM)  TSSOP (14)  4.40 mm x 5.00 mm"
  //            both are body dimensions, printed WIDTH FIRST, so length and
  //            width came out swapped against PW0014A on p27.
  //
  // Two different failures, and the column header does not even agree between
  // the documents, so neither an ordering rule nor a header test recovers it.
  // A pair of numbers beside a package name does not say WHICH dimensions they
  // are, and guessing places a courtyard and a silkscreen outline from it.
  const stated = datasheetTextFromPages([
    ["ACME345 Accelerometer", "Small and thin: 3 mm × 5 mm × 1 mm LGA package"].join("\n")
  ]);
  const part = buildPartRecord(stated, "ACME345.pdf");

  assert.equal(part.dimensions.bodyLengthMm.value, null);
  assert.equal(part.dimensions.bodyWidthMm.value, null);
});

test("a LABELLED body dimension is still read", () => {
  // The distinction that makes the refusal above a rule rather than a retreat:
  // prose that says which dimension it is states a fact, and is taken.
  const labelled = datasheetTextFromPages([
    ["ACME345 Accelerometer", "LGA package. Body length 5 mm, body width 3 mm, body height 1 mm."].join("\n")
  ]);
  const part = buildPartRecord(labelled, "ACME345.pdf");

  assert.equal(part.dimensions.bodyLengthMm.value, 5);
  assert.equal(part.dimensions.bodyWidthMm.value, 3);
  assert.ok(part.dimensions.bodyLengthMm.citation, "a value read off the page cites it");
});

test("a document stating several body sizes reports none of them", () => {
  // A family datasheet states its LQFP, its WLCSP and its BGA body, and they are
  // different sizes. Taking the first is answering with whichever package the
  // document happens to mention first.
  const family = datasheetTextFromPages([
    ["ACME407 Microcontroller"].join("\n"),
    ["LQFP64 package 10 mm × 10 mm", "WLCSP64 package 4 mm × 4 mm"].join("\n")
  ]);
  const part = buildPartRecord(family, "ACME407.pdf");

  assert.equal(part.dimensions.bodyLengthMm.value, null, "several bodies means none is known to be this one");
});

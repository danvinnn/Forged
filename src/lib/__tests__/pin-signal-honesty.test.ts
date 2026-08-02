import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPartRecord } from "../datasheet";
import { datasheetTextFromPages } from "../pdftext";

/**
 * Two pin signals, both of which were reporting confident nonsense.
 *
 * Found by reading what `bench:extraction` actually produced rather than what it
 * scored. Four parts in the corpus were EXPORT-READY on junk: an STM32F103C8 was
 * a one-pin part whose single pin was numbered 73, a PCF8574 had four pins
 * numbered 11, 13, 15 and 18, and an AD8628 had one pin named
 * "GENERALDESCRIPTIONWithanoffsetvoltageofonly". None of them had a declared
 * count to contradict the table, so `pins.length` became the pin count and
 * nothing downstream had any reason to doubt it.
 *
 * Fixing it took export-readiness DOWN, from 30% to 19%, which is the correct
 * direction: those parts were never ready, they were wrong.
 */

function datasheet(...pages: string[][]) {
  return datasheetTextFromPages(pages.map((lines) => lines.join("\n")));
}

test("a pin table read in fragments is refused, not reported", () => {
  // Body prose that happens to match NAME NUMBER TYPE. This is what an 8-pin
  // op-amp datasheet was producing: two rows, numbered 16 and 18.
  const doc = datasheet(
    ["ACME1234 Dual Operational Amplifier", "Available in an 8-pin SOIC package."],
    [
      "Pin Functions",
      "NC 16 NC Not internally connected",
      "NC 18 NC Not internally connected"
    ]
  );

  const part = buildPartRecord(doc, "ACME1234.pdf");
  assert.deepEqual(part.pins.value, null, "two rows numbered 16 and 18 are not a table");
  assert.equal(part.pinCount.value, 8, "and the declared count survives, no longer contradicted");
});

test("a single row that matches the row shape is prose, not a one-pin part", () => {
  const doc = datasheet(
    ["ACME2 Precision Amplifier"],
    ["Pin Functions", "GENERALDESCRIPTION 1 Input With an offset voltage of only"]
  );

  const part = buildPartRecord(doc, "ACME2.pdf");
  assert.deepEqual(part.pins.value, null);
  assert.equal(part.pinCount.value, null, "nothing is invented to fill the gap");
});

test("a table numbered 1..N with no gaps is believed", () => {
  const doc = datasheet(
    ["ACME3 Quad Comparator", "Available in a 4-pin SOIC package."],
    [
      "Pin Functions",
      "OUT 1 Output Comparator output",
      "IN 2 Input Inverting input",
      "VCC 3 Power Supply voltage",
      "GND 4 Power Ground"
    ]
  );

  const part = buildPartRecord(doc, "ACME3.pdf");
  assert.equal(part.pins.value?.length, 4);
  assert.equal(part.pinCount.value, 4);
  assert.deepEqual(
    part.pins.value?.map((pin) => pin.number),
    ["1", "2", "3", "4"]
  );
});

test("a two-terminal part is not refused for being small", () => {
  // The floor is two rows rather than four precisely so this still works. A
  // reference or a diode is a real part with a real footprint.
  const doc = datasheet(
    ["ACME4 Voltage Reference", "Available in a 2-pin SOT package."],
    ["Pin Functions", "VIN 1 Power Supply input", "GND 2 Power Ground"]
  );

  const part = buildPartRecord(doc, "ACME4.pdf");
  assert.equal(part.pins.value?.length, 2);
  assert.equal(part.pinCount.value, 2);
});

test("a package outline code is not a pin count", () => {
  // TO-220 is a three-lead part. Reading 220 out of it made an LD1117 a 220-pin
  // device, and an RTAX2000S was 883 pins because its front matter cites
  // MIL-STD-883.
  for (const [text, why] of [
    ["Available in TO-220 and TO-263 packages.", "TO-220"],
    ["Qualified to MIL-STD-883 Class B.", "MIL-STD-883"],
    ["Supports RS-485 and RS-232 signalling.", "RS-485"],
    ["Package outline per JEDEC MO-220.", "MO-220"]
  ]) {
    const part = buildPartRecord(datasheet(["ACME5 Regulator", text]), "ACME5.pdf");
    assert.equal(part.pinCount.value, null, `${why} must not become a pin count`);
  }
});

test("a footnote marker is not a package designator", () => {
  // The distinguishing feature is the space. Across the corpus every real
  // designator is written "SOIC (8)" and every false positive is glued to its
  // word: GND(7), NUMBER(3), CMTI(1), SIZE(2).
  const footnote = buildPartRecord(
    datasheet(["ACME6 Comparator", "Ground reference GND(7) and part NUMBER(3) apply."]),
    "ACME6.pdf"
  );
  assert.equal(footnote.pinCount.value, null, "GND(7) is a footnote, not a 7-pin package");

  const designator = buildPartRecord(
    datasheet(["ACME7 Driver", "Offered in SOIC (8) and SON (6)."]),
    "ACME7.pdf"
  );
  assert.equal(designator.pinCount.value, 8, "a spaced designator is the real thing");
});

test("a real designator still wins over a signal name that precedes it", () => {
  // LM139AQML-SP declared seven pins because GND(7) was matched before GDIP-14.
  const part = buildPartRecord(
    datasheet(["ACME8 Quad Comparator", "Ground GND(7) is common. Supplied as GDIP-14."]),
    "ACME8.pdf"
  );
  assert.equal(part.pinCount.value, 14);
});

/**
 * The one loosening of the rule above, and why it is not a loosening of the bar.
 *
 * A table read off the page geometry proves it is a well-formed table, not that
 * it is THIS device's, so it was made to wait for the document's declared count
 * to corroborate it. That refused a TLV9061 whose own five-pin table the reader
 * had found and read correctly, because the front matter of a datasheet covering
 * four devices declares no single count.
 *
 * A caption naming the part is a proof about the DEVICE, which is the thing
 * corroboration was ever standing in for. It still does not win an argument: a
 * declared count that CONTRADICTS the table means one of them is a misread, and
 * the numbering proof says nothing about which package the caller wants.
 */

let offset = 0;
function geometryItem(str: string, x: number, y: number) {
  const start = offset;
  offset += str.length + 1;
  return { str, x, y, width: str.length * 5, height: 8, start, end: start + str.length };
}

function withCaptionedTable(frontMatter: string, caption: string) {
  const doc = datasheet([frontMatter], ["Pin Functions"]);
  doc.pages[1].items = [
    geometryItem(caption, 57, 520),
    geometryItem("OUT", 57, 470), geometryItem("1", 107, 470),
    geometryItem("O", 147, 470), geometryItem("output", 173, 470),
    geometryItem("V-", 57, 456), geometryItem("2", 107, 456),
    geometryItem("P", 147, 456), geometryItem("supply", 173, 456)
  ];
  return doc;
}

test("a table claimed by its caption no longer waits for a declared count", () => {
  const doc = withCaptionedTable(
    "TLV9061, TLV9062, TLV9064 Operational Amplifiers",
    "Table 5-1. Pin Functions: TLV9061"
  );

  const part = buildPartRecord(doc, "TLV9061.pdf");
  assert.equal(part.pins.value?.length, 2);
  assert.equal(part.pinCount.value, 2, "the caption says the table is this device's");
});

test("and it still loses to a declared count that contradicts it", () => {
  const doc = withCaptionedTable(
    "TLV9061 Operational Amplifier, available in a 14-lead CFP package.",
    "Table 5-1. Pin Functions: TLV9061"
  );

  const part = buildPartRecord(doc, "TLV9061.pdf");
  assert.equal(part.pinCount.value, null, "two signals disagreeing is still unknown");
});

test("an uncaptioned table is unchanged, and still waits", () => {
  const doc = withCaptionedTable("TLV9061 Operational Amplifier", "Table 5-1. Pin Functions");

  const part = buildPartRecord(doc, "TLV9061.pdf");
  assert.equal(part.pins.value?.length, 2, "the pins are still worth reporting");
  assert.equal(part.pinCount.value, null, "but nothing proved the table is this part's");
});

/**
 * The geometry FIGURE reader, and the rule that keeps it safe.
 *
 * It runs only when both text readers found nothing, and it never sets the pin
 * count on its own. The constant-sum proof says the figure is complete; it says
 * nothing about which PACKAGE the caller wants, and a datasheet draws several.
 * An AD590 draws an eight-pin SOIC while declaring a two-lead flatpack, and an
 * AD8628 draws an eight-pin SOIC and a five-pin TSOT. Both are the part.
 */

function withFigure(frontMatter: string) {
  const doc = datasheet([frontMatter], ["Pin Configuration"]);
  const items = [];
  const left = ["NC", "V+", "V-", "GND"];
  const right = ["OUT", "REF1", "REF2", "VS"];
  for (let index = 0; index < 4; index += 1) {
    const y = 546 - index * 18;
    items.push(geometryItem(left[index], 80, y));
    items.push(geometryItem(String(index + 1), 140, y));
    items.push(geometryItem(String(8 - index), 234, y));
    items.push(geometryItem(right[index], 269, y));
  }
  doc.pages[1].items = items;
  return doc;
}

test("a figure read from geometry reports its pins", () => {
  const doc = withFigure("ACME700 Voltage Reference");
  const part = buildPartRecord(doc, "ACME700.pdf");

  assert.equal(part.pins.value?.length, 8);
  assert.equal(part.pins.value?.[0].name, "NC");
  assert.equal(part.pinCount.value, null, "and refuses the count with nothing to corroborate it");
});

test("a figure never outranks a declared count that contradicts it", () => {
  // The AD590 shape exactly: an eight-pin figure on a part the document declares
  // as a two-lead flatpack. Both are true and they are different packages.
  const doc = withFigure("ACME590 Temperature Sensor in a 2-lead FLATPACK package.");
  const part = buildPartRecord(doc, "ACME590.pdf");

  assert.equal(part.pins.value?.length, 8, "the pins are still worth reporting");
  assert.equal(part.pinCount.value, null, "but eight against two is not a count");
});

test("a figure the declared count agrees with sets it", () => {
  const doc = withFigure("ACME701 Voltage Reference in an 8-Pin SOIC package.");
  const part = buildPartRecord(doc, "ACME701.pdf");

  assert.equal(part.pinCount.value, 8);
});

/**
 * The figure as a TIE-BREAK, when a table and a declared count disagree.
 *
 * Both readers prove something, and they prove it differently: the table finds a
 * gap-free 1..N down a column of row geometry, the figure finds one under a
 * single constant sum across opposing sides. Neither can produce the other's
 * proof by accident. Two of them agreeing therefore outranks the declared count,
 * which is the same front-matter regex that has returned 220 for an LD1117.
 *
 * Measured on the hold-out: of six parts reading pins with the count refused,
 * five were refused by this disagreement and the figure backs the table on two.
 */
function withTableAndFigure(frontMatter: string) {
  const doc = datasheet([frontMatter], ["Pin Functions"], ["Pin Configuration"]);

  doc.pages[1].items = [
    geometryItem("Table 5-1. Pin Functions", 57, 520),
    geometryItem("OUT", 57, 470), geometryItem("1", 107, 470),
    geometryItem("O", 147, 470), geometryItem("output", 173, 470),
    geometryItem("V-", 57, 456), geometryItem("2", 107, 456),
    geometryItem("P", 147, 456), geometryItem("supply", 173, 456),
    geometryItem("IN", 57, 442), geometryItem("3", 107, 442),
    geometryItem("I", 147, 442), geometryItem("input", 173, 442),
    geometryItem("V+", 57, 428), geometryItem("4", 107, 428),
    geometryItem("P", 147, 428), geometryItem("supply", 173, 428)
  ];

  // A four-pin figure: 1 and 2 down the left, 4 and 3 down the right, so every
  // opposing pair sums to 5.
  const figure = [];
  const left = ["OUT", "V-"];
  const right = ["V+", "IN"];
  for (let index = 0; index < 2; index += 1) {
    const y = 546 - index * 18;
    figure.push(geometryItem(left[index], 80, y));
    figure.push(geometryItem(String(index + 1), 140, y));
    figure.push(geometryItem(String(4 - index), 234, y));
    figure.push(geometryItem(right[index], 269, y));
  }
  doc.pages[2].items = figure;

  return doc;
}

test("a figure that backs the table outranks a declared count that contradicts both", () => {
  const doc = withTableAndFigure(
    "ACME800 Operational Amplifier, available in a 14-lead CFP package."
  );

  const part = buildPartRecord(doc, "ACME800.pdf");
  assert.equal(part.pins.value?.length, 4);
  assert.equal(
    part.pinCount.value,
    4,
    "the table numbers 1..4 and the figure independently resolves to 4; the designator is outvoted"
  );
  assert.match(
    part.notes.join(" "),
    /independently resolves/,
    "and the discrepancy stays auditable in the notes"
  );
});

test("the tie-break needs a TABLE, so a figure cannot corroborate itself", () => {
  // The AD590 shape, guarded a second way. Pins that came from the figure are
  // not corroborated by asking the figure again; that comparison always agrees
  // and would make an eight-pin figure outrank a declared two-lead part.
  const doc = datasheet(
    ["ACME801 Temperature Sensor in a 2-lead FLATPACK package."],
    ["Pin Configuration"]
  );
  const figure = [];
  const left = ["NC", "V+"];
  const right = ["VS", "OUT"];
  for (let index = 0; index < 2; index += 1) {
    const y = 546 - index * 18;
    figure.push(geometryItem(left[index], 80, y));
    figure.push(geometryItem(String(index + 1), 140, y));
    figure.push(geometryItem(String(4 - index), 234, y));
    figure.push(geometryItem(right[index], 269, y));
  }
  doc.pages[1].items = figure;

  const part = buildPartRecord(doc, "ACME801.pdf");
  assert.equal(part.pins.value?.length, 4, "the pins are still worth reporting");
  assert.equal(part.pinCount.value, null, "but four against two is not a count");
});

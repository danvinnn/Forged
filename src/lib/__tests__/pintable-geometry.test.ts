import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPinTableByGeometry, readPinTableFromPage, readPinTablesFromPage } from "../pintable";
import type { PageText, TextItem } from "../pdftext";

/**
 * The geometry reader, built after two regex attempts measured as worthless.
 *
 * A pin table's description column wraps, and `pdf-parse` flattens the page by
 * baseline, so one logical row arrives as three lines with the wrap ABOVE the
 * row it belongs to. The x coordinate is what separates the columns and it was
 * being discarded, even though `pdftext.ts` already carries it on every item.
 *
 * These fixtures are laid out the way the real pages are, taken from reading
 * TI's SN65HVD230 page 5 item by item.
 */

let cursor = 0;
function item(str: string, x: number, y: number, width = str.length * 5, height = 8): TextItem {
  const start = cursor;
  cursor += str.length + 1;
  return { str, x, y, width, height, start, end: start + str.length };
}

function page(items: TextItem[]): PageText {
  return { page: 5, text: "", items, start: 0, end: 0, width: 612, height: 792 };
}

test("a wrapped description lands on the row it belongs to", () => {
  // The shape that defeats every line-based reader: the description of pin 1
  // sits ABOVE pin 1, and its tail sits below.
  const table = readPinTableFromPage(
    page([
      item("CAN transmit data input, also called TXD", 173, 480),
      item("D", 57, 476),
      item("1", 107, 476),
      item("I", 149, 476),
      item("input", 173, 472),
      item("GND", 57, 458),
      item("2", 107, 458),
      item("GND", 141, 458),
      item("Ground connection", 173, 458)
    ])
  );

  assert.ok(table, "a two-row table is enough");
  assert.equal(table.pins.length, 2);
  assert.equal(table.pins[0].name, "D");
  assert.equal(table.pins[0].type, "I");
  assert.match(table.pins[0].description, /CAN transmit data input/);
  assert.match(table.pins[0].description, /input$/, "the tail below the row belongs to it too");
  assert.equal(table.pins[1].name, "GND");
});

test("a name split across baselines by a subscript is rejoined", () => {
  // "V" over "ref", with the number sitting lower than either.
  const table = readPinTableFromPage(
    page([
      item("V", 57, 410),
      item("ref", 62, 408),
      item("5", 107, 404),
      item("O", 147, 410),
      item("VCC / 2 reference output pin", 173, 410),
      item("CANL", 57, 384),
      item("6", 107, 384),
      item("I/O", 144, 384),
      item("Low level CAN bus line", 173, 384),
      item("CANH", 57, 370),
      item("7", 107, 370),
      item("I/O", 144, 370),
      item("High level CAN bus line", 173, 370),
      item("D", 57, 424),
      item("4", 107, 424),
      item("O", 147, 424),
      item("output", 173, 424),
      item("A", 57, 440),
      item("3", 107, 440),
      item("I", 147, 440),
      item("third", 173, 440),
      item("B", 57, 456),
      item("2", 107, 456),
      item("I", 147, 456),
      item("second", 173, 456),
      item("C", 57, 472),
      item("1", 107, 472),
      item("I", 147, 472),
      item("first", 173, 472)
    ])
  );

  assert.ok(table);
  assert.equal(table.pins.length, 7);
  assert.equal(table.pins[4].number, "5");
  assert.equal(table.pins[4].name, "Vref", "the subscript is part of the name, not a row of its own");
});

test("the column headings are not read as the first pin", () => {
  // They sit above pin 1 and would otherwise be pulled in, which produced names
  // like "NAMESwitchCollectorPIN".
  const table = readPinTableFromPage(
    page([
      item("NAME", 57, 494),
      item("NO.", 102, 494),
      item("TYPE", 139, 500),
      item("DESCRIPTION", 337, 500),
      item("D", 57, 476),
      item("1", 107, 476),
      item("I", 149, 476),
      item("first", 173, 476),
      item("GND", 57, 458),
      item("2", 107, 458),
      item("GND", 141, 458),
      item("second", 173, 458)
    ])
  );

  assert.ok(table);
  assert.equal(table.pins[0].name, "D", "the heading row is out of reach");
});

test("a two-column pinout diagram is refused", () => {
  // The number column is there and reads 1..N, but the cells to its right are
  // the opposite side's pin numbers, not types. This is what an INA240 produced
  // before the type column was checked: `1:IN+[7 REF1]`.
  const table = readPinTableFromPage(
    page([
      item("D", 104, 628),
      item("1", 139, 628),
      item("8", 199, 628),
      item("RS", 233, 628),
      item("GND", 94, 610),
      item("2", 139, 610),
      item("7", 199, 610),
      item("CANH", 233, 610),
      item("VCC", 96, 592),
      item("3", 139, 592),
      item("6", 199, 592),
      item("CANL", 233, 592)
    ])
  );

  assert.equal(table, null, "a figure is not a table just because it numbers things");
});

test("a bond-pad coordinate table is refused", () => {
  // REF5025 has one, numbered 1..N, with coordinates where the type belongs.
  const table = readPinTableFromPage(
    page([
      item("NC", 57, 470),
      item("1", 107, 470),
      item("35.45", 150, 470),
      item("46.55", 220, 470),
      item("NC", 57, 456),
      item("2", 107, 456),
      item("496.75", 150, 456),
      item("56.55", 220, 456),
      item("VIN", 57, 442),
      item("3", 107, 442),
      item("607.45", 150, 442),
      item("56.55", 220, 442)
    ])
  );

  assert.equal(table, null);
});

test("a gapped number column is refused", () => {
  const table = readPinTableFromPage(
    page([
      item("A", 57, 470),
      item("1", 107, 470),
      item("I", 147, 470),
      item("first", 173, 470),
      item("B", 57, 456),
      item("3", 107, 456),
      item("I", 147, 456),
      item("third", 173, 456)
    ])
  );

  assert.equal(table, null, "1 and 3 is not a whole table");
});

test("a table ordered by name rather than by number is still read", () => {
  // The proof is the set, not the order. TI and ADI both ship tables sorted
  // alphabetically, and requiring document order refused all of them.
  const table = readPinTableFromPage(
    page([
      item("EN1", 57, 470),
      item("3", 107, 470),
      item("I", 147, 470),
      item("enable", 173, 470),
      item("GND1", 57, 456),
      item("1", 107, 456),
      item("GND", 147, 456),
      item("ground", 173, 456),
      item("VCC", 57, 442),
      item("2", 107, 442),
      item("Power", 147, 442),
      item("supply", 173, 442)
    ])
  );

  assert.ok(table);
  assert.deepEqual(
    table.pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:GND1", "2:VCC", "3:EN1"],
    "returned in pin order however the page listed them"
  );
});

test("a datasheet covering several devices is refused, not guessed at", () => {
  // An OPA2277 datasheet carries the dual's 8-pin table and the quad's 14-pin
  // table. Taking the longer one, which is what this did first, silently returns
  // the wrong part's pinout. Nothing here knows which variant was asked for.
  const dual = page([
    item("OUT", 57, 470), item("1", 107, 470), item("O", 147, 470), item("out", 173, 470),
    item("IN", 57, 456), item("2", 107, 456), item("I", 147, 456), item("in", 173, 456)
  ]);
  const quad = { ...page([
    item("OUTA", 57, 470), item("1", 107, 470), item("O", 147, 470), item("a", 173, 470),
    item("INA", 57, 456), item("2", 107, 456), item("I", 147, 456), item("b", 173, 456),
    item("INB", 57, 442), item("3", 107, 442), item("I", 147, 442), item("c", 173, 442)
  ]), page: 5 };

  assert.ok(readPinTableFromPage(dual), "each page on its own reads fine");
  assert.ok(readPinTableFromPage(quad));

  const doc = { text: "", pages: [dual, quad], pageCount: 2, truncated: false };
  assert.equal(
    extractPinTableByGeometry(doc as never),
    null,
    "two tables of different lengths is an ambiguity, not a choice"
  );
});

test("one table of a given length is still read when the pages agree", () => {
  const first = page([
    item("OUT", 57, 470), item("1", 107, 470), item("O", 147, 470), item("out", 173, 470),
    item("IN", 57, 456), item("2", 107, 456), item("I", 147, 456), item("in", 173, 456)
  ]);
  const doc = { text: "", pages: [first], pageCount: 1, truncated: false };
  const table = extractPinTableByGeometry(doc as never);
  assert.ok(table);
  assert.equal(table.pins.length, 2);
});

test("a multi-variant table is read from the column that names the part", () => {
  // An ISO7741 datasheet carries one pin-number column per device, headed
  // ISO7740, ISO7741, ISO7742. Reading the wrong column returns a pinout for a
  // part nobody asked about, so the heading has to match exactly.
  const items = [
    item("ISO7740", 113, 444), item("ISO7741", 167, 444), item("NAME", 59, 444),
    item("Type", 274, 444), item("DESCRIPTION", 402, 444),
    item("VCC1", 59, 424), item("1", 125, 424), item("1", 180, 424),
    item("I", 285, 424), item("supply one", 305, 424),
    item("GND1", 59, 406), item("2", 125, 406), item("2", 180, 406),
    item("GND", 285, 406), item("ground", 305, 406),
    item("INA", 59, 388), item("3", 125, 388), item("3", 180, 388),
    item("I", 285, 388), item("channel A", 305, 388)
  ];

  const chosen = readPinTableFromPage(page(items), "ISO7741");
  assert.ok(chosen, "the ISO7741 column is identified by its heading");
  assert.equal(chosen.pins.length, 3);
  assert.equal(chosen.pins[0].name, "VCC1");
  assert.equal(chosen.pins[0].type, "I", "the sibling variant's numbers are not read as the type");

  assert.equal(
    readPinTableFromPage(page(items), "ISO7742"),
    null,
    "a part with no column of its own is refused rather than given a neighbour's"
  );
  assert.equal(
    readPinTableFromPage(page(items)),
    null,
    "and with no part number there is nothing to choose with"
  );
});

test("a column whose first row is blank still finds the shared heading", () => {
  // The ISO7740 column starts two rows lower than the ISO7741 one, because its
  // first pin does not exist on that device. Looking for the heading above each
  // column's own top put it out of reach and made a multi-variant table look
  // like a single-variant one.
  const items = [
    item("ISO7740", 113, 444), item("ISO7741", 167, 444), item("NAME", 59, 444),
    item("EN1", 59, 424), item("—", 125, 424), item("1", 180, 424),
    item("I", 285, 424), item("enable", 305, 424),
    item("VCC", 59, 406), item("1", 125, 406), item("2", 180, 406),
    item("P", 285, 406), item("supply", 305, 406),
    item("GND", 59, 388), item("2", 125, 388), item("3", 180, 388),
    item("GND", 285, 388), item("ground", 305, 388)
  ];

  const table = readPinTableFromPage(page(items), "ISO7740");
  assert.ok(table, "the shorter column is still recognised as a variant column");
  assert.equal(table.pins.length, 2);
  assert.equal(table.pins[0].name, "VCC");
});

test("one name serving several stacked pin numbers is shared, not refused", () => {
  // A device with two grounds prints GND1 once, with its pin numbers stacked
  // above and below the name. Pin 8 owns no name of its own.
  const table = readPinTableFromPage(
    page([
      item("VCC1", 59, 400), item("1", 180, 400), item("P", 285, 400), item("supply", 305, 400),
      item("2", 180, 382),
      item("GND1", 59, 376), item("—", 282, 376), item("Ground connection", 305, 376),
      item("8", 180, 368),
      item("INA", 59, 350), item("3", 180, 350), item("I", 285, 350), item("channel A", 305, 350),
      item("INB", 59, 336), item("4", 180, 336), item("I", 285, 336), item("channel B", 305, 336),
      item("INC", 59, 322), item("5", 180, 322), item("I", 285, 322), item("channel C", 305, 322),
      item("IND", 59, 308), item("6", 180, 308), item("I", 285, 308), item("channel D", 305, 308),
      item("EN1", 59, 294), item("7", 180, 294), item("I", 285, 294), item("enable", 305, 294)
    ])
  );

  assert.ok(table, "a shared name row is a real layout, not a broken read");
  assert.equal(table.pins.length, 8);
  assert.equal(table.pins[1].name, "GND1", "pin 2");
  assert.equal(table.pins[7].name, "GND1", "and pin 8 shares it");
});

test("the footnote under the table is not read as the last pin", () => {
  // An ISO7741's last row reached down and took the legend, coming back named
  // "(1)VCC2I = Input, O = Output". The heading above the table already had a
  // ceiling; this is the same thing at the other end.
  const table = readPinTableFromPage(
    page([
      item("VCC1", 59, 400), item("1", 180, 400), item("P", 285, 400), item("supply", 305, 400),
      item("GND1", 59, 386), item("2", 180, 386), item("GND", 285, 386), item("ground", 305, 386),
      item("(1) I = Input, O = Output", 59, 366)
    ])
  );

  assert.ok(table);
  assert.equal(table.pins.length, 2);
  assert.equal(table.pins[1].name, "GND1", "the legend is out of reach below the last row");
});

/**
 * Caption selection, which is what resolves a datasheet covering several
 * devices on several PAGES.
 *
 * The variant-in-columns case was already handled by matching a column heading.
 * This is the same problem one level up, and the corpus said pin count cannot
 * solve it: an OPA2277 datasheet carries an EIGHT-pin table for the single
 * OPA277 on page 3 and another eight-pin table for the dual OPA2277 on page 4,
 * whose pin 1 is "Offset Trim" in one and "Out A" in the other. A reader
 * choosing by length is flipping a coin between two pinouts that fit the same
 * footprint. The caption above each table is the only thing that tells them
 * apart.
 */

function captioned(caption: string, rows: TextItem[], pageNumber: number): PageText {
  return { ...page([item(caption, 57, 520), ...rows]), page: pageNumber };
}

/** Two pins named for whichever device the table belongs to. */
function opampRows(first: string, second: string): TextItem[] {
  return [
    item(first, 57, 470), item("1", 107, 470), item("O", 147, 470), item("output", 173, 470),
    item(second, 57, 456), item("2", 107, 456), item("I", 147, 456), item("input", 173, 456)
  ];
}

test("the table whose caption names the part is the one that is read", () => {
  const single = captioned("Table 5-1. Pin Functions: OPA277", opampRows("Offset Trim", "-In"), 3);
  const dual = captioned("Table 5-2. Pin Functions: OPA2277", opampRows("Out A", "-In A"), 4);
  const doc = { text: "", pages: [single, dual], pageCount: 2, truncated: false };

  const table = extractPinTableByGeometry(doc as never, "OPA2277");
  assert.ok(table, "a captioned table is not an ambiguity");
  assert.equal(table.page, 4);
  assert.equal(table.pins[0].name, "Out A", "the single's table is the same LENGTH, so only the caption separates them");
  assert.equal(table.claimed, true, "and the caption is a proof about the device, not just the table");
});

test("tables of different lengths are resolved by caption, not refused", () => {
  // The TLV9061 shape: a five-pin single, an eight-pin dual and a sixteen-pin
  // quad, each captioned for its own device. This is what the differing-lengths
  // rule used to refuse outright.
  const single = captioned("Table 5-1. Pin Functions: TLV9061", opampRows("OUT", "V-"), 5);
  const quad = {
    ...captioned("Table 5-6. Pin Functions: TLV9064S", [
      item("IN1+", 57, 470), item("1", 107, 470), item("I", 147, 470), item("a", 173, 470),
      item("V+", 57, 456), item("2", 107, 456), item("P", 147, 456), item("b", 173, 456),
      item("IN2+", 57, 442), item("3", 107, 442), item("I", 147, 442), item("c", 173, 442)
    ], 9)
  };
  const doc = { text: "", pages: [single, quad], pageCount: 2, truncated: false };

  const table = extractPinTableByGeometry(doc as never, "TLV9061");
  assert.ok(table);
  assert.equal(table.pins.length, 2, "the single's table, not the quad's");
});

test("a caption naming a longer device does not claim the shorter part", () => {
  // TLV9061 is a prefix of TLV9061S, which is a DIFFERENT device with a shutdown
  // pin. Prefix matching runs from the request to the caption and never the
  // other way, so this refuses rather than handing back the S variant.
  const shutdown = captioned("Table 5-2. Pin Functions: TLV9061S", opampRows("SHDN", "OUT"), 5);
  const doc = { text: "", pages: [shutdown], pageCount: 1, truncated: false };

  assert.equal(extractPinTableByGeometry(doc as never, "TLV9061"), null);
});

test("an ordering part number is matched to the caption it extends", () => {
  // What a user actually types. The caption is TLV9061; the request carries the
  // package and reel suffix on top of it.
  const single = captioned("Table 5-1. Pin Functions: TLV9061", opampRows("OUT", "V-"), 5);
  const doc = { text: "", pages: [single], pageCount: 1, truncated: false };

  const table = extractPinTableByGeometry(doc as never, "TLV9061IDBVR");
  assert.ok(table);
  assert.equal(table.claimed, true);
});

test("another device's table is dropped rather than left to stand in", () => {
  // The OPA333 case. Its own table is unreadable, so the only table the reader
  // can see is the OPA2333's. One table of consistent length used to be returned
  // unopposed, which is how a single op-amp would have exported the dual's
  // eight-pin pinout.
  const dual = captioned("Pin Functions: OPA2333", opampRows("OUT A", "-IN A"), 4);
  const doc = { text: "", pages: [dual], pageCount: 1, truncated: false };

  assert.equal(extractPinTableByGeometry(doc as never, "OPA333"), null);
  assert.ok(
    extractPinTableByGeometry(doc as never, "OPA2333"),
    "and it is still read for the part it does belong to"
  );
});

test("a table numbering several packages is refused", () => {
  // An OPA333 pin table has a column per package (SOIC, SOT, SC70) and they
  // disagree about which signal sits where. The SOIC column's cells are not a
  // gap-free 1..N from this table's point of view, so the 1..N proof cannot see
  // them, and they were being read as part of the NAME: pin 1 came back called
  // "NCOUT1, 5, 86". Nothing on the page says which package the caller wants.
  const multi = page([
    item("NC", 57, 470), item("1, 5, 8", 90, 470), item("1", 130, 470), item("-", 160, 470), item("no connect", 190, 470),
    item("V-", 57, 456), item("4", 90, 456), item("2", 130, 456), item("P", 160, 456), item("supply", 190, 456),
    item("+IN", 57, 442), item("6", 90, 442), item("3", 130, 442), item("I", 160, 442), item("input", 190, 442)
  ]);

  assert.equal(readPinTableFromPage(multi), null);
});

/**
 * Tables that number several PACKAGES side by side, which is a different thing
 * from several devices and needs a different key.
 *
 * An LM358 prints one column of LCCC pin numbers and one of SOIC numbers against
 * the same signal names. The packages disagree about which pin is where, so the
 * only thing that resolves it is the caller naming the package they are
 * ordering, and even then only when that package's column is the one carrying
 * the 1..N proof.
 */

/** The LM358 shape: a name column, an LCCC column, a SOIC column, type, description. */
function twoPackageTable(): PageText {
  return page([
    item("LCCC", 127, 486),
    item("SOIC, SOT23-8, VSSOP, CDIP", 190, 486),
    item("IN1-", 59, 470), item("5", 137, 470), item("2", 244, 470), item("I", 337, 470), item("negative input", 372, 470),
    item("IN1+", 59, 456), item("7", 137, 456), item("3", 244, 456), item("I", 337, 456), item("positive input", 372, 456),
    item("OUT1", 59, 442), item("2", 137, 442), item("1", 244, 442), item("O", 337, 442), item("output", 372, 442),
    item("V-", 59, 428), item("10", 137, 428), item("4", 244, 428), item("P", 337, 428), item("supply", 372, 428)
  ]);
}

test("a table numbering two packages is read for the package that was named", () => {
  const table = readPinTableFromPage(twoPackageTable(), "LM358", "8-Pin SOIC");

  assert.ok(table, "the SOIC column is the one that reads 1..N");
  assert.deepEqual(
    table.pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:OUT1", "2:IN1-", "3:IN1+", "4:V-"],
    "and the LCCC numbers are dropped rather than read as the name"
  );
});

test("the same table is refused when the package named is the other one", () => {
  // The LCCC column does not read 1..N here, so it cannot be read at all. Taking
  // the provable column instead would return SOIC numbering for a part the
  // caller said was an LCCC, which is the silent wrong answer. This is the
  // INA240 case exactly.
  assert.equal(readPinTableFromPage(twoPackageTable(), "LM358", "20-pin LCCC"), null);
});

test("and refused outright when no package is named", () => {
  assert.equal(readPinTableFromPage(twoPackageTable(), "LM358"), null);
});

test("a row the package does not have keeps its name to itself", () => {
  // A table covering several packages still prints every signal and writes a
  // placeholder where a package has no such pin. That row owns no number, so its
  // name was claimed by whichever numbered row sat nearest: an LM358 pin 8 came
  // back called "NCV+" and an ISO7741 pin 11 "INDNC".
  const table = readPinTableFromPage(
    page([
      item("OUT", 57, 470), item("1", 107, 470), item("O", 147, 470), item("output", 173, 470),
      item("NC", 57, 456), item("—", 107, 456), item("—", 147, 456), item("no internal connection", 173, 456),
      item("V+", 57, 442), item("2", 107, 442), item("P", 147, 442), item("supply", 173, 442)
    ])
  );

  assert.ok(table);
  assert.deepEqual(table.pins.map((pin) => pin.name), ["OUT", "V+"]);
});

/**
 * Captioned tables.
 *
 * The type column was always a PROXY for "are these rows really a pin table",
 * and a caption reading `Table 3. Pin Function Descriptions` answers that
 * question outright. Where the vendor says so, the proxy is waived, which is
 * what lets the common ADI layout be read at all: `Pin No. | Mnemonic |
 * Description` has no type column and puts the number FIRST, so the name sits to
 * the right of it and the usual left-of-the-number rule finds nothing.
 */

/** The AD8232 page 6 shape: caption, heading row, then number-first rows. */
function numberFirstTable(caption: string): PageText {
  return page([
    item(caption, 36, 493),
    item("Pin", 36, 480), item("No.", 51, 480), item("Mnemonic", 75, 480), item("Description", 128, 480),
    item("1", 36, 467), item("HPDRIVE", 75, 467), item("High-Pass Driver Output.", 128, 467),
    item("2", 36, 445), item("+IN", 75, 445), item("Amplifier Positive Input.", 128, 445),
    item("3", 36, 433), item("RLD", 75, 433), item("Right Leg Drive Output.", 128, 433),
    item("4", 36, 421), item("GND", 75, 421), item("Power Supply Ground.", 128, 421)
  ]);
}

test("a captioned pin table is read without a type column", () => {
  const table = readPinTableFromPage(numberFirstTable("Table 3. Pin Function Descriptions"));

  assert.ok(table, "the caption is the vendor saying these rows are a pin table");
  assert.equal(table.captioned, true);
  assert.deepEqual(
    table.pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:HPDRIVE", "2:+IN", "3:RLD", "4:GND"],
    "the name is the column between the number and the heading that says Description"
  );
  assert.equal(table.pins[0].description, "High-Pass Driver Output.");
});

test("the same rows without a caption are still refused", () => {
  // The waiver is exactly as narrow as the caption. Uncaptioned, this shape is
  // indistinguishable from a pinout figure listing its numbers down one side and
  // its names down the other, and reading those as pinouts is what the type
  // column was there to prevent.
  const items = numberFirstTable("Table 3. Pin Function Descriptions").items.slice(1);
  assert.equal(readPinTableFromPage(page(items)), null);
});

test("a figure caption does not waive anything", () => {
  // AD8232 page 6 prints `Figure 2. Pin Configuration` directly above the real
  // table's caption, and the figure's own numbers form a qualifying 1..N band.
  assert.equal(readPinTableFromPage(numberFirstTable("Figure 2. Pin Configuration")), null);
});

test("a port-function table is not a pin table", () => {
  // An MSP430F5529 captions sixteen register maps `Table 9-46. Port P1 (P1.0 to
  // P1.7) Pin Functions`. Only a PACKAGE may qualify the caption, so these do
  // not match and the type column still has to be satisfied.
  assert.equal(
    readPinTableFromPage(numberFirstTable("Table 9-46. Port P1 (P1.0 to P1.7) Pin Functions")),
    null
  );
});

test("a package-qualified caption is recorded", () => {
  const table = readPinTableFromPage(
    numberFirstTable("Table 9. 8-Lead SOIC Pin Function Descriptions")
  );

  assert.ok(table);
  assert.equal(table.packageQualifier, "8-Lead SOIC");
});

/**
 * Two tables stacked in one column, which is the ADR4525 page 11 shape. ADI
 * prints the SOIC table directly above the LCC table and both number 1..8 in the
 * SAME x column, so the band holds sixteen values and eight distinct ones. The
 * no-repeats proof threw the whole page away.
 *
 * They are separated by their captions and NOT by watching for the numbering to
 * restart, which was tried, measured and reverted: cutting a band wherever the
 * numbers go backwards destroys the name-ordered tables this reader supports on
 * purpose. A caption says nothing about ordering.
 */
function stackedTables(): PageText {
  return page([
    item("Table 9. 8-Lead SOIC Pin Function Descriptions", 54, 559),
    item("Pin", 54, 546), item("No.", 70, 546), item("Mnemonic", 118, 546), item("Description", 202, 546),
    item("1", 54, 531), item("NIC", 118, 531), item("Not internally connected.", 202, 531),
    item("2", 54, 518), item("VIN", 118, 518), item("Input voltage connection.", 202, 518),
    item("3", 54, 505), item("GND", 118, 505), item("Ground.", 202, 505),
    item("Table 10. 8-Lead LCC Pin Function Descriptions", 54, 291),
    item("Pin", 54, 278), item("No.", 70, 278), item("Mnemonic", 107, 278), item("Description", 179, 278),
    item("1", 54, 263), item("NIC", 107, 263), item("Not internally connected.", 179, 263),
    item("2", 54, 250), item("VIN", 107, 250), item("Input voltage connection.", 179, 250),
    item("3", 54, 237), item("GNDFORCE", 107, 237), item("Ground connection.", 179, 237)
  ]);
}

test("two captioned tables in one column are read as two tables", () => {
  const tables = readPinTablesFromPage(stackedTables());

  assert.equal(tables.length, 2, "the band holds 1..8 twice and neither half is a fragment");
  assert.deepEqual(tables.map((table) => table.packageQualifier), ["8-Lead SOIC", "8-Lead LCC"]);
  assert.equal(tables[0].pins[2].name, "GND", "the SOIC's third pin");
  assert.equal(tables[1].pins[2].name, "GNDFORCE", "and the LCC's, which is a different signal");
});

test("the package named picks between them", () => {
  const doc = { pages: [stackedTables()], text: "", pageCount: 1 } as never;
  const soic = extractPinTableByGeometry(doc, "ADR4525", "8-Lead SOIC");

  assert.ok(soic);
  assert.equal(soic.pins[2].name, "GND");
  assert.equal(
    extractPinTableByGeometry(doc, "ADR4525", "8-Lead LCC")?.pins[2].name,
    "GNDFORCE"
  );
});

test("and naming no package refuses rather than guessing", () => {
  const doc = { pages: [stackedTables()], text: "", pageCount: 1 } as never;
  assert.equal(extractPinTableByGeometry(doc, "ADR4525"), null);
});

test("a table continued onto the next page is not read as a whole one", () => {
  // An MSP430F5529 prints `Table 7-1. Terminal Functions` over rows 1 to 11 and
  // `Table 7-1. Terminal Functions (continued)` over the rest. The first page on
  // its own is a gap-free 1..11 and reads as a consistent 11-pin part. It has 80.
  const first = numberFirstTable("Table 7-1. Terminal Functions");
  const rest = numberFirstTable("Table 7-1. Terminal Functions (continued)");
  const doc = { pages: [first, { ...rest, page: 6 }], text: "", pageCount: 2 } as never;

  assert.ok(readPinTableFromPage(first), "the page on its own still looks complete");
  assert.equal(extractPinTableByGeometry(doc, "MSP430F5529"), null, "the document says it is not");
});

/**
 * Cells holding GROUPS of pin numbers, which is how ST writes a rad-hard
 * regulator's pinout and how both RHFL4913 and RHFL4913A were unreadable:
 *
 *     Pin name   FLAT-16P        SMD.5   TO-257
 *     VO         1, 2, 6, 7      1       3
 *     VI         3, 4, 5         2       1
 *     GND        13              3       2
 *     NC         9, 11, 12, 15
 *
 * One signal, several positions, one cell. There is no band of bare integers for
 * the ordinary reader to find, so nothing keyed off it. Expanded, the FLAT-16P
 * column is sixteen distinct values spelling 1..16, which is the same
 * self-verifying proof every other reader here uses.
 */
function groupedTable(): PageText {
  return page([
    item("Table 1. Pin description", 247, 394),
    item("Pin name", 89, 375), item("FLAT-16P", 227, 375), item("SMD.5", 373, 375), item("TO-257", 488, 375),
    item("VO", 101, 358), item("1, 2, 6, 7", 234, 358), item("1", 388, 358), item("3", 500, 358),
    item("VI", 103, 341), item("3, 4, 5", 239, 341), item("2", 388, 341), item("1", 500, 341),
    item("GND", 98, 324), item("13", 245, 324), item("3", 388, 324), item("2", 500, 324),
    item("ISC", 101, 308), item("8", 248, 308),
    item("OCM", 97, 291), item("10", 245, 291),
    item("INHIBIT", 92, 275), item("14", 245, 275),
    item("SENSE", 93, 260), item("16", 245, 260),
    item("NC", 101, 244), item("9, 11, 12, 15", 228, 244)
  ]);
}

test("a column of grouped pin numbers is a pin table", () => {
  const tables = readPinTablesFromPage(groupedTable(), "RHFL4913", "FLAT-16P");
  const flat = tables.find((table) => table.pins.length === 16);

  assert.ok(flat, "expanded, the FLAT-16P column spells 1..16");
  assert.deepEqual(
    flat.pins.map((pin) => `${pin.number}:${pin.name}`),
    [
      "1:VO", "2:VO", "3:VI", "4:VI", "5:VI", "6:VO", "7:VO", "8:ISC",
      "9:NC", "10:OCM", "11:NC", "12:NC", "13:GND", "14:INHIBIT", "15:NC", "16:SENSE"
    ],
    "every pin in a cell takes that row's name"
  );
  assert.equal(flat.packageQualifier, "FLAT-16P", "the column heading names the package it numbers");
});

test("the same page read for another package gives that package's pinout", () => {
  // An RHFL4913 is a 16-pin part in FLAT-16P and a 3-pin part in TO-257. Both are
  // correct answers to different questions, which is exactly why the caller is
  // asked rather than guessed for.
  const doc = { pages: [groupedTable()], text: "", pageCount: 1 } as never;
  const to257 = extractPinTableByGeometry(doc, "RHFL4913", "TO-257");

  assert.ok(to257);
  assert.deepEqual(to257.pins.map((pin) => `${pin.number}:${pin.name}`), ["1:VI", "2:GND", "3:VO"]);
});

test("grouped cells need the vendor's caption too", () => {
  // This shape has no type column at all, so the caption is the only evidence the
  // rows are a pinout rather than any other table of numbers. Without it the
  // reader would be a 1..N test on its own, which has already been measured
  // admitting a bond-pad coordinate table.
  const items = groupedTable().items.slice(1);
  assert.equal(readPinTablesFromPage(page(items), "RHFL4913", "FLAT-16P").length, 0);
});

test("a number left of the grouped column rejects it", () => {
  // A TXB0104 numbers two packages side by side, and reading the second one made
  // the first one's cell part of the NAME: pin 2 came back called `A12` and pin 6
  // `NC6,9`. A pin name is never a bare number, so one is enough to reject.
  const withSecondColumn = page([
    ...groupedTable().items,
    // A second package's numbers, sitting between the names and the FLAT column.
    item("1", 180, 358), item("2", 180, 341), item("3", 180, 324),
    item("4", 180, 308), item("5", 180, 291), item("6", 180, 275),
    item("7", 180, 260), item("8", 180, 244)
  ]);

  const tables = readPinTablesFromPage(withSecondColumn, "RHFL4913", "FLAT-16P");
  assert.ok(
    !tables.some((table) => table.pins.some((pin) => /\d/.test(pin.name))),
    "no pin may come back with a number glued into its name"
  );
});

/**
 * Names, which are what the SYMBOL is built from. Every case below was a real
 * wrong name on a part that already ships, found by dumping every extracted
 * pinout in the corpus and reading it against the datasheets rather than by any
 * test failing.
 */

test("a multi-line header stays out of the first row's name", () => {
  // An LM358 spends four printed lines on `PIN / NAME / LCCC / SOIC, SOT23-8,
  // VSSOP, CDIP, PDIP, SO, TSSOP, CFP / I/O / DESCRIPTION`. What is left of it
  // lands in the NAME column of the row nearest below, so pin 2 came back called
  // `IN1–NAMELCCC(1)`, an ISO7741 pin 7 `EN1NAMEISO7740`, a TLV9061 pin 4
  // `IN–NAME`. A pin is never called NAME, so finding a heading word proves the
  // line is header rather than data.
  const table = readPinTableFromPage(
    page([
      item("Table 4-1. Pin Functions", 249, 389),
      item("PIN", 178, 376),
      item("I/O", 336, 364), item("DESCRIPTION", 435, 364),
      item("NAME", 68, 358), item("LCCC", 127, 358),
      item("(1)", 149, 355),
      item("SOIC, SOT23-8, VSSOP, CDIP,", 190, 362),
      item("PDIP, SO, TSSOP, CFP", 200, 353),
      item("IN1-", 59, 339), item("5", 140, 339), item("2", 244, 339), item("I", 340, 339), item("Negative input", 372, 339),
      item("IN1+", 59, 325), item("7", 140, 325), item("3", 244, 325), item("I", 340, 325), item("Positive input", 372, 325),
      item("OUT1", 59, 311), item("2", 140, 311), item("1", 244, 311), item("O", 340, 311), item("Output", 372, 311),
      item("V-", 59, 297), item("10", 137, 297), item("4", 244, 297), item("P", 340, 297), item("supply", 372, 297)
    ]),
    "LM358",
    "8-Pin SOIC"
  );

  assert.ok(table);
  assert.deepEqual(
    table.pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:OUT1", "2:IN1-", "3:IN1+", "4:V-"],
    "no heading word and no footnote marker in any name"
  );
});

test("a sibling device's name does not join this part's pin", () => {
  // SN65HVD230 prints one row per pin and qualifies the differences by device.
  // Pin 5 carries `Vref` for the '230 and '231 and `NC` for the '232, both
  // against the one number, so it came back called `VNCref`; pin 8 came back
  // `RNCS` the same way.
  const family = () =>
    page([
      item("Vref", 57, 410), item("O", 147, 410),
      item("SN65HVD230 and SN65HVD231: reference output pin", 173, 410),
      item("5", 107, 403),
      item("NC", 57, 397), item("NC", 144, 397), item("SN65HVD232: No Connect", 173, 397),
      item("CANL", 57, 384), item("6", 107, 384), item("I/O", 144, 384), item("Low level CAN bus line", 173, 384),
      item("CANH", 57, 370), item("7", 107, 370), item("I/O", 144, 370), item("High level CAN bus line", 173, 370),
      item("D", 57, 356), item("1", 107, 356), item("I", 147, 356), item("CAN transmit data input", 173, 356),
      item("GND", 57, 342), item("2", 107, 342), item("GND", 144, 342), item("Ground connection", 173, 342),
      item("VCC", 57, 328), item("3", 107, 328), item("Supply", 138, 328), item("Supply voltage", 173, 328),
      item("R", 57, 314), item("4", 107, 314), item("O", 147, 314), item("CAN receive data output", 173, 314)
    ]);

  const ours = readPinTableFromPage(family(), "SN65HVD230");
  assert.ok(ours);
  assert.equal(ours.pins[4].name, "Vref", "the '232's NC belongs to another part");

  // And the same page read for the '232 gives the '232's answer.
  const theirs = readPinTableFromPage(family(), "SN65HVD232");
  assert.equal(theirs?.pins[4].name, "NC");
});

test("a description may name another part without losing its text", () => {
  // UCC27524's ENA description cites the UCC27324's pin compatibility. Only the
  // NAME column is protected, so the description keeps what it says.
  const table = readPinTableFromPage(
    page([
      item("ENA", 59, 355), item("1", 115, 355), item("I", 148, 355),
      item("Enable input: compatible with the UCC27324 N/C pin.", 167, 355),
      item("INA", 59, 341), item("2", 115, 341), item("I", 148, 341), item("Input to Channel A", 167, 341)
    ]),
    "UCC27524"
  );

  assert.ok(table);
  assert.equal(table.pins[0].name, "ENA");
  assert.match(table.pins[0].description, /UCC27324/, "the description is left intact");
});

// ---------------------------------------------------------------------------
// A table continued across pages, joined and proved on the UNION.
//
// Laid out from MSP430F5529 pages 16 to 20, whose `Table 7-1. Terminal
// Functions` runs over five pages and prints four packages' numbering side by
// side. Both halves used to be DROPPED, and that was right at the time: each
// page holds a gap-free run of its own, so the 1..N proof passes on a FRAGMENT
// and the first page alone reads as a consistent 11-pin part. It has 80.
// ---------------------------------------------------------------------------

/** A page with its own number, which the continued-table reader keys off. */
function numbered(pageNumber: number, items: TextItem[]): PageText {
  return { page: pageNumber, text: "", items, start: 0, end: 0, width: 612, height: 792 };
}

/**
 * Two pages of one table. `PN` at x=170 numbers four pins across both pages;
 * `RGC` at x=196 numbers two and stops, which is how a smaller package prints in
 * the same table.
 */
function continuedPages(): PageText[] {
  return [
    numbered(16, [
      item("Table 7-1. Terminal Functions", 236, 672),
      item("NAME", 59, 610), item("1", 170, 610), item("1", 196, 610),
      item("I/O", 279, 610), item("first", 299, 610),
      item("NAMEB", 59, 596), item("2", 170, 596), item("2", 196, 596),
      item("I/O", 279, 596), item("second", 299, 596)
    ]),
    numbered(17, [
      item("Table 7-1. Terminal Functions (continued)", 208, 713),
      item("NAMEC", 59, 650), item("3", 170, 650), item("I/O", 279, 650), item("third", 299, 650),
      item("NAMED", 59, 636), item("4", 170, 636), item("I/O", 279, 636), item("fourth", 299, 636)
    ])
  ];
}

test("a table continued across pages is joined, not thrown away", () => {
  const pages = continuedPages();
  const doc = { text: "", pages, pageCount: 2, truncated: false };

  // Page 16 on its own is a gap-free 1..2 and would read as a complete two-pin
  // part, which is precisely the hazard: the fragment is indistinguishable from a
  // whole table by the per-page proof. What excludes it is the vendor's
  // `(continued)` marker on the OTHER page, so a four-pin answer here is also the
  // evidence that neither fragment was allowed to stand in for the table.
  assert.ok(
    readPinTableFromPage(pages[0]),
    "the fragment does read as a table on its own, which is why it must be excluded by label"
  );

  const table = extractPinTableByGeometry(doc as never, undefined, undefined, 4);
  assert.ok(table, "the union of the halves spells 1..4 and is read");
  assert.equal(table.pins.length, 4, "not the two-pin fragment");
  assert.deepEqual(
    table.pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:NAME", "2:NAMEB", "3:NAMEC", "4:NAMED"],
    "rows from both pages, in pin order"
  );
});

test("two columns that each prove themselves are refused without a declared count", () => {
  // The real ambiguity, measured on MSP430F5529: its PN column is exactly 1..80
  // and its RGC column is exactly 1..64. Both are internally perfect and they
  // describe different packages, so the union proof alone cannot choose.
  const doc = { text: "", pages: continuedPages(), pageCount: 2, truncated: false };

  assert.equal(
    extractPinTableByGeometry(doc as never),
    null,
    "two self-consistent columns and nothing to choose between them"
  );
});

test("a declared count that matches no column refuses rather than picking one", () => {
  // The declared count only ever SELECTS among columns that have each already
  // proved themselves. A wrong one must therefore lose the table, never promote a
  // bad read: this is what stops a front-matter misread from choosing a pinout.
  const doc = { text: "", pages: continuedPages(), pageCount: 2, truncated: false };

  assert.equal(
    extractPinTableByGeometry(doc as never, undefined, undefined, 9),
    null,
    "nothing on the page numbers nine pins"
  );
});

test("a page of a continued table that cannot be read loses the whole table", () => {
  // Half a pinout is what this file refuses everywhere else, and a joined table
  // is not exempt. Pin 4's name is prose, so its page fails and the table goes
  // with it rather than returning pins 1 to 3 of a four-pin part.
  const pages = continuedPages();
  pages[1] = numbered(17, [
    item("Table 7-1. Terminal Functions (continued)", 208, 713),
    item("NAMEC", 59, 650), item("3", 170, 650), item("I/O", 279, 650), item("third", 299, 650),
    // Width given explicitly so the run stays inside the name column: the
    // helper's default is five units per character, which would push a long name
    // across the number column and out of the row entirely.
    item("This sentence is far too long to be any part's pin name", 59, 636, 100),
    item("4", 170, 636), item("I/O", 279, 636), item("fourth", 299, 636)
  ]);
  const doc = { text: "", pages, pageCount: 2, truncated: false };

  assert.equal(
    extractPinTableByGeometry(doc as never, undefined, undefined, 4),
    null,
    "a page that will not read takes the table with it"
  );
});

test("a captioned table may carry a name longer than the ordinary bound", () => {
  // `P4.0/PM_UCB1STE/PM_UCA1CLK` is 26 characters of real MSP430F5529 pin name,
  // and the 24-character bound was the last thing keeping its 80-pin table
  // unreadable. The looser bound is tied to the CAPTION, because the bound exists
  // to catch prose drifting into the name column and the caption is the vendor
  // saying which column that is.
  const long = "P4.0/PM_UCB1STE/PM_UCA1CLK";
  assert.equal(long.length, 26, "the name this bound was raised for");

  const captioned = readPinTableFromPage(
    page([
      item("Table 7-1. Terminal Functions", 236, 500),
      item(long, 59, 470, 100), item("1", 170, 470), item("I/O", 279, 470), item("a", 299, 470),
      item("NAMEB", 59, 456), item("2", 170, 456), item("I/O", 279, 456), item("b", 299, 456)
    ])
  );
  assert.ok(captioned, "the vendor captioned these rows as its pin functions");
  assert.equal(captioned.pins[0].name, long);

  const uncaptioned = readPinTableFromPage(
    page([
      item(long, 59, 470, 100), item("1", 170, 470), item("I/O", 279, 470), item("a", 299, 470),
      item("NAMEB", 59, 456), item("2", 170, 456), item("I/O", 279, 456), item("b", 299, 456)
    ])
  );
  assert.equal(uncaptioned, null, "with no caption the tighter bound still applies");
});

// ---------------------------------------------------------------------------
// TI's current pin-table template: `NAME | NO. | I/O | DESCRIPTION`, continued
// across pages, with a cell that names SEVERAL pins and full-width section
// heading rows inside the table.
//
// Laid out from DRV8825 pages 3 and 4, coordinate for coordinate. Three things
// had to be true at once for this to read, which is why it was unreachable: the
// `14, 28` cell is invisible to a finder that wants a bare integer, the numbering
// is split across two pages so no page proves anything, and the heading rows sit
// at the NAME column's x with no number of their own.
// ---------------------------------------------------------------------------

/**
 * The real column geometry: single digits at x=118, two digits at x=116 and the
 * multi-pin cell at x=109, all centred on x=120, with rows 13.2 apart.
 */
function tiPages(): PageText[] {
  return [
    numbered(3, [
      item("Pin Functions", 273, 490),
      item("NAME", 65, 463.6), item("NO.", 113, 463.6),
      // A full-width section heading INSIDE the table, at the name column's x.
      item("POWER", 57, 450.4), item("AND", 89.6, 450.4), item("GROUND", 109.3, 450.4),
      item("CP1", 57, 437.2), item("1", 117.9, 437.2, 4.4),
      item("I/O", 150.4, 437.2), item("Charge pump", 174, 437.2),
      item("CP2", 57, 424), item("2", 117.9, 424, 4.4),
      item("I/O", 150.4, 424), item("Charge pump", 174, 424),
      // One cell, two pins, and the widest cell in the column, so it is what sets
      // the column's left edge and a left-edge cluster would split it off.
      item("GND", 57, 410.8), item("3, 8", 108.9, 410.8, 22.4),
      item("—", 151.7, 410.8), item("Device ground", 174, 410.8),
      item("CONTROL", 57, 397.6),
      item("AVREF", 57, 384.4), item("4", 117.9, 384.4, 4.4),
      item("I", 154.6, 384.4), item("Bridge A", 174, 384.4)
    ]),
    numbered(4, [
      item("Pin Functions", 244, 709), item("(continued)", 313, 709),
      item("NAME", 65, 680.2), item("NO.", 113, 680.2),
      item("nHOME", 57, 667), item("5", 117.9, 667, 4.4),
      item("OD", 149.7, 667), item("Home", 174, 667),
      item("OUTPUT", 57, 653.8),
      item("AOUT1", 57, 640.6), item("6", 117.9, 640.6, 4.4),
      item("O", 152.6, 640.6), item("Bridge A output", 174, 640.6),
      item("AOUT2", 57, 627.4), item("7", 117.9, 627.4, 4.4),
      item("O", 152.6, 627.4), item("Bridge A output", 174, 627.4)
    ])
  ];
}

test("a continued table with multi-pin cells is read, and its section headings are not names", () => {
  const doc = { text: "", pages: tiPages(), pageCount: 2, truncated: false };

  const table = extractPinTableByGeometry(doc as never, undefined, undefined, 8);
  assert.ok(table, "the union of the two pages spells 1..8 once the cells are expanded");
  assert.deepEqual(
    table.pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:CP1", "2:CP2", "3:GND", "4:AVREF", "5:nHOME", "6:AOUT1", "7:AOUT2", "8:GND"],
    "one cell gives two pins, and no name carries a heading row"
  );

  // The two faults this reader exists to avoid, stated as the values the earlier
  // attempt actually produced on this document.
  const names = table.pins.map((pin) => pin.name);
  assert.ok(!names.includes("CONTROLAVREF"), "the section band above a row is not part of its name");
  assert.ok(!names.includes("OUTPUTAOUT1"), "nor is one on the continuation page");
});

test("the count is taken in pins rather than in cells", () => {
  // Eight pins printed as seven cells. A reader counting cells sees seven,
  // disagrees with the declared eight, and throws away a table that is entirely
  // consistent. TI writes a device's grounds this way constantly.
  const doc = { text: "", pages: tiPages(), pageCount: 2, truncated: false };

  assert.equal(
    extractPinTableByGeometry(doc as never, undefined, undefined, 7),
    null,
    "seven is the number of cells, and it is not what the document declares"
  );
});

test("a name column run that is neither on a row nor a row away refuses the table", () => {
  // The one case the midpoint rule cannot decide. A wrapped name sits a fraction
  // of a row from its number (MSP430F5529 prints `P4.2/PM_UCB1SOMI/` over
  // `PM_UCB1SCL` at 4.8 either side of 13.9-unit rows) and a section heading sits
  // a full row away (DRV8825's are at 13.2 on 13.2-unit rows). Between those two
  // is a wrong pin name waiting to happen, so the table goes instead.
  //
  // Reachable only where the rows are UNEVENLY spaced, which is exactly where a
  // heading row lives: here `CONTROL` is moved into the 26.4-unit gap without
  // landing a clean row from either neighbour.
  const pages = tiPages();
  pages[0].items = pages[0].items.filter((entry) => entry.str !== "CONTROL");
  pages[0].items.push(item("CONTROL", 57, 402));

  assert.equal(
    extractPinTableByGeometry({ text: "", pages, pageCount: 2, truncated: false } as never, undefined, undefined, 8),
    null,
    "too far from either number to be its name and too near to be another row"
  );
});

test("a name wrapped onto a second line is kept whole", () => {
  // The other side of the same rule, from MSP430F5529 page 19: the number is
  // centred on its own cell and the two lines of the name straddle it, so both
  // are nearer to it than to the row above or below.
  const pages = tiPages();
  pages[1] = numbered(4, [
    item("Pin Functions", 244, 709), item("(continued)", 313, 709),
    item("nHOME", 57, 667), item("5", 117.9, 667, 4.4), item("Home", 174, 667),
    item("P4.2/PM_", 57, 645.4, 40), item("6", 117.9, 640.6, 4.4),
    item("UCB1SCL", 57, 635.8, 40), item("Bridge A output", 174, 640.6),
    item("AOUT2", 57, 627.4), item("7", 117.9, 627.4, 4.4), item("Bridge A", 174, 627.4)
  ]);

  const table = extractPinTableByGeometry(
    { text: "", pages, pageCount: 2, truncated: false } as never,
    undefined,
    undefined,
    8
  );
  assert.ok(table, "a straddling wrap is one cell, not two rows");
  assert.equal(
    table.pins.find((pin) => pin.number === "6")?.name,
    "P4.2/PM_UCB1SCL",
    "read down the page and joined, not truncated to either line"
  );
  assert.equal(
    table.pins.find((pin) => pin.number === "7")?.name,
    "AOUT2",
    "and the row below it does not adopt the wrap"
  );
});

// ---------------------------------------------------------------------------
// One table printed as several side-by-side blocks.
//
// Laid out from RHF1201 page 6, which prints 48 pins as `1-24 | 25-48` across one
// page. Neither block starts at 1 and reaches N, so the per-column proof fails on
// both and the table was invisible.
// ---------------------------------------------------------------------------

test("a table printed as two side-by-side blocks is read as one table", () => {
  const table = readPinTableFromPage(
    page([
      item("Table 2. Pin descriptions", 239, 715),
      item("Pin Name", 77, 698), item("Description", 158, 698),
      item("Pin Name", 309, 698), item("Description", 390, 698),
      item("1", 82, 676), item("GNDBI", 110, 676), item("Digital buffer ground", 144, 676, 80),
      item("3", 312, 676), item("SRC", 346, 676), item("Slew rate control input", 377, 676, 80),
      item("2", 82, 653), item("GNDBE", 108, 653), item("Digital buffer ground", 144, 653, 80),
      item("4", 312, 653), item("OEB", 346, 653), item("Output Enable input", 377, 653, 80)
    ])
  );

  assert.ok(table, "the blocks tile 1..4 exactly once");
  assert.deepEqual(
    table.pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:GNDBI", "2:GNDBE", "3:SRC", "4:OEB"]
  );
});

test("columns that number the SAME pins are variants, not blocks", () => {
  // The discriminator, and it needs no vocabulary: blocks of one table number
  // DISJOINT ranges, while variant columns number the same pins twice. An ISO7741
  // prints 1..16 three times and an MSP430F5529 prints 1..80 beside 1..64. Reading
  // either as a continuation would invent a part with twice the pins.
  const table = readPinTableFromPage(
    page([
      item("Table 2. Pin descriptions", 239, 715),
      item("Pin Name", 77, 698), item("Description", 158, 698),
      item("1", 82, 676), item("GNDBI", 110, 676), item("ground", 144, 676, 40),
      item("1", 312, 676), item("SRC", 346, 676), item("slew", 377, 676, 40),
      item("2", 82, 653), item("GNDBE", 108, 653), item("ground", 144, 653, 40),
      item("2", 312, 653), item("OEB", 346, 653), item("enable", 377, 653, 40)
    ])
  );

  assert.notEqual(
    table?.pins.length,
    4,
    "overlapping columns must never be joined into a four-pin part"
  );
});

test("a pin number glued to the cell beside it is recovered only where it fills a gap", () => {
  // RHF1201 draws `3VCCBE` as one text run, so its left block reads 1, 2, 6 and
  // skips 3. The split is accepted because 3 is MISSING from an otherwise
  // contiguous run, which is the numbering corroborating the split rather than the
  // text being trusted on its own.
  const table = readPinTableFromPage(
    page([
      item("Table 2. Pin descriptions", 239, 715),
      item("Pin Name", 77, 698), item("Description", 158, 698),
      item("Pin Name", 309, 698), item("Description", 390, 698),
      item("1", 82, 676), item("GNDBI", 110, 676), item("ground", 144, 676, 40),
      item("5", 312, 676), item("SRC", 346, 676), item("slew", 377, 676, 40),
      item("2", 82, 653), item("GNDBE", 108, 653), item("ground", 144, 653, 40),
      item("6", 312, 653), item("OEB", 346, 653), item("enable", 377, 653, 40),
      // The glued run, spanning the number column and the cell beside it. Its
      // number is INTERIOR to the block, which is what the gap rule can
      // corroborate; see the note on `completeBlock`.
      item("3VCCBE", 82, 630, 74),
      item("7", 312, 630), item("DFSB", 346, 630), item("format", 377, 630, 40),
      item("4", 82, 607), item("NCX", 110, 607), item("spare", 144, 607, 40),
      item("8", 312, 607), item("AVCC", 346, 607), item("supply", 377, 607, 40)
    ])
  );

  assert.ok(table, "the recovered 3 completes 1..8 across both blocks");
  assert.equal(table.pins.length, 8);
  assert.equal(table.pins[2].number, "3");
  assert.equal(table.pins[2].name, "VCCBE", "the number is taken off, the name is kept");
});

test("a pin the vendor leaves unnamed is called NC, not its neighbour's name", () => {
  // Read off a render of RHF1201 page 6: pins 4, 5, 20 and 21 have an EMPTY name
  // cell and the word `NC` in the DESCRIPTION column, while pin 19 beside them has
  // `DR` in Name and `Data ready output` in Description. Both sit at the same x, so
  // no column rule separates them.
  //
  // Left nameless, pin 20 adopts the nearest named row under the stacked-name rule
  // and comes back called `DR`, which is a wrong netlist.
  const table = readPinTableFromPage(
    page([
      item("Table 2. Pin descriptions", 239, 715),
      item("Pin Name", 77, 698), item("Description", 158, 698),
      item("1", 82, 676), item("DR", 110, 676), item("Data ready output", 144, 676, 60),
      item("2", 82, 653), item("NC", 144, 653),
      item("Not connected to the", 227, 657, 60), item("dice", 227, 649, 20),
      item("3", 82, 630), item("VCCBE", 110, 630), item("Digital buffer power", 144, 630, 60)
    ])
  );

  assert.ok(table);
  assert.equal(table.pins[1].name, "NC", "the vendor's own cell, not the row above");
  assert.equal(table.pins[0].name, "DR");
  assert.equal(table.pins[2].name, "VCCBE");
});

test("a description that merely mentions N/C does not rename the pin", () => {
  // The whole cell must be the designator. UCC27524's ENA cites the UCC27324's
  // `N/C` pin midway through its description and is not itself a no-connect.
  const table = readPinTableFromPage(
    page([
      item("Table 2. Pin descriptions", 239, 715),
      item("Pin Name", 77, 698), item("Description", 158, 698),
      item("1", 82, 676), item("ENA", 110, 676),
      item("Enable: compatible with the UCC27324 N/C pin", 144, 676, 60),
      item("2", 82, 653), item("INA", 110, 653), item("Input to channel A", 144, 653, 60)
    ])
  );

  assert.ok(table);
  assert.equal(table.pins[0].name, "ENA", "a mention is not a declaration");
});

test("the name column ends where the description column starts, not at its heading", () => {
  // A vendor does not left-align a heading with the text beneath it: RHF1201
  // prints `Description` at x=158 over descriptions beginning at x=144. Bounding
  // the name by the heading swept the description into it and pin 1 came back
  // called `GNDBIDigitalbufferground`.
  const table = readPinTableFromPage(
    page([
      item("Table 2. Pin descriptions", 239, 715),
      item("Pin Name", 77, 698), item("Description", 158, 698),
      item("1", 82, 676), item("GNDBI", 110, 676), item("Digital buffer ground", 144, 676, 60),
      item("2", 82, 653), item("GNDBE", 108, 653), item("Digital buffer ground", 144, 653, 60)
    ])
  );

  assert.ok(table);
  assert.equal(table.pins[0].name, "GNDBI");
  assert.match(table.pins[0].description, /Digital buffer ground/);
});

// ---------------------------------------------------------------------------
// A number-first table declared by a repeated HEADER ROW, joined across pages.
//
// ISL71001M heads every page `Pin Number | Pin Name | Description` and never
// captions the table. Its cells wrap across lines with a trailing comma, two of
// its numbers are glued to their names, and the table spans pages 6 and 7.
// ---------------------------------------------------------------------------

test("a number-first table headed by a row is read, wrapped cells and all", () => {
  const first = numbered(6, [
    item("Pin Number", 54, 335), item("Pin Name", 120, 335), item("Description", 337, 335),
    // A number glued to its name, recovered because 1 is missing from the run.
    item("1M/S", 74, 315, 30),
    item("2, 3, 4,", 57, 295, 30), item("DGND", 126, 290, 30), item("5, 6", 65, 285, 20)
  ]);
  const second = numbered(7, [
    item("Pin Number", 54, 757), item("Pin Name", 120, 757), item("Description", 337, 757),
    item("7, 8", 63, 732, 20), item("DVDD", 127, 732, 30),
    item("9", 72, 702, 10), item("AGND", 126, 702, 30)
  ]);
  const doc = { text: "", pages: [first, second], pageCount: 2, truncated: false };

  const table = extractPinTableByGeometry(doc as never, undefined, undefined, 9);
  assert.ok(table, "the union of both pages spells 1..9");
  assert.deepEqual(
    table.pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:M/S", "2:DGND", "3:DGND", "4:DGND", "5:DGND", "6:DGND", "7:DVDD", "8:DVDD", "9:AGND"],
    "a cell wrapped onto a second line names all six of its pins"
  );
});

test("a pinout figure above the header row is not read as the table", () => {
  // ISL71001M page 6 draws its pin-assignment figure above the table, and the
  // figure's own number column is a clean contiguous run. Everything above the
  // header row is excluded, which is what keeps it out.
  const only = numbered(6, [
    // The figure: a perfectly good 1..4 that is not this table.
    item("1", 191, 652), item("2", 191, 640), item("3", 191, 628), item("4", 191, 616),
    item("Pin Number", 54, 335), item("Pin Name", 120, 335), item("Description", 337, 335),
    item("1, 2", 57, 315, 20), item("DGND", 126, 315, 30),
    item("3, 4", 57, 295, 20), item("VDD", 126, 295, 30)
  ]);
  const doc = { text: "", pages: [only], pageCount: 1, truncated: false };

  const table = extractPinTableByGeometry(doc as never, undefined, undefined, 4);
  assert.ok(table);
  assert.deepEqual(
    table.pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:DGND", "2:DGND", "3:VDD", "4:VDD"],
    "the table below the header, not the figure above it"
  );
});

test("a lone column that contradicts the declared count is refused, not reported", () => {
  // A single qualifying column is not evidence that it is the right one. Measured
  // on STM32F103C8: its five-page table yields clean contiguous runs at N=60 and
  // N=63 for a part with 48 pins, because the text layer merges cells and drops
  // values out of the column they belong to. Reporting one would hand back a
  // pinout for a package nobody asked for.
  const pages = continuedPages();
  const doc = { text: "", pages, pageCount: 2, truncated: false };

  // Only the four-pin column tiles here, and the document says the part has five.
  assert.equal(
    extractPinTableByGeometry(doc as never, undefined, undefined, 5),
    null,
    "one column, and it disagrees with the count the document declares"
  );
  assert.ok(
    extractPinTableByGeometry(doc as never, undefined, undefined, 4),
    "the same column is read once the count agrees"
  );
});

test("a number locked inside a merged cell run is recovered", () => {
  // A PDF draws in one operation what the table typeset as several cells, so an
  // STM32F103C8 hands over `J7    L10    21`: two BGA ball designators and the
  // LQFP pin number, spanning three columns. Seventeen of that column's 48
  // numbers arrive this way, so the column reads short and the table is
  // unreadable however the columns are found.
  const pages = [
    numbered(16, [
      item("Table 7-1. Terminal Functions", 236, 672),
      item("NAME", 59, 610), item("1", 170, 610), item("I/O", 279, 610), item("first", 299, 610),
      item("NAMEB", 59, 596), item("2", 170, 596), item("I/O", 279, 596), item("second", 299, 596)
    ]),
    numbered(17, [
      item("Table 7-1. Terminal Functions (continued)", 208, 713),
      item("NAMEC", 59, 650), item("3", 170, 650), item("I/O", 279, 650), item("third", 299, 650),
      // Pin 4's number is glued to the cell beside it by a wide gap, which is
      // what separates a column break from a word space.
      // Width chosen so the recovered `4` lands in the number column at x=170,
      // which is what the proportional split has to achieve on a real page.
      item("NAMED", 59, 636), item("J7    4", 140, 636, 35),
      item("I/O", 279, 636), item("fourth", 299, 636)
    ])
  ];
  const doc = { text: "", pages, pageCount: 2, truncated: false };

  const table = extractPinTableByGeometry(doc as never, undefined, undefined, 4);
  assert.ok(table, "the recovered 4 completes 1..4 across both pages");
  assert.deepEqual(
    table.pins.map((pin) => pin.number),
    ["1", "2", "3", "4"],
    "the number locked in the run is recovered into its column"
  );
  // The `J7` half of the run stays left of the number column and so joins the
  // name, which is the hazard the next test refuses on a real page.
  assert.match(table.pins[3].name, /^NAMED/);
});

test("a table naming its pins to the right is read from the right, not the left", () => {
  // An STM32F103C8 prints four packages' BGA ball designators LEFT of its number
  // columns and the pin NAME to the right, so "whatever is left of the number"
  // reads `B2E2` — a ball designator rather than a net.
  //
  // The name band opens after the LAST number column, because this column is
  // CENTRED and its left edge is ragged, and it closes at the TYPE column, which
  // is found by its vocabulary rather than its position for the same reason.
  const table = readPinTableFromPage(
    page([
      item("Table 5. Medium-density pin definitions", 169, 741),
      item("Pin name", 237, 652), item("Type", 311, 640),
      item("A3", 72, 562), item("B2", 93, 562), item("1", 118, 562),
      item("PE2", 248, 562), item("I/O", 301, 562), item("first", 353, 562),
      item("B3", 72, 545), item("A1", 93, 545), item("2", 118, 545),
      item("PE3", 248, 545), item("I/O", 301, 545), item("third", 353, 545),
      // A long name in a centred column starts LEFT of the heading, and wraps.
      item("PC13-TAMPER-", 224, 528, 40), item("3", 118, 522),
      item("RTC", 243, 516, 15), item("I/O", 301, 522), item("second", 353, 522)
    ])
  );

  assert.ok(table, "the header says where the name is");
  assert.deepEqual(
    table.pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:PE2", "2:PE3", "3:PC13-TAMPER-RTC"],
    "no ball designators, no type cells, and the wrapped name read in reading order"
  );
});

/**
 * A TI `Pin Functions` table numbering several PACKAGES side by side, whose
 * cells WRAP and whose names are written as bus RANGES.
 *
 * The geometry is PCF8574's page 2, item by item: four package columns headed
 * `RGT`, `RGY`, `DGV or PW` and `DW or N`, a name column at x=58.9, and rows
 * that give one signal several positions. Two shapes appear here that no reader
 * handled before, and a third that it got silently wrong.
 *
 * Only the RGT and DW columns are laid out below. They are the two the real page
 * makes readable, and they are the pair that proves the point: both number
 * SIXTEEN pins and they disagree about every one of them.
 */
function pcf8574Page(): PageText {
  return {
    ...page([
      item("Table 4-1. Pin Functions", 57, 330),
      item("NAME", 58.9, 315.1, 23.6),
      item("RGT", 105, 306, 14),
      item("DW or N", 259, 306, 30),

      item("A [0..2]", 58.9, 296.4, 25.4),
      item("2, 3, 4", 104.9, 296.4, 22.2),
      item("1, 2, 3", 259.4, 296.4, 22.2),

      item("GND", 58.9, 277.6, 17.8),
      item("9", 113.8, 277.6, 4.4),
      item("8", 268.3, 277.6, 4.4),

      item("INT", 58.9, 263.7, 12.9),
      item("14", 111.5, 263.7, 8.9),
      item("13", 266.1, 263.7, 8.9),

      // The wrapped cell: one logical cell on three baselines, its name printed
      // on the MIDDLE one.
      item("5, 6, 7, 8, ", 99.3, 235.8, 35.6),
      item("4, 5, 6, 7, ", 253.9, 235.8, 35.6),
      item("P[0..7]", 58.9, 226.2, 23.1),
      item("10, 11, 12, ", 97.4, 226.2, 39.4),
      item("9, 10, 11, ", 254.2, 226.2, 35.0),
      item("13", 111.5, 216.6, 8.9),
      item("12", 266.1, 216.6, 8.9),

      item("SCL", 58.9, 202.6, 15.6),
      item("15", 111.5, 202.6, 8.9),
      item("14", 266.1, 202.6, 8.9),

      item("SDA", 58.9, 188.7, 16.4),
      item("16", 111.5, 188.7, 8.9),
      item("15", 266.1, 188.7, 8.9),

      item("VCC", 58.9, 174.7, 16.4),
      item("1", 113.8, 174.7, 4.4),
      item("16", 266.1, 174.7, 8.9)
    ]),
    page: 2
  };
}

test("a pin cell wrapped onto further baselines is read as one cell", () => {
  const tables = readPinTablesFromPage(pcf8574Page(), "PCF8574", "VQFN (RGT)");
  const rgt = tables.find((table) => table.packageQualifier === "RGT");

  assert.ok(rgt, "the RGT column spells 1..16 once its wrapped cell is rejoined");
  assert.equal(rgt.pins.length, 16, "eight of those sixteen come from the wrapped cell alone");
});

test("a pin name written as a bus range names one pin per index", () => {
  const tables = readPinTablesFromPage(pcf8574Page(), "PCF8574", "VQFN (RGT)");
  const rgt = tables.find((table) => table.packageQualifier === "RGT")!;

  assert.deepEqual(
    rgt.pins.map((pin) => `${pin.number}:${pin.name}`),
    [
      "1:VCC", "2:A0", "3:A1", "4:A2",
      "5:P0", "6:P1", "7:P2", "8:P3",
      "9:GND", "10:P4", "11:P5", "12:P6",
      "13:P7", "14:INT", "15:SCL", "16:SDA"
    ],
    "hand-read off the RGT figure on the same page, which numbers it independently"
  );
});

test("a table numbering several packages is not read until one is named", () => {
  assert.deepEqual(
    readPinTablesFromPage(pcf8574Page(), "PCF8574"),
    [],
    "four package columns are a choice, and answering it unasked is a wrong pinout"
  );
});

test("naming one package does not hand back another package's numbering", () => {
  // The failure this exists to prevent. Only the RGT column survives the reader,
  // so judging the ambiguity by what was READ leaves one table that looks
  // unambiguous. It is not: RGT puts VCC at pin 1 and DW puts A0 there.
  const soic = readPinTablesFromPage(pcf8574Page(), "PCF8574", "SOIC (DW)");
  assert.equal(
    soic.find((table) => table.packageQualifier === "RGT"),
    undefined,
    "asking for the SOIC must never return the VQFN column"
  );
});

test("a bus range that does not say which way it runs is refused", () => {
  // `D[7:0]` is conventionally listed MSB first, and the page never says so.
  // Pairing it with ascending pin numbers would invert the bus silently, so the
  // row is refused rather than guessed at.
  const descending = {
    ...page([
      item("Table 4-1. Pin Functions", 57, 330),
      item("NAME", 58.9, 315.1, 23.6),
      item("D [3:0]", 58.9, 296.4, 25.4),
      item("1, 2, 3, 4", 104.9, 296.4, 30),
      item("GND", 58.9, 277.6, 17.8),
      item("5", 113.8, 277.6, 4.4)
    ]),
    page: 2
  };

  assert.deepEqual(readPinTablesFromPage(descending, "X"), [], "no direction, no read");
});

/**
 * A type column written in PHRASES, which is the common house style.
 *
 * The vocabulary that validates a pin table holds single words, and membership
 * was tested against the whole cell. So `Digital input` matched nothing even
 * though both of its words are in the set, and a perfectly ordinary table failed
 * the type check and was discarded whole. Found on ADS8688, whose every row is
 * typed that way.
 *
 * The description column beside it is what keeps the looser rule honest: it
 * starts `Data input for serial communication`, and `DATA` is not type
 * vocabulary, so the two columns stay distinguishable.
 */
test("a type column written in phrases is still a type column", () => {
  const table = readPinTableFromPage(
    page([
      item("SDI", 57, 470), item("1", 107, 470),
      item("Digital input", 147, 470), item("Data input for serial comms", 220, 470),
      item("REFGND", 57, 456), item("2", 107, 456),
      item("Power supply", 147, 456), item("Reference ground pin", 220, 456),
      item("REFCAP", 57, 442), item("3", 107, 442),
      item("Analog output", 147, 442), item("Decoupling capacitor pin", 220, 442),
      item("REFIO", 57, 428), item("4", 107, 428),
      item("Analog input, output", 147, 428), item("Reference in or out", 220, 428)
    ])
  );

  assert.ok(table, "every row is typed, in two words instead of one");
  assert.deepEqual(
    table.pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:SDI", "2:REFGND", "3:REFCAP", "4:REFIO"]
  );
});

test("a description is not mistaken for a type just because it is short", () => {
  // Every cell in the type position here is prose. Widening the vocabulary to
  // phrases must not widen it to sentences, or a bond-pad coordinate table reads
  // as a pinout.
  const table = readPinTableFromPage(
    page([
      item("ROW", 57, 470), item("1", 107, 470),
      item("Bond pad", 147, 470), item("X MIN 35.45", 220, 470),
      item("ROW", 57, 456), item("2", 107, 456),
      item("Bond pad", 147, 456), item("X MAX 41.02", 220, 456),
      item("ROW", 57, 442), item("3", 107, 442),
      item("Bond pad", 147, 442), item("Y MIN 12.80", 220, 442)
    ])
  );

  assert.equal(table, null, "`Bond pad` is not pin-type vocabulary and must not pass");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPinFigureByGeometry, readFiguresFromPage } from "../pinfigure";
import type { PageText, TextItem } from "../pdftext";

/**
 * The pinout figure, read from geometry rather than from the flattened text.
 *
 * Fixtures are laid out the way the real pages are, taken from reading TI's
 * INA240 page 3 and TI's REF5025 page 3 item by item. Both draw TWO packages
 * side by side, which is what makes this harder than it looks.
 */

let cursor = 0;
function item(str: string, x: number, y: number, width = str.length * 5, height = 8): TextItem {
  const start = cursor;
  cursor += str.length + 1;
  return { str, x, y, width, height, start, end: start + str.length };
}

function page(items: TextItem[], pageNumber = 3): PageText {
  return { page: pageNumber, text: "", items, start: 0, end: 0, width: 612, height: 792 };
}

/** One four-pin-a-side figure: names outside, numbers inside, nothing between. */
function figure(originX: number, left: string[], right: string[]): TextItem[] {
  const items: TextItem[] = [];
  left.forEach((name, index) => {
    const y = 546 - index * 18;
    items.push(item(name, originX, y, 20));
    items.push(item(String(index + 1), originX + 40, y, 5));
  });
  right.forEach((name, index) => {
    const y = 546 - index * 18;
    items.push(item(String(left.length * 2 - index), originX + 150, y, 5));
    items.push(item(name, originX + 185, y, 20));
  });
  return items;
}

test("a two-column top view reads, and proves itself by the constant sum", () => {
  const figures = readFiguresFromPage(
    page(figure(80, ["NC", "IN+", "IN-", "GND"], ["OUT", "REF1", "REF2", "VS"]))
  );

  assert.equal(figures.length, 1);
  assert.deepEqual(
    figures[0].pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:NC", "2:IN+", "3:IN-", "4:GND", "5:VS", "6:REF2", "7:REF1", "8:OUT"],
    "the right column descends, so pin 5 is the bottom one"
  );
});

test("numbers that pair to a constant sum but carry no names are not a pinout", () => {
  // An AD590 page one has a self-consistent eight-number layout with nothing
  // beside it. The sum proof passes; it is still not a figure.
  const bare: TextItem[] = [];
  [1, 2, 3, 4].forEach((number, index) => {
    bare.push(item(String(number), 120, 546 - index * 18, 5));
    bare.push(item(String(9 - number), 234, 546 - index * 18, 5));
  });

  assert.deepEqual(readFiguresFromPage(page(bare)), []);
});

test("two packages side by side are not one figure", () => {
  // The defect this was written to catch. A page drawing two packages pairs the
  // FIRST figure's right column with the SECOND figure's left column: both are
  // real halves of real figures, so the pair passes the sum and completeness
  // tests, and it returns a scrambled pinout. An INA240 came back with IN+ at
  // both pin 2 and pin 8.
  const twoUp = page([
    ...figure(80, ["NC", "IN+", "IN-", "GND"], ["OUT", "REF1", "REF2", "VS"]),
    ...figure(360, ["IN-", "GND", "REF2", "NC"], ["IN+", "REF1", "VS", "OUT"])
  ]);

  const figures = readFiguresFromPage(twoUp);
  assert.equal(figures.length, 2, "exactly the two real figures, no cross pair");
  assert.equal(figures[0].pins[0].name, "NC");
  assert.equal(figures[1].pins[0].name, "IN-");
});

test("figures that disagree about a pin are two packages, and are refused", () => {
  // Real, and the reason the count is never taken from a figure alone: an INA240
  // PW package has NC at pin 1 and its D package has IN-.
  const doc = {
    text: "",
    pages: [
      page(figure(80, ["NC", "IN+", "IN-", "GND"], ["OUT", "REF1", "REF2", "VS"]), 3),
      page(figure(80, ["IN-", "GND", "REF2", "NC"], ["IN+", "REF1", "VS", "OUT"]), 9)
    ],
    pageCount: 2,
    truncated: false
  };

  assert.equal(extractPinFigureByGeometry(doc as never), null);
});

test("a figure missing a pin is refused rather than reported short", () => {
  const gapped = page([
    item("NC", 80, 546, 20), item("1", 120, 546, 5), item("8", 234, 546, 5), item("OUT", 269, 546, 20),
    item("IN+", 80, 528, 20), item("2", 120, 528, 5), item("7", 234, 528, 5), item("REF1", 269, 528, 20),
    // pin 3 and pin 6 are simply absent, so the numbers no longer span 1..8
    item("GND", 80, 492, 20), item("4", 120, 492, 5), item("5", 234, 492, 5), item("VS", 269, 492, 20)
  ]);

  assert.deepEqual(readFiguresFromPage(gapped), []);
});

test("the same figure drawn twice is read once and agrees with itself", () => {
  const doc = {
    text: "",
    pages: [page(figure(80, ["NC", "IN+", "IN-", "GND"], ["OUT", "REF1", "REF2", "VS"]), 3)],
    pageCount: 1,
    truncated: false
  };

  const found = extractPinFigureByGeometry(doc as never);
  assert.ok(found);
  assert.equal(found.pins.length, 8);
});

test("a package outline that carries a label is still one figure", () => {
  // The other half of the rule above, and it cost a real part before it existed:
  // an ADG5412 prints "ADG5412/ADG5413" and "TOP VIEW" inside the outline, and
  // requiring the space between the columns to be strictly empty threw the whole
  // sixteen-pin figure away. A label sits on a row or two; a neighbouring
  // figure's names sit on every row.
  const labelled = page([
    ...figure(80, ["IN1", "D1", "S1", "VSS"], ["IN2", "D2", "S2", "VDD"]),
    item("ADG5412/", 150, 546, 40),
    item("TOP VIEW", 150, 528, 40)
  ]);

  const figures = readFiguresFromPage(labelled);
  assert.equal(figures.length, 1);
  assert.deepEqual(
    figures[0].pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:IN1", "2:D1", "3:S1", "4:VSS", "5:VDD", "6:S2", "7:D2", "8:IN2"]
  );
});

/**
 * Caption resolution, which is what makes a page drawing two packages readable.
 *
 * An INA240 draws its PW and its D side by side and they have GENUINELY
 * different pinouts: pin 1 is NC on the TSSOP and IN- on the SOIC, pin 8 is OUT
 * and IN+. Confirmed by rendering page 3, not by reading the text layer. So the
 * two figures disagreeing is not a parse failure, it is the document, and the
 * only thing that resolves it is the package the caller is ordering.
 */

/** A figure with a caption line under it, the way TI sets them. */
function captioned(originX: number, left: string[], right: string[], caption: string): TextItem[] {
  return [
    ...figure(originX, left, right),
    item(caption, originX, 546 - left.length * 18 - 20, caption.length * 6)
  ];
}

function twoPackagePage(): PageText {
  return page([
    ...captioned(80, ["NC", "IN+", "IN-", "GND"], ["OUT", "REF1", "REF2", "VS"],
      "Figure 6-1. INA240 PW Package 8-Pin TSSOP Top View"),
    ...captioned(360, ["IN-", "GND", "REF2", "NC"], ["IN+", "REF1", "VS", "OUT"],
      "Figure 6-2. INA240 D Package 8-Pin SOIC Top View")
  ]);
}

test("two packages drawn side by side are resolved by the declared package", () => {
  const doc = { text: "", pages: [twoPackagePage()], pageCount: 1, truncated: false };

  const tssop = extractPinFigureByGeometry(doc as never, "INA240", "8-pin TSSOP");
  assert.ok(tssop);
  assert.equal(tssop.pins[0].name, "NC", "pin 1 of the TSSOP");
  assert.equal(tssop.pins[7].name, "OUT");

  const soic = extractPinFigureByGeometry(doc as never, "INA240", "8-Pin SOIC");
  assert.ok(soic);
  assert.equal(soic.pins[0].name, "IN-", "and pin 1 of the SOIC, which is a different pin");
});

test("without a package to go on, two disagreeing figures are refused", () => {
  const doc = { text: "", pages: [twoPackagePage()], pageCount: 1, truncated: false };
  assert.equal(extractPinFigureByGeometry(doc as never, "INA240"), null);
});

test("another device's figure is dropped before the package is even considered", () => {
  // An OPA333 datasheet draws the OPA2333's eight-pin SOIC too, and both
  // captions say SOIC, so the package alone cannot separate them.
  const doc = {
    text: "",
    pages: [
      page(captioned(80, ["NC", "-IN", "+IN", "V-"], ["NC", "OUT", "V+", "NC"],
        "OPA333 D Package 8-Pin SOIC"), 3),
      page(captioned(80, ["OUT A", "-IN A", "+IN A", "V-"], ["V+", "OUT B", "-IN B", "+IN B"],
        "OPA2333 D or DGK Package 8-Pin SOIC or VSSOP"), 4)
    ],
    pageCount: 2,
    truncated: false
  };

  const found = extractPinFigureByGeometry(doc as never, "OPA333", "8-pin SOIC");
  assert.ok(found);
  assert.equal(found.page, 3);
  assert.equal(found.pins[0].name, "NC", "the single's own figure, not the dual's");
});

/**
 * Names, which are what the schematic symbol is wired by. Each case below was a
 * real wrong name found by comparing extracted pinouts against the datasheets.
 */

test("a subscript on its own baseline belongs to the name", () => {
  // `VCC` is drawn as `V` at one size with `CC` under it at another, and the pin
  // number beside them is smaller than either. Measured on one SN74LVC1G08 page
  // the drop is 2.27 in the figure at the top and 3.38 in the one below, so a flat
  // tolerance of 3 read the same part as `VCC` in one figure and `V` in the other
  // and the page was refused for disagreeing with itself.
  const figures = readFiguresFromPage(
    page([
      item("A", 464, 660, 8), item("1", 482, 660, 3, 6),
      item("V", 520, 660, 6, 9), item("CC", 526, 656.6, 9, 6), item("6", 506, 660, 3, 6),
      item("B", 463, 646, 8), item("2", 481, 646, 3, 6),
      item("NC", 520, 646, 13), item("5", 506, 646, 3, 6),
      item("GND", 451, 633, 16), item("3", 481, 633, 3, 6),
      item("Y", 520, 633, 6), item("4", 506, 633, 3, 6)
    ])
  );

  assert.equal(figures.length, 1);
  assert.deepEqual(
    figures[0].pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:A", "2:B", "3:GND", "4:Y", "5:NC", "6:VCC"]
  );
});

test("but the row below is never part of the name", () => {
  // The reported text height is not reliably the font size: on an ADG5412 figure
  // the name runs come back tall enough that a height-proportional reach touches
  // the next row, and pin 1 merged into `IN1D1S1`. Names here are stacked in one
  // column, so they are x-adjacent and only the vertical bound separates them.
  const figures = readFiguresFromPage(
    page([
      item("IN1", 128, 668, 14, 18), item("1", 143, 668, 3, 18),
      item("IN2", 205, 668, 14, 18), item("6", 195, 668, 3, 18),
      item("D1", 130, 656, 12, 18), item("2", 143, 656, 3, 18),
      item("D2", 205, 656, 12, 18), item("5", 195, 656, 3, 18),
      item("S1", 130, 644, 12, 18), item("3", 143, 644, 3, 18),
      item("S2", 205, 644, 12, 18), item("4", 195, 644, 3, 18)
    ])
  );

  assert.equal(figures.length, 1);
  assert.deepEqual(
    figures[0].pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:IN1", "2:D1", "3:S1", "4:S2", "5:D2", "6:IN2"]
  );
});

test("a neighbouring figure's name is not this pin's name", () => {
  // Four packages about 100 units apart against a 90 unit reach: an SN74LVC1G08
  // pin 1 came back called `YA`, the left figure's `Y` with this figure's `A`
  // after it, and pin 3 `CCGND`. A name is a contiguous run.
  const figures = readFiguresFromPage(
    page([
      // The neighbour's right-hand names, close enough in x to be reachable.
      item("Y", 425, 660, 6), item("CC", 431, 646, 9),
      item("A", 464, 660, 8), item("1", 482, 660, 3, 6),
      item("VCC", 520, 660, 14), item("4", 506, 660, 3, 6),
      item("GND", 451, 646, 16), item("2", 481, 646, 3, 6),
      item("NC", 520, 646, 13), item("3", 506, 646, 3, 6)
    ])
  );

  const names = figures.flatMap((f) => f.pins.map((pin) => pin.name));
  assert.ok(!names.some((name) => /^YA|CCGND/.test(name)), `no bleed, got ${names.join(",")}`);
});

test("a footnote marker is not part of the name", () => {
  // An OPA333 labels its unconnected pins `NC(1)`, which is not a net.
  const figures = readFiguresFromPage(
    page([
      item("NC(1)", 200, 660, 24), item("1", 240, 660, 3),
      item("NC(1)", 300, 660, 24), item("4", 280, 660, 3),
      item("-IN", 205, 646, 14), item("2", 240, 646, 3),
      item("V+", 300, 646, 10), item("3", 280, 646, 3)
    ])
  );

  assert.equal(figures.length, 1);
  assert.deepEqual(figures[0].pins.map((pin) => pin.name), ["NC", "-IN", "V+", "NC"]);
});

/**
 * Figures that number only their CORNERS, which is how ST draws an RHF310A's
 * ceramic Flat-8: `1` and `8` at the top, `4` and `5` at the bottom, and the four
 * names down each side unnumbered. Four numbers is not eight pins, so the
 * completeness test refused the figure, correctly, and the part had no pinout.
 */

test("a corner-numbered figure is read when the names count out", () => {
  // Fully determined with no free parameter: the corners fix the first and last
  // pin of each column, the name rows fix how many pins the column has, and the
  // two have to agree on both sides.
  const figures = readFiguresFromPage(
    page([
      item("1", 263, 670, 7), item("8", 380, 670, 7),
      item("NC", 180, 652, 18), item("NC", 450, 651, 18),
      item("IN-", 181, 630, 18), item("+VCC", 450, 631, 35),
      item("IN+", 178, 608, 20), item("OUT", 450, 607, 28),
      item("-VCC", 178, 586, 28), item("NC", 450, 586, 17),
      item("4", 263, 566, 7), item("5", 380, 566, 7)
    ])
  );

  assert.equal(figures.length, 1);
  assert.deepEqual(
    figures[0].pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:NC", "2:IN-", "3:IN+", "4:-VCC", "5:NC", "6:OUT", "7:+VCC", "8:NC"],
    "the standard single op-amp pinout"
  );
});

test("but refused when the names do not count out", () => {
  // One name short of the span the corners declare. The arithmetic is the whole
  // safety argument, so a figure that fails it is refused rather than filled in.
  const figures = readFiguresFromPage(
    page([
      item("1", 263, 670, 7), item("8", 380, 670, 7),
      item("NC", 180, 652, 18), item("NC", 450, 651, 18),
      item("IN-", 181, 630, 18), item("+VCC", 450, 631, 35),
      item("IN+", 178, 608, 20), item("OUT", 450, 607, 28),
      item("4", 263, 566, 7), item("5", 380, 566, 7)
    ])
  );

  assert.deepEqual(figures, []);
});

test("and a partially numbered ordinary figure is not guessed at", () => {
  // Three numbered rows is a partial read of a normal figure, not a corner-marked
  // one, and inferring the gaps in one of those is a different and unsafe thing.
  const figures = readFiguresFromPage(
    page([
      item("1", 263, 670, 7), item("8", 380, 670, 7),
      item("2", 263, 640, 7), item("7", 380, 640, 7),
      item("NAME", 180, 655, 24), item("OTHER", 450, 655, 28),
      item("4", 263, 566, 7), item("5", 380, 566, 7)
    ])
  );

  assert.deepEqual(figures, []);
});

/**
 * Four-sided figures. Laid out the way an STM32F407 page 44 is: a rectangle with
 * pins down all four edges, the top and bottom rows set ROTATED so their names
 * sit above and below their numbers rather than beside them.
 *
 * `across` is the rotated ladder. A rotated run's reported width is its length
 * along its own baseline, so these fixtures give the names a width that says
 * nothing about their horizontal extent, exactly as the real pages do.
 */
function quad(perSide: number, names: string[], options: { rowOffset?: number } = {}): TextItem[] {
  const items: TextItem[] = [];
  const pitch = 12;
  const originX = 200;
  const originY = 600;
  const offset = options.rowOffset ?? 0;
  const nameOf = (number: number) => names[number - 1] ?? `P${number}`;

  // Left column: 1..perSide, top to bottom, names to the left.
  for (let index = 0; index < perSide; index += 1) {
    const y = originY - index * pitch;
    items.push(item(nameOf(index + 1), originX - 40, y, 24));
    items.push(item(String(index + 1), originX, y, 6));
  }
  // Bottom row: perSide+1 .. 2*perSide, left to right, names below. Inset from
  // the side columns, which is how these are drawn: the bottom ladder starts one
  // pin in from the corner rather than under the left column.
  for (let index = 0; index < perSide; index += 1) {
    const number = perSide + 1 + index;
    const x = originX + 8 + index * pitch;
    items.push(item(String(number), x, originY - perSide * pitch, 6));
    items.push(item(nameOf(number), x + offset, originY - perSide * pitch - 20, 24));
  }
  // Right column: 2*perSide+1 .. 3*perSide, bottom to top, names to the right.
  for (let index = 0; index < perSide; index += 1) {
    const number = 2 * perSide + 1 + index;
    const y = originY - (perSide - 1 - index) * pitch;
    items.push(item(String(number), originX + perSide * pitch, y, 6));
    items.push(item(nameOf(number), originX + perSide * pitch + 40, y, 24));
  }
  // Top row: 3*perSide+1 .. 4*perSide, right to left, names above.
  for (let index = 0; index < perSide; index += 1) {
    const number = 3 * perSide + 1 + index;
    const x = originX + 8 + (perSide - 1 - index) * pitch;
    items.push(item(String(number), x, originY + pitch, 6));
    items.push(item(nameOf(number), x + offset, originY + pitch + 20, 24));
  }
  return items;
}

const QUAD_NAMES = Array.from({ length: 16 }, (unused, index) => `PA${index + 1}`);

test("a four-sided figure reads, and proves itself by tiling 1..N", () => {
  const figures = readFiguresFromPage(page(quad(4, QUAD_NAMES)));

  assert.equal(figures.length, 1);
  assert.deepEqual(
    figures[0].pins.map((pin) => `${pin.number}:${pin.name}`),
    QUAD_NAMES.map((name, index) => `${index + 1}:${name}`),
    "all four edges, in pin order"
  );
});

test("a four-sided figure whose sides do not tile 1..N is refused", () => {
  // One edge renumbered so the four runs overlap instead of partitioning. Each
  // side is still a perfectly good consecutive run; together they are not a
  // pinout, and the tiling is the only thing that says so.
  const items = quad(4, QUAD_NAMES).map((entry) =>
    entry.str === "13" ? { ...entry, str: "1" } : entry
  );

  assert.deepEqual(readFiguresFromPage(page(items)), []);
});

test("a rotated row's names are paired by ORDER, so a constant offset does not scramble them", () => {
  // The STM32H743 case. Its bottom row arrives as one merged run, so the numbers
  // are recovered with an ESTIMATED x that sits a constant five units left of the
  // names — more than half the pin pitch, which is enough for nearest-name
  // matching to pair every number with its neighbour.
  const figures = readFiguresFromPage(page(quad(4, QUAD_NAMES, { rowOffset: 7 })));

  assert.equal(figures.length, 1);
  assert.deepEqual(
    figures[0].pins.map((pin) => `${pin.number}:${pin.name}`),
    QUAD_NAMES.map((name, index) => `${index + 1}:${name}`),
    "the offset is constant, so the ladders still line up"
  );
});

test("a rotated row whose names do not form one ladder with its numbers is refused", () => {
  // One name moved off the ladder. The offset is no longer constant, which is
  // the check that separates a real pairing from two lists that merely happen to
  // be the same length.
  const items = quad(4, QUAD_NAMES).map((entry) =>
    entry.str === "PA6" ? { ...entry, x: entry.x + 9 } : entry
  );

  assert.deepEqual(readFiguresFromPage(page(items)), []);
});

test("the figure's own caption is not read as a pin name", () => {
  // `Figure 7. LQFP144 pinout` is twenty-four characters, exactly the pin-name
  // limit, and it sits inside the top row's reach. Counted as a name it makes a
  // thirty-seventh entry for thirty-six pins and the figure is lost.
  const items = quad(4, QUAD_NAMES);
  items.push(item("Figure 7. LQFP144 pinout", 224, 600 + 12 + 40, 120));

  const figures = readFiguresFromPage(page(items));
  assert.equal(figures.length, 1);
  assert.equal(figures[0].pins.length, 16);
});

test("a four-sided figure does not displace a two-column one on the same page", () => {
  // The quad reader runs only where the page is otherwise silent, so it can add
  // parts and cannot take any away.
  const items = [...figure(80, ["NC", "IN+", "IN-", "GND"], ["OUT", "REF1", "REF2", "VS"])];
  const figures = readFiguresFromPage(page(items));

  assert.equal(figures.length, 1);
  assert.equal(figures[0].pins.length, 8, "the two-column reader's answer, not a quad");
});

test("figures of different lengths are separated by the count the document declares", () => {
  // An STM32F407 draws its LQFP64, LQFP100, LQFP144 and LQFP176 as four complete
  // figures, all captioned with the FAMILY name, so neither the device nor the
  // package claim tells them apart. The ordering scheme on the same document says
  // this part has 100 pins, and exactly one figure has 100.
  const doc = {
    text: "",
    pages: [page(quad(4, QUAD_NAMES), 3), page(quad(5, QUAD_NAMES.concat(["PA17", "PA18", "PA19", "PA20"])), 4)],
    pageCount: 2,
    truncated: false
  };

  assert.equal(extractPinFigureByGeometry(doc as never, "STM32"), null, "no count, so no basis for choosing");

  const chosen = extractPinFigureByGeometry(doc as never, "STM32", undefined, 20);
  assert.ok(chosen);
  assert.equal(chosen.pins.length, 20, "the twenty-pin figure, chosen by the declared count");

  assert.equal(
    extractPinFigureByGeometry(doc as never, "STM32", undefined, 40),
    null,
    "a count matching no figure refuses rather than promoting one"
  );
});

/**
 * Asymmetric two-column figures: a five-pin SOT has three leads down one side
 * and two down the other, so no two numbers pair to a constant and the rows do
 * not line up. Laid out the way an AD8628 page one is.
 */
function asymmetric(originX: number, left: string[], right: string[]): TextItem[] {
  const items: TextItem[] = [];
  const pitch = 20;
  left.forEach((name, index) => {
    const y = 600 - index * pitch;
    items.push(item(name, originX, y, 20));
    items.push(item(String(index + 1), originX + 40, y, 5));
  });
  const total = left.length + right.length;
  right.forEach((name, index) => {
    // The right column skips the middle row, which is what makes it asymmetric.
    const y = 600 - index * pitch * 2;
    items.push(item(String(total - index), originX + 150, y, 5));
    items.push(item(name, originX + 185, y, 20));
  });
  return items;
}

test("an asymmetric figure reads, and proves itself by the two sides tiling 1..N", () => {
  const figures = readFiguresFromPage(page(asymmetric(80, ["OUT", "V-", "+IN"], ["V+", "-IN"])));

  assert.equal(figures.length, 1);
  assert.deepEqual(
    figures[0].pins.map((pin) => `${pin.number}:${pin.name}`),
    ["1:OUT", "2:V-", "3:+IN", "4:-IN", "5:V+"],
    "the left column ascends from 1 and the right descends from N"
  );
});

test("an asymmetric figure whose columns do not meet in the middle is refused", () => {
  // The right column starts at 6 for a five-pin part, so the two runs overlap
  // instead of partitioning. Each side is still consecutive on its own.
  const items = asymmetric(80, ["OUT", "V-", "+IN"], ["V+", "-IN"]).map((entry) =>
    entry.str === "5" ? { ...entry, str: "6" } : entry
  );

  assert.deepEqual(readFiguresFromPage(page(items)), []);
});

test("an asymmetric figure that does not start at pin 1 is refused", () => {
  const items = asymmetric(80, ["OUT", "V-", "+IN"], ["V+", "-IN"]).map((entry) =>
    entry.str === "1" ? { ...entry, str: "9" } : entry
  );

  assert.deepEqual(readFiguresFromPage(page(items)), []);
});

test("equal-length columns are left to the constant-sum reader, not read as asymmetric", () => {
  // A symmetric figure the sum proof declined is not something to read a second
  // way. Pin 4 is missing here, so the sum reader refuses; the asymmetric reader
  // must not step in and report a three-pin part.
  const items = figure(80, ["NC", "IN+", "IN-", "GND"], ["OUT", "REF1", "REF2", "VS"]).filter(
    (entry) => entry.str !== "4" && entry.str !== "GND"
  );

  assert.deepEqual(readFiguresFromPage(page(items)), []);
});

test("a name whose run was drawn in an order its string does not describe is refused", () => {
  // An RHF310A prints pin 4 as `VCC-` and hands the run over as `-VCC` with a
  // NEGATIVE advance, because the glyphs were positioned right to left. Emitting
  // it gives a pin nobody can connect, so the name is dropped and the figure
  // comes up short.
  const items = figure(80, ["NC", "IN-", "IN+", "VCC-"], ["NC", "OUT", "+VCC", "NC"]).map((entry) =>
    entry.str === "VCC-" ? { ...entry, str: "-VCC", width: -1.1 } : entry
  );

  assert.deepEqual(readFiguresFromPage(page(items)), []);
});

// ---------------------------------------------------------------------------
// `packageClaimed`: whether the figure says WHICH package it draws
//
// The standing objection to a lone geometric figure is not that it might be
// incomplete, since the constant-sum proof settles that, but that a datasheet
// draws several packages and a complete pinout does not say which one it is. So
// the caller holds the count back until something else vouches for it. A caption
// naming the package that was ASKED for answers that objection in the
// document's own words, and this flag is how the caller learns it was answered.
// ---------------------------------------------------------------------------

test("a figure separated by its package caption says so", () => {
  const doc = { text: "", pages: [twoPackagePage()], pageCount: 1, truncated: false };

  const tssop = extractPinFigureByGeometry(doc as never, "INA240", "8-pin TSSOP");
  assert.ok(tssop);
  assert.equal(tssop.packageClaimed, true, "the caption named the package that was asked for");
});

test("a figure that nothing had to separate makes no such claim", () => {
  // One figure, no ambiguity to resolve, so the package claim was never
  // consulted. This is the AD590 shape: its document draws a single eight-pin
  // SOIC while the part is a two-lead flatpack, and nothing about that lone
  // figure says it is the package the caller holds.
  const doc = {
    text: "",
    pages: [page(captioned(80, ["NC", "IN+", "IN-", "GND"], ["OUT", "REF1", "REF2", "VS"],
      "Figure 1. Top View"))],
    pageCount: 1,
    truncated: false
  };

  const only = extractPinFigureByGeometry(doc as never, "ACME590", "2-lead FLATPACK");
  assert.ok(only, "a lone agreeing figure is still returned");
  assert.notEqual(only.packageClaimed, true, "but it does not claim to be the requested package");
});

test("a figure picked by the declared COUNT makes no package claim either", () => {
  // Two figures the caption cannot separate, resolved by the declared count.
  // That proves which figure has the right number of pins, which is the very
  // thing the count was being held back to check, so it may not double as its
  // own corroboration.
  const doc = {
    text: "",
    pages: [
      page([
        ...captioned(80, ["NC", "IN+", "IN-", "GND"], ["OUT", "REF1", "REF2", "VS"],
          "Figure 1. ACME40xxx Top View"),
        ...captioned(360, ["A", "B", "C"], ["D", "E", "F"], "Figure 2. ACME40xxx Top View")
      ])
    ],
    pageCount: 1,
    truncated: false
  };

  const byCount = extractPinFigureByGeometry(doc as never, "ACME40100", undefined, 6);
  assert.ok(byCount, "the count selects among figures that each proved themselves");
  assert.equal(byCount.pins.length, 6);
  assert.notEqual(byCount.packageClaimed, true, "the count is not a package claim");
});

// ---------------------------------------------------------------------------
// A family caption, and a SIBLING's caption, which look alike and are opposite
//
// Both fail an exact comparison against the part number, and treating them the
// same way is how a family datasheet hands back another device's pinout. The
// figure that comes back is complete, self-consistent, and wrong by 36 pins,
// which is the worst shape a defect can have here: nothing downstream can tell.
// ---------------------------------------------------------------------------

test("a caption naming the FAMILY with a wildcard still belongs to this part", () => {
  // An STM32F407VG's document captions all four of its figures `STM32F40xxx`,
  // so nothing but the declared count can separate them. Dropping them for not
  // saying `STM32F407VG` would lose the part entirely.
  const doc = {
    text: "",
    pages: [
      page([
        ...captioned(80, ["NC", "IN+", "IN-", "GND"], ["OUT", "REF1", "REF2", "VS"],
          "Figure 12. STM32F40xxx LQFP8 pinout"),
        ...captioned(360, ["A", "B", "C"], ["D", "E", "F"], "Figure 13. STM32F40xxx LQFP6 pinout")
      ])
    ],
    pageCount: 1,
    truncated: false
  };

  const byCount = extractPinFigureByGeometry(doc as never, "STM32F407VG", undefined, 6);
  assert.ok(byCount, "a wildcard family caption is this part's");
  assert.equal(byCount.pins.length, 6);
});

test("a caption naming a SIBLING device is not this part's, and nothing falls back to it", () => {
  // The STM32L476RG shape: a 64-pin part whose family document draws the 100-pin
  // STM32L476Vx. The `V` is fixed, not a wildcard, and it is exactly the
  // character that encodes the pin count.
  const doc = {
    text: "",
    pages: [
      page(captioned(80, ["NC", "IN+", "IN-", "GND"], ["OUT", "REF1", "REF2", "VS"],
        "Figure 11. STM32L476Vx LQFP8 pinout"))
    ],
    pageCount: 1,
    truncated: false
  };

  assert.equal(
    extractPinFigureByGeometry(doc as never, "STM32L476RG", "LQFP8"),
    null,
    "a sibling's complete figure is not an answer for this part"
  );
});

test("a package named in a caption is not read as the device that owns the figure", () => {
  // `Figure 12. STM32F40xxx LQFP64 pinout` names one device and one package. The
  // device token was invisible for being mixed-case, so `LQFP64` was taken as the
  // device, matched nothing, and every figure on the document looked like another
  // part's.
  const doc = {
    text: "",
    pages: [
      page(captioned(80, ["NC", "IN+", "IN-", "GND"], ["OUT", "REF1", "REF2", "VS"],
        "Figure 3. ACME192 LQFP8 pinout"))
    ],
    pageCount: 1,
    truncated: false
  };

  const found = extractPinFigureByGeometry(doc as never, "ACME192", "LQFP8");
  assert.ok(found, "the caption names this device and a package, not another device");
  assert.equal(found.pins.length, 8);
});

test("a caption naming ONLY a glued package still names no device", () => {
  // `Figure 9. TSSOP20 20-pin package pinout` names a package and nothing else,
  // which is how most figures on a single-part datasheet are captioned. Reading
  // `TSSOP20` as a device name drops the only pinout the document has. The lead
  // count has to come off before the family is recognisable, because `\bTSSOP\b`
  // does not match `TSSOP20`.
  const doc = {
    text: "",
    pages: [
      page(captioned(80, ["NC", "IN+", "IN-", "GND"], ["OUT", "REF1", "REF2", "VS"],
        "Figure 9. TSSOP8 8-pin package pinout"))
    ],
    pageCount: 1,
    truncated: false
  };

  const found = extractPinFigureByGeometry(doc as never, "ACME192", "TSSOP8");
  assert.ok(found, "a caption naming only a package belongs to whatever part the document is about");
  assert.equal(found.pins.length, 8);
});

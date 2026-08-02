import { test } from "node:test";
import assert from "node:assert/strict";
import { readDrawingDimensions } from "../drawingdimensions";
import type { PageText, TextItem } from "../pdftext";

/**
 * Reading dimensions off the mechanical drawing without a model.
 *
 * The fixtures reproduce the two layouts measured on real TI drawings, because
 * the difference between them is exactly what defeated the earlier attempts:
 *
 *   inline   `6X 1.27`   arrives as ONE text item
 *   stacked  `8X`        sits BETWEEN 0.482 above and 0.382 below, not beside
 *
 * Scored in the probe against the four families whose lead dimensions were read
 * off real drawings by hand and are pinned in `packages.ts`: pitch 4/5, lead
 * width 4/5, exact.
 */

let cursor = 0;
function item(str: string, x: number, y: number): TextItem {
  const start = cursor;
  cursor += str.length + 1;
  return { str, x, y, width: str.length * 5, height: 8, start, end: start + str.length };
}

/**
 * A drawing page: the heading, scattered values, and the count labels.
 *
 * `title` matters as much as the values. A datasheet prints one drawing per
 * package it offers and the reader refuses any page that is not titled for the
 * package being asked about, so the title is what makes the page eligible at
 * all. Real form, from the drawings measured: `PACKAGE OUTLINE DW0016B SOIC`.
 */
function drawingPage(labels: TextItem[], pageNumber = 29, title = "CFP - 2.861 mm max height"): PageText {
  const scatter = ["9.91", "9.55", "6.65", "6.30", "2.861", "2.325", "0.18", "0.10", "4.65", "4.25"].map(
    (value, index) => item(value, 70 + index * 41, 400 - index * 23)
  );
  return {
    page: pageNumber,
    text: `PACKAGE OUTLINE\n${title}`,
    items: [...scatter, ...labels],
    start: 0,
    end: 40,
    width: 612,
    height: 792
  };
}

function doc(page: PageText) {
  return { text: page.text, pages: [page], pageCount: 1, truncated: false };
}

test("an inline count label gives the pitch, checked against the pin count", () => {
  // LMP7704-SP: 14 pins, seven a side, so six gaps a side and the drawing says 6X.
  const read = readDrawingDimensions(
    doc(drawingPage([item("6X 1.27", 512, 560)])) as never,
    "14-lead CFP",
    14
  );

  assert.ok(read);
  assert.equal(read.pitchMm?.value, 1.27);
  assert.ok(read.pitchMm?.citation, "and it carries a citation back into the document");
});

test("a count that is not arithmetic on the pin count is not the pitch", () => {
  // 2X 7.62 is a row spacing on the same drawing. Nothing but the count
  // separates it from the pitch, which is the whole point of using the count.
  const read = readDrawingDimensions(
    doc(drawingPage([item("2X 7.62", 507, 540)])) as never,
    "14-lead CFP",
    14
  );

  assert.ok(read);
  assert.equal(read.pitchMm, null);
});

test("a stacked count label gives the lead width", () => {
  // The layout a same-baseline search misses: the count sits between its values.
  const read = readDrawingDimensions(
    doc(
      drawingPage([
        item("8X", 463, 500),
        item("0.482", 475, 505),
        item("0.382", 475, 495)
      ])
    ) as never,
    "14-lead CFP",
    14
  );

  assert.ok(read);
  assert.deepEqual(read.leadWidthMm?.value, { minMm: 0.382, maxMm: 0.482 });
});

test("both come off one drawing together", () => {
  const read = readDrawingDimensions(
    doc(
      drawingPage([
        item("6X 1.27", 512, 560),
        item("8X", 463, 500),
        item("0.482", 475, 505),
        item("0.382", 475, 495)
      ])
    ) as never,
    "14-lead CFP",
    14
  );

  assert.ok(read);
  assert.equal(read.pitchMm?.value, 1.27);
  assert.deepEqual(read.leadWidthMm?.value, { minMm: 0.382, maxMm: 0.482 });
  assert.equal(read.page, 29);
});

test("an untagged pair is not a lead width", () => {
  // The lead THICKNESS pair (0.18/0.10) is the same shape and a similar
  // magnitude. What separates them is that a drawing tags the width with a count
  // and leaves the thickness untagged.
  const read = readDrawingDimensions(doc(drawingPage([])) as never, "14-lead CFP", 14);

  assert.ok(read === null || read.leadWidthMm === null);
});

test("nothing is approximated when the drawing does not say", () => {
  const read = readDrawingDimensions(
    doc(drawingPage([item("6X 1.27", 512, 560)])) as never,
    "14-lead CFP",
    14
  );

  assert.ok(read);
  assert.equal(read.leadWidthMm, null, "absent rather than estimated from the pitch");
});

/**
 * Inch-primary drawings, which are 11 of the 40 cached datasheets.
 *
 * TI dimensions these in inches with millimetres in brackets on the line
 * directly beneath. The bracketed line is read and the inch figure ignored, so
 * no unit conversion happens here and the vendor's own rounding is kept. Before
 * this, the value regex required a leading digit and rejected brackets, so those
 * pages scored almost no values, fell below the drawing threshold, and the whole
 * drawing was invisible. UCC27524's SOIC outline was lost exactly that way.
 */
test("an inch-primary drawing is read from its bracketed millimetres", () => {
  const read = readDrawingDimensions(
    doc(
      drawingPage(
        [
          item("6X  .050", 336, 601),
          item("[1.27]", 351, 593),
          item("8X .012-.020", 331, 447),
          item("[0.31-0.51]", 331, 438)
        ],
        29,
        "D0008A SOIC - 1.75 mm max height"
      )
    ) as never,
    "SOIC-8",
    8
  );

  assert.ok(read);
  assert.equal(read.pitchMm?.value, 1.27, "0.050 inch, taken as the vendor's own 1.27");
  assert.deepEqual(read.leadWidthMm?.value, { minMm: 0.31, maxMm: 0.51 });
});

test("a bracketed line too far from its label is not its value", () => {
  const read = readDrawingDimensions(
    doc(
      drawingPage(
        [item("6X  .050", 336, 601), item("[1.27]", 336, 500)],
        29,
        "D0008A SOIC - 1.75 mm max height"
      )
    ) as never,
    "SOIC-8",
    8
  );

  assert.ok(read === null || read.pitchMm === null);
});

/**
 * The drawing has to be THIS part's package before anything is read off it.
 *
 * This is the rule that costs the most and earns it. Measured on the cache, the
 * page ranking hands an LM358 asking for SOIC its SOT-23-THIN drawing, a
 * UCC27524 its PowerPAD VSSOP drawing and an OPA333 its SOT-23 drawing. Every
 * value on those pages is real and correct and describes a different package,
 * which is the worst shape of wrong number: nothing downstream can tell, and the
 * pitch that comes back (0.65 for all three) is a plausible SOIC-looking figure.
 */
test("a drawing titled for another package is not read", () => {
  const read = readDrawingDimensions(
    doc(
      drawingPage(
        [item("6X 0.65", 512, 560), item("8X 0.22", 512, 500), item("0.38", 560, 500)],
        29,
        "DDF0008A SOT-23-THIN - 1.1 mm max height"
      )
    ) as never,
    "8-Pin SOIC",
    8
  );

  assert.equal(read, null, "the SOT-23 drawing says nothing about the SOIC this part was asked for");
});

test("an outline code whose lead count contradicts the pin count is not read", () => {
  // A DW0016B is a 16-lead outline. Asked about an 8-pin part, the page and the
  // part are not describing the same thing, whatever the title says.
  const read = readDrawingDimensions(
    doc(
      drawingPage([item("6X 1.27", 512, 560)], 46, "DW0016B SOIC - 2.65 mm max height")
    ) as never,
    "8-pin SOIC",
    8
  );

  assert.equal(read, null);
});

test("the outline code is returned, because it is what tells a SOIC from a SOIC", () => {
  const read = readDrawingDimensions(
    doc(
      drawingPage([item("14X 1.27", 512, 560)], 46, "DW0016B SOIC - 2.65 mm max height")
    ) as never,
    "16-pin SOIC",
    16
  );

  assert.ok(read);
  assert.equal(read.code?.code, "DW0016B");
  assert.equal(read.code?.prefix, "DW", "the prefix is the family, and DW is the wide body");
  assert.equal(read.code?.leadCount, 16, "the digits are checkable arithmetic, not decoration");
});

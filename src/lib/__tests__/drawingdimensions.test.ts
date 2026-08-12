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

test("a pitch tagged with the LEAD count is read, not just the gap count", () => {
  // Found 2026-08-10 by dumping the tagged labels on every page where the pitch
  // came back null. An ADS8688 is 38 pins in a DBT0038A and its drawing tags the
  // pitch `38 X 0.5`: the vendor counted the leads, not the gaps between them.
  // The reader wanted 36 or 18 and so read no pitch at all for that part.
  const read = readDrawingDimensions(
    doc(drawingPage([item("38 X 0.5", 512, 560)], 29, "TSSOP - 1.2 mm max height")) as never,
    "TSSOP (38)",
    38
  );

  assert.ok(read);
  assert.equal(read.pitchMm?.value, 0.5);
});

test("a quad package's pitch is read from its four-sided gap count", () => {
  // An MSP430F5529 is 80 pins in an LQFP and tags `76X 0.5`. A quad divides its
  // leads between four sides, so the gaps are 4 * (80/4 - 1) = 76. The reader
  // only knew the dual forms (78 across, 39 a side) and refused it.
  const read = readDrawingDimensions(
    doc(drawingPage([item("76X 0.5", 512, 560)], 29, "LQFP - 1.6 mm max height")) as never,
    "LQFP (80)",
    80
  );

  assert.ok(read);
  assert.equal(read.pitchMm?.value, 0.5);
});

test("a count near the pin count but not arithmetic on it is still refused", () => {
  // The forms widened on 2026-08-10, and widening them is how a drawing's other
  // count-tagged labels start being read as the pitch. `40X` on an 80-pin part
  // is neither the leads, the gaps across, the gaps a side, nor the quad gaps.
  const read = readDrawingDimensions(
    doc(drawingPage([item("40X 0.5", 512, 560)], 29, "LQFP - 1.6 mm max height")) as never,
    "LQFP (80)",
    80
  );

  assert.ok(read);
  assert.equal(read.pitchMm, null);
});

test("the lead width is refused when the drawing tags two pairs that could both be it", () => {
  // An OPA2277's DRM0008A tags `8X 0.38/0.23` for the terminal width and
  // `8X 0.5/0.3` for its length. Both are plausible lead widths against the 0.8
  // pitch and nothing in the TEXT separates them: what does is the direction the
  // dimension runs, and that is carried by arrows this reader cannot see.
  //
  // Taking the first in document order read an ADS1115 wrong; taking the largest
  // read this one wrong. So neither is taken. The null is what puts the field in
  // front of the rendered-page reader, which reads DRM0008A as 0.23-0.38.
  const read = readDrawingDimensions(
    doc(
      drawingPage(
        [
          item("6X 0.8", 300, 600),
          // The width, stacked: the count between its max and its min.
          item("8X", 463, 500),
          item("0.38", 475, 505),
          item("0.23", 475, 495),
          // The terminal LENGTH, tagged exactly the same way.
          item("8X", 463, 420),
          item("0.5", 475, 425),
          item("0.3", 475, 415)
        ],
        29,
        "VSON - 1 mm max height"
      )
    ) as never,
    "8-pin VSON",
    8
  );

  assert.ok(read);
  assert.equal(read.pitchMm?.value, 0.8, "the pitch is unambiguous and is still read");
  assert.equal(read.leadWidthMm, null, "two candidates is not an answer");
});

test("a single plausible width pair is still read", () => {
  // The refusal above must not become a blanket one. An ADS8688's DBT0038A tags
  // exactly one pair inside the pitch, and it is the width.
  const read = readDrawingDimensions(
    doc(
      drawingPage(
        [
          item("36X 0.5", 300, 600),
          item("38X", 463, 500),
          item("0.23", 475, 505),
          item("0.17", 475, 495)
        ],
        29,
        "TSSOP - 1.2 mm max height"
      )
    ) as never,
    "TSSOP (38)",
    38
  );

  assert.ok(read);
  assert.deepEqual(read.leadWidthMm?.value, { minMm: 0.17, maxMm: 0.23 });
});

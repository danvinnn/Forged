import { test } from "node:test";
import assert from "node:assert/strict";
import { findPackageDrawing } from "../packagedrawing";
import type { PageText, TextItem } from "../pdftext";

/**
 * Finding the mechanical drawing so a value we could not read can be asked for
 * with that page already on screen.
 *
 * The thing these lock is the distinction between a drawing and a MENTION of
 * one. A datasheet names its mechanical section in the table of contents and
 * again in the revision history, both of which match the heading and neither of
 * which is the drawing. That is the same failure the pin-section reader hit, and
 * it is separated here the same way: by what the page actually carries.
 */

let cursor = 0;
function item(str: string, x = 100, y = 400): TextItem {
  const start = cursor;
  cursor += str.length + 1;
  return { str, x, y, width: str.length * 5, height: 8, start, end: start + str.length };
}

function page(pageNumber: number, text: string, values: string[]): PageText {
  return {
    page: pageNumber,
    text,
    items: values.map((value, index) => item(value, 100 + index * 20, 400)),
    start: 0,
    end: text.length,
    width: 612,
    height: 792
  };
}

function doc(...pages: PageText[]) {
  return { text: pages.map((p) => p.text).join("\n\n"), pages, pageCount: pages.length, truncated: false };
}

const REAL_VALUES = ["6.65", "6.30", "9.91", "9.55", "25", "21", "1.27", "0.482", "0.382", "2.861"];

test("the drawing page is found by what it carries, not by its heading alone", () => {
  const found = findPackageDrawing(
    doc(
      page(2, "Table of Contents\n10 Mechanical, Packaging, and Orderable Information ..... 29", []),
      page(29, "PACKAGE OUTLINE\nHBH0014A\nCERAMIC FLATPACK", REAL_VALUES)
    ) as never
  );

  assert.ok(found);
  assert.equal(found.page, 29, "the contents entry names the section and carries no dimensions");
  assert.equal(found.valueCount, 10);
});

test("a revision-history line naming the drawing is not the drawing", () => {
  // Real, from LMP7704-SP page 25: "Deleted outdated and incorrect HBH0014A
  // package outline drawing from Mechanical, Packaging, and Orderable...".
  const found = findPackageDrawing(
    doc(
      page(25, "Deleted outdated and incorrect HBH0014A PACKAGE OUTLINE drawing", ["1", "2"]),
      page(29, "PACKAGE OUTLINE\nCFP - 2.861 mm max height", REAL_VALUES)
    ) as never
  );

  assert.ok(found);
  assert.equal(found.page, 29);
});

test("a datasheet with no mechanical drawing reports none rather than guessing", () => {
  // Measured: nine of the forty cached datasheets print no drawing at all, and
  // those parts have to be asked about with no page to show.
  assert.equal(
    findPackageDrawing(doc(page(1, "VA41630 Radiation Hardened MCU", ["176"])) as never),
    null
  );
});

test("several drawings are reported, not chosen between", () => {
  // A datasheet covering several packages prints one drawing each. Nothing here
  // knows which package the caller is ordering, so the others are offered.
  const found = findPackageDrawing(
    doc(
      page(31, "PACKAGE OUTLINE\nPW (TSSOP)", REAL_VALUES),
      page(33, "PACKAGE OUTLINE\nD (SOIC)", [...REAL_VALUES, "5.00", "4.80"])
    ) as never
  );

  assert.ok(found);
  assert.equal(found.page, 33, "the denser drawing ranks first");
  assert.deepEqual(found.alternatePages, [31]);
});

test("a page that merely mentions the heading with a few stray numbers is refused", () => {
  assert.equal(
    findPackageDrawing(doc(page(5, "See PACKAGE OUTLINE on page 29", ["29", "5", "1"])) as never),
    null
  );
});

test("a shipping table under the mechanical heading is not a drawing", () => {
  // Found by RENDERING the page the ranking chose, not by reading its text. TI
  // files shipping material under the same heading: an LM358 ranked a table of
  // carton sizes with 173 values first, and a TLV9061 ranked its TAPE AND REEL
  // BOX page. Both read perfectly well as text. What gives them away is that a
  // table stacks every value into a few columns.
  const columns = [100, 160, 220, 280, 340];
  const table: TextItem[] = [];
  for (let row = 0; row < 12; row += 1) {
    for (const x of columns) table.push(item("353.0", x, 600 - row * 14));
  }

  assert.equal(
    findPackageDrawing(doc(page(46, "PACKAGE OUTLINE\nDevice Package Type Pins SPQ", [])) as never),
    null,
    "a heading with no values is not a drawing either"
  );

  const shipping: PageText = {
    page: 46,
    text: "PACKAGE OUTLINE\nDevice Package Type Pins SPQ Length Width Height",
    items: table,
    start: 0,
    end: 0,
    width: 612,
    height: 792
  };
  assert.equal(findPackageDrawing({ text: shipping.text, pages: [shipping], pageCount: 1, truncated: false } as never), null);
});

test("a sparse drawing is still a drawing", () => {
  // The first version of the table test asked what share of values sat in the
  // five densest columns, which throws away any drawing with few values: an
  // SN65HVD230 outline has thirteen, so five columns cover them by arithmetic.
  const sparse: TextItem[] = ["6.65", "6.30", "9.91", "9.55", "1.27", "0.48", "0.38", "2.86", "0.18", "0.10"]
    .map((value, index) => item(value, 90 + index * 37, 500 - index * 21));

  const found = findPackageDrawing({
    text: "PACKAGE OUTLINE",
    pages: [{ page: 39, text: "PACKAGE OUTLINE", items: sparse, start: 0, end: 0, width: 612, height: 792 }],
    pageCount: 1,
    truncated: false
  } as never);

  assert.ok(found, "ten values scattered across ten columns is a drawing");
  assert.equal(found.page, 39);
});

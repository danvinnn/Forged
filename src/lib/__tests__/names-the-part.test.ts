import { test } from "node:test";
import assert from "node:assert/strict";
import { datasheetTextFromPages, namesThePart, looksLikeWrongDocument } from "../pdftext";

// A REAL DATASHEET FOR THE WRONG PART.
//
// Found 2026-08-21 by hand-reading a package drawing that did not match the part
// it was filed under. Three of the 123 cached datasheets were the wrong device:
//
//     TPS7A4700 -> TPS7A20,  TPS7A4700 -> TPS7A84,  TPS7A4901 -> TPS7A20
//
// Each reads perfectly and produces a complete, correct library for a chip
// nobody asked for. Nothing downstream can tell.

test("a datasheet for a different part in the same family is refused", () => {
  // The real front matter of the document that was cached as TPS7A4700.
  // Sized like the real thing, deliberately: the document that was cached as
  // TPS7A4700 is 48 pages of genuine TI datasheet. A toy fixture would be caught
  // by `looksLikeWrongDocument` on size alone and would prove nothing about the
  // case this function exists for.
  const body = "Electrical characteristics over operating free-air temperature range. ".repeat(40);
  const wrong = datasheetTextFromPages([
    "TPS7A20 www.ti.com SBVS338C - MARCH 2020 TPS7A20 300-mA, Ultra-Low-Noise, Low-IQ, High PSRR LDO",
    "Features Low output voltage noise " + body,
    ...Array.from({ length: 8 }, () => body)
  ]);
  assert.equal(namesThePart(wrong, "TPS7A4700"), false, "TPS7A is a shared PREFIX, not this part");
  assert.equal(namesThePart(wrong, "TPS7A4901"), false);
  // And it IS a real datasheet, so the size-based check cannot help here.
  assert.equal(looksLikeWrongDocument(wrong), false, "this is why a second check was needed");
});

test("the part's own datasheet is accepted", () => {
  const right = datasheetTextFromPages([
    "TPS7A4700 www.ti.com SBVS204 36-V, 1-A, 4.17-uVRMS, RF LDO Voltage Regulator",
    "Features"
  ]);
  assert.equal(namesThePart(right, "TPS7A4700"), true);
});

// THE HALF THAT KEEPS IT FROM BREAKING WORKING PARTS.
//
// Family datasheets are common and correct, and never write the full ordering
// number in their front matter. Refusing them would trade three broken parts for
// dozens.
test("a family datasheet naming the stem as its own token is accepted", () => {
  const family = datasheetTextFromPages([
    "L78 Datasheet Positive voltage regulator ICs Features Output current up to 1.5 A",
    "Output voltages of 5; 6; 8; 9; 12; 15; 18; 24 V"
  ]);
  assert.equal(namesThePart(family, "L7805"), true, "L78 stands alone and L7805 extends it");

  const connector = datasheetTextFromPages([
    "1.25mm Pitch Miniature Crimping Connector (UL Listed) DF13 Series Type Mounting Type",
    "Features"
  ]);
  assert.equal(namesThePart(connector, "DF13-4P-1.25DSA"), true, "DF13 stands alone");
});

// The distinction the whole rule turns on, stated directly.
test("a shared prefix is not a family stem", () => {
  const shared = datasheetTextFromPages(["TPS7A20 300-mA LDO", "Features"]);
  const standalone = datasheetTextFromPages(["TPS7A Series regulators", "Features"]);
  assert.equal(namesThePart(shared, "TPS7A4700"), false, "TPS7A inside TPS7A20 is not a token");
  assert.equal(namesThePart(standalone, "TPS7A4700"), true, "TPS7A as its own word is");
});

test("front matter only: a part named deep in a comparison table does not count", () => {
  const deep = datasheetTextFromPages([
    "TPS7A20 300-mA LDO",
    "Features",
    "Application note: see also TPS7A4700 for higher voltage"
  ]);
  assert.equal(namesThePart(deep, "TPS7A4700"), false, "page 3 is not front matter");
});

test("a part number too short to discriminate is never refused", () => {
  const anything = datasheetTextFromPages(["Some regulator", "Features"]);
  assert.equal(namesThePart(anything, "L7"), true, "too short to judge, so it does not judge");
});

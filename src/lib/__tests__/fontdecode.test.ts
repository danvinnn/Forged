import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeShiftedFonts, detectShift, shiftText } from "../fontdecode";

/**
 * Recovering text from fonts whose encoding is a constant offset.
 *
 * The case this exists for is LD1117 page 6, whose entire pin configuration
 * arrives as `$'-*1'  1&  9287  9,1`. Those are glyph codes from a subset font
 * with no ToUnicode map, displaced by exactly 29: ADJ/GND, NC, VOUT, VIN. The
 * page had been written off as needing a vision model and needs arithmetic.
 */

/**
 * The real LD1117 page 6 figure text, as pdf.js reports it.
 *
 * `ADJ/GND` encodes as `$'` + chr(18) + `-*1'`: the slash sits at 18 because
 * `'/'`(47) - 29 = 18, down in the control range where a printable-input check
 * would have refused to look.
 */
const ADJ_GND = `$'-${String.fromCharCode(18)}*1'`;
const LD1117_FIGURE = `${ADJ_GND} 1& 9287 9287 9,1 1& ${ADJ_GND} 9287 9,1`;

test("a constant-offset font is detected and decoded", () => {
  const shift = detectShift(LD1117_FIGURE);
  assert.equal(shift, 29);

  const decoded = shiftText(LD1117_FIGURE, 29)!;
  assert.match(decoded, /ADJ\/GND/);
  assert.match(decoded, /VOUT/);
  assert.match(decoded, /NC/);
});

/**
 * The guard that matters most, and the one whose absence was measured.
 *
 * The first version skipped any character a shift would push out of printable
 * ASCII. That sounds safe and destroys the test: at shift 59 the uppercase
 * letters overflow and are left alone, so a HEALTHY font's `VDD` and `GND`
 * survive, keep scoring, and let a nonsense shift win. Measured cost on the
 * corpus: fields 41% to 33%, bundles 7 to 5.
 */
test("healthy text is never shifted, whatever a shift would score", () => {
  for (const healthy of [
    "VDD GND AIN0 VDD GND AIN1 VDD GND AIN2 AIN P",
    "PACKAGE OUTLINE TSSOP - 1.2 mm max height PW0008A",
    "Note: The TAB is connected to the VOUT.",
    "Pin configuration LD1117 Figure 2. Pin connections (top view)"
  ]) {
    assert.equal(detectShift(healthy), null, `must not fire on: ${healthy}`);
  }
});

test("a shift that pushes any character out of printable ASCII is not the encoding", () => {
  // 'z'(122) + 29 = 151, past the printable range, so the whole shift is void.
  assert.equal(shiftText("z", 29), null);
  // Whitespace is preserved rather than shifted: a shifted space is not a space.
  assert.equal(shiftText("9,1 9,1", 29), "VIN VIN");
});

/**
 * Encoded glyph codes are NOT required to be printable, and requiring it
 * rejected every real case. LD1117's digits and slash encode into the control
 * range, because `'1'`(49) - 29 = 20 and `'/'`(47) - 29 = 18.
 */
test("control-range glyph codes decode, because that is where digits encode to", () => {
  const encoded = String.fromCharCode(18) + String.fromCharCode(20) + String.fromCharCode(27);
  assert.equal(shiftText(encoded, 29), "/18");
});

/**
 * The FONT is the unit. A page mixes encodings freely, so decoding per page
 * would corrupt the healthy text beside the broken figure, and deciding per
 * ITEM is unsafe in the other direction: a run like `9,1` is indistinguishable
 * from a European decimal on its own.
 */
test("only the broken font is decoded, and its neighbours are untouched", () => {
  const items = [
    { str: "Pin configuration LD1117", fontName: "f1" },
    { str: "Figure 2. Pin connections (top view)", fontName: "f1" },
    { str: ADJ_GND, fontName: "f4" },
    { str: "9,1", fontName: "f4" },
    { str: "9287", fontName: "f4" },
    { str: "1&", fontName: "f4" },
    { str: "SOT-223 SO-8", fontName: "f3" }
  ];

  const decoded = decodeShiftedFonts(items);

  assert.equal(decoded[0].str, "Pin configuration LD1117", "healthy font untouched");
  assert.equal(decoded[6].str, "SOT-223 SO-8", "healthy font untouched");
  assert.equal(decoded[2].str, "ADJ/GND");
  assert.equal(decoded[3].str, "VIN");
  assert.equal(decoded[4].str, "VOUT");
  assert.equal(decoded[5].str, "NC");
});

test("an item with no font is never touched, since there is no unit to test", () => {
  const items = [{ str: ADJ_GND }, { str: "9,1" }];
  assert.deepEqual(decodeShiftedFonts(items), items);
});

test("a font that does not decode decisively is left exactly as supplied", () => {
  // Digits with no vocabulary behind them. A wrongly "corrected" pin name is
  // worse than an unreadable one: unreadable is visibly a gap, wrong is not.
  const items = [{ str: "1.27 0.65 2.54", fontName: "f9" }, { str: "9.91 9.55", fontName: "f9" }];
  assert.deepEqual(decodeShiftedFonts(items), items);
});

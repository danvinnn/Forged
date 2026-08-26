import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAltiumText } from "../altium/binary";
import { AltiumEmitError } from "../altium/units";

/**
 * Windows-1252 is NOT Latin-1, and the difference is the 0x80-0x9F block.
 *
 * The encoder accepted any code point up to 0xFF and wrote it out as that byte.
 * That is Latin-1, and it was wrong in both directions at once: it refused the
 * twenty-six real characters this block holds, and it silently accepted the C1
 * control range and turned each one into a different character.
 *
 * Found 2026-08-24 from a user report of "export failed" on an LMP7704-SP,
 * whose pin names carry a U+2013 en dash. That is 0x96 in Windows-1252 and
 * always was.
 */

const bytes = (value: string) => [...encodeAltiumText(value)];

test("the en dash that broke a real export encodes as the byte it has always had", () => {
  const enDash = String.fromCodePoint(0x2013);
  assert.deepEqual(bytes(`IN A${enDash}`), [0x49, 0x4e, 0x20, 0x41, 0x96]);
});

test("every character Windows-1252 actually holds is written, not refused", () => {
  // The whole 0x80-0x9F block, by code point. A vendor is free to print any of
  // them in a pin name, and refusing one costs the user the entire export.
  const block: Array<[number, number]> = [
    [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
    [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
    [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
    [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
    [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
    [0x017e, 0x9e], [0x0178, 0x9f]
  ];
  for (const [codePoint, byte] of block) {
    assert.deepEqual(
      bytes(String.fromCodePoint(codePoint)),
      [byte],
      `U+${codePoint.toString(16).toUpperCase()} is Windows-1252 0x${byte.toString(16)}`
    );
  }
});

test("the C1 control range is REFUSED rather than quietly becoming punctuation", () => {
  // This is the worse half of the old behaviour. U+0096 was written as byte
  // 0x96, which in Windows-1252 is an en dash: a character nobody typed,
  // arriving on a pad in Altium. Silently substituting a character is the exact
  // failure the encoder's own comment said it existed to prevent.
  for (const codePoint of [0x80, 0x8d, 0x90, 0x96, 0x9d, 0x9f]) {
    assert.throws(
      () => encodeAltiumText(String.fromCodePoint(codePoint)),
      AltiumEmitError,
      `U+${codePoint.toString(16).toUpperCase()} is not a Windows-1252 character`
    );
  }
});

test("ASCII and the Latin-1 upper half are unchanged", () => {
  assert.deepEqual(bytes("VCC"), [0x56, 0x43, 0x43]);
  assert.deepEqual(bytes(String.fromCodePoint(0xe9)), [0xe9]);
  assert.deepEqual(bytes(String.fromCodePoint(0xa0)), [0xa0]);
  assert.deepEqual(bytes(String.fromCodePoint(0xff)), [0xff]);
});

test("what genuinely does not fit is still refused, and says which character", () => {
  // The refusal has to survive: an approximated designator is worse than none.
  for (const value of [String.fromCodePoint(0x4e2d), String.fromCodePoint(0x0100), "A" + String.fromCodePoint(0x1f600)]) {
    assert.throws(() => encodeAltiumText(value), AltiumEmitError);
  }
  assert.throws(() => encodeAltiumText(String.fromCodePoint(0x4e2d)), /U\+4E2D/);
});

test("an astral character is counted once, not as two halves", () => {
  // Iterating a string by index walks UTF-16 code units, so an emoji would be
  // read as two lone surrogates and reported as U+D83D. Iterating by character
  // reports the real code point, which is what the message has to name.
  assert.throws(() => encodeAltiumText(String.fromCodePoint(0x1f600)), /U\+1F600/);
});

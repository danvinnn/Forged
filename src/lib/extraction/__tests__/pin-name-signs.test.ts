import { test } from "node:test";
import assert from "node:assert/strict";
import { asciiSigns } from "../merge";

/**
 * A pin's name is the terminal it names, not the glyph the datasheet set it in.
 *
 * Reported 2026-08-24: an Altium export refused with
 *
 *   "IN A" + U+207B contains a character that Altium's Windows-1252 strings
 *   cannot represent.
 *
 * The refusal was correct, because Windows-1252 has no superscript minus. But
 * the hand-read `PINOUT_ORACLE` entry for that same table, written by a person
 * looking at the rendered page, says `IN A-`. The superscript was the
 * datasheet's typography reaching the record, not the vendor naming a pin.
 *
 * Normalised in the RECORD rather than in the Altium emitter, so the KiCad and
 * Altium libraries cannot disagree about what a pin is called.
 */

const SUP_MINUS = String.fromCodePoint(0x207b);
const SUP_PLUS = String.fromCodePoint(0x207a);
const MINUS_SIGN = String.fromCodePoint(0x2212);
const EN_DASH = String.fromCodePoint(0x2013);

const namesFrom = (raw: string[]) => raw.map(asciiSigns);

test("every typographic minus becomes the hyphen a person would write", () => {
  assert.deepEqual(
    namesFrom([`IN A${SUP_MINUS}`, `IN B${MINUS_SIGN}`, `IN C${EN_DASH}`, `IN D${SUP_PLUS}`]),
    ["IN A-", "IN B-", "IN C-", "IN D+"]
  );
});

test("nothing else about the name is touched", () => {
  // Not a general cleaner. No case folding, no accent stripping, no
  // whitespace collapsing, and no letter is ever altered.
  assert.deepEqual(
    namesFrom(["VCC", "GND", "A1", "nRESET", "P0.15/AIN1", "V+", "V-", "SDA/SDI"]),
    ["VCC", "GND", "A1", "nRESET", "P0.15/AIN1", "V+", "V-", "SDA/SDI"]
  );
});

test("the reported part now matches its hand-read oracle exactly", () => {
  // `PINOUT_ORACLE["LMP7704-SP"]` says `IN A-`, hand-read off page 3.
  assert.deepEqual(namesFrom([`IN A${SUP_MINUS}`]), ["IN A-"]);
});

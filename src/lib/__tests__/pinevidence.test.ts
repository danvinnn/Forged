import { test } from "node:test";
import assert from "node:assert/strict";
import { namesAgree, pinNameAlternatives, pinoutEvidence } from "../pinevidence";
import type { DatasheetText, PageText, TextItem } from "../pdftext";
import type { PinRecord } from "../types";

const pin = (number: number, name: string): PinRecord => ({
  number: String(number),
  name,
  electricalType: "unspecified"
});

/**
 * A page built from positioned runs, the way a PDF actually arrives.
 *
 * `pinoutEvidence` reads GEOMETRY, so a fixture of plain strings would exercise
 * none of it. Each run is placed explicitly and the page text is assembled the
 * way `renderPage` assembles it - runs joined in reading order, lines separated
 * by a newline - because the reader rebuilds its lines from those offsets.
 */
function pageOf(runs: Array<{ str: string; x: number; y: number; width?: number }>, page = 1): DatasheetText {
  const lines = new Map<number, Array<{ str: string; x: number; y: number; width?: number }>>();
  for (const run of runs) {
    const key = Math.round(run.y);
    lines.set(key, [...(lines.get(key) ?? []), run]);
  }
  const ordered = [...lines.entries()].sort((left, right) => right[0] - left[0]);
  const items: TextItem[] = [];
  let text = "";
  ordered.forEach(([, line], index) => {
    if (index > 0) text += "\n";
    for (const run of [...line].sort((left, right) => left.x - right.x)) {
      const start = text.length;
      text += run.str;
      items.push({
        str: run.str,
        x: run.x,
        y: run.y,
        width: run.width ?? run.str.length * 4,
        height: 8,
        start,
        end: text.length
      });
    }
  });
  const single: PageText = { page, text, items, start: 0, end: text.length, width: 612, height: 792 };
  return { text, pages: [single], pageCount: 1, truncated: false };
}

/** An eight-pin figure: four numbers down each side, names outboard of them. */
function dualFigure(names: string[]): DatasheetText {
  const runs: Array<{ str: string; x: number; y: number }> = [];
  const half = names.length / 2;
  for (let index = 0; index < half; index += 1) {
    const y = 600 - index * 20;
    runs.push({ str: names[index], x: 80, y });
    runs.push({ str: String(index + 1), x: 140, y });
    runs.push({ str: String(names.length - index), x: 210, y });
    runs.push({ str: names[names.length - 1 - index], x: 250, y });
  }
  return pageOf(runs);
}

const EIGHT = ["OUT1", "IN1-", "IN1+", "V-", "IN2+", "IN2-", "OUT2", "V+"];
const CLAIM = EIGHT.map((name, index) => pin(index + 1, name));

test("a figure whose names sit beside their numbers corroborates every pin", () => {
  const evidence = pinoutEvidence(dualFigure(EIGHT), CLAIM, 8);
  assert.ok(evidence, "the figure states the pinout in its text layer");
  assert.deepEqual(evidence.agreeing, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("a pinout shifted by one is not corroborated", () => {
  // The defect this exists to catch: STM32F407VG had twenty-two pins shifted and
  // nothing in the product could see it.
  const shifted = EIGHT.map((_, index) => pin(index + 1, EIGHT[(index + 1) % EIGHT.length]));
  const evidence = pinoutEvidence(dualFigure(EIGHT), shifted, 8);
  assert.ok(
    evidence === null || evidence.agreeing.length < 8,
    "a numbering off by one must not come back fully agreed"
  );
});

test("two swapped pins are not corroborated", () => {
  // OPA2277's shape: the SOIC column's names applied to the VSON's pins 7 and 8.
  const swapped = [...CLAIM];
  swapped[6] = pin(7, EIGHT[7]);
  swapped[7] = pin(8, EIGHT[6]);
  const evidence = pinoutEvidence(dualFigure(EIGHT), swapped, 8);
  const agreed = evidence?.agreeing ?? [];
  assert.ok(!agreed.includes(7) && !agreed.includes(8), "a swap must not be reported as agreement");
});

test("a name invented outright is not corroborated", () => {
  const invented = [...CLAIM];
  invented[3] = pin(4, "VBIAS");
  const evidence = pinoutEvidence(dualFigure(EIGHT), invented, 8);
  assert.ok(!(evidence?.agreeing ?? []).includes(4));
});

test("a longer sibling's pin table is not read as this part's pinout", () => {
  // OPA2189's shape: an 8-pin part measured against the 14-pin OPA4189 printed
  // on the same page, which produced two false disagreements on a reading that
  // is correct. A column of numbers running past this package's last pin belongs
  // to a different package, whatever names sit beside it.
  const fourteen = ["OUT A", "-IN A", "+IN A", "V+", "+IN B", "-IN B", "OUT B", "OUT C", "-IN C", "+IN C", "V-", "+IN D", "-IN D", "OUT D"];
  const table = fourteen.flatMap((name, index) => [
    { str: name, x: 80, y: 600 - index * 14 },
    { str: String(index + 1), x: 200, y: 600 - index * 14 }
  ]);
  const eightPinClaim = ["OUT A", "-IN A", "+IN A", "V-", "+IN B", "-IN B", "OUT B", "V+"].map((name, index) =>
    pin(index + 1, name)
  );
  assert.equal(
    pinoutEvidence(pageOf(table), eightPinClaim, 8),
    null,
    "a fourteen-number column is not an eight-pin package's pinout"
  );
});

test("a sibling's figure cannot fully corroborate a shorter part", () => {
  // The same page, read as a FIGURE: pins 1 to 7 down one side is a legitimate
  // sequence for an 8-pin part and the reader may use it, but the pin where the
  // two devices differ must not come back agreed, and a pinout that is not
  // agreed in full is flagged.
  const fourteen = ["OUT A", "-IN A", "+IN A", "V+", "+IN B", "-IN B", "OUT B", "OUT C", "-IN C", "+IN C", "V-", "+IN D", "-IN D", "OUT D"];
  const eightPinClaim = ["OUT A", "-IN A", "+IN A", "V-", "+IN B", "-IN B", "OUT B", "V+"].map((name, index) =>
    pin(index + 1, name)
  );
  const evidence = pinoutEvidence(dualFigure(fourteen), eightPinClaim, 8);
  assert.ok(!(evidence?.agreeing ?? []).includes(4), "pin 4 is V- here and V+ there; it is not corroborated");
  assert.ok((evidence?.agreeing ?? []).length < 8, "a partly agreed pinout is not a confirmed one");
});

test("silence is not agreement", () => {
  const blank = pageOf([{ str: "Absolute maximum ratings", x: 60, y: 700 }]);
  assert.equal(pinoutEvidence(blank, CLAIM, 8), null);
});

test("a pin name containing a space is still found", () => {
  // TI writes `OUTPUT 2` and `VOS TRIM` on its connection diagrams. The search
  // stopped at every space until 2026-08-27, so no part named that way had any
  // evidence at all.
  const names = ["OUTPUT 2", "OUTPUT 1", "V+", "INPUT 1-", "INPUT 1+", "INPUT 2-", "INPUT 2+", "GND"];
  const evidence = pinoutEvidence(dualFigure(names), names.map((name, index) => pin(index + 1, name)), 8);
  assert.ok(evidence, "a name with a space is a name");
  assert.deepEqual(evidence.agreeing, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("the same pin under two printed names is one pin", () => {
  // ST prints `PH0` in its table, `PH0-OSC_IN` in its figure, and the reading
  // returns both. All three are the same copper.
  assert.ok(namesAgree("PH0/OSC_IN (PH0)", "PH0-OSC_IN"));
  assert.ok(namesAgree("PA13 (JTMS-SWDIO)", "PA13"));
  assert.ok(namesAgree("SENSE/FB", "FB"));
});

test("a different net is still a different net", () => {
  // The comparison above must not soften into "shares some letters". Each of
  // these is a real defect this product has shipped or nearly shipped.
  assert.ok(!namesAgree("VSS", "VCAP_1"));
  assert.ok(!namesAgree("Out B", "V+"));
  assert.ok(!namesAgree("V+", "V-"));
  assert.ok(!namesAgree("IN1-", "IN1+"));
  assert.ok(!namesAgree("VDD", "VDDA"));
  assert.ok(!namesAgree("AIN_0P", "AIN_0GND"));
});

test("a trailing sign is not an alternative name", () => {
  // Splitting `V-` on its hyphen would leave a bare `V` free to agree with `V+`,
  // which is the one comparison that must never pass.
  assert.deepEqual([...pinNameAlternatives("V-")], ["V-"]);
  assert.deepEqual([...pinNameAlternatives("IN1-")], ["IN1-"]);
});

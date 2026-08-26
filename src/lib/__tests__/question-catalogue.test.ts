import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MILLIMETRE_INPUT_FIELDS,
  REQUIRED_INPUT_FIELDS,
  SETTING_INPUT_FIELDS,
  SHAPED_INPUT_FIELDS
} from "../exporters";

/**
 * EVERY QUESTION THE PRODUCT ASKS MUST BE ANSWERABLE.
 *
 * A question with no way to give an answer is worse than a plain refusal: it
 * spends the user's time, tells them exactly which number would fix it, and then
 * rejects that number. It has happened twice - `leadsPerSide` from 2026-08-14
 * and `landSpanCrossMm` after it - and both times the generator and the export
 * route each kept their own copy of the list and drifted.
 *
 * The route now derives its millimetre fields from the catalogue, so that half
 * cannot drift. What remains is the partition: every field the product may ask
 * for is answered by exactly one of the three routes below, and a field added to
 * the catalogue without a way to receive it fails here.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

test("every askable field is answerable by exactly one route", () => {
  const answered = [...MILLIMETRE_INPUT_FIELDS, ...SHAPED_INPUT_FIELDS, ...SETTING_INPUT_FIELDS];

  const unanswerable = REQUIRED_INPUT_FIELDS.filter((field) => !answered.includes(field as never));
  assert.deepEqual(
    unanswerable,
    [],
    "a field the product can ask for and nothing can receive is a refusal wearing the form of a question"
  );

  const orphaned = answered.filter((field) => !REQUIRED_INPUT_FIELDS.includes(field as never));
  assert.deepEqual(orphaned, [], "a field the route accepts and nothing asks for is dead validation");

  assert.equal(new Set(answered).size, answered.length, "a field is answered by one route, not two");
});

/**
 * The three shaped fields have no shared validator, so each one's branch is
 * checked to exist by name. A branch removed while the field stays askable is
 * the exact drift this file exists for, and it is invisible from the type
 * system: the route reads `payload[field]` and simply would not find it.
 */
test("each shaped field has its own branch on the export route", () => {
  const route = readFileSync(join(ROOT, "src/app/api/export/route.ts"), "utf8");
  for (const field of SHAPED_INPUT_FIELDS) {
    assert.match(
      route,
      new RegExp(`suppliedNumbers\\.${field}\\s*=`),
      `the export route must accept ${field}, because the generator asks for it`
    );
  }
  assert.match(
    route,
    /for \(const field of MILLIMETRE_INPUT_FIELDS\)/,
    "the millimetre fields come from the catalogue rather than a second hand-written list"
  );
});

/**
 * And the settings pair really is a settings pair: asked once on the settings
 * screen rather than per datasheet. A datasheet cannot answer these - the seated
 * geometry of an unformed lead is set by the assembler's forming die - so
 * putting them in front of a user per part would be friction with no source.
 */
test("the two forming numbers are settings fields, asked once per account", async () => {
  const { SETTINGS_FIELDS } = await import("../settings");
  for (const field of SETTING_INPUT_FIELDS) {
    assert.ok(
      SETTINGS_FIELDS.some((setting) => setting.key === field),
      `${field} is asked for as a part input and must exist on the settings screen`
    );
  }
});

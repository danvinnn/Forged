import { test } from "node:test";
import assert from "node:assert/strict";
import { groupsFor, pagesFor, FIELD_GROUPS } from "../models/local-focused";
import { extractionFields } from "../contracts";

/**
 * Splitting one wide question into several narrow ones, for a small local model.
 *
 * Measured against qwen2.5vl:7b: the production prompt returned NOTHING, and the
 * pin table asked on its own came back 8/8 correct against the hand-read oracle.
 * The capability is there; the capacity to hold twenty-three questions at once
 * is not.
 */

test("every extraction field belongs to some group, so none is silently never asked", () => {
  // The failure this prevents: adding a field to `contracts.ts` and forgetting
  // this file, so the focused model quietly stops asking about it forever.
  const groups = groupsFor(extractionFields);
  const asked = new Set(groups.flatMap((group) => group.fields));

  for (const field of extractionFields) {
    assert.ok(asked.has(field), `${field} is in no group and would never be asked`);
  }
});

test("a request for a few fields asks only the groups those fields need", () => {
  const groups = groupsFor(["pins", "dimensions.landSpanMm"]);

  assert.equal(groups.length, 2, "one question for the pin table, one for the land pattern");
  assert.deepEqual(groups.flatMap((group) => group.fields).sort(), ["dimensions.landSpanMm", "pins"]);
});

test("no field is asked for twice", () => {
  // A field in two groups would be answered twice and the second answer silently
  // dropped, which is a confusing way to waste a call.
  const seen = new Set<string>();
  for (const group of FIELD_GROUPS) {
    for (const field of group.fields) {
      assert.ok(!seen.has(field), `${field} appears in more than one group`);
      seen.add(field);
    }
  }
});

test("the pin table gets a question to itself", () => {
  // It is the field that blocks the most parts, and the one the local model was
  // measured to read perfectly ALONE and not at all alongside everything else.
  const own = FIELD_GROUPS.find((group) => group.fields.includes("pins"));
  assert.deepEqual(own?.fields, ["pins"]);
});


/**
 * Narrowing the PAGES, which is the half that actually mattered.
 *
 * Measured: the pin table over one page of text came back 8/8 correct, and the
 * same question over the whole 68k-character document produced no answer at all.
 * Splitting the fields without splitting the context changes nothing, and the
 * first version of this model did exactly that and returned zero fields.
 */
test("a question is given the pages that answer it, not the whole document", () => {
  const pages = [
    { page: 1, text: "Features. Low offset." },
    { page: 3, text: "Table 6-1. Pin Functions: INA240" },
    { page: 33, text: "PACKAGE OUTLINE PW0008A" },
    { page: 34, text: "LAND PATTERN EXAMPLE 8X (1.5)" }
  ];

  const pinGroup = FIELD_GROUPS.find((group) => group.fields.includes("pins"))!;
  assert.deepEqual(pagesFor(pinGroup, pages).map((p) => p.page), [3]);

  const landGroup = FIELD_GROUPS.find((group) => group.fields.includes("dimensions.landSpanMm"))!;
  assert.deepEqual(pagesFor(landGroup, pages).map((p) => p.page), [34]);
});

test("a question whose section is not found still gets a BOUNDED slice", () => {
  // Never the whole document. Falling back to everything is the failure mode,
  // not a safe default.
  const pages = Array.from({ length: 40 }, (_, i) => ({ page: i + 1, text: "nothing relevant" }));
  const group = FIELD_GROUPS.find((g) => g.fields.includes("pins"))!;

  assert.ok(pagesFor(group, pages).length <= 3, "a miss must not send 40 pages");
});

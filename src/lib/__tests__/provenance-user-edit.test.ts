import { test } from "node:test";
import assert from "node:assert/strict";
import { isUntraceable, userEdited } from "../provenance";
import type { Extracted } from "../types";

/**
 * A hand-typed value must not inherit the reader's citation.
 *
 * Found 2026-08-24 by driving the review panel in a browser. `handleCorrectReview`
 * patched value, confidence and method through a merging helper, so the model's
 * citation survived; `updatePin` passed it through explicitly. Either way the
 * record ended up claiming a number a person invented had been read off a
 * specific page of the datasheet.
 */

const asRead: Extracted<number> = {
  value: 1.27,
  confidence: 0.5,
  method: "vlm",
  citation: { page: 29, snippet: "1.27", region: null }
};

test("correcting a value drops the page the WRONG value was read from", () => {
  // The correction says the reader was wrong. The page it was wrong on is not
  // evidence for the number that replaces it, and citing it there is a claim
  // the datasheet does not support.
  const corrected = userEdited(0.65);
  assert.equal(corrected.value, 0.65);
  assert.equal(corrected.method, "user");
  assert.equal(corrected.citation, null, "no page is claimed for a number a person supplied");
  assert.equal(corrected.confidence, 1, "fully trusted, because a person put it there");
});

test("a merging patch is what let the citation survive, so the whole field is replaced", () => {
  // This is the shape of the bug: spreading the old field and overwriting three
  // keys keeps the fourth. `userEdited` returns a COMPLETE field for exactly
  // that reason.
  const merged = { ...asRead, value: 0.65, confidence: 1, method: "user" as const };
  assert.notEqual(merged.citation, null, "the defect, reproduced");

  const replaced = { ...asRead, ...userEdited(0.65) };
  assert.equal(replaced.citation, null, "the fix holds even when spread over the old field");
});

test("dropping the citation cannot block an export", () => {
  // The export gate refuses a MODEL value nobody can locate. A user value is
  // not a model value, so this fix costs no coverage. If that ever changes,
  // this test fails rather than parts silently stopping shipping.
  assert.equal(isUntraceable(userEdited(0.65)), false);
  assert.equal(isUntraceable({ value: 0.65, confidence: 0.5, method: "vlm", citation: null }), true);
  assert.equal(isUntraceable({ value: 0.65, confidence: 0.5, method: "vlm-drawing", citation: null }), true);
});

test("CONFIRMING is a different act and keeps its citation", () => {
  // A model read it and a person checked it against the page it names, which is
  // a stronger record than either alone. Only a correction discards.
  const confirmed = { ...asRead, confidence: 1, method: "user-confirmed" as const };
  assert.deepEqual(confirmed.citation, asRead.citation);
  assert.equal(isUntraceable(confirmed), false);
});

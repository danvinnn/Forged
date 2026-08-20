import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_FIELDS,
  densityOf,
  footprintSourceOf,
  missingRequired,
  parseSettings,
  settingsComplete
} from "../settings";

// RULES.md 3, as of 2026-08-19: a new account is taken through its settings
// before it can parse anything. Fields a published standard answers may be left
// blank, and blank means the standard, named on the screen. Fields no standard
// answers are required, because a default there would be invented.

test("a field with a published standard behind it is never required", () => {
  const blank = missingRequired({});
  for (const field of blank) {
    assert.equal(field.standard, null, `${field.key} has a standard, so blank is an answer, not a gap`);
  }
  // And every standard-backed field resolves to that standard.
  assert.equal(densityOf({}), "B", "IPC-7351B's own nominal");
  assert.equal(footprintSourceOf({}), "datasheet-first", "the vendor's pattern where there is one");
});

test("the two forming-die numbers gate the first run, because nothing else can answer them", () => {
  // Measured 2026-08-19: seven tuned parts were blocked on these two alone, and
  // they are the same two numbers for every part that customer will build.
  assert.equal(settingsComplete({}), false, "a fresh install cannot parse yet");

  const keys = missingRequired({}).map((field) => field.key).sort();
  assert.deepEqual(keys, ["formedLeadContactMm", "formedLeadSpanMm"]);

  assert.equal(settingsComplete({ formedLeadSpanMm: 6, formedLeadContactMm: 0.8 }), true);
  assert.equal(settingsComplete({ formedLeadSpanMm: 6 }), false, "one of the two is not both");
});

test("every required field states that no standard answers it", () => {
  // The screen has to be able to SAY why it is asking. A required field with a
  // standard named against it would be a question with an answer already.
  for (const field of SETTINGS_FIELDS) {
    if (field.standard === null) assert.ok(field.why.length > 0, `${field.key} must say why it is required`);
    else assert.ok(field.standard.length > 0);
  }
});

test("settings from a request body are bounded exactly as the export route bounds them", () => {
  // A store that accepts what `/api/export` rejects lets a user answer the
  // question and then be refused for the answer.
  assert.deepEqual(parseSettings({ formedLeadSpanMm: 6, formedLeadContactMm: 0.8 }), {
    formedLeadSpanMm: 6,
    formedLeadContactMm: 0.8
  });
  assert.deepEqual(parseSettings({ formedLeadSpanMm: 0 }), {}, "zero is not a span");
  assert.deepEqual(parseSettings({ formedLeadSpanMm: 500 }), {}, "beyond the route's ceiling");
  assert.deepEqual(parseSettings({ formedLeadContactMm: 9 }), {}, "a foot is not nine millimetres");
  assert.deepEqual(parseSettings({ densityLevel: "D" }), {}, "not a density level");
  assert.deepEqual(parseSettings({ densityLevel: "A" }), { densityLevel: "A" });
  assert.deepEqual(parseSettings({ footprintSource: "standard-always" }), { footprintSource: "standard-always" });
  assert.deepEqual(parseSettings(null), {});
  assert.deepEqual(parseSettings("nonsense"), {});
});

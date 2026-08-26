import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_FIELDS,
  densityOf,
  footprintSourceOf,
  missingRequired,
  outOfRange,
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


// A VALUE SILENTLY DROPPED IS INDISTINGUISHABLE FROM ONE NEVER GIVEN.
//
// Found in a browser 2026-08-24. `parseSettings` bounds the formed foot at 5 mm,
// which is right and matches `/api/export`. It dropped anything larger without a
// word: the box still showed the 8 the user typed, the gate still said one field
// was needed, and nothing on the screen joined the two. The user is then looking
// at a required field they have already answered, with no way to learn why it
// did not take.

test("a number the export route would refuse is reported, not just dropped", () => {
  const typed = { formedLeadSpanMm: 9.5, formedLeadContactMm: 8 };
  const kept = parseSettings(typed);

  assert.equal(kept.formedLeadContactMm, undefined, "still dropped, because the export refuses it");
  assert.equal(settingsComplete(kept), false, "so the gate is still shut");

  const rejected = outOfRange(typed);
  assert.equal(rejected.length, 1, "and the screen can now say which field");
  assert.equal(rejected[0]?.key, "formedLeadContactMm");
  assert.equal(rejected[0]?.max, 5, "with the limit it broke, so the message can name a number");
});

test("a blank field is an unanswered question and never reported as a bad answer", () => {
  // The two cases need different words from the screen: "answer this" against
  // "that answer is outside the range". Conflating them is how the original
  // message managed to be true and useless at once.
  assert.deepEqual(outOfRange({}), []);
  assert.deepEqual(outOfRange({ formedLeadContactMm: 1.2, formedLeadSpanMm: 9.5 }), []);
  assert.equal(missingRequired(parseSettings({})).length, 2);
});

test("every bound the screen shows is the bound parseSettings actually enforces", () => {
  // The two drifting apart is what `MAX_FORMED_CONTACT_MM` was written up for
  // once already: a screen that accepts 8 and a route that refuses it asks the
  // user a question and then rejects their answer.
  for (const field of SETTINGS_FIELDS) {
    if (field.max === undefined) continue;
    const atLimit = parseSettings({ [field.key]: field.max });
    assert.equal(atLimit[field.key], field.max, `${field.key} accepts its stated maximum`);

    const justOver = parseSettings({ [field.key]: field.max + 0.01 });
    assert.equal(justOver[field.key], undefined, `${field.key} refuses just above its stated maximum`);
    assert.equal(outOfRange({ [field.key]: field.max + 0.01 }).length, 1, "and says so");
  }
});

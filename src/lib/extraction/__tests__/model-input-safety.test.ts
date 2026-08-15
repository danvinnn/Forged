import { test } from "node:test";
import assert from "node:assert/strict";
import { datasheetTextFromPages } from "../../pdftext";
import { buildPartRecord } from "../../datasheet";
import { partSchema, resolveForExport } from "../../types";
import { mergeModelValues } from "../merge";
import { parseModelResponse } from "../models/prompt";
import type { ExtractionResult } from "../contracts";

// A model's output is untrusted input that gets written into a record which
// later drives CAD generation. These cover that boundary.

const doc = datasheetTextFromPages([
  "VORAGO Technologies VA10820\nAvailable in a 32-pin QFN package.",
  "Mechanical Data\nTerminal spacing is 0.5 mm nominal."
]);

test("a model cannot write to keys outside the field list", () => {
  const malicious = JSON.stringify({
    values: {
      __proto__: { value: "polluted", page: 1 },
      constructor: { value: "polluted", page: 1 },
      "dimensions.__proto__": { value: 1, page: 1 },
      sourceFileName: { value: "../../etc/passwd", page: 1 },
      id: { value: "overwritten", page: 1 },
      notes: { value: ["injected"], page: 1 }
    }
  });

  const result = parseModelResponse(malicious);
  assert.deepEqual(Object.keys(result.values), [], "only known extraction fields may survive parsing");

  const part = buildPartRecord(doc, "VA10820.pdf");
  const { part: merged } = mergeModelValues(part, doc, result, "test-model");

  assert.equal(merged.sourceFileName, "VA10820.pdf", "identity fields are not model-writable");
  assert.notEqual(merged.id, "overwritten");
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype must be untouched");
});

test("a model cannot inject a value of the wrong shape", () => {
  const result = parseModelResponse(
    JSON.stringify({
      values: {
        pinCount: { value: { nested: "object" }, page: 1 },
        partNumber: { value: true, page: 1 }
      }
    })
  );
  assert.equal(result.values.pinCount, undefined, "an object is not a usable scalar");
  assert.equal(result.values.partNumber, undefined, "a boolean is not a usable scalar");
});

test("a malformed or hostile response degrades to no values, never a throw", () => {
  for (const payload of ["", "not json", "{}", '{"values":null}', '{"values":{"pins":null}}', "[]"]) {
    const result = parseModelResponse(payload);
    assert.deepEqual(result.values, {}, `payload ${JSON.stringify(payload)} must yield nothing`);
  }
});

test("model output that survives still cannot produce an exportable record on its own", () => {
  // Worst case: a prompt-injected model returns confident values for everything
  // it was asked. It still cannot overwrite deterministic values, and the export
  // gate still applies, so injection cannot silently reach generated geometry.
  // A field already settled, which after 2026-08-14 means a person confirmed it
  // rather than a deterministic reader having read it. The property under test
  // is merge's, not the parser's: a settled value is never overwritten.
  const part = {
    ...buildPartRecord(doc, "VA10820.pdf"),
    manufacturer: {
      value: "VORAGO Technologies",
      confidence: 1,
      method: "user-confirmed" as const,
      citation: { page: 1, snippet: "VORAGO Technologies", region: null }
    }
  };
  const result: ExtractionResult = {
    values: {
      pins: { value: [{ number: "1", name: "EVIL", electricalType: "power" }], page: 1 },
      manufacturer: { value: "Attacker Inc", page: 1 }
    }
  };
  const { part: merged } = mergeModelValues(part, doc, result, "test-model");

  assert.equal(merged.manufacturer.value, "VORAGO Technologies", "a settled value still wins");

  // The model-supplied pin table carries no verified citation, so the export
  // boundary refuses it outright. Injection cannot reach generated geometry.
  // A settled pin count so the resolve reaches the traceability gate rather than
  // stopping at "missing", which is what this test is about.
  const resolved = resolveForExport({
    ...merged,
    pinCount: { value: 1, confidence: 1, method: "user", citation: null }
  });
  assert.equal(resolved.ok, false, "an untraceable pin table must not export");
  if (!resolved.ok) assert.ok(resolved.untraceable?.includes("pins"), JSON.stringify(resolved));

  assert.ok(partSchema.safeParse(JSON.parse(JSON.stringify(merged))).success);
});

test("an enormous field value is not silently accepted as a pin table", () => {
  const huge = Array.from({ length: 5000 }, (_, i) => ({
    number: String(i + 1),
    name: `P${i + 1}`,
    electricalType: "unspecified" as const
  }));
  const result: ExtractionResult = { values: { pins: { value: huge, page: 1 } } };
  const part = buildPartRecord(doc, "VA10820.pdf");
  const { part: merged } = mergeModelValues(part, doc, result, "test-model");

  // It is accepted into the record (the schema allows it) but is uncitable,
  // because a pin array has no single string to locate on a page.
  assert.equal(merged.pins.citation, null, "a pin table cannot be citation-verified by text match");
  assert.ok(
    merged.notes.some((note) => /not traceable/i.test(note)),
    "an uncitable model value must be flagged as untraceable"
  );
});

// ---------------------------------------------------------------------------
// Truncated responses.
//
// Measured 2026-08-13: `gemini-3.5-flash` with unbounded thinking returned all
// three requested fields correctly and stopped one character short of closing
// its JSON, reproducibly. The whole answer was discarded over a missing brace.
// ---------------------------------------------------------------------------

test("a response cut off after a complete field is recovered, not discarded", () => {
  // Exactly the shape measured: valid through the last field, then nothing.
  const truncated =
    '{\n  "values": {\n    "manufacturer": {\n      "value": "Texas Instruments",\n      "page": 1\n    },\n' +
    '    "pinCount": {\n      "value": 8,\n      "page": 1\n    }\n  },\n  "notes": [],\n  "pagesWorthRendering": []';

  const result = parseModelResponse(truncated);
  assert.equal(result.values.manufacturer?.value, "Texas Instruments");
  assert.equal(result.values.pinCount?.value, 8);
});

test("a value cut off MID-NUMBER is dropped whole, never completed", () => {
  // The hazard the repair exists to avoid. A body length of 4.95 mm cut after
  // "4.9" must not reach copper as 4.9: it is a different package. The rewind
  // goes back to the last CLOSED container, so the incomplete field cannot
  // survive at all.
  const truncated =
    '{\n  "values": {\n    "manufacturer": {\n      "value": "Texas Instruments",\n      "page": 1\n    },\n' +
    '    "dimensions.bodyLengthMm": {\n      "value": 4.9';

  const result = parseModelResponse(truncated);
  assert.equal(result.values.manufacturer?.value, "Texas Instruments", "the complete field survives");
  assert.equal(
    result.values["dimensions.bodyLengthMm"],
    undefined,
    "a half-read number must never become a value"
  );
});

test("a response cut off MID-STRING drops that field too", () => {
  const truncated =
    '{\n  "values": {\n    "pinCount": {\n      "value": 8,\n      "page": 1\n    },\n' +
    '    "packageType": {\n      "value": "TSSO';

  const result = parseModelResponse(truncated);
  assert.equal(result.values.pinCount?.value, 8);
  assert.equal(result.values.packageType, undefined, "'TSSO' is not a package");
});

test("an unreadable response says so, so a refusal and a failure are not the same event", () => {
  // Before this they were indistinguishable: both arrived as an empty result.
  // One means the model read the page and declined, which is a fact about the
  // datasheet; the other means we could not read the model, which is a fact
  // about us, and only the second is a bug.
  const result = parseModelResponse("I am afraid I cannot help with that request.");
  assert.deepEqual(result.values, {});
  assert.match(result.notes?.join(" ") ?? "", /not valid JSON/);
});

test("a genuine refusal is still reported with the model's own reasons", () => {
  const refusal = JSON.stringify({
    values: {},
    notes: ["The document specifies multiple package options, so dimensions cannot be assigned."]
  });
  const result = parseModelResponse(refusal);
  assert.deepEqual(result.values, {});
  assert.match(result.notes?.join(" ") ?? "", /multiple package options/);
  assert.doesNotMatch(result.notes?.join(" ") ?? "", /not valid JSON/);
});

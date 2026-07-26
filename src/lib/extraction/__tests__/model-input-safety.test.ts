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
  const part = buildPartRecord(doc, "VA10820.pdf");
  const result: ExtractionResult = {
    values: {
      pins: { value: [{ number: "1", name: "EVIL", electricalType: "power" }], page: 1 },
      manufacturer: { value: "Attacker Inc", page: 1 }
    }
  };
  const { part: merged } = mergeModelValues(part, doc, result, "test-model");

  assert.equal(merged.manufacturer.value, "VORAGO Technologies", "deterministic still wins");

  // The model-supplied pin table carries no verified citation, so the export
  // boundary refuses it outright. Injection cannot reach generated geometry.
  const resolved = resolveForExport(merged);
  assert.equal(resolved.ok, false, "an untraceable pin table must not export");
  if (!resolved.ok) assert.ok(resolved.untraceable?.includes("pins"));

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

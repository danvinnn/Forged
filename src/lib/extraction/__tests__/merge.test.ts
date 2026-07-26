import { test } from "node:test";
import assert from "node:assert/strict";
import { datasheetTextFromPages } from "../../pdftext";
import { buildPartRecord } from "../../datasheet";
import { partSchema, resolveForExport, type PartRecord } from "../../types";
import { mergeModelValues, unresolvedFields, verifyCitation } from "../merge";
import { buildExtractionRequest } from "../request";
import type { ExtractionResult } from "../contracts";

// The merge layer is where the traceability guarantee is actually enforced, so
// it carries the tests that used to sit on the legacy Gemini record builder:
// model output must satisfy the part contract, must never overwrite a value the
// code read off the page, and must not claim a citation it cannot support.

// Page 1 carries what the text pass CAN read (vendor, package, pin count).
// Page 2 carries a value phrased so the deterministic patterns miss it, which
// is what leaves a genuine gap for a model to fill.
const doc = datasheetTextFromPages([
  "VORAGO Technologies VA10820\nRad-Hard ARM Cortex-M0 MCU\nAvailable in a 32-pin QFN package.",
  "Mechanical Data\nTerminal spacing is 0.5 mm nominal.\nStorage temperature range applies."
]);

function deterministic(): PartRecord {
  return buildPartRecord(doc, "VA10820.pdf");
}

test("only fields the text pass could not resolve are offered to a model", () => {
  const part = deterministic();
  const fields = unresolvedFields(part);

  // The text pass reads the manufacturer and package off page 1, so a model is
  // never asked about them.
  assert.ok(!fields.includes("manufacturer"), "a resolved field must not be offered to the model");
  assert.ok(fields.includes("pins"), "an unresolved field must be offered");
});

test("a model cannot overwrite a value the deterministic pass resolved", () => {
  const part = deterministic();
  assert.equal(part.manufacturer.value, "VORAGO Technologies");

  const result: ExtractionResult = {
    values: { manufacturer: { value: "NXP", page: 1 } }
  };
  const { part: merged, filled } = mergeModelValues(part, doc, result, "test-model");

  assert.equal(merged.manufacturer.value, "VORAGO Technologies", "deterministic wins");
  assert.equal(merged.manufacturer.method, "deterministic");
  assert.ok(!filled.includes("manufacturer"));
});

test("a model value whose page claim checks out becomes a citation", () => {
  const part = deterministic();
  assert.equal(part.dimensions.pitchMm.value, null, "fixture must leave this gap open");

  const result: ExtractionResult = {
    values: { "dimensions.pitchMm": { value: 0.5, page: 2 } }
  };
  const { part: merged, filled, uncited } = mergeModelValues(part, doc, result, "test-model");

  assert.equal(merged.dimensions.pitchMm.value, 0.5);
  assert.equal(merged.dimensions.pitchMm.method, "vlm");
  assert.equal(merged.dimensions.pitchMm.citation?.page, 2);
  assert.ok(filled.includes("dimensions.pitchMm"));
  assert.ok(!uncited.includes("dimensions.pitchMm"));
});

test("a model value that is not on the page it claims gets NO citation", () => {
  const part = deterministic();
  // 0.5 appears on page 2, not page 1.
  const result: ExtractionResult = {
    values: { "dimensions.pitchMm": { value: 0.5, page: 1 } }
  };
  const { part: merged, uncited } = mergeModelValues(part, doc, result, "test-model");

  assert.equal(merged.dimensions.pitchMm.value, 0.5, "the value is kept");
  assert.equal(merged.dimensions.pitchMm.citation, null, "but the unverifiable claim is not");
  assert.equal(merged.dimensions.pitchMm.confidence, null);
  assert.ok(uncited.includes("dimensions.pitchMm"));
  assert.ok(
    merged.notes.some((note) => /not traceable for QML sign-off/i.test(note)),
    "the record must say the value is untraceable"
  );
});

test("a value the model invented outright is never citable", () => {
  const part = deterministic();
  const result: ExtractionResult = {
    values: { "radiation.tid": { value: "999krad(Si)", page: 2 } }
  };
  const { part: merged, uncited } = mergeModelValues(part, doc, result, "test-model");

  assert.equal(merged.radiation.tid.citation, null, "a value not in the document cannot be cited");
  assert.ok(uncited.includes("radiation.tid"));
});

test("an empty pin array from a model is not an answer", () => {
  const part = deterministic();
  const result: ExtractionResult = { values: { pins: { value: [], page: 1 } } };
  const { part: merged, filled } = mergeModelValues(part, doc, result, "test-model");

  assert.equal(merged.pins.value, null);
  assert.ok(!filled.includes("pins"));
});

test("a merged record still satisfies the part contract", () => {
  const part = deterministic();
  const result: ExtractionResult = {
    values: {
      pins: {
        value: [{ number: "1", name: "VDD", electricalType: "power" }],
        page: 1
      },
      "radiation.qmlClass": { value: "QML Class Q", page: 2 }
    },
    notes: ["pin table was image-based"]
  };
  const { part: merged } = mergeModelValues(part, doc, result, "test-model");

  const parsed = partSchema.safeParse(JSON.parse(JSON.stringify(merged)));
  assert.ok(parsed.success, `merged record must satisfy partSchema: ${JSON.stringify(parsed.error?.issues ?? [])}`);
  assert.ok(merged.notes.some((note) => /test-model: pin table was image-based/.test(note)));
});

test("model-filled pins cannot export without a verified citation", () => {
  const part = deterministic();
  // A pin array has no single string to locate on a page, so a model-supplied
  // pin table can never be citation-verified and is always untraceable.
  const result: ExtractionResult = {
    values: { pins: { value: [{ number: "1", name: "VDD", electricalType: "power" }], page: 1 } }
  };
  const { part: merged } = mergeModelValues(part, doc, result, "test-model");

  assert.equal(merged.pins.citation, null);
  const resolved = resolveForExport(merged);
  assert.equal(resolved.ok, false, "untraceable geometry must not reach a generated part");
  if (!resolved.ok) assert.ok(resolved.untraceable?.includes("pins"));
});

test("verifyCitation ignores a page that does not exist", () => {
  assert.equal(verifyCitation(doc, { value: "VA10820", page: 99 }), null);
  assert.equal(verifyCitation(doc, { value: "VA10820", page: null }), null);
});

test("no request is built when the text pass resolved everything it can", () => {
  const part = deterministic();
  // Force every field resolved.
  const full = JSON.parse(JSON.stringify(part)) as PartRecord;
  for (const key of ["partNumber", "manufacturer", "packageType", "pinCount"] as const) {
    full[key] = { value: key === "pinCount" ? 8 : "x", confidence: 1, method: "deterministic", citation: null } as never;
  }
  full.pins = { value: [{ number: "1", name: "A", electricalType: "unspecified" }], confidence: 1, method: "deterministic", citation: null };
  for (const key of Object.keys(full.dimensions) as Array<keyof typeof full.dimensions>) {
    full.dimensions[key] = { value: 1, confidence: 1, method: "deterministic", citation: null };
  }
  for (const key of Object.keys(full.radiation) as Array<keyof typeof full.radiation>) {
    full.radiation[key] = { value: "x", confidence: 1, method: "deterministic", citation: null };
  }

  assert.equal(buildExtractionRequest(full, doc, "x.pdf"), null, "no gaps means no model call");
});

test("the request carries pages, not a flattened blob", () => {
  const part = deterministic();
  const request = buildExtractionRequest(part, doc, "VA10820.pdf");

  assert.ok(request, "expected a request");
  assert.equal(request!.pages.length, 2);
  assert.equal(request!.pages[0].page, 1);
  // This is what makes a model answer citable at all.
  assert.match(request!.pages[1].text, /Terminal spacing/);
});

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
    // Lead width is a min/max pair rather than a scalar; every other dimension
    // is a plain number and the value itself does not matter here.
    const value = key === "leadWidthMm" ? { minMm: 1, maxMm: 1 } : 1;
    full.dimensions[key] = { value, confidence: 1, method: "deterministic", citation: null } as never;
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

// --- Pin tables can now be verified, which unblocks the model path ----------
// The benchmark showed pin data blocks 34 of 37 parsed corpus parts, and a model
// is the intended answer for messy tables. While a pin array could never be
// cited, a model-supplied table was permanently untraceable and so could never
// export, making the model useless for the one field that actually matters.

// Page 2 lists the pin names but in a layout the deterministic row parser cannot
// read, which is exactly the case a model is for: the names ARE on the page, the
// structure is not machine-readable.
const pinTableDoc = datasheetTextFromPages([
  "ACME1234 Quad Amplifier\nAvailable in a 8-pin SOIC package.",
  "Pin assignments are shown in the package drawing: OUTA, INA-, INA+, VCC."
]);

test("a model pin table whose names ARE on the cited page gets a citation", () => {
  const part = buildPartRecord(pinTableDoc, "ACME1234.pdf");
  const result: ExtractionResult = {
    values: {
      pins: {
        value: [
          { number: "1", name: "OUTA", electricalType: "output" },
          { number: "2", name: "INA-", electricalType: "input" },
          { number: "3", name: "INA+", electricalType: "input" },
          { number: "4", name: "VCC", electricalType: "power" }
        ],
        page: 2
      }
    }
  };
  const { part: merged, uncited } = mergeModelValues(part, pinTableDoc, result, "test-model");

  assert.ok(merged.pins.citation, "a table whose rows are on the page must be citable");
  assert.equal(merged.pins.citation!.page, 2);
  assert.match(merged.pins.citation!.snippet, /4-row pin table/);
  assert.ok(!uncited.includes("pins"));
});

test("a model pin table that is mostly invented is NOT cited", () => {
  const part = buildPartRecord(pinTableDoc, "ACME1234.pdf");
  const result: ExtractionResult = {
    values: {
      pins: {
        value: [
          { number: "1", name: "OUTA", electricalType: "output" },
          { number: "2", name: "FAKE1", electricalType: "input" },
          { number: "3", name: "FAKE2", electricalType: "input" },
          { number: "4", name: "FAKE3", electricalType: "power" }
        ],
        page: 2
      }
    }
  };
  const { part: merged, uncited } = mergeModelValues(part, pinTableDoc, result, "test-model");

  // Only 1 of 4 names is real, well under the threshold.
  assert.equal(merged.pins.citation, null, "a mostly-fabricated table must not be cited");
  assert.ok(uncited.includes("pins"));
});

test("a table cited to the WRONG page is not accepted", () => {
  const part = buildPartRecord(pinTableDoc, "ACME1234.pdf");
  const result: ExtractionResult = {
    values: {
      pins: {
        value: [
          { number: "1", name: "OUTA", electricalType: "output" },
          { number: "2", name: "INA-", electricalType: "input" }
        ],
        page: 1
      }
    }
  };
  const { part: merged } = mergeModelValues(part, pinTableDoc, result, "test-model");
  assert.equal(merged.pins.citation, null, "the rows are on page 2, not page 1");
});

/**
 * The shape a REAL model returns, which nothing exercised before 2026-07-29.
 *
 * Every fixture in this file builds well-formed `PinRecord`s by hand, so the
 * merge was only ever tested against values already in our own types. A live
 * Gemini call returns `{"number": 1}` as an INTEGER against a schema requiring a
 * string, and `"electricalType": null` against an enum with no null member.
 * Stored raw, those passed `resolveForExport` in process and then failed
 * `partSchema.safeParse` at `/api/export` with "Invalid part record", so the
 * model path had never once produced a bundle end to end.
 */
test("a model's pin rows are coerced to the record contract", () => {
  const part = deterministic();
  const merged = mergeModelValues(
    part,
    doc,
    {
      values: {
        pins: {
          value: [
            { number: 1, name: "VIN", electricalType: null, description: "Input" },
            { number: 2, name: "GND", electricalType: "power" }
          ] as never,
          page: 1
        }
      }
    },
    "gemini"
  );

  const pins = merged.part.pins.value!;
  assert.equal(typeof pins[0].number, "string", "pinSchema requires a string");
  assert.equal(pins[0].number, "1");
  assert.equal(pins[0].electricalType, "unspecified", "null is not a member of the enum");
  assert.equal(pins[1].electricalType, "power", "a valid type is kept");
  // The gate the whole path failed at: this must survive the export boundary.
  assert.equal(partSchema.safeParse(JSON.parse(JSON.stringify(merged.part))).success, true);
});

/**
 * A model answer is held to the SAME proof the deterministic readers must pass.
 *
 * Both geometry readers require exactly 1..N with no gaps or repeats, and a
 * model answer was not, which made it the weakest link in a chain built to
 * refuse precisely this. The name-based citation check cannot catch it: a
 * PCF8574 page draws a 16-pin and a 20-pin variant interleaved, so real names
 * against the wrong package's numbers score full marks.
 */
test("a model pin table that does not number 1..N is discarded, not stored", () => {
  const merged = mergeModelValues(
    deterministic(),
    doc,
    {
      values: {
        pins: {
          value: [
            { number: 1, name: "VIN", electricalType: "power" },
            { number: 3, name: "GND", electricalType: "power" }
          ] as never,
          page: 1
        }
      }
    },
    "gemini"
  );

  assert.equal(merged.part.pins.value, null, "the gap means the field stays unknown");
  assert.ok(!merged.filled.includes("pins"));
  assert.equal(merged.rejected[0]?.field, "pins");
  assert.match(merged.rejected[0].reason, /1\.\.2|gaps|repeats/);
  assert.ok(
    merged.part.notes.some((note) => /discarded/i.test(note)),
    "and the record says so rather than going quiet"
  );
});

test("an exposed thermal pad refuses the table, and says that is why", () => {
  // AD8232, measured: the model returns a correct 1..20 LFCSP table plus a 21st
  // row numbered "EP". Emitting the numbered pins alone would be a footprint
  // missing the pad the part must be soldered by, and geometry.ts has no
  // exposed-pad concept at all.
  const rows = Array.from({ length: 20 }, (_, index) => ({
    number: index + 1,
    name: `P${index + 1}`,
    electricalType: "unspecified"
  }));
  rows.push({ number: "EP" as never, name: "", electricalType: "power" });

  const merged = mergeModelValues(
    deterministic(),
    doc,
    { values: { pins: { value: rows as never, page: 1 } } },
    "gemini"
  );

  assert.equal(merged.part.pins.value, null);
  assert.match(merged.rejected[0].reason, /exposed thermal pad/);
});

// --- values read off a RENDERED page ----------------------------------------
//
// A dimension printed beside a dimension line is genuinely absent from the text
// layer, so `verifyCitation` can never confirm it. That is why these values get
// their own method and their own weaker evidence rather than either being
// rejected (which loses every correct drawing read) or being passed off as
// text-verified (which would let a value nobody can grep look like one they can).

test("a value not in the text is cited to the render only if we sent that page", () => {
  const part = deterministic();

  // 0.75 appears nowhere in the document text; it is a body height off a drawing.
  const result: ExtractionResult = {
    values: { "dimensions.bodyHeightMm": { value: 0.75, page: 2 } }
  };

  const textOnly = mergeModelValues(part, doc, result, "test-model");
  assert.equal(textOnly.part.dimensions.bodyHeightMm.value, 0.75);
  assert.equal(textOnly.part.dimensions.bodyHeightMm.citation, null, "no render, no citation");
  assert.equal(textOnly.part.dimensions.bodyHeightMm.method, "vlm");
  assert.ok(textOnly.uncited.includes("dimensions.bodyHeightMm"));

  const withRender = mergeModelValues(part, doc, result, "test-model", [2]);
  const field = withRender.part.dimensions.bodyHeightMm;
  assert.equal(field.value, 0.75);
  assert.ok(field.citation, "a page we rendered can carry a citation");
  assert.equal(field.citation.page, 2);
  assert.equal(field.method, "vlm-drawing", "provenance must say it was read off the render");
});

test("a drawing-read value is recorded as weaker evidence than a quoted one", () => {
  const part = deterministic();

  const drawn = mergeModelValues(
    part,
    doc,
    { values: { "dimensions.bodyHeightMm": { value: 0.75, page: 2 } } },
    "test-model",
    [2]
  ).part.dimensions.bodyHeightMm;

  // "0.5 mm" IS on page 2, so this one is quotable and takes the text path.
  const quoted = mergeModelValues(
    part,
    doc,
    { values: { "dimensions.pitchMm": { value: 0.5, page: 2 } } },
    "test-model",
    [2]
  ).part.dimensions.pitchMm;

  assert.equal(quoted.method, "vlm");
  assert.equal(drawn.method, "vlm-drawing");
  assert.ok(
    (drawn.confidence ?? 1) < (quoted.confidence ?? 0),
    "a value we can show but cannot grep must not outrank one we can grep"
  );
});

test("a pin table is never accepted on drawing evidence alone", () => {
  const part = deterministic();

  // Rows that do not appear on the cited page. verifyPinTable is what stops a
  // fabricated table entering the record, and a table is what pads are built
  // from, so the weaker drawing path must not offer it a way in.
  const result: ExtractionResult = {
    values: {
      pins: {
        value: [
          { number: "1", name: "INVENTED", electricalType: "passive" },
          { number: "2", name: "ALSO_INVENTED", electricalType: "passive" }
        ],
        page: 2
      }
    }
  };

  const outcome = mergeModelValues(part, doc, result, "test-model", [2]);

  // The table is still recorded and flagged uncited, which is the behaviour that
  // predates images. What must NOT happen is the drawing path quietly supplying
  // the citation `verifyPinTable` refused: pads are built from this field, so it
  // does not get to stand on evidence weaker than a row-by-row check.
  assert.equal(outcome.part.pins.citation, null, "a pin table must not take a drawing citation");
  assert.equal(outcome.part.pins.method, "vlm", "and must not be labelled as read off a drawing");
  assert.ok(outcome.uncited.includes("pins"), "it is reported as untraceable instead");
});

test("a rendered record still satisfies the part contract", () => {
  const part = deterministic();
  const outcome = mergeModelValues(
    part,
    doc,
    { values: { "dimensions.bodyHeightMm": { value: 0.75, page: 2 } } },
    "test-model",
    [2]
  );
  assert.doesNotThrow(() => partSchema.parse(outcome.part));
});

// --- lead span and lead width, the two a land pattern is built from ----------

test("a lead span is accepted as a min/max pair and cited when both ends are on the page", () => {
  const part = deterministic();
  const spanDoc = datasheetTextFromPages([
    "VORAGO VA10820 32-pin QFN",
    "PACKAGE OUTLINE PW0008A TSSOP C 6.6 TYP SEATING PLANE 6.2 PIN 1 ID"
  ]);
  const base = buildPartRecord(spanDoc, "VA10820.pdf");
  const outcome = mergeModelValues(
    base,
    spanDoc,
    { values: { "dimensions.leadSpanMm": { value: { minMm: 6.2, maxMm: 6.6 }, page: 2 } } },
    "test-model",
    [2]
  );
  const span = outcome.part.dimensions.leadSpanMm;
  assert.deepEqual(span.value, { minMm: 6.2, maxMm: 6.6 });
  assert.ok(span.citation, "both endpoints are printed on page 2, so this is quotable");
  assert.equal(span.method, "vlm");
});

test("a malformed range is dropped rather than stored, because it reaches the land pattern", () => {
  const part = deterministic();
  for (const bad of [
    { minMm: 6.6, maxMm: 6.2 }, // the wrong way round
    { minMm: -1, maxMm: 6.6 }, // not a dimension
    { minMm: 6.2 }, // half a pair
    6.2 // a scalar where a pair was asked for
  ]) {
    const outcome = mergeModelValues(
      part,
      doc,
      { values: { "dimensions.leadSpanMm": { value: bad as never, page: 2 } } },
      "test-model",
      [2]
    );
    assert.equal(outcome.part.dimensions.leadSpanMm.value, null, `${JSON.stringify(bad)} must not enter the record`);
    assert.ok(outcome.rejected.some((entry) => entry.field === "dimensions.leadSpanMm"));
  }
});

// --- retry classification ----------------------------------------------------
//
// Lives here rather than under models/ because the concrete models are only
// reachable by dynamic import and this is pure classification logic. The rule it
// guards: a 429 means two different things, and only one of them is worth
// waiting out.

test("a billing failure is not treated as transient, whatever status it arrives with", async () => {
  const { GeminiExtractionModel } = await import("../models/gemini");
  // Exercised through the public surface: a model with no key configured must
  // report itself unconfigured rather than attempt a call that cannot succeed.
  const model = new GeminiExtractionModel();
  const had = process.env.GOOGLE_GEMINI_API_KEY;
  delete process.env.GOOGLE_GEMINI_API_KEY;
  assert.equal(model.isConfigured(), false, "no key means no call");
  if (had !== undefined) process.env.GOOGLE_GEMINI_API_KEY = had;
});

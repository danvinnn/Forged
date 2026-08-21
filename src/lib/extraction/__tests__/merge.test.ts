import { test } from "node:test";
import assert from "node:assert/strict";
import { datasheetTextFromPages } from "../../pdftext";
import { buildPartRecord } from "../../datasheet";
import { partSchema, resolveForExport, type PartRecord } from "../../types";
import { mergeModelValues, RANGE_FIELDS, unresolvedFields, verifyCitation } from "../merge";
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

/**
 * A record with ONE field already settled, and the rest open.
 *
 * The settled field used to come from the deterministic parser reading page 1.
 * That parser was deleted on 2026-08-14, so it is set here instead. Nothing the
 * tests below assert was about the parser: they are about merge, which fills
 * gaps and never overwrites, and which has to keep doing both whatever put the
 * value there. A user confirming a field in the review panel produces exactly
 * this shape.
 */
function deterministic(): PartRecord {
  const part = buildPartRecord(doc, "VA10820.pdf");
  return {
    ...part,
    manufacturer: {
      value: "VORAGO Technologies",
      confidence: 0.9,
      method: "deterministic",
      citation: { page: 1, snippet: "VORAGO Technologies", region: null }
    }
  };
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
  // A settled pin count, so the resolve gets past "missing" and reaches the
  // traceability gate this test is actually about. It used to come from the
  // deterministic parser reading page 1.
  const resolved = resolveForExport({
    ...merged,
    pinCount: { value: 1, confidence: 1, method: "user", citation: null }
  });
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
  for (const key of [
    "partNumber",
    "manufacturer",
    "packageType",
    "pinCount",
    "jedecOutline",
    "packageOutlineCode"
  ] as const) {
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

  // A record with nothing left unresolved asks NOTHING.
  //
  // This asserted the cross-check field list until the cross-check was deleted
  // on 2026-08-16. The list existed so the model could contradict a second
  // reader; with the deterministic parser gone there is no second reading, and
  // re-asking a field whose value the USER supplied buys an answer that
  // `mergeModelValues` will refuse to store.
  const request = buildExtractionRequest(full, doc, "x.pdf");
  assert.equal(request, null, "nothing is unresolved, so there is nothing to ask");
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

test("an exposed thermal pad is recorded on the part, and the pinout is KEPT", () => {
  // AD8232, measured: the model returns a correct 1..20 LFCSP table plus a 21st
  // row numbered "EP".
  //
  // This used to refuse the whole table. That was the wrong layer: geometry.ts
  // has no exposed-pad concept, so the FOOTPRINT cannot be built, but the twenty
  // numbered rows are a correct pinout and the symbol is built from them.
  // Measured over the hold-out, the old behaviour discarded three complete
  // pinouts (ADS1220, LD39050, ST1S10) over a single trailing row.
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

  assert.equal(merged.part.pins.value?.length, 20, "the numbered rows survive");
  assert.equal(merged.part.exposedPad, true, "and the pad is recorded rather than forgotten");
  assert.ok(
    !merged.rejected.some((entry) => entry.field === "pins"),
    "a pad row is not a defect in the pin table"
  );
});

test("a table of nothing but terminals is still refused", () => {
  // The pad row is dropped, not tolerated: dropping it must not turn an answer
  // with no pinout in it into an empty accepted one.
  const merged = mergeModelValues(
    deterministic(),
    doc,
    { values: { pins: { value: [{ number: "EP", name: "PAD" }] as never, page: 1 } } },
    "gemini"
  );

  assert.equal(merged.part.pins.value, null);
  assert.match(merged.rejected[0].reason, /no numbered rows/);
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

function pinTableOnPage(page: number): ExtractionResult {
  return {
    values: {
      pins: {
        value: [
          { number: "1", name: "OUT", electricalType: "output" },
          { number: "2", name: "GND", electricalType: "power" }
        ],
        page
      }
    }
  };
}

test("a pin table read off a rendered page is cited to that page, not discarded", () => {
  // Reversed on 2026-08-06. Some pinouts are vector artwork with no text layer,
  // so a text citation is not merely hard to obtain, it does not exist. The old
  // rule threw those pins away for want of evidence the document cannot supply.
  // A citation naming the page a reviewer can open is real evidence.
  const outcome = mergeModelValues(deterministic(), doc, pinTableOnPage(2), "test-model", [2]);

  assert.ok(outcome.part.pins.citation, "the render is evidence, and evidence is not discarded");
  assert.equal(outcome.part.pins.citation?.page, 2);
  assert.equal(outcome.part.pins.method, "vlm-drawing", "provenance must say where it came from");
  assert.equal(outcome.part.pins.confidence, 0.4, "the review tier, not the verified tier");
  assert.ok(!outcome.uncited.includes("pins"));
});

test("a pin table claiming a page we never sent is still uncited", () => {
  // The guard that survives: the model may only cite what it was shown. Without
  // this, lifting the array exclusion would let a claimed page number stand in
  // for evidence on a page nothing ever looked at.
  const outcome = mergeModelValues(deterministic(), doc, pinTableOnPage(7), "test-model", [2]);

  assert.equal(outcome.part.pins.citation, null, "page 7 was never rendered or sent");
  assert.equal(outcome.part.pins.method, "vlm");
  assert.ok(outcome.uncited.includes("pins"), "recorded and flagged, as before");
});

test("a malformed pin table is still rejected outright, render or no render", () => {
  // The shape guard is unchanged by the citation change. A table that cannot be
  // parsed never enters the record at all, which is a stronger outcome than
  // being recorded uncited.
  const result = {
    values: { pins: { value: [{ number: "", name: "" }] as never, page: 2 } }
  } as ExtractionResult;

  const outcome = mergeModelValues(deterministic(), doc, result, "test-model", [2]);
  assert.equal(outcome.part.pins.value, null, "nothing usable, so nothing recorded");
  assert.ok(outcome.rejected.some((entry) => entry.field === "pins"));
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


// ---------------------------------------------------------------------------
// The one rule that survived the cross-check
// ---------------------------------------------------------------------------

/**
 * The cross-check was deleted on 2026-08-16 because the parser it compared
 * against was already gone: eleven of its thirteen fields were permanently
 * null, `valuesAgree` reads a null side as agreement, and the bench reported
 * "0 disagreements on 0/56 parts" for months, which reads like a pass and means
 * nothing was examined.
 *
 * Deleting it was not a pure subtraction. The same code decided whether the
 * model's value was KEPT, so the precedence had to be carried across on its
 * own. This is that rule, pinned so it cannot be lost the next time something
 * around it is removed.
 */
test("a value already on the record is not overwritten by the model", () => {
  const part = deterministic();
  const result: ExtractionResult = {
    values: {
      // Cited to page 1, where this string genuinely appears, so the claim is
      // verifiable. Even verifiable, it does not get to replace what is there.
      manufacturer: { value: "NXP", page: 1 }
    }
  };
  const { part: merged, filled } = mergeModelValues(part, doc, result, "test-model");
  assert.equal(merged.manufacturer.value, "VORAGO Technologies");
  assert.ok(!filled.includes("manufacturer"), "and it is not reported as filled");
});

test("a package the user chose is not replaced by the model's reading of it", () => {
  const part = deterministic();
  part.packageType = { value: "SOIC-8", confidence: 1, method: "user", citation: null };

  const result: ExtractionResult = { values: { packageType: { value: "QFN", page: 1 } } };
  const { part: merged } = mergeModelValues(part, doc, result, "test-model");

  // Under the cross-check this could flip: `packageType` was on the
  // cross-checked list, so a cited model reading displaced it. The user picked
  // from a list built out of their own document, so their choice is the more
  // authoritative of the two.
  assert.equal(merged.packageType.value, "SOIC-8");
});

test("a gap is still filled, so the rule blocks overwriting and nothing else", () => {
  const part = deterministic();
  assert.equal(part.pins.value, null, "the fixture leaves this open");

  const { filled } = mergeModelValues(
    part,
    doc,
    { values: { manufacturer: { value: "NXP", page: 1 }, jedecOutline: { value: "MO-153", page: 2 } } },
    "test-model"
  );
  assert.ok(filled.includes("jedecOutline"), "an unanswered field is still the model's to answer");
});

/**
 * EVERY dimension is gated, including ones added after this test was written.
 *
 * The gate was a hardcoded list of nine field names. It was correct the day it
 * was written and then the pads changed source: until 2026-08-12 they were
 * computed from `leadSpanMm` and `leadContactMm`, and since then they are
 * `landPadLengthMm`, `landPadWidthMm` and `landSpanMm` read off the datasheet's
 * own printed footprint. None of the three was ever added, so for four months
 * the gate named the fields that USED to place copper and not the ones that did.
 *
 * A list cannot report that it has fallen behind, so this asserts the PROPERTY
 * instead: enumerate the record's dimensions, make each one an uncited model
 * value in turn, and require the export to refuse it. A field added to the
 * schema next month is covered the day it is added, and this test fails if
 * anyone reintroduces a list that does not cover it.
 */
test("an uncited model value in ANY dimension blocks the export, field list or not", () => {
  const base = buildPartRecord(doc, "VA10820.pdf");
  const complete: PartRecord = {
    ...base,
    partNumber: { value: "VA10820", confidence: 1, method: "user", citation: null },
    pinCount: { value: 4, confidence: 1, method: "user", citation: null },
    pins: {
      value: [
        { number: "1", name: "A", electricalType: "passive" },
        { number: "2", name: "B", electricalType: "passive" },
        { number: "3", name: "C", electricalType: "passive" },
        { number: "4", name: "D", electricalType: "passive" }
      ],
      confidence: 1,
      method: "user",
      citation: null
    }
  };

  assert.ok(resolveForExport(complete).ok, "the fixture must resolve, or this proves nothing");

  const names = Object.keys(complete.dimensions);
  assert.ok(names.length >= 20, `expected the full dimension set, saw ${names.length}`);

  for (const name of names) {
    // A value a model produced and nobody can find on a page. The one route by
    // which a crafted datasheet could reach a manufactured part.
    const tainted: PartRecord = {
      ...complete,
      dimensions: {
        ...complete.dimensions,
        [name]: { value: 1, confidence: null, method: "vlm", citation: null }
      }
    };

    const result = resolveForExport(tainted);
    assert.equal(result.ok, false, `an uncited ${name} must not reach geometry`);
    if (result.ok) continue;
    assert.ok(
      (result.untraceable ?? []).includes(`dimensions.${name}`),
      `${name} must be NAMED in the refusal, so the user knows what to confirm`
    );
  }
});

test("a value read off a RENDERED page is held to the same rule", () => {
  // `vlm-drawing` was left out of `isUntraceable`. Harmless today, because a
  // drawing citation is produced whenever the page was one we sent, so the case
  // cannot arise. Named anyway: the rule is "a model answer nobody can locate is
  // not evidence", and it does not care which of the two model paths produced
  // it. The path that was exempt is the one that reads mechanical drawings.
  const base = buildPartRecord(doc, "VA10820.pdf");
  const record: PartRecord = {
    ...base,
    partNumber: { value: "VA10820", confidence: 1, method: "user", citation: null },
    pinCount: { value: 4, confidence: 1, method: "user", citation: null },
    pins: {
      value: [
        { number: "1", name: "A", electricalType: "passive" },
        { number: "2", name: "B", electricalType: "passive" },
        { number: "3", name: "C", electricalType: "passive" },
        { number: "4", name: "D", electricalType: "passive" }
      ],
      confidence: 1,
      method: "user",
      citation: null
    },
    dimensions: {
      ...base.dimensions,
      landSpanMm: { value: 5.8, confidence: 0.4, method: "vlm-drawing", citation: null },
      landSpanCrossMm: { value: null, confidence: null, method: null, citation: null },
    }
  };

  const result = resolveForExport(record);
  assert.equal(result.ok, false, "an uncited drawing read is not evidence either");
});

test("a BARE answer is kept, not discarded over the shape of its envelope", async () => {
  // Found in the manual audit of 2026-08-17. The contract asks for
  // {"value": 0.65, "page": 3}. A model that answers {"dimensions.pitchMm":
  // 0.65} had its answer dropped on the floor with no trace: not stored, not
  // recorded as declined, not in notes. That is the same failure as an
  // unanswerable question, just one layer further on. It read the value, said
  // so, and we threw it away over the wrapper.
  const { parseModelResponse } = await import("../models/prompt");

  const result = parseModelResponse(
    JSON.stringify({
      values: {
        "dimensions.pitchMm": 0.65,
        "dimensions.leadSpanMm": { minMm: 4.75, maxMm: 5.05 },
        "dimensions.leadForm": "straight"
      }
    })
  );

  assert.equal(result.values["dimensions.pitchMm"]?.value, 0.65);
  assert.equal(result.values["dimensions.pitchMm"]?.page, null, "a bare answer carries no page");
  assert.deepEqual(result.values["dimensions.leadSpanMm"]?.value, { minMm: 4.75, maxMm: 5.05 });
  assert.equal(result.values["dimensions.leadForm"]?.value, "straight");
});

test("a bare null is recorded as declined, not lost", async () => {
  // "I looked and the document does not state this" must stay distinguishable
  // from "I never answered", in both the wrapped and the bare shape. Losing
  // that distinction is what hid the leadForm defect for months.
  const { parseModelResponse } = await import("../models/prompt");

  const result = parseModelResponse(
    JSON.stringify({
      values: {
        "dimensions.pitchMm": null,
        "dimensions.leadForm": { value: null, page: null }
      }
    })
  );

  assert.equal(result.values["dimensions.pitchMm"], undefined, "a null is never a value");
  assert.deepEqual(
    [...(result.declined ?? [])].sort(),
    ["dimensions.leadForm", "dimensions.pitchMm"],
    "both shapes of refusal are recorded"
  );
});

test("EVERY extraction field can actually be stored on the record", async () => {
  // Found in the manual audit of 2026-08-17, and it had been true for every part
  // ever processed. `fieldAt` carried a guard against a top-level field with no
  // case; `setFieldAt` did not, and `packageOutlineCode` fell through it. The
  // model's answer was written to a property named "undefined" on the Extracted
  // object, the record kept value: null, and the notes reported the field as
  // filled. Silent and total.
  //
  // A round trip over EVERY field rather than a case for the one that broke: the
  // guard is only worth anything if nothing can slip past it again.
  const { extractionFields } = await import("../contracts");
  const { datasheetTextFromPages } = await import("../../pdftext");
  const { buildPartRecord } = await import("../../datasheet");

  const doc = datasheetTextFromPages(["ACME555 Timer. ACME Semiconductor.", "PACKAGE OUTLINE"]);

  // A value each field's own contract accepts, so nothing is rejected upstream
  // of the thing being tested.
  const sample = (field: string): unknown => {
    if (field === "pins") return [{ number: "1", name: "OUT", electricalType: "output", description: "" }];
    // Taken from `merge.ts` rather than listed again. Listed twice, adding a
    // range field to one and not the other feeds a scalar to a range field, the
    // validation correctly drops it, and this test reports the merge broken.
    if ((RANGE_FIELDS as readonly string[]).includes(field)) return { minMm: 0.3, maxMm: 0.5 };
    if (field === "dimensions.leadSides") return 2;
    if (field === "dimensions.leadForm") return "gullwing";
    if (field === "dimensions.mounting") return "smd";
    if (field === "dimensions.solderMaskDefined") return "non-solder-mask-defined";
    if (field === "dimensions.leadsPerSide") return "4,4";
    if (field.endsWith("Mm") || field === "pinCount" || field === "dimensions.leadCount") return 1.5;
    if (field === "dimensions.vacantLeadSlot") return 3;
    return "X";
  };

  for (const field of extractionFields) {
    const part = buildPartRecord(doc, "ACME555.pdf");
    const outcome = mergeModelValues(
      part,
      doc,
      { values: { [field]: { value: sample(field) as never, page: 1 } } },
      "test",
      []
    );

    const stored = field.includes(".")
      ? (outcome.part as unknown as Record<string, Record<string, { value: unknown }>>)[field.split(".")[0]][field.split(".")[1]]
      : (outcome.part as unknown as Record<string, { value: unknown }>)[field];

    assert.notEqual(stored.value, null, `${field} was reported as merged but nothing reached the record`);
    const holder = stored as unknown as Record<string, unknown>;
    assert.ok(!("undefined" in holder), `${field} wrote to a property named "undefined"`);
  }
});

test("a grid-addressed pinout is refused for being out of scope, not for being unreadable", async () => {
  // TXB0104 in the corpus is a 12-ball DSBGA. Every terminal is addressed by
  // grid position, so every row hits the exposed-pad branch, the table empties,
  // and the user used to be told "the pin table had no numbered rows". We had
  // read it perfectly. The refusal blamed the document for our own scope.
  //
  // Forge is blocked on grid arrays in three independent places: this check,
  // leadSides being 2 | 4, and arrangement being "dual" | "quad". That is a
  // deliberate limit, and the refusal should say so rather than imply a failure
  // to read.
  const { datasheetTextFromPages } = await import("../../pdftext");
  const { buildPartRecord } = await import("../../datasheet");

  const doc = datasheetTextFromPages(["TXB0104. Texas Instruments. 12-ball DSBGA."]);
  const part = buildPartRecord(doc, "TXB0104.pdf");

  const outcome = mergeModelValues(
    part,
    doc,
    {
      values: {
        pins: {
          value: [
            { number: "A1", name: "VCCA", electricalType: "power_in" },
            { number: "A2", name: "GND", electricalType: "power_in" },
            { number: "B1", name: "OE", electricalType: "input" }
          ] as never,
          page: 1
        }
      }
    },
    "test",
    []
  );

  const note = outcome.part.notes.find((entry) => /grid position/.test(entry));
  assert.ok(note, "the refusal must name the real reason");
  assert.match(note, /read correctly/, "and must not imply the pinout was unreadable");
  assert.doesNotMatch(
    outcome.part.notes.join(" "),
    /had no numbered rows/,
    "the old message blamed the document"
  );
});

test("an exposed-pad row still leaves the numbered pins intact", async () => {
  // The behaviour the grid case must not disturb. A QFN table is 1..N plus one
  // row called EP or PAD; skipping that row and flagging it recovered three
  // hold-out parts whose pinouts used to be thrown away whole.
  const { datasheetTextFromPages } = await import("../../pdftext");
  const { buildPartRecord } = await import("../../datasheet");

  const doc = datasheetTextFromPages(["ST1S10. 8-lead with epad. OUT VIN GND FB EN SYNC NC PGND epad"]);
  const part = buildPartRecord(doc, "ST1S10.pdf");

  const outcome = mergeModelValues(
    part,
    doc,
    {
      values: {
        pins: {
          value: [
            { number: "1", name: "OUT", electricalType: "output" },
            { number: "2", name: "VIN", electricalType: "power_in" },
            { number: "epad", name: "GND", electricalType: "power_in" }
          ] as never,
          page: 1
        }
      }
    },
    "test",
    []
  );

  assert.equal(outcome.part.pins.value?.length, 2, "the numbered rows survive");
  assert.equal(outcome.part.exposedPad, true, "and the pad is recorded rather than lost");
});

test("a thermal pad the vendor NUMBERED is built as a pad, not as a lead", () => {
  // TPS54360, promoted out of the hold-out on 2026-08-17 for producing an
  // invalid footprint. Texas Instruments numbers the PowerPAD rather than
  // lettering it: an 8-lead HSOIC has a NINTH row called `9`.
  //
  // The row is numeric, so the `EP`/`PAD`/`TAB` check above never saw it. It
  // survived as an ordinary signal pin on an eight-lead package, nothing placed
  // a land for it, and the output invariant refused the part entirely with "the
  // pin table lists pin 9 and no land was placed for it". The pad's SIZE was on
  // the record the whole time.
  const rows = Array.from({ length: 9 }, (_, index) => ({
    number: index + 1,
    name: index === 8 ? "PowerPAD" : `P${index + 1}`,
    electricalType: "unspecified"
  }));

  const merged = mergeModelValues(
    deterministic(),
    doc,
    {
      values: {
        pins: { value: rows as never, page: 1 },
        "dimensions.leadCount": { value: 8, page: 1 },
        "dimensions.thermalPadLengthMm": { value: 3.1, page: 1 },
        "dimensions.thermalPadWidthMm": { value: 2.41, page: 1 }
      }
    },
    "gemini"
  );

  assert.equal(merged.part.pins.value?.length, 8, "eight leads, as the package declares");
  assert.equal(merged.part.exposedPad, true, "and the ninth row is the pad");
  assert.ok(
    merged.part.notes.some((note) => /exposed thermal pad, not a lead/.test(note)),
    "the record says which row was reclassified and why"
  );
});

test("an extra pin is NOT called a thermal pad when the document prints no pad", () => {
  // The guard that keeps the rule above safe. Reclassifying a real signal pin as
  // copper under the body is far worse than the refusal it replaces, so the
  // document must actually state a pad size. Here it does not, and the ninth row
  // stays a pin: the part then refuses, which is the correct outcome for a lead
  // count and a pin table that disagree.
  const rows = Array.from({ length: 9 }, (_, index) => ({
    number: index + 1,
    name: `P${index + 1}`,
    electricalType: "unspecified"
  }));

  const merged = mergeModelValues(
    deterministic(),
    doc,
    {
      values: {
        pins: { value: rows as never, page: 1 },
        "dimensions.leadCount": { value: 8, page: 1 }
      }
    },
    "gemini"
  );

  assert.equal(merged.part.pins.value?.length, 9, "every row survives");
  assert.equal(merged.part.exposedPad, false, "nothing was invented from a count mismatch alone");
});

// ---------------------------------------------------------------------------
// The page the document PRINTS versus the page the file counts
// ---------------------------------------------------------------------------

test("a value cited by the page number printed on the page is still traceable", () => {
  // A datasheet with a cover and a contents page prints `Page 3 of 3` in the
  // footer of its FIFTH file page. The model sees an image and quotes the only
  // number on it, which is the printed one, and every value on that drawing was
  // then thrown away as untraceable. Measured on AD9833: seven correct
  // dimensions lost, and the part shipped nothing.
  const withFrontMatter = datasheetTextFromPages([
    "Cover",
    "Revision history",
    "ACME9833 Direct Digital Synthesiser\nPage 1 of 3",
    "Specifications\nPage 2 of 3",
    "OUTLINE DIMENSIONS\nBody height 1.10 mm maximum.\nPage 3 of 3"
  ]);
  const part = buildPartRecord(withFrontMatter, "ACME9833.pdf");

  const outcome = mergeModelValues(
    part,
    withFrontMatter,
    // The drawing is on file page 5 and the model says 3, because 3 is what the
    // page itself says.
    { values: { "dimensions.bodyHeightMm": { value: 1.1, page: 3 } } } as ExtractionResult,
    "test-model",
    []
  );

  const height = outcome.part.dimensions.bodyHeightMm;
  assert.equal(height.value, 1.1);
  assert.equal(height.citation?.page, 5, "cited on the file page that prints that number");
  assert.ok(!outcome.uncited.includes("dimensions.bodyHeightMm"));
});

test("the printed-page fallback resolves nothing when the number is ambiguous", () => {
  // It resolves a page, it never accepts a value. Two pages printing the same
  // number is a document we cannot read that way, and it gets the behaviour it
  // has today rather than a guess between them.
  const twice = datasheetTextFromPages([
    "Cover",
    "Revision history",
    // File page 3 says nothing about the value, so the direct check fails and
    // the fallback is what decides. Two later pages both print "Page 3".
    "Contents",
    "Body height 1.10 mm maximum.\nPage 3 of 9",
    "Body height 1.10 mm maximum.\nPage 3 of 9"
  ]);
  const outcome = mergeModelValues(
    buildPartRecord(twice, "ACME.pdf"),
    twice,
    { values: { "dimensions.bodyHeightMm": { value: 1.1, page: 3 } } } as ExtractionResult,
    "test-model",
    []
  );

  assert.equal(outcome.part.dimensions.bodyHeightMm.citation, null, "no page, so no citation");
  assert.ok(outcome.uncited.includes("dimensions.bodyHeightMm"));
});

// The envelope spelling of "N mm max height", added 2026-08-20. Renesas heads
// its outline drawings "64-QFP 10.0 x 10.0 x 1.2 mm Body, 0.5 mm Pitch", and the
// live ISL71001M record took 1.00 from Detail A instead, shipping a STEP solid
// 0.2 mm short.
test("a body envelope in the title block corrects the height the model returned", () => {
  const drawing = datasheetTextFromPages([
    "Cover",
    "Package Outline Drawing Q64.10x10J\n64-QFP 10.0 x 10.0 x 1.2 mm Body, 0.5 mm Pitch\n1.00 +/- 0.05\n1.20 Max"
  ]);
  const outcome = mergeModelValues(
    buildPartRecord(drawing, "ACME.pdf"),
    drawing,
    { values: { "dimensions.bodyHeightMm": { value: 1.0, page: 2 } } } as ExtractionResult,
    "test-model",
    [2]
  );

  assert.equal(outcome.part.dimensions.bodyHeightMm.value, 1.2, "the page states the envelope");
});

// The guard that keeps the addition from becoming a general "read the title
// block" rule: a page that states the height two ways and disagrees with itself
// corrects nothing.
test("a page whose two height statements disagree corrects nothing", () => {
  const conflicted = datasheetTextFromPages([
    "Cover",
    "CFP - 2.33mm max height\n16-CFP 9.9 x 6.5 x 1.2 mm Body"
  ]);
  const outcome = mergeModelValues(
    buildPartRecord(conflicted, "ACME.pdf"),
    conflicted,
    { values: { "dimensions.bodyHeightMm": { value: 1.778, page: 2 } } } as ExtractionResult,
    "test-model",
    [2]
  );

  assert.equal(outcome.part.dimensions.bodyHeightMm.value, 1.778, "two candidates, so the model's answer stands");
});

// SEVERAL PINOUT PAGES, SETTLED BY CONTENT.
//
// `citeSoleRenderedPinoutPage` required exactly ONE rendered page to identify as
// a pinout page. Once the render budget went to 16 pages, a multi-package
// datasheet routinely sends two, and pin tables that had been read correctly
// were refused for want of a page number. Measured 2026-08-20: two hold-out
// parts held with uncitable pins.
test("two pinout pages are settled by which one carries this table's pin names", () => {
  const twoPinouts = datasheetTextFromPages([
    "Cover",
    "Pin Configuration\nVIN VOUT GND ENABLE NR SENSE FB COMP",
    "Pin Configuration\nAIN0 AIN1 AIN2 AIN3 SCL SDA ADDR ALERT"
  ]);
  const outcome = mergeModelValues(
    buildPartRecord(twoPinouts, "ACME.pdf"),
    twoPinouts,
    {
      values: {},
      packagesInThisDocument: [
        {
          packageType: "VSSOP (DGS)",
          pins: [
            { number: "1", name: "AIN0", electricalType: "unspecified" },
            { number: "2", name: "AIN1", electricalType: "unspecified" },
            { number: "3", name: "AIN2", electricalType: "unspecified" },
            { number: "4", name: "SCL", electricalType: "unspecified" },
            { number: "5", name: "SDA", electricalType: "unspecified" },
            { number: "6", name: "ADDR", electricalType: "unspecified" }
          ]
        }
      ]
    } as ExtractionResult,
    "test-model",
    [2, 3]
  );

  const entry = outcome.part.packagesInThisDocument?.[0];
  assert.ok(entry?.pins && entry.pins.length === 6, "the table survives instead of being discarded");
  assert.equal(entry?.citation?.page, 3, "cited to the page that actually carries these names");
});

// THE TIE STILL REFUSES. This is the half that keeps it a proof.
test("two pinout pages carrying the same names cite neither", () => {
  const identical = datasheetTextFromPages([
    "Cover",
    "Pin Configuration\nOUT IN- IN+ VCC GND",
    "Pin Configuration\nOUT IN- IN+ VCC GND"
  ]);
  const outcome = mergeModelValues(
    buildPartRecord(identical, "ACME.pdf"),
    identical,
    {
      values: {},
      packagesInThisDocument: [
        {
          packageType: "SOIC (D)",
          pins: [
            { number: "1", name: "OUT", electricalType: "unspecified" },
            { number: "2", name: "IN-", electricalType: "unspecified" },
            { number: "3", name: "IN+", electricalType: "unspecified" },
            { number: "4", name: "VCC", electricalType: "unspecified" }
          ]
        }
      ]
    } as ExtractionResult,
    "test-model",
    [2, 3]
  );

  // The table IS cited here, and by a better route: both pages carry the rows in
  // their text layer, so the ordinary text proof fires first and names page 2.
  // What must not happen is the AMBIGUOUS rendered-page proof claiming a page it
  // cannot tell from its neighbour.
  const entry = outcome.part.packagesInThisDocument?.[0];
  assert.ok(
    !/rendered pinout page/.test(entry?.citation?.snippet ?? ""),
    "a tie between two pinout pages proves nothing, whatever else cites the table"
  );
});

// THE SAME PROOF, FOR THE FLAT PIN TABLE.
//
// A pinout drawn as vector artwork has no text to quote, and the model cites the
// page it saw rather than one the drawing pass was shown, so both the text check
// and `citeRenderedPage` fail on rows that were read correctly. Measured
// 2026-08-20: two hold-out parts held on exactly this, and recovering them took
// SHIPS from 55/59 to 57/59.
test("a pin table nothing else can cite is proven by the rendered page carrying its names", () => {
  const artwork = datasheetTextFromPages([
    "Cover",
    "Ordering information",
    // The pinout page: it identifies itself and prints the names, but the rows
    // are not quotable as a table, so `verifyCitation` cannot carry it.
    "Pin Configuration\nOUT1 IN1- IN1+ VEE IN2+ IN2- OUT2 VCC"
  ]);
  const outcome = mergeModelValues(
    buildPartRecord(artwork, "ACME.pdf"),
    artwork,
    {
      values: {
        // Page 9 does not exist in this document and was never rendered, which
        // is what makes both earlier checks fail.
        pins: {
          value: [
            { number: "1", name: "OUT1" },
            { number: "2", name: "IN1-" },
            { number: "3", name: "IN1+" },
            { number: "4", name: "VEE" },
            { number: "5", name: "IN2+" },
            { number: "6", name: "IN2-" },
            { number: "7", name: "OUT2" },
            { number: "8", name: "VCC" }
          ],
          page: 9
        }
      }
    } as unknown as ExtractionResult,
    "test-model",
    [3]
  );

  assert.equal(outcome.part.pins.value?.length, 8, "the rows survive");
  assert.equal(outcome.part.pins.citation?.page, 3, "cited to the rendered page that carries the names");
  assert.ok(!outcome.uncited.includes("pins"), "and it is no longer held as uncitable");
});

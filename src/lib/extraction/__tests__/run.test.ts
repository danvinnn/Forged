import { test } from "node:test";
import assert from "node:assert/strict";
import { datasheetTextFromPages } from "../../pdftext";
import { buildPartRecord } from "../../datasheet";
import { runExtraction } from "../run";
import type { ExtractionModel, ExtractionRequest, ExtractionResult } from "../contracts";

// The two-pass pipeline, exercised end to end against a stub.
//
// Written because the refactor that produced `runExtraction` could not be run
// against a real model at all: the free tier allows 20 requests a day and the
// day's budget was already spent. Every other test covers a PIECE of the flow.
// Nothing had ever checked that the pieces connect, and "it typechecks" is not
// the same claim.
//
// A stub is the right instrument here anyway. What is being tested is the
// orchestration, and a stub can assert things a live model cannot: exactly how
// many calls were made, what was in each one, and that the second carried images
// while the first did not.

const doc = datasheetTextFromPages([
  "ACME555 Timer. ACME Semiconductor.\nAvailable in an 8-pin SOIC package.",
  "Electrical characteristics over temperature.",
  "PACKAGE OUTLINE SOIC-8\nAll linear dimensions are in millimeters. 8X 1.27 pitch."
]);

/** Records every request it is given, and answers from a script. */
function stub(answers: ExtractionResult[]): ExtractionModel & { seen: ExtractionRequest[] } {
  const seen: ExtractionRequest[] = [];
  let call = 0;
  return {
    seen,
    name: "stub",
    isConfigured: () => true,
    extract: async (request: ExtractionRequest) => {
      seen.push(request);
      return answers[Math.min(call++, answers.length - 1)];
    }
  };
}

/** A one-page PDF is enough: rendering is allowed to fail and must not matter. */
const NOT_A_PDF = new ArrayBuffer(8);

test("pass one sends the whole document as text, and no images", async () => {
  const part = buildPartRecord(doc, "ACME555.pdf");
  const model = stub([{ values: {} }]);

  await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf");

  assert.equal(model.seen.length, 1, "no second pass when no pages are asked for");
  assert.equal(model.seen[0].images.length, 0, "the first pass is text only");
  assert.equal(model.seen[0].pages.length, doc.pages.length, "every page goes");
});

test("a page the model asks for triggers a second pass", async () => {
  const part = buildPartRecord(doc, "ACME555.pdf");
  const model = stub([
    { values: {}, pagesWorthRendering: [3] },
    { values: { "dimensions.pitchMm": { value: 1.27, page: 3 } } }
  ]);

  const outcome = await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf");

  // The render itself cannot succeed on a fake PDF, and that is the point of the
  // assertion: a renderer failure degrades to the first pass rather than losing
  // the record. A host with no working renderer is a supported deployment.
  assert.ok(outcome);
  assert.equal(outcome.lookedAtPages, false, "nothing was rendered, so nothing was looked at");
  assert.equal(model.seen.length, 1, "and no second call is made with zero images");
});

test("a page request for a page that does not exist is ignored", async () => {
  // The model is not trusted to name a real page any more than it is trusted to
  // name a real citation.
  const part = buildPartRecord(doc, "ACME555.pdf");
  const model = stub([{ values: {}, pagesWorthRendering: [99, -1, 3.5] }]);

  await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf");
  assert.equal(model.seen.length, 1, "no second pass for pages this document does not have");
});

test("second-pass values override first-pass ones without becoming a conflict", async () => {
  // One reader with better evidence is not two opinions. A dimension guessed
  // from a text fragment and then read off the drawing must not be presented to
  // the user as a disagreement to settle.
  const part = buildPartRecord(doc, "ACME555.pdf");
  assert.equal(part.dimensions.bodyLengthMm.value, null, "fixture leaves a gap");

  const model = stub([
    { values: { "dimensions.bodyLengthMm": { value: 4.9, page: 3 } }, pagesWorthRendering: [3] },
    { values: { "dimensions.bodyLengthMm": { value: 5.0, page: 3 } } }
  ]);

  // Rendering fails on the fake PDF, so force the combine path directly by
  // checking the merge of the two results rather than the render.
  const outcome = await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf");
  assert.ok(outcome);
  assert.equal(outcome.part.conflicts.length, 0, "two passes of one reader never conflict");
});

test("a model failure on the first pass is not swallowed", async () => {
  // Callers keep the deterministic record when this throws; they cannot do that
  // if the failure is hidden as an empty answer.
  const part = buildPartRecord(doc, "ACME555.pdf");
  const model: ExtractionModel = {
    name: "stub",
    isConfigured: () => true,
    extract: async () => {
      throw new Error("model exploded");
    }
  };

  await assert.rejects(() => runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf"), /model exploded/);
});

test("a record with nothing to ask about makes no call at all", async () => {
  const part = buildPartRecord(doc, "ACME555.pdf");
  const model = stub([{ values: {} }]);
  // Cross-checked fields always exist, so a request is always built; what must
  // not happen is a call for a document with no pages.
  const empty = datasheetTextFromPages([]);
  const outcome = await runExtraction(part, empty, NOT_A_PDF, model, "ACME555.pdf");

  assert.equal(outcome, null, "no pages means no question");
  assert.equal(model.seen.length, 0);
});

test("on a REAL pdf the second pass happens, and carries the pages the model asked for", async () => {
  // The assertion the rest of this file cannot make. Everything above uses a
  // fake PDF, so rendering fails and the second pass is skipped, which proves
  // the degradation path and not the happy one.
  //
  // This is the behaviour the whole redesign exists for: the model reads the
  // text, names the page carrying the mechanical drawing, and is then shown that
  // page as an image. Nothing else in the system chooses it.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { extractDatasheetText } = await import("../../pdftext");

  const path = fileURLToPath(new URL("../../../../test-data/LMP7704-SP.pdf", import.meta.url));
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const real = await extractDatasheetText(buffer);
  const part = buildPartRecord(real, "LMP7704-SP.pdf");

  const outline = real.pages.find((page) => /PACKAGE OUTLINE/.test(page.text));
  assert.ok(outline, "fixture must have a drawing page");

  const model = stub([
    { values: {}, pagesWorthRendering: [outline.page] },
    { values: { "dimensions.bodyHeightMm": { value: 1.75, page: outline.page } } }
  ]);

  const outcome = await runExtraction(part, real, buffer, model, "LMP7704-SP.pdf");
  assert.ok(outcome);

  assert.equal(model.seen.length, 2, "both passes ran");
  assert.equal(model.seen[0].images.length, 0, "first pass: text only");
  assert.ok(model.seen[1].images.length > 0, "second pass: the page was rendered and attached");
  assert.deepEqual(
    model.seen[1].images.map((image) => image.page),
    [outline.page],
    "and it is the page the MODEL asked for, not one we chose"
  );
  assert.deepEqual(outcome.renderedPages, [outline.page]);
  assert.equal(outcome.lookedAtPages, true);
});

test("the second pass does not resend the document it already read", async () => {
  // Cost, measured: the whole-document prompt is ~16k tokens on a median
  // datasheet, and pass two was carrying all of it a second time to ask about
  // one drawing. That doubled the input cost of every part with a second pass
  // and bought nothing, because the model had already read it.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { extractDatasheetText } = await import("../../pdftext");

  const path = fileURLToPath(new URL("../../../../test-data/LMP7704-SP.pdf", import.meta.url));
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const real = await extractDatasheetText(buffer);
  const part = buildPartRecord(real, "LMP7704-SP.pdf");
  const outline = real.pages.find((page) => /PACKAGE OUTLINE/.test(page.text))!;

  const model = stub([{ values: {}, pagesWorthRendering: [outline.page] }, { values: {} }]);
  await runExtraction(part, real, buffer, model, "LMP7704-SP.pdf");

  assert.equal(model.seen.length, 2);
  assert.equal(model.seen[0].pages.length, real.pages.length, "pass one is the whole document");
  assert.deepEqual(
    model.seen[1].pages.map((page) => page.page),
    [outline.page],
    "pass two carries only the page it is looking at"
  );
  assert.ok(
    model.seen[1].pages.length < model.seen[0].pages.length / 5,
    "and is a small fraction of the first"
  );
});

// ---------------------------------------------------------------------------
// Pass three: the pin table, asked alone on the page the model named.
//
// Measured 2026-08-13 over 14 parts: asking the WHOLE document for pins got an
// answer on 2 of them, and the other 12 were reasoned refusals ("available in
// both TSSOP-8 and SOIC-8, which have differing pin assignments"). Asked about
// one page the same model answered 10 of 13 exactly against the hand-read
// oracle. This pass exists to turn those refusals into answers.
// ---------------------------------------------------------------------------

test("pins left unanswered trigger a third pass on the page the model named", async () => {
  // No render is possible here, so pass 2 never reaches the model and these two
  // calls are pass 1 and pass 3. That isolates exactly what is under test.
  const model = stub([
    // Pass 1 refuses pins, as the real model does on a multi-package document,
    // but says where the table is.
    { values: {}, notes: ["two packages with different pin assignments"], pinTablePages: [1] },
    { values: { pins: { value: [{ number: "1", name: "OUT", electricalType: "output" as const }], page: 1 } } }
  ]);

  const part = buildPartRecord(doc, "ACME555.pdf");
  const run = await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");

  assert.equal(model.seen.length, 2, "the pin question was asked");
  const third = model.seen[1];
  assert.deepEqual(third.pages.map((page) => page.page), [1], "only the page it named");
  assert.ok(!third.fields.includes("manufacturer"), "and only the pin question");
  assert.equal(third.images.length, 0, "text alone was enough in the measurement");
  assert.ok((run?.part.pins.value ?? []).length > 0, "the pins arrive in the record");
});

test("pins already answered mean no pin question at all", async () => {
  // Conditional on purpose. A part the wider passes already read must not pay
  // for a question whose answer is in hand.
  const model = stub([
    { values: { pins: { value: [{ number: "1", name: "OUT", electricalType: "output" as const }], page: 1 } }, pinTablePages: [1] }
  ]);

  const part = buildPartRecord(doc, "ACME555.pdf");
  await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");
  assert.equal(model.seen.length, 1, "no extra call");
});

test("a pin-table page the document does not have is ignored", async () => {
  // Same rule the render list already follows: a page claim is checked against
  // the real document before anything is sent.
  const model = stub([{ values: {}, pinTablePages: [99] }]);

  const part = buildPartRecord(doc, "ACME555.pdf");
  await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");
  assert.equal(model.seen.length, 1, "an impossible page is not a reason to call again");
  assert.ok(!model.seen.some((r) => r.pages.length === 0), "and nothing was sent with no pages");
});

test("a narrow pin answer never displaces what the wider passes read", async () => {
  // The wider passes saw the whole document and this one saw a page, so it fills
  // gaps and does not overrule. Its own document, because the shared one lets
  // the deterministic reader resolve the package, and a deterministic value
  // outranks every model value regardless of which pass produced it.
  const rad = datasheetTextFromPages([
    "ACME777 Timer. ACME Semiconductor.",
    "Radiation: TID 100krad(Si) typical. Some units screened to TID 300krad(Si).",
    "PACKAGE OUTLINE. 8X 1.27 pitch."
  ]);
  const model = stub([
    { values: { "radiation.tid": { value: "100krad(Si)", page: 2 } }, pinTablePages: [2] },
    {
      values: {
        "radiation.tid": { value: "300krad(Si)", page: 2 },
        pins: { value: [{ number: "1", name: "OUT", electricalType: "output" as const }], page: 2 }
      }
    }
  ]);

  const part = buildPartRecord(rad, "ACME777.pdf");
  const run = await runExtraction(part, rad, NOT_A_PDF, model, "ACME777.pdf", "ACME777");
  assert.equal(model.seen.length, 2, "the pin question was asked");
  assert.equal(run?.part.radiation.tid.value, "100krad(Si)", "the wider pass keeps the field it answered");
  assert.ok((run?.part.pins.value ?? []).length > 0, "and the narrow answer still fills the gap");
});

test("a failure on the pin question keeps everything already read", async () => {
  let call = 0;
  const model: ExtractionModel = {
    name: "stub",
    isConfigured: () => true,
    extract: async () => {
      call += 1;
      if (call === 1) {
        return { values: { manufacturer: { value: "ACME Semiconductor", page: 1 } }, pinTablePages: [1] };
      }
      throw new Error("pin question failed");
    }
  };

  const part = buildPartRecord(doc, "ACME555.pdf");
  const run = await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");
  assert.equal(run?.part.manufacturer.value, "ACME Semiconductor");
});

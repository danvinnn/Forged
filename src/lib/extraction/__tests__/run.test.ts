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
  assert.ok(
    model.seen[1].images.map((image) => image.page).includes(outline.page),
    "and the page the MODEL asked for is among them: nothing may drop its choice"
  );
  assert.ok(outcome.renderedPages.includes(outline.page));
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
  assert.ok(
    model.seen[1].pages.map((page) => page.page).includes(outline.page),
    "pass two carries the page it is looking at"
  );
  assert.ok(
    model.seen[1].pages.length < real.pages.length,
    "pass two carries only the pages being looked at, never the document again"
  );
  assert.ok(
    model.seen[1].pages.length < model.seen[0].pages.length / 5,
    "and is a small fraction of the first"
  );
});

test("a rendered figure does not overwrite a pin list the first pass already read", async () => {
  // The precedence rule had no test and was wrong for as long as it existed:
  // pass 2 won every field unconditionally, including pins.
  //
  // Measured on the 2026-08-17 corpus run. RHF1201's pin TABLE is on page 6;
  // pass 2 was shown pages 5 and 33, read the pinout FIGURE on page 5 instead,
  // and overwrote a correct `D11(MSB)` with `(MSB)D11` while nulling all 48
  // electrical types a figure cannot carry. LIS3DH was the same shape, table on
  // page 9 and figure on page 8, and came out rotated by one position. Both had
  // been read correctly and thrown away.
  //
  // The dimension half is asserted in the same test on purpose. An earlier
  // attempt at this fix held pass 1 for EVERY field whose page was not rendered,
  // which sounds more principled and is measurably worse: it also kept
  // RHF1201's front-page `gullwing` over the `straight` on its package drawing,
  // and REF5025's page-1 6.9mm over the drawing's 7.035mm. Reading graphics is
  // the entire reason pass 2 exists, so it has to keep winning those.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { extractDatasheetText } = await import("../../pdftext");

  const path = fileURLToPath(new URL("../../../../test-data/LMP7704-SP.pdf", import.meta.url));
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const real = await extractDatasheetText(buffer);
  const part = buildPartRecord(real, "LMP7704-SP.pdf");
  const outline = real.pages.find((page) => /PACKAGE OUTLINE/.test(page.text))!;

  const fromTable = [
    { number: "1", name: "D11(MSB)", electricalType: "output" as const },
    { number: "2", name: "D0(LSB)", electricalType: "output" as const }
  ];
  const fromFigure = [
    { number: "1", name: "(MSB)D11", electricalType: "unspecified" as const },
    { number: "2", name: "(LSB)D0", electricalType: "unspecified" as const }
  ];

  const model = stub([
    {
      values: {
        pins: { value: fromTable, page: 2 },
        "dimensions.pitchMm": { value: 1.27, page: 1 }
      },
      pagesWorthRendering: [outline.page]
    },
    {
      values: {
        pins: { value: fromFigure, page: outline.page },
        "dimensions.pitchMm": { value: 0.65, page: outline.page }
      }
    }
  ]);

  const run = await runExtraction(part, real, buffer, model, "LMP7704-SP.pdf");

  assert.equal(model.seen.length, 2, "the second pass ran");
  assert.deepEqual(
    run!.part.pins?.value?.map((pin) => pin.name),
    ["D11(MSB)", "D0(LSB)"],
    "the pin table pass one read is not replaced by a figure"
  );
  assert.equal(
    run!.part.dimensions.pitchMm?.value,
    0.65,
    "a dimension read off the drawing is still one opinion improved, so pass two wins"
  );

  // The other half, and the reason this is a page test rather than a blanket
  // "pass one keeps its pins". Where pass 2 re-reads the SAME page it is looking
  // at the same evidence with the image, and it is right to win: on RHF310A that
  // is what corrects `-VCC` to `VCC-`. Blocking it costs that fix.
  const sameTable = [{ number: "1", name: "VCC-", electricalType: "power" as const }];
  const rereading = stub([
    {
      values: { pins: { value: [{ number: "1", name: "-VCC", electricalType: "power" as const }], page: outline.page } },
      pagesWorthRendering: [outline.page]
    },
    { values: { pins: { value: sameTable, page: outline.page } } }
  ]);

  const reread = await runExtraction(part, real, buffer, rereading, "LMP7704-SP.pdf");
  assert.deepEqual(
    reread!.part.pins?.value?.map((pin) => pin.name),
    ["VCC-"],
    "re-reading the same page with the image is an improvement, not a substitution"
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


test("pins already answered mean no pin question at all", async () => {
  // Conditional on purpose. A part the wider passes already read must not pay
  // for a question whose answer is in hand.
  const model = stub([
    { values: { pins: { value: [{ number: "1", name: "OUT", electricalType: "output" as const }], page: 1 } } }
  ]);

  const part = buildPartRecord(doc, "ACME555.pdf");
  await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");
  assert.equal(model.seen.length, 1, "no extra call");
});

test("a pin-table page the document does not have is ignored", async () => {
  // Same rule the render list already follows: a page claim is checked against
  // the real document before anything is sent.
  const model = stub([{ values: {} }]);

  const part = buildPartRecord(doc, "ACME555.pdf");
  await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");
  assert.equal(model.seen.length, 1, "an impossible page is not a reason to call again");
  assert.ok(!model.seen.some((r) => r.pages.length === 0), "and nothing was sent with no pages");
});


test("a failure on the pin question keeps everything already read", async () => {
  let call = 0;
  const model: ExtractionModel = {
    name: "stub",
    isConfigured: () => true,
    extract: async () => {
      call += 1;
      if (call === 1) {
        return { values: { manufacturer: { value: "ACME Semiconductor", page: 1 } } };
      }
      throw new Error("pin question failed");
    }
  };

  const part = buildPartRecord(doc, "ACME555.pdf");
  const run = await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");
  assert.equal(run?.part.manufacturer.value, "ACME Semiconductor");
});

// ---------------------------------------------------------------------------
// Pin tables per package, read in the pass that already has the document.
//
// Replaces a third model call. That pass existed because the model refused to
// report pins when the part number did not say which package it meant, so a
// narrow second question was asked about one page. The refusal was the thing to
// fix: pass 1 already has the whole document and can just report what it found,
// labelled by package. Two calls instead of three, and the answer is in hand
// before anyone is asked to choose.
// ---------------------------------------------------------------------------

test("per-package pin tables are kept on the record, so choosing costs no call", async () => {
  const model = stub([
    {
      values: {},
      notes: ["the part number does not name a package"],
      pinTablesByPackage: [
        { packageType: "SOT23-5", pins: [{ number: "1", name: "OUT", electricalType: "unspecified" }] },
        { packageType: "SC70-5", pins: [{ number: "1", name: "OUT", electricalType: "unspecified" }] }
      ]
    }
  ]);

  const part = buildPartRecord(doc, "ACME555.pdf");
  const run = await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");

  assert.equal(model.seen.length, 1, "one call, not two questions about pins");
  assert.equal(run?.part.pinTablesByPackage?.length, 2, "both tables are on the record");
  assert.deepEqual(
    run?.part.pinTablesByPackage?.map((t) => t.packageType),
    ["SOT23-5", "SC70-5"],
    "kept separate and labelled, never merged into one"
  );
});

test("a document with one pinout carries no per-package tables", async () => {
  // Only populated where it means something. A single-package datasheet should
  // not grow a list with one entry in it.
  const model = stub([{ values: {} }]);
  const part = buildPartRecord(doc, "ACME555.pdf");
  const run = await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");
  assert.equal(run?.part.pinTablesByPackage, undefined);
});

test("the pipeline makes at most two model calls", async () => {
  // The count is the point. Three passes meant a workaround was living in the
  // pipeline; two is the text pass and the render pass, both structural.
  const model = stub([{ values: {}, pagesWorthRendering: [3] }, { values: {} }]);
  const part = buildPartRecord(doc, "ACME555.pdf");
  await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");
  assert.ok(model.seen.length <= 2, `expected at most 2 calls, saw ${model.seen.length}`);
});

test("the prompt offers every leadForm value the record accepts", async () => {
  // The defect this locks out, found 2026-08-17: the record and the generator
  // accept gullwing, nolead and straight, and the prompt offered only the first
  // two. A ceramic flat pack therefore had no valid answer and the model
  // returned null, correctly, for 37 of 81 parts. It read as a model that could
  // not read package drawings, and it was a question that could not express the
  // answer.
  //
  // Generalised rather than pinned to leadForm: any field the record constrains
  // to a set must offer that whole set, or the same failure returns elsewhere.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const guide = readFileSync(fileURLToPath(new URL("../models/prompt.ts", import.meta.url)), "utf8");
  const types = readFileSync(fileURLToPath(new URL("../../types.ts", import.meta.url)), "utf8");

  for (const [field, line] of [
    ["leadForm", /leadForm: extracted\(z\.enum\(\[([^\]]+)\]/],
    ["mounting", /mounting: extracted\(z\.enum\(\[([^\]]+)\]/],
    ["solderMaskDefined", /solderMaskDefined: extracted\(z\.enum\(\[([^\]]+)\]/]
  ] as const) {
    const declared = types.match(line);
    assert.ok(declared, `${field} must still be a zod enum for this test to mean anything`);
    const allowed = [...declared[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(allowed.length > 0);

    const start = guide.indexOf(`"dimensions.${field}":`);
    assert.ok(start > 0, `${field} must be described to the model`);
    const description = guide.slice(start, start + 1600);
    for (const value of allowed) {
      assert.ok(
        description.includes(`'${value}'`),
        `the prompt never offers ${field} = '${value}', so the model cannot return it`
      );
    }
  }
});

test("every field merge requires as a min/max pair is asked for that way, and no other is", async () => {
  // The contradiction this locks out, found 2026-08-17. `merge.ts` DROPS
  // leadWidthMm, leadSpanMm and leadContactMm unless they arrive as a positive
  // min/max pair, and the image-pass guidance told the model to report any
  // dimension printed as a range "as its NOMINAL value". On the pass that reads
  // drawings, obeying one instruction meant losing the value to the other.
  // leadSpanMm was missing on 6 of 12 blocked parts and leadContactMm on 4.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const guide = readFileSync(fileURLToPath(new URL("../models/prompt.ts", import.meta.url)), "utf8");
  const merge = readFileSync(fileURLToPath(new URL("../merge.ts", import.meta.url)), "utf8");

  // The fields merge insists on as ranges, read out of the guard itself so this
  // cannot fall behind a fourth one being added.
  const guard = merge.slice(merge.indexOf("const range = asRange(value);") - 400, merge.indexOf("const range = asRange(value);"));
  const required = [...guard.matchAll(/field === "(dimensions\.\w+)"/g)].map((m) => m[1]);
  assert.ok(required.length >= 3, "expected merge to require several range fields");

  for (const field of required) {
    const start = guide.indexOf(`"${field}":`);
    assert.ok(start > 0, `${field} must be described to the model`);
    const description = guide.slice(start, start + 900);
    // Bare substrings: the guide escapes its quotes in source, so it reads
    // \"minMm\" on disk rather than "minMm".
    assert.ok(
      description.includes("minMm") && description.includes("maxMm"),
      `${field} is dropped unless it is a min/max pair, so the guide must ask for one`
    );
  }

  // And the nominal-value instruction must carve them out, or the image pass
  // asks for the one shape the merge refuses.
  const nominal = guide.indexOf("NOMINAL value");
  assert.ok(nominal > 0, "the image guidance still mentions nominal values");
  const clause = guide.slice(nominal, nominal + 400);
  assert.ok(
    /minMm/.test(clause) && /EXCEPT|except/.test(clause),
    "the nominal-value rule must exempt the min/max fields"
  );
});

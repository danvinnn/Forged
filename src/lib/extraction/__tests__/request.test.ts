import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildExtractionRequest } from "../request";
import { buildPrompt } from "../models/prompt";
import { MAX_PAGES_TO_MODEL } from "../contracts";
import { extractDatasheetText, datasheetTextFromPages } from "../../pdftext";
import { buildPartRecord } from "../../datasheet";
import { unresolvedFields } from "../merge";

/**
 * What gets sent to the model.
 *
 * This file replaces `pageselect.test.ts`, which guarded a page SELECTOR that no
 * longer exists. Measured 2026-08-11: the largest datasheet in the corpus is
 * ~142k tokens against a 1,048,576-token limit, so every document fits whole and
 * choosing 8 pages of it was a workaround for a constraint that had gone away.
 * It cost whole parts while it lasted.
 *
 * The properties that survived the deletion are the ones that always mattered:
 * the page carrying the answer is in the prompt, and nothing but the model
 * decides which pages get LOOKED at.
 */

test("what was sent, and what it was a subset of, is recorded on the request", () => {
  // A model that answered null may simply never have been shown the page, so the
  // request states what it was a view OF. It now always covers the whole
  // document, and that has to be visible rather than assumed: `truncated` is
  // reachable past a 2,000,000-character rail and would otherwise be silent.
  const doc = datasheetTextFromPages([
    "LMP7704-SP.",
    "PACKAGE OUTLINE. Dimensions are in millimeters.",
    "filler"
  ]);
  const part = buildPartRecord(doc, "LMP7704-SP.pdf");
  const request = buildExtractionRequest(part, doc, "LMP7704-SP.pdf");
  assert.ok(request);

  assert.equal(request.selection?.totalPages, 3);
  assert.equal(
    request.selection?.totalChars,
    doc.pages.reduce((total, page) => total + page.text.length, 0)
  );
  assert.equal(request.selection?.reason, "whole-document");
  assert.equal(request.pages.length, 3, "nothing is held back");
});

test("on a real datasheet the WHOLE document is sent, answers included", async () => {
  // This asserted the prompt SHRANK until 2026-08-11, which was correct when the
  // target was a local `qwen2.5:1.5b` and wrong once it was a million-token
  // model. Measured across all 85 cached datasheets, the largest is 569k
  // characters, about 142k tokens, against a 1,048,576-token limit. Every
  // datasheet fits whole and we were sending 0.6% of capacity, chosen by the
  // deterministic parser's own opinion. TS922 and TSZ121 both lost their pinout
  // that way and both said so in their notes.
  //
  // What the old test really guarded is kept and strengthened: the page carrying
  // the answer must be in the prompt. It now cannot fail to be.
  const pdf = fileURLToPath(new URL("../../../../test-data/LMP7704-SP.pdf", import.meta.url));
  const bytes = readFileSync(pdf);
  const doc = await extractDatasheetText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const part = buildPartRecord(doc, "LMP7704-SP.pdf");

  const missing = unresolvedFields(part);
  // Everything geometric is asked of the model now. The deterministic reader that
  // used to answer the pitch off the drawing was deleted on 2026-08-14, having
  // been measured to contribute nothing to any dimension.
  assert.ok(missing.includes("dimensions.pitchMm"), "the pitch is a question for the model");
  assert.ok(missing.includes("dimensions.bodyHeightMm"), "so is the body height");

  const request = buildExtractionRequest(part, doc, "LMP7704-SP.pdf");
  assert.ok(request);

  assert.equal(request.pages.length, doc.pages.length, "every page is sent");
  assert.equal(request.selection?.reason, "whole-document");

  const outline = doc.pages.find((page) => /PACKAGE OUTLINE/.test(page.text));
  assert.ok(outline, "the datasheet has a package outline page");
  assert.ok(
    request.pages.some((page) => page.page === outline.page),
    `the package outline (page ${outline.page}) must be sent`
  );
});


test("the first pass asks the model which pages to render, and attaches none", () => {
  // The second pass exists because a drawing's dimensions are labels beside
  // dimension lines, and which dimension a label belongs to is carried by the
  // ARROWS. The text has the numbers without what they measure.
  const doc = datasheetTextFromPages([
    "ACME123 Op-amp in an 8-pin SOIC package.",
    "PACKAGE OUTLINE. All linear dimensions are in millimeters."
  ]);
  const part = buildPartRecord(doc, "ACME123.pdf");
  const request = buildExtractionRequest(part, doc, "ACME123.pdf");
  assert.ok(request);

  assert.equal(request.images.length, 0, "the first pass is text only");
  const prompt = buildPrompt(request);
  assert.match(prompt, /pagesWorthRendering/, "and it asks which pages to look at");
  // The NUMBER comes from the one constant, not from a word typed here: it was
  // written out in four places and raising the budget without raising the
  // sentence would have changed nothing, because the model reads the sentence.
  assert.match(prompt, new RegExp(`at most ${MAX_PAGES_TO_MODEL} pages`));
});

// --- selecting the page a DRAWING is on -------------------------------------
//
// These guard the three defects that kept the package drawing out of the model's
// hands. All three were invisible until pages started being rendered, because a
// text-only model could not have used the drawing anyway.



test("a resolved package is a SUGGESTION the model may reject", () => {
  // This asserted the opposite until 2026-08-11. The prompt used to read "This
  // part is in the X package ... report values for THIS one only", where X came
  // from a text scan, so when the scan was wrong the model read the wrong
  // drawing faithfully. It had been told the answer instead of asked the
  // question, and that was the last place the deterministic pass gave orders.
  //
  // The alternatives now go WITH the suggestion, because a model that may reject
  // a package needs to see what it can reject it in favour of.
  const doc = datasheetTextFromPages([
    "ACME358 Op-amp in an 8-pin SOIC package. Also available in TSSOP-8 and VSSOP-8."
  ]);
  const part = buildPartRecord(doc, "ACME358.pdf");
  const request = buildExtractionRequest(part, doc, "ACME358.pdf", "ACME358");
  assert.ok(request);

  const prompt = buildPrompt(request);
  if (part.packageType.value !== null) {
    assert.match(prompt, /suggests the package is/, "offered as a suggestion");
    assert.match(prompt, /that scan is often wrong/, "and openly distrusted");
    assert.match(prompt, /Decide for yourself/, "the model decides");
    assert.doesNotMatch(prompt, /report values for THIS one only/, "no longer an order");
  }
});


/**
 * The device the model is asked about, on a datasheet covering several.
 *
 * The prompt line naming the requested part is emitted only when the request
 * carries a part number, and every caller in the product left it undefined, so
 * the line was never sent. Measured on OPA2189: 58 pages covering OPA189,
 * OPA2189 and OPA4189, two pin tables on page 5, and the model returned the
 * SINGLE op-amp's pinout for the dual in both the text and the rendered pass.
 * Nothing in the request said which of the three was wanted.
 */
test("the request names the device even when the caller does not", () => {
  const doc = datasheetTextFromPages([
    "OPA189, OPA2189, OPA4189\nPrecision amplifiers\n8-pin SOIC package.",
    "Pin Functions: OPA189\n1 NC\n2 -IN"
  ]);
  const part = buildPartRecord(doc, "OPA2189.pdf");
  assert.equal(part.partNumber.value, "OPA2189", "the text pass reads it off page 1");

  const request = buildExtractionRequest(part, doc, "OPA2189.pdf");

  assert.equal(request?.partNumber, "OPA2189", "so the model is told which device to read");
});

test("an explicit part number still wins over the record's", () => {
  const doc = datasheetTextFromPages(["OPA189, OPA2189\nPrecision amplifiers\n8-pin SOIC."]);
  const part = buildPartRecord(doc, "OPA2189.pdf");

  const request = buildExtractionRequest(part, doc, "OPA2189.pdf", "OPA4189");

  assert.equal(request?.partNumber, "OPA4189", "the caller knows something the record does not");
});

// ---------------------------------------------------------------------------
// The question that had no answer
// ---------------------------------------------------------------------------

/**
 * Where a per-package measurement is asked for, and where it is not.
 *
 * Measured over the hold-out on 2026-08-18: 27 of 57 parts returned NOT ONE
 * dimension from either pass. The model's own notes say why, and they say it in
 * the same words each time: the part number does not specify a package
 * designator. The prompt told it not to pick a package and gave it nowhere to
 * put a per-package answer, so the honest reply was nothing at all.
 *
 * Two properties, and the second matters as much as the first: the ask appears
 * where the drawings are, and does NOT appear where the package is already
 * settled, because there it would invite a list for a document with nothing to
 * list.
 */

const familyDoc = () =>
  datasheetTextFromPages([
    "ACME358 Data Sheet\nAvailable in SOIC-8 (D) and VSSOP-8 (DGK).",
    "PACKAGE OUTLINE D0008A\nBody length D 4.90 mm",
    "PACKAGE OUTLINE DGK0008A\nBody length D 3.00 mm"
  ]);

test("the pass that can see the drawings is asked for measurements PER PACKAGE", () => {
  const doc = familyDoc();
  const request = buildExtractionRequest(buildPartRecord(doc, "ACME358.pdf"), doc, "ACME358.pdf");
  assert.ok(request);

  const textPass = buildPrompt(request);
  assert.doesNotMatch(
    textPass,
    /report them PER\nPACKAGE/,
    "the text pass cannot read a dimension line, so it is not asked to"
  );

  // The second pass, as `withRenderedPages` builds it: images attached and no
  // package settled, which is the state the refusal was measured in.
  const imagePass = buildPrompt({
    ...request,
    packageType: null,
    images: [{ page: 2, mimeType: "image/png", base64: "", widthPx: 1, heightPx: 1 }]
  });
  assert.match(imagePass, /packagesInThisDocument/, "and it has somewhere to put the answer");
  assert.match(imagePass, /one entry per package/);
});

test("a settled package is asked for one answer, not a list", () => {
  // The ask exists because the question had no answer. Where the part number
  // decides, it has exactly one, and asking both ways would let a package
  // disagree with itself.
  const doc = familyDoc();
  const request = buildExtractionRequest(buildPartRecord(doc, "ACME358.pdf"), doc, "ACME358.pdf");
  assert.ok(request);

  const settled = buildPrompt({
    ...request,
    packageType: "SOIC-8",
    images: [{ page: 2, mimeType: "image/png", base64: "", widthPx: 1, heightPx: 1 }]
  });
  assert.doesNotMatch(settled, /one entry per package/);
});

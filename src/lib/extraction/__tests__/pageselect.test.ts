import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selectPages } from "../pageselect";
import { buildExtractionRequest } from "../request";
import { buildPrompt } from "../models/prompt";
import { extractDatasheetText, datasheetTextFromPages } from "../../pdftext";
import { buildPartRecord } from "../../datasheet";
import { unresolvedFields } from "../merge";
import type { ExtractionField } from "../contracts";

/**
 * Page selection is the fix for a measured problem: a real local model answers
 * our contract correctly on a short prompt and returns nothing usable on a
 * whole-document one. These tests hold the two properties that matter, and they
 * pull in opposite directions, so both are asserted:
 *
 * - the prompt gets much smaller
 * - the page carrying the answer is still in it
 *
 * The second is the one that can quietly stop being true, so the last test runs
 * against a real datasheet rather than a fixture we wrote to pass.
 */

const LIMITS = { maxPages: 8, maxCharsPerPage: 6000, maxTotalChars: 24_000 };

function pages(...texts: string[]) {
  return texts.map((text, index) => ({ page: index + 1, text }));
}

test("the page carrying the field wins over the pages that merely come first", () => {
  const document = pages(
    "LMP7704-SP Quad Operational Amplifier. Texas Instruments.",
    "Electrical characteristics over temperature. Supply current 0.7 mA.",
    "Typical performance curves.",
    "PACKAGE OUTLINE. All linear dimensions are in millimeters. 14X 1.27 pitch."
  );

  const selection = selectPages(document, ["dimensions.pitchMm"], LIMITS);
  const chosen = selection.pages.map((page) => page.page);

  assert.equal(selection.reason, "relevance");
  assert.ok(chosen.includes(4), `the package drawing must be sent, got ${chosen.join(",")}`);
  assert.ok(!chosen.includes(3), "a performance-curve page is not where a pitch is");
});

test("page one always goes, because it says which device this is", () => {
  // A datasheet can describe several orderable devices. Without the identity
  // page a model has no way to tell which one the rest of the text is about,
  // and the rule telling it to ignore the others has nothing to bind to.
  const document = pages(
    "LMP7704-SP. Texas Instruments.",
    "PACKAGE OUTLINE. Dimensions are in millimeters."
  );

  const chosen = selectPages(document, ["dimensions.bodyLengthMm"], LIMITS).pages.map((p) => p.page);
  assert.ok(chosen.includes(1));
});

test("pages are sent in reading order however they were ranked", () => {
  const document = pages(
    "LMP7704-SP.",
    "nothing of interest",
    "Radiation performance. Total ionizing dose 100 krad(Si).",
    "PACKAGE OUTLINE. Dimensions are in millimeters. JEDEC MO-220."
  );

  const selection = selectPages(document, ["radiation.tid", "dimensions.bodyWidthMm"], LIMITS);
  const chosen = selection.pages.map((page) => page.page);
  assert.deepEqual(chosen, [...chosen].sort((a, b) => a - b), "a citing model should see the document as written");
});

test("an unrecognised document falls back to the leading pages rather than to nothing", () => {
  // Our cues are English section headings. A datasheet that uses none of them
  // must still get looked at; silently sending zero pages would turn a model
  // that could have helped into one that never answers.
  const document = pages("aaaa", "bbbb", "cccc");
  const selection = selectPages(document, ["dimensions.pitchMm"], LIMITS);

  assert.equal(selection.reason, "leading");
  assert.equal(selection.pages.length, 3);
});

test("the budget cuts the least relevant page, not the last one", () => {
  const filler = "x".repeat(6000);
  const document = [
    { page: 1, text: "LMP7704-SP." },
    { page: 2, text: filler },
    { page: 3, text: filler },
    { page: 4, text: `PACKAGE OUTLINE. Dimensions are in millimeters. ${filler}` }
  ];

  const selection = selectPages(document, ["dimensions.bodyLengthMm"], {
    maxPages: 8,
    maxCharsPerPage: 6000,
    maxTotalChars: 6100
  });

  const chosen = selection.pages.map((page) => page.page);
  assert.ok(chosen.includes(1), "identity survives");
  assert.ok(!chosen.includes(2) && !chosen.includes(3), "filler is dropped first");
});

test("what was sent, and what it was a subset of, is on the request", () => {
  const document = pages("LMP7704-SP.", "PACKAGE OUTLINE. Dimensions are in millimeters.", "filler");
  const selection = selectPages(document, ["dimensions.pitchMm"], LIMITS);

  assert.equal(selection.totalPages, 3);
  assert.equal(selection.totalChars, document.reduce((n, p) => n + p.text.length, 0));
  assert.ok(selection.pages.length < selection.totalPages, "a partial view is recorded as partial");
});

test("every field has cues, so no field silently selects nothing", () => {
  // A field added to the contract without cues would score zero everywhere and
  // quietly fall back to the leading pages for the whole request.
  const document = pages("LMP7704-SP.", "PACKAGE OUTLINE. Pin Functions. Total ionizing dose. Ordering Information.");
  const fields: ExtractionField[] = [
    "partNumber", "manufacturer", "packageType", "pinCount", "pins",
    "dimensions.bodyLengthMm", "dimensions.bodyWidthMm", "dimensions.bodyHeightMm",
    "dimensions.pitchMm", "dimensions.leadLengthMm", "dimensions.leadCount",
    "radiation.tid", "radiation.see", "radiation.sel", "radiation.qmlClass"
  ];

  for (const field of fields) {
    const selection = selectPages(document, [field], LIMITS);
    assert.equal(selection.reason, "relevance", `${field} has no cue that matches an obvious page`);
  }
});

test("on a real datasheet the prompt shrinks and still contains the answers", async () => {
  // LMP7704-SP: 30 pages, ~59k characters. The deterministic pass leaves the
  // body height and the lead length unresolved, and both are printed on the
  // package-outline page. That page is the assertion.
  const pdf = fileURLToPath(new URL("../../../../test-data/LMP7704-SP.pdf", import.meta.url));
  const bytes = readFileSync(pdf);
  const doc = await extractDatasheetText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const part = buildPartRecord(doc, "LMP7704-SP.pdf");

  const missing = unresolvedFields(part);
  // The pitch used to be on this list and is not any more: the drawing reader
  // takes it off the outline page deterministically, which is the whole point of
  // reading the drawing. Asserted in BOTH directions so that a regression which
  // silently stops reading it shows up here rather than as a quieter model call.
  assert.equal(part.dimensions.pitchMm.value, 1.27, "the pitch is read off the drawing, not asked of a model");
  assert.ok(!missing.includes("dimensions.pitchMm"), "so it is not a gap to ask about");
  assert.ok(missing.includes("dimensions.bodyHeightMm"), "the fixture still has a gap to ask about");

  const request = buildExtractionRequest(part, doc, "LMP7704-SP.pdf");
  assert.ok(request);

  const outline = doc.pages.find((page) => /PACKAGE OUTLINE/.test(page.text));
  assert.ok(outline, "the datasheet has a package outline page");
  assert.ok(
    request.pages.some((page) => page.page === outline.page),
    `the package outline (page ${outline.page}) must be sent; sent ${request.pages.map((p) => p.page).join(",")}`
  );

  // The measurement that justified the change. The old rule was positional:
  // the first 40 pages, 6k characters each.
  const positional = doc.pages.slice(0, 40).map((page) => ({ page: page.page, text: page.text.slice(0, 6000) }));
  const before = buildPrompt({ ...request, pages: positional }).length;
  const after = buildPrompt(request).length;

  assert.ok(after < before / 3, `prompt should shrink by well over half: ${before} -> ${after}`);
});

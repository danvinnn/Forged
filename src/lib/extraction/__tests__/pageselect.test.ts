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

// --- selecting the page a DRAWING is on -------------------------------------
//
// These guard the three defects that kept the package drawing out of the model's
// hands. All three were invisible until pages started being rendered, because a
// text-only model could not have used the drawing anyway.

const DRAWING_FIELDS: ExtractionField[] = ["dimensions.pitchMm", "dimensions.bodyHeightMm"];
const DRAWING_LIMITS = { maxPages: 6, maxCharsPerPage: 6000, maxTotalChars: 24_000 };

test("the dimension table beats the notes page facing it", () => {
  // ST prints the drawing's notes on the NEXT page. Those notes are prose about
  // a drawing and used to outscore the drawing, so the model was shown a page
  // carrying no dimension at all.
  const pages = [
    { page: 1, text: "STM32G071 Datasheet Features" },
    { page: 131, text: "Package information Table 84. LQFP64 - Mechanical data millimeters Symbol Min Typ Max A - - 1.60" },
    { page: 132, text: "Package information Notes: 1. Dimensioning and tolerancing conform to ASME Y14.5M-1994. Seating plane. Dimensions are in millimeters." }
  ];
  const chosen = selectPages(pages, DRAWING_FIELDS, DRAWING_LIMITS, { packageType: "LQFP64", pinCount: 64 })
    .pages.map((page) => page.page);
  assert.ok(chosen.includes(131), "the page with the actual Min/Typ/Max columns must be sent");
});

test("this part's package table beats a sibling's on the same document", () => {
  // A family datasheet prints mechanical data for every package it offers. They
  // are indistinguishable to a vocabulary scan, and the resolved designator is
  // the only thing that separates them.
  const pages = [
    { page: 1, text: "STM32G071 Datasheet" },
    { page: 131, text: "Package information Table 84. LQFP64 - Mechanical data millimeters Symbol Min Typ Max" },
    { page: 134, text: "Package information Table 85. UFBGA64 - Mechanical data millimeters Symbol Min Typ Max seating plane ASME Y14.5" }
  ];
  const chosen = selectPages(pages, DRAWING_FIELDS, DRAWING_LIMITS, { packageType: "LQFP64", pinCount: 64 })
    .pages.map((page) => page.page);
  assert.ok(chosen.includes(131), "the package this part is in must be preferred");
});

test("a page repeating a package name does not outrank the drawing", () => {
  // Ordering tables list every orderable package and so repeat the family name.
  // Counting frequency made them the top-scoring pages in the document; an
  // STM32F407VG's two ordering pages scored 24 and 21 against the LQFP100
  // drawing's 10. A structural marker is not more true for being repeated.
  const pages = [
    { page: 1, text: "Datasheet" },
    { page: 173, text: "Package information Table 93. LQFP100 - Mechanical data millimeters Symbol Min Typ Max" },
    { page: 202, text: "Ordering information LQFP100 LQFP100 LQFP100 LQFP100 LQFP100 LQFP100 LQFP100 LQFP100" }
  ];
  const chosen = selectPages(pages, DRAWING_FIELDS, DRAWING_LIMITS, { packageType: "LQFP100", pinCount: 100 })
    .pages.map((page) => page.page);
  assert.ok(chosen.includes(173), "the drawing must outrank a page that merely repeats the name");
});

test("a concern still gets pages when another concern matches far more of them", () => {
  // Fields used to be summed into one ranking, so on a long document the
  // concern matching forty pages consumed the budget and the concern matching
  // one page was cut. Reserving per concern is what stops that.
  const pins = Array.from({ length: 20 }, (_value, index) => ({
    page: index + 2,
    text: "Pin Functions PIN NO. NAME DESCRIPTION terminal functions"
  }));
  const pages = [
    { page: 1, text: "Datasheet" },
    ...pins,
    { page: 99, text: "Package outline DGK0008A mechanical data 8X 0.65 seating plane" }
  ];
  const chosen = selectPages(
    pages,
    ["pins", "pinCount", "dimensions.pitchMm"] as ExtractionField[],
    DRAWING_LIMITS,
    { packageType: "VSSOP", pinCount: 8 }
  ).pages.map((page) => page.page);
  assert.ok(chosen.includes(99), "the one dimension page must survive twenty pin pages");
});

test("a part with no resolved package selects exactly as it did before", () => {
  // The package cues are additive. A record that could not settle its package
  // must not select worse than one that never had the hint.
  const pages = [
    { page: 1, text: "Datasheet" },
    { page: 30, text: "PACKAGE OUTLINE PWP0028C mechanical data 26X 0.65 seating plane millimeters" },
    { page: 31, text: "Electrical characteristics Symbol Min Typ Max" }
  ];
  const withHint = selectPages(pages, DRAWING_FIELDS, DRAWING_LIMITS, { packageType: null, pinCount: null });
  assert.ok(withHint.pages.map((page) => page.page).includes(30));
});

test("a document with five package drawings sends the one this part is in", () => {
  // The generic drawing cues score every package page equally: they all say
  // PACKAGE OUTLINE, all carry an outline code, all tag a pitch. An LM358 prints
  // five and the record resolves it to the SOIC. Ranked merely strong, the right
  // drawing tied with four wrong ones and lost on incidental density, so the
  // model was shown TSSOP, VSSOP and SOT-23 drawings, correctly answered null
  // for every dimension, and said why: no package variant was specified.
  const drawing = (code: string, family: string) =>
    `PACKAGE OUTLINE ${code} ${family} SCALE 2.800 mechanical data seating plane 8X 0.65 millimeters`;
  const pages = [
    { page: 1, text: "LM358 Dual Operational Amplifier" },
    { page: 51, text: drawing("PW0008A", "TSSOP") },
    { page: 54, text: drawing("JG0008A", "CDIP") },
    { page: 56, text: drawing("DGK0008A", "VSSOP") },
    { page: 60, text: drawing("DDF0008A", "SOT-23-THIN") },
    { page: 63, text: drawing("D0008A", "SOIC") }
  ];
  const chosen = selectPages(pages, DRAWING_FIELDS, DRAWING_LIMITS, {
    packageType: "8-Pin SOIC",
    pinCount: 8
  }).pages.map((page) => page.page);
  assert.ok(chosen.includes(63), "the SOIC drawing must be sent to a part resolved as a SOIC");
});
